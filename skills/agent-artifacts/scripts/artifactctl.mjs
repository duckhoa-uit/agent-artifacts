#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_PART_CONCURRENCY = 3;
const MAX_PART_CONCURRENCY = 8;
const MAX_PART_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 250;
let manifestWrite = Promise.resolve();

const [command, ...args] = process.argv.slice(2);
const configuredBaseUrl = process.env.ARTIFACTS_URL || "";
const apiKey = process.env.ARTIFACTS_API_KEY;
let baseUrl = "";

try {
  if (!configuredBaseUrl || !apiKey) throw new Error("ARTIFACTS_URL and ARTIFACTS_API_KEY are required");
  baseUrl = normalizeBaseUrl(configuredBaseUrl);
  if (command === "upload") await upload(args);
  else if (command === "share") await share(args);
  else if (command === "get") await get(args);
  else if (command === "delete") await remove(args);
  else throw new Error("Usage: artifactctl upload|share|get|delete ...");
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}

async function upload(values) {
  const file = values[0];
  if (!file) throw new Error("Usage: artifactctl upload FILE [--purpose PURPOSE] [--retention 7d|30d|retain]");
  const options = flags(values.slice(1));
  const retention = options.retention || "30d";
  if (!["7d", "30d", "retain"].includes(retention)) throw new Error("Upload retention must be 7d, 30d, or retain");
  const resume = options.resume === true || options.resume === "true";
  const concurrency = parseConcurrency(options.concurrency);
  const info = await stat(file);
  const capabilities = await api("GET", "/v1/capabilities");
  const maxSmallUploadBytes = Number(capabilities.max_small_upload_bytes);
  if (!Number.isSafeInteger(maxSmallUploadBytes) || maxSmallUploadBytes <= 0) throw new Error("Worker returned an invalid direct-upload limit");
  const partSize = Number(capabilities.multipart_part_size_bytes);
  if (!Number.isSafeInteger(partSize) || partSize <= 0) throw new Error("Worker returned an invalid multipart part size");
  const maxMultipartParts = Number(capabilities.max_multipart_parts || 10_000);
  const maxMultipartUploadBytes = Number(capabilities.max_multipart_upload_bytes || partSize * maxMultipartParts);
  if (!Number.isSafeInteger(maxMultipartParts) || maxMultipartParts <= 0 || !Number.isSafeInteger(maxMultipartUploadBytes) || maxMultipartUploadBytes <= 0) {
    throw new Error("Worker returned invalid multipart limits");
  }
  const common = {
    filename: file.split(/[\\/]/).pop(), content_type: options["content-type"] || mime(file), sha256: await fileSha256(file),
    source_agent: options["source-agent"], repo: options.repo, pr_number: options.pr ? Number(options.pr) : undefined,
    task_id: options["task-id"], purpose: options.purpose, retention,
  };
  let result;
  if (info.size <= maxSmallUploadBytes) {
    if (resume) throw new Error("--resume is only available for multipart uploads");
    result = await api("POST", "/v1/artifacts", await readFile(file), headers(common));
  } else {
    if (info.size > maxMultipartUploadBytes) throw new Error(`File exceeds the Worker multipart limit of ${maxMultipartUploadBytes} bytes`);
    const manifestFile = uploadManifestPath(file, common.sha256);
    let manifest;
    if (resume) {
      manifest = await loadUploadManifest(manifestFile);
      validateUploadManifest(manifest, file, info, common.sha256, partSize, maxMultipartParts);
    } else {
      if (await exists(manifestFile)) throw new Error(`An unfinished multipart upload exists at ${manifestFile}; pass --resume or remove it`);
      const init = await api("POST", "/v1/uploads", JSON.stringify({ ...common, size_bytes: info.size }), { "content-type": "application/json" });
      manifest = {
        version: 1,
        file: resolve(file),
        size_bytes: info.size,
        mtime_ms: info.mtimeMs,
        sha256: common.sha256,
        upload_id: init.upload_id,
        artifact_id: init.artifact_id,
        part_size_bytes: init.part_size_bytes,
        total_parts: init.total_parts,
        parts: {},
      };
      validateUploadManifest(manifest, file, info, common.sha256, partSize, maxMultipartParts);
      await saveUploadManifest(manifestFile, manifest);
    }
    try {
      const handle = await open(file, "r");
      try {
        const pendingParts = [];
        for (let partNumber = 1, offset = 0; offset < info.size; partNumber += 1, offset += manifest.part_size_bytes) {
          if (!manifest.parts[String(partNumber)]) pendingParts.push({ partNumber, offset, length: Math.min(manifest.part_size_bytes, info.size - offset) });
        }
        await mapConcurrent(pendingParts, concurrency, async ({ partNumber, offset, length }) => {
          const buffer = Buffer.alloc(length);
          await readExact(handle, buffer, offset);
          const uploaded = await uploadPartWithRetry(manifest.upload_id, partNumber, buffer, length);
          manifest.parts[String(partNumber)] = uploaded.etag;
          await saveUploadManifest(manifestFile, manifest);
        });
      } finally { await handle.close(); }
      const finalInfo = await stat(file);
      if (finalInfo.size !== info.size || finalInfo.mtimeMs !== info.mtimeMs) throw new Error("File changed during multipart upload");
      result = await api("POST", `/v1/uploads/${manifest.upload_id}/complete`, JSON.stringify({}), { "content-type": "application/json" });
      await unlink(manifestFile);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${message}. Multipart state is saved at ${manifestFile}; retry with --resume`);
    }
  }
  print(result);
}

async function uploadPartWithRetry(uploadId, partNumber, buffer, length) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_PART_RETRIES; attempt += 1) {
    try {
      return await api("PUT", `/v1/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`, buffer, { "content-type": "application/octet-stream", "content-length": String(length) });
    } catch (cause) {
      lastError = cause;
      if (attempt === MAX_PART_RETRIES) break;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

async function mapConcurrent(items, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function parseConcurrency(value) {
  if (value === undefined) return DEFAULT_PART_CONCURRENCY;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PART_CONCURRENCY) throw new Error(`Multipart concurrency must be an integer between 1 and ${MAX_PART_CONCURRENCY}`);
  return parsed;
}

function uploadManifestPath(file, sha256) {
  return resolve(dirname(file), `.${basename(file)}.${sha256}.artifact-upload.json`);
}

async function loadUploadManifest(file) {
  let value;
  try { value = JSON.parse(await readFile(file, "utf8")); } catch (cause) {
    throw new Error(`Unable to read multipart manifest ${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return value;
}

function validateUploadManifest(manifest, file, info, sha256, partSize, maxParts) {
  if (!manifest || manifest.version !== 1 || typeof manifest.upload_id !== "string" || typeof manifest.artifact_id !== "string" || typeof manifest.parts !== "object") throw new Error("Multipart manifest is invalid");
  if (manifest.file !== resolve(file) || manifest.size_bytes !== info.size || manifest.mtime_ms !== info.mtimeMs || manifest.sha256 !== sha256) throw new Error("Multipart manifest does not match the current file");
  if (manifest.part_size_bytes !== partSize || !Number.isInteger(manifest.total_parts) || manifest.total_parts < 1 || manifest.total_parts > maxParts || manifest.total_parts !== Math.ceil(info.size / partSize)) throw new Error("Multipart manifest does not match the Worker capabilities");
  for (const [partNumber, etag] of Object.entries(manifest.parts)) {
    if (!/^\d+$/.test(partNumber) || Number(partNumber) < 1 || Number(partNumber) > manifest.total_parts || typeof etag !== "string" || !etag) throw new Error("Multipart manifest contains an invalid part");
  }
}

async function saveUploadManifest(file, manifest) {
  const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
  manifestWrite = manifestWrite.then(async () => {
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  });
  return manifestWrite;
}

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function share(values) {
  const artifactId = values[0];
  if (!artifactId) throw new Error("Usage: artifactctl share ARTIFACT_ID [--retention retain|temporary] [--expires SECONDS]");
  const options = flags(values.slice(1));
  print(await api("POST", `/v1/artifacts/${encodeURIComponent(artifactId)}/shares`, JSON.stringify({
    retention: options.retention || "temporary", expires_in_seconds: options.expires ? Number(options.expires) : undefined,
  }), { "content-type": "application/json" }));
}

async function get(values) {
  const artifactId = values[0];
  const output = values[1] === "--output" ? values[2] : null;
  if (!artifactId || !output) throw new Error("Usage: artifactctl get ARTIFACT_ID --output FILE");
  const response = await fetch(`${baseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}`, { headers:{ authorization:`Bearer ${apiKey}` } });
  if (!response.ok || !response.body) throw new Error(await response.text());
  const expectedLength = response.headers.get("content-length");
  const expectedSha256 = response.headers.get("x-artifact-sha256");
  if (expectedLength === null && expectedSha256 === null) throw new Error("Artifact response did not include Content-Length or x-artifact-sha256");
  const destination = resolve(output);
  const temporary = resolve(dirname(destination), `.${basename(destination)}.${process.pid}-${randomUUID()}.tmp`);
  const hash = createHash("sha256");
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(temporary, { flags:"wx" }));
    if (expectedLength !== null) {
      const length = Number(expectedLength);
      if (!Number.isSafeInteger(length) || length < 0) throw new Error("Artifact response Content-Length is invalid");
      if (bytes !== length) throw new Error(`Downloaded artifact length mismatch: expected ${length} bytes, received ${bytes}`);
    }
    const actualSha256 = hash.digest("hex");
    if (expectedSha256 !== null) {
      if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error("Artifact response checksum is invalid");
      if (actualSha256 !== expectedSha256.toLowerCase()) throw new Error("Downloaded artifact checksum did not match x-artifact-sha256");
    }
    await rename(temporary, destination);
  } catch (cause) {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    throw cause;
  }
  print({ artifact_id:artifactId, output, bytes });
}

async function remove(values) {
  const artifactId = values[0];
  if (!artifactId) throw new Error("Usage: artifactctl delete ARTIFACT_ID");
  const response = await fetch(`${baseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}`, { method:"DELETE", headers:{ authorization:`Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(await response.text());
  print({ artifact_id:artifactId, deleted:true });
}

async function api(method, path, body, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method, body, headers:{ authorization:`Bearer ${apiKey}`, ...extraHeaders } });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw:text }; }
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function fileSha256(file) { const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex"); }
function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("ARTIFACTS_URL must be a valid URL"); }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("ARTIFACTS_URL must use HTTPS (HTTP is allowed only for localhost testing)");
  if (url.username || url.password || url.search || url.hash) throw new Error("ARTIFACTS_URL must not contain credentials, a query, or a fragment");
  return url.toString().replace(/\/$/, "");
}
async function readExact(handle, buffer, position) { let offset = 0; while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset); if (!bytesRead) throw new Error("File ended during multipart upload"); offset += bytesRead; } }
function headers(input) { return Object.fromEntries(Object.entries({ "content-type":input.content_type, "x-filename":input.filename, "x-artifact-sha256":input.sha256, "x-artifact-retention":input.retention, "x-source-agent":input.source_agent, "x-repo":input.repo, "x-pr-number":input.pr_number, "x-task-id":input.task_id, "x-purpose":input.purpose }).filter(([, value]) => value !== undefined)); }
function flags(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index]?.startsWith("--")) continue;
    const name = values[index].slice(2);
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) result[name] = true;
    else { result[name] = next; index += 1; }
  }
  return result;
}
function mime(file) { const extension = file.toLowerCase().split(".").pop(); return { png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", webp:"image/webp", mp4:"video/mp4", mov:"video/quicktime", webm:"video/webm", pdf:"application/pdf", json:"application/json", txt:"text/plain" }[extension] || "application/octet-stream"; }
function print(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

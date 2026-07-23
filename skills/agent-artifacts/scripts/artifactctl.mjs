#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const [command, ...args] = process.argv.slice(2);
const baseUrl = (process.env.ARTIFACTS_URL || "").replace(/\/$/, "");
const apiKey = process.env.ARTIFACTS_API_KEY;

try {
  if (!baseUrl || !apiKey) throw new Error("ARTIFACTS_URL and ARTIFACTS_API_KEY are required");
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
  const info = await stat(file);
  const common = {
    filename: file.split(/[\\/]/).pop(), content_type: options["content-type"] || mime(file), sha256: await fileSha256(file),
    source_agent: options["source-agent"], repo: options.repo, pr_number: options.pr ? Number(options.pr) : undefined,
    task_id: options["task-id"], purpose: options.purpose, retention,
  };
  let result;
  if (info.size <= 50 * 1024 * 1024) {
    result = await api("POST", "/v1/artifacts", await readFile(file), headers(common));
  } else {
    const init = await api("POST", "/v1/uploads", JSON.stringify({ ...common, size_bytes: info.size }), { "content-type": "application/json" });
    try {
      const handle = await open(file, "r");
      try {
        for (let partNumber = 1, offset = 0; offset < info.size; partNumber += 1, offset += init.part_size_bytes) {
          const length = Math.min(init.part_size_bytes, info.size - offset);
          const buffer = Buffer.allocUnsafe(length);
          await handle.read(buffer, 0, length, offset);
          await api("PUT", `/v1/uploads/${init.upload_id}/parts/${partNumber}`, buffer, { "content-type": "application/octet-stream", "content-length": String(length) });
        }
      } finally { await handle.close(); }
      result = await api("POST", `/v1/uploads/${init.upload_id}/complete`, JSON.stringify({}), { "content-type": "application/json" });
    } catch (cause) {
      await fetch(`${baseUrl}/v1/uploads/${encodeURIComponent(init.upload_id)}`, { method:"DELETE", headers:{ authorization:`Bearer ${apiKey}` } }).catch(() => undefined);
      throw cause;
    }
  }
  print(result);
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
  await pipeline(Readable.fromWeb(response.body), createWriteStream(output));
  print({ artifact_id:artifactId, output, bytes:(await stat(output)).size });
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
function headers(input) { return Object.fromEntries(Object.entries({ "content-type":input.content_type, "x-filename":input.filename, "x-artifact-sha256":input.sha256, "x-artifact-retention":input.retention, "x-source-agent":input.source_agent, "x-repo":input.repo, "x-pr-number":input.pr_number, "x-task-id":input.task_id, "x-purpose":input.purpose }).filter(([, value]) => value !== undefined)); }
function flags(values) { const result = {}; for (let index = 0; index < values.length; index += 1) if (values[index]?.startsWith("--")) result[values[index].slice(2)] = values[index + 1]?.startsWith("--") ? true : values[++index]; return result; }
function mime(file) { const extension = file.toLowerCase().split(".").pop(); return { png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", webp:"image/webp", mp4:"video/mp4", mov:"video/quicktime", webm:"video/webm", pdf:"application/pdf", json:"application/json", txt:"text/plain" }[extension] || "application/octet-stream"; }
function print(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }


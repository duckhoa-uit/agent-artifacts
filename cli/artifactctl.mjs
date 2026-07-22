#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";

const [command, ...args] = process.argv.slice(2);
const baseUrl = (process.env.ARTIFACTS_URL || "").replace(/\/$/, "");
const apiKey = process.env.ARTIFACTS_API_KEY;

if (!baseUrl || !apiKey) fail("ARTIFACTS_URL and ARTIFACTS_API_KEY are required");

if (command === "upload") await upload(args);
else if (command === "share") await share(args);
else if (command === "get") await get(args);
else if (command === "delete") await remove(args);
else fail("Usage: artifactctl upload|share|get|delete ...");

async function upload(values) {
  const file = values[0];
  if (!file) fail("Usage: artifactctl upload FILE [--purpose PURPOSE] [--retention retain|temporary]");
  const options = flags(values.slice(1));
  const info = await stat(file);
  const digest = await fileSha256(file);
  const common = {
    filename: file.split(/[\\/]/).pop(),
    content_type: options["content-type"] || mime(file),
    sha256: digest,
    source_agent: options["source-agent"],
    repo: options.repo,
    pr_number: options.pr ? Number(options.pr) : undefined,
    task_id: options["task-id"],
    purpose: options.purpose,
  };
  let result;
  if (info.size <= 50 * 1024 * 1024) {
    const body = await readFile(file);
    result = await api("POST", "/v1/artifacts", body, headers(common));
  } else {
    const init = await api("POST", "/v1/uploads", JSON.stringify({ ...common, size_bytes: info.size }), { "content-type": "application/json" });
    const handle = await open(file, "r");
    try {
      const partSize = init.part_size_bytes;
      for (let partNumber = 1, offset = 0; offset < info.size; partNumber += 1, offset += partSize) {
        const length = Math.min(partSize, info.size - offset);
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, offset);
        await api("PUT", `/v1/uploads/${init.upload_id}/parts/${partNumber}`, buffer, { "content-type": "application/octet-stream", "content-length": String(length) });
      }
    } finally {
      await handle.close();
    }
    result = await api("POST", `/v1/uploads/${init.upload_id}/complete`, JSON.stringify({}), { "content-type": "application/json" });
  }
  if (options.retention) result.retention = options.retention;
  print(result);
}

async function share(values) {
  const artifactId = values[0];
  if (!artifactId) fail("Usage: artifactctl share ARTIFACT_ID [--retention retain|temporary] [--expires SECONDS]");
  const options = flags(values.slice(1));
  print(await api("POST", `/v1/artifacts/${encodeURIComponent(artifactId)}/shares`, JSON.stringify({
    retention: options.retention,
    expires_in_seconds: options.expires ? Number(options.expires) : undefined,
  }), { "content-type": "application/json" }));
}

async function get(values) {
  const artifactId = values[0];
  const output = values[1] === "--output" ? values[2] : null;
  if (!artifactId || !output) fail("Usage: artifactctl get ARTIFACT_ID --output FILE");
  const response = await fetch(`${baseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!response.ok) fail(await response.text());
  const file = await import("node:fs/promises");
  await file.writeFile(output, Buffer.from(await response.arrayBuffer()));
  print({ artifact_id: artifactId, output, bytes: (await stat(output)).size });
}

async function remove(values) {
  const artifactId = values[0];
  if (!artifactId) fail("Usage: artifactctl delete ARTIFACT_ID");
  const response = await fetch(`${baseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}`, { method: "DELETE", headers: { authorization: `Bearer ${apiKey}` } });
  if (!response.ok) fail(await response.text());
  print({ artifact_id: artifactId, deleted: true });
}

async function api(method, path, body, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method, body, headers: { authorization: `Bearer ${apiKey}`, ...extraHeaders } });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) fail(JSON.stringify(data));
  return data;
}

async function fileSha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function headers(input) {
  return Object.fromEntries(Object.entries({ "content-type": input.content_type, "x-filename": input.filename, "x-artifact-sha256": input.sha256, "x-source-agent": input.source_agent, "x-repo": input.repo, "x-pr-number": input.pr_number, "x-task-id": input.task_id, "x-purpose": input.purpose }).filter(([, value]) => value !== undefined));
}

function flags(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) if (values[index]?.startsWith("--")) result[values[index].slice(2)] = values[index + 1]?.startsWith("--") ? true : values[++index];
  return result;
}

function mime(file) {
  const extension = file.toLowerCase().split(".").pop();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", pdf: "application/pdf", json: "application/json", txt: "text/plain" }[extension] || "application/octet-stream";
}

function print(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function fail(message) { process.stderr.write(`${message}\n`); process.exit(1); }

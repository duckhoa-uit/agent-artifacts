#!/usr/bin/env node
import { createHash } from "node:crypto";

const baseUrl = (process.env.ARTIFACTS_URL || "").replace(/\/$/, "");
const adminToken = process.env.ARTIFACTS_ADMIN_TOKEN;
if (!baseUrl || !adminToken) fail("ARTIFACTS_URL and ARTIFACTS_ADMIN_TOKEN are required");

const results = [];
const health = await request("GET", "/healthz");
assert(health.ok === true, "healthz");
results.push("healthz");

const issued = await request("POST", "/v1/admin/api-keys", {
  owner: "e2e",
  scopes: ["artifact:write", "artifact:read", "artifact:delete", "share:create"],
}, adminToken);
assert(typeof issued.token === "string", "admin issues one-time API key");
const token = issued.token;
const listing = await request("GET", "/v1/admin/api-keys", undefined, adminToken);
assert(!JSON.stringify(listing).includes(token), "API listing does not return raw token");
results.push("api-key-create-and-list");

const small = new TextEncoder().encode("agent-artifacts e2e small payload");
const smallSha = sha256(small);
const smallArtifact = await requestRaw("POST", "/v1/artifacts", small, token, {
  "content-type": "text/plain",
  "content-length": String(small.byteLength),
  "x-filename": "small.txt",
  "x-artifact-sha256": smallSha,
  "x-purpose": "e2e",
});
assert(smallArtifact.status === 201, "small upload");
const smallData = await smallArtifact.json();
assert(smallData.sha256 === smallSha, "small SHA-256 metadata");
const privateResponse = await requestRaw("GET", `/v1/artifacts/${smallData.id}`);
assert(privateResponse.status === 401, "artifact endpoint stays private without a bearer key");
results.push("small-upload");

const downloaded = await requestRaw("GET", `/v1/artifacts/${smallData.id}`, undefined, token);
assert(downloaded.status === 200 && new Uint8Array(await downloaded.arrayBuffer()).every((value, index) => value === small[index]), "authenticated download");
const head = await requestRaw("HEAD", `/v1/artifacts/${smallData.id}`, undefined, token);
assert(head.status === 200 && head.headers.get("content-length") === String(small.byteLength), "HEAD metadata");
const range = await requestRaw("GET", `/v1/artifacts/${smallData.id}`, undefined, token, { range: "bytes=0-5" });
assert(range.status === 206 && (await range.text()) === "agent-", "HTTP Range download");
results.push("get-head-range");

const share = await request("POST", `/v1/artifacts/${smallData.id}/shares`, { retention: "temporary", expires_in_seconds: 600 }, token);
const shared = await requestRaw("GET", new URL(share.url).pathname, undefined, undefined, { range: "bytes=-6" });
assert(shared.status === 206 && (await shared.text()) === "ayload", "bearerless share and Range");
await requestRaw("DELETE", `/v1/shares/${share.id}`, undefined, token);
const revokedShare = await requestRaw("GET", new URL(share.url).pathname);
assert(revokedShare.status === 404, "share revoke");
results.push("share-create-range-revoke");

const partSize = 20 * 1024 * 1024;
const large = new Uint8Array(partSize + 17);
large.fill(65);
large.set(new TextEncoder().encode("multipart-e2e"), large.length - 13);
const largeSha = sha256(large);
const init = await request("POST", "/v1/uploads", {
  filename: "large.bin", content_type: "application/octet-stream", size_bytes: large.byteLength,
  sha256: largeSha, purpose: "e2e",
}, token);
assert(init.total_parts === 2, "multipart init");
for (let part = 0; part < init.total_parts; part += 1) {
  const chunk = large.slice(part * init.part_size_bytes, Math.min(large.length, (part + 1) * init.part_size_bytes));
  const uploaded = await requestRaw("PUT", `/v1/uploads/${init.upload_id}/parts/${part + 1}`, chunk, token, { "content-length": String(chunk.byteLength) });
  assert(uploaded.status === 200, `multipart part ${part + 1}`);
}
const complete = await request("POST", `/v1/uploads/${init.upload_id}/complete`, {}, token);
assert(complete.id === init.artifact_id && complete.sha256 === largeSha, "multipart complete");
const largeRange = await requestRaw("GET", `/v1/artifacts/${init.artifact_id}`, undefined, token, { range: `bytes=${partSize + 4}-${partSize + 16}` });
assert(largeRange.status === 206 && (await largeRange.text()) === "multipart-e2e", "large artifact Range playback");
results.push("multipart-upload-complete-range");

await requestRaw("DELETE", `/v1/artifacts/${smallData.id}`, undefined, token);
await requestRaw("DELETE", `/v1/artifacts/${init.artifact_id}`, undefined, token);
const deleted = await requestRaw("GET", `/v1/artifacts/${smallData.id}`, undefined, token);
assert(deleted.status === 404, "artifact delete");
const revoked = await requestRaw("DELETE", `/v1/artifacts/${init.artifact_id}`, undefined, token);
assert(revoked.status === 404, "deleted artifact cannot be deleted twice");
await requestRaw("DELETE", `/v1/admin/api-keys/${issued.id}`, undefined, undefined, { authorization: `Bearer ${adminToken}` });
const afterRevoke = await requestRaw("GET", `/v1/artifacts/${init.artifact_id}`, undefined, token);
assert(afterRevoke.status === 401, "API key revoke takes effect immediately");
results.push("delete-and-key-revoke");

console.log(JSON.stringify({ ok: true, base_url: baseUrl, cases: results }, null, 2));

async function request(method, path, body, bearer) {
  const response = await requestRaw(method, path, body ? JSON.stringify(body) : undefined, bearer, { "content-type": "application/json" });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) fail(`${method} ${path} ${response.status}: ${text}`);
  return data;
}

async function requestRaw(method, path, body, bearer, extra = {}) {
  const headers = { ...extra };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return fetch(`${baseUrl}${path}`, { method, body, headers });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assert(condition, label) {
  if (!condition) fail(`E2E assertion failed: ${label}`);
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

#!/usr/bin/env node
import { createHash } from "node:crypto";

const baseUrl = (process.env.ARTIFACTS_URL || "").replace(/\/$/, "");
const adminToken = process.env.ARTIFACTS_E2E_ADMIN_TOKEN;
const accessClientId = process.env.ARTIFACTS_E2E_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.ARTIFACTS_E2E_ACCESS_CLIENT_SECRET;
if (Boolean(accessClientId) !== Boolean(accessClientSecret)) throw new Error("ARTIFACTS_E2E_ACCESS_CLIENT_ID and ARTIFACTS_E2E_ACCESS_CLIENT_SECRET must be provided together");
if (!baseUrl || (!adminToken && !accessClientId)) throw new Error("ARTIFACTS_URL and either ARTIFACTS_E2E_ADMIN_TOKEN or the E2E Access service-token pair are required");

const resources = { keys: [], artifacts: [] };
const cases = [];
let failure;
const cleanupFailures = [];
try {
  const health = await request("GET", "/healthz");
  assert(health.ok === true, "healthz");
  const capabilities = await waitForCapabilities();
  assert(capabilities.max_small_upload_bytes > 0 && capabilities.multipart_part_size_bytes > 0, "upload capabilities");
  assert(capabilities.max_multipart_parts === 10_000 && capabilities.max_multipart_upload_bytes === capabilities.multipart_part_size_bytes * capabilities.max_multipart_parts && capabilities.supports_resume === true, "multipart capabilities");
  assert((await requestRaw("GET", "/admin/")).status === 200, "admin dashboard shell");
  assert(["break-glass", "cloudflare-access"].includes((await request("GET", "/v1/admin/session", undefined, adminToken)).mode), "admin session");
  cases.push("health-and-admin-dashboard");

  const first = await issueKey("e2e-owner-one");
  const second = await issueKey("e2e-owner-two");
  const listing = await request("GET", "/v1/admin/api-keys", undefined, adminToken);
  assert(!JSON.stringify(listing).includes(first.token) && !JSON.stringify(listing).includes(second.token), "raw tokens never appear in listing");
  cases.push("api-key-one-time-reveal");

  const small = new TextEncoder().encode("agent-artifacts e2e small payload");
  const smallSha = sha256(small);
  const mismatch = await requestRaw("POST", "/v1/artifacts", small, first.token, uploadHeaders("bad.txt", small.length, "0".repeat(64)));
  assert(mismatch.status === 422, "small checksum mismatch rejected");
  const smallResponse = await requestRaw("POST", "/v1/artifacts", small, first.token, { ...uploadHeaders("small.txt", small.length, smallSha), "x-artifact-retention": "7d" });
  assert(smallResponse.status === 201, "small upload");
  const smallArtifact = await smallResponse.json();
  resources.artifacts.push(smallArtifact.id);
  assert(smallArtifact.sha256 === smallSha && smallArtifact.retention === "7d", "small integrity and retention metadata");
  assert((await requestRaw("GET", `/v1/artifacts/${smallArtifact.id}`)).status === 401, "private without key");
  assert((await requestRaw("GET", `/v1/artifacts/${smallArtifact.id}`, undefined, second.token)).status === 404, "owner isolation");
  cases.push("small-upload-integrity-owner-isolation");

  const rotated = await issueKey("e2e-owner-one");
  assert((await requestRaw("GET", `/v1/artifacts/${smallArtifact.id}`, undefined, rotated.token)).status === 200, "principal survives key rotation");
  cases.push("principal-key-rotation");

  const downloaded = await requestRaw("GET", `/v1/artifacts/${smallArtifact.id}`, undefined, first.token);
  assert(downloaded.status === 200 && equal(new Uint8Array(await downloaded.arrayBuffer()), small), "authenticated download");
  const etag = downloaded.headers.get("etag");
  assert(etag && (await requestRaw("GET", `/v1/artifacts/${smallArtifact.id}`, undefined, first.token, { "if-none-match": etag })).status === 304, "conditional GET");
  const head = await requestRaw("HEAD", `/v1/artifacts/${smallArtifact.id}`, undefined, first.token);
  assert(head.status === 200 && head.headers.get("content-length") === String(small.length), "HEAD metadata");
  const range = await requestRaw("GET", `/v1/artifacts/${smallArtifact.id}`, undefined, first.token, { range: "bytes=0-5" });
  assert(range.status === 206 && await range.text() === "agent-", "HTTP Range");
  cases.push("get-head-range-conditional");

  const share = await request("POST", `/v1/artifacts/${smallArtifact.id}/shares`, { retention: "temporary", expires_in_seconds: 600 }, rotated.token);
  const shared = await requestRaw("GET", new URL(share.url).pathname, undefined, undefined, { range: "bytes=-6" });
  assert(shared.status === 206 && await shared.text() === "ayload", "bearerless share Range");
  await requestRaw("DELETE", `/v1/shares/${share.id}`, undefined, rotated.token);
  assert((await requestRaw("GET", new URL(share.url).pathname)).status === 404, "share revoke");
  cases.push("share-create-range-revoke");

  const partSize = capabilities.multipart_part_size_bytes;
  const large = new Uint8Array(capabilities.max_small_upload_bytes + 1024);
  large.fill(65);
  large.set(new TextEncoder().encode("multipart-e2e"), large.length - 13);
  const init = await request("POST", "/v1/uploads", { filename:"large.bin", content_type:"application/octet-stream", size_bytes:large.length, sha256:sha256(large), purpose:"e2e", retention:"30d" }, first.token);
  resources.artifacts.push(init.artifact_id);
  assert(init.total_parts === Math.ceil(large.length / partSize) && init.total_parts > 2, "multipart threshold init");
  assert((await requestRaw("PUT", `/v1/uploads/${init.upload_id}/parts/1`, new Uint8Array(2), first.token, { "content-length":"2" })).status === 422, "multipart part sizing");
  for (let part = 0; part < init.total_parts; part += 1) {
    const chunk = large.slice(part * init.part_size_bytes, Math.min(large.length, (part + 1) * init.part_size_bytes));
    assert((await requestRaw("PUT", `/v1/uploads/${init.upload_id}/parts/${part + 1}`, chunk, first.token, { "content-length":String(chunk.length) })).status === 200, `multipart part ${part + 1}`);
  }
  const complete = await request("POST", `/v1/uploads/${init.upload_id}/complete`, {}, first.token);
  const repeated = await request("POST", `/v1/uploads/${init.upload_id}/complete`, {}, first.token);
  assert(complete.id === init.artifact_id && repeated.id === init.artifact_id, "idempotent completion");
  const largeRange = await requestRaw("GET", `/v1/artifacts/${init.artifact_id}`, undefined, first.token, { range:`bytes=${large.length - 13}-${large.length - 1}` });
  assert(largeRange.status === 206 && await largeRange.text() === "multipart-e2e", "large Range playback");
  cases.push("multipart-over-direct-limit-idempotency-range");

  const overview = await request("GET", "/v1/admin/overview", undefined, adminToken);
  assert(overview.active_keys >= 3 && overview.active_artifacts >= 2, "admin overview state");
  const artifacts = await request("GET", "/v1/admin/artifacts?q=e2e-owner-one", undefined, adminToken);
  assert(artifacts.data.some((item) => item.id === smallArtifact.id), "admin artifact search");
  const audit = await request("GET", "/v1/admin/audit-logs?limit=100", undefined, adminToken);
  assert(audit.data.some((item) => item.event_type === "artifact.upload" && item.artifact_id === smallArtifact.id && item.synthetic === 1), "audit ledger and synthetic marker");
  const cleanAnalytics = await request("GET", "/v1/admin/analytics?days=30", undefined, adminToken);
  assert(cleanAnalytics.include_synthetic === false && cleanAnalytics.totals.uploads === 0, "synthetic traffic hidden by default");
  const allAnalytics = await waitForAnalytics();
  assert(allAnalytics.include_synthetic === true && allAnalytics.totals.uploads >= 2 && allAnalytics.totals.downloads >= 2 && allAnalytics.totals.shares >= 1, "usage rollup analytics");
  cases.push("admin-overview-artifacts-audit-analytics");

  await requestRaw("DELETE", `/v1/admin/api-keys/${first.id}`, undefined, undefined, { authorization:`Bearer ${adminToken}` });
  resources.keys.splice(resources.keys.indexOf(first.id), 1);
  assert((await requestRaw("GET", `/v1/artifacts/${smallArtifact.id}`, undefined, first.token)).status === 401, "immediate key revoke");
  cases.push("immediate-key-revoke");
} catch (cause) {
  failure = cause;
} finally {
  for (const artifactId of resources.artifacts) await cleanup("artifact", artifactId, `/v1/admin/artifacts/${artifactId}`);
  for (const keyId of resources.keys) await cleanup("key", keyId, `/v1/admin/api-keys/${keyId}`);
}

if (cleanupFailures.length) {
  const cleanupError = new Error(`E2E cleanup failed: ${cleanupFailures.join("; ")}`);
  failure = failure ? new AggregateError([failure, cleanupError], "E2E assertions and cleanup failed") : cleanupError;
}

if (failure) {
  console.error(JSON.stringify({ ok:false, error:failure instanceof Error ? failure.message : String(failure), completed_cases:cases }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok:true, base_url:baseUrl, cases }, null, 2));
}

async function issueKey(owner) {
  const issued = await request("POST", "/v1/admin/api-keys", { owner, synthetic:true, scopes:["artifact:write", "artifact:read", "artifact:delete", "share:create"] }, adminToken);
  resources.keys.push(issued.id);
  return issued;
}
async function waitForAnalytics() {
  const deadline = Date.now() + 5000;
  let result;
  while (Date.now() < deadline) {
    result = await request("GET", "/v1/admin/analytics?days=30&include_synthetic=true", undefined, adminToken);
    if (result.totals.uploads >= 2 && result.totals.downloads >= 2) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return result;
}
async function waitForCapabilities() {
  const deadline = Date.now() + 30_000;
  let result;
  while (Date.now() < deadline) {
    result = await request("GET", "/v1/capabilities");
    if (result.max_multipart_parts === 10_000 && result.supports_resume === true) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Worker capabilities did not converge after deploy: ${JSON.stringify(result)}`);
}
async function request(method, path, body, bearer) { const response = await requestRaw(method, path, body === undefined ? undefined : JSON.stringify(body), bearer, body === undefined ? {} : { "content-type":"application/json" }); const text = await response.text(); const data = text ? JSON.parse(text) : {}; if (!response.ok) throw new Error(`${method} ${path} ${response.status}: ${text}`); return data; }
async function requestRaw(method, path, body, bearer, extra = {}) {
  const headers = { ...extra };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (accessClientId && accessClientSecret && (path === "/admin/" || path.startsWith("/v1/admin/"))) {
    headers["cf-access-client-id"] = accessClientId;
    headers["cf-access-client-secret"] = accessClientSecret;
  }
  return fetch(`${baseUrl}${path}`, { method, body, headers });
}
async function cleanup(type, id, path) {
  try {
    const response = await requestRaw("DELETE", path, undefined, undefined, { authorization:`Bearer ${adminToken}` });
    if (response.status !== 204 && response.status !== 404) cleanupFailures.push(`${type} ${id}: ${response.status}`);
  } catch (cause) {
    cleanupFailures.push(`${type} ${id}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
function uploadHeaders(filename, length, hash) { return { "content-type":"text/plain", "content-length":String(length), "x-filename":filename, "x-artifact-sha256":hash, "x-purpose":"e2e" }; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function equal(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function assert(condition, label) { if (!condition) throw new Error(`E2E assertion failed: ${label}`); }

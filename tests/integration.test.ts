import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runCleanup } from "../src/cleanup";

const adminHeaders = { authorization: "Bearer test-admin-token", "content-type": "application/json" };

describe("artifact service", () => {
  it("keeps artifacts private to their owner and revokes keys immediately", async () => {
    const first = await issueKey("agent-one");
    const second = await issueKey("agent-two");
    const body = new TextEncoder().encode("private evidence");
    const artifact = await upload(first.token, body, "private.txt");

    expect((await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}`, { headers: bearer(first.token) })).status).toBe(200);
    expect((await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}`, { headers: bearer(second.token) })).status).toBe(404);

    expect((await SELF.fetch(`https://example.test/v1/admin/api-keys/${first.id}`, { method: "DELETE", headers: adminHeaders })).status).toBe(204);
    expect((await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}`, { headers: bearer(first.token) })).status).toBe(401);
  });

  it("verifies small-upload checksums and persists retention", async () => {
    const key = await issueKey("checksum-agent");
    const body = new TextEncoder().encode("checksum protected");
    const bad = await SELF.fetch("https://example.test/v1/artifacts", {
      method: "POST", headers: { ...bearer(key.token), "content-type": "text/plain", "content-length": String(body.length), "x-filename": "bad.txt", "x-artifact-sha256": "0".repeat(64) }, body,
    });
    expect(bad.status).toBe(422);

    const artifact = await upload(key.token, body, "good.txt", "7d");
    const row = await env.DB.prepare("SELECT retention, expires_at, checksum_status FROM artifacts WHERE id = ?1").bind(artifact.id).first<{ retention: string; expires_at: number | null; checksum_status: string }>();
    expect(row?.retention).toBe("7d");
    expect(row?.expires_at).toBeTypeOf("number");
    expect(row?.checksum_status).toBe("verified");
  });

  it("rejects malformed multipart parts and makes completion idempotent", async () => {
    const key = await issueKey("multipart-agent");
    const size = Number(env.MULTIPART_PART_SIZE_BYTES) + 3;
    const initResponse = await SELF.fetch("https://example.test/v1/uploads", {
      method: "POST", headers: { ...bearer(key.token), "content-type": "application/json" },
      body: JSON.stringify({ filename: "large.bin", content_type: "application/octet-stream", size_bytes: size, sha256: "a".repeat(64), retention: "30d" }),
    });
    expect(initResponse.status).toBe(201);
    const init = await initResponse.json<{ upload_id: string; part_size_bytes: number }>();
    const invalid = new Uint8Array(2);
    const invalidResponse = await SELF.fetch(`https://example.test/v1/uploads/${init.upload_id}/parts/1`, { method: "PUT", headers: { ...bearer(key.token), "content-length": "2" }, body: invalid });
    expect(invalidResponse.status).toBe(422);

    const first = new Uint8Array(init.part_size_bytes);
    const second = new Uint8Array(3);
    for (const [part, chunk] of [[1, first], [2, second]] as const) {
      expect((await SELF.fetch(`https://example.test/v1/uploads/${init.upload_id}/parts/${part}`, { method: "PUT", headers: { ...bearer(key.token), "content-length": String(chunk.length) }, body: chunk })).status).toBe(200);
    }
    const complete = () => SELF.fetch(`https://example.test/v1/uploads/${init.upload_id}/complete`, { method: "POST", headers: { ...bearer(key.token), "content-type": "application/json" }, body: "{}" });
    expect((await complete()).status).toBe(200);
    expect((await complete()).status).toBe(200);
  });

  it("cleans expired artifacts and exposes the admin dashboard APIs", async () => {
    const key = await issueKey("cleanup-agent");
    const artifact = await upload(key.token, new TextEncoder().encode("expired"), "expired.txt");
    await env.DB.prepare("UPDATE artifacts SET expires_at = 1 WHERE id = ?1").bind(artifact.id).run();
    const cleanup = await runCleanup(env);
    expect(cleanup.expiredArtifacts).toBe(1);
    expect(cleanup.reconciledObjects).toBe(0);
    expect(await env.ARTIFACTS.head(`artifacts/${artifact.id}`)).toBeNull();
    const purged = await env.DB.prepare("SELECT r2_deleted_at FROM artifacts WHERE id = ?1").bind(artifact.id).first<{ r2_deleted_at: number | null }>();
    expect(purged?.r2_deleted_at).toBeTypeOf("number");

    const session = await SELF.fetch("https://example.test/v1/admin/session", { headers: adminHeaders });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ authenticated: true, mode: "break-glass" });
    expect((await SELF.fetch("https://example.test/v1/admin/overview", { headers: adminHeaders })).status).toBe(200);
    const adminCleanup = await SELF.fetch("https://example.test/v1/admin/cleanup", { method: "POST", headers: adminHeaders });
    expect(adminCleanup.status).toBe(200);
    expect(await adminCleanup.json()).toMatchObject({ reconciledObjects: 0 });
  });
});

async function issueKey(owner: string): Promise<{ id: string; token: string }> {
  const response = await SELF.fetch("https://example.test/v1/admin/api-keys", { method: "POST", headers: adminHeaders, body: JSON.stringify({ owner, scopes: ["artifact:write", "artifact:read", "artifact:delete", "share:create"] }) });
  expect(response.status).toBe(201);
  return response.json();
}

async function upload(token: string, body: Uint8Array, filename: string, retention = "30d"): Promise<{ id: string }> {
  const bytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
  const response = await SELF.fetch("https://example.test/v1/artifacts", { method: "POST", headers: { ...bearer(token), "content-type": "text/plain", "content-length": String(body.length), "x-filename": filename, "x-artifact-sha256": hash, "x-artifact-retention": retention }, body: bytes });
  expect(response.status).toBe(201);
  return response.json();
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

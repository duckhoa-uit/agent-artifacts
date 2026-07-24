import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
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

    const rotated = await issueKey("agent-one");
    expect((await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}`, { headers: bearer(rotated.token) })).status).toBe(200);
    const shareResponse = await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}/shares`, {
      method: "POST",
      headers: { ...bearer(rotated.token), "content-type": "application/json" },
      body: JSON.stringify({ retention: "temporary" }),
    });
    expect(shareResponse.status).toBe(201);
    const share = await shareResponse.json<{ id: string }>();
    expect((await SELF.fetch(`https://example.test/v1/shares/${share.id}`, { method: "DELETE", headers: bearer(rotated.token) })).status).toBe(204);

    expect((await SELF.fetch(`https://example.test/v1/admin/api-keys/${first.id}`, { method: "DELETE", headers: adminHeaders })).status).toBe(204);
    expect((await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}`, { headers: bearer(first.token) })).status).toBe(401);
    expect((await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}`, { headers: bearer(rotated.token) })).status).toBe(200);
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

  it("forces active content to download under a sandboxed response", async () => {
    const key = await issueKey("active-content-agent");
    const body = new TextEncoder().encode("<script src='/admin/app.js'></script>");
    const artifact = await upload(key.token, body, "payload.html", "30d", "text/html");
    const shareResponse = await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}/shares`, {
      method: "POST",
      headers: { ...bearer(key.token), "content-type": "application/json" },
      body: JSON.stringify({ retention: "temporary" }),
    });
    expect(shareResponse.status).toBe(201);
    const share = await shareResponse.json<{ url: string }>();
    const response = await SELF.fetch(share.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("rate-limits repeated downloads of the same public share", async () => {
    const key = await issueKey("rate-limit-agent");
    const artifact = await upload(key.token, new TextEncoder().encode("bounded share"), "bounded.txt");
    const shareResponse = await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}/shares`, {
      method: "POST",
      headers: { ...bearer(key.token), "content-type": "application/json" },
      body: JSON.stringify({ retention: "temporary" }),
    });
    const share = await shareResponse.json<{ url: string }>();
    const limiter = vi.spyOn(env.SHARE_DOWNLOAD_RATE_LIMITER, "limit").mockResolvedValueOnce({ success: false });
    try {
      const limited = await SELF.fetch(share.url);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
    } finally {
      limiter.mockRestore();
    }
  });

  it("rejects malformed multipart parts and makes completion idempotent", async () => {
    const key = await issueKey("multipart-agent");
    const size = Number(env.MULTIPART_PART_SIZE_BYTES) + 3;
    const initResponse = await SELF.fetch("https://example.test/v1/uploads", {
      method: "POST", headers: { ...bearer(key.token), "content-type": "application/json" },
      body: JSON.stringify({ filename: "large.bin", content_type: "application/octet-stream", size_bytes: size, sha256: "a".repeat(64), retention: "30d" }),
    });
    expect(initResponse.status).toBe(201);
    const init = await initResponse.json<{ upload_id: string; artifact_id: string; part_size_bytes: number }>();
    const prematureShare = await SELF.fetch(`https://example.test/v1/artifacts/${init.artifact_id}/shares`, {
      method: "POST",
      headers: { ...bearer(key.token), "content-type": "application/json" },
      body: JSON.stringify({ retention: "temporary" }),
    });
    expect(prematureShare.status).toBe(404);
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

  it("caps active multipart sessions per principal", async () => {
    const key = await issueKey("bounded-multipart-agent");
    const body = JSON.stringify({
      filename: "bounded.bin",
      content_type: "application/octet-stream",
      size_bytes: Number(env.MULTIPART_PART_SIZE_BYTES) + 1,
      sha256: "b".repeat(64),
      retention: "30d",
    });
    for (let index = 0; index < 20; index += 1) {
      const response = await SELF.fetch("https://example.test/v1/uploads", {
        method: "POST",
        headers: { ...bearer(key.token), "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(201);
    }
    const limited = await SELF.fetch("https://example.test/v1/uploads", {
      method: "POST",
      headers: { ...bearer(key.token), "content-type": "application/json" },
      body,
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "too_many_active_uploads" } });
  });

  it("cleans expired artifacts and exposes the admin dashboard APIs", async () => {
    const key = await issueKey("cleanup-agent");
    const artifact = await upload(key.token, new TextEncoder().encode("expired"), "expired.txt");
    await env.DB.prepare("UPDATE artifacts SET expires_at = 1 WHERE id = ?1").bind(artifact.id).run();
    await env.DB.prepare("INSERT INTO audit_logs (event_type, created_at) VALUES ('old.event', 1)").run();
    const cleanup = await runCleanup(env);
    expect(cleanup.expiredArtifacts).toBe(1);
    expect(cleanup.reconciledObjects).toBe(0);
    expect(cleanup.purgedRows).toBeGreaterThanOrEqual(1);
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

    const inventory = await SELF.fetch("https://example.test/v1/admin/artifacts?limit=1&offset=0", { headers: adminHeaders });
    expect(inventory.status).toBe(200);
    expect(await inventory.json()).toMatchObject({ total: expect.any(Number), limit: 1, offset: 0 });
  });

  it("rejects cross-site admin mutations and non-JSON admin bodies", async () => {
    const crossSite = await SELF.fetch("https://example.test/v1/admin/cleanup", {
      method: "POST",
      headers: { ...adminHeaders, origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);

    const wrongContentType = await SELF.fetch("https://example.test/v1/admin/api-keys", {
      method: "POST",
      headers: { ...adminHeaders, origin: "https://example.test", "content-type": "text/plain" },
      body: JSON.stringify({ owner: "csrf-attempt", scopes: ["artifact:read"] }),
    });
    expect(wrongContentType.status).toBe(415);

    const sameOrigin = await SELF.fetch("https://example.test/v1/admin/cleanup", {
      method: "POST",
      headers: { ...adminHeaders, origin: "https://example.test", "sec-fetch-site": "same-origin" },
    });
    expect(sameOrigin.status).toBe(200);
  });

  it("separates synthetic usage from the admin analytics rollup", async () => {
    const key = await issueKey("synthetic-agent", true);
    const artifact = await upload(key.token, new TextEncoder().encode("analytics"), "analytics.txt");
    expect((await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}`, { headers: bearer(key.token) })).status).toBe(200);

    const hidden = await SELF.fetch("https://example.test/v1/admin/analytics?days=30", { headers: adminHeaders });
    expect(hidden.status).toBe(200);
    expect(await hidden.json()).toMatchObject({ include_synthetic: false, totals: { uploads: 0, downloads: 0, shares: 0 } });

    const visible = await SELF.fetch("https://example.test/v1/admin/analytics?days=30&include_synthetic=true", { headers: adminHeaders });
    expect(visible.status).toBe(200);
    const payload = await visible.json<{ totals: { uploads: number; downloads: number }; daily: Array<{ synthetic: number }> }>();
    expect(payload.totals.uploads).toBeGreaterThanOrEqual(1);
    expect(payload.totals.downloads).toBeGreaterThanOrEqual(1);
    expect(payload.daily.some((row) => row.synthetic === 1)).toBe(true);
  });

  it("keeps a revoked key while an active retained share references it", async () => {
    const uploader = await issueKey("rotation-owner");
    const rotated = await issueKey("rotation-owner");
    const artifact = await upload(uploader.token, new TextEncoder().encode("retained"), "retained.txt", "retain");
    const share = await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}/shares`, {
      method: "POST",
      headers: { ...bearer(rotated.token), "content-type": "application/json" },
      body: JSON.stringify({ retention: "retain" }),
    });
    expect(share.status).toBe(201);
    expect((await SELF.fetch(`https://example.test/v1/admin/api-keys/${rotated.id}`, { method: "DELETE", headers: adminHeaders })).status).toBe(204);
    await env.DB.prepare("UPDATE api_keys SET revoked_at = 1 WHERE id = ?1").bind(rotated.id).run();

    await expect(runCleanup(env)).resolves.toMatchObject({ failures: 0 });
    expect(await env.DB.prepare("SELECT id FROM api_keys WHERE id = ?1").bind(rotated.id).first()).not.toBeNull();
  });
});

async function issueKey(owner: string, synthetic = true): Promise<{ id: string; token: string }> {
  const response = await SELF.fetch("https://example.test/v1/admin/api-keys", { method: "POST", headers: adminHeaders, body: JSON.stringify({ owner, synthetic, scopes: ["artifact:write", "artifact:read", "artifact:delete", "share:create"] }) });
  expect(response.status).toBe(201);
  return response.json();
}

async function upload(token: string, body: Uint8Array, filename: string, retention = "30d", contentType = "text/plain"): Promise<{ id: string }> {
  const bytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
  const response = await SELF.fetch("https://example.test/v1/artifacts", { method: "POST", headers: { ...bearer(token), "content-type": contentType, "content-length": String(body.length), "x-filename": filename, "x-artifact-sha256": hash, "x-artifact-retention": retention }, body: bytes });
  expect(response.status).toBe(201);
  return response.json();
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

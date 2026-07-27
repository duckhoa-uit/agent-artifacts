import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { runCleanup } from "../src/cleanup";

const adminHeaders = { authorization: "Bearer test-admin-token", "content-type": "application/json" };

describe("artifact service", () => {
  it("advertises direct and resumable multipart upload limits", async () => {
    const response = await SELF.fetch("https://example.test/v1/capabilities");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      max_small_upload_bytes: Number(env.MAX_SMALL_UPLOAD_BYTES),
      multipart_part_size_bytes: Number(env.MULTIPART_PART_SIZE_BYTES),
      max_multipart_parts: 10_000,
      max_multipart_upload_bytes: Number(env.MULTIPART_PART_SIZE_BYTES) * 10_000,
      supports_resume: true,
    });
  });

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

  it("enforces owner isolation across artifact and multipart mutations", async () => {
    const first = await issueKey("matrix-owner-one");
    const second = await issueKey("matrix-owner-two");
    const body = new TextEncoder().encode("owner matrix");

    const artifact = await upload(first.token, body, "matrix.txt");
    expect((await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}`, { headers: bearer(first.token) })).status).toBe(200);
    expect((await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}`, { method: "HEAD", headers: bearer(first.token) })).status).toBe(200);
    expect((await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}`, { headers: bearer(second.token) })).status).toBe(404);
    expect((await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}`, { method: "HEAD", headers: bearer(second.token) })).status).toBe(404);

    expect((await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}`, { method: "DELETE", headers: bearer(second.token) })).status).toBe(404);
    const afterDeleteDenial = await env.DB.prepare("SELECT deleted_at FROM artifacts WHERE id = ?1").bind(artifact.id).first<{ deleted_at: number | null }>();
    expect(afterDeleteDenial?.deleted_at).toBeNull();
    expect((await SELF.fetch(`https://example.test/v1/artifacts/${artifact.id}`, { method: "DELETE", headers: bearer(first.token) })).status).toBe(204);

    const shareArtifact = await upload(first.token, body, "share-matrix.txt");
    const sharesBefore = await env.DB.prepare("SELECT COUNT(*) AS count FROM shares WHERE artifact_id = ?1").bind(shareArtifact.id).first<{ count: number }>();
    const deniedShare = await SELF.fetch(`https://example.test/v1/artifacts/${shareArtifact.id}/shares`, {
      method: "POST", headers: { ...bearer(second.token), "content-type": "application/json" }, body: JSON.stringify({ retention: "temporary" }),
    });
    expect(deniedShare.status).toBe(404);
    const sharesAfter = await env.DB.prepare("SELECT COUNT(*) AS count FROM shares WHERE artifact_id = ?1").bind(shareArtifact.id).first<{ count: number }>();
    expect(sharesAfter?.count).toBe(sharesBefore?.count ?? 0);
    const createdShare = await SELF.fetch(`https://example.test/v1/artifacts/${shareArtifact.id}/shares`, {
      method: "POST", headers: { ...bearer(first.token), "content-type": "application/json" }, body: JSON.stringify({ retention: "temporary" }),
    });
    expect(createdShare.status).toBe(201);
    const share = await createdShare.json<{ id: string }>();
    expect((await SELF.fetch(`https://example.test/v1/shares/${share.id}`, { method: "DELETE", headers: bearer(second.token) })).status).toBe(404);
    expect((await env.DB.prepare("SELECT revoked_at FROM shares WHERE id = ?1").bind(share.id).first<{ revoked_at: number | null }>())?.revoked_at).toBeNull();
    expect((await SELF.fetch(`https://example.test/v1/shares/${share.id}`, { method: "DELETE", headers: bearer(first.token) })).status).toBe(204);

    const partSession = await initMultipart(first.token, "part-matrix.bin");
    const partBody = new Uint8Array([7]);
    expect((await SELF.fetch(`https://example.test/v1/uploads/${partSession.upload_id}/parts/1`, { method: "PUT", headers: { ...bearer(second.token), "content-length": "1" }, body: partBody })).status).toBe(404);
    const partsAfterDenial = await env.DB.prepare("SELECT COUNT(*) AS count FROM upload_parts WHERE upload_id = ?1").bind(partSession.upload_id).first<{ count: number }>();
    expect(partsAfterDenial?.count).toBe(0);
    expect((await SELF.fetch(`https://example.test/v1/uploads/${partSession.upload_id}/parts/1`, { method: "PUT", headers: { ...bearer(first.token), "content-length": "1" }, body: partBody })).status).toBe(200);

    const completeSession = await initMultipart(first.token, "complete-matrix.bin");
    expect((await SELF.fetch(`https://example.test/v1/uploads/${completeSession.upload_id}/parts/1`, { method: "PUT", headers: { ...bearer(first.token), "content-length": "1" }, body: partBody })).status).toBe(200);
    expect((await SELF.fetch(`https://example.test/v1/uploads/${completeSession.upload_id}/complete`, { method: "POST", headers: { ...bearer(second.token), "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    const completeAfterDenial = await env.DB.prepare("SELECT status, operation FROM upload_sessions WHERE id = ?1").bind(completeSession.upload_id).first<{ status: string; operation: string | null }>();
    expect(completeAfterDenial).toEqual({ status: "active", operation: null });
    expect((await SELF.fetch(`https://example.test/v1/uploads/${completeSession.upload_id}/complete`, { method: "POST", headers: { ...bearer(first.token), "content-type": "application/json" }, body: "{}" })).status).toBe(200);

    const abortSession = await initMultipart(first.token, "abort-matrix.bin");
    expect((await SELF.fetch(`https://example.test/v1/uploads/${abortSession.upload_id}`, { method: "DELETE", headers: bearer(second.token) })).status).toBe(404);
    const abortAfterDenial = await env.DB.prepare("SELECT status, operation FROM upload_sessions WHERE id = ?1").bind(abortSession.upload_id).first<{ status: string; operation: string | null }>();
    expect(abortAfterDenial).toEqual({ status: "active", operation: null });
    expect((await SELF.fetch(`https://example.test/v1/uploads/${abortSession.upload_id}`, { method: "DELETE", headers: bearer(first.token) })).status).toBe(204);
    await runCleanup(env);
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

  it("cleans up a direct upload after a stored-size mismatch", async () => {
    const key = await issueKey("size-mismatch-agent");
    const body = new TextEncoder().encode("size mismatch");
    const put = vi.spyOn(env.ARTIFACTS, "put").mockResolvedValue({ size: body.length + 1 } as R2Object);
    try {
      const response = await SELF.fetch("https://example.test/v1/artifacts", {
        method: "POST", headers: { ...bearer(key.token), "content-type": "text/plain", "content-length": String(body.length), "x-filename": "mismatch.txt", "x-artifact-sha256": "d".repeat(64) }, body,
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: "size_mismatch" } });
      const artifact = await env.DB.prepare("SELECT id FROM artifacts WHERE filename = 'mismatch.txt'").first();
      expect(artifact).toBeNull();
      expect(await env.ARTIFACTS.head(String(put.mock.calls[0]?.[0]))).toBeNull();
      expect(await env.DB.prepare("SELECT artifact_id FROM pending_artifacts WHERE r2_key = ?1").bind(String(put.mock.calls[0]?.[0])).first()).toBeNull();
    } finally {
      put.mockRestore();
    }
  });

  it("returns a deterministic checksum failure from storage", async () => {
    const key = await issueKey("checksum-failure-agent");
    const body = new TextEncoder().encode("checksum failure");
    const put = vi.spyOn(env.ARTIFACTS, "put").mockRejectedValue(new Error("sha256 checksum mismatch"));
    try {
      const response = await SELF.fetch("https://example.test/v1/artifacts", {
        method: "POST", headers: { ...bearer(key.token), "content-type": "text/plain", "content-length": String(body.length), "x-filename": "checksum-failure.txt", "x-artifact-sha256": "e".repeat(64) }, body,
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: "checksum_mismatch" } });
      expect(await env.DB.prepare("SELECT id FROM artifacts WHERE filename = 'checksum-failure.txt'").first()).toBeNull();
      expect(await env.DB.prepare("SELECT artifact_id FROM pending_artifacts WHERE r2_key = ?1").bind(String(put.mock.calls[0]?.[0])).first()).toBeNull();
    } finally {
      put.mockRestore();
    }
  });

  it("durably retries direct-upload compensation after metadata and R2 failures", async () => {
    const key = await issueKey("pending-retry-agent");
    const body = new TextEncoder().encode("pending retry");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map((value) => value.toString(16).padStart(2, "0")).join("");
    const batch = vi.spyOn(env.DB, "batch").mockRejectedValueOnce(new Error("metadata finalization failed"));
    const originalDelete = env.ARTIFACTS.delete;
    const remove = vi.spyOn(env.ARTIFACTS, "delete")
      .mockRejectedValueOnce(new Error("immediate cleanup failed"))
      .mockRejectedValueOnce(new Error("first scheduled cleanup failed"))
      .mockImplementation((r2Key) => originalDelete.call(env.ARTIFACTS, r2Key));
    try {
      const response = await SELF.fetch("https://example.test/v1/artifacts", {
        method: "POST", headers: { ...bearer(key.token), "content-type": "text/plain", "content-length": String(body.length), "x-filename": "pending-retry.txt", "x-artifact-sha256": hash }, body,
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });

      const pending = await env.DB.prepare("SELECT artifact_id, r2_key FROM pending_artifacts WHERE r2_key LIKE 'artifacts/%' ORDER BY created_at DESC LIMIT 1").first<{ artifact_id: string; r2_key: string }>();
      expect(pending).not.toBeNull();
      expect(await env.ARTIFACTS.head(pending!.r2_key)).not.toBeNull();
      expect((await SELF.fetch(`https://example.test/v1/artifacts/${pending!.artifact_id}`, { headers: bearer(key.token) })).status).toBe(404);
      expect((await SELF.fetch(`https://example.test/v1/artifacts/${pending!.artifact_id}/shares`, {
        method: "POST", headers: { ...bearer(key.token), "content-type": "application/json" }, body: JSON.stringify({ retention: "temporary" }),
      })).status).toBe(404);
      const inventory = await SELF.fetch("https://example.test/v1/admin/artifacts?q=pending-retry.txt", { headers: adminHeaders });
      expect(inventory.status).toBe(200);
      expect((await inventory.json<{ data: unknown[] }>()).data).toHaveLength(0);

      const firstCleanup = await runCleanup(env);
      expect(firstCleanup.reconciledPendingObjects).toBe(0);
      expect(firstCleanup.failures).toBeGreaterThanOrEqual(1);
      expect(await env.DB.prepare("SELECT artifact_id FROM pending_artifacts WHERE artifact_id = ?1").bind(pending!.artifact_id).first()).not.toBeNull();

      const secondCleanup = await runCleanup(env);
      expect(secondCleanup.reconciledPendingObjects).toBe(1);
      expect(secondCleanup.failures).toBe(0);
      expect(await env.DB.prepare("SELECT artifact_id FROM pending_artifacts WHERE artifact_id = ?1").bind(pending!.artifact_id).first()).toBeNull();
      expect(await env.ARTIFACTS.head(pending!.r2_key)).toBeNull();
    } finally {
      batch.mockRestore();
      remove.mockRestore();
    }
  });

  it("reconciles multipart completion and abort failures without losing session state", async () => {
    const key = await issueKey("multipart-failure-agent");
    const partBody = new Uint8Array([9]);

    const completion = await initMultipart(key.token, "missing-completion.bin");
    expect((await SELF.fetch(`https://example.test/v1/uploads/${completion.upload_id}/parts/1`, { method: "PUT", headers: { ...bearer(key.token), "content-length": "1" }, body: partBody })).status).toBe(200);
    const originalResume = env.ARTIFACTS.resumeMultipartUpload;
    const completeSpy = vi.spyOn(env.ARTIFACTS, "resumeMultipartUpload").mockImplementation((r2Key, uploadId) => {
      const multipart = originalResume.call(env.ARTIFACTS, r2Key, uploadId);
      multipart.complete = vi.fn().mockRejectedValue(new Error("missing completed object"));
      return multipart;
    });
    try {
      const response = await SELF.fetch(`https://example.test/v1/uploads/${completion.upload_id}/complete`, { method: "POST", headers: { ...bearer(key.token), "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "storage_unavailable" } });
      expect(await env.DB.prepare("SELECT status, operation FROM upload_sessions WHERE id = ?1").bind(completion.upload_id).first()).toEqual({ status: "active", operation: null });
      expect((await env.DB.prepare("SELECT deleted_at FROM artifacts WHERE id = ?1").bind(completion.artifact_id).first<{ deleted_at: number | null }>())?.deleted_at).toBeNull();
      expect(await env.ARTIFACTS.head(`artifacts/${completion.artifact_id}`)).toBeNull();
    } finally {
      completeSpy.mockRestore();
    }

    const abort = await initMultipart(key.token, "failed-abort.bin");
    const abortSpy = vi.spyOn(env.ARTIFACTS, "resumeMultipartUpload").mockImplementation((r2Key, uploadId) => {
      const multipart = originalResume.call(env.ARTIFACTS, r2Key, uploadId);
      multipart.abort = vi.fn().mockRejectedValue(new Error("abort unavailable"));
      return multipart;
    });
    try {
      const response = await SELF.fetch(`https://example.test/v1/uploads/${abort.upload_id}`, { method: "DELETE", headers: bearer(key.token) });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "upload_abort_failed" } });
      expect(await env.DB.prepare("SELECT status, operation FROM upload_sessions WHERE id = ?1").bind(abort.upload_id).first()).toEqual({ status: "active", operation: null });
    } finally {
      abortSpy.mockRestore();
    }
    expect((await SELF.fetch(`https://example.test/v1/uploads/${abort.upload_id}`, { method: "DELETE", headers: bearer(key.token) })).status).toBe(204);
    expect(await env.DB.prepare("SELECT status, operation FROM upload_sessions WHERE id = ?1").bind(abort.upload_id).first()).toEqual({ status: "aborted", operation: null });
    expect((await env.DB.prepare("SELECT deleted_at FROM artifacts WHERE id = ?1").bind(abort.artifact_id).first<{ deleted_at: number | null }>())?.deleted_at).toBeTypeOf("number");
    await runCleanup(env);
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

  it("records normal multipart completion exactly once", async () => {
    const key = await issueKey("completion-ledger-normal-agent");
    const session = await initMultipart(key.token, "ledger-normal.bin");
    await putSingleMultipartPart(key.token, session.upload_id);
    expect((await completeMultipartRequest(key.token, session.upload_id)).status).toBe(200);
    expect((await completeMultipartRequest(key.token, session.upload_id)).status).toBe(200);
    await expectCompletionLedger(session.artifact_id, key, 1);
  });

  it("recovers an already-written multipart object during a request", async () => {
    const key = await issueKey("completion-ledger-request-agent");
    const session = await prepareInterruptedCompletion(key.token, "ledger-request.bin");
    expect((await completeMultipartRequest(key.token, session.upload_id)).status).toBe(200);
    expect((await SELF.fetch(`https://example.test/v1/artifacts/${session.artifact_id}`, { headers: bearer(key.token) })).status).toBe(200);
    await expectCompletionLedger(session.artifact_id, key, 1);
  });

  it("recovers an already-written multipart object during scheduled cleanup", async () => {
    const key = await issueKey("completion-ledger-scheduled-agent");
    const session = await prepareInterruptedCompletion(key.token, "ledger-scheduled.bin");
    const cleanup = await runCleanup(env);
    expect(cleanup.failures).toBe(0);
    expect((await SELF.fetch(`https://example.test/v1/artifacts/${session.artifact_id}`, { headers: bearer(key.token) })).status).toBe(200);
    await expectCompletionLedger(session.artifact_id, key, 1);
  });

  it("coalesces request and scheduled recovery races into one completion event", async () => {
    const key = await issueKey("completion-ledger-race-agent");
    const session = await prepareInterruptedCompletion(key.token, "ledger-race.bin");
    const [request, cleanup] = await Promise.all([
      completeMultipartRequest(key.token, session.upload_id),
      runCleanup(env),
    ]);
    expect(request.status).toBe(200);
    expect(cleanup.failures).toBe(0);
    await expectCompletionLedger(session.artifact_id, key, 1);
  });

  it("retries a failed completion ledger write without duplicates", async () => {
    const key = await issueKey("completion-ledger-retry-agent");
    const session = await prepareInterruptedCompletion(key.token, "ledger-retry.bin");
    const batch = vi.spyOn(env.DB, "batch").mockRejectedValueOnce(new Error("completion ledger unavailable"));
    try {
      expect((await completeMultipartRequest(key.token, session.upload_id)).status).toBe(500);
      expect(await env.DB.prepare("SELECT status, operation FROM upload_sessions WHERE id = ?1").bind(session.upload_id).first()).toEqual({ status: "active", operation: "completing" });
    } finally {
      batch.mockRestore();
    }
    expect((await completeMultipartRequest(key.token, session.upload_id)).status).toBe(200);
    await expectCompletionLedger(session.artifact_id, key, 1);
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

  it("reconciles a soft-deleted artifact that still has an R2 object", async () => {
    const key = await issueKey("cleanup-reconcile-agent");
    const artifact = await upload(key.token, new TextEncoder().encode("soft deleted"), "soft-deleted.txt");
    await env.DB.prepare("UPDATE artifacts SET deleted_at = ?1, r2_deleted_at = NULL WHERE id = ?2").bind(Math.floor(Date.now() / 1000), artifact.id).run();

    const cleanup = await runCleanup(env);
    expect(cleanup.reconciledObjects).toBeGreaterThanOrEqual(1);
    expect(await env.ARTIFACTS.head(`artifacts/${artifact.id}`)).toBeNull();
    expect((await env.DB.prepare("SELECT r2_deleted_at FROM artifacts WHERE id = ?1").bind(artifact.id).first<{ r2_deleted_at: number | null }>())?.r2_deleted_at).toBeTypeOf("number");
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

async function initMultipart(token: string, filename: string): Promise<{ upload_id: string; artifact_id: string }> {
  const response = await SELF.fetch("https://example.test/v1/uploads", {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify({ filename, content_type: "application/octet-stream", size_bytes: 1, sha256: "c".repeat(64), retention: "30d" }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function putSingleMultipartPart(token: string, uploadId: string): Promise<void> {
  const response = await SELF.fetch(`https://example.test/v1/uploads/${uploadId}/parts/1`, {
    method: "PUT", headers: { ...bearer(token), "content-length": "1" }, body: new Uint8Array([5]),
  });
  expect(response.status).toBe(200);
}

async function completeMultipartRequest(token: string, uploadId: string): Promise<Response> {
  return SELF.fetch(`https://example.test/v1/uploads/${uploadId}/complete`, {
    method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: "{}",
  });
}

async function prepareInterruptedCompletion(token: string, filename: string): Promise<{ upload_id: string; artifact_id: string }> {
  const session = await initMultipart(token, filename);
  await putSingleMultipartPart(token, session.upload_id);
  const stored = await env.DB.prepare("SELECT r2_key, r2_upload_id FROM upload_sessions WHERE id = ?1").bind(session.upload_id).first<{ r2_key: string; r2_upload_id: string }>();
  const part = await env.DB.prepare("SELECT part_number, etag FROM upload_parts WHERE upload_id = ?1").bind(session.upload_id).first<{ part_number: number; etag: string }>();
  expect(stored).not.toBeNull();
  expect(part).not.toBeNull();
  await env.ARTIFACTS.resumeMultipartUpload(stored!.r2_key, stored!.r2_upload_id).complete([{ partNumber: part!.part_number, etag: part!.etag }]);
  await env.DB.prepare("UPDATE upload_sessions SET operation = 'completing', operation_started_at = 1 WHERE id = ?1").bind(session.upload_id).run();
  return session;
}

async function expectCompletionLedger(artifactId: string, key: { token: string }, expectedBytes: number): Promise<void> {
  const events = await env.DB.prepare("SELECT COUNT(*) AS count FROM multipart_completion_events WHERE artifact_id = ?1").bind(artifactId).first<{ count: number }>();
  expect(events?.count).toBe(1);
  const audit = await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE event_type = 'artifact.upload.complete' AND artifact_id = ?1").bind(artifactId).first<{ count: number }>();
  expect(audit?.count).toBe(1);
  const principal = await env.DB.prepare("SELECT principal_id, synthetic FROM artifacts WHERE id = ?1").bind(artifactId).first<{ principal_id: string; synthetic: number }>();
  expect(principal).not.toBeNull();
  const usage = await env.DB.prepare("SELECT request_count, bytes_count FROM usage_daily WHERE principal_id = ?1 AND event_type = 'upload' AND synthetic = ?2").bind(principal!.principal_id, principal!.synthetic).first<{ request_count: number; bytes_count: number }>();
  expect(usage).toEqual({ request_count: 1, bytes_count: expectedBytes });
  expect((await SELF.fetch(`https://example.test/v1/artifacts/${artifactId}`, { headers: bearer(key.token) })).status).toBe(200);
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

import type { AppEnv, ArtifactRow, AuthContext, Retention } from "./types";
import { audit, createShare, getArtifact } from "./db";
import { requireScope } from "./auth";
import { artifactInputSchema, multipartInputSchema, parseJson, shareInputSchema } from "./schema";
import { artifactHeaders, error, id, json, now, parseRange, safeFilename, sha256 } from "./utils";

interface ArtifactInput {
  filename: string;
  content_type: string;
  sha256?: string;
  source_agent?: string;
  repo?: string;
  pr_number?: number;
  task_id?: string;
  purpose?: string;
  retention?: Retention;
}

interface UploadSession {
  id: string;
  artifact_id: string;
  api_key_id: string;
  r2_key: string;
  r2_upload_id: string;
  total_parts: number;
  status: "active" | "completed" | "aborted";
}

export async function createSmallArtifact(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "artifact:write");
  if (auth instanceof Response) return auth;
  if (!request.body) return error("Request body is required", 400);
  const length = Number(request.headers.get("content-length"));
  const max = Number(env.MAX_SMALL_UPLOAD_BYTES);
  if (!Number.isInteger(length) || length <= 0) return error("A positive Content-Length header is required", 411, "length_required");
  if (length > max) return error("Use multipart upload for files above the small upload limit", 413, "payload_too_large");

  const parsed = artifactInputSchema.safeParse(headersInput(request.headers));
  if (!parsed.success) return error(parsed.error.issues.map((issue) => issue.message).join("; "), 400, "validation_error");
  const input = parsed.data;
  if (!input.sha256) return error("x-artifact-sha256 is required", 400, "validation_error");
  const artifactId = id("art");
  const r2Key = `artifacts/${artifactId}`;
  let stored: R2Object;
  try {
    stored = await env.ARTIFACTS.put(r2Key, request.body, {
      httpMetadata: { contentType: input.content_type },
      sha256: input.sha256,
    });
  } catch (cause) {
    console.warn(JSON.stringify({ event: "artifact.upload_rejected", artifact_id: artifactId, reason: cause instanceof Error ? cause.message : "r2_error" }));
    return error("Artifact checksum did not match the uploaded body", 422, "checksum_mismatch");
  }
  if (stored.size !== length) {
    await env.ARTIFACTS.delete(r2Key);
    return error("Stored object size does not match Content-Length", 422, "size_mismatch");
  }
  try {
    await insertArtifact(env, artifactId, auth, r2Key, stored.size, input, "verified");
  } catch (cause) {
    await env.ARTIFACTS.delete(r2Key);
    throw cause;
  }
  await audit(env, "artifact.upload", { apiKeyId: auth.id, artifactId, metadata: { mode: "small", size_bytes: stored.size, checksum: "verified" } });
  return json(artifactResponse(request, artifactId, stored.size, input, auth), 201);
}

export async function initMultipart(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "artifact:write");
  if (auth instanceof Response) return auth;
  const parsed = await parseJson(request, multipartInputSchema);
  if ("response" in parsed) return parsed.response;
  const input = parsed.data;
  const partSize = Number(env.MULTIPART_PART_SIZE_BYTES);
  const totalParts = Math.ceil(input.size_bytes / partSize);
  if (totalParts > 10_000) return error("Too many multipart parts", 400);
  const artifactId = id("art");
  const sessionId = id("upl");
  const r2Key = `artifacts/${artifactId}`;
  const multipart = await env.ARTIFACTS.createMultipartUpload(r2Key, { httpMetadata: { contentType: input.content_type } });
  const createdAt = now();
  const retention = resolveRetention(input.retention, env);
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO artifacts (id, api_key_id, filename, content_type, size_bytes, sha256, r2_key, source_agent, repo, pr_number, task_id, purpose, created_at, retention, expires_at, checksum_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'client_asserted')").bind(
        artifactId, auth.id, safeFilename(input.filename), input.content_type, input.size_bytes, input.sha256, r2Key,
        input.source_agent ?? null, input.repo ?? null, input.pr_number ?? null, input.task_id ?? null, input.purpose ?? null,
        createdAt, retention, retentionExpiry(retention, createdAt),
      ),
      env.DB.prepare("INSERT INTO upload_sessions (id, artifact_id, api_key_id, r2_key, r2_upload_id, total_parts, status, created_at, last_activity_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?7)").bind(
        sessionId, artifactId, auth.id, r2Key, multipart.uploadId, totalParts, createdAt,
      ),
    ]);
  } catch (cause) {
    await multipart.abort().catch(() => undefined);
    throw cause;
  }
  await audit(env, "artifact.upload.init", { apiKeyId: auth.id, artifactId, metadata: { mode: "multipart", total_parts: totalParts, expected_size: input.size_bytes } });
  return json({ upload_id: sessionId, artifact_id: artifactId, part_size_bytes: partSize, total_parts: totalParts }, 201);
}

export async function uploadPart(request: Request, env: AppEnv, ctx: ExecutionContext, sessionId: string, partNumberValue: string): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "artifact:write");
  if (auth instanceof Response) return auth;
  const partNumber = Number(partNumberValue);
  if (!Number.isInteger(partNumber) || partNumber < 1 || !request.body) return error("Invalid part or empty body", 400);
  const session = await env.DB.prepare(
    "SELECT s.*, a.size_bytes FROM upload_sessions s JOIN artifacts a ON a.id = s.artifact_id WHERE s.id = ?1 AND s.api_key_id = ?2 AND s.status = 'active' AND a.deleted_at IS NULL",
  ).bind(sessionId, auth.id).first<UploadSession & { size_bytes: number }>();
  if (!session) return error("Active upload session not found", 404, "not_found");
  if (partNumber > session.total_parts) return error("Part number exceeds the upload plan", 400);
  const partSize = Number(env.MULTIPART_PART_SIZE_BYTES);
  const expected = partNumber === session.total_parts ? session.size_bytes - partSize * (session.total_parts - 1) : partSize;
  const actual = Number(request.headers.get("content-length"));
  if (actual !== expected) return error(`Part ${partNumber} must be exactly ${expected} bytes`, 422, "part_size_mismatch");
  const part = await env.ARTIFACTS.resumeMultipartUpload(session.r2_key, session.r2_upload_id).uploadPart(partNumber, request.body);
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO upload_parts (upload_id, part_number, etag, size_bytes) VALUES (?1, ?2, ?3, ?4)").bind(sessionId, partNumber, part.etag, actual),
    env.DB.prepare("UPDATE upload_sessions SET last_activity_at = ?1 WHERE id = ?2").bind(now(), sessionId),
  ]);
  return json({ upload_id: sessionId, part_number: partNumber, etag: part.etag });
}

export async function completeMultipart(request: Request, env: AppEnv, ctx: ExecutionContext, sessionId: string): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "artifact:write");
  if (auth instanceof Response) return auth;
  const session = await env.DB.prepare("SELECT * FROM upload_sessions WHERE id = ?1 AND api_key_id = ?2").bind(sessionId, auth.id).first<UploadSession>();
  if (!session) return error("Upload session not found", 404, "not_found");
  if (session.status === "aborted") return error("Upload session was aborted", 409, "upload_aborted");
  if (session.status === "completed") return completedArtifactResponse(request, env, session.artifact_id, auth);
  const artifact = await getArtifact(env, session.artifact_id);
  if (!artifact) return error("Artifact metadata not found", 404, "not_found");
  const parts = await env.DB.prepare("SELECT part_number, etag, size_bytes FROM upload_parts WHERE upload_id = ?1 ORDER BY part_number ASC")
    .bind(sessionId).all<{ part_number: number; etag: string; size_bytes: number }>();
  if (parts.results.length !== session.total_parts) return error("All multipart parts must be uploaded before completion", 409, "incomplete_upload");
  if (parts.results.reduce((sum, part) => sum + part.size_bytes, 0) !== artifact.size_bytes) return error("Uploaded part sizes do not match the declared artifact size", 422, "size_mismatch");

  const multipart = env.ARTIFACTS.resumeMultipartUpload(session.r2_key, session.r2_upload_id);
  let stored: R2Object;
  try {
    stored = await multipart.complete(parts.results.map((part) => ({ partNumber: part.part_number, etag: part.etag })));
  } catch (cause) {
    const existing = await env.ARTIFACTS.head(session.r2_key);
    if (!existing) throw cause;
    stored = existing;
  }
  if (stored.size !== artifact.size_bytes) {
    await env.ARTIFACTS.delete(session.r2_key);
    await markUploadAborted(env, session);
    return error("Completed object size does not match the declared artifact size", 422, "size_mismatch");
  }
  await env.DB.prepare("UPDATE upload_sessions SET status = 'completed', completed_at = ?1, last_activity_at = ?1 WHERE id = ?2").bind(now(), sessionId).run();
  await audit(env, "artifact.upload.complete", { apiKeyId: auth.id, artifactId: artifact.id, metadata: { mode: "multipart", size_bytes: stored.size, checksum: "client_asserted" } });
  return completedArtifactResponse(request, env, artifact.id, auth);
}

export async function abortMultipart(request: Request, env: AppEnv, ctx: ExecutionContext, sessionId: string): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "artifact:write");
  if (auth instanceof Response) return auth;
  const session = await env.DB.prepare("SELECT * FROM upload_sessions WHERE id = ?1 AND api_key_id = ?2 AND status = 'active'").bind(sessionId, auth.id).first<UploadSession>();
  if (!session) return error("Active upload session not found", 404, "not_found");
  await env.ARTIFACTS.resumeMultipartUpload(session.r2_key, session.r2_upload_id).abort().catch(() => undefined);
  await markUploadAborted(env, session);
  await audit(env, "artifact.upload.abort", { apiKeyId: auth.id, artifactId: session.artifact_id });
  return new Response(null, { status: 204 });
}

export async function getArtifactResponse(request: Request, env: AppEnv, ctx: ExecutionContext, artifactId: string): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "artifact:read");
  if (auth instanceof Response) return auth;
  const artifact = await getArtifact(env, artifactId);
  if (!artifact || artifact.api_key_id !== auth.id) return error("Artifact not found", 404, "not_found");
  const response = await serveArtifact(request, env, artifact);
  if (response.status < 400) ctx.waitUntil(audit(env, "artifact.download", { apiKeyId: auth.id, artifactId, metadata: { range: response.status === 206, method: request.method } }));
  return response;
}

export async function deleteArtifact(request: Request, env: AppEnv, ctx: ExecutionContext, artifactId: string): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "artifact:delete");
  if (auth instanceof Response) return auth;
  const artifact = await getArtifact(env, artifactId);
  if (!artifact || artifact.api_key_id !== auth.id) return error("Artifact not found", 404, "not_found");
  await deleteArtifactData(env, artifact);
  await audit(env, "artifact.delete", { apiKeyId: auth.id, artifactId });
  return new Response(null, { status: 204 });
}

export async function createArtifactShare(request: Request, env: AppEnv, ctx: ExecutionContext, artifactId: string): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "share:create");
  if (auth instanceof Response) return auth;
  const artifact = await getArtifact(env, artifactId);
  if (!artifact || artifact.api_key_id !== auth.id) return error("Artifact not found", 404, "not_found");
  const body = request.headers.get("content-length") === "0" ? { retention: "temporary" as const } : await parseJson(request, shareInputSchema);
  if ("response" in body) return body.response;
  const value = "data" in body ? body.data : body;
  const expiresAt = shareExpiry(value.retention, "expires_in_seconds" in value ? value.expires_in_seconds : undefined, artifact, env);
  const share = await createShare(env, artifactId, { apiKeyId: auth.id }, expiresAt);
  await audit(env, "share.create", { apiKeyId: auth.id, artifactId, shareId: share.id, metadata: { expires_at: expiresAt } });
  return json({ id: share.id, artifact_id: artifactId, url: new URL(`/s/${share.token}/${encodeURIComponent(artifact.filename)}`, request.url).toString(), expires_at: expiresAt }, 201);
}

export async function revokeShare(request: Request, env: AppEnv, ctx: ExecutionContext, shareId: string): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "share:create");
  if (auth instanceof Response) return auth;
  const share = await env.DB.prepare("SELECT id, artifact_id, created_by_key_id FROM shares WHERE id = ?1").bind(shareId).first<{ id: string; artifact_id: string; created_by_key_id: string | null }>();
  if (!share || share.created_by_key_id !== auth.id) return error("Share not found", 404, "not_found");
  await env.DB.prepare("UPDATE shares SET revoked_at = ?1 WHERE id = ?2").bind(now(), shareId).run();
  await audit(env, "share.revoke", { apiKeyId: auth.id, artifactId: share.artifact_id, shareId });
  return new Response(null, { status: 204 });
}

export async function getSharedArtifact(request: Request, env: AppEnv, ctx: ExecutionContext, token: string): Promise<Response> {
  const share = await env.DB.prepare("SELECT id, artifact_id, expires_at, revoked_at FROM shares WHERE token_hash = ?1").bind(await sha256(token)).first<{ id: string; artifact_id: string; expires_at: number | null; revoked_at: number | null }>();
  if (!share || share.revoked_at || (share.expires_at !== null && share.expires_at <= now())) return error("Share link is invalid or expired", 404, "not_found");
  const artifact = await getArtifact(env, share.artifact_id);
  if (!artifact) return error("Artifact not found", 404, "not_found");
  const response = await serveArtifact(request, env, artifact);
  if (response.status < 400) ctx.waitUntil(audit(env, "share.download", { artifactId: artifact.id, shareId: share.id, metadata: { range: response.status === 206, method: request.method } }));
  return response;
}

export async function serveArtifact(request: Request, env: AppEnv, artifact: ArtifactRow): Promise<Response> {
  const range = parseRange(request.headers.get("range"), artifact.size_bytes);
  if (request.headers.get("range") && !range) return new Response(null, { status: 416, headers: { "content-range": `bytes */${artifact.size_bytes}` } });
  const object = await env.ARTIFACTS.get(artifact.r2_key, range ? { range } : undefined);
  if (!object) return error("Artifact object not found", 404, "not_found");
  const headers = artifactHeaders(artifact, object.httpEtag);
  if (request.headers.get("if-none-match") === object.httpEtag) return new Response(null, { status: 304, headers });
  const ifMatch = request.headers.get("if-match");
  if (ifMatch && ifMatch !== "*" && ifMatch !== object.httpEtag) return new Response(null, { status: 412, headers });
  if (range) {
    headers.set("content-length", String(range.length));
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${artifact.size_bytes}`);
  }
  return new Response(request.method === "HEAD" ? null : object.body, { status: range ? 206 : 200, headers });
}

export async function deleteArtifactData(env: AppEnv, artifact: ArtifactRow): Promise<void> {
  const active = await env.DB.prepare("SELECT * FROM upload_sessions WHERE artifact_id = ?1 AND status = 'active'").bind(artifact.id).first<UploadSession>();
  if (active) await env.ARTIFACTS.resumeMultipartUpload(active.r2_key, active.r2_upload_id).abort().catch(() => undefined);
  await env.ARTIFACTS.delete(artifact.r2_key);
  const deletedAt = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE artifacts SET deleted_at = COALESCE(deleted_at, ?1) WHERE id = ?2").bind(deletedAt, artifact.id),
    env.DB.prepare("UPDATE upload_sessions SET status = 'aborted', last_activity_at = ?1 WHERE artifact_id = ?2 AND status = 'active'").bind(deletedAt, artifact.id),
    env.DB.prepare("UPDATE shares SET revoked_at = COALESCE(revoked_at, ?1) WHERE artifact_id = ?2").bind(deletedAt, artifact.id),
  ]);
}

function headersInput(headers: Headers): Record<string, unknown> {
  return {
    filename: headers.get("x-filename") ?? "",
    content_type: headers.get("content-type") ?? "application/octet-stream",
    sha256: headers.get("x-artifact-sha256") ?? undefined,
    source_agent: headers.get("x-source-agent") ?? undefined,
    repo: headers.get("x-repo") ?? undefined,
    pr_number: headers.get("x-pr-number") ?? undefined,
    task_id: headers.get("x-task-id") ?? undefined,
    purpose: headers.get("x-purpose") ?? undefined,
    retention: headers.get("x-artifact-retention") ?? undefined,
  };
}

async function insertArtifact(env: AppEnv, artifactId: string, auth: AuthContext, r2Key: string, sizeBytes: number, input: ArtifactInput, checksumStatus: ArtifactRow["checksum_status"]): Promise<void> {
  const createdAt = now();
  const retention = resolveRetention(input.retention, env);
  await env.DB.prepare("INSERT INTO artifacts (id, api_key_id, filename, content_type, size_bytes, sha256, r2_key, source_agent, repo, pr_number, task_id, purpose, created_at, retention, expires_at, checksum_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)").bind(
    artifactId, auth.id, safeFilename(input.filename), input.content_type, sizeBytes, input.sha256 ?? null, r2Key,
    input.source_agent ?? null, input.repo ?? null, input.pr_number ?? null, input.task_id ?? null, input.purpose ?? null,
    createdAt, retention, retentionExpiry(retention, createdAt), checksumStatus,
  ).run();
}

async function completedArtifactResponse(request: Request, env: AppEnv, artifactId: string, auth: AuthContext): Promise<Response> {
  const artifact = await getArtifact(env, artifactId);
  if (!artifact) return error("Artifact metadata not found", 500, "internal_error");
  return json(artifactResponse(request, artifact.id, artifact.size_bytes, artifact, auth));
}

function artifactResponse(request: Request, artifactId: string, sizeBytes: number, input: ArtifactInput | ArtifactRow, auth: AuthContext): Record<string, unknown> {
  return {
    id: artifactId, filename: safeFilename(input.filename), content_type: input.content_type, size_bytes: sizeBytes,
    sha256: input.sha256 ?? null, url: new URL(`/v1/artifacts/${artifactId}`, request.url).toString(), owner: auth.owner,
    retention: input.retention ?? null, expires_at: "expires_at" in input ? input.expires_at : retentionExpiry(resolveRetention(input.retention, undefined), now()),
  };
}

function resolveRetention(value: Retention | undefined, env?: AppEnv): Retention {
  const configured = value ?? env?.DEFAULT_ARTIFACT_RETENTION ?? "30d";
  return configured === "7d" || configured === "retain" ? configured : "30d";
}

function retentionExpiry(retention: Retention, createdAt: number): number | null {
  if (retention === "retain") return null;
  return createdAt + (retention === "7d" ? 7 : 30) * 86_400;
}

function shareExpiry(retention: "retain" | "temporary", ttl: number | undefined, artifact: ArtifactRow, env: AppEnv): number | null {
  if (retention === "retain") return artifact.expires_at;
  const requested = now() + (ttl ?? Number(env.DEFAULT_SHARE_TTL_SECONDS));
  return artifact.expires_at === null ? requested : Math.min(requested, artifact.expires_at);
}

async function markUploadAborted(env: AppEnv, session: UploadSession): Promise<void> {
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE upload_sessions SET status = 'aborted', last_activity_at = ?1 WHERE id = ?2").bind(timestamp, session.id),
    env.DB.prepare("UPDATE artifacts SET deleted_at = COALESCE(deleted_at, ?1) WHERE id = ?2").bind(timestamp, session.artifact_id),
  ]);
}

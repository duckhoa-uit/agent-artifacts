import type { AppEnv, AuthContext } from "./types";
import { audit, createShare, getArtifact } from "./db";
import { requireScope } from "./auth";
import { artifactHeaders, error, id, json, now, parseJsonBody, parsePositiveInt, parseRange, safeFilename, sha256 } from "./utils";

interface ArtifactInput {
  filename?: string;
  content_type?: string;
  sha256?: string;
  source_agent?: string;
  repo?: string;
  pr_number?: number;
  task_id?: string;
  purpose?: string;
}

export async function createSmallArtifact(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "artifact:write");
  if (auth instanceof Response) return auth;
  const length = Number(request.headers.get("content-length") ?? 0);
  const max = Number(env.MAX_SMALL_UPLOAD_BYTES || 52428800);
  if (length > max) return error("Use multipart upload for files above the small upload limit", 413, "payload_too_large");
  if (!request.body) return error("Request body is required", 400);
  const input = headersInput(request.headers);
  const artifactId = id("art");
  const r2Key = `artifacts/${artifactId}`;
  await env.ARTIFACTS.put(r2Key, request.body, { httpMetadata: { contentType: input.content_type } });
  const sizeBytes = length || ((await env.ARTIFACTS.head(r2Key))?.size ?? 0);
  try {
    await insertArtifact(env, artifactId, auth, r2Key, sizeBytes, input);
  } catch (cause) {
    await env.ARTIFACTS.delete(r2Key);
    throw cause;
  }
  await audit(env, "artifact.upload", { apiKeyId: auth.id, artifactId, metadata: { mode: "small", size_bytes: sizeBytes } });
  return json(artifactResponse(request, artifactId, r2Key, sizeBytes, input, auth), 201);
}

export async function initMultipart(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "artifact:write");
  if (auth instanceof Response) return auth;
  const input = await parseJsonBody<ArtifactInput & { size_bytes: number }>(request);
  const sizeBytes = parsePositiveInt(input.size_bytes);
  if (!sizeBytes || !input.filename) return error("filename and positive size_bytes are required", 400);
  const partSize = Number(env.MULTIPART_PART_SIZE_BYTES || 20971520);
  const totalParts = Math.ceil(sizeBytes / partSize);
  if (totalParts > 10000) return error("Too many multipart parts", 400);
  const artifactId = id("art");
  const sessionId = id("upl");
  const r2Key = `artifacts/${artifactId}`;
  const multipart = await env.ARTIFACTS.createMultipartUpload(r2Key, { httpMetadata: { contentType: input.content_type || "application/octet-stream" } });
  const createdAt = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO artifacts (id, api_key_id, filename, content_type, size_bytes, sha256, r2_key, source_agent, repo, pr_number, task_id, purpose, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)").bind(
      artifactId, auth.id, safeFilename(input.filename), input.content_type || "application/octet-stream", sizeBytes, input.sha256 ?? null, r2Key,
      input.source_agent ?? null, input.repo ?? null, input.pr_number ?? null, input.task_id ?? null, input.purpose ?? null, createdAt,
    ),
    env.DB.prepare("INSERT INTO upload_sessions (id, artifact_id, api_key_id, r2_key, r2_upload_id, total_parts, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7)").bind(
      sessionId, artifactId, auth.id, r2Key, multipart.uploadId, totalParts, createdAt,
    ),
  ]);
  await audit(env, "artifact.upload.init", { apiKeyId: auth.id, artifactId, metadata: { mode: "multipart", total_parts: totalParts } });
  return json({ upload_id: sessionId, artifact_id: artifactId, part_size_bytes: partSize, total_parts: totalParts }, 201);
}

export async function uploadPart(request: Request, env: AppEnv, ctx: ExecutionContext, sessionId: string, partNumberValue: string): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "artifact:write");
  if (auth instanceof Response) return auth;
  const partNumber = Number(partNumberValue);
  if (!Number.isInteger(partNumber) || partNumber < 1) return error("Invalid part number", 400);
  const session = await env.DB.prepare("SELECT * FROM upload_sessions WHERE id = ?1 AND api_key_id = ?2 AND status = 'active'").bind(sessionId, auth.id).first<{ id: string; r2_key: string; r2_upload_id: string; total_parts: number }>();
  if (!session) return error("Active upload session not found", 404, "not_found");
  if (partNumber > session.total_parts || !request.body) return error("Invalid part or empty body", 400);
  const multipart = env.ARTIFACTS.resumeMultipartUpload(session.r2_key, session.r2_upload_id);
  const part = await multipart.uploadPart(partNumber, request.body);
  const sizeBytes = Number(request.headers.get("content-length") ?? 0);
  await env.DB.prepare("INSERT OR REPLACE INTO upload_parts (upload_id, part_number, etag, size_bytes) VALUES (?1, ?2, ?3, ?4)").bind(sessionId, partNumber, part.etag, sizeBytes).run();
  return json({ upload_id: sessionId, part_number: partNumber, etag: part.etag }, 200);
}

export async function completeMultipart(request: Request, env: AppEnv, ctx: ExecutionContext, sessionId: string): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "artifact:write");
  if (auth instanceof Response) return auth;
  const session = await env.DB.prepare("SELECT * FROM upload_sessions WHERE id = ?1 AND api_key_id = ?2 AND status = 'active'").bind(sessionId, auth.id).first<{ id: string; artifact_id: string; r2_key: string; r2_upload_id: string; total_parts: number }>();
  if (!session) return error("Active upload session not found", 404, "not_found");
  const parts = await env.DB.prepare("SELECT part_number, etag FROM upload_parts WHERE upload_id = ?1 ORDER BY part_number ASC").bind(sessionId).all<{ part_number: number; etag: string }>();
  if (parts.results.length !== session.total_parts) return error("All multipart parts must be uploaded before completion", 409, "incomplete_upload");
  const multipart = env.ARTIFACTS.resumeMultipartUpload(session.r2_key, session.r2_upload_id);
  await multipart.complete(parts.results.map((part) => ({ partNumber: part.part_number, etag: part.etag })));
  await env.DB.batch([
    env.DB.prepare("UPDATE upload_sessions SET status = 'completed', completed_at = ?1 WHERE id = ?2").bind(now(), sessionId),
  ]);
  const artifact = await getArtifact(env, session.artifact_id);
  if (!artifact) return error("Artifact metadata not found", 500, "internal_error");
  await audit(env, "artifact.upload.complete", { apiKeyId: auth.id, artifactId: artifact.id, metadata: { mode: "multipart" } });
  return json(artifactResponse(request, artifact.id, artifact.r2_key, artifact.size_bytes, {
    filename: artifact.filename, content_type: artifact.content_type, sha256: artifact.sha256 ?? undefined,
    source_agent: artifact.source_agent ?? undefined, repo: artifact.repo ?? undefined, pr_number: artifact.pr_number ?? undefined,
    task_id: artifact.task_id ?? undefined, purpose: artifact.purpose ?? undefined,
  }, auth));
}

export async function abortMultipart(request: Request, env: AppEnv, ctx: ExecutionContext, sessionId: string): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "artifact:write");
  if (auth instanceof Response) return auth;
  const session = await env.DB.prepare("SELECT * FROM upload_sessions WHERE id = ?1 AND api_key_id = ?2 AND status = 'active'").bind(sessionId, auth.id).first<{ id: string; artifact_id: string; r2_key: string; r2_upload_id: string }>();
  if (!session) return error("Active upload session not found", 404, "not_found");
  await env.ARTIFACTS.resumeMultipartUpload(session.r2_key, session.r2_upload_id).abort();
  await env.DB.batch([
    env.DB.prepare("UPDATE upload_sessions SET status = 'aborted' WHERE id = ?1").bind(sessionId),
    env.DB.prepare("UPDATE artifacts SET deleted_at = ?1 WHERE id = ?2").bind(now(), session.artifact_id),
  ]);
  return new Response(null, { status: 204 });
}

export async function getArtifactResponse(request: Request, env: AppEnv, ctx: ExecutionContext, artifactId: string): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "artifact:read");
  if (auth instanceof Response) return auth;
  const artifact = await getArtifact(env, artifactId);
  if (!artifact) return error("Artifact not found", 404, "not_found");
  const range = parseRange(request.headers.get("range"), artifact.size_bytes);
  if (request.headers.get("range") && !range) return new Response(null, { status: 416, headers: { "content-range": `bytes */${artifact.size_bytes}` } });
  const object = await env.ARTIFACTS.get(artifact.r2_key, range ? { range } : undefined);
  if (!object) return error("Artifact object not found", 404, "not_found");
  const headers = artifactHeaders(artifact, object.httpEtag);
  if (range) {
    headers.set("content-length", String(range.length));
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${artifact.size_bytes}`);
  }
  await audit(env, "artifact.download", { apiKeyId: auth.id, artifactId, metadata: { range: Boolean(range), method: request.method } });
  if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

export async function deleteArtifact(request: Request, env: AppEnv, ctx: ExecutionContext, artifactId: string): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "artifact:delete");
  if (auth instanceof Response) return auth;
  const artifact = await getArtifact(env, artifactId);
  if (!artifact) return error("Artifact not found", 404, "not_found");
  if (artifact.api_key_id !== auth.id) return error("Only the uploader can delete this artifact", 403, "forbidden");
  await env.ARTIFACTS.delete(artifact.r2_key);
  await env.DB.prepare("UPDATE artifacts SET deleted_at = ?1 WHERE id = ?2").bind(now(), artifactId).run();
  await env.DB.prepare("UPDATE shares SET revoked_at = ?1 WHERE artifact_id = ?2 AND revoked_at IS NULL").bind(now(), artifactId).run();
  await audit(env, "artifact.delete", { apiKeyId: auth.id, artifactId });
  return new Response(null, { status: 204 });
}

export async function createArtifactShare(request: Request, env: AppEnv, ctx: ExecutionContext, artifactId: string): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "share:create");
  if (auth instanceof Response) return auth;
  const artifact = await getArtifact(env, artifactId);
  if (!artifact) return error("Artifact not found", 404, "not_found");
  if (artifact.api_key_id !== auth.id) return error("Only the uploader can create a share", 403, "forbidden");
  let body: { expires_in_seconds?: number; retention?: "retain" | "temporary" } = {};
  if (request.headers.get("content-length") !== "0") {
    try { body = await parseJsonBody<typeof body>(request); } catch { body = {}; }
  }
  const retention = body.retention ?? "temporary";
  const ttl = parsePositiveInt(body.expires_in_seconds, Number(env.DEFAULT_SHARE_TTL_SECONDS || 604800));
  const expiresAt = retention === "retain" ? null : now() + (ttl ?? 604800);
  const share = await createShare(env, artifactId, auth.id, expiresAt);
  await audit(env, "share.create", { apiKeyId: auth.id, artifactId, shareId: share.id, metadata: { expires_at: expiresAt } });
  const url = new URL(`/s/${share.token}/${encodeURIComponent(artifact.filename)}`, request.url).toString();
  return json({ id: share.id, artifact_id: artifactId, url, expires_at: expiresAt }, 201);
}

export async function revokeShare(request: Request, env: AppEnv, ctx: ExecutionContext, shareId: string): Promise<Response> {
  const auth = await requireScope(request, env, ctx, "share:create");
  if (auth instanceof Response) return auth;
  const share = await env.DB.prepare("SELECT id, artifact_id, created_by_key_id FROM shares WHERE id = ?1").bind(shareId).first<{ id: string; artifact_id: string; created_by_key_id: string }>();
  if (!share) return error("Share not found", 404, "not_found");
  if (share.created_by_key_id !== auth.id) return error("Only the share creator can revoke it", 403, "forbidden");
  await env.DB.prepare("UPDATE shares SET revoked_at = ?1 WHERE id = ?2").bind(now(), shareId).run();
  await audit(env, "share.revoke", { apiKeyId: auth.id, artifactId: share.artifact_id, shareId });
  return new Response(null, { status: 204 });
}

export async function getSharedArtifact(request: Request, env: AppEnv, ctx: ExecutionContext, token: string): Promise<Response> {
  const share = await env.DB.prepare("SELECT id, artifact_id, expires_at, revoked_at FROM shares WHERE token_hash = ?1").bind(await sha256(token)).first<{ id: string; artifact_id: string; expires_at: number | null; revoked_at: number | null }>();
  if (!share || share.revoked_at || (share.expires_at !== null && share.expires_at <= now())) return error("Share link is invalid or expired", 404, "not_found");
  const artifact = await getArtifact(env, share.artifact_id);
  if (!artifact) return error("Artifact not found", 404, "not_found");
  const range = parseRange(request.headers.get("range"), artifact.size_bytes);
  if (request.headers.get("range") && !range) return new Response(null, { status: 416, headers: { "content-range": `bytes */${artifact.size_bytes}` } });
  const object = await env.ARTIFACTS.get(artifact.r2_key, range ? { range } : undefined);
  if (!object) return error("Artifact object not found", 404, "not_found");
  const headers = artifactHeaders(artifact, object.httpEtag);
  if (range) {
    headers.set("content-length", String(range.length));
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${artifact.size_bytes}`);
  }
  ctx.waitUntil(audit(env, "share.download", { artifactId: artifact.id, shareId: share.id, metadata: { range: Boolean(range), method: request.method } }));
  if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

function headersInput(headers: Headers): ArtifactInput {
  return {
    filename: headers.get("x-filename") ?? undefined,
    content_type: headers.get("content-type") ?? "application/octet-stream",
    sha256: headers.get("x-artifact-sha256") ?? undefined,
    source_agent: headers.get("x-source-agent") ?? undefined,
    repo: headers.get("x-repo") ?? undefined,
    pr_number: parsePositiveInt(headers.get("x-pr-number")),
    task_id: headers.get("x-task-id") ?? undefined,
    purpose: headers.get("x-purpose") ?? undefined,
  };
}

async function insertArtifact(env: AppEnv, artifactId: string, auth: AuthContext, r2Key: string, sizeBytes: number, input: ArtifactInput): Promise<void> {
  await env.DB.prepare("INSERT INTO artifacts (id, api_key_id, filename, content_type, size_bytes, sha256, r2_key, source_agent, repo, pr_number, task_id, purpose, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)").bind(
    artifactId, auth.id, safeFilename(input.filename), input.content_type || "application/octet-stream", sizeBytes, input.sha256 ?? null, r2Key,
    input.source_agent ?? null, input.repo ?? null, input.pr_number ?? null, input.task_id ?? null, input.purpose ?? null, now(),
  ).run();
}

function artifactResponse(request: Request, artifactId: string, r2Key: string, sizeBytes: number, input: ArtifactInput, auth: AuthContext): Record<string, unknown> {
  return {
    id: artifactId,
    filename: safeFilename(input.filename),
    content_type: input.content_type || "application/octet-stream",
    size_bytes: sizeBytes,
    sha256: input.sha256 ?? null,
    url: new URL(`/v1/artifacts/${artifactId}`, request.url).toString(),
    owner: auth.owner,
  };
}

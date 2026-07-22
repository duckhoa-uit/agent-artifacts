import type { AdminContext, AppEnv } from "./types";
import { AGENT_SCOPES } from "./types";
import { audit, createApiKey, createShare, getArtifact } from "./db";
import { deleteArtifactData, serveArtifact } from "./artifacts";
import { runCleanup } from "./cleanup";
import { adminShareSchema, createKeySchema, parseJson, updateKeySchema } from "./schema";
import { error, json, now } from "./utils";

export async function handleAdmin(request: Request, env: AppEnv, admin: AdminContext, path: string): Promise<Response> {
  if (path === "/v1/admin/session" && request.method === "GET") return json({ authenticated: true, actor: admin.actor, mode: admin.mode });
  if (path === "/v1/admin/overview" && request.method === "GET") return overview(env);
  if (path === "/v1/admin/cleanup" && request.method === "POST") return json(await runCleanup(env));
  if (path === "/v1/admin/api-keys" && request.method === "GET") return listApiKeys(request, env);
  if (path === "/v1/admin/api-keys" && request.method === "POST") return issueApiKey(request, env, admin);
  if (path.startsWith("/v1/admin/api-keys/") && request.method === "PATCH") return updateApiKey(request, env, admin, path.split("/")[4]);
  if (path.startsWith("/v1/admin/api-keys/") && request.method === "DELETE") return revokeApiKey(env, admin, path.split("/")[4]);
  if (path === "/v1/admin/artifacts" && request.method === "GET") return listArtifacts(request, env);
  if (path.startsWith("/v1/admin/artifacts/") && path.endsWith("/content") && (request.method === "GET" || request.method === "HEAD")) {
    return downloadArtifact(request, env, path.split("/")[4]);
  }
  if (path.startsWith("/v1/admin/artifacts/") && request.method === "DELETE") return deleteArtifact(env, admin, path.split("/")[4]);
  if (path === "/v1/admin/shares" && request.method === "GET") return listShares(request, env);
  if (path === "/v1/admin/shares" && request.method === "POST") return issueShare(request, env, admin);
  if (path.startsWith("/v1/admin/shares/") && request.method === "DELETE") return revokeShare(env, admin, path.split("/")[4]);
  if (path === "/v1/admin/audit-logs" && request.method === "GET") return listAuditLogs(request, env);
  return error("Admin route not found", 404, "not_found");
}

async function overview(env: AppEnv): Promise<Response> {
  const current = now();
  const [keys, artifacts, bytes, shares, uploads, events] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS value FROM api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?1)").bind(current).first<{ value: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS value FROM artifacts WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?1)").bind(current).first<{ value: number }>(),
    env.DB.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS value FROM artifacts WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?1)").bind(current).first<{ value: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS value FROM shares WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?1)").bind(current).first<{ value: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS value FROM upload_sessions WHERE status = 'active'").first<{ value: number }>(),
    env.DB.prepare("SELECT event_type, actor_type, actor_id, created_at FROM audit_logs ORDER BY id DESC LIMIT 8").all(),
  ]);
  return json({ active_keys: keys?.value ?? 0, active_artifacts: artifacts?.value ?? 0, stored_bytes: bytes?.value ?? 0, active_shares: shares?.value ?? 0, active_uploads: uploads?.value ?? 0, recent_events: events.results });
}

async function listApiKeys(request: Request, env: AppEnv): Promise<Response> {
  const { limit, offset } = pagination(request);
  const result = await env.DB.prepare("SELECT id, key_prefix, owner, scopes, created_at, last_used_at, expires_at, revoked_at FROM api_keys ORDER BY created_at DESC LIMIT ?1 OFFSET ?2").bind(limit, offset).all();
  return json({ data: result.results, limit, offset });
}

async function issueApiKey(request: Request, env: AppEnv, admin: AdminContext): Promise<Response> {
  const parsed = await parseJson(request, createKeySchema);
  if ("response" in parsed) return parsed.response;
  const body = parsed.data;
  const expiresAt = body.expires_at === null ? null : body.expires_at ?? (body.expires_in_seconds ? now() + body.expires_in_seconds : null);
  const created = await createApiKey(env, { owner: body.owner, scopes: body.scopes, expiresAt });
  await audit(env, "key.create", { admin, metadata: { key_id: created.record.id, owner: created.record.owner, scopes: body.scopes } });
  return json({
    id: created.record.id, token: created.token, owner: created.record.owner, scopes: body.scopes,
    expires_at: created.record.expires_at, warning: "Store this token now. It will not be returned again.",
  }, 201);
}

async function updateApiKey(request: Request, env: AppEnv, admin: AdminContext, keyId: string): Promise<Response> {
  const parsed = await parseJson(request, updateKeySchema);
  if ("response" in parsed) return parsed.response;
  const body = parsed.data;
  const current = await env.DB.prepare("SELECT id FROM api_keys WHERE id = ?1").bind(keyId).first<{ id: string }>();
  if (!current) return error("API key not found", 404, "not_found");
  const statements: D1PreparedStatement[] = [];
  if (body.scopes) statements.push(env.DB.prepare("UPDATE api_keys SET scopes = ?1 WHERE id = ?2").bind(JSON.stringify([...new Set(body.scopes)]), keyId));
  if (body.expires_at !== undefined) statements.push(env.DB.prepare("UPDATE api_keys SET expires_at = ?1 WHERE id = ?2").bind(body.expires_at, keyId));
  if (body.revoked !== undefined) statements.push(env.DB.prepare("UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2").bind(body.revoked ? now() : null, keyId));
  await env.DB.batch(statements);
  await audit(env, "key.update", { admin, metadata: { key_id: keyId, fields: Object.keys(body) } });
  const updated = await env.DB.prepare("SELECT id, key_prefix, owner, scopes, created_at, last_used_at, expires_at, revoked_at FROM api_keys WHERE id = ?1").bind(keyId).first();
  return json(updated);
}

async function revokeApiKey(env: AppEnv, admin: AdminContext, keyId: string): Promise<Response> {
  const result = await env.DB.prepare("UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?1) WHERE id = ?2").bind(now(), keyId).run();
  if (!result.meta.changes) return error("API key not found", 404, "not_found");
  await audit(env, "key.revoke", { admin, metadata: { key_id: keyId } });
  return new Response(null, { status: 204 });
}

async function listArtifacts(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const { limit, offset } = pagination(request);
  const search = `%${url.searchParams.get("q")?.trim() ?? ""}%`;
  const result = await env.DB.prepare(
    "SELECT a.id, a.filename, a.content_type, a.size_bytes, a.sha256, a.source_agent, a.repo, a.pr_number, a.task_id, a.purpose, a.created_at, a.deleted_at, a.r2_deleted_at, a.retention, a.expires_at, a.checksum_status, k.owner, k.key_prefix FROM artifacts a JOIN api_keys k ON k.id = a.api_key_id WHERE (a.filename LIKE ?1 OR k.owner LIKE ?1 OR COALESCE(a.repo, '') LIKE ?1) ORDER BY a.created_at DESC LIMIT ?2 OFFSET ?3",
  ).bind(search, limit, offset).all();
  return json({ data: result.results, limit, offset });
}

async function downloadArtifact(request: Request, env: AppEnv, artifactId: string): Promise<Response> {
  const artifact = await getArtifact(env, artifactId);
  if (!artifact) return error("Artifact not found", 404, "not_found");
  return serveArtifact(request, env, artifact);
}

async function deleteArtifact(env: AppEnv, admin: AdminContext, artifactId: string): Promise<Response> {
  const artifact = await getArtifact(env, artifactId);
  if (!artifact) return error("Artifact not found", 404, "not_found");
  await deleteArtifactData(env, artifact);
  await audit(env, "artifact.admin_delete", { admin, artifactId });
  return new Response(null, { status: 204 });
}

async function listShares(request: Request, env: AppEnv): Promise<Response> {
  const { limit, offset } = pagination(request);
  const result = await env.DB.prepare(
    "SELECT s.id, s.artifact_id, a.filename, s.created_by_key_id, s.created_by_actor, s.created_at, s.expires_at, s.revoked_at FROM shares s JOIN artifacts a ON a.id = s.artifact_id ORDER BY s.created_at DESC LIMIT ?1 OFFSET ?2",
  ).bind(limit, offset).all();
  return json({ data: result.results, limit, offset });
}

async function issueShare(request: Request, env: AppEnv, admin: AdminContext): Promise<Response> {
  const parsed = await parseJson(request, adminShareSchema);
  if ("response" in parsed) return parsed.response;
  const body = parsed.data;
  const artifact = await getArtifact(env, body.artifact_id);
  if (!artifact) return error("Artifact not found", 404, "not_found");
  let expiresAt = body.retention === "retain" ? artifact.expires_at : now() + (body.expires_in_seconds ?? Number(env.DEFAULT_SHARE_TTL_SECONDS));
  if (artifact.expires_at !== null && (expiresAt === null || expiresAt > artifact.expires_at)) expiresAt = artifact.expires_at;
  const share = await createShare(env, artifact.id, { actor: admin.actor }, expiresAt);
  await audit(env, "share.admin_create", { admin, artifactId: artifact.id, shareId: share.id, metadata: { expires_at: expiresAt } });
  return json({ id: share.id, artifact_id: artifact.id, url: new URL(`/s/${share.token}/${encodeURIComponent(artifact.filename)}`, request.url).toString(), expires_at: expiresAt }, 201);
}

async function revokeShare(env: AppEnv, admin: AdminContext, shareId: string): Promise<Response> {
  const share = await env.DB.prepare("SELECT id, artifact_id FROM shares WHERE id = ?1").bind(shareId).first<{ id: string; artifact_id: string }>();
  if (!share) return error("Share not found", 404, "not_found");
  await env.DB.prepare("UPDATE shares SET revoked_at = COALESCE(revoked_at, ?1) WHERE id = ?2").bind(now(), shareId).run();
  await audit(env, "share.admin_revoke", { admin, artifactId: share.artifact_id, shareId });
  return new Response(null, { status: 204 });
}

async function listAuditLogs(request: Request, env: AppEnv): Promise<Response> {
  const { limit, offset } = pagination(request);
  const result = await env.DB.prepare("SELECT id, event_type, api_key_id, artifact_id, share_id, actor_type, actor_id, metadata, created_at FROM audit_logs ORDER BY id DESC LIMIT ?1 OFFSET ?2").bind(limit, offset).all();
  return json({ data: result.results, limit, offset });
}

function pagination(request: Request): { limit: number; offset: number } {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  return { limit, offset };
}

export { AGENT_SCOPES };

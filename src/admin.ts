import type { AdminContext, AppEnv } from "./types";
import { AGENT_SCOPES } from "./types";
import { audit, createApiKey, createShare, getArtifact } from "./db";
import { deleteArtifactData, serveArtifact } from "./artifacts";
import { runCleanup } from "./cleanup";
import { adminShareSchema, createKeySchema, parseJson, updateKeySchema } from "./schema";
import { trackUsage } from "./usage";
import { error, json, now } from "./utils";

export async function handleAdmin(request: Request, env: AppEnv, admin: AdminContext, path: string, ctx: ExecutionContext): Promise<Response> {
  if (path === "/v1/admin/session" && request.method === "GET") return json({ authenticated: true, actor: admin.actor, mode: admin.mode });
  if (path === "/v1/admin/overview" && request.method === "GET") return overview(env);
  if (path === "/v1/admin/analytics" && request.method === "GET") return analytics(request, env);
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
  if (path === "/v1/admin/shares" && request.method === "POST") return issueShare(request, env, admin, ctx);
  if (path.startsWith("/v1/admin/shares/") && request.method === "DELETE") return revokeShare(env, admin, path.split("/")[4]);
  if (path === "/v1/admin/audit-logs" && request.method === "GET") return listAuditLogs(request, env);
  return error("Admin route not found", 404, "not_found");
}

async function overview(env: AppEnv): Promise<Response> {
  const current = now();
  const [keys, artifacts, bytes, shares, uploads, events] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS value FROM api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?1)").bind(current).first<{ value: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS value FROM artifacts a WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?1) AND NOT EXISTS (SELECT 1 FROM upload_sessions u WHERE u.artifact_id = a.id AND u.status != 'completed')").bind(current).first<{ value: number }>(),
    env.DB.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS value FROM artifacts a WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?1) AND NOT EXISTS (SELECT 1 FROM upload_sessions u WHERE u.artifact_id = a.id AND u.status != 'completed')").bind(current).first<{ value: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS value FROM shares s JOIN artifacts a ON a.id = s.artifact_id WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?1) AND a.deleted_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > ?1)").bind(current).first<{ value: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS value FROM upload_sessions WHERE status = 'active'").first<{ value: number }>(),
    env.DB.prepare("SELECT event_type, actor_type, actor_id, created_at FROM audit_logs ORDER BY id DESC LIMIT 8").all(),
  ]);
  return json({ active_keys: keys?.value ?? 0, active_artifacts: artifacts?.value ?? 0, stored_bytes: bytes?.value ?? 0, active_shares: shares?.value ?? 0, active_uploads: uploads?.value ?? 0, recent_events: events.results });
}

async function listApiKeys(request: Request, env: AppEnv): Promise<Response> {
  const { limit, offset } = pagination(request);
  const [result, total] = await Promise.all([
    env.DB.prepare("SELECT k.id, k.principal_id, k.key_prefix, k.owner, k.scopes, k.created_at, k.last_used_at, k.expires_at, k.revoked_at, k.synthetic FROM api_keys k JOIN principals p ON p.id = k.principal_id ORDER BY k.created_at DESC LIMIT ?1 OFFSET ?2").bind(limit, offset).all(),
    env.DB.prepare("SELECT COUNT(*) AS value FROM api_keys").first<{ value: number }>(),
  ]);
  return json({ data: result.results, total: total?.value ?? 0, limit, offset });
}

async function issueApiKey(request: Request, env: AppEnv, admin: AdminContext): Promise<Response> {
  const parsed = await parseJson(request, createKeySchema);
  if ("response" in parsed) return parsed.response;
  const body = parsed.data;
  const expiresAt = body.expires_at === null ? null : body.expires_at ?? (body.expires_in_seconds ? now() + body.expires_in_seconds : null);
  const created = await createApiKey(env, { owner: body.owner, scopes: body.scopes, synthetic: body.synthetic, expiresAt }, admin);
  return json({
    id: created.record.id, token: created.token, owner: created.record.owner, principal_id: created.record.principal_id, synthetic: Boolean(created.record.synthetic), scopes: body.scopes,
    expires_at: created.record.expires_at, warning: "Store this token now. It will not be returned again.",
  }, 201);
}

async function updateApiKey(request: Request, env: AppEnv, admin: AdminContext, keyId: string): Promise<Response> {
  const parsed = await parseJson(request, updateKeySchema);
  if ("response" in parsed) return parsed.response;
  const body = parsed.data;
  const current = await env.DB.prepare("SELECT id, principal_id, synthetic FROM api_keys WHERE id = ?1").bind(keyId).first<{ id: string; principal_id: string; synthetic: number }>();
  if (!current) return error("API key not found", 404, "not_found");
  const statements: D1PreparedStatement[] = [];
  if (body.scopes) statements.push(env.DB.prepare("UPDATE api_keys SET scopes = ?1 WHERE id = ?2").bind(JSON.stringify([...new Set(body.scopes)]), keyId));
  if (body.expires_at !== undefined) statements.push(env.DB.prepare("UPDATE api_keys SET expires_at = ?1 WHERE id = ?2").bind(body.expires_at, keyId));
  if (body.revoked !== undefined) statements.push(env.DB.prepare("UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2").bind(body.revoked ? now() : null, keyId));
  await env.DB.batch(statements);
  await audit(env, "key.update", { admin, principalId: current.principal_id, synthetic: Boolean(current.synthetic), metadata: { key_id: keyId, fields: Object.keys(body) } });
  const updated = await env.DB.prepare("SELECT k.id, k.principal_id, k.key_prefix, k.owner, k.scopes, k.created_at, k.last_used_at, k.expires_at, k.revoked_at, k.synthetic FROM api_keys k JOIN principals p ON p.id = k.principal_id WHERE k.id = ?1").bind(keyId).first();
  return json(updated);
}

async function revokeApiKey(env: AppEnv, admin: AdminContext, keyId: string): Promise<Response> {
  const current = await env.DB.prepare("SELECT principal_id, synthetic FROM api_keys WHERE id = ?1").bind(keyId).first<{ principal_id: string; synthetic: number }>();
  if (!current) return error("API key not found", 404, "not_found");
  const result = await env.DB.prepare("UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?1) WHERE id = ?2").bind(now(), keyId).run();
  if (!result.meta.changes) return error("API key not found", 404, "not_found");
  await audit(env, "key.revoke", { admin, principalId: current.principal_id, synthetic: Boolean(current.synthetic), metadata: { key_id: keyId } });
  return new Response(null, { status: 204 });
}

async function listArtifacts(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const { limit, offset } = pagination(request);
  const search = `%${url.searchParams.get("q")?.trim() ?? ""}%`;
  const current = now();
  const where = "(a.filename LIKE ?1 OR p.name LIKE ?1 OR COALESCE(a.repo, '') LIKE ?1)";
  const [result, total] = await Promise.all([
    env.DB.prepare(
      `SELECT a.id, a.filename, a.content_type, a.size_bytes, a.sha256, a.source_agent, a.repo, a.pr_number, a.task_id, a.purpose, a.created_at, a.deleted_at, a.r2_deleted_at, a.retention, a.expires_at, a.checksum_status, a.principal_id, a.synthetic, p.name AS owner, k.key_prefix, u.status AS upload_status,
       CASE WHEN a.deleted_at IS NOT NULL THEN 'deleted' WHEN a.expires_at IS NOT NULL AND a.expires_at <= ?2 THEN 'expired' WHEN u.status = 'active' THEN 'uploading' WHEN u.status = 'aborted' THEN 'aborted' ELSE 'active' END AS state
       FROM artifacts a JOIN api_keys k ON k.id = a.api_key_id JOIN principals p ON p.id = a.principal_id LEFT JOIN upload_sessions u ON u.artifact_id = a.id WHERE ${where} ORDER BY a.created_at DESC LIMIT ?3 OFFSET ?4`,
    ).bind(search, current, limit, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS value FROM artifacts a JOIN principals p ON p.id = a.principal_id WHERE ${where}`).bind(search).first<{ value: number }>(),
  ]);
  return json({ data: result.results, total: total?.value ?? 0, limit, offset });
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
  await audit(env, "artifact.admin_delete", { admin, principalId: artifact.principal_id, synthetic: Boolean(artifact.synthetic), artifactId });
  return new Response(null, { status: 204 });
}

async function listShares(request: Request, env: AppEnv): Promise<Response> {
  const { limit, offset } = pagination(request);
  const [result, total] = await Promise.all([
    env.DB.prepare(
      "SELECT s.id, s.artifact_id, a.filename, s.created_by_key_id, s.created_by_principal_id, s.created_by_actor, s.created_at, s.expires_at, s.revoked_at, a.deleted_at AS artifact_deleted_at, a.expires_at AS artifact_expires_at FROM shares s JOIN artifacts a ON a.id = s.artifact_id ORDER BY s.created_at DESC LIMIT ?1 OFFSET ?2",
    ).bind(limit, offset).all(),
    env.DB.prepare("SELECT COUNT(*) AS value FROM shares").first<{ value: number }>(),
  ]);
  return json({ data: result.results, total: total?.value ?? 0, limit, offset });
}

async function issueShare(request: Request, env: AppEnv, admin: AdminContext, ctx: ExecutionContext): Promise<Response> {
  const parsed = await parseJson(request, adminShareSchema);
  if ("response" in parsed) return parsed.response;
  const body = parsed.data;
  const artifact = await getArtifact(env, body.artifact_id);
  if (!artifact) return error("Artifact not found", 404, "not_found");
  let expiresAt = body.retention === "retain" ? artifact.expires_at : now() + (body.expires_in_seconds ?? Number(env.DEFAULT_SHARE_TTL_SECONDS));
  if (artifact.expires_at !== null && (expiresAt === null || expiresAt > artifact.expires_at)) expiresAt = artifact.expires_at;
  const share = await createShare(env, artifact.id, { admin, principalId: artifact.principal_id, synthetic: Boolean(artifact.synthetic) }, expiresAt);
  trackUsage(ctx, env, { principalId: artifact.principal_id, synthetic: Boolean(artifact.synthetic), eventType: "share" });
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
  const [result, total] = await Promise.all([
    env.DB.prepare("SELECT id, event_type, api_key_id, principal_id, artifact_id, share_id, actor_type, actor_id, synthetic, metadata, created_at FROM audit_logs ORDER BY id DESC LIMIT ?1 OFFSET ?2").bind(limit, offset).all(),
    env.DB.prepare("SELECT COUNT(*) AS value FROM audit_logs").first<{ value: number }>(),
  ]);
  return json({ data: result.results, total: total?.value ?? 0, limit, offset });
}

async function analytics(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 90);
  const includeSynthetic = url.searchParams.get("include_synthetic") === "true";
  const since = new Date((now() - days * 86_400) * 1000).toISOString().slice(0, 10);
  const filter = includeSynthetic ? 1 : 0;
  const [daily, principals] = await Promise.all([
    env.DB.prepare(
      "SELECT day, event_type, synthetic, SUM(request_count) AS count, SUM(bytes_count) AS bytes FROM usage_daily WHERE day >= ?1 AND (?2 = 1 OR synthetic = 0) GROUP BY day, event_type, synthetic ORDER BY day ASC, event_type ASC",
    ).bind(since, filter).all(),
    env.DB.prepare(
      "SELECT u.principal_id, COALESCE(p.name, u.principal_id) AS owner, u.synthetic, SUM(u.request_count) AS count, SUM(u.bytes_count) AS bytes FROM usage_daily u LEFT JOIN principals p ON p.id = u.principal_id WHERE u.day >= ?1 AND (?2 = 1 OR u.synthetic = 0) GROUP BY u.principal_id, owner, u.synthetic ORDER BY count DESC LIMIT 20",
    ).bind(since, filter).all(),
  ]);
  const totals = { uploads: 0, downloads: 0, shares: 0, bytes_uploaded: 0, bytes_downloaded: 0 };
  for (const row of daily.results as Array<{ event_type: string; count: number; bytes: number }>) {
    const count = Number(row.count ?? 0);
    const bytes = Number(row.bytes ?? 0);
    if (row.event_type === "upload") { totals.uploads += count; totals.bytes_uploaded += bytes; }
    if (row.event_type === "download") { totals.downloads += count; totals.bytes_downloaded += bytes; }
    if (row.event_type === "share") totals.shares += count;
  }
  return json({ days, since, include_synthetic: includeSynthetic, totals, daily: daily.results, principals: principals.results });
}

function pagination(request: Request): { limit: number; offset: number } {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  return { limit, offset };
}

export { AGENT_SCOPES };

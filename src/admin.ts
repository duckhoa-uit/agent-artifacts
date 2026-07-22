import { createApiKey } from "./db";
import { requireAdmin } from "./auth";
import { audit } from "./db";
import type { AppEnv, Scope } from "./types";
import { error, json, now, parseJsonBody, parsePositiveInt } from "./utils";

const scopes: Scope[] = ["artifact:write", "artifact:read", "artifact:delete", "share:create", "admin:keys"];

export async function listApiKeys(request: Request, env: AppEnv): Promise<Response> {
  const denied = requireAdmin(request, env);
  if (denied) return denied;
  const result = await env.DB.prepare("SELECT id, key_prefix, owner, scopes, created_at, last_used_at, expires_at, revoked_at FROM api_keys ORDER BY created_at DESC").all();
  return json({ data: result.results });
}

export async function issueApiKey(request: Request, env: AppEnv): Promise<Response> {
  const denied = requireAdmin(request, env);
  if (denied) return denied;
  const body = await parseJsonBody<{ owner?: string; scopes?: Scope[]; expires_in_seconds?: number; expires_at?: number | null }>(request);
  if (!body.owner?.trim()) return error("owner is required", 400);
  const requestedScopes = body.scopes ?? ["artifact:write", "artifact:read", "artifact:delete", "share:create"];
  if (!requestedScopes.every((scope) => scopes.includes(scope))) return error("Unknown API key scope", 400);
  const expiresAt = body.expires_at === null ? null : body.expires_at ?? (parsePositiveInt(body.expires_in_seconds) ? now() + Number(body.expires_in_seconds) : null);
  const created = await createApiKey(env, { owner: body.owner.trim(), scopes: requestedScopes, expiresAt });
  await audit(env, "key.create", { metadata: { key_id: created.record.id, owner: created.record.owner, scopes: requestedScopes } });
  return json({
    id: created.record.id,
    token: created.token,
    owner: created.record.owner,
    scopes: requestedScopes,
    expires_at: created.record.expires_at,
    warning: "Store this token now. It will not be returned again.",
  }, 201);
}

export async function updateApiKey(request: Request, env: AppEnv, keyId: string): Promise<Response> {
  const denied = requireAdmin(request, env);
  if (denied) return denied;
  const body = await parseJsonBody<{ scopes?: Scope[]; expires_at?: number | null; revoked?: boolean }>(request);
  if (body.scopes && !body.scopes.every((scope) => scopes.includes(scope))) return error("Unknown API key scope", 400);
  const current = await env.DB.prepare("SELECT id FROM api_keys WHERE id = ?1").bind(keyId).first<{ id: string }>();
  if (!current) return error("API key not found", 404, "not_found");
  const statements: D1PreparedStatement[] = [];
  if (body.scopes) statements.push(env.DB.prepare("UPDATE api_keys SET scopes = ?1 WHERE id = ?2").bind(JSON.stringify([...new Set(body.scopes)]), keyId));
  if (body.expires_at !== undefined) statements.push(env.DB.prepare("UPDATE api_keys SET expires_at = ?1 WHERE id = ?2").bind(body.expires_at, keyId));
  if (body.revoked !== undefined) statements.push(env.DB.prepare("UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2").bind(body.revoked ? now() : null, keyId));
  if (!statements.length) return error("No supported fields supplied", 400);
  await env.DB.batch(statements);
  await audit(env, "key.update", { metadata: { key_id: keyId, fields: Object.keys(body) } });
  const updated = await env.DB.prepare("SELECT id, key_prefix, owner, scopes, created_at, last_used_at, expires_at, revoked_at FROM api_keys WHERE id = ?1").bind(keyId).first();
  return json(updated);
}

export async function revokeApiKey(request: Request, env: AppEnv, keyId: string): Promise<Response> {
  const denied = requireAdmin(request, env);
  if (denied) return denied;
  const result = await env.DB.prepare("UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?1) WHERE id = ?2").bind(now(), keyId).run();
  if (!result.meta.changes) return error("API key not found", 404, "not_found");
  await audit(env, "key.revoke", { metadata: { key_id: keyId } });
  return new Response(null, { status: 204 });
}

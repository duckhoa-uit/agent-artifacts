import type { AdminContext, AppEnv, ArtifactRow, AuthContext, Scope } from "./types";
import { id, now, randomToken, sha256 } from "./utils";

export interface ApiKeyRecord {
  id: string;
  principal_id: string;
  key_prefix: string;
  owner: string;
  scopes: string;
  synthetic: number;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

export interface CreatedApiKey {
  record: ApiKeyRecord;
  token: string;
}

export async function authenticateApiKey(env: AppEnv, token: string): Promise<AuthContext | null> {
  if (!token.startsWith("ak_live_")) return null;
  const keyPrefix = token.slice(0, "ak_live_".length + 8);
  const keyHash = await sha256(token);
  const record = await env.DB.prepare(
    `SELECT k.id, k.principal_id, k.key_prefix, p.name AS owner, k.scopes, k.synthetic, k.created_at, k.last_used_at, k.expires_at, k.revoked_at
     FROM api_keys k JOIN principals p ON p.id = k.principal_id
     WHERE k.key_prefix = ?1 AND k.key_hash = ?2`,
  ).bind(keyPrefix, keyHash).first<ApiKeyRecord>();
  if (!record || record.revoked_at || (record.expires_at !== null && record.expires_at <= now())) return null;
  return {
    id: record.id,
    principal_id: record.principal_id,
    owner: record.owner,
    synthetic: Boolean(record.synthetic),
    scopes: JSON.parse(record.scopes) as Scope[],
  };
}

export async function touchKey(env: AppEnv, keyId: string): Promise<void> {
  const timestamp = now();
  await env.DB.prepare("UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?3)")
    .bind(timestamp, keyId, timestamp - 300).run();
}

export async function createApiKey(
  env: AppEnv,
  input: { owner: string; scopes: Scope[]; synthetic?: boolean; expiresAt?: number | null },
  admin: AdminContext,
): Promise<CreatedApiKey> {
  const principal = await ensurePrincipal(env, input.owner, Boolean(input.synthetic));
  const token = randomToken("ak_live");
  const keyPrefix = token.slice(0, "ak_live_".length + 8);
  const record: ApiKeyRecord = {
    id: id("key"), principal_id: principal.id, key_prefix: keyPrefix, owner: principal.name,
    scopes: JSON.stringify([...new Set(input.scopes)]), synthetic: input.synthetic ? 1 : 0, created_at: now(), last_used_at: null,
    expires_at: input.expiresAt ?? null, revoked_at: null,
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO api_keys (id, principal_id, key_prefix, key_hash, owner, scopes, synthetic, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    ).bind(record.id, record.principal_id, record.key_prefix, await sha256(token), record.owner, record.scopes, record.synthetic, record.created_at, record.expires_at),
    auditStatement(env, "key.create", { admin, principalId: record.principal_id, synthetic: Boolean(record.synthetic), metadata: { key_id: record.id, owner: record.owner, scopes: input.scopes } }),
  ]);
  return { record, token };
}

export async function getArtifact(env: AppEnv, artifactId: string): Promise<ArtifactRow | null> {
  return env.DB.prepare("SELECT a.* FROM artifacts a JOIN principals p ON p.id = a.principal_id WHERE a.id = ?1 AND a.deleted_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > ?2) AND NOT EXISTS (SELECT 1 FROM upload_sessions WHERE artifact_id = a.id AND status != 'completed')")
    .bind(artifactId, now()).first<ArtifactRow>();
}

export async function audit(
  env: AppEnv,
  eventType: string,
  details: { apiKeyId?: string; principalId?: string; synthetic?: boolean; artifactId?: string; shareId?: string; admin?: AdminContext; metadata?: Record<string, unknown> },
): Promise<void> {
  await auditStatement(env, eventType, details).run();
}

export function auditStatement(
  env: AppEnv,
  eventType: string,
  details: { apiKeyId?: string; principalId?: string; synthetic?: boolean; artifactId?: string; shareId?: string; admin?: AdminContext; metadata?: Record<string, unknown> },
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO audit_logs (event_type, api_key_id, principal_id, artifact_id, share_id, metadata, created_at, actor_type, actor_id, synthetic) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
  ).bind(
    eventType, details.apiKeyId ?? null, details.principalId ?? null, details.artifactId ?? null, details.shareId ?? null,
    details.metadata ? JSON.stringify(details.metadata) : null, now(),
    details.admin?.mode ?? (details.apiKeyId ? "api-key" : "system"), details.admin?.actor ?? details.apiKeyId ?? "worker", details.synthetic ? 1 : 0,
  );
}

export async function createShare(
  env: AppEnv,
  artifactId: string,
  creator: { apiKeyId?: string; principalId?: string; synthetic?: boolean; admin?: AdminContext },
  expiresAt: number | null,
): Promise<{ id: string; token: string; expiresAt: number | null }> {
  const token = randomToken("sh");
  const share = { id: id("share"), token, expiresAt };
  const eventType = creator.admin ? "share.admin_create" : "share.create";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO shares (id, artifact_id, token_hash, created_by_key_id, created_by_principal_id, created_by_actor, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    ).bind(share.id, artifactId, await sha256(token), creator.apiKeyId ?? null, creator.principalId ?? null, creator.admin?.actor ?? null, now(), expiresAt),
    auditStatement(env, eventType, {
      apiKeyId: creator.apiKeyId,
      principalId: creator.principalId,
      synthetic: creator.synthetic,
      admin: creator.admin,
      artifactId,
      shareId: share.id,
      metadata: { expires_at: expiresAt },
    }),
  ]);
  return share;
}

async function ensurePrincipal(env: AppEnv, name: string, synthetic: boolean): Promise<{ id: string; name: string; synthetic: number }> {
  const principalId = id("principal");
  await env.DB.prepare(
    "INSERT INTO principals (id, name, synthetic, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(name) DO NOTHING",
  ).bind(principalId, name, synthetic ? 1 : 0, now()).run();
  const principal = await env.DB.prepare("SELECT id, name, synthetic FROM principals WHERE name = ?1").bind(name).first<{ id: string; name: string; synthetic: number }>();
  if (!principal) throw new Error("Principal creation failed");
  return principal;
}

import type { AppEnv, ArtifactRow, AuthContext, Scope } from "./types";
import { id, now, randomToken, sha256 } from "./utils";

export interface ApiKeyRecord {
  id: string;
  key_prefix: string;
  owner: string;
  scopes: string;
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
  const record = await env.DB.prepare(
    "SELECT id, key_prefix, owner, scopes, created_at, last_used_at, expires_at, revoked_at FROM api_keys WHERE key_prefix = ?1",
  ).bind(keyPrefix).first<ApiKeyRecord>();
  if (!record || record.revoked_at || (record.expires_at !== null && record.expires_at <= now())) return null;
  const hash = await sha256(token);
  const hashRecord = await env.DB.prepare("SELECT id FROM api_keys WHERE id = ?1 AND key_hash = ?2")
    .bind(record.id, hash)
    .first<{ id: string }>();
  if (!hashRecord) return null;
  return { id: record.id, owner: record.owner, scopes: JSON.parse(record.scopes) as Scope[] };
}

export async function touchKey(env: AppEnv, keyId: string): Promise<void> {
  await env.DB.prepare("UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2").bind(now(), keyId).run();
}

export async function createApiKey(
  env: AppEnv,
  input: { owner: string; scopes: Scope[]; expiresAt?: number | null },
): Promise<CreatedApiKey> {
  const token = randomToken("ak_live");
  const keyPrefix = token.slice(0, "ak_live_".length + 8);
  const record: ApiKeyRecord = {
    id: id("key"),
    key_prefix: keyPrefix,
    owner: input.owner,
    scopes: JSON.stringify([...new Set(input.scopes)]),
    created_at: now(),
    last_used_at: null,
    expires_at: input.expiresAt ?? null,
    revoked_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO api_keys (id, key_prefix, key_hash, owner, scopes, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  ).bind(record.id, record.key_prefix, await sha256(token), record.owner, record.scopes, record.created_at, record.expires_at).run();
  return { record, token };
}

export async function getArtifact(env: AppEnv, artifactId: string): Promise<ArtifactRow | null> {
  return env.DB.prepare("SELECT * FROM artifacts WHERE id = ?1 AND deleted_at IS NULL").bind(artifactId).first<ArtifactRow>();
}

export async function audit(
  env: AppEnv,
  eventType: string,
  details: { apiKeyId?: string; artifactId?: string; shareId?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (event_type, api_key_id, artifact_id, share_id, metadata, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(
    eventType,
    details.apiKeyId ?? null,
    details.artifactId ?? null,
    details.shareId ?? null,
    details.metadata ? JSON.stringify(details.metadata) : null,
    now(),
  ).run();
}

export async function createShare(
  env: Env,
  artifactId: string,
  apiKeyId: string,
  expiresAt: number | null,
): Promise<{ id: string; token: string; expiresAt: number | null }> {
  const token = randomToken("sh");
  const share = { id: id("share"), token, expiresAt };
  await env.DB.prepare(
    "INSERT INTO shares (id, artifact_id, token_hash, created_by_key_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(share.id, artifactId, await sha256(token), apiKeyId, now(), expiresAt).run();
  return share;
}

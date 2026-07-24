import type { AppEnv, ArtifactRow } from "./types";
import { audit } from "./db";
import { claimUploadTransition, deleteArtifactData, releaseUploadTransition } from "./artifacts";
import { now } from "./utils";

interface CleanupResult {
  expiredArtifacts: number;
  staleUploads: number;
  reconciledObjects: number;
  purgedRows: number;
  failures: number;
}

export async function runCleanup(env: AppEnv): Promise<CleanupResult> {
  const timestamp = now();
  const staleBefore = timestamp - Number(env.UPLOAD_SESSION_TTL_SECONDS);
  let staleUploads = 0;
  let expiredArtifacts = 0;
  let reconciledObjects = 0;
  let failures = 0;

  const interrupted = await env.DB.prepare(
    "SELECT s.id, s.artifact_id, s.r2_key, s.r2_upload_id, s.operation, a.size_bytes FROM upload_sessions s JOIN artifacts a ON a.id = s.artifact_id WHERE s.status = 'active' AND s.operation IS NOT NULL AND s.operation_started_at <= ?1 ORDER BY s.operation_started_at, s.id LIMIT 100",
  ).bind(staleBefore).all<{ id: string; artifact_id: string; r2_key: string; r2_upload_id: string; operation: "completing" | "aborting"; size_bytes: number }>();
  for (const session of interrupted.results) {
    try {
      if (session.operation === "completing") {
        const object = await env.ARTIFACTS.head(session.r2_key);
        if (object?.size === session.size_bytes) {
          await env.DB.prepare(
            "UPDATE upload_sessions SET status = 'completed', operation = NULL, operation_started_at = NULL, completed_at = ?1, last_activity_at = ?1 WHERE id = ?2 AND status = 'active' AND operation = 'completing'",
          ).bind(timestamp, session.id).run();
          continue;
        }
      }
      await releaseUploadTransition(env, session.id, session.operation);
    } catch (cause) {
      failures += 1;
      logFailure("cleanup.transition_recovery_failed", session.id, cause);
    }
  }

  const stale = await env.DB.prepare(
    "SELECT s.id, s.artifact_id, s.r2_key, s.r2_upload_id FROM upload_sessions s WHERE s.status = 'active' AND s.operation IS NULL AND COALESCE(s.last_activity_at, s.created_at) <= ?1 ORDER BY COALESCE(s.last_activity_at, s.created_at), s.id LIMIT 100",
  ).bind(staleBefore).all<{ id: string; artifact_id: string; r2_key: string; r2_upload_id: string }>();
  for (const session of stale.results) {
    try {
      if (!await claimUploadTransition(env, session.id, "aborting")) continue;
      try {
        await env.ARTIFACTS.resumeMultipartUpload(session.r2_key, session.r2_upload_id).abort();
      } catch (cause) {
        await releaseUploadTransition(env, session.id, "aborting");
        throw cause;
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE upload_sessions SET status = 'aborted', operation = NULL, operation_started_at = NULL, last_activity_at = ?1 WHERE id = ?2 AND status = 'active' AND operation = 'aborting'").bind(timestamp, session.id),
        env.DB.prepare("UPDATE artifacts SET deleted_at = COALESCE(deleted_at, ?1) WHERE id = ?2").bind(timestamp, session.artifact_id),
        env.DB.prepare("UPDATE shares SET revoked_at = COALESCE(revoked_at, ?1) WHERE artifact_id = ?2").bind(timestamp, session.artifact_id),
      ]);
      await audit(env, "cleanup.upload_aborted", { artifactId: session.artifact_id, metadata: { upload_id: session.id } });
      staleUploads += 1;
    } catch (cause) {
      failures += 1;
      logFailure("cleanup.upload_abort_failed", session.id, cause);
    }
  }

  const expired = await env.DB.prepare("SELECT * FROM artifacts WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?1 ORDER BY expires_at, id LIMIT 100")
    .bind(timestamp).all<ArtifactRow>();
  for (const artifact of expired.results) {
    try {
      await deleteArtifactData(env, artifact);
      await audit(env, "cleanup.artifact_expired", { artifactId: artifact.id, metadata: { retention: artifact.retention } });
      expiredArtifacts += 1;
    } catch (cause) {
      failures += 1;
      logFailure("cleanup.artifact_expiry_failed", artifact.id, cause);
    }
  }

  const pendingObjects = await env.DB.prepare("SELECT * FROM artifacts WHERE deleted_at IS NOT NULL AND r2_deleted_at IS NULL ORDER BY deleted_at, id LIMIT 100")
    .all<ArtifactRow>();
  for (const artifact of pendingObjects.results) {
    try {
      await env.ARTIFACTS.delete(artifact.r2_key);
      await env.DB.prepare("UPDATE artifacts SET r2_deleted_at = ?1 WHERE id = ?2 AND r2_deleted_at IS NULL").bind(now(), artifact.id).run();
      await audit(env, "cleanup.r2_reconciled", { artifactId: artifact.id });
      reconciledObjects += 1;
    } catch (cause) {
      failures += 1;
      logFailure("cleanup.r2_reconcile_failed", artifact.id, cause);
    }
  }

  const purgedRows = await purgeHistory(env, timestamp);
  return { expiredArtifacts, staleUploads, reconciledObjects, purgedRows, failures };
}

async function purgeHistory(env: AppEnv, timestamp: number): Promise<number> {
  const auditBefore = timestamp - 90 * 86_400;
  const tombstoneBefore = timestamp - 30 * 86_400;
  const uploadBefore = timestamp - 7 * 86_400;
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs WHERE created_at < ?1 ORDER BY created_at LIMIT 500)").bind(auditBefore),
    env.DB.prepare("DELETE FROM usage_daily WHERE day < date(?1, 'unixepoch', '-90 days') OR (synthetic = 1 AND day < date(?1, 'unixepoch', '-30 days'))").bind(timestamp),
    env.DB.prepare("DELETE FROM upload_parts WHERE upload_id IN (SELECT id FROM upload_sessions WHERE status != 'active' AND COALESCE(completed_at, last_activity_at, created_at) < ?1 LIMIT 500)").bind(uploadBefore),
    env.DB.prepare("DELETE FROM upload_sessions WHERE id IN (SELECT id FROM upload_sessions WHERE status != 'active' AND COALESCE(completed_at, last_activity_at, created_at) < ?1 LIMIT 500)").bind(uploadBefore),
    env.DB.prepare("DELETE FROM shares WHERE id IN (SELECT id FROM shares WHERE COALESCE(revoked_at, expires_at) IS NOT NULL AND COALESCE(revoked_at, expires_at) < ?1 ORDER BY COALESCE(revoked_at, expires_at) LIMIT 500)").bind(tombstoneBefore),
    env.DB.prepare("DELETE FROM artifacts WHERE id IN (SELECT id FROM artifacts WHERE deleted_at < ?1 AND r2_deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shares WHERE shares.artifact_id = artifacts.id) AND NOT EXISTS (SELECT 1 FROM upload_sessions WHERE upload_sessions.artifact_id = artifacts.id) ORDER BY deleted_at LIMIT 500)").bind(tombstoneBefore),
    env.DB.prepare("DELETE FROM api_keys WHERE id IN (SELECT id FROM api_keys WHERE COALESCE(revoked_at, expires_at) IS NOT NULL AND COALESCE(revoked_at, expires_at) < ?1 AND NOT EXISTS (SELECT 1 FROM artifacts WHERE artifacts.api_key_id = api_keys.id) AND NOT EXISTS (SELECT 1 FROM shares WHERE shares.created_by_key_id = api_keys.id) ORDER BY COALESCE(revoked_at, expires_at) LIMIT 500)").bind(tombstoneBefore),
  ]);
  return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
}

function logFailure(event: string, id: string, cause: unknown): void {
  console.warn(JSON.stringify({ event, id, reason: cause instanceof Error ? cause.message : String(cause) }));
}

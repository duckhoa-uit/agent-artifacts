import type { AppEnv, ArtifactRow } from "./types";
import { audit } from "./db";
import { deleteArtifactData } from "./artifacts";
import { now } from "./utils";

export async function runCleanup(env: AppEnv): Promise<{ expiredArtifacts: number; staleUploads: number; reconciledObjects: number }> {
  const timestamp = now();
  const staleBefore = timestamp - Number(env.UPLOAD_SESSION_TTL_SECONDS);
  const stale = await env.DB.prepare(
    "SELECT s.id, s.artifact_id, s.r2_key, s.r2_upload_id FROM upload_sessions s WHERE s.status = 'active' AND COALESCE(s.last_activity_at, s.created_at) <= ?1 LIMIT 100",
  ).bind(staleBefore).all<{ id: string; artifact_id: string; r2_key: string; r2_upload_id: string }>();
  for (const session of stale.results) {
    await env.ARTIFACTS.resumeMultipartUpload(session.r2_key, session.r2_upload_id).abort().catch(() => undefined);
    await env.DB.batch([
      env.DB.prepare("UPDATE upload_sessions SET status = 'aborted', last_activity_at = ?1 WHERE id = ?2 AND status = 'active'").bind(timestamp, session.id),
      env.DB.prepare("UPDATE artifacts SET deleted_at = COALESCE(deleted_at, ?1) WHERE id = ?2").bind(timestamp, session.artifact_id),
    ]);
    await audit(env, "cleanup.upload_aborted", { artifactId: session.artifact_id, metadata: { upload_id: session.id } });
  }

  const expired = await env.DB.prepare("SELECT * FROM artifacts WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?1 LIMIT 100")
    .bind(timestamp).all<ArtifactRow>();
  for (const artifact of expired.results) {
    await deleteArtifactData(env, artifact);
    await audit(env, "cleanup.artifact_expired", { artifactId: artifact.id, metadata: { retention: artifact.retention } });
  }

  const pendingObjects = await env.DB.prepare("SELECT * FROM artifacts WHERE deleted_at IS NOT NULL AND r2_deleted_at IS NULL LIMIT 100")
    .all<ArtifactRow>();
  for (const artifact of pendingObjects.results) {
    await env.ARTIFACTS.delete(artifact.r2_key);
    await env.DB.prepare("UPDATE artifacts SET r2_deleted_at = ?1 WHERE id = ?2 AND r2_deleted_at IS NULL").bind(now(), artifact.id).run();
    await audit(env, "cleanup.r2_reconciled", { artifactId: artifact.id });
  }
  return { expiredArtifacts: expired.results.length, staleUploads: stale.results.length, reconciledObjects: pendingObjects.results.length };
}

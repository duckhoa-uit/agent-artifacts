CREATE TABLE IF NOT EXISTS pending_artifacts (
  artifact_id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_artifacts_created
  ON pending_artifacts(created_at, artifact_id);

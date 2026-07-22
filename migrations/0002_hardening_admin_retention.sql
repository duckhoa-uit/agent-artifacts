ALTER TABLE artifacts ADD COLUMN retention TEXT NOT NULL DEFAULT 'retain';
ALTER TABLE artifacts ADD COLUMN expires_at INTEGER;
ALTER TABLE artifacts ADD COLUMN checksum_status TEXT NOT NULL DEFAULT 'client_asserted';

CREATE INDEX IF NOT EXISTS idx_artifacts_expiry ON artifacts(expires_at, deleted_at);

ALTER TABLE upload_sessions ADD COLUMN last_activity_at INTEGER;
UPDATE upload_sessions SET last_activity_at = created_at WHERE last_activity_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_upload_sessions_cleanup ON upload_sessions(status, last_activity_at);

ALTER TABLE audit_logs ADD COLUMN actor_type TEXT;
ALTER TABLE audit_logs ADD COLUMN actor_id TEXT;

PRAGMA defer_foreign_keys = ON;

CREATE TABLE shares_v2 (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_key_id TEXT,
  created_by_actor TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id),
  FOREIGN KEY (created_by_key_id) REFERENCES api_keys(id)
);

INSERT INTO shares_v2 (id, artifact_id, token_hash, created_by_key_id, created_at, expires_at, revoked_at)
SELECT id, artifact_id, token_hash, created_by_key_id, created_at, expires_at, revoked_at FROM shares;

DROP TABLE shares;
ALTER TABLE shares_v2 RENAME TO shares;
CREATE INDEX IF NOT EXISTS idx_shares_artifact ON shares(artifact_id);
CREATE INDEX IF NOT EXISTS idx_shares_expiry ON shares(expires_at, revoked_at);

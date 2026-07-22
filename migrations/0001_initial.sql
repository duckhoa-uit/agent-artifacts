CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  source_agent TEXT,
  repo TEXT,
  pr_number INTEGER,
  task_id TEXT,
  purpose TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_key ON artifacts(api_key_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL UNIQUE,
  api_key_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  r2_upload_id TEXT NOT NULL,
  total_parts INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'aborted')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
);

CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_number),
  FOREIGN KEY (upload_id) REFERENCES upload_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_key_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id),
  FOREIGN KEY (created_by_key_id) REFERENCES api_keys(id)
);

CREATE INDEX IF NOT EXISTS idx_shares_artifact ON shares(artifact_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  api_key_id TEXT,
  artifact_id TEXT,
  share_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

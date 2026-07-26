CREATE TABLE IF NOT EXISTS multipart_completion_events (
  upload_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  synthetic INTEGER NOT NULL CHECK (synthetic IN (0, 1)),
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_multipart_completion_events_created
  ON multipart_completion_events(created_at, upload_id);

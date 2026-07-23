ALTER TABLE upload_sessions ADD COLUMN operation TEXT CHECK (operation IN ('completing', 'aborting'));
ALTER TABLE upload_sessions ADD COLUMN operation_started_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_upload_sessions_transition
  ON upload_sessions(status, operation, last_activity_at);

ALTER TABLE artifacts ADD COLUMN r2_deleted_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_artifacts_r2_cleanup ON artifacts(deleted_at, r2_deleted_at);

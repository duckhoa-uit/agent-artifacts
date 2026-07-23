CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1)),
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);

ALTER TABLE api_keys ADD COLUMN principal_id TEXT;
ALTER TABLE api_keys ADD COLUMN synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1));

INSERT INTO principals (id, name, synthetic, created_at)
SELECT
  'principal_' || lower(hex(randomblob(16))),
  owner,
  CASE
    WHEN lower(owner) LIKE '%e2e%'
      OR lower(owner) LIKE '%test%'
      OR lower(owner) LIKE '%smoke%'
      OR lower(owner) LIKE '%diagnostic%'
      OR lower(owner) LIKE '%browser%'
      OR lower(owner) LIKE '%cli%'
      OR lower(owner) LIKE '%skill%'
      OR lower(owner) LIKE '%github%'
      OR lower(owner) LIKE '%hermes%'
      OR lower(owner) LIKE '%codex%'
    THEN 1 ELSE 0
  END,
  MIN(created_at)
FROM api_keys
GROUP BY owner;

UPDATE api_keys
SET principal_id = (
  SELECT p.id FROM principals p WHERE p.name = api_keys.owner
)
WHERE principal_id IS NULL;

UPDATE api_keys
SET synthetic = COALESCE((
  SELECT p.synthetic FROM principals p WHERE p.id = api_keys.principal_id
), 0)
WHERE synthetic = 0;

CREATE INDEX IF NOT EXISTS idx_api_keys_principal ON api_keys(principal_id);

ALTER TABLE artifacts ADD COLUMN principal_id TEXT;
ALTER TABLE artifacts ADD COLUMN synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1));
UPDATE artifacts
SET principal_id = (
  SELECT k.principal_id FROM api_keys k WHERE k.id = artifacts.api_key_id
)
WHERE principal_id IS NULL;
UPDATE artifacts
SET synthetic = COALESCE((
  SELECT k.synthetic FROM api_keys k WHERE k.id = artifacts.api_key_id
), 0)
WHERE synthetic = 0;
CREATE INDEX IF NOT EXISTS idx_artifacts_principal ON artifacts(principal_id);

ALTER TABLE upload_sessions ADD COLUMN principal_id TEXT;
UPDATE upload_sessions
SET principal_id = (
  SELECT k.principal_id FROM api_keys k WHERE k.id = upload_sessions.api_key_id
)
WHERE principal_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_upload_sessions_principal ON upload_sessions(principal_id);

ALTER TABLE shares ADD COLUMN created_by_principal_id TEXT;
UPDATE shares
SET created_by_principal_id = (
  SELECT a.principal_id FROM artifacts a WHERE a.id = shares.artifact_id
)
WHERE created_by_principal_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_shares_principal ON shares(created_by_principal_id);

ALTER TABLE audit_logs ADD COLUMN principal_id TEXT;
ALTER TABLE audit_logs ADD COLUMN synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1));
UPDATE audit_logs
SET principal_id = (
  SELECT k.principal_id FROM api_keys k WHERE k.id = audit_logs.api_key_id
)
WHERE principal_id IS NULL AND api_key_id IS NOT NULL;
UPDATE audit_logs
SET synthetic = COALESCE((
  SELECT p.synthetic
  FROM principals p
  WHERE p.id = audit_logs.principal_id
), 0)
WHERE synthetic = 0;
CREATE INDEX IF NOT EXISTS idx_audit_principal_created ON audit_logs(principal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_synthetic_created ON audit_logs(synthetic, created_at);

CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('upload', 'download', 'share')),
  synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1)),
  request_count INTEGER NOT NULL DEFAULT 0,
  bytes_count INTEGER NOT NULL DEFAULT 0,
  last_updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, principal_id, event_type, synthetic)
);

INSERT INTO usage_daily (day, principal_id, event_type, synthetic, request_count, bytes_count, last_updated_at)
SELECT
  date(a.created_at, 'unixepoch'),
  COALESCE(a.principal_id, 'system'),
  CASE
    WHEN a.event_type IN ('artifact.upload', 'artifact.upload.complete') THEN 'upload'
    WHEN a.event_type IN ('artifact.download', 'share.download') THEN 'download'
    WHEN a.event_type IN ('share.create', 'share.admin_create') THEN 'share'
  END,
  a.synthetic,
  COUNT(*),
  COALESCE(SUM(CASE WHEN a.event_type IN ('artifact.upload', 'artifact.upload.complete') THEN CAST(COALESCE(json_extract(a.metadata, '$.size_bytes'), 0) AS INTEGER) ELSE 0 END), 0),
  MAX(a.created_at)
FROM audit_logs a
WHERE a.event_type IN ('artifact.upload', 'artifact.upload.complete', 'artifact.download', 'share.download', 'share.create', 'share.admin_create')
GROUP BY
  date(a.created_at, 'unixepoch'),
  COALESCE(a.principal_id, 'system'),
  CASE
    WHEN a.event_type IN ('artifact.upload', 'artifact.upload.complete') THEN 'upload'
    WHEN a.event_type IN ('artifact.download', 'share.download') THEN 'download'
    WHEN a.event_type IN ('share.create', 'share.admin_create') THEN 'share'
  END,
  a.synthetic;

CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily(day);
CREATE INDEX IF NOT EXISTS idx_usage_daily_principal ON usage_daily(principal_id, day);

DROP INDEX IF EXISTS idx_api_keys_prefix;

CREATE INDEX IF NOT EXISTS idx_api_keys_created ON api_keys(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_created ON shares(created_at DESC);

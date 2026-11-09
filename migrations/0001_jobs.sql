CREATE TABLE jobs (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 80),
  payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB)) <= 4096 AND json_valid(payload)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'expired', 'unknown')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL DEFAULT (unixepoch() + 3600),
  lease_until INTEGER,
  claim_token TEXT,
  completed_at INTEGER,
  result TEXT CHECK (result IS NULL OR (json_valid(result) AND length(CAST(result AS BLOB)) <= 524288)),
  error TEXT
);
CREATE INDEX jobs_pending ON jobs(status, created_at);
CREATE INDEX jobs_lease ON jobs(status, lease_until);
CREATE INDEX jobs_retention ON jobs(created_at);

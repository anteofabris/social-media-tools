export const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT,
  followers INTEGER,
  bio TEXT,
  website TEXT,
  business_category TEXT,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  account_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  hashtag TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS classifications (
  account_id TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_json TEXT,
  model TEXT NOT NULL,
  classified_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  stats_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_sources_account ON sources(account_id);
CREATE INDEX IF NOT EXISTS idx_classifications_account ON classifications(account_id);
CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);
`;

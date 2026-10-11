-- calendar-agent initial schema (S2). See docs/architecture/data.md.

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,          -- ciphertext when encrypted = 1
  encrypted   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

CREATE TABLE queries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at       TEXT NOT NULL,
  workspace_id      TEXT,
  workspace_name    TEXT,
  user_id           TEXT NOT NULL,
  user_name         TEXT,
  entry_point       TEXT NOT NULL,    -- dm | mention | slash | sandbox | cli
  channel_id        TEXT,
  question          TEXT NOT NULL,
  intent            TEXT,
  parsed_json       TEXT,
  answer            TEXT,
  language          TEXT,
  timezone_used     TEXT,
  latency_ms        INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  cost_usd          REAL,
  error             TEXT
);
CREATE INDEX queries_received_at ON queries (received_at);
CREATE INDEX queries_user ON queries (user_id, received_at);
CREATE INDEX queries_workspace ON queries (workspace_id, received_at);

CREATE TABLE slack_installations (
  team_id        TEXT PRIMARY KEY,
  team_name      TEXT,
  enterprise_id  TEXT,
  bot_token_enc  TEXT NOT NULL,       -- envelope ciphertext
  bot_id         TEXT,
  bot_user_id    TEXT,
  scopes         TEXT,
  installed_by   TEXT,
  installed_at   TEXT NOT NULL,
  removed_at     TEXT
);

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,     -- sha256 of the opaque cookie value
  csrf_token    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE TABLE login_attempts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  success   INTEGER NOT NULL
);
CREATE INDEX login_attempts_at ON login_attempts (at);

CREATE TABLE slack_user_cache (
  team_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  tz          TEXT,
  locale      TEXT,
  name        TEXT,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

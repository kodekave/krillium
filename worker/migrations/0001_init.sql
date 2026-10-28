-- GTM Radar stage 1 schema (spec section 6).

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  organiser TEXT,
  url TEXT,
  city TEXT,
  country TEXT,
  lat REAL,
  lon REAL,
  start_date TEXT,
  end_date TEXT,
  status TEXT,
  source_url TEXT,
  content_hash TEXT,
  last_checked TEXT,
  last_changed TEXT,
  fit INTEGER,
  public_names INTEGER,
  timing INTEGER,
  distance INTEGER
);

CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT UNIQUE,
  name TEXT NOT NULL,
  name_key TEXT,
  aliases TEXT NOT NULL DEFAULT '[]',
  industry TEXT,
  size TEXT,
  region TEXT,
  erp TEXT,
  listed INTEGER NOT NULL DEFAULT 0,
  vendor INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_companies_name_key ON companies (name_key);

CREATE TABLE people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  linkedin_url TEXT UNIQUE,
  company_id INTEGER REFERENCES companies (id),
  name TEXT NOT NULL,
  title TEXT,
  persona TEXT,
  source_url TEXT,
  date_found TEXT,
  lawful_basis TEXT
);

CREATE TABLE event_people (
  event_id TEXT NOT NULL REFERENCES events (id),
  person_id INTEGER NOT NULL REFERENCES people (id),
  role TEXT,
  score INTEGER,
  tier TEXT,
  PRIMARY KEY (event_id, person_id)
);

CREATE TABLE event_companies (
  event_id TEXT NOT NULL REFERENCES events (id),
  company_id INTEGER NOT NULL REFERENCES companies (id),
  source_url TEXT,
  PRIMARY KEY (event_id, company_id)
);

CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies (id),
  type TEXT NOT NULL,
  weight REAL,
  date TEXT,
  quote TEXT,
  source_url TEXT
);

CREATE TABLE icp_config (
  version INTEGER PRIMARY KEY,
  json TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES events (id),
  user TEXT NOT NULL,
  choice TEXT NOT NULL,
  reason TEXT,
  note TEXT,
  score_snapshot REAL,
  config_version INTEGER,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  email TEXT PRIMARY KEY,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE prefs (
  user TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user, key)
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started TEXT,
  finished TEXT,
  status TEXT,
  model_spend REAL,
  error TEXT
);

CREATE TABLE changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT REFERENCES events (id),
  kind TEXT NOT NULL,
  summary TEXT,
  source_url TEXT,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE calendar_tokens (
  token_hash TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);

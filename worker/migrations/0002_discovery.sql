-- Event discovery (docs/superpowers/specs/2026-10-29-event-discovery-design.md, section 6).

ALTER TABLE events ADD COLUMN origin TEXT NOT NULL DEFAULT 'import';
ALTER TABLE events ADD COLUMN auto_added INTEGER NOT NULL DEFAULT 0;

CREATE TABLE search_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  created_by TEXT NOT NULL,
  started TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished TEXT,
  planned INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  model_spend REAL NOT NULL DEFAULT 0,
  note TEXT,
  error TEXT
);
CREATE INDEX idx_search_runs_user ON search_runs (created_by, status);

-- One row per cluster of sources describing the same event. event_id has no foreign key on purpose:
-- undoing an auto-add deletes the event while the candidate row stays as the record of the rejection.
CREATE TABLE candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  organiser TEXT,
  city TEXT,
  country TEXT,
  lat REAL,
  lon REAL,
  start_date TEXT,
  end_date TEXT,
  topic_hits INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'inbox',
  conflict TEXT,
  event_id TEXT,
  first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_candidates_status ON candidates (status);

CREATE TABLE candidate_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates (id),
  domain TEXT NOT NULL,
  url TEXT NOT NULL,
  adapter TEXT NOT NULL,
  title TEXT,
  found_start TEXT,
  found_end TEXT,
  found_city TEXT,
  quote TEXT,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (candidate_id, url)
);

CREATE TABLE rejections (
  name_key TEXT NOT NULL,
  start_date TEXT NOT NULL,
  rejected_by TEXT NOT NULL,
  rejected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (name_key, start_date)
);

-- Holds the hash and the extracted facts of a page, never the page text.
CREATE TABLE page_cache (
  url_hash TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  text_hash TEXT NOT NULL,
  extracted_json TEXT
);

CREATE TABLE event_sources (
  event_id TEXT NOT NULL REFERENCES events (id),
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  adapter TEXT,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, url)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Every outcome of a run, including filtered items and the reason they were dropped.
CREATE TABLE run_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES search_runs (id),
  outcome TEXT NOT NULL,
  candidate_id INTEGER,
  event_id TEXT,
  name TEXT,
  url TEXT,
  start_date TEXT,
  city TEXT,
  reason TEXT,
  domains TEXT
);
CREATE INDEX idx_run_items_run ON run_items (run_id);

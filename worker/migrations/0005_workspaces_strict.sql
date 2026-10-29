-- Private workspaces, part 2 of 2 (docs/superpowers/specs/2026-10-29-workspaces-design.md, section 4).
-- Rebuilds the 15 tenant tables so that workspace_id is required, has no default, and takes part in every key. Child
-- tables point at their parents through (workspace_id, id), so the database itself refuses a row that points into another
-- workspace. Run it together with 0004 and deploy the Worker straight after: the code before this change does not name
-- workspace_id, so it can no longer write.
--
-- How the tables are swapped without ever breaking a reference: every new table is created under a _v2 name and points
-- at the other _v2 tables; parents are copied before children; the old tables are dropped children first, so nothing
-- that still exists points at a table that is gone; then each _v2 table takes the real name. Renaming a parent makes
-- SQLite rewrite the references in its children. (signals still points at companies(id), which stays a primary key.)

CREATE TABLE events_v2 (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  id TEXT NOT NULL,
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
  distance INTEGER,
  origin TEXT NOT NULL DEFAULT 'import',
  auto_added INTEGER NOT NULL DEFAULT 0,
  sectors TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE companies_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  domain TEXT,
  name TEXT NOT NULL,
  name_key TEXT,
  aliases TEXT NOT NULL DEFAULT '[]',
  industry TEXT,
  size TEXT,
  region TEXT,
  erp TEXT,
  listed INTEGER NOT NULL DEFAULT 0,
  vendor INTEGER NOT NULL DEFAULT 0,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, domain)
);

CREATE TABLE people_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  email TEXT,
  linkedin_url TEXT,
  company_id INTEGER,
  name TEXT NOT NULL,
  title TEXT,
  persona TEXT,
  source_url TEXT,
  date_found TEXT,
  lawful_basis TEXT,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, email),
  UNIQUE (workspace_id, linkedin_url),
  FOREIGN KEY (workspace_id, company_id) REFERENCES companies_v2 (workspace_id, id)
);

CREATE TABLE event_people_v2 (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  event_id TEXT NOT NULL,
  person_id INTEGER NOT NULL,
  role TEXT,
  fit INTEGER,
  contact TEXT,
  PRIMARY KEY (workspace_id, event_id, person_id),
  FOREIGN KEY (workspace_id, event_id) REFERENCES events_v2 (workspace_id, id),
  FOREIGN KEY (workspace_id, person_id) REFERENCES people_v2 (workspace_id, id)
);

CREATE TABLE event_companies_v2 (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  event_id TEXT NOT NULL,
  company_id INTEGER NOT NULL,
  source_url TEXT,
  PRIMARY KEY (workspace_id, event_id, company_id),
  FOREIGN KEY (workspace_id, event_id) REFERENCES events_v2 (workspace_id, id),
  FOREIGN KEY (workspace_id, company_id) REFERENCES companies_v2 (workspace_id, id)
);

CREATE TABLE event_sources_v2 (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  event_id TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  adapter TEXT,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, event_id, url),
  FOREIGN KEY (workspace_id, event_id) REFERENCES events_v2 (workspace_id, id)
);

CREATE TABLE icp_config_v2 (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  version INTEGER NOT NULL,
  json TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, version)
);

CREATE TABLE decisions_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  event_id TEXT NOT NULL,
  user TEXT NOT NULL,
  choice TEXT NOT NULL,
  reason TEXT,
  note TEXT,
  score_snapshot REAL,
  config_version INTEGER,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, event_id) REFERENCES events_v2 (workspace_id, id)
);

CREATE TABLE changes_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  event_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT,
  source_url TEXT,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, event_id) REFERENCES events_v2 (workspace_id, id)
);

CREATE TABLE search_runs_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  query_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  created_by TEXT NOT NULL,
  started TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished TEXT,
  planned INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  model_spend REAL NOT NULL DEFAULT 0,
  note TEXT,
  error TEXT,
  UNIQUE (workspace_id, id)
);

CREATE TABLE run_items_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  run_id INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  candidate_id INTEGER,
  event_id TEXT,
  name TEXT,
  url TEXT,
  start_date TEXT,
  city TEXT,
  reason TEXT,
  domains TEXT,
  FOREIGN KEY (workspace_id, run_id) REFERENCES search_runs_v2 (workspace_id, id)
);

CREATE TABLE candidates_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  cluster_key TEXT NOT NULL,
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
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sectors TEXT NOT NULL DEFAULT '[]',
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, cluster_key)
);

CREATE TABLE candidate_sources_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  candidate_id INTEGER NOT NULL,
  domain TEXT NOT NULL,
  url TEXT NOT NULL,
  adapter TEXT NOT NULL,
  title TEXT,
  found_start TEXT,
  found_end TEXT,
  found_city TEXT,
  quote TEXT,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (candidate_id, url),
  FOREIGN KEY (workspace_id, candidate_id) REFERENCES candidates_v2 (workspace_id, id)
);

CREATE TABLE rejections_v2 (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  name_key TEXT NOT NULL,
  start_date TEXT NOT NULL,
  rejected_by TEXT NOT NULL,
  rejected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, name_key, start_date)
);

CREATE TABLE settings_v2 (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

-- Parents first.
INSERT INTO events_v2 (workspace_id, id, name, organiser, url, city, country, lat, lon, start_date, end_date, status, source_url, content_hash, last_checked, last_changed, fit, public_names, timing, distance, origin, auto_added, sectors)
  SELECT workspace_id, id, name, organiser, url, city, country, lat, lon, start_date, end_date, status, source_url, content_hash, last_checked, last_changed, fit, public_names, timing, distance, origin, auto_added, sectors FROM events;
INSERT INTO companies_v2 (id, workspace_id, domain, name, name_key, aliases, industry, size, region, erp, listed, vendor)
  SELECT id, workspace_id, domain, name, name_key, aliases, industry, size, region, erp, listed, vendor FROM companies;
INSERT INTO people_v2 (id, workspace_id, email, linkedin_url, company_id, name, title, persona, source_url, date_found, lawful_basis)
  SELECT id, workspace_id, email, linkedin_url, company_id, name, title, persona, source_url, date_found, lawful_basis FROM people;
INSERT INTO icp_config_v2 (workspace_id, version, json, created_by, created_at)
  SELECT workspace_id, version, json, created_by, created_at FROM icp_config;
INSERT INTO search_runs_v2 (id, workspace_id, query_json, status, created_by, started, updated, finished, planned, done, pages, model_calls, model_spend, note, error)
  SELECT id, workspace_id, query_json, status, created_by, started, updated, finished, planned, done, pages, model_calls, model_spend, note, error FROM search_runs;
INSERT INTO candidates_v2 (id, workspace_id, cluster_key, name, organiser, city, country, lat, lon, start_date, end_date, topic_hits, status, conflict, event_id, first_seen, last_seen, sectors)
  SELECT id, workspace_id, cluster_key, name, organiser, city, country, lat, lon, start_date, end_date, topic_hits, status, conflict, event_id, first_seen, last_seen, sectors FROM candidates;
INSERT INTO rejections_v2 (workspace_id, name_key, start_date, rejected_by, rejected_at)
  SELECT workspace_id, name_key, start_date, rejected_by, rejected_at FROM rejections;
INSERT INTO settings_v2 (workspace_id, key, value)
  SELECT workspace_id, key, value FROM settings;

-- Then children.
INSERT INTO event_people_v2 (workspace_id, event_id, person_id, role, fit, contact)
  SELECT workspace_id, event_id, person_id, role, fit, contact FROM event_people;
INSERT INTO event_companies_v2 (workspace_id, event_id, company_id, source_url)
  SELECT workspace_id, event_id, company_id, source_url FROM event_companies;
INSERT INTO event_sources_v2 (workspace_id, event_id, url, domain, adapter, added_at)
  SELECT workspace_id, event_id, url, domain, adapter, added_at FROM event_sources;
INSERT INTO decisions_v2 (id, workspace_id, event_id, user, choice, reason, note, score_snapshot, config_version, at)
  SELECT id, workspace_id, event_id, user, choice, reason, note, score_snapshot, config_version, at FROM decisions;
INSERT INTO changes_v2 (id, workspace_id, event_id, kind, summary, source_url, at)
  SELECT id, workspace_id, event_id, kind, summary, source_url, at FROM changes;
INSERT INTO run_items_v2 (id, workspace_id, run_id, outcome, candidate_id, event_id, name, url, start_date, city, reason, domains)
  SELECT id, workspace_id, run_id, outcome, candidate_id, event_id, name, url, start_date, city, reason, domains FROM run_items;
INSERT INTO candidate_sources_v2 (id, workspace_id, candidate_id, domain, url, adapter, title, found_start, found_end, found_city, quote, fetched_at)
  SELECT id, workspace_id, candidate_id, domain, url, adapter, title, found_start, found_end, found_city, quote, fetched_at FROM candidate_sources;

-- Drop the old tables, children before parents (this also drops their old indexes).
DROP TABLE run_items;
DROP TABLE candidate_sources;
DROP TABLE event_people;
DROP TABLE event_companies;
DROP TABLE event_sources;
DROP TABLE decisions;
DROP TABLE changes;
DROP TABLE people;
DROP TABLE companies;
DROP TABLE events;
DROP TABLE search_runs;
DROP TABLE candidates;
DROP TABLE icp_config;
DROP TABLE settings;
DROP TABLE rejections;

-- Give the new tables their real names; SQLite rewrites the references in their children as it goes.
ALTER TABLE events_v2 RENAME TO events;
ALTER TABLE companies_v2 RENAME TO companies;
ALTER TABLE people_v2 RENAME TO people;
ALTER TABLE icp_config_v2 RENAME TO icp_config;
ALTER TABLE search_runs_v2 RENAME TO search_runs;
ALTER TABLE candidates_v2 RENAME TO candidates;
ALTER TABLE rejections_v2 RENAME TO rejections;
ALTER TABLE settings_v2 RENAME TO settings;
ALTER TABLE event_people_v2 RENAME TO event_people;
ALTER TABLE event_companies_v2 RENAME TO event_companies;
ALTER TABLE event_sources_v2 RENAME TO event_sources;
ALTER TABLE decisions_v2 RENAME TO decisions;
ALTER TABLE changes_v2 RENAME TO changes;
ALTER TABLE run_items_v2 RENAME TO run_items;
ALTER TABLE candidate_sources_v2 RENAME TO candidate_sources;

-- The indexes the old tables had, now led by workspace_id where they filter by it.
CREATE INDEX idx_companies_name_key ON companies (workspace_id, name_key);
CREATE INDEX idx_search_runs_user ON search_runs (workspace_id, created_by, status);
-- One running search per person, enforced by the database so two tabs cannot start two (a person is in one workspace).
CREATE UNIQUE INDEX idx_one_running_search_per_user ON search_runs (created_by) WHERE status = 'running';
CREATE INDEX idx_run_items_run ON run_items (workspace_id, run_id);
CREATE INDEX idx_candidates_status ON candidates (workspace_id, status);

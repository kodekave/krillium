-- Private workspaces, part 1 of 2 (docs/superpowers/specs/2026-10-29-workspaces-design.md, sections 4 and 15).
-- Additive only: nothing here changes a key or removes a default, so the code that existed before this migration keeps
-- working. Migration 0005 rebuilds the tables with composite keys and no default once all code names workspace_id.

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  shared_keys INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT
);

-- Everything that exists today belongs to workspace 1, which may use the Worker's own search keys.
INSERT INTO workspaces (id, name, status, shared_keys, approved_at) VALUES (1, 'Main workspace', 'active', 1, CURRENT_TIMESTAMP);

-- SQLite cannot add a NOT NULL column without a default, so users.workspace_id is nullable here; the code treats a
-- user with no workspace as having no access.
ALTER TABLE users ADD COLUMN workspace_id INTEGER REFERENCES workspaces (id);
ALTER TABLE users ADD COLUMN operator INTEGER NOT NULL DEFAULT 0;
UPDATE users SET workspace_id = 1;

ALTER TABLE events ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE companies ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE people ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE event_people ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE event_companies ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE event_sources ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE icp_config ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE decisions ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE changes ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE search_runs ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE run_items ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE candidates ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE candidate_sources ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rejections ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;

-- The keys the scoped upserts (ON CONFLICT targets) name. Migration 0005 turns these into real primary keys and
-- unique constraints on the rebuilt tables.
CREATE UNIQUE INDEX uq_events_ws_id ON events (workspace_id, id);
CREATE UNIQUE INDEX uq_companies_ws_domain ON companies (workspace_id, domain);
CREATE UNIQUE INDEX uq_people_ws_email ON people (workspace_id, email);
CREATE UNIQUE INDEX uq_people_ws_linkedin ON people (workspace_id, linkedin_url);
CREATE UNIQUE INDEX uq_icp_config_ws_version ON icp_config (workspace_id, version);
CREATE UNIQUE INDEX uq_settings_ws_key ON settings (workspace_id, key);
CREATE UNIQUE INDEX uq_rejections_ws_key ON rejections (workspace_id, name_key, start_date);
CREATE UNIQUE INDEX uq_candidates_ws_cluster ON candidates (workspace_id, cluster_key);
CREATE UNIQUE INDEX uq_event_people_ws ON event_people (workspace_id, event_id, person_id);
CREATE UNIQUE INDEX uq_event_companies_ws ON event_companies (workspace_id, event_id, company_id);
CREATE UNIQUE INDEX uq_event_sources_ws ON event_sources (workspace_id, event_id, url);

-- The workspace's memory: an append-only log of facts about what it decided or did (spec section 15). It holds no
-- personal data about leads.
CREATE TABLE memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_memory_ws_kind_at ON memory (workspace_id, kind, at);

-- Backfill from the history that already exists. Automatic additions are not human decisions and are not copied.
INSERT INTO memory (workspace_id, at, actor, kind, subject, detail)
SELECT 1, d.at, d.user, 'event.decision', d.event_id,
  json_object(
    'choice', d.choice, 'reason', d.reason, 'name', e.name, 'organiser', e.organiser, 'city', e.city, 'country', e.country,
    'sectors', CASE WHEN json_valid(e.sectors) THEN json(e.sectors) ELSE json('[]') END,
    'priority', d.score_snapshot, 'icpVersion', d.config_version, 'backfilled', json('true'))
FROM decisions d LEFT JOIN events e ON e.id = d.event_id;

INSERT INTO memory (workspace_id, at, actor, kind, subject, detail)
SELECT 1, c.last_seen, 'unknown',
  CASE c.status WHEN 'rejected' THEN 'candidate.rejected' ELSE 'candidate.approved' END,
  CAST(c.id AS TEXT),
  json_object(
    'name', c.name, 'organiser', c.organiser, 'city', c.city, 'country', c.country, 'startDate', c.start_date,
    'sectors', CASE WHEN json_valid(c.sectors) THEN json(c.sectors) ELSE json('[]') END,
    'sites', json((SELECT json_group_array(domain) FROM (SELECT DISTINCT domain FROM candidate_sources WHERE candidate_id = c.id ORDER BY domain))),
    'siteCount', (SELECT COUNT(DISTINCT domain) FROM candidate_sources WHERE candidate_id = c.id),
    'inboxReason', NULL, 'backfilled', json('true'))
FROM candidates c WHERE c.status IN ('rejected', 'approved');

INSERT INTO memory (workspace_id, at, actor, kind, subject, detail)
SELECT 1, created_at, COALESCE(created_by, 'unknown'), 'icp.saved', CAST(version AS TEXT),
  json_object('version', version, 'changed', json('[]'), 'backfilled', json('true'))
FROM icp_config WHERE version > 1;

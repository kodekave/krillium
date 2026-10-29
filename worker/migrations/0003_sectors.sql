-- Sector profiles: the sectors an event or a candidate belongs to, as a JSON list of sector ids.
ALTER TABLE events ADD COLUMN sectors TEXT NOT NULL DEFAULT '[]';
ALTER TABLE candidates ADD COLUMN sectors TEXT NOT NULL DEFAULT '[]';

-- The case-study events were chosen for procurement, so imported events start in that sector.
UPDATE events SET sectors = '["procurement"]' WHERE origin = 'import';

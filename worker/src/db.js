import { DEFAULT_CONFIG } from '../../site/js/shared/scoring.js';

export async function getActiveConfig(db) {
  const read = () =>
    db.prepare('SELECT version, json FROM icp_config ORDER BY version DESC LIMIT 1').first();
  let row = await read();
  if (!row) {
    await db
      .prepare('INSERT OR IGNORE INTO icp_config (version, json, created_by) VALUES (1, ?, ?)')
      .bind(JSON.stringify({ ...DEFAULT_CONFIG, version: 1 }), 'system')
      .run();
    row = await read();
  }
  return { ...JSON.parse(row.json), version: row.version };
}

export async function saveConfig(db, cfg, user) {
  const current = await getActiveConfig(db);
  const version = current.version + 1;
  await db
    .prepare('INSERT INTO icp_config (version, json, created_by) VALUES (?, ?, ?)')
    .bind(version, JSON.stringify({ ...cfg, version }), user)
    .run();
  return version;
}

#!/usr/bin/env node
// Usage: node scripts/import-sheet.mjs --events events.csv --leads leads.csv --vendors vendors.csv --out import.sql
// Then:  npx wrangler d1 execute gtm-radar --remote --file import.sql   (run by you; the CSVs stay out of git)
import { readFileSync, writeFileSync } from 'node:fs';
import { buildImport } from './import-lib.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
if (!args.events || !args.leads || !args.out) {
  console.error('usage: import-sheet.mjs --events a.csv --leads b.csv [--vendors c.csv] --out import.sql');
  process.exit(1);
}
const read = (p) => (p ? readFileSync(p, 'utf8') : '');
const { sql, warnings } = buildImport({ eventsCsv: read(args.events), leadsCsv: read(args.leads), vendorsCsv: read(args.vendors) });
writeFileSync(args.out, sql);
for (const w of warnings) console.warn(`warning: ${w}`);
console.log(`wrote ${sql.split('\n').filter(Boolean).length} statements to ${args.out}`);

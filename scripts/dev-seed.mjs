#!/usr/bin/env node
// Local development data: the ten case-study events (public facts) with MADE-UP people and companies.
// Usage: node scripts/dev-seed.mjs > .wrangler/dev-seed.sql
import { SAMPLE_EVENTS } from '../worker/src/samples.js';
import { buildImport } from './import-lib.js';

// The ten events are shared with the Worker's sample-events route.
const EVENTS = SAMPLE_EVENTS.map((e) => [e.id, e.name, e.organiser, e.url, e.city, e.country, e.startDate, e.endDate, e.sourceUrl, e.fit, e.publicNames, e.timing, e.distance]);

// [event, named people, account-only companies]
const PLAN = { bvl: [5, 0], 'ssow-dach': [0, 3], 'bme-sym': [9, 0], naw: [4, 0], 'ssow-orl': [7, 0], sapinsider: [0, 2], 'bme-eu': [3, 0], 'impact-nyc': [3, 0], 'ssow-eu': [0, 4], 'applied-ai': [0, 2] };

const COMPANIES = ['Northwind Distribution', 'Halden Industrial Supply', 'Brandt Werkstoffe GmbH', 'Cobalt Foods', 'Meridian Electric Supply', 'Voss Logistik AG', 'Larkspur Consumer Goods', 'Tessel Metals', 'Ardent Building Products', 'Kiefer Armaturen GmbH', 'Pinecrest Wholesale', 'Oakline Packaging', 'Sundial Beverages', 'Rhein Fasteners GmbH'];
const FIRST = ['Alex', 'Maren', 'Jonas', 'Priya', 'Tomas', 'Ingrid', 'Marcus', 'Elena', 'Felix', 'Nadia', 'Oskar', 'Hana', 'Luca', 'Sofia', 'Daniel', 'Katrin'];
const LAST = ['Rivera', 'Lindqvist', 'Aboagye', 'Brandt', 'Okafor', 'Vasquez', 'Hartmann', 'Nakamura', 'Moreau', 'Kowalski', 'Schreiber', 'Doyle', 'Petrov', 'Haas', 'Mendes', 'Winter'];
const TITLES = ['CFO', 'VP Finance', 'Leiter Einkauf', 'Geschäftsführer', 'Head of Order to Cash', 'Head of Procure to Pay', 'Leiter Supply Chain Management', 'Global Process Owner', 'ERP Lead', 'COO'];
const ROLES = ['Speaker', 'Keynote', 'Moderator', 'Attendee', 'Exhibitor'];

let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed >> 8) % n; };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');
const csv = (rows) => rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');

const eventsCsv = csv([['id', 'name', 'organiser', 'url', 'city', 'country', 'start_date', 'end_date', 'source_url', 'fit', 'public_names', 'timing', 'distance'], ...EVENTS]);
const leadRows = [['event_id', 'name', 'title', 'company', 'domain', 'email', 'email_status', 'linkedin_url', 'role', 'fit', 'source_url']];
let n = 0;
for (const [id, [people, accounts]] of Object.entries(PLAN)) {
  for (let i = 0; i < people; i += 1) {
    const company = COMPANIES[rnd(COMPANIES.length)];
    const domain = `${slug(company)}.test`;
    const name = `${FIRST[rnd(FIRST.length)]} ${LAST[rnd(LAST.length)]} ${n}`.replace(/ \d+$/, '');
    const verified = rnd(10) < 6;
    leadRows.push([id, name, TITLES[rnd(TITLES.length)], company, domain, verified ? `${slug(name).replace(/-/g, '.')}@${domain}` : '', verified ? 'Verified' : '', verified ? '' : `https://linkedin.test/in/${slug(name)}`, ROLES[rnd(ROLES.length)], 22 + rnd(17), `${EVENTS.find((e) => e[0] === id)[8]}`]);
    n += 1;
  }
  for (let i = 0; i < accounts; i += 1) {
    const company = COMPANIES[rnd(COMPANIES.length)];
    leadRows.push([id, '', '', `${company} ${i + 1}`, `${slug(company)}-${i + 1}.test`, '', '', '', 'Company only', 20 + rnd(10), EVENTS.find((e) => e[0] === id)[8]]);
  }
}
const vendorsCsv = csv([['name', 'domain', 'event_id'], ['Vendor Systems', 'vendor-systems.test', 'ssow-orl'], ['Rival Automation', 'rival-automation.test', 'bme-sym']]);

const { sql } = buildImport({ eventsCsv, leadsCsv: csv(leadRows), vendorsCsv }, { today: '2026-10-29' });
// Workspace 1 (made by the migration) holds the ten events and the dev user, who is also the operator. Workspace 2 is
// empty and has its own admin, so local checks can see one workspace never showing another's data.
process.stdout.write([
  sql.trimEnd(),
  "INSERT OR IGNORE INTO workspaces (id, name, status, shared_keys, approved_at) VALUES (2, 'Second workspace', 'active', 0, CURRENT_TIMESTAMP);",
  "INSERT OR IGNORE INTO users (email, name, role, workspace_id, operator) VALUES ('dev@example.test', 'Dev User', 'admin', 1, 1);",
  "INSERT OR IGNORE INTO users (email, name, role, workspace_id, operator) VALUES ('other@example.test', 'Other Admin', 'admin', 2, 0);",
  '',
].join('\n'));

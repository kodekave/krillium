#!/usr/bin/env node
// Local development data: the ten case-study events (public facts) with MADE-UP people and companies.
// Usage: node scripts/dev-seed.mjs > .wrangler/dev-seed.sql
import { buildImport } from './import-lib.js';

const EVENTS = [
  ['bvl', 'BVL Supply Chain CX', 'BVL', 'https://cx.bvl.de/en/', 'Berlin', 'DE', '2026-10-21', '2026-10-22', 'https://cx.bvl.de/en/speaker', 5, 5, 5, 4],
  ['ssow-dach', 'SSOW DACH', 'SSON', 'https://www.ssonetwork.com/events-shared-services-week', 'Berlin', 'DE', '2026-11-17', '2026-11-19', 'https://www.ssonetwork.com/events-sharedserviceswoche/agenda-mc', 5, 3, 5, 5],
  ['bme-sym', 'BME Symposium Procurement and Logistics', 'BME', 'https://www.bme.de/symposium-procurement-logistics/', 'Berlin', 'DE', '2026-11-18', '2026-11-19', 'https://www.bme.de/veranstaltungen/grossveranstaltungen/60th-symposium-procurement-and-logistics/speakers/', 5, 5, 5, 5],
  ['naw', 'NAW Executive Summit', 'NAW', 'https://www.naw.org/events/naw-executive-summit/', 'Washington, DC', 'US', '2027-01-19', '2027-01-21', 'https://www.naw.org/events/naw-executive-summit/', 5, 4, 4, 4],
  ['ssow-orl', 'SSOW Orlando', 'SSON', 'https://www.ssonetwork.com/events-ssoweek', 'Orlando', 'US', '2027-03-08', '2027-03-11', 'https://www.luminik.io/events/shared-services-outsourcing-week-conference-orlando-b90f29ef22c7/attendees/', 4, 4, 4, 3],
  ['sapinsider', 'SAPinsider Las Vegas', 'SAPinsider', 'https://vegas.sapinsider.org/', 'Las Vegas', 'US', '2027-03-15', '2027-03-18', 'https://vegas.sapinsider.org/', 4, 3, 3, 3],
  ['bme-eu', 'BME European Procurement and Supply Chain Excellence Summit', 'BME', 'https://www.bme.de/veranstaltungen/grossveranstaltungen/european-procurement-supply-chain-excellence-summit/', 'Berlin', 'DE', '2027-04-19', '2027-04-20', 'https://www.bme.de/veranstaltungen/grossveranstaltungen/european-procurement-supply-chain-excellence-summit/summit-speakers/', 4, 3, 4, 3],
  ['impact-nyc', 'Industry Impact Summit NYC', 'Supply Chain LIVE', 'https://supplychaindigital.com/events/procurement-supply-chain-live/the-new-york-summit-supply-chain-live-2027', 'New York', 'US', '2027-04-20', '2027-04-21', 'https://supplychaindigital.com/events/procurement-supply-chain-live/the-new-york-summit-procurement-live-2027', 4, 3, 3, 3],
  ['ssow-eu', 'SSOW Europe', 'SSON', 'https://www.ssonetwork.com/events-ssoweek', 'Estoril', 'PT', '2027-05-10', '2027-05-13', 'https://ssonetwork.com/events-ssoweek/downloads/shared-services-outsourcing-week-europe-2025-attendee-snapshot', 4, 3, 3, 2],
  ['applied-ai', 'Applied AI for Distributors', 'Distribution Strategy Group', 'https://distributionstrategy.com/2026/09/applied-ai-2027-expands-as-distributors-move-from-pilots-to-deployment/', 'Schaumburg', 'US', '2027-06-22', '2027-06-24', 'https://distributionstrategy.com/2026/06/graybar-grainger-executives-to-headline-dsg-ai-conference-in-chicago/', 4, 3, 3, 2],
];

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
process.stdout.write(`${sql}INSERT OR IGNORE INTO users (email, name, role) VALUES ('dev@example.test', 'Dev User', 'admin');\n`);

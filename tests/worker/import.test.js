import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import eventsCsv from '../fixtures/events.csv?raw';
import leadsCsv from '../fixtures/leads.csv?raw';
import vendorsCsv from '../fixtures/vendors.csv?raw';
import { buildImportSql, parseCsv } from '../../scripts/import-lib.js';
import { getRankedEvents } from '../../worker/src/db.js';
import { resetData } from './helpers.js';

const runSql = async (sql) => {
  for (const line of sql.split('\n').filter((l) => l.trim())) await env.DB.prepare(line).run();
};
const count = async (table) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
const sql = () => buildImportSql({ eventsCsv, leadsCsv, vendorsCsv });

beforeEach(resetData);

describe('parseCsv', () => {
  it('handles quoted fields with commas, quotes and newlines', () => {
    const rows = parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n');
    expect(rows).toEqual([['a', 'b'], ['x, y', 'say "hi"\nthere']]);
  });
});

describe('buildImportSql', () => {
  it('is idempotent: a second run changes no counts', async () => {
    await runSql(sql());
    const tables = ['events', 'companies', 'people', 'event_people', 'event_companies', 'changes'];
    const first = await Promise.all(tables.map(count));
    await runSql(sql());
    const second = await Promise.all(tables.map(count));
    expect(second).toEqual(first);
    expect(first[0]).toBe(3);
  });

  it('gives one people row and two event rows to the same email on two events', async () => {
    await runSql(sql());
    expect(await count("people WHERE email = 'ada@acme.test'")).toBe(1);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM event_people ep JOIN people p ON p.id = ep.person_id WHERE p.email = 'ada@acme.test'",
    ).first();
    expect(rows.n).toBe(2);
  });

  it('resolves Siemens AG and Siemens to one company and one person', async () => {
    await runSql(sql());
    expect(await count("companies WHERE name_key = 'siemens'")).toBe(1);
    expect(await count("people WHERE linkedin_url = 'https://linkedin.test/in/sam'")).toBe(1);
  });

  it('flags vendor-list companies and keeps them out of event counts', async () => {
    await runSql(sql());
    const vendor = await env.DB.prepare("SELECT vendor FROM companies WHERE domain = 'vendor.test'").first();
    expect(vendor.vendor).toBe(1);
    const { events } = await getRankedEvents(env.DB);
    const orl = events.find((e) => e.id === 'orl');
    expect(orl.counts).toEqual({ tierA: 2, tierB: 1, accountOnly: 0 });
    const bme = events.find((e) => e.id === 'bme');
    expect(bme.counts).toEqual({ tierA: 3, tierB: 0, accountOnly: 1 });
  });

  it('keeps umlauts and academic prefixes in names intact', async () => {
    await runSql(sql());
    const row = await env.DB.prepare("SELECT name, persona FROM people WHERE email = 'joerg@mueller-logistik.test'").first();
    expect(row).toEqual({ name: 'Prof. Dr. Jörg Müller', persona: 'economic_buyer' });
  });

  it('drops an email whose domain does not match its company', async () => {
    await runSql(sql());
    const row = await env.DB.prepare("SELECT email FROM people WHERE name = 'Dana Mismatch'").first();
    expect(row.email).toBeNull();
  });

  it('writes one imported change per event, and none on a rerun', async () => {
    await runSql(sql());
    await runSql(sql());
    expect(await count("changes WHERE kind = 'imported'")).toBe(3);
  });

  it('fills coordinates for known cities and leaves unknown ones null', async () => {
    await runSql(sql());
    const berlin = await env.DB.prepare("SELECT lat, lon FROM events WHERE id = 'bme'").first();
    expect(berlin.lat).toBeCloseTo(52.52, 2);
    const tbc = await env.DB.prepare("SELECT lat, lon, start_date FROM events WHERE id = 'tbc'").first();
    expect(tbc).toEqual({ lat: null, lon: null, start_date: null });
  });
});

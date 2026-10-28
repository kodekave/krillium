import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import eventsCsv from '../fixtures/events.csv?raw';
import leadsCsv from '../fixtures/leads.csv?raw';
import vendorsCsv from '../fixtures/vendors.csv?raw';
import { buildImport, buildImportSql, parseCsv } from '../../scripts/import-lib.js';
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

const EVENTS = 'id,name,city,start_date,end_date,fit,public_names,timing,distance\ne1,Event One,Berlin,2027-03-08,2027-03-10,4,4,4,4\n';
const LEAD_HEAD = 'event_id,name,title,company,domain,email,email_status,linkedin_url,role,fit,source_url\n';
const run = async (leads, events = EVENTS, vendors = '') => {
  const { sql, warnings } = buildImport({ eventsCsv: events, leadsCsv: LEAD_HEAD + leads, vendorsCsv: vendors });
  await runSql(sql);
  return warnings;
};
const contactOf = async (name) => (await env.DB.prepare('SELECT ep.contact FROM event_people ep JOIN people p ON p.id = ep.person_id WHERE p.name = ?').bind(name).first()).contact;

describe('import review fixes', () => {
  it('counts only a plain verified or valid status as a verified email', async () => {
    await run([
      'e1,Vera Fied,CFO,Acme,acme.test,vera@acme.test,Verified,,Speaker,30,',
      'e1,Una Fied,CFO,Acme,acme.test,una@acme.test,Unverified,,Speaker,30,',
      'e1,Not Ver,CFO,Acme,acme.test,not@acme.test,not verified,,Speaker,30,',
      'e1,Val Id,CFO,Acme,acme.test,val@acme.test,valid,,Speaker,30,',
    ].join('\n') + '\n');
    expect(await contactOf('Vera Fied')).toBe('verified_email');
    expect(await contactOf('Una Fied')).toBe('none');
    expect(await contactOf('Not Ver')).toBe('none');
    expect(await contactOf('Val Id')).toBe('verified_email');
  });

  it('skips a lead or vendor with a blank company name and warns instead of aborting', async () => {
    const warnings = await run('e1,No Company,CFO,,,,,,Speaker,30,\ne1,Ok Person,CFO,Acme,acme.test,,,,Speaker,30,\n', EVENTS, 'name,domain,event_id\n,blank.test,e1\n');
    expect(warnings.join(' ')).toMatch(/blank company/);
    expect(await count('people')).toBe(1);
  });

  it('stores only ISO dates and warns about anything else', async () => {
    const events = 'id,name,city,start_date,end_date,fit,public_names,timing,distance\ne1,Event One,Berlin,11/18/2026,2026-18-11,4,4,4,4\ne2,Event Two,Berlin,2027-03-08,2027-03-10,4,4,4,4\n';
    const warnings = await run('', events);
    const rows = await env.DB.prepare('SELECT id, start_date, end_date FROM events ORDER BY id').all();
    expect(rows.results).toEqual([{ id: 'e1', start_date: null, end_date: null }, { id: 'e2', start_date: '2027-03-08', end_date: '2027-03-10' }]);
    expect(warnings.filter((w) => /unrecognised date/.test(w))).toHaveLength(2);
  });

  it('keeps the strongest role and contact when a person is listed twice at one event', async () => {
    await run('e1,Dup Person,CFO,Acme,acme.test,dup@acme.test,Verified,,Speaker,30,\ne1,Dup Person,CFO,Acme,acme.test,dup@acme.test,,,Attendee,30,\n');
    const row = await env.DB.prepare("SELECT ep.role, ep.contact FROM event_people ep JOIN people p ON p.id = ep.person_id WHERE p.name = 'Dup Person'").first();
    expect(row).toEqual({ role: 'speaker', contact: 'verified_email' });
    expect(await count('event_people')).toBe(1);
  });
});

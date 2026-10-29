// Pure CSV-to-SQL import of the case-study Sheet tabs. One statement per line (D1 exec requirement).
import { classifyPersona, domainMatches, normaliseCompanyName } from '../site/js/shared/clean.js';
import { coordsForCity } from '../site/js/shared/cities.js';
import { DEFAULT_CONFIG } from '../site/js/shared/scoring.js';

const VERIFIED = /^(verified|valid)$/i;
const LAWFUL_BASIS = 'legitimate interest (B2B), public source';

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toObjects(text) {
  const rows = parseCsv(text ?? '').filter((r) => r.some((c) => c.trim() !== ''));
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const q = (v) => {
  if (v === null || v === undefined || v === '') return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/\r?\n/g, ' ').replace(/'/g, "''")}'`;
};
const num = (v) => (v === '' || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const slug = (s) => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const cleanDomain = (d) => fold(d).replace(/^@/, '').replace(/^www\./, '');

function coordsFor(row) {
  const lat = num(row.lat);
  const lon = num(row.lon);
  if (lat !== null && lon !== null) return [lat, lon];
  return coordsForCity(row.city);
}

function eventRole(raw, hasPerson) {
  const r = fold(raw);
  if (/speaker|keynote|panel|moderator|session|host/.test(r)) return 'speaker';
  if (/exhibit|sponsor/.test(r)) return 'exhibitor';
  if (/company|account/.test(r) || !hasPerson) return 'company_only';
  return 'attendee';
}

export function buildImport({ eventsCsv, leadsCsv, vendorsCsv }, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const out = [];
  const warnings = [];
  const events = toObjects(eventsCsv).map((e) => {
    const event = { ...e, id: e.id || slug(e.name) };
    for (const key of ['start_date', 'end_date']) {
      if (event[key] && !ISO_DATE.test(event[key])) {
        warnings.push(`event "${event.id}": unrecognised date "${event[key]}" in ${key} (use YYYY-MM-DD); left blank`);
        event[key] = '';
      }
    }
    return event;
  });
  const eventById = new Map(events.map((e) => [fold(e.id), e]));
  const eventByName = new Map(events.map((e) => [normaliseCompanyName(e.name), e]));
  const findEvent = (ref) => eventById.get(fold(ref)) ?? eventByName.get(normaliseCompanyName(ref));

  const companies = new Map();
  const byNameKey = new Map();
  function companyFor(name, domainRaw, vendor = 0) {
    const nameKey = normaliseCompanyName(name);
    const domain = cleanDomain(domainRaw) || null;
    let entry = (domain && companies.get(`d:${domain}`)) || byNameKey.get(nameKey);
    if (!entry) {
      entry = { name, nameKey, domain, vendor: 0, key: domain ? `d:${domain}` : `n:${nameKey}` };
      companies.set(entry.key, entry);
      byNameKey.set(nameKey, entry);
    } else if (domain && !entry.domain) {
      companies.delete(entry.key);
      entry.domain = domain;
      entry.key = `d:${domain}`;
      companies.set(entry.key, entry);
    }
    entry.vendor = Math.max(entry.vendor, vendor);
    return entry;
  }

  const eventCompanies = [];
  for (const v of toObjects(vendorsCsv)) {
    if (!v.name) {
      warnings.push(`vendor row skipped: blank company name (domain "${v.domain}")`);
      continue;
    }
    const company = companyFor(v.name, v.domain, 1);
    const event = v.event_id ? findEvent(v.event_id) : null;
    if (event) eventCompanies.push({ event, company, source: null });
  }

  const people = [];
  const personByEmail = new Map();
  const personByLinkedin = new Map();
  const personByName = new Map();
  const appearances = new Map();
  for (const row of toObjects(leadsCsv)) {
    const event = findEvent(row.event_id ?? row.event);
    if (!event) {
      warnings.push(`lead "${row.name || row.company}" skipped: unknown event "${row.event_id ?? row.event}"`);
      continue;
    }
    if (!row.company) {
      warnings.push(`lead "${row.name}" skipped: blank company name`);
      continue;
    }
    const company = companyFor(row.company, row.domain);
    if (!row.name) {
      eventCompanies.push({ event, company, source: row.source_url });
      continue;
    }
    const emailDomain = (row.email.split('@')[1] ?? '').toLowerCase();
    const emailOk = Boolean(row.email) && domainMatches(emailDomain, company.domain ?? '', []);
    const email = emailOk ? row.email.toLowerCase() : null;
    const linkedin = row.linkedin_url || null;
    const nameKey = `${fold(row.name)}|${company.key}`;
    let person = (email && personByEmail.get(email)) || (linkedin && personByLinkedin.get(linkedin)) || personByName.get(nameKey);
    if (!person) {
      person = { name: row.name, email, linkedin, company, title: row.title, persona: classifyPersona(row.title), source: row.source_url };
      people.push(person);
    } else {
      person.email ??= email;
      person.linkedin ??= linkedin;
    }
    if (person.email) personByEmail.set(person.email, person);
    if (person.linkedin) personByLinkedin.set(person.linkedin, person);
    personByName.set(nameKey, person);

    const role = eventRole(row.role, true);
    const contact =
      person.email && VERIFIED.test(row.email_status.trim()) ? 'verified_email' : person.linkedin ? 'linkedin' : 'none';
    const key = `${event.id}|${people.indexOf(person)}`;
    const fit = num(row.fit) ?? 0;
    const seen = appearances.get(key);
    if (!seen) appearances.set(key, { event, person, role, fit, contact });
    else {
      // Listed twice at one event: keep the strongest role, contact and fit.
      if (DEFAULT_CONFIG.eventRole[role] > DEFAULT_CONFIG.eventRole[seen.role]) seen.role = role;
      if (DEFAULT_CONFIG.contact[contact] > DEFAULT_CONFIG.contact[seen.contact]) seen.contact = contact;
      seen.fit = Math.max(seen.fit, fit);
    }
    if (num(row.fit) === null) warnings.push(`lead "${row.name}" has no fit value; scored with 0`);
  }

  const companySub = (c) =>
    c.domain
      ? `(SELECT id FROM companies WHERE domain = ${q(c.domain)})`
      : `(SELECT id FROM companies WHERE name_key = ${q(c.nameKey)} ORDER BY id LIMIT 1)`;
  const personSub = (p) => {
    if (p.email) return `(SELECT id FROM people WHERE email = ${q(p.email)})`;
    if (p.linkedin) return `(SELECT id FROM people WHERE linkedin_url = ${q(p.linkedin)})`;
    return `(SELECT id FROM people WHERE name = ${q(p.name)} AND company_id IS ${companySub(p.company)} ORDER BY id LIMIT 1)`;
  };

  for (const e of events) {
    const [lat, lon] = coordsFor(e);
    out.push(
      `INSERT INTO events (id, name, organiser, url, city, country, lat, lon, start_date, end_date, source_url, last_checked, fit, public_names, timing, distance) VALUES (${[
        q(e.id), q(e.name), q(e.organiser), q(e.url), q(e.city), q(e.country), q(lat), q(lon), q(e.start_date),
        q(e.end_date), q(e.source_url), q(e.last_checked), q(num(e.fit)), q(num(e.public_names)), q(num(e.timing)), q(num(e.distance)),
      ].join(', ')}) ON CONFLICT (id) DO UPDATE SET name = excluded.name, organiser = excluded.organiser, url = excluded.url, city = excluded.city, country = excluded.country, lat = excluded.lat, lon = excluded.lon, start_date = excluded.start_date, end_date = excluded.end_date, source_url = excluded.source_url, fit = excluded.fit, public_names = excluded.public_names, timing = excluded.timing, distance = excluded.distance;`,
    );
    out.push(
      `INSERT INTO changes (event_id, kind, summary) SELECT ${q(e.id)}, 'imported', 'Imported from the Sheet' WHERE NOT EXISTS (SELECT 1 FROM changes WHERE event_id = ${q(e.id)} AND kind = 'imported');`,
    );
  }

  for (const c of companies.values()) {
    if (c.domain) {
      out.push(
        `INSERT INTO companies (name, name_key, domain, vendor) VALUES (${q(c.name)}, ${q(c.nameKey)}, ${q(c.domain)}, ${c.vendor}) ON CONFLICT (domain) DO UPDATE SET name = excluded.name, name_key = excluded.name_key, vendor = MAX(companies.vendor, excluded.vendor);`,
      );
    } else {
      out.push(
        `INSERT INTO companies (name, name_key, vendor) SELECT ${q(c.name)}, ${q(c.nameKey)}, ${c.vendor} WHERE NOT EXISTS (SELECT 1 FROM companies WHERE name_key = ${q(c.nameKey)});`,
      );
      if (c.vendor) out.push(`UPDATE companies SET vendor = 1 WHERE name_key = ${q(c.nameKey)};`);
    }
  }

  for (const p of people) {
    const cols = `(name, email, linkedin_url, company_id, title, persona, source_url, date_found, lawful_basis)`;
    const vals = [q(p.name), q(p.email), q(p.linkedin), companySub(p.company), q(p.title), q(p.persona), q(p.source), q(today), q(LAWFUL_BASIS)].join(', ');
    const update = `SET name = excluded.name, title = excluded.title, persona = excluded.persona, company_id = excluded.company_id, source_url = excluded.source_url`;
    if (p.email) {
      out.push(`INSERT INTO people ${cols} VALUES (${vals}) ON CONFLICT (email) DO UPDATE ${update}, linkedin_url = COALESCE(people.linkedin_url, excluded.linkedin_url);`);
    } else if (p.linkedin) {
      out.push(`INSERT INTO people ${cols} VALUES (${vals}) ON CONFLICT (linkedin_url) DO UPDATE ${update};`);
    } else {
      out.push(`INSERT INTO people ${cols} SELECT ${vals} WHERE NOT EXISTS (SELECT 1 FROM people WHERE name = ${q(p.name)} AND company_id IS ${companySub(p.company)});`);
    }
  }

  for (const a of appearances.values()) {
    out.push(
      `INSERT INTO event_people (event_id, person_id, role, fit, contact) VALUES (${q(a.event.id)}, ${personSub(a.person)}, ${q(a.role)}, ${a.fit}, ${q(a.contact)}) ON CONFLICT (event_id, person_id) DO UPDATE SET role = excluded.role, fit = excluded.fit, contact = excluded.contact;`,
    );
  }
  for (const ec of eventCompanies) {
    out.push(
      `INSERT OR IGNORE INTO event_companies (event_id, company_id, source_url) VALUES (${q(ec.event.id)}, ${companySub(ec.company)}, ${q(ec.source)});`,
    );
  }
  return { sql: `${out.join('\n')}\n`, warnings };
}

export function buildImportSql(csvs, options) {
  return buildImport(csvs, options).sql;
}

import { describe, expect, it } from 'vitest';

// A cheap early warning that complements the isolation sweep: every SQL statement in the Worker and the scripts that
// reads, changes or deletes a workspace table must name workspace_id at least as often as it names such a table. It is a
// heuristic (the sweep is the proof), so it is deliberately simple: it looks at string and template literals only.
const TENANT_TABLES = [
  'events', 'companies', 'people', 'event_people', 'event_companies', 'event_sources', 'icp_config', 'decisions', 'changes',
  'search_runs', 'run_items', 'candidates', 'candidate_sources', 'rejections', 'settings', 'memory',
];
const TABLE = TENANT_TABLES.join('|');
// A table is read or changed after FROM, JOIN, UPDATE or DELETE FROM. After INTO it counts only when the column list follows
// in the same literal (an insert whose column list is built elsewhere is held to the schema, where workspace_id is NOT NULL).
const REFERENCE = new RegExp(`\\b(?:FROM|JOIN|UPDATE|DELETE\\s+FROM)\\s+(?:${TABLE})\\b|\\bINTO\\s+(?:${TABLE})\\s*\\(`, 'gi');
const IS_SQL = /\b(SELECT|INSERT|UPDATE|DELETE)\b/i;

// Every string and template literal in a piece of JavaScript, expressions inside templates included. Comments and regular
// expression literals are skipped so a quote inside one cannot throw the reading off.
export function literalsOf(source) {
  const out = [];
  const regexAllowedAfter = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
  const readString = (i, quote) => {
    let j = i + 1;
    while (j < source.length && source[j] !== quote) j += source[j] === '\\' ? 2 : 1;
    return j + 1;
  };
  const readRegex = (i) => {
    let j = i + 1;
    let inClass = false;
    while (j < source.length && (inClass || source[j] !== '/')) {
      if (source[j] === '\\') j += 1;
      else if (source[j] === '[') inClass = true;
      else if (source[j] === ']') inClass = false;
      j += 1;
    }
    return j + 1;
  };
  let readTemplate;
  const readExpression = (start) => {
    let j = start;
    let depth = 1;
    while (j < source.length && depth > 0) {
      const c = source[j];
      if (c === '{') { depth += 1; j += 1; } else if (c === '}') { depth -= 1; j += 1; } else if (c === "'" || c === '"') j = readString(j, c);
      else if (c === '`') j = readTemplate(j);
      else j += 1;
    }
    return j;
  };
  readTemplate = (i) => {
    let j = i + 1;
    while (j < source.length && source[j] !== '`') {
      if (source[j] === '\\') j += 2;
      else if (source[j] === '$' && source[j + 1] === '{') j = readExpression(j + 2);
      else j += 1;
    }
    return j + 1;
  };
  const previousSignificant = (i) => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(source[j])) j -= 1;
    return j >= 0 ? source[j] : '(';
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 2;
    } else if (c === '/' && regexAllowedAfter.has(previousSignificant(i))) {
      i = readRegex(i);
    } else if (c === "'" || c === '"') {
      const end = readString(i, c);
      out.push(source.slice(i + 1, end - 1));
      i = end;
    } else if (c === '`') {
      const end = readTemplate(i);
      out.push(source.slice(i + 1, end - 1));
      i = end;
    } else {
      i += 1;
    }
  }
  return out;
}

// The SQL statements in a piece of JavaScript that name a workspace table fewer times than they name workspace_id.
export function findUnscoped(source) {
  const found = [];
  for (const text of literalsOf(source)) {
    if (!IS_SQL.test(text)) continue;
    const references = (text.match(REFERENCE) ?? []).length;
    const scoped = (text.match(/workspace_id/g) ?? []).length;
    if (references > scoped) found.push({ text: text.replace(/\s+/g, ' ').slice(0, 160), references, scoped });
  }
  return found;
}

const sources = import.meta.glob(['../../worker/src/**/*.js', '../../scripts/*.js', '../../scripts/*.mjs'], { query: '?raw', import: 'default', eager: true });

describe('the scan itself', () => {
  it('flags a statement that omits workspace_id', () => {
    expect(findUnscoped("db.prepare('SELECT * FROM events WHERE id = ?')")).toHaveLength(1);
    expect(findUnscoped('db.prepare(`DELETE FROM changes WHERE event_id = ?`)')).toHaveLength(1);
    expect(findUnscoped("db.prepare('INSERT INTO memory (actor, kind) VALUES (?, ?)')")).toHaveLength(1);
  });

  it('flags a join that scopes only one of its tables', () => {
    const sql = "db.prepare('SELECT 1 FROM event_people ep JOIN people p ON p.id = ep.person_id WHERE ep.workspace_id = ?')";
    expect(findUnscoped(sql)).toHaveLength(1);
  });

  it('accepts a statement that scopes each of its tables', () => {
    const sql = "db.prepare('SELECT 1 FROM event_people ep JOIN people p ON p.id = ep.person_id AND p.workspace_id = ep.workspace_id WHERE ep.workspace_id = ?')";
    expect(findUnscoped(sql)).toEqual([]);
    expect(findUnscoped("db.prepare('UPDATE candidates SET status = ? WHERE workspace_id = ? AND id = ?')")).toEqual([]);
  });

  it('ignores tables that are not workspace tables', () => {
    expect(findUnscoped("db.prepare('SELECT * FROM users WHERE email = ?')")).toEqual([]);
    expect(findUnscoped("db.prepare('UPDATE workspaces SET status = ? WHERE id = ?')")).toEqual([]);
    expect(findUnscoped("db.prepare('SELECT * FROM page_cache WHERE url_hash = ?')")).toEqual([]);
    expect(findUnscoped("db.prepare('SELECT key, value FROM prefs WHERE user = ?')")).toEqual([]);
  });

  it('reads statements built from templates with expressions inside them', () => {
    const sql = 'db.prepare(`INSERT OR IGNORE INTO event_sources (workspace_id, event_id) VALUES ${rows.map(() => \'(?, ?)\').join(\', \')}`)';
    expect(findUnscoped(sql)).toEqual([]);
    const bad = 'db.prepare(`SELECT * FROM events WHERE id IN (${ids.map(() => \'?\').join(\', \')})`)';
    expect(findUnscoped(bad)).toHaveLength(1);
  });

  it('is not thrown off by quotes in regular expressions or comments', () => {
    const source = [
      "const clean = (v) => String(v).replace(/'/g, \"''\");",
      "// SELECT * FROM events -- a comment, not a statement",
      "db.prepare('SELECT * FROM events WHERE workspace_id = ?');",
      "db.prepare('SELECT * FROM companies');",
    ].join('\n');
    const found = findUnscoped(source);
    expect(found).toHaveLength(1);
    expect(found[0].text).toContain('FROM companies');
  });
});

describe('the Worker and the scripts', () => {
  it('reads the source files', () => {
    const names = Object.keys(sources).map((p) => p.split('/').slice(-2).join('/'));
    expect(names.length).toBeGreaterThan(15);
    for (const expected of ['src/db.js', 'discovery/store.js', 'discovery/run.js', 'discovery/settings.js', 'src/memory.js', 'scripts/import-lib.js']) {
      expect(names, expected).toContain(expected);
    }
  });

  it('has no statement on a workspace table that leaves out workspace_id', () => {
    const problems = [];
    for (const [path, source] of Object.entries(sources)) {
      for (const f of findUnscoped(source)) problems.push(`${path.replace('../../', '')}: names ${f.references} workspace tables but workspace_id ${f.scoped} times: ${f.text}`);
    }
    expect(problems).toEqual([]);
  });
});

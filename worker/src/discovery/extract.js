// Turns search-result pages into verified observations. Exa's reader proposes the facts as a structured summary of each
// page; nothing is kept unless the quotes it gives are really in the page and support the dates and names it claims.
// Page text is untrusted, and so is the summary written from it.
import { fold } from '../../../site/js/shared/clean.js';
import { countryCode } from '../../../site/js/shared/cities.js';
import { nameTokens, registrableDomain } from '../../../site/js/shared/names.js';

// How much of each page is kept and checked. The Exa adapter asks for this much text, so a quote can only be verified
// if it comes from the start of the page.
export const MAX_PAGE_CHARS = 8000;

const pageText = (page) => String(page.text ?? '').slice(0, MAX_PAGE_CHARS);

// Exa returns a structured summary as a JSON string; an object is accepted as well. Anything else is unreadable.
export function parseSummary(value) {
  if (value && typeof value === 'object') return Array.isArray(value) ? null : value;
  if (typeof value !== 'string') return null;
  const raw = value.replace(/```(?:json)?/gi, '').trim();
  for (const attempt of [raw, raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)]) {
    try {
      const parsed = JSON.parse(attempt);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// Folded, dash-normalised, whitespace-collapsed text, so quotes match despite typography.
const norm = (s) => fold(s).replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim();

const MONTHS = [
  ['jan', 'january', 'januar', 'janvier', 'enero', 'gennaio', 'januari', 'janeiro'],
  ['feb', 'february', 'februar', 'fevrier', 'febrero', 'febbraio', 'februari', 'fevereiro'],
  ['mar', 'march', 'marz', 'mrz', 'mars', 'marzo', 'maart', 'marco'],
  ['apr', 'april', 'avril', 'abril', 'aprile'],
  ['may', 'mai', 'mayo', 'maggio', 'mei', 'maio'],
  ['jun', 'june', 'juni', 'juin', 'junio', 'giugno', 'junho'],
  ['jul', 'july', 'juli', 'juillet', 'julio', 'luglio', 'julho'],
  ['aug', 'august', 'aout', 'agosto', 'augustus'],
  ['sep', 'sept', 'september', 'septembre', 'septiembre', 'setiembre', 'settembre', 'setembro'],
  ['oct', 'october', 'okt', 'oktober', 'octobre', 'octubre', 'ottobre', 'outubro'],
  ['nov', 'november', 'novembre', 'noviembre', 'novembro'],
  ['dec', 'december', 'dez', 'dezember', 'decembre', 'diciembre', 'dicembre', 'dezembro'],
];
const MONTH_OF = new Map(MONTHS.flatMap((names, i) => names.map((name) => [name, i + 1])));

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function validIso(value) {
  const match = ISO.exec(String(value ?? ''));
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? { year, month, day } : null;
}

// Dates written out in a quote, in the order they appear. Only whole dates count: "Q1 2027", "H2 2027",
// "March 2027, 9:00 - 17:00" and "TBA" contain none. A numeric date such as 03/08/2027 that could be read day-first
// or month-first is left out rather than guessed.
const MONTH_WORDS = [...MONTH_OF.keys()].sort((a, b) => b.length - a.length).join('|');
const ORD = '(?:st|nd|rd|th)?';
const DAY_FIRST = new RegExp(`(?<!\\d)(\\d{1,2})${ORD}\\.?(?:\\s*(?:-|to|bis|au|al)\\s*\\d{1,2}${ORD}\\.?)?\\s*(?:of\\s+|de\\s+)?(${MONTH_WORDS})\\b\\.?(?:,?\\s*(\\d{4})(?!\\d))?`, 'g');
const MONTH_FIRST = new RegExp(`(?<![a-z])(${MONTH_WORDS})\\b\\.?\\s+(\\d{1,2})${ORD}(?!\\d)(?:\\s*(?:-|to)\\s*\\d{1,2}${ORD}(?!\\d))?(?:,?\\s*(\\d{4})(?!\\d))?`, 'g');

function dateMentions(text) {
  const found = [];
  const add = (index, day, month, year) => {
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) found.push({ index, day, month, year });
  };
  for (const m of text.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) add(m.index, Number(m[3]), Number(m[2]), Number(m[1]));
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/g)) add(m.index, Number(m[1]), Number(m[2]), Number(m[3]));
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?!\d)/g)) {
    const [a, b, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a > 12 && b <= 12) add(m.index, a, b, year);
    else if (b > 12 && a <= 12) add(m.index, b, a, year);
    else if (a === b) add(m.index, a, a, year);
  }
  for (const m of text.matchAll(DAY_FIRST)) add(m.index, Number(m[1]), MONTH_OF.get(m[2]), m[3] ? Number(m[3]) : null);
  for (const m of text.matchAll(MONTH_FIRST)) add(m.index, Number(m[2]), MONTH_OF.get(m[1]), m[3] ? Number(m[3]) : null);
  return found.sort((a, b) => a.index - b.index);
}

// The quote's first written date must be the start date, so the end of a range or an unrelated later date
// cannot stand in for it, and its year must be the start year.
function quoteSupportsDate(parts, quote) {
  const text = norm(quote);
  const first = dateMentions(text)[0];
  if (!first || first.day !== parts.day || first.month !== parts.month) return false;
  const years = (text.match(/(?<!\d)\d{4}(?!\d)/g) ?? []).map(Number);
  return first.year ? first.year === parts.year : years.includes(parts.year);
}

const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const inPage = (quote, text) => {
  const q = norm(quote);
  return q.length >= 3 && text.includes(q);
};

// How many distinct topics the page mentions (a phrase two sectors share counts once), and which sectors those topics
// belong to.
function matchTopics(text, sectors) {
  const folded = ` ${norm(text)} `;
  const mentioned = new Map();
  const mentions = (topic) => {
    const key = norm(topic);
    if (!mentioned.has(key)) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      mentioned.set(key, Boolean(escaped) && new RegExp(`[^a-z0-9]${escaped}[^a-z0-9]`).test(folded));
    }
    return mentioned.get(key);
  };
  const ids = sectors.filter((s) => s.topics.map(mentions).some(Boolean)).map((s) => s.id);
  return { topicHits: [...mentioned.values()].filter(Boolean).length, sectors: ids };
}

// Returns { observation } for a verified event or { reason } for a dropped one. URLs come from the page, never the model.
function verify(raw, page, sectors) {
  const text = norm(pageText(page));
  const quotes = raw.quotes && typeof raw.quotes === 'object' ? raw.quotes : {};
  const name = clean(raw.name);
  const tokens = name ? nameTokens(name) : [];
  const nameQuote = norm(quotes.name);
  if (!name || !tokens.length || !inPage(quotes.name, text) || !tokens.every((t) => nameQuote.includes(t))) return { reason: 'no verified name' };

  const start = validIso(raw.startDate);
  if (!start || !inPage(quotes.dates, text) || !quoteSupportsDate(start, quotes.dates)) return { reason: 'no verified date' };

  const end = validIso(raw.endDate) && raw.endDate >= raw.startDate ? raw.endDate : null;
  const city = clean(raw.city);
  const cityOk = city && inPage(quotes.city, text) && norm(quotes.city).includes(norm(city));
  return {
    observation: {
      name, organiser: clean(raw.organiser), startDate: raw.startDate, endDate: end, city: cityOk ? city : null,
      country: countryCode(raw.country), online: raw.online === true, cancelled: raw.cancelled === true, url: page.url,
      sourceDomain: registrableDomain(page.url), adapter: page.adapter, title: page.title ?? null,
      quotes: { name: String(quotes.name).slice(0, 200), dates: String(quotes.dates).slice(0, 200), city: cityOk ? String(quotes.city).slice(0, 200) : null },
      ...matchTopics(pageText(page), sectors),
    },
  };
}

// Checks the summary Exa returned for each page. A page with no readable summary is counted, so the run can say so; it
// is not mistaken for a page that has no event on it.
export function extractPages(pages, { sectors = [] } = {}) {
  const observations = [];
  const dropped = [];
  let unreadable = 0;
  for (const page of pages) {
    const raw = parseSummary(page.summary);
    if (!raw) {
      unreadable += 1;
      dropped.push({ url: page.url, reason: 'no readable summary' });
    } else if (raw.isEvent === false) {
      dropped.push({ url: page.url, reason: 'no event on page' });
    } else {
      const result = verify(raw, page, sectors);
      if (result.observation) observations.push(result.observation);
      else dropped.push({ url: page.url, reason: result.reason });
    }
  }
  return { observations, dropped, unreadable };
}

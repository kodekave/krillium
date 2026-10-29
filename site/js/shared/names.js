// Event-name and URL helpers for matching the same event across sites. Pure: shared by the Worker and the page.
import { fold } from './clean.js';

const FILLER = new Set(['annual', 'international', 'conference', 'summit', 'congress', 'forum', 'expo', 'the', 'of', 'and', 'for', 'in', 'on']);
const YEAR = /^(19|20)\d\d$/;
const ORDINAL = /^\d+(st|nd|rd|th)$/;

export function nameTokens(name) {
  const words = fold(name).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w) && !YEAR.test(w) && !ORDINAL.test(w));
  return [...new Set(kept)].sort();
}

export const nameKey = (name) => nameTokens(name).join(' ');

export function nameSimilarity(a, b) {
  const left = new Set(nameTokens(a));
  const right = new Set(nameTokens(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

// Second-level domains under which the registrable domain has three labels.
const THREE_LABEL = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'com.br', 'co.jp', 'co.nz', 'co.za',
  'com.sg', 'com.hk', 'com.tr', 'com.mx', 'com.cn', 'com.tw',
]);

export function registrableDomain(url) {
  let host;
  try {
    const parsed = new URL(String(url ?? ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    host = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host || null;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  return THREE_LABEL.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

export const slugify = (text) => fold(text).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

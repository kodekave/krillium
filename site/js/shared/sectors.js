// Sector profiles: named bundles of topics that describe a kind of event the team wants to find, such as pharma or
// procurement. Shared by the Worker (settings and search planning) and the page (the editor).
import { fold } from './clean.js';

export const MAX_SECTORS = 12;
export const MAX_TOPICS = 8;
export const MAX_TOPIC_LENGTH = 60;
export const MAX_NAME_LENGTH = 40;
const MAX_ID_LENGTH = 30;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const frozen = (sector) => Object.freeze({ ...sector, topics: Object.freeze([...sector.topics]) });

// The starter set. Each sector has the phrases a search for it uses, and a phrase also marks an event as belonging to
// the sector when it appears in the event's page.
export const DEFAULT_SECTORS = Object.freeze([
  { id: 'procurement', name: 'Procurement and supply chain', topics: ['procure to pay', 'procurement', 'supply chain', 'logistics', 'distribution'], enabled: true },
  { id: 'finance-ops', name: 'Finance operations and shared services', topics: ['shared services', 'finance automation', 'accounts payable', 'order to cash', 'financial close', 'CFO'], enabled: true },
  { id: 'pharma', name: 'Pharma and life sciences', topics: ['pharma supply chain', 'pharmaceutical procurement', 'life sciences operations', 'clinical supply', 'GxP compliance'], enabled: true },
  { id: 'manufacturing', name: 'Manufacturing and industrial ERP', topics: ['ERP', 'SAP S/4HANA', 'industrial manufacturing', 'digital supply chain', 'operations excellence'], enabled: true },
  { id: 'banking', name: 'Banking and insurance operations', topics: ['banking operations', 'insurance operations', 'financial services automation', 'fintech', 'treasury'], enabled: true },
].map(frozen));

// Returns the problems with a list of sectors, each naming the sector it is about; an empty list means it is valid.
export function validateSectors(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_SECTORS) return [`sectors must be a list of 1 to ${MAX_SECTORS} sectors`];
  const errors = [];
  const seen = new Set();
  list.forEach((s, i) => {
    const at = `sector ${i + 1}`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      errors.push(`${at} must be an object`);
      return;
    }
    if (typeof s.id !== 'string' || s.id.length > MAX_ID_LENGTH || !ID_PATTERN.test(s.id)) errors.push(`${at}: id must be 1 to ${MAX_ID_LENGTH} lowercase letters, digits or dashes`);
    else if (seen.has(s.id)) errors.push(`${at}: id ${s.id} is used twice`);
    else seen.add(s.id);
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) errors.push(`${at}: name must be 1 to ${MAX_NAME_LENGTH} characters`);
    const topics = Array.isArray(s.topics) ? s.topics.map((t) => (typeof t === 'string' ? t.trim() : null)) : null;
    if (!topics || topics.length < 1 || topics.length > MAX_TOPICS || topics.some((t) => !t || t.length > MAX_TOPIC_LENGTH)) {
      errors.push(`${at}: topics must be 1 to ${MAX_TOPICS} phrases of 1 to ${MAX_TOPIC_LENGTH} characters`);
    }
    if (typeof s.enabled !== 'boolean') errors.push(`${at}: enabled must be true or false`);
  });
  return errors;
}

// A trimmed copy holding only the four known fields. Call it on a list that passed validateSectors.
export const cleanSectors = (list) =>
  list.map((s) => ({ id: s.id, name: s.name.trim(), topics: s.topics.map((t) => t.trim()), enabled: s.enabled }));

// One topic from each sector in turn, so a search that has room for only a few topics still reaches every sector. A
// phrase that two sectors share is kept once.
export function interleaveTopics(sectors) {
  const out = [];
  const seen = new Set();
  const longest = Math.max(0, ...sectors.map((s) => s.topics.length));
  for (let i = 0; i < longest; i += 1) {
    for (const s of sectors) {
      const topic = s.topics[i];
      if (topic !== undefined && !seen.has(topic.toLowerCase())) {
        seen.add(topic.toLowerCase());
        out.push(topic);
      }
    }
  }
  return out;
}

// A short lowercase id for a new sector, made from its name and numbered if another sector already has it.
export function sectorId(name, taken = []) {
  const base = fold(String(name ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_ID_LENGTH).replace(/-+$/, '') || 'sector';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!used.has(id)) return id;
  }
}

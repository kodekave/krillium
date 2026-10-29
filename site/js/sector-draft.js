// Editing helpers for the sector list in the ICP brain. Every function returns a new list and leaves its input alone.
import { sectorId, validateSectors } from './shared/sectors.js';

// Topics are typed as one line (or one per line); empty and repeated phrases are dropped.
export function parseTopics(text) {
  const seen = new Set();
  return String(text ?? '')
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
}

export const topicsText = (topics) => topics.join(', ');

export const updateSector = (list, index, patch) => list.map((s, i) => (i === index ? { ...s, ...patch } : s));

// A new sector is switched on and has no topics yet, so it cannot be saved until it has some.
export const addSector = (list) => [...list, { id: sectorId('New sector', list.map((s) => s.id)), name: 'New sector', topics: [], enabled: true }];

export const removeSector = (list, index) => list.filter((_, i) => i !== index);

export function describeSectors(saved, draft) {
  const errors = validateSectors(draft);
  return { dirty: JSON.stringify(saved) !== JSON.stringify(draft), valid: errors.length === 0, errors };
}

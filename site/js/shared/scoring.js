// Shared by the Worker and the page: one scoring truth for stored ranks and the live ICP preview.

export const DEFAULT_CONFIG = {
  version: 1,
  weights: { eventScoreShare: 0.4, icpDensityShare: 0.6 },
  density: { tierA: 3, tierB: 1, accountOnly: 0.5 },
  thresholds: { mustAttend: 70, consider: 45, tierA: 75, tierB: 55 },
  persona: { economic_buyer: 30, champion: 22, influencer: 12 },
  eventRole: { speaker: 20, exhibitor: 14, attendee: 12, company_only: 8 },
  contact: { verified_email: 10, linkedin: 4, none: 0 },
  homeBases: [
    { name: 'Berlin', lat: 52.52, lon: 13.405 },
    { name: 'New York', lat: 40.7128, lon: -74.006 },
  ],
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round2 = (n) => Math.round(n * 100) / 100;

export function leadScore(input, cfg) {
  const persona = input.persona ? (cfg.persona[input.persona] ?? 0) : 0;
  const role = cfg.eventRole[input.eventRole] ?? 0;
  const contact = cfg.contact[input.contact] ?? 0;
  return input.fit + persona + role + contact;
}

export function tierFor(score, cfg) {
  if (score >= cfg.thresholds.tierA) return 'A';
  if (score >= cfg.thresholds.tierB) return 'B';
  return 'C';
}

export function icpDensity(counts, cfg) {
  return (
    counts.tierA * cfg.density.tierA +
    counts.tierB * cfg.density.tierB +
    counts.accountOnly * cfg.density.accountOnly
  );
}

export function eventPriority(event, maxDensity, cfg) {
  const eventNorm = clamp((event.eventScore20 / 20) * 100, 0, 100);
  const densityNorm =
    maxDensity > 0 ? clamp((icpDensity(event.counts, cfg) / maxDensity) * 100, 0, 100) : 0;
  return round2(
    cfg.weights.eventScoreShare * eventNorm + cfg.weights.icpDensityShare * densityNorm,
  );
}

export function statusFor(priority, cfg) {
  if (priority >= cfg.thresholds.mustAttend) return 'must-attend';
  if (priority >= cfg.thresholds.consider) return 'consider';
  return 'watch';
}

export const leadTier = (lead, cfg) => tierFor(leadScore(lead, cfg), cfg);

// Tiers are always derived from lead inputs and the active config, never stored, so editing the config re-tiers everyone.
export function countsFromLeads(leads, accountOnly, cfg) {
  let tierA = 0;
  let tierB = 0;
  for (const lead of leads) {
    const tier = leadTier(lead, cfg);
    if (tier === 'A') tierA += 1;
    else if (tier === 'B') tierB += 1;
  }
  return { tierA, tierB, accountOnly };
}

export function rankEvents(inputEvents, cfg) {
  const events = inputEvents.map((e) => (e.leads ? { ...e, counts: countsFromLeads(e.leads, e.accountOnly ?? 0, cfg) } : e));
  const maxDensity = Math.max(0, ...events.map((e) => icpDensity(e.counts, cfg)));
  return events
    .map((e) => {
      const priority = eventPriority(e, maxDensity, cfg);
      return { ...e, priority, status: statusFor(priority, cfg) };
    })
    .sort((a, b) => b.priority - a.priority);
}

function nonNegativeNumbers(group, label, errors) {
  for (const [key, value] of Object.entries(group ?? {})) {
    if (!Number.isFinite(value) || value < 0) errors.push(`${label}.${key} must be a number of 0 or more`);
  }
}

export function validateConfig(cfg) {
  const errors = [];
  const { eventScoreShare, icpDensityShare } = cfg.weights ?? {};
  if (!Number.isFinite(eventScoreShare) || !Number.isFinite(icpDensityShare) ||
      Math.abs(eventScoreShare + icpDensityShare - 1) > 1e-9) {
    errors.push('weights must sum to 1');
  }
  const t = cfg.thresholds ?? {};
  if (!(t.consider < t.mustAttend)) errors.push('consider threshold must be below must-attend');
  if (!(t.tierB < t.tierA)) errors.push('tier B cut-off must be below tier A');
  for (const table of ['density', 'persona', 'eventRole', 'contact']) {
    if (!cfg[table] || typeof cfg[table] !== 'object') errors.push(`${table} table is required`);
  }
  nonNegativeNumbers(cfg.density, 'density', errors);
  nonNegativeNumbers(cfg.persona, 'persona', errors);
  nonNegativeNumbers(cfg.eventRole, 'eventRole', errors);
  nonNegativeNumbers(cfg.contact, 'contact', errors);
  if (!Array.isArray(cfg.homeBases)) {
    errors.push('home bases must be a list');
  } else {
    for (const base of cfg.homeBases) {
      const ok = base && typeof base === 'object' && typeof base.name === 'string' && Number.isFinite(base.lat) && Number.isFinite(base.lon) &&
        Math.abs(base.lat) <= 90 && Math.abs(base.lon) <= 180;
      if (!ok) errors.push(`home base ${base?.name ?? '(unnamed)'} needs a name and numeric coordinates`);
    }
  }
  return { ok: errors.length === 0, errors };
}

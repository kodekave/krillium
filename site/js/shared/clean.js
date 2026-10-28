// Rule-based cleaning shared by the Worker and the page. Models are only for what these rules cannot read.

const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .trim();

const cleanDomain = (d) => fold(d).replace(/^@/, '').replace(/^www\./, '');

export function domainMatches(emailDomain, companyDomain, aliases) {
  const email = cleanDomain(emailDomain);
  if (!email) return false;
  return [companyDomain, ...(aliases ?? [])]
    .map(cleanDomain)
    .filter(Boolean)
    .some((d) => email === d || email.endsWith(`.${d}`));
}

// Ordered: the first persona with a matching rule wins.
const PERSONA_RULES = [
  [
    'economic_buyer',
    [
      /\b(cfo|cpo|coo|ceo)\b/,
      /\bchief\b.*\b(officer|financial|procurement|operating|executive)\b/,
      /\b(vp|svp|evp|vice president)\b.*\b(finance|financial|procurement|purchasing|einkauf)\b/,
      /\bhead of shared services\b|\bshared services (head|lead|director)\b/,
      /\bleiter einkauf\b|\beinkaufsleiter\b/,
      /\bgesch(?:a|ae)ftsf(?:u|ue)hrer\b|\bmanaging director\b/,
    ],
  ],
  [
    'champion',
    [
      /\border[ -]to[ -]cash\b|\bprocure[ -]to[ -]pay\b|\b(o2c|p2p)\b/,
      /\border management\b|\bauftragsmanagement\b/,
      /\bleiter supply chain\b|\bhead of (global )?supply chain\b|\bsupply chain management\b/,
    ],
  ],
  [
    'influencer',
    [/\bprocess owner\b/, /\berp\b/, /\bautomation (lead|manager|engineer)\b/, /\banalyst\b/],
  ],
];

export function classifyPersona(title) {
  const t = fold(title);
  for (const [persona, rules] of PERSONA_RULES) {
    if (rules.some((rule) => rule.test(t))) return persona;
  }
  return null;
}

const LEGAL_SUFFIXES = new Set([
  'ag', 'gmbh', 'se', 'inc', 'corp', 'corporation', 'ltd', 'llc', 'plc', 'kg', 'sa', 'nv', 'bv',
]);

export function normaliseCompanyName(name) {
  const tokens = fold(name)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

// Pure graph model: events connect to the companies attached to them; companies connect to the buying personas seen there.
const PERSONA_LABEL = { economic_buyer: 'Economic buyer', champion: 'Champion', influencer: 'Influencer' };

export function buildGraph(events, accountsByEvent) {
  const nodes = new Map();
  const links = new Map();
  const addNode = (n) => { if (!nodes.has(n.id)) nodes.set(n.id, n); };
  const addLink = (source, target) => { links.set(`${source}>${target}`, { source, target }); };

  for (const e of events) addNode({ id: `event:${e.id}`, kind: 'event', label: e.name, status: e.status, priority: e.priority, eventId: e.id });
  for (const e of events) {
    for (const a of accountsByEvent?.[e.id] ?? []) {
      const company = `company:${a.domain || `name:${a.company}`}`;
      addNode({ id: company, kind: 'company', label: a.company || 'Unknown company' });
      addLink(`event:${e.id}`, company);
      if (a.persona) {
        const persona = `persona:${a.persona}`;
        addNode({ id: persona, kind: 'persona', label: PERSONA_LABEL[a.persona] ?? a.persona });
        addLink(company, persona);
      }
    }
  }
  return { nodes: [...nodes.values()], links: [...links.values()] };
}

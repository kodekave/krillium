// A small force simulation (repulsion, link springs, centring) so the graph needs no library.
const PAD = 18;

export function createSimulation(nodes, links, { width, height }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  nodes.forEach((n, i) => {
    const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
    const ring = Math.min(width, height) * 0.3;
    n.x = width / 2 + Math.cos(angle) * ring;
    n.y = height / 2 + Math.sin(angle) * ring;
    n.vx = 0;
    n.vy = 0;
  });
  const edges = links.map((l) => ({ a: byId.get(l.source), b: byId.get(l.target) })).filter((l) => l.a && l.b);
  let alpha = 1;

  function tick() {
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        if (dx === 0 && dy === 0) { dx = 0.5; dy = 0.5; }
        const d2 = dx * dx + dy * dy;
        const force = Math.min(6, (9000 * (0.4 + 0.6 * alpha)) / d2);
        const d = Math.sqrt(d2);
        a.vx -= (dx / d) * force;
        a.vy -= (dy / d) * force;
        b.vx += (dx / d) * force;
        b.vy += (dy / d) * force;
      }
    }
    for (const { a, b } of edges) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const rest = a.kind === 'persona' || b.kind === 'persona' ? 120 : 72;
      const pull = (d - rest) * 0.02;
      a.vx += (dx / d) * pull;
      a.vy += (dy / d) * pull;
      b.vx -= (dx / d) * pull;
      b.vy -= (dy / d) * pull;
    }
    for (const n of nodes) {
      n.vx += (width / 2 - n.x) * 0.0045;
      n.vy += (height / 2 - n.y) * 0.0045;
      n.vx *= 0.82;
      n.vy *= 0.82;
      n.x = Math.min(width - PAD, Math.max(PAD, n.x + n.vx));
      n.y = Math.min(height - PAD, Math.max(PAD, n.y + n.vy));
    }
    alpha = Math.max(0.02, alpha * 0.985);
    return alpha;
  }

  return { tick, settle(steps = 300) { for (let i = 0; i < steps; i += 1) tick(); }, get alpha() { return alpha; } };
}

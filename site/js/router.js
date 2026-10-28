// Hash router. Each route loads a view module exporting mount(root, ctx) => unmount().

export function createRouter({ root, routes, ctx, fallback = 'radar', onRoute }) {
  let unmount = null;
  let renderId = 0;

  const currentName = () => {
    const name = location.hash.replace(/^#\//, '').split('?')[0];
    return name in routes ? name : fallback;
  };

  async function render() {
    const id = ++renderId;
    const name = currentName();
    const mod = await routes[name]();
    if (id !== renderId) return;
    unmount?.();
    root.replaceChildren();
    unmount = mod.mount(root, ctx) ?? null;
    onRoute?.(name);
  }

  addEventListener('hashchange', render);
  return {
    start: render,
    current: currentName,
    navigate(name) {
      if (location.hash === `#/${name}`) render();
      else location.hash = `#/${name}`;
    },
  };
}

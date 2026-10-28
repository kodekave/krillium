// Motion helpers. Every animation in the app asks prefersReducedMotion() first.

export const prefersReducedMotion = () =>
  Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

const clamp01 = (t) => Math.min(1, Math.max(0, t));

export function countValue(target, t) {
  const p = clamp01(t);
  return Math.round(target * (1 - (1 - p) ** 3));
}

export function countUp(el, target, { ms = 700, format = String } = {}) {
  if (prefersReducedMotion()) {
    el.textContent = format(target);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = (now - start) / ms;
    el.textContent = format(countValue(target, t));
    if (t < 1 && el.isConnected) requestAnimationFrame(step);
    else el.textContent = format(target);
  };
  requestAnimationFrame(step);
}

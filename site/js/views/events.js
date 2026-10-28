export function mount(root) {
  root.innerHTML = '<section class="view"><h1>Events</h1><p class="muted">This screen is built in a later task.</p></section>';
  return () => {};
}

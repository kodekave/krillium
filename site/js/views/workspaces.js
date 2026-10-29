// The operator's Workspaces screen: who has asked for a workspace, with Approve and Decline, and a switch for whether a
// workspace may use the Worker's own search keys. The Worker refuses everyone else, so a non-operator who opens this
// address only sees a plain message.
import { h } from '../dom.js';
import { emptyState } from '../empty-state.js';
import { STATUS_LABEL, workspaceActions } from '../workspace-state.js';

const PILL = { pending: 'pill-needs-check', active: 'pill-verified', suspended: 'pill-watch' };
const when = (value) => (value ? String(value).slice(0, 16).replace('T', ' ') : '');

export function mount(root, ctx) {
  let disposed = false;
  const count = h('p', { class: 'muted' });
  const problem = h('p', { class: 'workspaces-error', role: 'alert', hidden: true });
  const body = h('div', { class: 'workspaces-body' });
  root.append(h('section', { class: 'view' }, h('header', {}, h('h1', {}, 'Workspaces'), count), problem, body));

  const show = (text) => {
    problem.hidden = !text;
    problem.textContent = text ?? '';
  };

  async function change(request, control) {
    control.disabled = true;
    show(null);
    const res = await request();
    if (disposed) return;
    if (!res.ok) {
      show(res.error ?? 'That did not work. Try again.');
      control.disabled = false;
      return;
    }
    await load();
  }

  function row(workspace, ownId) {
    const actions = workspaceActions(workspace, ownId).map((a) => h('button', {
      type: 'button', class: a.action === 'approve' ? 'btn btn-primary' : 'btn',
      onclick: (ev) => change(() => ctx.api.post(`/api/operator/workspaces/${workspace.id}/${a.action}`), ev.currentTarget),
    }, a.label));
    const sharedKeys = h('label', { class: 'shared-keys-toggle' },
      h('input', {
        type: 'checkbox', checked: workspace.sharedKeys, 'aria-label': `Let ${workspace.name} use the shared search keys`,
        onchange: (ev) => change(() => ctx.api.put(`/api/operator/workspaces/${workspace.id}/shared-keys`, { on: ev.currentTarget.checked }), ev.currentTarget),
      }),
      'Shared keys');
    return h('tr', { 'data-id': workspace.id },
      h('td', {}, h('strong', {}, workspace.name), h('div', { class: 'muted small' }, workspace.ownerEmail ?? 'No owner'), workspace.hasData ? h('div', { class: 'muted small' }, 'Has data') : null),
      h('td', {}, h('span', { class: `pill ${PILL[workspace.status] ?? ''}` }, STATUS_LABEL[workspace.status] ?? workspace.status)),
      h('td', { class: 'muted small' }, when(workspace.createdAt)),
      h('td', {}, sharedKeys),
      h('td', { class: 'row-actions' }, actions));
  }

  function render(list) {
    const waiting = list.filter((w) => w.status === 'pending').length;
    count.textContent = `${list.length} ${list.length === 1 ? 'workspace' : 'workspaces'}${waiting ? `, ${waiting} waiting for approval` : ''}. Waiting requests come first.`;
    const ownId = ctx.session.getWorkspace()?.id;
    body.replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Workspace', 'Status', 'Requested', 'Search keys', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, list.map((w) => row(w, ownId))))));
  }

  async function load() {
    const res = await ctx.api.get('/api/operator/workspaces');
    if (disposed) return;
    if (!res.ok) {
      if (res.status === 401) return;
      body.replaceChildren(emptyState({
        art: 'load-error',
        title: res.status === 403 ? 'Only the operator can see this' : 'The workspaces could not load',
        text: res.status === 403 ? 'Workspaces are approved by the person who runs this service.' : 'The service returned an error. Try again in a moment.',
        action: res.status === 403 ? null : h('button', { type: 'button', class: 'btn btn-primary', onclick: load }, 'Try again'),
      }));
      return;
    }
    render(res.data);
  }

  window.addEventListener('radar:reauth', load);
  load();
  return () => {
    disposed = true;
    window.removeEventListener('radar:reauth', load);
  };
}

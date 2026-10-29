import { describe, expect, it } from 'vitest';
import { createSession } from '../../site/js/auth.js';
import { STATUS_LABEL, signInOutcome, workspaceActions } from '../../site/js/workspace-state.js';

describe('signInOutcome', () => {
  it('lets a signed-in answer through', () => {
    expect(signInOutcome({ ok: true, status: 200, data: { token: 't' } })).toEqual({ kind: 'signed-in', message: null });
  });

  it('treats a 202 pending answer as waiting, not as a session', () => {
    expect(signInOutcome({ ok: true, status: 202, data: { status: 'pending' } })).toEqual({
      kind: 'pending', message: 'Your workspace is waiting for approval. Sign in again later to check.',
    });
  });

  it('says a switched-off workspace is not active', () => {
    expect(signInOutcome({ ok: false, status: 403, error: 'this workspace is not active' })).toEqual({
      kind: 'inactive', message: 'This workspace is not active. Ask the operator.',
    });
  });

  it('says when sign-ups are closed', () => {
    expect(signInOutcome({ ok: false, status: 503, error: 'sign-ups are closed for now' })).toEqual({ kind: 'closed', message: 'Sign-ups are closed for now.' });
  });

  it('says when the service cannot be reached', () => {
    expect(signInOutcome({ ok: false, stale: true })).toEqual({
      kind: 'unreachable', message: 'Cannot reach the radar service. Check your connection and try again.',
    });
  });

  it('treats anything else as a sign-in that could not be verified', () => {
    for (const result of [{ ok: false, status: 401 }, { ok: false, status: 500 }, { ok: true, status: 202, data: {} }, undefined]) {
      expect(signInOutcome(result)).toEqual({ kind: 'failed', message: 'Sign-in could not be verified. Try again.' });
    }
  });
});

describe('createSession with workspaces', () => {
  const storage = (initial = null) => {
    let value = initial;
    return { getItem: () => value, setItem: (_key, text) => { value = text; }, removeItem: () => { value = null; } };
  };
  const body = { token: 't', user: { email: 'a@example.test' }, workspace: { id: 2, name: 'Bravo team' }, operator: true };

  it('remembers the workspace and the operator flag from the sign-in answer', () => {
    const session = createSession(storage(JSON.stringify(body)));
    expect(session.getToken()).toBe('t');
    expect(session.getWorkspace()).toEqual({ id: 2, name: 'Bravo team' });
    expect(session.isOperator()).toBe(true);
  });

  it('has no workspace and no operator rights without a session or with an older one', () => {
    const none = createSession(storage());
    expect(none.getWorkspace()).toBeNull();
    expect(none.isOperator()).toBe(false);
    const older = createSession(storage(JSON.stringify({ token: 't', user: { email: 'a@example.test' } })));
    expect(older.getWorkspace()).toBeNull();
    expect(older.isOperator()).toBe(false);
  });

  it('keeps what it is given and forgets it on clear', () => {
    const session = createSession(storage());
    session.set(body);
    expect(session.isOperator()).toBe(true);
    session.clear();
    expect(session.getWorkspace()).toBeNull();
    expect(session.isOperator()).toBe(false);
  });
});

describe('workspaceActions', () => {
  it('offers approve and decline for a workspace that is waiting', () => {
    expect(workspaceActions({ id: 3, status: 'pending' }, 1)).toEqual([
      { label: 'Approve', action: 'approve' }, { label: 'Decline', action: 'suspend' },
    ]);
  });

  it('offers suspend for an active workspace and reactivate for a suspended one', () => {
    expect(workspaceActions({ id: 3, status: 'active' }, 1)).toEqual([{ label: 'Suspend', action: 'suspend' }]);
    expect(workspaceActions({ id: 3, status: 'suspended' }, 1)).toEqual([{ label: 'Reactivate', action: 'approve' }]);
  });

  it("never offers to suspend the operator's own workspace", () => {
    expect(workspaceActions({ id: 1, status: 'active' }, 1)).toEqual([]);
  });

  it('labels each status in plain words', () => {
    expect(STATUS_LABEL).toEqual({ pending: 'Waiting for approval', active: 'Active', suspended: 'Suspended' });
  });
});

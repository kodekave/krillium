// Pure rules for the sign-in screen and the operator's Workspaces screen. No DOM and no network, so they are tested directly.

// What a sign-in answer means for the person at the sign-in screen. `result` is what api.post returns. A 202 is "ok" to
// the api layer but is not a session: the workspace is waiting for the operator's approval.
export function signInOutcome(result) {
  if (result?.stale) return { kind: 'unreachable', message: 'Cannot reach the radar service. Check your connection and try again.' };
  if (result?.ok && result.status === 202 && result.data?.status === 'pending') {
    return { kind: 'pending', message: 'Your workspace is waiting for approval. Sign in again later to check.' };
  }
  if (result?.ok && result.status !== 202) return { kind: 'signed-in', message: null };
  if (result?.status === 403) return { kind: 'inactive', message: 'This workspace is not active. Ask the operator.' };
  if (result?.status === 503) return { kind: 'closed', message: 'Sign-ups are closed for now.' };
  return { kind: 'failed', message: 'Sign-in could not be verified. Try again.' };
}

export const STATUS_LABEL = { pending: 'Waiting for approval', active: 'Active', suspended: 'Suspended' };

// The buttons the operator gets on a workspace row. "suspend" and "approve" are the two API actions; the labels say what
// they mean for that status. The operator's own workspace is never offered a way to switch itself off.
export function workspaceActions(workspace, ownWorkspaceId) {
  if (workspace.status === 'pending') return [{ label: 'Approve', action: 'approve' }, { label: 'Decline', action: 'suspend' }];
  if (workspace.status === 'suspended') return [{ label: 'Reactivate', action: 'approve' }];
  return workspace.id === ownWorkspaceId ? [] : [{ label: 'Suspend', action: 'suspend' }];
}

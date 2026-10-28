// Access choices exposed by the chat composer. Codex keeps thread settings for
// later turns; the harness also uses this choice for approvals on an active turn.
export const ACCESS_MODES = new Set(['manual', 'automatic']);

export function accessModeFromSettings(approvalPolicy, sandbox) {
  return approvalPolicy === 'never' && (sandbox === 'danger-full-access' || sandbox?.type === 'dangerFullAccess') ? 'automatic' : 'manual';
}

export function accessParams(mode, { threadStart = false } = {}) {
  if (!ACCESS_MODES.has(mode)) throw new Error('Modo de desenvolvimento inválido.');
  if (mode === 'manual') return { approvalPolicy: 'on-request', approvalsReviewer: 'user' };
  return threadStart
    ? { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    : { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
}

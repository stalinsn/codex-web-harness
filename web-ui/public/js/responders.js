// Who is answering: Codex, or one of the connected accounts. Replies, the running
// indicator and account tags are coloured per provider (Codex neutral, Claude orange,
// Google blue).
import { state } from './state.js';

export const CODEX = { id: 'codex', label: 'Codex', provider: 'codex' };

export function providerClass(provider) {
  return `provider-${/^[a-z0-9-]+$/.test(String(provider || '')) ? provider : 'custom'}`;
}

/** Remove any provider-* class and apply the one for `provider`. */
export function setProviderClass(node, provider) {
  if (!node) return;
  for (const name of [...node.classList]) if (name.startsWith('provider-')) node.classList.remove(name);
  node.classList.add(providerClass(provider));
}

export function rememberTurnAccount(turn) {
  if (turn?.id && turn.account?.provider) state.turnAccounts.set(turn.id, turn.account);
}

/** Responder of a turn; falls back to the open conversation's account. */
export function responderFor(turnId = '') {
  const fromTurn = turnId && state.turnAccounts.get(turnId);
  if (fromTurn) return fromTurn;
  const threadId = String(state.selectedThreadId || '');
  if (!threadId.startsWith('ext-')) return CODEX;
  const thread = state.selectedThread?.id === threadId ? state.selectedThread : state.threads.find((item) => item.id === threadId);
  const account = state.accounts.find((item) => item.id === thread?.accountId);
  return account ? { id: account.id, label: account.label, provider: account.provider } : { id: '', label: 'Assistente', provider: 'custom' };
}

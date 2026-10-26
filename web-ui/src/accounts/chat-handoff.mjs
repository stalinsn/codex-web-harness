// Account switching for the regular chat on the primary Codex account:
// - near the limit (switchAtPercent) the running turn is steered to write the handoff
//   file and stop at a safe point;
// - when that turn ends (or fails on the limit) a continuous task picks the work up on
//   the next available account of the rotation.
import { randomUUID } from 'node:crypto';
import { codexUsage, handoffInstruction } from './codex-usage.mjs';
import { looksRateLimited } from './parsers.mjs';
import { PRIMARY_ID } from './registry.mjs';

const REPEAT_GUARD_MS = 30 * 60 * 1000;

export class ChatHandoff {
  constructor({ primaryCodex, accounts, orchestrator, emit }) {
    this.codex = primaryCodex;
    this.accounts = accounts;
    this.orchestrator = orchestrator;
    this.emit = emit;
    this.steered = new Map(); // threadId -> turnId
    this.continued = new Map(); // threadId -> timestamp
    this.orchestrated = new Set(); // threads created by continuous tasks
    primaryCodex.subscribe((message) => this.#onMessage(message).catch((error) => console.error('Falha na troca automática de conta:', error.message)));
  }

  markOrchestrated(threadId) { if (threadId) this.orchestrated.add(threadId); }

  get rotation() { return this.accounts.registry.rotation; }

  async #onMessage(message) {
    const params = message.params || {};
    if (message.method === 'account/rateLimits/updated') {
      const { percent } = codexUsage(params);
      if (percent == null || !this.rotation.proactiveHandoff || percent < this.rotation.switchAtPercent) return;
      if (!this.#hasAlternative()) return;
      for (const [threadId, turnId] of this.codex.activeTurns) {
        if (this.orchestrated.has(threadId) || this.steered.get(threadId) === turnId) continue;
        this.steered.set(threadId, turnId);
        await this.codex.rpc('turn/steer', { threadId, expectedTurnId: turnId, clientUserMessageId: randomUUID(), input: [{ type: 'text', text: handoffInstruction(percent) }] }).catch(() => {});
        this.emit('handoff-steered', { threadId, percent });
      }
      return;
    }
    const threadId = params.threadId || params.turn?.threadId;
    if (!threadId || this.orchestrated.has(threadId)) return;
    if (message.method === 'error' && params.willRetry !== true && looksRateLimited(params.error?.message)) {
      await this.#limitReached(threadId, params.error?.message);
    } else if (message.method === 'turn/completed') {
      const errorText = params.turn?.error?.message || '';
      if (looksRateLimited(errorText)) await this.#limitReached(threadId, errorText);
      else if (this.steered.has(threadId)) { this.steered.delete(threadId); await this.#continue(threadId, 'proactive'); }
    }
  }

  async #limitReached(threadId, message) {
    const { resetsAt } = codexUsage(this.codex.rateLimits);
    await this.accounts.markLimited(PRIMARY_ID, { resetsAt, message });
    this.steered.delete(threadId);
    await this.#continue(threadId, 'limit');
  }

  #hasAlternative() {
    return Boolean(this.accounts.pick(this.rotation.order, { exclude: [PRIMARY_ID] }));
  }

  async #continue(threadId, reason) {
    if (!this.rotation.autoContinue) return;
    const last = this.continued.get(threadId) || 0;
    if (Date.now() - last < REPEAT_GUARD_MS || !this.#hasAlternative()) return;
    this.continued.set(threadId, Date.now());
    const task = await this.orchestrator.create({ fromThreadId: threadId, order: this.rotation.order.filter((id) => id !== PRIMARY_ID) });
    this.emit('handoff-started', { threadId, taskId: task.id, taskThreadId: task.threadId, reason, title: task.title });
  }
}

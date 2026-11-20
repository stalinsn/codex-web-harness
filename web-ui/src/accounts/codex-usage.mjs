// Reading Codex rate-limit snapshots (account/rateLimits/read or .../updated).

/** Highest used percentage across all windows, and when the most-used window resets (unix s). */
export function codexUsage(rateLimits) {
  const candidate = rateLimits?.rateLimitsByLimitId || rateLimits?.rateLimits || rateLimits;
  const buckets = candidate ? (Array.isArray(candidate) ? candidate : Object.values(candidate)) : [];
  let percent = null;
  let resetsAt = 0;
  for (const bucket of buckets) {
    for (const window of [bucket?.primary, bucket?.secondary]) {
      const used = Number(window?.usedPercent);
      if (!Number.isFinite(used)) continue;
      const reset = Number(window.resetsAt) || 0;
      if (percent == null || used > percent || (used === percent && reset > resetsAt)) { percent = used; resetsAt = reset; }
    }
  }
  return { percent, resetsAt };
}

const WINDOW_NAMES = { 300: 'five_hour', 10080: 'seven_day', 1440: 'one_day', 43200: 'thirty_day' };

/**
 * Every Codex rate-limit window, keyed like Claude's (five_hour, seven_day…), so clients can show
 * each limit with its own reset time instead of only the most used one.
 */
export function codexWindows(rateLimits) {
  const candidate = rateLimits?.rateLimitsByLimitId || rateLimits?.rateLimits || rateLimits;
  const entries = candidate ? (Array.isArray(candidate) ? candidate.map((bucket, index) => [bucket?.limitId || String(index), bucket]) : Object.entries(candidate)) : [];
  const windows = {};
  for (const [limitId, bucket] of entries) {
    for (const [slot, window] of [['primary', bucket?.primary], ['secondary', bucket?.secondary]]) {
      const used = Number(window?.usedPercent);
      if (!Number.isFinite(used)) continue;
      const minutes = Number(window.windowDurationMins ?? window.windowMinutes) || 0;
      const base = WINDOW_NAMES[minutes] || (minutes ? `${minutes}_min` : slot);
      const key = !limitId || limitId === 'codex' || /^\d+$/.test(limitId) ? base : `${limitId}:${base}`;
      windows[key] = { percent: Math.min(100, Math.round(used * 10) / 10), resetsAt: Number(window.resetsAt) || 0, ...(minutes ? { minutes } : {}) };
    }
  }
  return windows;
}

export const HANDOFF_FILE = '.harness/HANDOFF.md';

export function handoffInstruction(percent) {
  return [
    `Atenção: esta conta está em ${Math.round(percent)}% do limite de uso e outra conta vai continuar o trabalho.`,
    `Pare em um ponto seguro agora. Atualize \`${HANDOFF_FILE}\` com: Objetivo, Estado atual, Feito (arquivos alterados), Próximos passos em ordem, Decisões e restrições, Como validar.`,
    'Não comece etapas novas. Encerre o turno com um resumo curto de onde parou.',
  ].join('\n');
}

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

export const HANDOFF_FILE = '.harness/HANDOFF.md';

export function handoffInstruction(percent) {
  return [
    `Atenção: esta conta está em ${Math.round(percent)}% do limite de uso e outra conta vai continuar o trabalho.`,
    `Pare em um ponto seguro agora. Atualize \`${HANDOFF_FILE}\` com: Objetivo, Estado atual, Feito (arquivos alterados), Próximos passos em ordem, Decisões e restrições, Como validar.`,
    'Não comece etapas novas. Encerre o turno com um resumo curto de onde parou.',
  ].join('\n');
}

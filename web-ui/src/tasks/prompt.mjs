// Prompts for orchestrated segments. Every agent keeps .harness/HANDOFF.md current so
// that any other account/model can pick the work up after a limit or interruption.
import { HANDOFF_FILE } from '../accounts/codex-usage.mjs';

export const DONE_MARKER = 'HARNESS_STATUS: DONE';
export const BLOCKED_MARKER = 'HARNESS_STATUS: BLOCKED';
const MAX_HANDOFF = 40_000;
const MAX_POLICY = 20_000;
const MAX_GOAL = 50_000;
// Linux limits one argv element to 128 KiB; CLIs receive the prompt as an argument.
const MAX_PROMPT_BYTES = 110_000;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n\n[… truncado]` : text);

export function outcomeMarker(text) {
  const tail = String(text || '').slice(-4000);
  if (tail.includes(BLOCKED_MARKER)) return 'blocked';
  if (tail.includes(DONE_MARKER)) return 'done';
  return '';
}

/**
 * @param {object} p
 * @param {object} p.task      task record (goal, cwd, title)
 * @param {object} p.account   account record
 * @param {string} p.handoff   current .harness/HANDOFF.md contents ('' if none)
 * @param {object|null} p.previous last segment ({ accountLabel, outcome, summary })
 * @param {string[]} p.policies installation/project guidelines for non-Codex agents
 * @param {'start'|'handoff'|'nudge'} p.mode
 */
export function buildSegmentPrompt({ task, account, handoff = '', previous = null, policies = [], mode = 'start', scale = 1 }) {
  if (mode === 'nudge') {
    return [
      'Continue a tarefa de onde parou. Mantenha `' + HANDOFF_FILE + '` atualizado.',
      `Se o objetivo já estiver concluído e validado, responda com um resumo e a linha \`${DONE_MARKER}\`.`,
      `Se depender de uma decisão ou aprovação humana, explique e termine com \`${BLOCKED_MARKER}\`.`,
    ].join('\n');
  }
  const parts = [
    'Você está executando uma tarefa contínua gerenciada pelo Codex Web Harness. Se esta conta atingir o limite de uso, outra conta ou modelo continuará a partir do registro de retomada.',
  ];
  if (account.provider !== 'codex' && policies.length) {
    parts.push(`## Diretrizes da instalação (obrigatórias)\n\n${policies.map((policy) => clip(policy, MAX_POLICY * scale)).join('\n\n---\n\n')}\n\nNesta execução não há ninguém para aprovar comandos em tempo real. Quando estas diretrizes exigirem pedido explícito ou confirmação, não execute: registre o plano no arquivo de retomada e termine com \`${BLOCKED_MARKER}\`.`);
  }
  parts.push(`## Objetivo\n\n${clip(task.goal.trim(), MAX_GOAL * scale)}`);
  parts.push(`## Pasta de trabalho\n\n\`${task.cwd}\``);
  parts.push([
    '## Registro de retomada',
    '',
    `Mantenha \`${HANDOFF_FILE}\` (dentro da pasta de trabalho) sempre atualizado, a cada etapa significativa e não só no fim, com as seções: Objetivo, Estado atual, Feito (arquivos alterados), Próximos passos em ordem, Decisões e restrições, Como validar.`,
  ].join('\n'));
  if (mode === 'handoff' || handoff) {
    const origin = previous ? `A etapa anterior (${previous.accountLabel}) terminou com: ${previous.outcome}.` : 'Uma execução anterior foi interrompida.';
    parts.push([
      '## Continuação',
      '',
      `${origin} Leia o registro abaixo, confira \`git status\` e \`git diff\` e continue sem refazer o que já foi feito.`,
      handoff ? `\n<registro-de-retomada>\n${clip(handoff, MAX_HANDOFF * scale)}\n</registro-de-retomada>` : '\nO registro ainda não existe; reconstrua o estado pelo repositório antes de continuar.',
      previous?.summary ? `\nÚltima mensagem da etapa anterior:\n<mensagem>\n${clip(previous.summary, 4000 * scale)}\n</mensagem>` : '',
    ].join('\n'));
  }
  parts.push(`## Encerramento\n\nQuando o objetivo estiver concluído e validado, atualize o registro e termine a resposta final com a linha \`${DONE_MARKER}\`. Se precisar de uma decisão humana, explique e termine com \`${BLOCKED_MARKER}\`.`);
  return parts.join('\n\n');
}

/** Goal text for a task that continues an interrupted chat thread. */
export function goalFromThread({ thread, turns }) {
  const userTexts = [];
  let lastAgent = '';
  for (const turn of turns || []) {
    for (const item of turn.items || []) {
      if (item.type === 'userMessage') {
        const text = (item.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
          .replace(/\[Arquivo anexado\][\s\S]*?\[\/Arquivo anexado\]/g, '[arquivo anexado]').trim();
        if (text) userTexts.push(text);
      } else if (item.type === 'agentMessage' && item.text) lastAgent = item.text;
    }
  }
  const first = userTexts[0] || '';
  const recent = userTexts.slice(1).slice(-3);
  return [
    `Continue o trabalho da conversa "${thread?.name || thread?.preview || thread?.id}" do Codex, interrompida por limite de uso.`,
    first ? `\nPedido original:\n<pedido>\n${clip(first, 6000)}\n</pedido>` : '',
    recent.length ? `\nMensagens mais recentes do usuário:\n${recent.map((text) => `<mensagem>\n${clip(text, 2000)}\n</mensagem>`).join('\n')}` : '',
    lastAgent ? `\nÚltima resposta do Codex antes da interrupção:\n<resposta>\n${clip(lastAgent, 4000)}\n</resposta>` : '',
  ].filter(Boolean).join('\n');
}

/** Build the prompt, shrinking the large sections until it fits a command-line argument. */
export function fitPrompt(options) {
  for (const scale of [1, 0.6, 0.35, 0.2]) {
    const prompt = buildSegmentPrompt({ ...options, scale });
    if (Buffer.byteLength(prompt) <= MAX_PROMPT_BYTES) return prompt;
  }
  const prompt = buildSegmentPrompt({ ...options, scale: 0.1 });
  return Buffer.from(prompt).subarray(0, MAX_PROMPT_BYTES).toString('utf8').replace(/\uFFFD$/, '');
}

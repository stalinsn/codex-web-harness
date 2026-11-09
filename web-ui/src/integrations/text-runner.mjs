// Text-only generation for integrations. The CLI runs with no tools, no MCP servers,
// no hooks and no session history, inside a fresh empty temporary directory that is
// deleted afterwards. The prompt goes through stdin (never argv) and stdout is taken
// as plain text, with a hard timeout and an output size cap.
//
// Only providers with a verified no-tools mode are allowed. Anything else is reported
// as unavailable and refused, never run in a weaker mode.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.mjs';
import { accountEnv, commandFor } from '../accounts/cli-runner.mjs';
import { looksRateLimited, reportedTokenUsage, resetFromText } from '../accounts/parsers.mjs';

export const MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 3000;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]/-]{0,99}$/u;

// Claude Code 2.1.x: `--tools ""` removes every built-in tool, --strict-mcp-config skips
// MCP servers from any settings, --disable-slash-commands blocks custom commands/skills
// (which can embed shell snippets), disableAllHooks stops settings hooks and
// --no-session-persistence keeps nothing on disk. No prompt argument: -p reads stdin.
// stream-json (needs --verbose) carries the answer in the final `result` event plus the
// subscription windows (`rate_limit_event`) and token usage, recorded for the account.
// The `init` event lists tools/MCP servers: any non-empty list discards the answer.
export const CLAUDE_TEXT_ARGS = Object.freeze([
  '-p',
  '--output-format', 'stream-json',
  '--verbose',
  '--tools', '',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--disable-slash-commands',
  '--settings', '{"disableAllHooks":true}',
]);

// Codex exec (verificado na 0.164 com arquivo-isca): sem config do usuário (MCP), sem regras,
// sem sessão em disco, sandbox só leitura e todos os recursos de ferramenta desligados por
// --disable (conectores "apps", shell, code mode/exec, MCP, imagem, navegador, subagentes,
// hooks). Sobram só ferramentas inertes (wait/request_user_input/colaboração com a mesma
// config). --json: a resposta vem do último agent_message; qualquer item de ferramenta
// (comando, arquivo, MCP, web) descarta a resposta. `-` lê o prompt do stdin.
export const CODEX_DISABLED_FEATURES = Object.freeze([
  'apps', 'shell_tool', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'computer_use',
  'image_generation', 'multi_agent', 'hooks', 'in_app_browser', 'goals', 'incremental_tools', 'code_mode_host',
  'code_mode_interrupt', 'unified_exec', 'unified_exec_tty', 'view_image', 'sleep_tool', 'tool_suggest',
  'skill_mcp_dependency_install', 'tool_call_mcp_elicitation', 'guardian_approval',
]);
export const CODEX_TEXT_ARGS = Object.freeze([
  'exec',
  '--skip-git-repo-check',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--sandbox', 'read-only',
  '--color', 'never',
  '--json',
  ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
  '-c', 'web_search="disabled"',
  '-c', 'mcp_servers={}',
]);

/** Itens do Codex que não usam ferramenta. */
const CODEX_INERT_ITEMS = new Set(['agent_message', 'reasoning', 'error']);

/** Lê o JSONL do `codex exec --json`: texto final, tokens, limite e ferramentas usadas. */
export function readCodexStream(raw) {
  const out = { text: null, tokens: null, limit: null, usedTools: [], failure: '' };
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event?.item;
    if (item && typeof item.type === 'string' && !CODEX_INERT_ITEMS.has(item.type)) out.usedTools.push(item.type);
    if (event?.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') out.text = item.text;
    if (event?.type === 'turn.completed' && event.usage && typeof event.usage === 'object') out.tokens = event.usage;
    if (event?.type === 'turn.failed' || event?.type === 'error') {
      const message = String(event.error?.message ?? event.message ?? 'falha do Codex');
      out.failure = message.slice(0, 400);
      if (looksRateLimited(message)) out.limit = { resetsAt: resetFromText(message), message: out.failure };
    }
  }
  return out;
}

// Antigravity (agy 1.5.x) não tem modo sem ferramentas: roda numa gaiola bubblewrap lançada
// pelo root (o AppArmor do Ubuntu bloqueia userns sem privilégio) e já rebaixada para o
// usuário do serviço. Dentro só existem /usr e arquivos de rede/certificados (somente
// leitura), o binário do agy, a pasta de login DESTA conta (em /home/agy) e a pasta de
// trabalho vazia (/work). Teste-isca na VPS: arquivo fora da gaiola ilegível; `ls /` só
// mostra a gaiola. Rede liberada (a CLI fala com o Google). CODEX_UI_INTEGRATION_AGY=0 desliga.
export const AGY_JAIL_PATH = '/usr/bin/bwrap';

export function agyJailArgs({ agyBin, accountDir, workDir, uid, gid }) {
  return [
    '-n', AGY_JAIL_PATH,
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/sbin', '/sbin',
    '--perms', '0755', '--dir', '/etc', '--perms', '0755', '--dir', '/opt', '--perms', '0755', '--dir', '/opt/agy', '--perms', '0755', '--dir', '/home',
    '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf', '--ro-bind', '/etc/hosts', '/etc/hosts', '--ro-bind', '/etc/nsswitch.conf', '/etc/nsswitch.conf',
    '--ro-bind', '/etc/ssl', '/etc/ssl', '--ro-bind', '/etc/ca-certificates', '/etc/ca-certificates', '--ro-bind', '/etc/localtime', '/etc/localtime',
    '--ro-bind', agyBin, '/opt/agy/agy',
    '--bind', accountDir, '/home/agy',
    '--bind', workDir, '/work', '--chdir', '/work',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--share-net', '--die-with-parent', '--new-session',
    '--clearenv', '--setenv', 'HOME', '/home/agy', '--setenv', 'PATH', '/opt/agy:/usr/bin:/bin', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'LANG', 'C.UTF-8',
    '/usr/bin/setpriv', `--reuid=${uid}`, `--regid=${gid}`, '--clear-groups', '--no-new-privs', '--inh-caps=-all', '--bounding-set=-all',
    '/opt/agy/agy',
  ];
}

const UNSUPPORTED = {
  antigravity: 'A gaiola do Antigravity não está disponível neste servidor (bubblewrap ausente ou CODEX_UI_INTEGRATION_AGY=0).',
  'gemini-cli': 'O Gemini CLI não oferece um modo comprovadamente sem ferramentas; a geração de texto não usa esta conta.',
  custom: 'CLIs personalizadas não têm um modo sem ferramentas garantido pelo harness.',
};
const CODEX_DISABLED = 'O Codex foi desligado na integração (CODEX_UI_INTEGRATION_CODEX=0).';

/** Whether an account's provider can run text generation safely. */
export function textSupport(account, { allowCodex = config.integrationCodexText, allowAgy = config.integrationAgyText && existsSync(AGY_JAIL_PATH) } = {}) {
  if (account.provider === 'claude-code') return { ok: true, reason: '' };
  if (account.provider === 'antigravity') return allowAgy && account.dir ? { ok: true, reason: '' } : { ok: false, reason: UNSUPPORTED.antigravity };
  if (account.provider === 'codex') return allowCodex ? { ok: true, reason: '' } : { ok: false, reason: CODEX_DISABLED };
  return { ok: false, reason: UNSUPPORTED[account.provider] || 'Provedor sem modo de texto seguro.' };
}

/** The exact command for a text run. Account-level `args` are never used here. */
export function buildTextCommand(account, options = {}) {
  const support = textSupport(account, options);
  if (!support.ok) throw Object.assign(new Error(support.reason), { statusCode: 422 });
  const model = MODEL.test(account.model || '') ? account.model : '';
  if (account.provider === 'claude-code') {
    return { bin: commandFor(account), args: [...CLAUDE_TEXT_ARGS, ...(model ? ['--model', model] : [])] };
  }
  if (account.provider === 'antigravity') {
    // O agy só aceita o prompt por argumento; ele é acrescentado em runText.
    const agyBin = account.bin && account.bin.startsWith('/') ? account.bin : join(config.homeDir, '.local', 'bin', 'agy');
    const jail = agyJailArgs({ agyBin, accountDir: account.dir, workDir: options.workDir || '/nonexistent', uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 });
    return { bin: 'sudo', args: [...jail, '--output-format', 'text', '--print-timeout', '280s', ...(model ? ['--model', model] : []), '-p'], promptArg: true };
  }
  return { bin: account.bin || config.codexBin, args: [...CODEX_TEXT_ARGS, ...(model ? ['--model', model] : []), '-'] };
}

const toPercent = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round((number <= 1 ? number * 100 : number) * 10) / 10;
};

/**
 * Subscription windows from a Claude `rate_limit_event`: { five_hour: {percent, resetsAt,
 * status}, seven_day: ... }. `percent`/`resetsAt` are the tightest window, which is what
 * the account queue uses to decide availability.
 */
export function claudeUsageFromRateLimit(info) {
  if (!info || typeof info !== 'object') return null;
  const windows = {};
  for (const [name, value] of Object.entries(info.unifiedWindows || {})) {
    const percent = toPercent(value?.utilization);
    if (percent == null || !/^[a-z0-9_]{1,40}$/u.test(name)) continue;
    windows[name] = { percent, resetsAt: Number(value.resetsAt) || 0, status: String(value.status || '').slice(0, 40) };
  }
  if (!Object.keys(windows).length) {
    const percent = toPercent(info.utilization);
    if (percent == null) return null;
    windows[String(info.rateLimitType || 'janela').slice(0, 40)] = { percent, resetsAt: Number(info.resetsAt) || 0, status: String(info.status || '').slice(0, 40) };
  }
  const tightest = Object.values(windows).sort((a, b) => b.percent - a.percent)[0];
  return { percent: tightest.percent, resetsAt: tightest.resetsAt, windows };
}

/** Reads the stream-json lines of a text run. Unknown or broken lines are ignored. */
export function readClaudeStream(raw) {
  const out = { result: null, usage: null, tokens: null, limit: null, exposedTools: false };
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'system' && event.subtype === 'init') {
      const listed = (value) => Array.isArray(value) && value.length > 0;
      if (listed(event.tools) || listed(event.mcp_servers)) out.exposedTools = true;
    } else if (event?.type === 'rate_limit_event') {
      const info = event.rate_limit_info || {};
      out.usage = claudeUsageFromRateLimit(info) || out.usage;
      if (/rate_?limited|rejected|exceeded/iu.test(String(info.status || ''))) {
        out.limit = { resetsAt: Number(info.resetsAt) || 0, message: `Limite da assinatura (${info.rateLimitType || 'uso'})` };
      }
    } else if (event?.type === 'result') {
      const text = typeof event.result === 'string' ? event.result : '';
      out.result = { ok: !event.is_error && event.subtype === 'success', text };
      out.tokens = reportedTokenUsage(event.usage) ? event.usage : null;
      if (event.is_error && looksRateLimited(text)) out.limit = { resetsAt: resetFromText(text), message: text.replace(/\|\d{10}\b/u, '').slice(0, 300) };
    }
  }
  return out;
}

const lastLines = (text, count = 3) => String(text || '').replace(/\u001b\[[0-9;]*m/gu, '').trim().split('\n').map((line) => line.trim()).filter(Boolean).slice(-count).join(' ').slice(-600);

/**
 * @returns {Promise<{status: 'completed'|'rate-limited'|'failed'|'timeout'|'too-large', text: string, error: string, resetsAt: number, usage?: object, tokens?: object}>}
 */
export async function runText({ account, prompt, timeoutMs, maxOutputBytes = MAX_OUTPUT_BYTES, spawnImpl = spawn, tmpRoot = tmpdir(), allowCodex, allowAgy }) {
  const dir = await mkdtemp(join(tmpRoot, 'harness-text-'));
  const command = (() => { try { return buildTextCommand(account, { allowCodex, ...(allowAgy === undefined ? {} : { allowAgy }), workDir: dir }); } catch (error) { return { error }; } })();
  if (command.error) { await rm(dir, { recursive: true, force: true }).catch(() => {}); throw command.error; }
  const { bin } = command;
  const args = command.promptArg ? [...command.args, prompt] : command.args;
  const streamed = account.provider === 'claude-code';
  const codexJson = account.provider === 'codex';
  try {
    return await new Promise((resolvePromise) => {
      const outcome = { status: 'failed', text: '', error: '', resetsAt: 0 };
      let child;
      try {
        child = spawnImpl(bin, args, {
          cwd: dir,
          env: { ...accountEnv(account), TMPDIR: dir },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
      } catch (error) {
        resolvePromise({ ...outcome, error: error.message });
        return;
      }
      const chunks = [];
      let size = 0;
      let stderr = '';
      let reason = '';
      let settled = false;
      const killTree = (sig) => {
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); }
        catch { try { child.kill(sig); } catch { /* already gone */ } }
      };
      const stop = (why) => {
        if (settled || reason) return;
        reason = why;
        killTree('SIGTERM');
        setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS).unref?.();
      };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      child.stdout.on('data', (chunk) => {
        if (reason) return;
        size += chunk.length;
        if (size > maxOutputBytes) { stop('too-large'); return; }
        chunks.push(chunk);
      });
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
      child.stdin.on('error', () => { /* the CLI may exit before reading everything */ });
      const finish = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        return true;
      };
      child.on('error', (error) => {
        outcome.error = error.code === 'ENOENT' ? `Comando não encontrado: ${bin}` : error.message;
        // 'close' normally follows; do not wait forever if it does not.
        setTimeout(() => { if (finish()) resolvePromise(outcome); }, 1000).unref?.();
      });
      child.on('close', (code) => {
        if (!finish()) return;
        let text = Buffer.concat(chunks).toString('utf8');
        if (streamed && !reason) {
          const stream = readClaudeStream(text);
          if (stream.usage) outcome.usage = stream.usage;
          if (stream.tokens) outcome.tokens = stream.tokens;
          if (stream.exposedTools) {
            Object.assign(outcome, { status: 'failed', error: 'A CLI iniciou com ferramentas ou MCP ativos; a resposta foi descartada.' });
            resolvePromise(outcome);
            return;
          }
          if (stream.limit) {
            Object.assign(outcome, { status: 'rate-limited', resetsAt: stream.limit.resetsAt, error: stream.limit.message });
            resolvePromise(outcome);
            return;
          }
          if (stream.result) {
            if (stream.result.ok) text = stream.result.text;
            else { outcome.error = lastLines(stream.result.text, 2) || 'A CLI terminou com erro.'; text = stream.result.text; code = code || 1; }
          }
        }
        if (codexJson && !reason) {
          const stream = readCodexStream(text);
          if (stream.tokens) outcome.tokens = stream.tokens;
          if (stream.usedTools.length) {
            Object.assign(outcome, { status: 'failed', error: `O Codex usou ferramentas (${[...new Set(stream.usedTools)].join(', ')}); a resposta foi descartada.` });
            resolvePromise(outcome);
            return;
          }
          if (stream.limit) {
            Object.assign(outcome, { status: 'rate-limited', resetsAt: stream.limit.resetsAt, error: stream.limit.message });
            resolvePromise(outcome);
            return;
          }
          if (stream.text !== null) text = stream.text;
          else { outcome.error = stream.failure || 'O Codex não devolveu texto.'; text = ''; code = code || 1; }
        }
        if (reason === 'timeout') Object.assign(outcome, { status: 'timeout', error: 'A geração excedeu o tempo máximo.' });
        else if (reason === 'too-large') Object.assign(outcome, { status: 'too-large', error: 'A resposta ultrapassou o tamanho máximo permitido.' });
        else if (code === 0 && text.trim()) Object.assign(outcome, { status: 'completed', text: text.replace(/\s+$/u, '') });
        else {
          const detail = `${stderr}\n${text}`;
          if (looksRateLimited(detail)) Object.assign(outcome, { status: 'rate-limited', resetsAt: resetFromText(detail), error: lastLines(detail, 1) || 'Limite de uso atingido.' });
          else outcome.error ||= lastLines(stderr) || lastLines(text) || (code === 0 ? 'A CLI não devolveu texto.' : `Saiu com código ${code}.`);
        }
        resolvePromise(outcome);
      });
      child.stdin.end(prompt, 'utf8');
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

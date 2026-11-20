// Text-only generation for integrations. The CLI runs with no tools, no MCP servers,
// no hooks and no session history, inside a fresh empty temporary directory that is
// deleted afterwards. The prompt goes through stdin (never argv) and stdout is taken
// as plain text, with a hard timeout and an output size cap.
//
// Only providers with a verified no-tools mode are allowed. Anything else is reported
// as unavailable and refused, never run in a weaker mode.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.mjs';
import { accountEnv, commandFor } from '../accounts/cli-runner.mjs';
import { looksRateLimited, resetFromText } from '../accounts/parsers.mjs';

export const MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 3000;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]/-]{0,99}$/u;

// Claude Code 2.1.x: `--tools ""` removes every built-in tool, --strict-mcp-config skips
// MCP servers from any settings, --disable-slash-commands blocks custom commands/skills
// (which can embed shell snippets), disableAllHooks stops settings hooks and
// --no-session-persistence keeps nothing on disk. No prompt argument: -p reads stdin.
export const CLAUDE_TEXT_ARGS = Object.freeze([
  '-p',
  '--output-format', 'text',
  '--tools', '',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--disable-slash-commands',
  '--settings', '{"disableAllHooks":true}',
]);

// Codex exec: read-only sandbox (no writes, no network) and every tool feature turned
// off through config overrides; `-` reads the prompt from stdin. The overrides could not
// be verified against the installed Codex version, and `codex exec` silently ignores
// unknown keys, so this stays disabled unless CODEX_UI_INTEGRATION_CODEX=1.
export const CODEX_TEXT_ARGS = Object.freeze([
  'exec',
  '--sandbox', 'read-only',
  '--skip-git-repo-check',
  '--color', 'never',
  '-c', 'features.shell_tool=false',
  '-c', 'features.unified_exec=false',
  '-c', 'features.view_image_tool=false',
  '-c', 'features.apply_patch_freeform=false',
  '-c', 'web_search="disabled"',
  '-c', 'tools.web_search=false',
  '-c', 'mcp_servers={}',
]);

const UNSUPPORTED = {
  antigravity: 'O Antigravity CLI não oferece um modo comprovadamente sem ferramentas; a geração de texto não usa esta conta.',
  'gemini-cli': 'O Gemini CLI não oferece um modo comprovadamente sem ferramentas; a geração de texto não usa esta conta.',
  custom: 'CLIs personalizadas não têm um modo sem ferramentas garantido pelo harness.',
};
const CODEX_DISABLED = 'O Codex exec mantém ferramentas (leitura de arquivos pelo shell) mesmo em --sandbox read-only, e não foi possível confirmar como desativá-las nesta versão. Ative com CODEX_UI_INTEGRATION_CODEX=1 somente após conferir.';

/** Whether an account's provider can run text generation safely. */
export function textSupport(account, { allowCodex = config.integrationCodexText } = {}) {
  if (account.provider === 'claude-code') return { ok: true, reason: '' };
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
  return { bin: account.bin || config.codexBin, args: [...CODEX_TEXT_ARGS, ...(model ? ['--model', model] : []), '-'] };
}

const lastLines = (text, count = 3) => String(text || '').replace(/\u001b\[[0-9;]*m/gu, '').trim().split('\n').map((line) => line.trim()).filter(Boolean).slice(-count).join(' ').slice(-600);

/**
 * @returns {Promise<{status: 'completed'|'rate-limited'|'failed'|'timeout'|'too-large', text: string, error: string, resetsAt: number}>}
 */
export async function runText({ account, prompt, timeoutMs, maxOutputBytes = MAX_OUTPUT_BYTES, spawnImpl = spawn, tmpRoot = tmpdir(), allowCodex }) {
  const { bin, args } = buildTextCommand(account, { allowCodex });
  const dir = await mkdtemp(join(tmpRoot, 'harness-text-'));
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
        const text = Buffer.concat(chunks).toString('utf8');
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

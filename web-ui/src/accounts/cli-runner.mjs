// Run one headless CLI agent segment for an account and report how it ended.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import readline from 'node:readline';
import { config } from '../config.mjs';
import { getParser, looksRateLimited, resetFromText } from './parsers.mjs';
import { PROVIDERS, expandArgs } from './providers.mjs';

const KILL_GRACE_MS = 5000;

/** Environment for an account: login isolation plus explicit overrides. */
export function accountEnv(account) {
  const preset = PROVIDERS[account.provider];
  const env = {
    ...process.env,
    PATH: `${join(config.homeDir, '.local', 'bin')}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
  };
  if (preset?.isolation?.env) env[preset.isolation.env] = account.dir;
  return { ...env, ...account.env };
}

export function commandFor(account) {
  const preset = PROVIDERS[account.provider];
  return account.bin || preset.bin;
}

/**
 * @returns {Promise<{status: 'completed'|'rate-limited'|'failed'|'stopped', text: string, sessionId: string, resetsAt: number, error: string}>}
 */
export function runCliSegment({ account, prompt, cwd, sessionId = '', onEvent = () => {}, signal, timeoutMs = 2 * 60 * 60 * 1000 }) {
  const preset = PROVIDERS[account.provider];
  const values = { prompt, cwd, model: account.model, effort: account.effort, permissionMode: account.permissionMode || preset.permissionMode || '', sessionId };
  const args = expandArgs(account.args || preset.args, values);
  if (sessionId) args.push(...expandArgs(account.resumeArgs || preset.resumeArgs || [], values));
  const parse = getParser(account.parser || preset.parser);
  const outcome = { status: 'failed', text: '', sessionId, resetsAt: 0, error: '' };
  if (signal?.aborted) return Promise.resolve({ ...outcome, status: 'stopped' });

  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(commandFor(account), args, { cwd, env: accountEnv(account), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      resolvePromise({ ...outcome, error: error.code === 'E2BIG' ? 'O prompt ficou grande demais para a linha de comando.' : error.message });
      return;
    }
    let stderr = '';
    let settled = false;
    let limited = false;
    let stopped = false;
    let pendingDelta = '';

    const killTree = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const stop = () => {
      if (settled) return;
      stopped = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => { outcome.error = 'A etapa excedeu o tempo máximo.'; stop(); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });

    // Streamed chunks are joined without separators and reported as one text event.
    const flushDelta = () => {
      if (!pendingDelta) return;
      const text = pendingDelta;
      pendingDelta = '';
      onEvent({ type: 'text', text });
    };
    const appendText = (text, delta) => {
      outcome.text = `${outcome.text}${outcome.text && !delta ? '\n' : ''}${text}`.slice(-20000);
    };
    const handle = (event) => {
      // One limit notice per run: the CLI may report it as an event and again as the result.
      if (limited && (event.type === 'rate-limit' || (event.type === 'result' && !event.ok))) return;
      if (event.type === 'text' && event.delta) { appendText(event.text, true); pendingDelta += event.text; return; }
      flushDelta();
      if (event.type === 'session' && event.sessionId) outcome.sessionId = event.sessionId;
      if (event.type === 'text') appendText(event.text, false);
      if (event.type === 'rate-limit') { limited = true; outcome.resetsAt = event.resetsAt || outcome.resetsAt; outcome.error = event.message || outcome.error; }
      if (event.type === 'result') {
        if (event.text) outcome.text = event.text;
        if (event.sessionId) outcome.sessionId = event.sessionId;
        if (event.ok) outcome.error = '';
        else if (!limited) outcome.error = event.text || 'A execução terminou com erro.';
      }
      if (event.type === 'error') outcome.error = event.message;
      onEvent(event);
    };

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let events;
      try { events = parse(line); } catch { events = [{ type: 'text', text: line }]; }
      for (const event of events) handle(event);
    });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
    child.on('error', (error) => {
      outcome.error = error.code === 'ENOENT' ? `Comando não encontrado: ${commandFor(account)}` : error.message;
    });
    // A background process started by the agent may keep stdout open after the CLI
    // exits; give the pipes a moment, then end the group.
    child.on('exit', () => {
      setTimeout(() => {
        if (settled) return;
        killTree('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      }, 3000).unref();
    });
    child.on('close', (code) => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      flushDelta();
      if (!limited && looksRateLimited(stderr) && code !== 0) {
        limited = true;
        outcome.resetsAt = resetFromText(stderr);
        outcome.error = stderr.trim().split('\n').at(-1);
      }
      if (limited) outcome.status = 'rate-limited';
      else if (stopped) outcome.status = 'stopped';
      else if (code === 0 && !outcome.error) outcome.status = 'completed';
      else {
        outcome.status = 'failed';
        outcome.error ||= stderr.trim().split('\n').slice(-3).join(' ') || `Saiu com código ${code}.`;
      }
      resolvePromise(outcome);
    });
  });
}

/** Signed-in check: credential files and/or a cheap command, depending on the preset. */
export async function checkCliLogin(account) {
  const preset = PROVIDERS[account.provider];
  const { access } = await import('node:fs/promises');
  if (preset.status?.files?.length) {
    for (const file of preset.status.files) {
      try { await access(join(account.dir, file)); return { loggedIn: true, detail: 'Credenciais encontradas.' }; } catch { /* try next */ }
    }
    if (!preset.status.command) return { loggedIn: false, detail: 'Nenhuma credencial encontrada na pasta da conta.' };
  }
  if (!preset.status?.command) return { loggedIn: null, detail: 'Sem verificação automática para esta CLI.' };
  return new Promise((resolvePromise) => {
    const child = spawn(commandFor(account), preset.status.command, { cwd: config.homeDir, env: accountEnv(account), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-2000); });
    child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-2000); });
    child.on('error', (error) => { clearTimeout(timer); resolvePromise({ loggedIn: false, detail: error.code === 'ENOENT' ? `CLI não instalada: ${commandFor(account)}` : error.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lastLine = output.trim().split('\n').at(-1) || '';
      resolvePromise(code === 0 ? { loggedIn: true, detail: lastLine.slice(0, 200) || 'Sessão ativa.' } : { loggedIn: false, detail: lastLine.slice(0, 200) || `Não autenticada (código ${code}).` });
    });
  });
}

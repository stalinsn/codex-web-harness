// One authenticated, short-lived shell in a pseudo-terminal for the private inspector.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../config.mjs';
import { httpError } from '../http/respond.mjs';

const MAX_SESSION_MS = 30 * 60 * 1000;
const BUFFER_CHARS = 256 * 1024;
const FLUSH_MS = 40;
const bounded = (value, min, max, fallback) => Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
const shellRc = fileURLToPath(new URL('./server-terminal.bashrc', import.meta.url));
const quoteShell = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export class ServerTerminal {
  constructor({ emit }) {
    this.emit = emit;
    this.session = null;
  }

  view(session = this.session) {
    if (!session) return null;
    return {
      id: session.id,
      status: session.status,
      detail: session.detail,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      startedAt: session.startedAt,
      output: session.output,
      outputSeq: session.outputSeq,
    };
  }

  async start({ cwd = config.homeDir, cols = 80, rows = 24 } = {}) {
    if (this.session?.status === 'running') return this.view();
    const width = bounded(cols, 40, 160, 80);
    const height = bounded(rows, 12, 50, 24);
    const session = {
      id: randomUUID(), status: 'running', detail: '', cwd, cols: width, rows: height,
      startedAt: Date.now(), output: '', outputSeq: 0, pending: '', flushTimer: null,
      child: null, timeout: null,
    };
    const command = `stty cols ${width} rows ${height} 2>/dev/null; exec /bin/bash --noprofile --rcfile ${quoteShell(shellRc)} -i`;
    const child = spawn('script', ['-qfec', command, '/dev/null'], {
      cwd,
      env: {
        ...process.env,
        HOME: config.homeDir,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        COLUMNS: String(width),
        LINES: String(height),
        PS1: '\\u@\\h:\\w\\$ ',
        PS2: '> ',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    session.child = child;
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => this.#append(session, chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => this.#append(session, chunk.toString('utf8')));
    child.on('error', (error) => this.#finish(session, 'failed', error.code === 'ENOENT' ? 'O utilitário script não está instalado.' : error.message));
    child.on('close', (code) => {
      if (session.status === 'running') this.#finish(session, 'closed', code === 0 ? 'Shell encerrado.' : `Shell encerrado com código ${code}.`);
    });
    this.session = session;
    session.timeout = setTimeout(() => this.stop(session.id, 'Sessão encerrada após 30 minutos.'), MAX_SESSION_MS);
    this.#state(session);
    return this.view(session);
  }

  get(id) {
    if (!this.session || this.session.id !== id) throw httpError('Sessão do terminal não encontrada.', 404);
    return this.session;
  }

  write(id, data) {
    const session = this.get(id);
    if (session.status !== 'running' || !session.child.stdin.writable) throw httpError('O terminal está encerrado.', 409);
    const text = String(data ?? '');
    if (!text || text.length > 8192) throw httpError('Entrada inválida.', 400);
    session.child.stdin.write(text);
  }

  stop(id, detail = 'Encerrado pelo usuário.') {
    const session = this.session;
    if (!session || session.id !== id) throw httpError('Sessão do terminal não encontrada.', 404);
    if (session.status !== 'running') return this.view(session);
    this.#finish(session, 'stopped', detail);
    return this.view(session);
  }

  stopAll() {
    if (this.session?.status === 'running') this.#finish(this.session, 'stopped', 'Serviço reiniciado.');
  }

  #append(session, text) {
    if (session.status !== 'running') return;
    session.output = `${session.output}${text}`;
    if (session.output.length > BUFFER_CHARS) session.output = session.output.slice(-BUFFER_CHARS);
    session.outputSeq += 1;
    session.pending += text;
    if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => {
        session.flushTimer = null;
        const data = session.pending;
        session.pending = '';
        if (data) this.emit('terminal-output', { sessionId: session.id, seq: session.outputSeq, data }, { replay: false });
      }, FLUSH_MS);
    }
  }

  #finish(session, status, detail) {
    if (session.status !== 'running') return;
    session.status = status;
    session.detail = detail;
    clearTimeout(session.timeout);
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
      const data = session.pending;
      session.pending = '';
      if (data) this.emit('terminal-output', { sessionId: session.id, seq: session.outputSeq, data }, { replay: false });
    }
    try { process.kill(-session.child.pid, 'SIGTERM'); } catch { /* already exited */ }
    setTimeout(() => { try { process.kill(-session.child.pid, 'SIGKILL'); } catch { /* already exited */ } }, 3000).unref();
    this.#state(session);
  }

  #state(session) {
    const state = this.view(session);
    delete state.output;
    this.emit('terminal-state', state);
  }
}

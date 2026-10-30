// Private shell embedded in the inspector sidebar.
import { api } from './api.js';
import { $, toast } from './dom.js';
import { setCardSummary } from './inspector-layout.js';
import { loadXterm } from './wizard.js';

const terminal = { session: null, term: null, lastSeq: 0, loading: false, starting: false, pending: [], input: '', inputTimer: null, inputChain: Promise.resolve() };

function renderState(session) {
  terminal.session = session;
  const running = session?.status === 'running';
  const status = $('#serverTerminalStatus');
  status.textContent = running
    ? `Ativo como ubuntu · ${session.cwd}`
    : session?.detail || (session ? 'Sessão encerrada.' : 'Sessão fechada.');
  status.classList.toggle('running', running);
  $('#startServerTerminal').hidden = running;
  $('#startServerTerminal').textContent = session ? 'Abrir nova sessão' : 'Abrir terminal';
  $('#stopServerTerminal').hidden = !running;
  $('#serverTerminalHost').hidden = !terminal.term && !running;
  setCardSummary('terminal', running ? 'ubuntu · ativo' : session ? 'encerrado' : 'abrir shell');
}

function measureTerminal() {
  const host = $('#serverTerminalHost');
  const fontSize = 11;
  const cols = Math.max(40, Math.min(140, Math.floor((host.clientWidth - 12) / (fontSize * 0.61))));
  const rows = Math.max(12, Math.min(40, Math.floor((host.clientHeight - 8) / (fontSize * 1.22))));
  return { cols, rows, fontSize };
}

function queueInput(data) {
  if (terminal.session?.status !== 'running') return;
  terminal.input += data;
  clearTimeout(terminal.inputTimer);
  terminal.inputTimer = setTimeout(flushInput, 24);
}

function flushInput() {
  if (!terminal.input || terminal.session?.status !== 'running') return;
  const data = terminal.input.slice(0, 4096);
  terminal.input = terminal.input.slice(data.length);
  const sessionId = terminal.session.id;
  terminal.inputChain = terminal.inputChain
    .then(() => api(`/api/server-terminal/${encodeURIComponent(sessionId)}/input`, { method: 'POST', body: JSON.stringify({ data }) }))
    .catch((error) => toast(error.message, 'error'));
  if (terminal.input) terminal.inputTimer = setTimeout(flushInput, 24);
}

async function mountTerminal(session, { reset = false } = {}) {
  const host = $('#serverTerminalHost');
  host.hidden = false;
  await loadXterm();
  if (!terminal.term) {
    const { cols, rows, fontSize } = measureTerminal();
    const term = new window.Terminal({
      cols, rows, fontSize, scrollback: 1800, cursorBlink: true, convertEol: true,
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      theme: { background: '#111216', foreground: '#e3e4ea', cursor: '#b8c1ff', selectionBackground: '#3c4370' },
    });
    term.open(host);
    term.onData(queueInput);
    terminal.term = term;
  }
  if (reset) terminal.term.reset();
  terminal.loading = true;
  const pending = terminal.pending.splice(0);
  terminal.lastSeq = Number(session.outputSeq) || 0;
  if (session.output) terminal.term.write(session.output);
  terminal.loading = false;
  for (const event of [...pending, ...terminal.pending.splice(0)]) writeOutput(event);
  terminal.term.focus();
}

function writeOutput(data) {
  if (data.sessionId !== terminal.session?.id || Number(data.seq) <= terminal.lastSeq) return;
  terminal.lastSeq = Number(data.seq) || terminal.lastSeq;
  terminal.term?.write(data.data || '');
}

async function readCurrent({ attach = true } = {}) {
  terminal.loading = true;
  try {
    const { session } = await api('/api/server-terminal');
    if (!session) { terminal.pending = []; renderState(null); terminal.loading = false; return; }
    renderState(session);
    if (attach && (session.status === 'running' || session.output)) await mountTerminal(session, { reset: true });
    else terminal.loading = false;
  } catch (error) { terminal.loading = false; throw error; }
}

async function startTerminal() {
  const button = $('#startServerTerminal');
  button.disabled = true;
  terminal.loading = true;
  terminal.starting = true;
  try {
    $('#serverTerminalHost').hidden = false;
    await loadXterm();
    const size = measureTerminal();
    const { session } = await api('/api/server-terminal', {
      method: 'POST',
      body: JSON.stringify({ cwd: '/home/ubuntu', cols: size.cols, rows: size.rows }),
    });
    renderState(session);
    terminal.starting = false;
    await mountTerminal(session, { reset: true });
  } catch (error) { terminal.loading = false; terminal.starting = false; toast(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function stopTerminal() {
  const button = $('#stopServerTerminal');
  if (!terminal.session) return;
  button.disabled = true;
  try {
    const { session } = await api(`/api/server-terminal/${encodeURIComponent(terminal.session.id)}`, { method: 'DELETE' });
    renderState(session);
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; }
}

export function handleServerTerminalEvent(event) {
  if (event.type === 'terminal-state') {
    if (event.data?.id === terminal.session?.id) renderState(event.data);
  } else if (event.type === 'terminal-output' && event.data?.sessionId === terminal.session?.id) {
    if (terminal.loading) terminal.pending.push(event.data);
    else writeOutput(event.data);
  } else if (event.type === 'terminal-output' && (terminal.loading || terminal.starting)) {
    terminal.pending.push(event.data);
  }
}

export function reconnectServerTerminal() {
  if (terminal.session && !$('#serverTerminalCard').classList.contains('collapsed')) readCurrent().catch(() => {});
}

export function bindServerTerminal() {
  setCardSummary('terminal', 'abrir shell');
  $('#startServerTerminal').addEventListener('click', startTerminal);
  $('#stopServerTerminal').addEventListener('click', stopTerminal);
  $('#serverTerminalCard .card-title-row').addEventListener('click', () => {
    requestAnimationFrame(() => {
      if (!$('#serverTerminalCard').classList.contains('collapsed')) readCurrent().catch((error) => toast(error.message, 'error'));
    });
  });
}

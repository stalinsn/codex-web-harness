const PREFIX = '/codex-agent';
const PINNED_THREAD_SECTION_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
const state = {
  models: [], threads: [], projects: [], selectedProjectId: localStorage.getItem('codex-project') || '', selectedThreadId: null, selectedThread: null,
  cwd: localStorage.getItem('codex-cwd') || '', defaultCwd: '', projectsRoot: '', activeThreadProjectId: '', archivedView: false, loadingThreadId: null,
  modelId: localStorage.getItem('codex-model') || '', effort: localStorage.getItem('codex-effort') || '',
  files: [], busy: false, sending: false, interrupting: false, account: null, rateLimits: null, usage: null, contextUsage: null,
  queueItems: [], recoveredQueueItems: [], turnStartedAtMs: null, turnTimer: null,
  streamedMessages: new Map(), activityCards: new Map(), commandGroups: new Map(), reasoningGroups: new Map(), turnIntermediates: new Map(), userMessageIds: new Set(), pendingApprovals: new Map(),
  activeTurnId: null,
  activeThreadIds: new Set(),
  followLatest: true,
  threadListRequest: 0,
};
const authUi = { mode: 'login', step: 'credentials', challengeId: '', setupRequired: false, countdown: null, started: false };
let vpsHealthRequest = null;
const voice = { phase: 'idle', recorder: null, stream: null, chunks: [], blob: null, url: '', timer: null, startedAt: 0, seconds: 0, request: null, jobId: null, cancelled: false, context: null, meterSource: null, meterFrame: null, hasSignal: false, generation: 0 };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icons = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.7"/><path d="m16 16 4 4"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  external: '<path d="M14 4h6v6m-10 4L20 4"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
  chart: '<path d="M4 19V5m0 14h17"/><path d="m7 15 4-4 3 2 6-7"/>',
  archive: '<rect x="3" y="5" width="18" height="4" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9m-8 3h2"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  'arrow-up': '<path d="M12 19V5m-7 7 7-7 7 7"/>',
  paperclip: '<path d="m8 12.5 6.9-6.9a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a5 5 0 0 1-7.1-7.1l8.3-8.3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 10h18"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  gauge: '<path d="M4.8 18a9 9 0 1 1 14.4 0"/><path d="m12 13 4-4m-4 4-2 2"/><circle cx="12" cy="13" r="1"/>',
  server: '<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01m3-10h7m-7 10h7"/>',
  shield: '<path d="M12 3 20 6v5c0 5.3-3.4 8.4-8 10-4.6-1.6-8-4.7-8-10V6z"/><path d="m9 12 2 2 4-4"/>',
  chat: '<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-9.5a7.5 7.5 0 1 1 17 0Z"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 4v3"/>',
  containers: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M7 12h2m2 0h2m2 0h2M8 8V5m4 3V5m4 3V5"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7z"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-4 4 3 3m-6-1 3 3"/>',
  pin: '<path d="m15 3 6 6-4 1-4 5-4-4 5-4zM9 15l-6 6m4-12 8 8"/>',
  rename: '<path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  microphone: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V22m-4 0h8"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
};

function installIcons() {
  $$('[data-icon]').forEach((node) => {
    const name = node.dataset.icon;
    if (!icons[name]) return;
    node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function markdown(text) {
  const blocks = [];
  let safe = escapeHtml(text);
  safe = safe.replace(/```([\w.+-]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const index = blocks.push(`<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${code.replace(/\n$/, '')}</code></pre>`) - 1;
    return `\u0000${index}\u0000`;
  });
  const inline = (line) => line
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\\\|/g, '|');
  const tableCells = (line) => {
    let value = line.trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
    const cells = [];
    let cell = '';
    let inCode = false;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (char === '`' && value[index - 1] !== '\\') inCode = !inCode;
      if (char === '|' && !inCode && value[index - 1] !== '\\') {
        cells.push(cell.trim()); cell = '';
      } else cell += char;
    }
    cells.push(cell.trim());
    return cells;
  };
  const tableAlignment = (cell) => {
    const value = cell.trim();
    if (!/^:?-{3,}:?$/.test(value)) return null;
    if (value.startsWith(':') && value.endsWith(':')) return 'center';
    if (value.endsWith(':')) return 'right';
    return 'left';
  };
  const lines = safe.split('\n');
  const output = [];
  let paragraph = [];
  let list = '';
  let listItems = [];
  let quote = [];
  const flushParagraph = () => { if (paragraph.length) { output.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; } };
  const flushList = () => { if (listItems.length) { output.push(`<${list}>${listItems.map((item) => `<li>${inline(item)}</li>`).join('')}</${list}>`); listItems = []; list = ''; } };
  const flushQuote = () => { if (quote.length) { output.push(`<blockquote><p>${quote.map(inline).join('<br>')}</p></blockquote>`); quote = []; } };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const headerCells = tableCells(line);
    const delimiterCells = lines[index + 1] ? tableCells(lines[index + 1]) : [];
    const alignments = delimiterCells.map(tableAlignment);
    const isTable = headerCells.length > 1 && alignments.length === headerCells.length && alignments.every(Boolean);
    if (isTable) {
      flushParagraph(); flushList(); flushQuote();
      const renderCell = (cell, tag, column) => `<${tag}${alignments[column] ? ` style="text-align:${alignments[column]}"` : ''}>${inline(cell)}</${tag}>`;
      const head = `<thead><tr>${headerCells.map((cell, column) => renderCell(cell, 'th', column)).join('')}</tr></thead>`;
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const cells = tableCells(lines[index]);
        if (cells.length === 1) break;
        while (cells.length < headerCells.length) cells.push('');
        rows.push(`<tr>${cells.slice(0, headerCells.length).map((cell, column) => renderCell(cell, 'td', column)).join('')}</tr>`);
        index += 1;
      }
      output.push(`<div class="table-wrap"><table>${head}<tbody>${rows.join('')}</tbody></table></div>`);
      index -= 1;
      continue;
    }
    const code = line.match(/^\u0000(\d+)\u0000$/);
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const quoteLine = line.match(/^\s*&gt;\s?(.*)$/);
    const rule = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
    if (!line.trim() || code || heading || bullet || ordered || quoteLine || rule) {
      flushParagraph();
      if (!bullet && !ordered) flushList();
      if (!quoteLine) flushQuote();
      if (!line.trim()) continue;
      if (code) { output.push(blocks[Number(code[1])] || ''); continue; }
      if (rule) { output.push('<hr>'); continue; }
      if (heading) { const level = heading[1].length; output.push(`<h${level}>${inline(heading[2])}</h${level}>`); continue; }
      if (bullet || ordered) {
        const type = bullet ? 'ul' : 'ol';
        if (list && list !== type) flushList();
        list = type; listItems.push((bullet || ordered)[1]); continue;
      }
      if (quoteLine) { quote.push(quoteLine[1]); continue; }
    }
    paragraph.push(line);
  }
  flushParagraph(); flushList(); flushQuote();
  return output.join('');
}

function formatNumber(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('pt-BR', { notation: Number(value) >= 100000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(Number(value));
}

function formatReset(timestamp) {
  if (!timestamp) return 'reinício não informado';
  const date = new Date(Number(timestamp) * 1000);
  if (Number.isNaN(date.getTime())) return 'reinício não informado';
  return `reinicia ${new Intl.DateTimeFormat('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(date)}`;
}

function formatCountdown(timestamp) {
  const remaining = Math.ceil((Number(timestamp) * 1000 - Date.now()) / 1000);
  if (!Number.isFinite(remaining)) return '';
  if (remaining <= 0) return 'em breve';
  if (remaining < 60) return 'em <1 min';
  if (remaining < 3600) return `em ${Math.ceil(remaining / 60)} min`;
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.ceil((remaining % 3600) / 60);
  if (remaining < 86400) return minutes ? `em ${hours} h ${minutes} min` : `em ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  const days = Math.floor(hours / 24);
  return `em ${days} ${days === 1 ? 'dia' : 'dias'}${hours % 24 ? ` e ${hours % 24} h` : ''}`;
}

function updateResetCountdowns() {
  $$('.meter-countdown').forEach((node) => { node.textContent = formatCountdown(node.dataset.resetAt); });
}

function effortLabel(value) {
  return ({ none: 'Desligado', minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Extra alto', max: 'Máximo', ultra: 'Ultra' })[value] || value;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body != null) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${PREFIX}${path}`, { credentials: 'same-origin', cache: 'no-store', ...options, headers });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `Falha na solicitação (${response.status}).`); error.data = data; throw error; }
  return data;
}

function showAuthNotice(message = '', kind = '') {
  const notice = $('#authNotice');
  notice.textContent = message;
  notice.className = `auth-notice${kind ? ` ${kind}` : ''}`;
  notice.hidden = !message;
}

function showAuthFlow() {
  const firstStep = authUi.step === 'credentials';
  $('#credentialsStep').hidden = !(firstStep && authUi.mode === 'login');
  $('#setupStep').hidden = !(firstStep && authUi.mode === 'setup');
  $('#codeStep').hidden = authUi.step !== 'code';
  $('#newPasswordStep').hidden = authUi.step !== 'code' || authUi.mode === 'login';
  $('#forgotPassword').hidden = authUi.mode !== 'login' || authUi.step !== 'credentials';
  $('#authCode').value = authUi.step === 'code' ? $('#authCode').value : '';

  const title = $('#authTitle');
  const subtitle = $('#authSubtitle');
  const eyebrow = $('#authEyebrow');
  if (authUi.mode === 'setup') {
    eyebrow.textContent = 'PRIMEIRO ACESSO';
    title.textContent = authUi.step === 'code' ? 'Defina sua senha' : 'Ative seu acesso';
    subtitle.textContent = authUi.step === 'code' ? 'Digite o código enviado ao seu e-mail e escolha uma senha segura.' : 'Vamos confirmar sua identidade por e-mail antes de você criar sua senha pessoal.';
  } else if (authUi.mode === 'reset') {
    eyebrow.textContent = 'RECUPERAÇÃO SEGURA';
    title.textContent = 'Redefina sua senha';
    subtitle.textContent = 'Use o código enviado ao seu e-mail e escolha uma nova senha.';
  } else if (authUi.step === 'code') {
    eyebrow.textContent = 'VERIFICAÇÃO EM DUAS ETAPAS';
    title.textContent = 'Confirme que é você';
    subtitle.textContent = 'Digite o código de uso único que enviamos ao endereço cadastrado.';
  } else {
    eyebrow.textContent = 'ACESSO PESSOAL';
    title.textContent = 'Entrar no Codex';
    subtitle.textContent = 'Use sua senha e confirme o acesso com um código enviado ao seu e-mail.';
  }

  $('#verifyCode').textContent = authUi.mode === 'login' ? 'Confirmar e entrar' : authUi.mode === 'setup' ? 'Ativar acesso' : 'Salvar nova senha';
  $('#authScreen').hidden = false;
  $('#appShell').hidden = true;
}

function startResendCooldown(seconds) {
  const button = $('#resendCode');
  if (authUi.countdown) clearInterval(authUi.countdown);
  let remaining = Math.max(0, Number(seconds) || 0);
  const update = () => {
    button.disabled = remaining > 0;
    button.textContent = remaining > 0 ? `Reenviar em ${remaining}s` : 'Reenviar código';
    if (remaining <= 0 && authUi.countdown) {
      clearInterval(authUi.countdown);
      authUi.countdown = null;
    }
    remaining -= 1;
  };
  update();
  if (remaining >= 0) authUi.countdown = setInterval(update, 1000);
}

async function startLogin(event) {
  event?.preventDefault();
  const password = $('#authPassword').value;
  if (!password) return showAuthNotice('Informe sua senha.', 'error');
  const button = $('#loginSubmit');
  button.disabled = true;
  showAuthNotice('Validando sua senha e enviando o código…');
  try {
    const data = await api('/api/auth/login/start', { method: 'POST', body: JSON.stringify({ password }) });
    authUi.mode = 'login'; authUi.step = 'code'; authUi.challengeId = data.challengeId;
    $('#authEmailHint').textContent = data.emailHint || 'seu e-mail cadastrado';
    $('#authPassword').value = '';
    $('#authCode').value = '';
    showAuthFlow();
    showAuthNotice('Código enviado. Confira sua caixa de entrada e o spam.', 'success');
    startResendCooldown(data.resendIn);
    $('#authCode').focus();
  } catch (error) { showAuthNotice(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function startSetup() {
  const button = $('#startSetup');
  button.disabled = true;
  showAuthNotice('Enviando o código de ativação…');
  try {
    const data = await api('/api/auth/setup/start', { method: 'POST', body: '{}' });
    authUi.mode = 'setup'; authUi.step = 'code'; authUi.challengeId = data.challengeId;
    $('#authEmailHint').textContent = data.emailHint || 'seu e-mail cadastrado';
    $('#authCode').value = '';
    showAuthFlow();
    showAuthNotice('Código enviado. Depois de confirmar, você poderá definir sua senha.', 'success');
    startResendCooldown(data.resendIn);
    $('#authCode').focus();
  } catch (error) { showAuthNotice(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function startPasswordReset() {
  const button = $('#forgotPassword');
  button.disabled = true;
  showAuthNotice('Enviando o código de recuperação…');
  try {
    const data = await api('/api/auth/reset/start', { method: 'POST', body: '{}' });
    authUi.mode = 'reset'; authUi.step = 'code'; authUi.challengeId = data.challengeId;
    $('#authEmailHint').textContent = data.emailHint || 'seu e-mail cadastrado';
    $('#authCode').value = '';
    showAuthFlow();
    showAuthNotice('Código enviado para recuperação da senha.', 'success');
    startResendCooldown(data.resendIn);
    $('#authCode').focus();
  } catch (error) { showAuthNotice(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function verifyAuthCode() {
  const code = $('#authCode').value.trim();
  if (!/^\d{6}$/u.test(code)) return showAuthNotice('Informe o código de 6 dígitos recebido por e-mail.', 'error');
  const button = $('#verifyCode');
  button.disabled = true;
  showAuthNotice(authUi.mode === 'login' ? 'Confirmando seu acesso…' : 'Confirmando o código e salvando a senha…');
  try {
    let data;
    if (authUi.mode === 'login') {
      data = await api('/api/auth/login/verify', { method: 'POST', body: JSON.stringify({ challengeId: authUi.challengeId, code }) });
    } else {
      data = await api(`/api/auth/${authUi.mode}/complete`, {
        method: 'POST',
        body: JSON.stringify({ challengeId: authUi.challengeId, code, password: $('#newPassword').value, confirmPassword: $('#confirmPassword').value }),
      });
    }
    if (authUi.countdown) clearInterval(authUi.countdown);
    authUi.countdown = null;
    authUi.challengeId = '';
    showAuthNotice('Acesso confirmado.', 'success');
    startApplication();
  } catch (error) { showAuthNotice(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function resendAuthCode() {
  const button = $('#resendCode');
  button.disabled = true;
  showAuthNotice('Enviando outro código…');
  try {
    const data = await api('/api/auth/resend', { method: 'POST', body: JSON.stringify({ challengeId: authUi.challengeId }) });
    $('#authEmailHint').textContent = data.emailHint || $('#authEmailHint').textContent;
    showAuthNotice('Novo código enviado. O anterior deixou de valer.', 'success');
    startResendCooldown(data.resendIn);
  } catch (error) { showAuthNotice(error.message, 'error'); button.disabled = false; }
}

function startApplication() {
  $('#authScreen').hidden = true;
  $('#appShell').hidden = false;
  if (authUi.started) return;
  authUi.started = true;
  setInterval(updateResetCountdowns, 60_000);
  refreshVpsHealth();
  setInterval(() => { if (!document.hidden) refreshVpsHealth(); }, 60_000);
  bindEvents(); connectEvents(); bootstrap();
}

async function initializeAuthentication() {
  installIcons();
  $('#authForm').addEventListener('submit', (event) => authUi.step === 'code' ? (event.preventDefault(), verifyAuthCode()) : startLogin(event));
  $('#startSetup').addEventListener('click', startSetup);
  $('#forgotPassword').addEventListener('click', startPasswordReset);
  $('#verifyCode').addEventListener('click', verifyAuthCode);
  $('#resendCode').addEventListener('click', resendAuthCode);
  $('#backToAuth').addEventListener('click', () => {
    authUi.mode = authUi.setupRequired ? 'setup' : 'login'; authUi.step = 'credentials'; authUi.challengeId = '';
    if (authUi.countdown) clearInterval(authUi.countdown);
    authUi.countdown = null; showAuthNotice(''); showAuthFlow();
  });
  $('#togglePassword').addEventListener('click', () => {
    const input = $('#authPassword'); const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    $('#togglePassword').textContent = visible ? 'Ocultar' : 'Mostrar';
    $('#togglePassword').setAttribute('aria-label', visible ? 'Ocultar senha' : 'Mostrar senha');
  });
  try {
    const status = await api('/api/auth/status');
    authUi.setupRequired = Boolean(status.setupRequired);
    if (status.authenticated) return startApplication();
    authUi.mode = authUi.setupRequired ? 'setup' : 'login';
    authUi.step = 'credentials'; showAuthFlow();
  } catch (error) {
    authUi.mode = 'login'; authUi.step = 'credentials'; showAuthFlow();
    showAuthNotice(error.message || 'Não foi possível verificar sua sessão.', 'error');
  }
}

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('#toastContainer').append(node);
  setTimeout(() => node.remove(), 4200);
}

function voiceIsActive() { return ['requesting', 'recording', 'transcribing'].includes(voice.phase); }
function touchComposer() { return window.matchMedia('(pointer: coarse)').matches; }
function voiceTime(seconds) { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }

function renderVoice(error = '') {
  const panel = $('#voicePanel');
  $('#composerForm').classList.toggle('has-voice', voice.phase !== 'idle');
  const recording = voice.phase === 'recording';
  panel.hidden = voice.phase === 'idle';
  panel.classList.toggle('is-recording', recording);
  panel.classList.toggle('is-transcribing', voice.phase === 'transcribing');
  $('#voiceStatus').textContent = ({ requesting: 'Liberando microfone…', recording: 'Gravando sua mensagem', ready: 'Ouça e transcreva para revisar', transcribing: 'Transcrevendo… você pode continuar escrevendo' })[voice.phase] || '';
  $('#voiceTimer').textContent = voiceTime(voice.seconds);
  $('#voicePlayer').hidden = !voice.blob || recording;
  $('#stopRecording').hidden = !recording;
  $('#transcribeAudio').hidden = !voice.blob || recording;
  $('#transcribeAudio').disabled = voice.phase === 'transcribing';
  $('#transcribeAudio').textContent = voice.phase === 'transcribing' ? 'Transcrevendo…' : 'Transcrever áudio';
  $('#downloadAudio').hidden = !voice.blob || recording;
  $('#discardAudio').textContent = voice.phase === 'transcribing' ? 'Cancelar transcrição' : 'Descartar';
  $('#voiceError').hidden = !error;
  $('#voiceError').textContent = error;
  $('#voiceInput').classList.toggle('listening', recording);
  $('#voiceInput').setAttribute('aria-pressed', String(recording));
  $('#voiceInput').disabled = voice.phase === 'requesting' || voice.phase === 'transcribing' || voice.phase === 'ready';
  $('#voiceButtonLabel').textContent = recording ? 'Concluir' : 'Gravar';
  $('#attachAudio').disabled = voice.phase !== 'idle';
  updateComposerControls();
}

function releaseMicrophone() {
  clearInterval(voice.timer); voice.timer = null;
  cancelAnimationFrame(voice.meterFrame);
  voice.stream?.getTracks().forEach((track) => track.stop()); voice.stream = null;
  voice.meterSource?.disconnect(); voice.meterSource = null;
  voice.context?.close().catch(() => {}); voice.context = null;
}

function clearRecordedAudio() {
  voice.cancelled = true;
  voice.generation += 1;
  voice.request?.abort(); voice.request = null;
  if (voice.jobId) api(`/api/voice/transcriptions/${voice.jobId}`, { method: 'DELETE' }).catch(() => {});
  voice.jobId = null;
  if (voice.recorder?.state === 'recording') voice.recorder.stop();
  releaseMicrophone(); voice.recorder = null;
  $('#voicePlayer').pause(); $('#voicePlayer').removeAttribute('src'); $('#voicePlayer').load();
  if (voice.url) URL.revokeObjectURL(voice.url);
  voice.url = ''; voice.blob = null; voice.chunks = []; voice.phase = 'idle'; voice.seconds = 0;
  renderVoice();
}

function showRecordedAudio(blob) {
  if (!blob.size) { clearRecordedAudio(); toast('O áudio ficou vazio. Tente gravar novamente.', 'error'); return; }
  if (blob.size > 12 * 1024 * 1024) { clearRecordedAudio(); toast('O limite é de 12 MB por áudio.', 'error'); return; }
  voice.blob = blob; voice.url = URL.createObjectURL(blob); voice.phase = 'ready';
  $('#voicePlayer').src = voice.url;
  renderVoice();
}

async function transcribeRecordedAudio() {
  if (!voice.blob || voice.phase !== 'ready') return;
  const generation = voice.generation;
  voice.phase = 'transcribing'; voice.request = new AbortController();
  const signal = voice.request.signal;
  renderVoice();
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Não consegui ler a gravação.')); reader.readAsDataURL(voice.blob);
    });
    if (signal.aborted) return;
    const job = await api('/api/voice/transcriptions', { method: 'POST', signal, body: JSON.stringify({ mime: voice.blob.type, data: String(dataUrl).split(',')[1] }) });
    voice.jobId = job.id;
    const deadline = Date.now() + 330_000;
    while (!signal.aborted && Date.now() < deadline) {
      const result = await api(`/api/voice/transcriptions/${job.id}`, { signal });
      if (result.status === 'failed' || result.status === 'cancelled') throw new Error(result.error || 'Transcrição cancelada.');
      if (result.status === 'completed') {
        if (!result.text?.trim()) throw new Error('Não identifiquei fala neste áudio. Tente gravar novamente.');
        if (generation !== voice.generation) return;
        const textarea = $('#messageInput');
        const draft = textarea.value.trimEnd();
        textarea.value = `${draft}${draft ? '\n\n' : ''}${result.text.trim()}`;
        voice.jobId = null;
        clearRecordedAudio();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        if (!touchComposer()) textarea.focus();
        toast('Transcrição pronta. Revise o texto e toque em Enviar.');
        return;
      }
      await new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(new DOMException('Cancelado', 'AbortError')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 1500);
        signal.addEventListener('abort', cancel, { once: true });
      });
    }
    if (!signal.aborted) throw new Error('A transcrição demorou demais. Seu áudio continua aqui para tentar novamente.');
  } catch (error) {
    if (error.name === 'AbortError' || generation !== voice.generation) return;
    if (voice.jobId) api(`/api/voice/transcriptions/${voice.jobId}`, { method: 'DELETE' }).catch(() => {});
    voice.jobId = null; voice.request = null; voice.phase = 'ready';
    renderVoice(error.message || 'Não foi possível transcrever. Seu áudio foi preservado.');
  }
}

async function startVoiceRecording() {
  if (voice.phase === 'recording') { stopVoiceRecording(); return; }
  if (voice.phase !== 'idle') return;
  if (touchComposer()) $('#messageInput').blur();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { $('#audioInput').click(); return; }
  voice.cancelled = false; voice.phase = 'requesting'; voice.hasSignal = false;
  const generation = ++voice.generation;
  renderVoice();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (voice.cancelled || generation !== voice.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
    voice.stream = stream;
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64000 });
    voice.recorder = recorder; voice.chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size && generation === voice.generation) voice.chunks.push(event.data); };
    recorder.onstop = () => {
      if (generation !== voice.generation) return;
      releaseMicrophone(); voice.recorder = null;
      if (voice.cancelled) return;
      const blob = new Blob(voice.chunks, { type: recorder.mimeType || voice.chunks[0]?.type || 'audio/webm' });
      showRecordedAudio(blob);
    };
    recorder.onerror = () => { clearRecordedAudio(); toast('A gravação foi interrompida pelo navegador. Tente novamente.', 'error'); };
    recorder.start(500); voice.startedAt = Date.now(); voice.seconds = 0; voice.phase = 'recording';
    voice.timer = setInterval(() => {
      voice.seconds = Math.floor((Date.now() - voice.startedAt) / 1000);
      $('#voiceTimer').textContent = `${voiceTime(voice.seconds)} / 3:00`;
      if (voice.seconds >= 180 && recorder.state === 'recording') recorder.stop();
    }, 500);
    renderVoice();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      try {
        voice.context = new AudioContextClass();
        voice.meterSource = voice.context.createMediaStreamSource(stream);
        const analyser = voice.context.createAnalyser(); analyser.fftSize = 256;
        voice.meterSource.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const draw = () => {
          if (voice.phase !== 'recording') return;
          analyser.getByteTimeDomainData(data);
          const level = Math.sqrt(data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / data.length);
          voice.hasSignal ||= level > .01;
          $('#voicePanel').style.setProperty('--voice-level', `${Math.min(100, Math.max(4, level * 600))}%`);
          if (voice.seconds >= 5 && !voice.hasSignal) $('#voiceStatus').textContent = 'Som muito baixo. Confira seu microfone';
          else $('#voiceStatus').textContent = 'Gravando sua mensagem';
          voice.meterFrame = requestAnimationFrame(draw);
        };
        draw();
      } catch { /* Recording remains usable if metering is unavailable. */ }
    }
  } catch (error) {
    clearRecordedAudio();
    toast(error.name === 'NotAllowedError' ? 'Permita o microfone nas configurações do navegador ou escolha um arquivo de áudio.' : 'Não consegui acessar o microfone. Você pode escolher um arquivo de áudio.', 'error');
  }
}

function stopVoiceRecording() {
  if (voice.recorder?.state === 'recording') voice.recorder.stop();
}

function setupComposerViewport() {
  const sync = () => {
    const viewport = window.visualViewport;
    document.documentElement.style.setProperty('--app-height', `${viewport?.height || window.innerHeight}px`);
    document.documentElement.style.setProperty('--viewport-top', `${viewport?.offsetTop || 0}px`);
  };
  window.visualViewport?.addEventListener('resize', sync);
  window.visualViewport?.addEventListener('scroll', sync);
  window.addEventListener('resize', sync);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && voice.phase === 'recording') voice.recorder?.stop();
  });
  sync();
}

function getSelectedModel() { return state.models.find((model) => model.id === state.modelId) || state.models.find((model) => model.isDefault) || state.models[0] || null; }

function populateModels() {
  const select = $('#modelSelect');
  select.replaceChildren();
  state.models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.displayName || model.model || model.id;
    select.append(option);
  });
  if (!state.models.some((model) => model.id === state.modelId)) state.modelId = getSelectedModel()?.id || '';
  select.value = state.modelId;
  updateEfforts();
  updateComposerControls();
}

function updateEfforts() {
  const model = getSelectedModel();
  const select = $('#effortSelect');
  select.replaceChildren();
  if (!model) return;
  const supported = model.supportedReasoningEfforts || [];
  supported.forEach((item) => {
    const value = item.reasoningEffort || item;
    const option = document.createElement('option');
    option.value = value;
    option.textContent = effortLabel(value);
    select.append(option);
  });
  if (!supported.some((item) => (item.reasoningEffort || item) === state.effort)) state.effort = model.defaultReasoningEffort || (supported[0]?.reasoningEffort || supported[0]) || '';
  select.value = state.effort;
  select.title = supported.find((item) => (item.reasoningEffort || item) === state.effort)?.description || `Raciocínio ${effortLabel(state.effort).toLowerCase()}`;
}

function pathIsWithin(path, root) {
  const base = String(root || '').replace(/\/+$/, '');
  const target = String(path || '');
  return Boolean(base && target && (target === base || target.startsWith(base + '/')));
}

function projectForThread(thread) {
  if (!thread) return null;
  return state.projects.find((project) => {
    if ((project.threadIds || []).includes(thread.id)) return true;
    const cwd = thread.cwd || thread.workingDirectory || thread.workspace?.cwd || '';
    return pathIsWithin(cwd, project.cwd);
  }) || null;
}

function threadBelongsToProject(thread, project) {
  return projectForThread(thread)?.id === project.id;
}

function threadDisplayTitle(thread) {
  const name = String(thread?.name || '').trim();
  if (name && !/^#\s*Files mentioned by the user\s*:/i.test(name)) return name.split(/\r?\n/, 1)[0].trim().slice(0, 100) || 'Nova conversa';
  const preview = String(thread?.preview || '').trim();
  if (/^#\s*Files mentioned by the user\s*:/i.test(preview)) return 'Conversa com arquivo anexado';
  return preview.split(/\r?\n/, 1)[0].trim().slice(0, 100) || 'Nova conversa';
}

function updateWorkingDirectory(path) {
  state.cwd = path;
  localStorage.setItem('codex-cwd', path);
  $('#cwdLabel').textContent = path;
  $('#inspectorCwd').textContent = path;
  renderConversationContext();
}

function renderConversationContext() {
  const badge = $('#conversationContext');
  const activeProjectId = state.selectedThreadId ? state.activeThreadProjectId : state.selectedProjectId;
  const project = state.projects.find((item) => item.id === activeProjectId) || null;
  if (badge) {
    badge.textContent = project ? `Projeto · ${project.name}` : 'Geral · sem projeto';
    badge.title = project ? `Esta conversa usa o projeto ${project.name} (${project.cwd})` : 'Esta conversa não está vinculada a um projeto.';
  }
  const select = $('#chatContextSelect');
  if (!select) return;
  const current = state.selectedProjectId;
  select.replaceChildren(new Option('Dúvida geral · sem projeto', ''));
  state.projects.forEach((item) => select.add(new Option(`Desenvolver em · ${item.name}`, item.id)));
  select.value = state.projects.some((item) => item.id === current) ? current : '';
}

function associateThreadWithSelectedProject(threadId) {
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  if (!project || !threadId) return;
  if (!Array.isArray(project.threadIds)) project.threadIds = [];
  if (!project.threadIds.includes(threadId)) project.threadIds.push(threadId);
  renderProjects();
}

function renderProjects() {
  const list = $('#projectList');
  if (!list) return;
  list.replaceChildren();

  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'project-item' + (state.selectedProjectId ? '' : ' active');
  all.innerHTML = '<span class="icon" data-icon="folder"></span>';
  const allLabel = document.createElement('span');
  allLabel.className = 'project-item-label';
  allLabel.textContent = 'Todas as conversas';
  all.append(allLabel);
  all.addEventListener('click', () => selectProject(''));
  list.append(all);

  state.projects.forEach((project) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'project-item' + (project.id === state.selectedProjectId ? ' active' : '');
    button.title = project.cwd;
    button.innerHTML = '<span class="icon" data-icon="folder"></span>';
    const label = document.createElement('span');
    label.className = 'project-item-label';
    label.textContent = project.name;
    const count = document.createElement('span');
    count.className = 'project-count';
    count.textContent = String(state.threads.filter((thread) => threadBelongsToProject(thread, project)).length);
    button.append(label, count);
    button.addEventListener('click', () => selectProject(project.id));
    list.append(button);
  });
  installIcons();
  renderConversationContext();
}

function selectProject(id, { folderPath = null, updateActiveThread = false } = {}) {
  const project = state.projects.find((item) => item.id === id) || null;
  state.selectedProjectId = project?.id || '';
  if (state.selectedProjectId) localStorage.setItem('codex-project', state.selectedProjectId);
  else localStorage.removeItem('codex-project');
  if (folderPath) updateWorkingDirectory(folderPath);
  else if (!state.selectedThreadId) updateWorkingDirectory(project?.cwd || state.defaultCwd || state.cwd);
  if (updateActiveThread && state.selectedThreadId) state.activeThreadProjectId = project?.id || '';
  renderConversationContext();
  renderThreads(state.threads, $('#threadSearch').value.trim());
}

function projectSlug(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'novo-projeto';
}

function updateProjectDirectoryField() {
  const createDirectory = $('#projectCreateDirectory').checked;
  const path = $('#projectPath');
  path.readOnly = createDirectory;
  $('#projectDialogCopy').textContent = createDirectory
    ? 'A pasta será criada dentro da área de projetos da VPS. O Codex começará uma conversa já vinculada a ela.'
    : 'Converse com o Codex dentro de uma pasta existente. As conversas iniciadas nela aparecem agrupadas no projeto.';
  $('#projectsRootLabel').textContent = state.projectsRoot || `${state.defaultCwd}/projects`;
  if (createDirectory) {
    const name = $('#projectName').value.trim();
    path.value = `${state.projectsRoot || `${state.defaultCwd}/projects`}/${projectSlug(name)}`;
  }
}

function openProjectDialog(createDirectory = false) {
  $('#projectForm').reset();
  $('#projectName').value = '';
  $('#projectCreateDirectory').checked = createDirectory;
  $('#projectPath').value = createDirectory ? '' : state.cwd;
  updateProjectDirectoryField();
  $('#projectDialog').showModal();
  $('#projectName').focus();
}

async function createProject(event) {
  event.preventDefault();
  const name = $('#projectName').value.trim();
  const cwd = $('#projectPath').value.trim();
  const createDirectory = $('#projectCreateDirectory').checked;
  try {
    const data = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, cwd, createDirectory }) });
    state.projects = data.projects || [];
    $('#projectDialog').close();
    $('#projectForm').reset();
    selectProject(data.project.id);
    if (createDirectory) newChat();
    toast('Projeto criado.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function closeThreadMenus() {
  $$('.thread-actions-popover').forEach((menu) => {
    if (menu.matches(':popover-open')) menu.hidePopover();
  });
}

function renderThreads(threads = state.threads, query = $('#threadSearch')?.value.trim() || '') {
  state.threads = threads;
  renderProjects();
  const list = $('#threadList');
  const heading = $('#threadListTitle');
  if (heading) heading.textContent = query ? 'Resultados da busca' : state.archivedView ? 'Arquivadas' : 'Conversas';
  const archivedToggle = $('#toggleArchived');
  if (archivedToggle) {
    archivedToggle.setAttribute('aria-pressed', String(state.archivedView));
    archivedToggle.setAttribute('aria-label', 'Mostrar conversas arquivadas');
  }
  $('#showRecentThreads')?.setAttribute('aria-pressed', String(!state.archivedView));
  closeThreadMenus();
  $$('.thread-actions-popover').forEach((menu) => menu.remove());
  list.replaceChildren();
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  const allProjects = Boolean(query && $('#threadSearchScope')?.value === 'all');
  const visibleThreads = [...(project && !allProjects ? threads.filter((thread) => threadBelongsToProject(thread, project)) : threads)]
    .sort((left, right) => Number(right.section?.id === PINNED_THREAD_SECTION_ID) - Number(left.section?.id === PINNED_THREAD_SECTION_ID));
  $('#clearThreadSearch')?.classList.toggle('hidden', !query);
  if ($('#threadSearchHint')) $('#threadSearchHint').textContent = query ? `${visibleThreads.length} resultado${visibleThreads.length === 1 ? '' : 's'}` : '';
  list.setAttribute('aria-label', state.archivedView ? 'Conversas arquivadas' : 'Conversas recentes e fixadas');
  if (!visibleThreads.length) {
    const empty = document.createElement('div');
    empty.className = 'thread-empty';
    empty.textContent = query ? 'Nenhuma conversa encontrada.' : state.archivedView ? 'Nenhuma conversa arquivada.' : project ? 'Este projeto ainda não tem conversas.' : 'Suas conversas recentes aparecerão aqui.';
    list.append(empty);
    return;
  }
  let previousGroup = '';
  visibleThreads.forEach((thread) => {
    const pinned = thread.section?.id === PINNED_THREAD_SECTION_ID;
    const groupName = state.archivedView || query ? '' : pinned ? 'Fixadas' : 'Recentes';
    if (groupName && groupName !== previousGroup) {
      const groupHeading = document.createElement('div'); groupHeading.className = 'thread-group-heading'; groupHeading.textContent = groupName;
      list.append(groupHeading); previousGroup = groupName;
    }
    const row = document.createElement('div');
    row.className = `thread-row${pinned ? ' pinned' : ''}`;
    const button = document.createElement('button');
    const isRunning = state.activeThreadIds.has(thread.id) || thread.status?.type === 'active';
    button.className = `thread-item ${thread.id === state.selectedThreadId ? 'active' : ''}${isRunning ? ' running' : ''}`;
    button.type = 'button';
    button.title = threadDisplayTitle(thread);
    button.innerHTML = `<span class="icon" data-icon="chat"></span><span class="thread-item-title"></span>${isRunning ? '<span class="thread-running-indicator" role="status" aria-label="Codex trabalhando" title="Codex trabalhando"></span>' : ''}${thread.section?.id === PINNED_THREAD_SECTION_ID ? '<span class="thread-pin-badge">Fixada</span>' : ''}`;
    $('.thread-item-title', button).textContent = threadDisplayTitle(thread);
    button.addEventListener('click', () => openThread(thread.id));
    const menu = document.createElement('div');
    menu.className = 'thread-actions';
    const trigger = document.createElement('button');
    trigger.type = 'button'; trigger.className = 'thread-actions-trigger';
    trigger.textContent = '⋯';
    trigger.title = 'Ações da conversa';
    trigger.setAttribute('aria-label', `Ações: ${threadDisplayTitle(thread)}`);
    trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
    menu.append(trigger);
    const popover = document.createElement('div');
    popover.className = 'thread-actions-popover';
    popover.id = `thread-menu-${thread.id}`; popover.setAttribute('popover', 'auto'); popover.setAttribute('role', 'menu');
    popover.setAttribute('aria-label', `Ações: ${threadDisplayTitle(thread)}`); trigger.setAttribute('aria-controls', popover.id);
    const action = (label, handler, { danger = false, disabled = false, icon = 'chat' } = {}) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = danger ? 'thread-action danger' : 'thread-action';
      item.setAttribute('role', 'menuitem');
      item.innerHTML = `<span class="icon" data-icon="${icon}"></span><span>${escapeHtml(label)}</span>`;
      item.disabled = disabled;
      if (disabled) item.title = 'Disponível quando a execução terminar.';
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        popover.hidePopover();
        handler();
      });
      popover.append(item);
    };
    const running = thread.status?.type === 'active';
    action('Renomear', () => performThreadAction(thread, 'rename'), { icon: 'rename' });
    if (!state.archivedView) action(pinned ? 'Desafixar' : 'Fixar no topo', () => performThreadAction(thread, 'pin'), { icon: 'pin' });
    action(state.archivedView ? 'Restaurar conversa' : 'Arquivar conversa', () => performThreadAction(thread, state.archivedView ? 'unarchive' : 'archive'), { disabled: running, icon: 'archive' });
    action('Excluir conversa', () => performThreadAction(thread, 'delete'), { danger: true, disabled: running, icon: 'trash' });
    document.body.append(popover);
    trigger.addEventListener('click', () => {
      if (popover.matches(':popover-open')) return popover.hidePopover();
      closeThreadMenus(); popover.showPopover();
      const rect = trigger.getBoundingClientRect();
      const height = popover.getBoundingClientRect().height;
      popover.style.left = `${Math.max(8, Math.min(innerWidth - 212, rect.right - 204))}px`;
      popover.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, rect.bottom + 5))}px`;
    });
    popover.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(popover.matches(':popover-open'))));
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); if (!popover.matches(':popover-open')) trigger.click(); $('button:not(:disabled)', popover)?.focus(); }
    });
    popover.addEventListener('keydown', (event) => {
      const buttons = $$('button:not(:disabled)', popover); const index = buttons.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); popover.hidePopover(); trigger.focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
    });
    row.append(button, menu);
    list.append(row);
  });
  installIcons();
}

async function performThreadAction(thread, action) {
  const id = encodeURIComponent(thread.id);
  try {
    if (action === 'rename') {
      const name = window.prompt('Nome da conversa', thread.name || threadDisplayTitle(thread));
      if (name === null) return;
      const trimmed = name.trim();
      if (!trimmed) return toast('O nome não pode ficar vazio.', 'error');
      await api(`/api/threads/${id}/rename`, { method: 'POST', body: JSON.stringify({ name: trimmed }) });
      if (state.selectedThreadId === thread.id) updateThreadHeader({ ...state.selectedThread, name: trimmed });
      toast('Conversa renomeada.');
    } else if (action === 'pin') {
      const pinned = thread.section?.id !== PINNED_THREAD_SECTION_ID;
      await api(`/api/threads/${id}/pin`, { method: 'POST', body: JSON.stringify({ pinned }) });
      toast(pinned ? 'Conversa fixada no topo.' : 'Conversa desafixada.');
    } else if (action === 'archive' || action === 'unarchive') {
      await api(`/api/threads/${id}/${action}`, { method: 'POST', body: '{}' });
      if (state.selectedThreadId === thread.id) newChat();
      toast(action === 'archive' ? 'Conversa arquivada.' : 'Conversa restaurada.');
    } else if (action === 'delete') {
      const title = threadDisplayTitle(thread);
      if (!window.confirm(`Excluir permanentemente “${title}”? Esta ação não pode ser desfeita.`)) return;
      await api(`/api/threads/${id}/delete`, { method: 'DELETE' });
      if (state.selectedThreadId === thread.id) newChat();
      toast('Conversa excluída.');
    }
    await refreshThreadList($('#threadSearch').value.trim());
  } catch (error) {
    toast(error.message, 'error');
  }
}

function setConnection(online, message) {
  $('#connectionDot').className = `status-dot ${online ? 'online' : 'offline'}`;
  $('#connectionText').textContent = message || (online ? 'Codex conectado' : 'Reconectando…');
}

function renderUsage() {
  const meters = $('#rateLimitMeters');
  const data = state.rateLimits;
  const buckets = data ? (Array.isArray(data) ? data : Object.values(data)) : [];
  if (!buckets.length) {
    meters.innerHTML = '<div class="meter-heading"><span>Limites da conta</span><span>indisponíveis</span></div>';
  } else {
    meters.innerHTML = buckets.map((bucket, index) => {
      const primaries = [bucket.primary, bucket.secondary].filter(Boolean);
      return primaries.map((window, windowIndex) => {
        const used = Math.min(100, Math.max(0, Number(window.usedPercent) || 0));
        const label = bucket.limitName || (index === 0 ? 'Codex' : bucket.limitId || 'Outro limite');
        const windowLabel = windowIndex === 0 ? 'janela curta' : 'janela longa';
        const reset = formatReset(window.resetsAt);
        const resetAt = Number(window.resetsAt);
        const countdown = Number.isFinite(resetAt) && resetAt > 0 ? `<strong class="meter-countdown" data-reset-at="${Math.floor(resetAt)}">${formatCountdown(resetAt)}</strong>` : '';
        return `<div class="meter"><div class="meter-heading"><span>${escapeHtml(label)} · ${windowLabel}</span><span>${Math.round(used)}% usado</span></div><div class="meter-track"><div class="meter-fill ${used >= 90 ? 'critical' : used >= 75 ? 'high' : ''}" style="width:${used}%"></div></div><div class="meter-reset-row"><span class="meter-reset">${escapeHtml(reset)}</span>${countdown}</div></div>`;
      }).join('');
    }).join('');
  }
  const summary = state.usage?.summary || {};
  const daily = state.usage?.dailyUsageBuckets;
  const recent = Array.isArray(daily) && daily.length ? daily[daily.length - 1].tokens : null;
  const metrics = [
    { label: 'Tokens acumulados', value: summary.lifetimeTokens, format: formatNumber },
    { label: 'Último dia disponível', value: recent, format: formatNumber },
    { label: 'Maior uso diário', value: summary.peakDailyTokens, format: formatNumber },
    { label: 'Sequência atual', value: summary.currentStreakDays, format: (value) => `${formatNumber(value)} ${Number(value) === 1 ? 'dia' : 'dias'}` },
    { label: 'Maior sequência', value: summary.longestStreakDays, format: (value) => `${formatNumber(value)} ${Number(value) === 1 ? 'dia' : 'dias'}` },
    { label: 'Turno mais longo', value: summary.longestRunningTurnSec, format: (value) => formatDuration(Number(value) * 1000) },
  ].filter((metric) => metric.value != null && Number.isFinite(Number(metric.value)));
  $('#tokenSummary').innerHTML = metrics.map((metric) => `<div class="token-stat"><strong>${escapeHtml(metric.format(metric.value))}</strong><span>${escapeHtml(metric.label)}</span></div>`).join('');
  updateResetCountdowns();
  const plan = state.account?.planType;
  if (plan && $('#planBadge')) $('#planBadge').textContent = String(plan).replace(/^./, (char) => char.toUpperCase());
}

function showInspector(show) {
  if (show) closeSidebar();
  $('#inspector').classList.toggle('open', show);
  if (window.innerWidth <= 680) {
    $('#mobileScrim').classList.toggle('show', show || $('#sidebar').classList.contains('open'));
  }
}

function setupInspectorResize() {
  const handle = $('#inspectorResizeHandle');
  const root = document.documentElement;
  const minimum = 260;
  const maximum = () => {
    const sidebarWidth = Number.parseFloat(getComputedStyle(root).getPropertyValue('--side-width')) || 264;
    return Math.max(minimum, Math.min(560, window.innerWidth - sidebarWidth - 460));
  };
  const current = () => Number.parseFloat(getComputedStyle(root).getPropertyValue('--inspector-width')) || 300;
  let preferredWidth = Number(localStorage.getItem('codex-inspector-width'));
  if (!Number.isFinite(preferredWidth) || preferredWidth < minimum) preferredWidth = current();
  const apply = (requested) => {
    const width = Math.min(maximum(), Math.max(minimum, requested));
    root.style.setProperty('--inspector-width', `${width}px`);
    handle.setAttribute('aria-valuemax', String(Math.round(maximum())));
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
  };
  apply(preferredWidth);
  let pointerId = null;
  handle.addEventListener('pointerdown', (event) => {
    if (window.innerWidth <= 980 || event.button !== 0) return;
    pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    document.body.classList.add('resizing-inspector');
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (event.pointerId === pointerId) apply(window.innerWidth - event.clientX);
  });
  const finish = (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    document.body.classList.remove('resizing-inspector');
    preferredWidth = current();
    localStorage.setItem('codex-inspector-width', String(Math.round(preferredWidth)));
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowLeft') { event.preventDefault(); apply(current() + step); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); apply(current() - step); }
    else if (event.key === 'Home') { event.preventDefault(); apply(minimum); }
    else if (event.key === 'End') { event.preventDefault(); apply(maximum()); }
    else return;
    preferredWidth = current();
    localStorage.setItem('codex-inspector-width', String(Math.round(preferredWidth)));
  });
  window.addEventListener('resize', () => { if (window.innerWidth > 980) apply(preferredWidth); });
}

function updateThreadHeader(thread) {
  state.selectedThread = thread || null;
  const title = thread?.id ? threadDisplayTitle(thread) : 'Novo chat';
  $('#activeTitle').textContent = title;
  $('#threadInfo').classList.toggle('hidden', !thread?.id);
  if (thread?.id) {
    const updated = thread.updatedAt ? new Date(Number(thread.updatedAt) * (Number(thread.updatedAt) < 1e12 ? 1000 : 1)) : null;
    const status = thread.status?.type === 'active' ? 'Em execução' : 'Pronta para continuar';
    $('#threadMeta').innerHTML = `<div class="thread-meta-row"><span>Estado</span><strong>${escapeHtml(status)}</strong></div><div class="thread-meta-row"><span>Modelo</span><strong>${escapeHtml(thread.model || thread.modelProvider || 'Codex')}</strong></div><div class="thread-meta-row"><span>Atualizada</span><strong>${updated && !Number.isNaN(updated.getTime()) ? escapeHtml(new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(updated)) : '—'}</strong></div>`;
    location.hash = `thread=${encodeURIComponent(thread.id)}`;
    renderContextUsage(state.contextUsage);
  } else {
    $('#threadMeta').replaceChildren();
    state.contextUsage = null;
    renderContextUsage(null);
    history.replaceState(null, '', location.pathname);
  }
  renderConversationContext();
  renderThreads(state.threads);
}

function renderContextUsage(snapshot) {
  const root = $('#contextUsageMeter');
  if (!root) return;
  const usage = snapshot?.tokenUsage || snapshot || null;
  const used = Number(usage?.last?.totalTokens ?? usage?.last?.inputTokens ?? usage?.lastTokenUsage?.totalTokens);
  const capacity = Number(usage?.modelContextWindow ?? usage?.model_context_window);
  if (!state.selectedThreadId) {
    root.innerHTML = '<p class="muted-note">Abra uma conversa para ver o contexto usado e o limite do modelo.</p>';
    return;
  }
  if (!Number.isFinite(used) || !Number.isFinite(capacity) || capacity <= 0) {
    root.innerHTML = '<p class="muted-note">Aguardando a próxima leitura de tokens desta conversa.</p>';
    return;
  }
  const percent = Math.min(100, Math.max(0, used / capacity * 100));
  const remaining = Math.max(0, capacity - used);
  const tone = percent >= 90 ? 'critical' : percent >= 75 ? 'high' : '';
  const updated = snapshot?.updatedAt ? new Date(snapshot.updatedAt) : null;
  const updatedText = updated && !Number.isNaN(updated.getTime()) ? new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(updated) : '';
  root.innerHTML = `<div class="context-usage-heading"><strong>${escapeHtml(formatNumber(used))} usados</strong><span>${escapeHtml(formatNumber(capacity))} tokens</span></div><div class="meter-track context-usage-track"><div class="meter-fill ${tone}" style="width:${percent.toFixed(1)}%"></div></div><div class="context-usage-foot"><span>${percent.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% · ${escapeHtml(formatNumber(remaining))} restantes</span><span>${updatedText ? `Atualizado ${escapeHtml(updatedText)}` : 'Último turno'}</span></div><p class="muted-note">Estimativa do último turno em relação à janela do modelo. A janela pode incluir instruções e ferramentas, não só o texto visível.</p>`;
}

async function loadContextUsage(threadId) {
  state.contextUsage = null;
  renderContextUsage(null);
  if (!threadId) return;
  try {
    const data = await api(`/api/threads/${encodeURIComponent(threadId)}/context-usage`);
    if (state.selectedThreadId !== threadId) return;
    state.contextUsage = data.contextUsage || null;
    renderContextUsage(state.contextUsage);
  } catch { /* Live app-server notifications will update the meter when available. */ }
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) { scaled /= 1024; unit += 1; }
  return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(scaled)} ${units[unit]}`;
}

function renderVpsHealth(data) {
  const hostMetrics = $('#vpsHostMetrics');
  const projectList = $('#vpsProjectList');
  const storageList = $('#vpsStorageList');
  if (!data?.host) {
    hostMetrics.innerHTML = '<p class="vps-health-error">Métricas indisponíveis.</p>';
    projectList.innerHTML = data?.docker?.error ? `<p class="vps-health-error">${escapeHtml(data.docker.error)}</p>` : '';
    return;
  }

  const { host, docker } = data;
  const memoryPercent = host.memory.totalBytes ? Math.round((host.memory.usedBytes / host.memory.totalBytes) * 100) : 0;
  const diskPercent = host.disk?.usedPercent ?? 0;
  const percentClass = (value) => value >= 90 ? 'critical' : value >= 75 ? 'high' : '';
  hostMetrics.innerHTML = `
    <div class="vps-metric"><div class="vps-metric-heading"><span>CPU</span><strong>${Number(host.cpu.percent).toFixed(1)}%</strong></div><div class="vps-meter"><i class="${percentClass(host.cpu.percent)}" style="width:${Math.min(100, host.cpu.percent)}%"></i></div><small>${host.cpu.cores} vCPU · carga ${Number(host.load1m).toFixed(2)}</small></div>
    <div class="vps-metric"><div class="vps-metric-heading"><span>Memória</span><strong>${escapeHtml(formatBytes(host.memory.availableBytes))} livres</strong></div><div class="vps-meter"><i class="${percentClass(memoryPercent)}" style="width:${memoryPercent}%"></i></div><small>${escapeHtml(formatBytes(host.memory.usedBytes))} / ${escapeHtml(formatBytes(host.memory.totalBytes))} · ${memoryPercent}% usado</small></div>
    <div class="vps-metric"><div class="vps-metric-heading"><span>Disco raiz</span><strong>${escapeHtml(formatBytes(host.disk?.availableBytes))} livres</strong></div><div class="vps-meter"><i class="${percentClass(diskPercent)}" style="width:${diskPercent}%"></i></div><small>${escapeHtml(formatBytes(host.disk?.usedBytes))} / ${escapeHtml(formatBytes(host.disk?.totalBytes))} · ${diskPercent}% usado</small></div>
    <div class="vps-metric vps-container-count"><div class="vps-metric-heading"><span>Containers</span><strong>${docker.runningCount} ativos</strong></div><small>${docker.stoppedCount} parados · amostra ao vivo</small></div>`;

  if (!docker.available) {
    projectList.innerHTML = `<p class="vps-health-error">${escapeHtml(docker.error || 'Docker indisponível.')}</p>`;
  } else {
    const projects = docker.projects || [];
    const hostServices = (host.services || []).map((service) => `<div class="vps-project-row host-service-row"><span class="vps-state-dot healthy"></span><span class="vps-project-name"><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.status)} · CPU ${Number(service.cpuPercent).toFixed(1)}%</small></span><span class="vps-project-memory">${escapeHtml(formatBytes(service.memoryBytes))}</span></div>`).join('');
    const projectRows = projects.map((project) => {
      const stateClass = project.unhealthy ? 'unhealthy' : project.stopped ? 'partial' : 'healthy';
      const stateText = project.unhealthy ? 'Com falha' : project.stopped ? `${project.running}/${project.containers} ativos` : 'Em execução';
      const children = (docker.containers || []).filter((container) => container.project === project.name).map((container) => `<div class="vps-container-row"><span>${escapeHtml(container.name)}</span><span>${container.running ? `${Number(container.cpuPercent).toFixed(1)}% CPU · ${escapeHtml(formatBytes(container.memoryBytes))} RAM` : escapeHtml(container.status)} · disco ${escapeHtml(formatBytes(container.storageBytes))}</span></div>`).join('');
      const projectPath = project.sourcePath ? `<div class="vps-storage-breakdown"><span>Código · ${escapeHtml(project.sourcePath)}</span><strong>${escapeHtml(formatBytes(project.sourceBytes))}</strong></div>` : '';
      const projectVolumes = (data.dockerVolumes || []).filter((volume) => volume.project === project.name).map((volume) => `<div class="vps-storage-breakdown"><span>Volume · ${escapeHtml(volume.name)}</span><strong>${escapeHtml(volume.size)}</strong></div>`).join('');
      return `<details class="vps-project-details"><summary class="vps-project-row"><span class="vps-state-dot ${stateClass}"></span><span class="vps-project-name"><strong>${escapeHtml(project.name)}</strong><small>${project.containers} ${project.containers === 1 ? 'container' : 'containers'} · CPU ${Number(project.cpuPercent).toFixed(1)}% · ${escapeHtml(stateText)}</small></span><span class="vps-project-resources"><strong>${escapeHtml(formatBytes(project.memoryBytes))}</strong><small>${escapeHtml(formatBytes(project.storageBytes))} disco</small></span></summary><div class="vps-container-list">${children}${projectPath}${projectVolumes}</div></details>`;
    }).join('');
    const stopped = (docker.containers || []).filter((container) => !container.running);
    const stoppedDetails = stopped.length ? `<details class="vps-stopped-details"><summary>${stopped.length} ${stopped.length === 1 ? 'container parado' : 'containers parados'}</summary><div>${stopped.map((container) => `<p><strong>${escapeHtml(container.name)}</strong><small>${escapeHtml(container.status)}</small></p>`).join('')}</div></details>` : '';
    projectList.innerHTML = `<div class="vps-project-heading"><span>INSTÂNCIA</span><span>MEMÓRIA / DISCO</span></div>${hostServices}${projectRows || '<p class="vps-health-muted">Nenhum container em execução.</p>'}${stoppedDetails}`;
  }

  const storageLabels = { Images: 'Imagens', Containers: 'Containers', 'Local Volumes': 'Volumes', 'Build Cache': 'Cache de build' };
  storageList.innerHTML = (data.dockerStorage || []).map((item) => `<div><span>${escapeHtml(storageLabels[item.type] || item.type)}</span><strong>${escapeHtml(item.size)}${item.reclaimable ? `<small>${escapeHtml(item.reclaimable)} reclamável</small>` : ''}</strong></div>`).join('') || '<small>Resumo Docker indisponível.</small>';
  $('#vpsVolumeStorage').innerHTML = (data.dockerVolumes || []).map((volume) => `<div><span>${escapeHtml(volume.name)}${volume.project ? `<small>${escapeHtml(volume.project)}</small>` : '<small>sem instância atribuída</small>'}</span><strong>${escapeHtml(volume.size)}</strong></div>`).join('') || '<small>Nenhum volume local.</small>';
  const storageLocations = [...(data.storageLocations || []), ...(data.projectDirectories || []).map((location) => ({ ...location, name: `Código · ${location.project}` }))];
  $('#vpsStorageLocations').innerHTML = storageLocations.map((location) => `<div><span>${escapeHtml(location.name)}<small>${escapeHtml(location.path)}</small></span><strong>${escapeHtml(formatBytes(location.bytes))}</strong></div>`).join('') || '<small>Pastas principais indisponíveis.</small>';
  const checked = new Date(data.checkedAt);
  $('#vpsHealthUpdated').textContent = `Atualizado ${checked.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · atualiza a cada minuto`;
}

async function refreshVpsHealth(force = false) {
  if (vpsHealthRequest) return vpsHealthRequest;
  const button = $('#refreshVpsHealth');
  button?.classList.add('spinning');
  vpsHealthRequest = api(`/api/server-health${force ? '?refresh=true' : ''}`)
    .then(renderVpsHealth)
    .catch((error) => {
      $('#vpsHostMetrics').innerHTML = '<p class="vps-health-error">Não foi possível ler as métricas.</p>';
      $('#vpsProjectList').innerHTML = `<p class="vps-health-error">${escapeHtml(error.message)}</p>`;
      $('#vpsHealthUpdated').textContent = 'Atualização indisponível';
    })
    .finally(() => { button?.classList.remove('spinning'); vpsHealthRequest = null; });
  return vpsHealthRequest;
}

function updateRunningClock() {
  if (!state.busy) return;
  const elapsed = state.turnStartedAtMs ? Date.now() - state.turnStartedAtMs : 0;
  $('#runningText').textContent = elapsed > 0 ? `Codex trabalhando há ${formatDuration(elapsed)}` : 'Codex está trabalhando…';
  for (const group of state.turnIntermediates.values()) {
    if (group.turnId === (state.activeTurnId || 'active') && group.durationMs == null) updateTurnIntermediateTitle(group);
  }
}

function updateComposerControls() {
  const hasDraft = Boolean($('#messageInput')?.value.trim() || state.files.length);
  const send = $('#sendButton');
  const modelSelect = $('#modelSelect');
  const effortSelect = $('#effortSelect');
  if (modelSelect) modelSelect.disabled = !state.models.length;
  if (effortSelect) effortSelect.disabled = !getSelectedModel()?.supportedReasoningEfforts?.length;
  if (send) {
    send.title = state.busy ? 'Adicionar mensagem à fila' : 'Enviar mensagem';
    send.setAttribute('aria-label', state.busy ? 'Adicionar mensagem à fila' : 'Enviar mensagem');
    send.disabled = state.sending || voice.phase !== 'idle' || !hasDraft;
    $('#sendLabel').textContent = state.sending ? 'Enviando…' : state.busy ? 'Fila' : 'Enviar';
    send.classList.toggle('queue-mode', state.busy);
  }
  if ($('#attachImage')) $('#attachImage').disabled = state.sending;
  if ($('#steerButton')) {
    $('#steerButton').classList.toggle('hidden', !state.busy || !state.selectedThreadId);
    $('#steerButton').disabled = state.sending || voice.phase !== 'idle' || !hasDraft;
  }
  if ($('#stopTurn')) {
    $('#stopTurn').classList.toggle('hidden', !state.busy || !state.selectedThreadId);
    $('#stopTurn').disabled = state.interrupting;
    $('.stop-button-label', $('#stopTurn')).textContent = state.interrupting ? 'Parando…' : 'Parar';
  }
  if ($('#composerHint')) $('#composerHint').textContent = voice.phase === 'recording'
    ? 'Gravando · até 3 minutos'
    : state.busy ? 'Em execução · sua próxima mensagem entra na fila'
    : touchComposer() ? 'Escreva ou grave sua mensagem' : 'Enter envia · Shift+Enter cria uma linha';
  if ($('#composerFootnote')) $('#composerFootnote').textContent = voice.phase === 'ready' ? 'O áudio fica aqui até você transcrever ou descartar.' : voice.phase === 'transcribing' ? 'O áudio é processado na VPS. Ao terminar, revise o texto antes de enviar.' : state.busy ? 'Use Orientar agora para enviar uma instrução à execução atual.' : 'Grave, transcreva e revise antes de enviar.';

}

function setBusy(busy, detail = '') {
  state.busy = Boolean(busy);
  $('#runningIndicator').classList.toggle('hidden', !state.busy);
  if (detail) $('#runningText').textContent = detail;
  if (state.busy) {
    if (!state.turnStartedAtMs) state.turnStartedAtMs = Date.now();
    updateRunningClock();
    if (!state.turnTimer) state.turnTimer = setInterval(updateRunningClock, 1000);
  } else {
    state.turnStartedAtMs = null;
    clearInterval(state.turnTimer);
    state.turnTimer = null;
  }
  for (const group of state.turnIntermediates.values()) {
    const isActiveGroup = group.turnId === (state.activeTurnId || 'active');
    group.card.open = state.busy && isActiveGroup;
    updateTurnIntermediateTitle(group);
  }
  for (const group of state.reasoningGroups.values()) updateReasoningGroup(group);
  updateComposerControls();
}

function makeAvatar() {
  return '<div class="message-avatar" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M16 3.2 27.1 9.6v12.8L16 28.8 4.9 22.4V9.6L16 3.2Z"/><path d="m11.2 11.2 4.8 4.8-4.8 4.8M20.8 11.2 16 16l4.8 4.8"/></svg></div>';
}

function openImagePreview(src, caption = 'Imagem anexada') {
  if (!src) return;
  $('#imagePreviewImage').src = src;
  $('#imagePreviewImage').alt = caption;
  $('#imagePreviewCaption').textContent = caption;
  $('#imagePreviewDialog').showModal();
}

function makeMessage(role, { text = '', images = [], time = null, id = '', turnId = '', phase = '', finalAnswer = true, parent = null } = {}) {
  $('#welcome').classList.add('hidden');
  const row = document.createElement('article');
  row.className = `message ${role}`;
  if (id) row.dataset.itemId = id;
  if (turnId) row.dataset.turnId = turnId;
  if (role === 'assistant') {
    row.dataset.finalAnswer = finalAnswer ? 'true' : 'false';
    if (phase) row.dataset.phase = phase;
  }
  if (role === 'assistant') row.innerHTML = `${makeAvatar()}<div class="message-body"><div class="assistant-label">Codex</div><div class="message-content"></div><div class="message-meta"></div></div>`;
  else row.innerHTML = '<div class="message-body"><div class="message-content"></div><div class="message-images"></div><div class="message-meta"></div></div>';
  if (role === 'assistant') $('.message-content', row).innerHTML = markdown(text);
  else $('.message-content', row).textContent = text;
  const imageBox = $('.message-images', row);
  for (const image of images) {
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'message-image-open';
    preview.title = 'Abrir imagem em tamanho maior';
    preview.setAttribute('aria-label', `Ampliar ${image.name || 'imagem anexada'}`);
    const img = document.createElement('img');
    img.alt = image.name || 'Imagem anexada';
    if (image.url) img.src = image.url;
    else if (image.dataUrl) img.src = image.dataUrl;
    else img.alt = 'Imagem anexada';
    preview.addEventListener('click', () => openImagePreview(img.currentSrc || img.src, img.alt));
    preview.append(img);
    imageBox?.append(preview);
  }
  if (imageBox && !imageBox.children.length) imageBox.remove();
  if (time) $('.message-meta', row).textContent = time;
  (parent || $('#messages')).append(row);
  scrollConversation();
  return row;
}

function scrollConversation(force = false) {
  const area = $('#messages');
  if (force) {
    state.followLatest = true;
    $('#scrollToLatest')?.classList.add('hidden');
  }
  if (!state.followLatest) return;
  requestAnimationFrame(() => {
    if (state.followLatest) area.scrollTop = area.scrollHeight;
  });
}

function imageFromContent(content, threadId) {
  const images = [];
  for (const part of content || []) {
    if (part.type === 'image' && part.url) images.push({ url: part.url, name: 'Imagem' });
    if (part.type === 'localImage' && part.path) {
      const name = String(part.path).split('/').pop();
      images.push({ url: `${PREFIX}/api/images/${encodeURIComponent(threadId)}/${encodeURIComponent(name)}`, name: 'Imagem enviada' });
    }
  }
  return images;
}

function isFinalAgentMessage(item) {
  const phase = String(item?.phase || '').toLowerCase().replace(/[\s-]/g, '_');
  return !phase || phase === 'final_answer' || phase === 'finalanswer' || phase === 'final';
}

function updateTurnIntermediateTitle(group) {
  const isLive = state.busy && group.turnId === (state.activeTurnId || 'active');
  const elapsed = group.durationMs ?? (isLive && state.turnStartedAtMs ? Date.now() - state.turnStartedAtMs : 0);
  group.card.classList.toggle('is-live', isLive);
  group.title.textContent = isLive
    ? (elapsed > 0 ? `Em andamento · ${formatDuration(elapsed)}` : 'Progresso em andamento')
    : (elapsed > 0 ? `Trabalhou por ${formatDuration(elapsed)}` : 'Atividades intermediárias');
  group.hint.textContent = group.card.open ? 'Recolher' : 'Ver detalhes';
}

function ensureTurnIntermediates(turnId, append = true) {
  const normalizedTurnId = turnId || state.activeTurnId || 'active';
  const groupKey = `${state.selectedThreadId}:${normalizedTurnId}`;
  let group = state.turnIntermediates.get(groupKey);
  if (group) return group;

  const card = document.createElement('details');
  card.className = 'activity-card turn-intermediates';
  card.open = state.busy && normalizedTurnId === (state.activeTurnId || 'active');
  const heading = document.createElement('summary');
  heading.className = 'activity-heading';
  const icon = document.createElement('span'); icon.className = 'icon';
  icon.innerHTML = `<svg viewBox="0 0 24 24">${icons.bolt}</svg>`;
  const title = document.createElement('span'); title.className = 'turn-intermediates-title';
  const hint = document.createElement('span'); hint.className = 'turn-intermediates-hint';
  const content = document.createElement('div'); content.className = 'turn-intermediate-content';
  heading.append(icon, title, hint); card.append(heading, content);
  card.addEventListener('toggle', () => updateTurnIntermediateTitle(group));
  group = { card, title, hint, content, items: new Set(), turnId: normalizedTurnId, durationMs: null };
  state.turnIntermediates.set(groupKey, group);

  const finalAnswer = normalizedTurnId === 'active' ? null : $$('.message.assistant', $('#messages')).find((message) => message.dataset.turnId === normalizedTurnId && message.dataset.finalAnswer === 'true');
  if (finalAnswer) $('#messages').insertBefore(card, finalAnswer);
  else if (append) $('#messages').append(card);
  updateTurnIntermediateTitle(group);
  return group;
}

function registerIntermediate(turnId, itemId, append = true) {
  const group = ensureTurnIntermediates(turnId, append);
  group.items.add(String(itemId || `item-${group.items.size + 1}`));
  updateTurnIntermediateTitle(group);
  return group;
}

function renderCommandActivity(item, append, turnId) {
  const key = `${state.selectedThreadId}:${item.id}`;
  const turnGroup = registerIntermediate(turnId, `command:${item.id}`, append);
  const groupKey = `${state.selectedThreadId}:${turnGroup.turnId}`;
  let group = state.commandGroups.get(groupKey);
  if (!group) {
    const card = document.createElement('details');
    card.className = 'activity-card command-group';
    const heading = document.createElement('summary');
    heading.className = 'activity-heading';
    const icon = document.createElement('span'); icon.className = 'icon';
    icon.innerHTML = `<svg viewBox="0 0 24 24">${icons.terminal}</svg>`;
    const title = document.createElement('span');
    const hint = document.createElement('span'); hint.className = 'command-group-hint'; hint.textContent = 'Ver detalhes';
    const content = document.createElement('div'); content.className = 'command-list';
    heading.append(icon, title, hint); card.append(heading, content);
    card.addEventListener('toggle', () => { hint.textContent = card.open ? 'Recolher' : 'Ver detalhes'; });
    group = { card, title, content, items: new Map() };
    state.commandGroups.set(groupKey, group);
    if (append) turnGroup.content.append(card);
  }
  let entry = state.activityCards.get(key);
  if (!entry) {
    entry = document.createElement('div'); entry.className = 'command-entry';
    const command = document.createElement('code'); command.className = 'command-name';
    const output = document.createElement('pre'); output.className = 'activity-output hidden';
    entry.append(command, output); group.content.append(entry);
    state.activityCards.set(key, entry);
  }
  const command = $('.command-name', entry);
  const output = $('.activity-output', entry);
  command.textContent = item.command || 'Comando';
  if (item.aggregatedOutput) output.textContent = item.aggregatedOutput;
  output.classList.toggle('hidden', !output.textContent);
  group.items.set(key, item.status || 'inProgress');
  const statuses = [...group.items.values()];
  const running = statuses.some((status) => ['inProgress', 'running', 'pending'].includes(status));
  const failed = statuses.filter((status) => status === 'failed').length;
  group.card.open = state.busy && turnGroup.turnId === (state.activeTurnId || 'active');
  group.title.textContent = `${running ? 'Comandos em execução' : 'Comandos executados'} · ${statuses.length}${failed ? ` · ${failed} falhou${failed > 1 ? 'ram' : ''}` : ''}`;
  if (append) scrollConversation();
  return entry;
}

function ensureReasoningGroup(turnId, append = true, itemId = '') {
  const turnGroup = registerIntermediate(turnId, `reasoning:${itemId || 'summary'}`, append);
  const normalizedTurnId = turnGroup.turnId;
  const groupKey = `${state.selectedThreadId}:${normalizedTurnId}`;
  let group = state.reasoningGroups.get(groupKey);
  if (group) return group;

  const card = document.createElement('div');
  card.className = 'activity-card reasoning-group';
  const heading = document.createElement('div');
  heading.className = 'activity-heading';
  const icon = document.createElement('span'); icon.className = 'icon';
  icon.innerHTML = `<svg viewBox="0 0 24 24">${icons.bolt}</svg>`;
  const title = document.createElement('span'); title.className = 'reasoning-group-title';
  const content = document.createElement('div'); content.className = 'reasoning-steps';
  heading.append(icon, title); card.append(heading, content);
  group = { card, title, content, parts: new Map(), turnId: normalizedTurnId };
  state.reasoningGroups.set(groupKey, group);
  if (append) turnGroup.content.append(card);
  updateReasoningGroup(group);
  return group;
}

function updateReasoningGroup(group) {
  const visibleParts = [...group.parts.values()].filter((part) => part.text.trim());
  visibleParts.forEach((part, index) => {
    part.number.textContent = `Etapa ${index + 1}`;
    part.row.hidden = false;
    part.body.innerHTML = markdown(part.text);
  });
  for (const part of group.parts.values()) {
    if (!part.text.trim()) part.row.hidden = true;
  }
  group.card.hidden = visibleParts.length === 0;
  group.title.textContent = `Resumo do raciocínio · ${visibleParts.length} ${visibleParts.length === 1 ? 'etapa' : 'etapas'}`;
}

function setReasoningPart({ itemId, summaryIndex = 0, turnId = '', text = '', delta = false, append = true }) {
  const group = ensureReasoningGroup(turnId, append, itemId);
  const partKey = `${itemId || 'reasoning'}:${Number(summaryIndex) || 0}`;
  let part = group.parts.get(partKey);
  if (!part) {
    const row = document.createElement('section'); row.className = 'reasoning-step'; row.hidden = true;
    const number = document.createElement('span'); number.className = 'reasoning-step-number';
    const body = document.createElement('div'); body.className = 'reasoning-step-content';
    row.append(number, body); group.content.append(row);
    part = { row, number, body, text: '' };
    group.parts.set(partKey, part);
  }
  part.text = delta ? part.text + String(text || '') : String(text || '');
  updateReasoningGroup(group);
  return group;
}

function renderReasoningSummary(item, turnId = '', append = true) {
  const summary = Array.isArray(item.summary) ? item.summary : (typeof item.summary === 'string' ? [item.summary] : []);
  let rendered = false;
  summary.forEach((part, index) => {
    const text = typeof part === 'string' ? part : (typeof part?.text === 'string' ? part.text : '');
    if (!text.trim()) return;
    setReasoningPart({ itemId: item.id, summaryIndex: index, turnId, text, append });
    rendered = true;
  });
  return rendered;
}

function renderActivity(item, append = false, turnId = '') {
  if (item.type === 'commandExecution') return renderCommandActivity(item, append, turnId);
  const key = `${state.selectedThreadId}:${item.id}`;
  const turnGroup = registerIntermediate(turnId, `activity:${item.id || item.type}`, append);
  let card = state.activityCards.get(key);
  if (!card) {
    card = document.createElement('div');
    card.className = 'activity-card';
    const heading = document.createElement('div');
    heading.className = 'activity-heading';
    const icon = document.createElement('span'); icon.className = 'icon';
    const title = document.createElement('span');
    const output = document.createElement('pre'); output.className = 'activity-output hidden';
    heading.append(icon, title); card.append(heading, output);
    state.activityCards.set(key, card);
    if (append) turnGroup.content.append(card);
  }
  const headingIcon = $('.icon', card);
  const headingText = $('.activity-heading span:last-child', card);
  const output = $('.activity-output', card);
  if (item.type === 'fileChange') {
    headingIcon.innerHTML = `<svg viewBox="0 0 24 24">${icons.folder}</svg>`;
    const files = (item.changes || []).map((change) => change.path).filter(Boolean);
    headingText.textContent = item.status === 'completed' ? `Alterações aplicadas · ${files.length || 1} arquivo(s)` : `Alterações em arquivos · ${files.join(', ') || 'em andamento'}`;
    const diff = (item.changes || []).map((change) => `--- ${change.path}\n${change.diff || ''}`).join('\n');
    if (diff) output.textContent = diff;
  } else if (item.type === 'webSearch') {
    headingIcon.innerHTML = `<svg viewBox="0 0 24 24">${icons.search}</svg>`;
    headingText.textContent = `Busca na web${item.query ? ` · ${item.query}` : ''}`;
  } else if (item.type === 'collabToolCall') {
    headingIcon.innerHTML = `<svg viewBox="0 0 24 24">${icons.bolt}</svg>`;
    const normalize = (value) => String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    const tool = normalize(item.tool);
    const status = normalize(item.status);
    const states = item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates : {};
    const agentRefs = Array.isArray(item.receiverAgents) ? item.receiverAgents : [];
    const agentIds = [...new Set([...agentRefs.map((agent) => agent.threadId), ...Object.keys(states), ...(item.receiverThreadIds || [])].filter(Boolean))];
    const hasRunningAgent = Object.values(states).some((agent) => ['running', 'pending init'].includes(normalize(agent?.status)));
    const isFailed = status === 'failed' || Object.values(states).some((agent) => ['errored', 'not found'].includes(normalize(agent?.status)));
    const action = tool === 'spawn agent' ? 'delegou uma tarefa' : tool === 'wait' ? 'aguardou o trabalho' : tool === 'send input' ? 'enviou uma orientação' : tool === 'resume agent' ? 'retomou um agente' : tool === 'close agent' ? 'encerrou um agente' : tool === 'interrupt agent' ? 'interrompeu um agente' : tool === 'list agents' ? 'consultou os agentes' : 'coordenou agentes';
    const result = isFailed ? 'com falha' : status === 'interrupted' ? 'interrompido' : (status === 'in progress' || hasRunningAgent) ? 'em andamento' : 'concluído';
    const agentStatusLabels = { 'pending init': 'iniciando', running: 'trabalhando', interrupted: 'interrompido', completed: 'concluiu', errored: 'falhou', shutdown: 'encerrado', 'not found': 'indisponível' };
    const countLabel = agentIds.length ? ` · ${agentIds.length} agente${agentIds.length === 1 ? '' : 's'}` : '';
    headingText.textContent = `Agentes auxiliares · ${action}${countLabel} · ${result}`;
    const details = [];
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';
    if (prompt) details.push(`Tarefa: ${prompt.slice(0, 500)}${prompt.length > 500 ? '…' : ''}`);
    for (const agentId of agentIds) {
      const ref = agentRefs.find((agent) => agent.threadId === agentId);
      const identity = [ref?.agentNickname, ref?.agentRole].filter(Boolean).join(' · ') || `Agente ${String(agentId).slice(0, 8)}`;
      const agentState = states[agentId];
      const agentStatus = normalize(agentState?.status);
      const stateLabel = agentStatus ? ` — ${agentStatusLabels[agentStatus] || agentStatus}` : '';
      const message = typeof agentState?.message === 'string' ? `: ${agentState.message.slice(0, 180)}` : '';
      details.push(`${identity}${stateLabel}${message}`);
    }
    if (details.length) output.textContent = details.join('\n');
  } else {
    headingIcon.innerHTML = `<svg viewBox="0 0 24 24">${icons.bolt}</svg>`;
    headingText.textContent = item.type === 'mcpToolCall' ? `Ferramenta · ${item.tool || 'MCP'}` : item.type === 'plan' ? 'Plano de trabalho' : item.type || 'Atividade';
    if (item.text || item.result || item.error) output.textContent = item.text || item.result || item.error;
  }
  if (output.textContent) output.classList.remove('hidden');
  if (append) scrollConversation();
  return card;
}

function renderTurnHistory(turns, threadId) {
  const sameThread = $('#messages').dataset.threadId === threadId;
  const previousScrollTop = $('#messages').scrollTop;
  if (!sameThread) state.followLatest = true;
  $('#messages').dataset.threadId = threadId;
  state.streamedMessages.clear();
  state.activityCards.clear();
  state.commandGroups.clear();
  state.reasoningGroups.clear();
  state.turnIntermediates.clear();
  state.userMessageIds.clear();
  state.activeTurnId = null;
  $('#messages').replaceChildren();
  let count = 0;
  for (const turn of turns || []) {
    const items = turn.items || [];
    let lastFinalIndex = -1;
    let lastAgentIndex = -1;
    items.forEach((item, index) => {
      if (item.type !== 'agentMessage') return;
      lastAgentIndex = index;
      if (isFinalAgentMessage(item)) lastFinalIndex = index;
    });
    const visibleAnswerIndex = lastFinalIndex >= 0 ? lastFinalIndex : lastAgentIndex;
    let lastAssistant = null;
    items.forEach((item, index) => {
      if (item.type === 'userMessage') {
        const text = (item.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        const images = imageFromContent(item.content, threadId);
        if (text || images.length) {
          if (item.id) state.userMessageIds.add(item.id);
          makeMessage('user', { text, images, id: item.id }); count++;
        }
      } else if (item.type === 'agentMessage') {
        if (item.text) {
          const finalAnswer = index === visibleAnswerIndex;
          if (finalAnswer) {
            lastAssistant = makeMessage('assistant', { text: item.text, id: item.id, turnId: turn.id, phase: item.phase, finalAnswer: true });
          } else {
            const group = registerIntermediate(turn.id, `message:${item.id || index}`, true);
            makeMessage('assistant', { text: item.text, id: item.id, turnId: turn.id, phase: item.phase, finalAnswer: false, parent: group.content });
          }
          count++;
        }
      } else if (item.type === 'reasoning') {
        if (renderReasoningSummary(item, turn.id, true)) count++;
      } else if (['commandExecution', 'fileChange', 'webSearch', 'mcpToolCall', 'collabToolCall', 'plan'].includes(item.type)) {
        renderActivity(item, true, turn.id); count++;
      }
    });
    const durationMs = Number(turn.durationMs) || (turn.startedAt && turn.completedAt ? (Number(turn.completedAt) - Number(turn.startedAt)) * 1000 : 0);
    const group = state.turnIntermediates.get(`${threadId}:${turn.id}`);
    if (group && durationMs > 0) { group.durationMs = durationMs; updateTurnIntermediateTitle(group); }
    else if (lastAssistant && durationMs > 0) $('.message-meta', lastAssistant).textContent = `Trabalhou por ${formatDuration(durationMs)}`;
  }
  $('#welcome').classList.toggle('hidden', count > 0);
  if (sameThread && !state.followLatest) $('#messages').scrollTop = previousScrollTop;
  else scrollConversation(true);
}

function getOrCreateStreamMessage(itemId, turnId = '', phase = '') {
  const key = `${state.selectedThreadId}:${itemId}`;
  let message = state.streamedMessages.get(key);
  if (!message) {
    const normalizedTurnId = turnId || state.activeTurnId || '';
    const finalAnswer = isFinalAgentMessage({ phase });
    const group = finalAnswer ? null : registerIntermediate(normalizedTurnId, `message:${itemId}`, true);
    const row = makeMessage('assistant', { id: itemId, turnId: normalizedTurnId, phase, finalAnswer, parent: group?.content || null });
    message = { row, text: '', phase, turnId: normalizedTurnId, finalAnswer };
    state.streamedMessages.set(key, message);
  }
  return message;
}

function placeStreamMessage(stream, phase) {
  if (phase) stream.phase = phase;
  const finalAnswer = isFinalAgentMessage({ phase: stream.phase });
  const target = finalAnswer ? $('#messages') : registerIntermediate(stream.turnId, `message:${stream.row.dataset.itemId}`, true).content;
  if (stream.row.parentElement !== target) target.append(stream.row);
  stream.finalAnswer = finalAnswer;
  stream.row.dataset.finalAnswer = finalAnswer ? 'true' : 'false';
  if (stream.phase) stream.row.dataset.phase = stream.phase;
  return stream;
}

function addApproval(request) {
  const threadId = request.params?.threadId;
  const requestId = String(request.id);
  state.pendingApprovals.set(requestId, request);
  if (threadId !== state.selectedThreadId) return;
  $('#welcome').classList.add('hidden');
  const card = document.createElement('div');
  card.className = 'activity-card approval-card';
  card.dataset.requestId = requestId;
  const command = request.params?.command || request.params?.commandActions?.map((action) => action.command).filter(Boolean).join('\n') || '';
  const reason = request.params?.reason || 'O Codex precisa da sua decisão para continuar.';
  card.innerHTML = `<div class="activity-heading"><span class="icon"><svg viewBox="0 0 24 24">${icons.shield}</svg></span><span>Confirmação necessária</span></div><div class="approval-reason"></div>${command ? '<pre class="approval-command"></pre>' : ''}<div class="approval-actions"><button class="approve" data-decision="accept">Permitir agora</button><button data-decision="acceptForSession">Permitir nesta sessão</button><button data-decision="decline">Recusar</button></div>`;
  $('.approval-reason', card).textContent = reason;
  if (command) $('.approval-command', card).textContent = command;
  $$('.approval-actions button', card).forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/api/threads/${encodeURIComponent(threadId)}/approval`, { method: 'POST', body: JSON.stringify({ requestId, decision: button.dataset.decision }) });
      card.remove(); state.pendingApprovals.delete(requestId);
      toast(button.dataset.decision.startsWith('accept') ? 'Aprovação enviada.' : 'Solicitação recusada.');
    } catch (error) { button.disabled = false; toast(error.message, 'error'); }
  }));
  $('#messages').append(card);
  scrollConversation();
}

function handleCodexNotification(message) {
  const params = message.params || {};
  const eventThreadId = params.threadId || params.turn?.threadId;
  if (eventThreadId && message.method === 'turn/started') {
    state.activeThreadIds.add(eventThreadId);
    renderThreads(state.threads, $('#threadSearch').value.trim());
  } else if (eventThreadId && message.method === 'thread/status/changed') {
    if (params.status?.type === 'active') state.activeThreadIds.add(eventThreadId);
    else state.activeThreadIds.delete(eventThreadId);
    renderThreads(state.threads, $('#threadSearch').value.trim());
  }
  if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
    addApproval({ id: params.requestId ?? params.itemId ?? randomKey(), method: message.method, params, serverRequestId: params.requestId });
    return;
  }
  if (message.method === 'thread/status/changed' && eventThreadId === state.selectedThreadId) {
    setBusy(params.status?.type === 'active');
  }
  if (eventThreadId && eventThreadId !== state.selectedThreadId) return;
  if (message.method === 'turn/started') {
    state.turnStartedAtMs = params.turn?.startedAt ? Number(params.turn.startedAt) * 1000 : Date.now();
    state.activeTurnId = params.turn?.id || null;
    setBusy(true);
    return;
  }
  if (message.method === 'item/reasoning/summaryPartAdded') {
    const itemId = params.itemId || params.item?.id;
    if (itemId) setReasoningPart({ itemId, summaryIndex: params.summaryIndex, turnId: params.turnId, text: '', append: true });
    return;
  }
  if (message.method === 'item/reasoning/summaryTextDelta') {
    const itemId = params.itemId || params.item?.id;
    if (itemId) setReasoningPart({ itemId, summaryIndex: params.summaryIndex, turnId: params.turnId, text: params.delta || '', delta: true, append: true });
    return;
  }
  // Raw reasoning text deltas are intentionally ignored; only user-facing summary events are rendered.
  if (message.method === 'item/agentMessage/delta') {
    const itemId = params.itemId || params.item?.id;
    if (!itemId) return;
    const stream = getOrCreateStreamMessage(itemId, params.turnId, params.phase || params.item?.phase || '');
    stream.text += params.delta || '';
    $('.message-content', stream.row).innerHTML = markdown(stream.text);
    scrollConversation();
    return;
  }
  if (message.method === 'item/commandExecution/outputDelta') {
    const itemId = params.itemId || params.item?.id;
    if (!itemId) return;
    const key = `${state.selectedThreadId}:${itemId}`;
    const card = state.activityCards.get(key) || renderActivity({ id: itemId, type: 'commandExecution', command: params.command, status: 'inProgress' }, true, params.turnId);
    const output = $('.activity-output', card);
    output.textContent += params.delta || '';
    output.classList.remove('hidden');
    scrollConversation();
    return;
  }
  if (message.method === 'item/started' || message.method === 'item/completed') {
    const item = params.item;
    if (!item) return;
    if (item.type === 'agentMessage') {
      const key = `${state.selectedThreadId}:${item.id}`;
      let stream = state.streamedMessages.get(key);
      if (!stream) stream = getOrCreateStreamMessage(item.id, params.turnId);
      stream.turnId = params.turnId || stream.turnId;
      placeStreamMessage(stream, item.phase);
      if (item.text) stream.text = item.text;
      $('.message-content', stream.row).innerHTML = markdown(stream.text);
    } else if (item.type === 'reasoning') {
      renderReasoningSummary(item, params.turnId, true);
    } else if (item.type === 'userMessage' && message.method === 'item/started') {
      if (!item.id || !state.userMessageIds.has(item.id)) {
        const text = (item.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        const images = imageFromContent(item.content, state.selectedThreadId);
        if (item.id) state.userMessageIds.add(item.id);
        if (text || images.length) makeMessage('user', { text, images, id: item.id });
      }
    } else if (item.type === 'userMessage') {
      // The user message was rendered when its item started.
    } else {
      renderActivity(item, true, params.turnId);
    }
    return;
  }
  if (message.method === 'turn/plan/updated') {
    const plan = params.plan || [];
    const text = plan.map((step) => `${step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '→' : '·'} ${step.step}`).join('\n');
    renderActivity({ id: `plan-${params.turnId || 'active'}`, type: 'plan', text }, true, params.turnId);
    return;
  }
  if (message.method === 'thread/tokenUsage/updated') {
    $('#threadMeta').dataset.usage = JSON.stringify(params.tokenUsage || params);
    return;
  }
  if (message.method === 'error') {
    toast(params.error?.message || 'Ocorreu um erro no turno.', 'error');
  }
}

function randomKey() { return `request-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function connectEvents() {
  const events = new EventSource(`${PREFIX}/api/events`, { withCredentials: true });
  events.onopen = () => setConnection(true, 'Codex conectado');
  events.onerror = () => setConnection(false, 'Reconectando ao Codex…');
  events.onmessage = (raw) => {
    let event; try { event = JSON.parse(raw.data); } catch { return; }
    if (event.type === 'server-state') setConnection(Boolean(event.data.online), event.data.message);
    else if (event.type === 'codex-event') handleCodexNotification(event.data);
    else if (event.type === 'server-request') addApproval(event.data);
    else if (event.type === 'request-resolved') state.pendingApprovals.delete(event.data.requestId);
    else if (event.type === 'account-data') { state.account = event.data.account; state.rateLimits = event.data.rateLimits; state.usage = event.data.usage; renderUsage(); }
    else if (event.type === 'thread-usage') {
      const usage = event.data.tokenUsage || event.data;
      const tokenText = usage.total?.totalTokens ?? usage.totalTokens ?? usage.total?.inputTokens;
      if (tokenText != null) $('#threadMeta').dataset.tokens = String(tokenText);
      if (event.data.threadId === state.selectedThreadId) {
        state.contextUsage = { tokenUsage: usage, updatedAt: event.at || new Date().toISOString() };
        renderContextUsage(state.contextUsage);
      }
    }
    else if (event.type === 'thread-queue-changed') {
      if (event.data.threadId === state.selectedThreadId) refreshQueue(state.selectedThreadId).catch((error) => toast(error.message, 'error'));
    }
    else if (event.type === 'turn-accepted') {
      const isNew = !state.selectedThreadId;
      state.selectedThreadId = event.data.threadId;
      state.activeThreadIds.add(event.data.threadId);
      if (isNew) state.activeThreadProjectId = state.selectedProjectId;
      setBusy(true);
      if (isNew) updateThreadHeader({ id: event.data.threadId, name: 'Nova conversa', model: event.data.model, status: { type: 'active' } });
    }
    else if (event.type === 'thread-created') {
      state.selectedThreadId = event.data.thread.id;
      state.activeThreadProjectId = state.selectedProjectId;
      associateThreadWithSelectedProject(event.data.thread.id);
      renderConversationContext();
    }
    else if (event.type === 'turn-completed') {
      if (event.data.threadId) {
        state.activeThreadIds.delete(event.data.threadId);
        renderThreads(state.threads, $('#threadSearch').value.trim());
      }
      if (event.data.threadId === state.selectedThreadId) {
        const turnId = event.data.turn?.id;
        const group = turnId ? state.turnIntermediates.get(`${event.data.threadId}:${turnId}`) : null;
        if (group) group.durationMs = Number(event.data.turn?.durationMs) || (state.turnStartedAtMs ? Date.now() - state.turnStartedAtMs : 0);
        setBusy(false);
        if (group) { group.card.open = false; updateTurnIntermediateTitle(group); }
        state.activeTurnId = null;
        loadThreadHistory(state.selectedThreadId).catch(() => {});
      }
      refreshThreadList().catch(() => {});
      refreshUsage().catch(() => {});
    }
  };
}

async function refreshThreadList(query = $('#threadSearch')?.value.trim() || '') {
  const requestId = ++state.threadListRequest;
  const params = new URLSearchParams();
  if (query) params.set('search', query);
  if (state.archivedView) params.set('archived', 'true');
  const data = await api(`/api/threads${params.size ? `?${params}` : ''}`);
  if (requestId !== state.threadListRequest) return;
  renderThreads(data.threads || [], query);
}

async function refreshUsage(force = true) {
  const data = await api(`/api/bootstrap${force ? '?refresh=true' : ''}`);
  state.account = data.account;
  state.rateLimits = data.rateLimits;
  state.usage = data.usage;
  renderUsage();
}

async function bootstrap() {
  try {
    const data = await api('/api/bootstrap');
    state.models = data.models || [];
    state.account = data.account;
    state.rateLimits = data.rateLimits;
    state.usage = data.usage;
    state.threads = data.threads || [];
    state.activeThreadIds = new Set(state.threads.filter((thread) => thread.status?.type === 'active').map((thread) => thread.id));
    state.projects = data.projects || [];
    state.defaultCwd = data.defaultCwd || '/';
    state.projectsRoot = data.projectsRoot || `${state.defaultCwd}/projects`;
    if (!state.projects.some((project) => project.id === state.selectedProjectId)) state.selectedProjectId = '';
    const startupProject = state.projects.find((project) => project.id === state.selectedProjectId);
    if (startupProject) updateWorkingDirectory(startupProject.cwd);
    else if (!state.cwd) updateWorkingDirectory(state.defaultCwd);
    (data.pending || []).forEach((request) => state.pendingApprovals.set(String(request.id), request));
    populateModels(); renderUsage(); renderProjects(); renderThreads(); setConnection(true, 'Codex conectado');
    if ($('#planBadge') && data.account?.planType) $('#planBadge').textContent = String(data.account.planType).replace(/^./, (char) => char.toUpperCase());
    const threadId = new URLSearchParams(location.hash.slice(1)).get('thread');
    if (threadId) await openThread(threadId);
  } catch (error) {
    setConnection(false, 'Codex indisponível');
    toast(error.message, 'error');
  }
}

async function loadThreadHistory(threadId) {
  const data = await api(`/api/threads/${encodeURIComponent(threadId)}/history`);
  if (state.selectedThreadId !== threadId) return null;
  state.selectedThreadId = threadId;
  const row = state.threads.find((item) => item.id === threadId);
  const thread = data.thread || { id: threadId };
  if (!thread.name && !thread.preview && row) Object.assign(thread, { name: row.name, preview: row.preview });
  updateThreadHeader(thread);
  await loadContextUsage(threadId);
  renderTurnHistory(data.turns || [], threadId);
  const active = data.thread?.status?.type === 'active';
  if (active) state.activeThreadIds.add(threadId);
  else state.activeThreadIds.delete(threadId);
  renderThreads(state.threads, $('#threadSearch').value.trim());
  const activeTurn = [...(data.turns || [])].reverse().find((turn) => {
    const status = typeof turn.status === 'string' ? turn.status : turn.status?.type;
    return status === 'inProgress' || status === 'active';
  });
  state.turnStartedAtMs = activeTurn?.startedAt ? Number(activeTurn.startedAt) * 1000 : null;
  setBusy(active);
  refreshQueue(threadId).catch((error) => toast(error.message, 'error'));
  state.pendingApprovals.forEach((request) => { if (request.params?.threadId === threadId) addApproval(request); });
  if (window.innerWidth <= 680) closeSidebar();
  return data;
}

function showThreadLoading() {
  $('#welcome').classList.add('hidden');
  $('#messages').replaceChildren();
  const status = document.createElement('div');
  status.className = 'thread-load-state';
  status.setAttribute('role', 'status');
  status.innerHTML = '<span class="thread-load-spinner" aria-hidden="true"></span><span>Carregando o histórico da conversa…</span>';
  $('#messages').append(status);
}

function showThreadLoadError(threadId, error) {
  $('#welcome').classList.add('hidden');
  $('#messages').replaceChildren();
  const card = document.createElement('section');
  card.className = 'thread-load-error';
  const title = document.createElement('strong');
  title.textContent = 'Não foi possível abrir esta conversa.';
  const detail = document.createElement('p');
  detail.textContent = error?.message || 'Tente novamente em alguns instantes.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Tentar novamente';
  retry.addEventListener('click', () => openThread(threadId));
  card.append(title, detail, retry);
  $('#messages').append(card);
}

async function openThread(threadId) {
  if (!threadId || state.loadingThreadId === threadId) return;
  state.selectedThreadId = threadId;
  state.loadingThreadId = threadId;
  const summary = state.threads.find((item) => item.id === threadId);
  state.activeThreadProjectId = projectForThread(summary)?.id || '';
  state.queueItems = [];
  renderQueue();
  updateThreadHeader(summary || { id: threadId });
  renderThreads(state.threads, $('#threadSearch').value.trim());
  setBusy(false);
  showThreadLoading();
  try {
    await loadThreadHistory(threadId);
    if (state.selectedThreadId !== threadId) return;
    const thread = state.selectedThread || state.threads.find((item) => item.id === threadId);
    const project = projectForThread(thread);
    state.activeThreadProjectId = project?.id || '';
    const cwd = project?.cwd || thread?.cwd || thread?.workingDirectory || thread?.workspace?.cwd || state.defaultCwd;
    selectProject(project?.id || '', { folderPath: cwd, updateActiveThread: true });
  } catch (error) {
    if (state.selectedThreadId === threadId) {
      setBusy(false);
      showThreadLoadError(threadId, error);
      toast(error.message, 'error');
    }
  } finally {
    if (state.loadingThreadId === threadId) state.loadingThreadId = null;
  }
}

function newChat() {
  state.followLatest = true;
  state.selectedThreadId = null;
  state.selectedThread = null;
  state.activeThreadProjectId = '';
  state.loadingThreadId = null;
  state.streamedMessages.clear(); state.activityCards.clear(); state.commandGroups.clear(); state.reasoningGroups.clear(); state.turnIntermediates.clear(); state.userMessageIds.clear();
  state.activeTurnId = null;
  state.queueItems = []; renderQueue();
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  updateWorkingDirectory(project?.cwd || state.defaultCwd || state.cwd || '/');
  $('#messages').replaceChildren(); $('#welcome').classList.remove('hidden');
  setBusy(false); updateThreadHeader(null);
  if (window.innerWidth <= 680) closeSidebar();
  $('#messageInput').focus();
}

function renderAttachments() {
  const box = $('#attachmentStrip');
  box.replaceChildren();
  box.classList.toggle('hidden', !state.files.length);
  state.files.forEach((file, index) => {
    const tile = document.createElement('div'); tile.className = 'attachment-preview';
    const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'attachment-image-open'; preview.title = 'Ampliar imagem'; preview.setAttribute('aria-label', `Ampliar ${file.name}`);
    const image = document.createElement('img'); image.src = file.dataUrl; image.alt = file.name;
    preview.addEventListener('click', () => openImagePreview(image.src, file.name));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'attachment-remove'; remove.title = 'Remover imagem'; remove.innerHTML = `<span class="icon" data-icon="close"></span>`;
    remove.addEventListener('click', () => { state.files.splice(index, 1); renderAttachments(); });
    preview.append(image); tile.append(preview, remove); box.append(tile);
  });
  installIcons();
  updateComposerControls();
}

function queueItemLabel(item) {
  const text = (item.input || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
  const images = (item.input || []).filter((part) => part.type === 'image' || part.type === 'localImage').length;
  if (text && images) return `${text} · ${images} imagem${images === 1 ? '' : 's'}`;
  if (text) return text;
  return images ? `${images} imagem${images === 1 ? '' : 's'} anexada${images === 1 ? '' : 's'}` : 'Mensagem sem texto';
}

function renderQueue() {
  const panel = $('#queuePanel');
  const list = $('#queueList');
  if (!panel || !list) return;
  const threadId = state.selectedThreadId;
  const items = threadId ? state.queueItems : [];
  panel.classList.toggle('hidden', !items.length);
  $('#queueCount').textContent = items.length ? `${items.length} ${items.length === 1 ? 'mensagem' : 'mensagens'}` : '';
  list.replaceChildren();
  items.forEach((item, index) => {
    const row = document.createElement('div'); row.className = 'queued-item';
    const position = document.createElement('span'); position.className = 'queued-position'; position.textContent = String(index + 1);
    const text = document.createElement('span'); text.className = 'queued-text'; text.textContent = queueItemLabel(item);
    const imageParts = (item.input || []).filter((part) => part.type === 'image' || part.type === 'localImage');
    const imagePreviews = document.createElement('div'); imagePreviews.className = 'queued-image-previews';
    imageParts.forEach((part, imageIndex) => {
      let src = part.url || '';
      if (part.type === 'localImage' && part.path) {
        const name = String(part.path).split('/').pop();
        src = `${PREFIX}/api/images/${encodeURIComponent(threadId)}/${encodeURIComponent(name)}`;
      }
      if (!src) return;
      const imageButton = document.createElement('button'); imageButton.type = 'button'; imageButton.className = 'queued-image-open'; imageButton.title = 'Ampliar imagem da mensagem na fila'; imageButton.setAttribute('aria-label', `Ampliar imagem ${imageIndex + 1} da fila`);
      const image = document.createElement('img'); image.src = src; image.alt = `Imagem ${imageIndex + 1} da mensagem na fila`;
      imageButton.addEventListener('click', () => openImagePreview(image.currentSrc || image.src, image.alt));
      imageButton.append(image); imagePreviews.append(imageButton);
    });
    if (!imagePreviews.children.length) imagePreviews.remove();
    const actions = document.createElement('div'); actions.className = 'queued-actions';
    const steer = document.createElement('button'); steer.type = 'button'; steer.className = 'queue-action queue-steer'; steer.textContent = 'Orientar agora'; steer.title = 'Tirar da fila e enviar como orientação para a execução atual';
    steer.hidden = Boolean(item.localOnly);
    steer.addEventListener('click', async () => {
      steer.disabled = true;
      try {
        await api(`/api/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(item.id)}`, { method: 'POST' });
        toast('Mensagem enviada como orientação.');
        await refreshQueue(threadId);
      } catch (error) {
        toast(error.message, 'error');
        if (error.data?.recoverableItem) {
          const recovered = { ...error.data.recoverableItem, id: `local-recovery-${Date.now()}`, localOnly: true, threadId };
          state.recoveredQueueItems = [...state.recoveredQueueItems.filter((queued) => queued.id !== item.id), recovered];
          state.queueItems = [recovered, ...state.queueItems.filter((queued) => queued.id !== item.id)];
          renderQueue();
        } else refreshQueue(threadId).catch(() => {});
      }
      finally { steer.disabled = false; }
    });
    const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'queue-action queue-restore'; restore.textContent = 'Voltar ao rascunho'; restore.title = 'Tirar da fila e devolver ao campo de mensagem';
    restore.addEventListener('click', async () => {
      restore.disabled = true;
      try {
        await restoreQueueItem(item, threadId);
        toast('Mensagem devolvida ao rascunho.');
      } catch (error) { toast(error.message, 'error'); }
      finally { restore.disabled = false; }
    });
    actions.append(steer, restore);
    row.append(position, text);
    if (imagePreviews.isConnected || imagePreviews.children.length) row.append(imagePreviews);
    row.append(actions); list.append(row);
  });
  installIcons();
}

async function restoreQueueItem(item, threadId) {
  const input = Array.isArray(item.input) ? item.input : [];
  const text = input.filter((part) => part.type === 'text').map((part) => String(part.text || '')).join('\n');
  const imageParts = input.filter((part) => part.type === 'image' || part.type === 'localImage');
  const localImageParts = imageParts.filter((part) => part.type === 'localImage' && typeof part.path === 'string');
  if (imageParts.length !== localImageParts.length) throw new Error('Não consegui recuperar todas as imagens. A mensagem continua na fila.');
  if (state.files.length + localImageParts.length > 4) throw new Error('Remova uma imagem do rascunho antes de devolver esta mensagem.');

  const restoredFiles = [];
  for (const part of localImageParts) {
    const name = part.path.split(/[\\/]/).pop();
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(name)) throw new Error('Uma imagem da fila tem um nome inválido. A mensagem continua na fila.');
    const response = await fetch(`${PREFIX}/api/images/${encodeURIComponent(threadId)}/${encodeURIComponent(name)}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Não consegui recuperar uma imagem. A mensagem continua na fila.');
    const blob = await response.blob();
    const dataUrl = await new Promise((resolvePromise, rejectPromise) => {
      const reader = new FileReader(); reader.onload = () => resolvePromise(reader.result); reader.onerror = () => rejectPromise(new Error('Não consegui recuperar uma imagem.')); reader.readAsDataURL(blob);
    });
    restoredFiles.push({ name, mime: blob.type || 'image/png', dataUrl, data: String(dataUrl).split(',')[1] });
  }

  if (state.selectedThreadId !== threadId) throw new Error('Volte a esta conversa para devolver a mensagem da fila. Ela continua guardada.');
  if (state.files.length + restoredFiles.length > 4) throw new Error('Remova uma imagem do rascunho antes de devolver esta mensagem.');
  if (!item.localOnly) await api(`/api/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
  const textarea = $('#messageInput');
  const draft = textarea.value.trimEnd();
  textarea.value = `${draft}${draft && text ? '\n\n' : ''}${text}`;
  state.files.push(...restoredFiles);
  renderAttachments();
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
  state.queueItems = state.queueItems.filter((queued) => queued.id !== item.id);
  state.recoveredQueueItems = state.recoveredQueueItems.filter((queued) => queued.id !== item.id);
  renderQueue();
  if (!item.localOnly) await refreshQueue(threadId);
}

async function refreshQueue(threadId = state.selectedThreadId) {
  if (!threadId) { state.queueItems = []; renderQueue(); return; }
  const data = await api(`/api/threads/${encodeURIComponent(threadId)}/queue`);
  if (threadId !== state.selectedThreadId) return;
  const recoverable = state.recoveredQueueItems.filter((item) => item.threadId === threadId);
  state.queueItems = [...(data.items || []), ...recoverable];
  renderQueue();
}

async function addFiles(files) {
  const accepted = [...files];
  for (const file of accepted) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { toast(`${file.name}: formato não suportado.`, 'error'); continue; }
    if (file.size > 8 * 1024 * 1024) { toast(`${file.name}: o limite é 8 MB por imagem.`, 'error'); continue; }
    if (state.files.length >= 4) { toast('O limite é de 4 imagens por mensagem.', 'error'); break; }
    const dataUrl = await new Promise((resolvePromise, rejectPromise) => {
      const reader = new FileReader(); reader.onload = () => resolvePromise(reader.result); reader.onerror = () => rejectPromise(new Error('Não foi possível ler a imagem.')); reader.readAsDataURL(file);
    }).catch((error) => { toast(error.message, 'error'); return null; });
    if (!dataUrl) continue;
    state.files.push({ name: file.name, mime: file.type, dataUrl, data: String(dataUrl).split(',')[1] });
  }
  renderAttachments();
}

async function submitMessage(event) {
  event?.preventDefault();
  if (state.sending) return;
  if (voice.phase !== 'idle') { toast('Conclua a transcrição ou descarte o áudio antes de enviar.', 'error'); return; }
  const textarea = $('#messageInput');
  const text = textarea.value.trim();
  if (!text && !state.files.length) return;
  const currentThread = state.selectedThreadId;
  const files = [...state.files];
  state.sending = true; updateComposerControls();
  try {
    const result = await api('/api/turn', {
      method: 'POST',
      body: JSON.stringify({ threadId: currentThread, text, model: state.modelId, effort: state.effort, cwd: state.cwd, images: files.map(({ name, mime, data }) => ({ name, mime, data })) }),
    });
    state.selectedThreadId = result.threadId;
    if (!currentThread) {
      state.activeThreadProjectId = state.selectedProjectId;
      associateThreadWithSelectedProject(result.threadId);
    }
    if (!currentThread && !result.queued) updateThreadHeader({ id: result.threadId, name: 'Nova conversa', model: getSelectedModel()?.displayName || state.modelId, status: { type: 'active' } });
    if (result.queued) {
      setBusy(true);
      toast('Mensagem adicionada à fila.');
      refreshQueue(result.threadId).catch((error) => toast(error.message, 'error'));
    } else {
      if (!state.turnStartedAtMs) state.turnStartedAtMs = Date.now();
      setBusy(true);
    }
    if (textarea.value.trim() === text) { textarea.value = ''; textarea.style.height = 'auto'; }
    if (files.length === state.files.length && files.every((file, index) => state.files[index] === file)) { state.files = []; renderAttachments(); }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.sending = false;
    updateComposerControls();
    textarea.dispatchEvent(new Event('input'));
    if (!touchComposer()) textarea.focus();
  }
}

async function steerMessage() {
  if (state.sending || voice.phase !== 'idle' || !state.selectedThreadId) return;
  const textarea = $('#messageInput');
  const text = textarea.value.trim();
  if (!text && !state.files.length) return;
  const threadId = state.selectedThreadId;
  const files = [...state.files];
  state.sending = true; updateComposerControls();
  try {
    await api(`/api/threads/${encodeURIComponent(threadId)}/steer`, {
      method: 'POST',
      body: JSON.stringify({ text, images: files.map(({ name, mime, data }) => ({ name, mime, data })) }),
    });
    if (textarea.value.trim() === text) { textarea.value = ''; textarea.style.height = 'auto'; }
    if (files.length === state.files.length && files.every((file, index) => state.files[index] === file)) { state.files = []; renderAttachments(); }
    toast('Orientação enviada para a execução atual.');
  } catch (error) { toast(error.message, 'error'); }
  finally {
    state.sending = false;
    updateComposerControls();
    textarea.dispatchEvent(new Event('input'));
    textarea.focus();
  }
}

function openSidebar() { showInspector(false); $('#sidebar').classList.add('open'); $('#mobileScrim').classList.add('show'); }
function closeSidebar() { $('#sidebar').classList.remove('open'); if (!$('#inspector').classList.contains('open')) $('#mobileScrim').classList.remove('show'); }

function bindEvents() {
  setupInspectorResize();
  setupComposerViewport();
  $('#closeImagePreview').addEventListener('click', () => $('#imagePreviewDialog').close());
  $('#imagePreviewDialog').addEventListener('click', (event) => {
    if (event.target === $('#imagePreviewDialog')) $('#imagePreviewDialog').close();
  });
  $('#messages').addEventListener('scroll', () => {
    const area = $('#messages');
    state.followLatest = area.scrollHeight - area.clientHeight - area.scrollTop < 80;
    $('#scrollToLatest').classList.toggle('hidden', state.followLatest);
  }, { passive: true });
  $('#scrollToLatest').addEventListener('click', () => scrollConversation(true));
  $('#newChat').addEventListener('click', newChat);
  $('#logoutButton').addEventListener('click', async () => {
    const button = $('#logoutButton'); button.disabled = true;
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); location.reload(); }
    catch (error) { button.disabled = false; toast(error.message, 'error'); }
  });
  $('#composerForm').addEventListener('submit', submitMessage);
  $('#voiceInput').addEventListener('click', startVoiceRecording);
  $('#stopRecording').addEventListener('click', stopVoiceRecording);
  $('#discardAudio').addEventListener('click', clearRecordedAudio);
  $('#transcribeAudio').addEventListener('click', transcribeRecordedAudio);
  $('#attachAudio').addEventListener('click', () => $('#audioInput').click());
  $('#audioInput').addEventListener('change', (event) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || voice.phase !== 'idle') return;
    const extension = file.name.split('.').pop().toLowerCase();
    const types = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', aac: 'audio/aac' };
    if (!types[extension] && !file.type.startsWith('audio/')) { toast('Escolha um arquivo de áudio.', 'error'); return; }
    voice.cancelled = false; voice.generation += 1;
    showRecordedAudio(new Blob([file], { type: types[extension] || file.type }));
  });
  $('#voicePlayer').addEventListener('loadedmetadata', () => { const duration = $('#voicePlayer').duration; if (Number.isFinite(duration)) { voice.seconds = Math.round(duration); $('#voiceTimer').textContent = voiceTime(voice.seconds); } });
  $('#downloadAudio').addEventListener('click', () => {
    const link = document.createElement('a'); link.href = voice.url;
    const extension = voice.blob.type.includes('mp4') ? 'm4a' : voice.blob.type.includes('mpeg') ? 'mp3' : voice.blob.type.split('/')[1]?.split(';')[0] || 'webm';
    link.download = `mensagem-de-voz.${extension}`; link.click();
  });
  $('#messageInput').addEventListener('input', (event) => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`; updateComposerControls(); });
  $('#messageInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && (!touchComposer() || event.ctrlKey || event.metaKey)) { event.preventDefault(); submitMessage(event); }
  });
  $('#messageInput').addEventListener('paste', async (event) => {
    let files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile()).filter(Boolean);
    if (!files.length) files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain');
    if (text) {
      const input = event.currentTarget;
      input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input'));
    }
    await addFiles(files);
  });
  $('#steerButton').addEventListener('click', steerMessage);
  $('#modelSelect').addEventListener('change', () => { state.modelId = $('#modelSelect').value; localStorage.setItem('codex-model', state.modelId); updateEfforts(); localStorage.setItem('codex-effort', state.effort); updateComposerControls(); });
  $('#effortSelect').addEventListener('change', () => { state.effort = $('#effortSelect').value; localStorage.setItem('codex-effort', state.effort); });
  $('#cwdControl').addEventListener('click', () => { $('#cwdInput').value = state.cwd; $('#pathDialog').showModal(); });
  $('#pathForm').addEventListener('submit', (event) => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    const next = $('#cwdInput').value.trim();
    if (!next.startsWith('/')) return toast('Informe um caminho absoluto da VPS.', 'error');
    updateWorkingDirectory(next);
    const project = state.projects.find((item) => pathIsWithin(next, item.cwd));
    selectProject(project?.id || '', { folderPath: next, updateActiveThread: true });
    $('#pathDialog').close();
  });
  $$('.quick-paths button').forEach((button) => button.addEventListener('click', () => { $('#cwdInput').value = button.dataset.path; }));
  $('#attachImage').addEventListener('click', () => $('#imageInput').click());
  $('#imageInput').addEventListener('change', async (event) => { await addFiles(event.target.files); event.target.value = ''; });
  $('#refreshThreads').addEventListener('click', () => refreshThreadList($('#threadSearch').value.trim()).catch((error) => toast(error.message, 'error')));
  $('#toggleArchived').addEventListener('click', async () => {
    if (state.archivedView) return;
    state.archivedView = true;
    try { await refreshThreadList($('#threadSearch').value.trim()); }
    catch (error) { state.archivedView = false; renderThreads(state.threads); toast(error.message, 'error'); }
  });
  $('#showRecentThreads').addEventListener('click', async () => {
    if (!state.archivedView) return;
    state.archivedView = false;
    try { await refreshThreadList(); }
    catch (error) { state.archivedView = true; renderThreads(state.threads); toast(error.message, 'error'); }
  });
  $('#clearThreadSearch').addEventListener('click', () => {
    $('#threadSearch').value = ''; $('#threadSearch').focus();
    refreshThreadList('').catch((error) => toast(error.message, 'error'));
  });
  $('#threadSearchScope').addEventListener('change', () => renderThreads());
  $('#threadList').addEventListener('scroll', closeThreadMenus, { passive: true });
  window.addEventListener('resize', closeThreadMenus);
  $('#threadSearch').addEventListener('input', debounce(() => refreshThreadList($('#threadSearch').value.trim()).catch((error) => toast(error.message, 'error')), 250));
  $('#refreshUsage').addEventListener('click', () => refreshUsage(true).then(() => toast('Uso atualizado.')).catch((error) => toast(error.message, 'error')));
  $('#refreshVpsHealth').addEventListener('click', () => refreshVpsHealth(true));
  $('#toggleUsage').addEventListener('click', () => showInspector(true));
  $('#closeUsage').addEventListener('click', () => showInspector(false));
  $('#openSidebar').addEventListener('click', openSidebar);
  $('#closeSidebar').addEventListener('click', closeSidebar);
  $('#addProject').addEventListener('click', () => openProjectDialog(false));
  $('#newProjectChat').addEventListener('click', () => openProjectDialog(true));
  $('#chatContextSelect').addEventListener('change', () => selectProject($('#chatContextSelect').value));
  $('#projectName').addEventListener('input', updateProjectDirectoryField);
  $('#projectCreateDirectory').addEventListener('change', updateProjectDirectoryField);
  $('#cancelProject').addEventListener('click', () => $('#projectDialog').close());
  $('#projectForm').addEventListener('submit', createProject);
  window.addEventListener('hashchange', () => {
    const threadId = new URLSearchParams(location.hash.slice(1)).get('thread');
    if (threadId && threadId !== state.selectedThreadId) openThread(threadId);
    else if (!threadId && state.selectedThreadId) newChat();
  });
  $('#mobileScrim').addEventListener('click', () => { closeSidebar(); showInspector(false); });
  $('#stopTurn').addEventListener('click', async () => {
    if (!state.selectedThreadId || state.interrupting) return;
    const threadId = state.selectedThreadId;
    state.interrupting = true; updateComposerControls();
    try {
      const result = await api(`/api/threads/${encodeURIComponent(threadId)}/interrupt`, { method: 'POST', body: '{}' });
      if (!result.interrupted) toast('A execução já terminou.');
    } catch (error) { toast(error.message, 'error'); }
    finally { state.interrupting = false; updateComposerControls(); }
  });
  $$('.suggestion').forEach((button) => button.addEventListener('click', () => { $('#messageInput').value = button.dataset.prompt; $('#messageInput').focus(); $('#messageInput').dispatchEvent(new Event('input')); }));
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); newChat(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); openSidebar(); $('#threadSearch').focus(); }
    if (event.key === 'Escape') { closeSidebar(); showInspector(false); }
  });
  $('#cwdLabel').textContent = state.cwd; $('#inspectorCwd').textContent = state.cwd;
  updateComposerControls();
}

function debounce(callback, delay) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => callback(...args), delay); }; }

initializeAuthentication();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${PREFIX}/service-worker.js`).catch(() => {});
}

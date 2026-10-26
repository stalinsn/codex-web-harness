// Login, first-access and password-reset screens; application start-up.
import { api } from './api.js';
import { bindEvents, bootstrap } from './app.js';
import { syncExecutionState } from './conversation.js';
import { $, installIcons } from './dom.js';
import { connectEvents } from './events.js';
import { refreshVpsHealth } from './inspector.js';
import { updateResetCountdowns } from './rate-limit.js';
import { authUi, runtime, state } from './state.js';

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
    if (authUi.mode === 'login') {
      await api('/api/auth/login/verify', { method: 'POST', body: JSON.stringify({ challengeId: authUi.challengeId, code }) });
    } else {
      await api(`/api/auth/${authUi.mode}/complete`, {
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
  $('#sessionLoading').hidden = true;
  $('#authScreen').hidden = true;
  $('#appShell').hidden = false;
  if (authUi.started) return;
  authUi.started = true;
  setInterval(updateResetCountdowns, 60_000);
  setInterval(() => { if (!document.hidden) refreshVpsHealth(); }, 60_000);
  bindEvents(); connectEvents(); bootstrap();
  setInterval(() => { if (!document.hidden && state.busy && Date.now() - state.lastExecutionEventAt > 20_000) syncExecutionState().catch(() => {}); }, 15_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncExecutionState().catch(() => {}); });
}

async function checkAuthentication() {
  if (runtime.authCheckRequest) return runtime.authCheckRequest;
  const loading = $('#sessionLoading');
  loading.hidden = false;
  $('#authScreen').hidden = true;
  $('#sessionLoadingText').textContent = 'Restaurando sua sessão…';
  $('#retrySession').hidden = true;

  runtime.authCheckRequest = (async () => {
    let lastError;
    let status;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        status = await api('/api/auth/status');
        if (typeof status.authenticated !== 'boolean') throw new Error('A resposta de sessão veio incompleta.');
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolvePromise) => setTimeout(resolvePromise, 350 * (attempt + 1)));
      }
    }

    if (lastError) {
      $('#sessionLoadingText').textContent = 'Não consegui confirmar sua sessão agora.';
      $('#retrySession').hidden = false;
      return;
    }

    authUi.setupRequired = Boolean(status.setupRequired);
    if (status.authenticated) return startApplication();
    authUi.mode = authUi.setupRequired ? 'setup' : 'login';
    authUi.step = 'credentials';
    showAuthFlow();
    loading.hidden = true;
    $('#authScreen').hidden = false;
  })().finally(() => { runtime.authCheckRequest = null; });
  return runtime.authCheckRequest;
}

export async function initializeAuthentication() {
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
  $('#retrySession').addEventListener('click', () => checkAuthentication());
  await checkAuthentication();
}

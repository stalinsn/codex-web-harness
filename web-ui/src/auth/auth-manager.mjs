import { createHash, createHmac, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import nodemailer from 'nodemailer';

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = '__Secure-codex_session';
const COOKIE_PATH = '/codex-agent';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const CODE_MS = 10 * 60 * 1000;
const SEND_COOLDOWN_MS = 60 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const PASSWORD_OPTIONS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PASSWORD_BYTES = 32;
const OTP_ATTEMPTS = 5;

export class AuthError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function parseCookie(header) {
  for (const entry of String(header || '').split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() === COOKIE_NAME) return entry.slice(separator + 1).trim();
  }
  return '';
}

function maskEmail(email) {
  const [local = '', domain = ''] = email.split('@');
  if (!local || !domain) return 'seu e-mail cadastrado';
  const visible = local.length < 3 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${'•'.repeat(Math.max(3, Math.min(8, local.length - visible.length)))}@${domain}`;
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128 && Buffer.byteLength(value, 'utf8') <= 256 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function asSmtpError(error) {
  const code = String(error?.code || '');
  if (code === 'EAUTH') return 'O servidor de e-mail recusou a autenticação. A configuração precisa ser revisada.';
  if (['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNREFUSED', 'EDNS'].includes(code)) return 'Não foi possível conectar ao servidor de e-mail. A configuração precisa ser revisada.';
  return 'Não foi possível enviar o código por e-mail. Tente novamente mais tarde.';
}

export class AuthManager {
  constructor(statePath) {
    this.statePath = statePath;
    this.state = null;
    this.challenges = new Map();
    this.rateWindows = new Map();
    this.writeQueue = Promise.resolve();
    this.deliveryBusy = false;
  }

  async initialize() {
    let state;
    try {
      const fileInfo = await stat(this.statePath);
      if ((fileInfo.mode & 0o077) !== 0) throw new Error('O arquivo de autenticação precisa ter permissão 0600.');
      state = JSON.parse(await readFile(this.statePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('A configuração privada do login Codex não foi provisionada.');
      throw error;
    }

    const smtp = state?.smtp;
    if (state?.version !== 1 || !state.email || !state.sessionPepper || !smtp?.host || !smtp?.fromEmail) {
      throw new Error('A configuração privada do login Codex está incompleta.');
    }
    if (!['password', 'none'].includes(smtp.authMode) || !['starttls', 'ssl'].includes(smtp.secureMode)) {
      throw new Error('O modo SMTP da configuração privada não é válido.');
    }
    if (smtp.authMode === 'password' && (!smtp.username || typeof smtp.password !== 'string' || !smtp.password)) {
      throw new Error('As credenciais SMTP privadas estão incompletas.');
    }

    state.sessions = Array.isArray(state.sessions) ? state.sessions : [];
    state.emailSendTimestamps = Array.isArray(state.emailSendTimestamps) ? state.emailSendTimestamps.filter(Number.isFinite) : [];
    this.state = state;
    await this.pruneState();
  }

  get setupRequired() { return !this.state.passwordHash; }

  status(cookieHeader) {
    const session = this.getSession(cookieHeader);
    return { authenticated: Boolean(session), setupRequired: this.setupRequired };
  }

  getSession(cookieHeader) {
    if (!this.state) return null;
    const token = parseCookie(cookieHeader);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
    const candidate = hashToken(token);
    const now = Date.now();
    const session = this.state.sessions.find((entry) => safeEqual(entry.tokenHash, candidate) && entry.expiresAt > now);
    return session ? { expiresAt: session.expiresAt } : null;
  }

  sessionCookie(token) {
    return `${COOKIE_NAME}=${token}; Path=${COOKIE_PATH}; Max-Age=${Math.floor(SESSION_MS / 1000)}; Secure; HttpOnly; SameSite=Strict`;
  }

  clearCookie() {
    return `${COOKIE_NAME}=; Path=${COOKIE_PATH}; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
  }

  async logout(cookieHeader) {
    const token = parseCookie(cookieHeader);
    if (/^[A-Za-z0-9_-]{43}$/u.test(token)) {
      const tokenHash = hashToken(token);
      this.state.sessions = this.state.sessions.filter((entry) => !safeEqual(entry.tokenHash, tokenHash));
      await this.persist();
    }
  }

  async startLogin(password, ip) {
    this.consumeRate(`login:${ip}`, 10, 15 * 60 * 1000);
    if (!this.state.passwordHash) throw new AuthError('Este acesso ainda precisa ser configurado pelo primeiro acesso.', 409);
    const acceptedPassword = await this.verifyPassword(String(password || ''), this.state.passwordHash);
    if (!acceptedPassword) throw new AuthError('Senha incorreta.', 401);
    return this.issueCode('login');
  }

  async startSetup(ip) {
    this.consumeRate(`setup:${ip}`, 5, 60 * 60 * 1000);
    if (!this.setupRequired) throw new AuthError('O primeiro acesso já foi configurado. Use o login normal.', 409);
    return this.issueCode('setup');
  }

  async startReset(ip) {
    this.consumeRate(`reset:${ip}`, 5, 60 * 60 * 1000);
    if (this.setupRequired) throw new AuthError('Use a opção de primeiro acesso para definir a senha.', 409);
    return this.issueCode('reset');
  }

  async resendCode(challengeId, ip) {
    const challenge = this.challenges.get(String(challengeId || ''));
    if (!challenge || challenge.expiresAt <= Date.now()) throw new AuthError('Esse código expirou. Inicie a etapa novamente.', 410);
    this.consumeRate(`resend:${ip}`, 5, 60 * 60 * 1000);
    return this.issueCode(challenge.intent, String(challengeId));
  }

  async verifyLogin(challengeId, code) {
    await this.consumeCode(challengeId, code, 'login');
    return this.createSession();
  }

  async completeSetup(challengeId, code, password, confirmPassword) {
    if (!this.setupRequired) throw new AuthError('O primeiro acesso já foi configurado.', 409);
    this.validateNewPassword(password, confirmPassword);
    await this.consumeCode(challengeId, code, 'setup');
    if (!this.setupRequired) throw new AuthError('O primeiro acesso já foi configurado.', 409);
    this.state.passwordHash = await this.hashPassword(password);
    await this.persist();
    return this.createSession();
  }

  async completeReset(challengeId, code, password, confirmPassword) {
    if (this.setupRequired) throw new AuthError('Use a opção de primeiro acesso para definir a senha.', 409);
    this.validateNewPassword(password, confirmPassword);
    await this.consumeCode(challengeId, code, 'reset');
    this.state.passwordHash = await this.hashPassword(password);
    this.state.sessions = [];
    await this.persist();
    return this.createSession();
  }

  validateNewPassword(password, confirmPassword) {
    if (!validPassword(password)) throw new AuthError('Use uma senha de 12 a 128 caracteres, sem caracteres de controle.', 400);
    if (!safeEqual(password, confirmPassword)) throw new AuthError('As senhas não coincidem.', 400);
  }

  consumeRate(key, maximum, windowMs) {
    const now = Date.now();
    const entries = (this.rateWindows.get(key) || []).filter((time) => time > now - windowMs);
    if (entries.length >= maximum) throw new AuthError('Muitas tentativas. Aguarde um pouco e tente novamente.', 429);
    entries.push(now);
    this.rateWindows.set(key, entries);
    if (this.rateWindows.size > 2000) {
      for (const [entryKey, times] of this.rateWindows) {
        if (!times.some((time) => time > now - 60 * 60 * 1000)) this.rateWindows.delete(entryKey);
      }
    }
  }

  async issueCode(intent, existingId = '') {
    if (this.deliveryBusy) throw new AuthError('Um código está sendo enviado. Aguarde alguns segundos.', 429);
    this.deliveryBusy = true;
    let challengeId = '';
    let transporter;
    try {
      const now = Date.now();
      const sends = this.state.emailSendTimestamps.filter((time) => time > now - SEND_WINDOW_MS);
      const latest = sends.at(-1) || 0;
      if (now - latest < SEND_COOLDOWN_MS) throw new AuthError('Aguarde um minuto antes de solicitar outro código.', 429);
      if (sends.length >= 3) throw new AuthError('O limite de códigos por hora foi atingido. Tente novamente mais tarde.', 429);

      challengeId = existingId || randomBytes(24).toString('base64url');
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      this.challenges.set(challengeId, {
        intent,
        codeHash: createHmac('sha256', this.state.sessionPepper).update(`${challengeId}:${code}`).digest('hex'),
        expiresAt: now + CODE_MS,
        attempts: 0,
      });
      this.state.emailSendTimestamps = [...sends, now];
      await this.persist();

      const subject = intent === 'setup' ? 'Ative seu acesso ao Codex' : intent === 'reset' ? 'Recupere seu acesso ao Codex' : 'Seu código de acesso ao Codex';
      const action = intent === 'setup' ? 'configurar seu acesso' : intent === 'reset' ? 'redefinir sua senha' : 'entrar no Codex';
      const html = `<div style="font-family:Arial,sans-serif;color:#171923;max-width:560px;margin:0 auto;padding:28px"><p style="color:#626b86;font-size:12px;letter-spacing:.12em;text-transform:uppercase">Acesso privado</p><h1 style="font-size:24px">Código de acesso ao Codex</h1><p>Use este código para ${action} no seu servidor. Ele expira em 10 minutos.</p><p style="font:700 32px ui-monospace,monospace;letter-spacing:.35em;background:#f2f3f8;padding:18px 20px;border-radius:12px">${code}</p><p>Se você não solicitou este código, ignore esta mensagem. Nunca compartilhe o código.</p></div>`;
      const text = `Seu código para ${action} no Codex é: ${code}\n\nEle expira em 10 minutos. Se você não solicitou este código, ignore esta mensagem. Nunca compartilhe o código.`;

      transporter = nodemailer.createTransport({
        host: this.state.smtp.host,
        port: this.state.smtp.port,
        secure: this.state.smtp.secureMode === 'ssl',
        ...(this.state.smtp.secureMode === 'starttls' ? { requireTLS: true } : {}),
        ...(this.state.smtp.authMode === 'password' ? { auth: { user: this.state.smtp.username, pass: this.state.smtp.password } } : {}),
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
      await transporter.sendMail({
        from: { name: this.state.smtp.fromName, address: this.state.smtp.fromEmail },
        to: this.state.email,
        subject,
        text,
        html,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } catch (error) {
      if (challengeId) this.challenges.delete(challengeId);
      if (error instanceof AuthError) throw error;
      throw new AuthError(asSmtpError(error), 503);
    } finally {
      this.deliveryBusy = false;
      transporter?.close();
    }
    return { challengeId, emailHint: maskEmail(this.state.email), expiresIn: Math.floor(CODE_MS / 1000), resendIn: Math.floor(SEND_COOLDOWN_MS / 1000) };
  }

  async consumeCode(challengeId, code, expectedIntent) {
    const id = String(challengeId || '');
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.expiresAt <= Date.now() || challenge.intent !== expectedIntent) {
      this.challenges.delete(id);
      throw new AuthError('O código é inválido ou expirou. Solicite um novo código.', 400);
    }
    if (!/^\d{6}$/u.test(String(code || ''))) {
      challenge.attempts += 1;
      if (challenge.attempts >= OTP_ATTEMPTS) this.challenges.delete(id);
      throw new AuthError('O código é inválido ou expirou.', 400);
    }
    const candidate = createHmac('sha256', this.state.sessionPepper).update(`${id}:${code}`).digest('hex');
    if (!safeEqual(candidate, challenge.codeHash)) {
      challenge.attempts += 1;
      if (challenge.attempts >= OTP_ATTEMPTS) this.challenges.delete(id);
      throw new AuthError('O código é inválido ou expirou.', 400);
    }
    this.challenges.delete(id);
  }

  async hashPassword(password) {
    const salt = randomBytes(16);
    const derived = await scrypt(password, salt, PASSWORD_BYTES, PASSWORD_OPTIONS);
    return `scrypt$${PASSWORD_OPTIONS.N}$${PASSWORD_OPTIONS.r}$${PASSWORD_OPTIONS.p}$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
  }

  async verifyPassword(password, encoded) {
    const [algorithm, nText, rText, pText, saltText, keyText, extra] = String(encoded || '').split('$');
    if (algorithm !== 'scrypt' || extra !== undefined || !saltText || !keyText || password.length > 128) return false;
    const n = Number(nText), r = Number(rText), p = Number(pText);
    if (n !== PASSWORD_OPTIONS.N || r !== PASSWORD_OPTIONS.r || p !== PASSWORD_OPTIONS.p) return false;
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(keyText, 'base64url');
    if (salt.length !== 16 || expected.length !== PASSWORD_BYTES) return false;
    const actual = Buffer.from(await scrypt(password, salt, PASSWORD_BYTES, PASSWORD_OPTIONS));
    return timingSafeEqual(actual, expected);
  }

  async createSession() {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.state.sessions = this.state.sessions.filter((entry) => entry.expiresAt > now).slice(-11);
    this.state.sessions.push({ tokenHash: hashToken(token), createdAt: now, expiresAt: now + SESSION_MS });
    await this.persist();
    return { token, maxAge: Math.floor(SESSION_MS / 1000) };
  }

  async pruneState() {
    const now = Date.now();
    const sessions = this.state.sessions.filter((entry) => typeof entry.tokenHash === 'string' && entry.expiresAt > now);
    const sends = this.state.emailSendTimestamps.filter((time) => time > now - SEND_WINDOW_MS);
    if (sessions.length !== this.state.sessions.length || sends.length !== this.state.emailSendTimestamps.length) {
      this.state.sessions = sessions;
      this.state.emailSendTimestamps = sends;
      await this.persist();
    }
  }

  async persist() {
    const run = async () => {
      await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.statePath}.tmp-${process.pid}`;
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.statePath);
    };
    this.writeQueue = this.writeQueue.then(run, run);
    await this.writeQueue;
  }
}

export function readSessionToken(cookieHeader) {
  return parseCookie(cookieHeader);
}

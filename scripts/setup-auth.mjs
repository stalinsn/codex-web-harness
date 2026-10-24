import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, open } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

if (!stdin.isTTY || !stdout.isTTY) {
  console.error('Execute este assistente em um terminal interativo.');
  process.exit(1);
}

const home = process.env.HOME || homedir();
const codexHome = process.env.CODEX_HOME || join(home, '.codex');
const configPath = join(codexHome, 'web-auth.json');
const prompt = createInterface({ input: stdin, output: stdout });

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) && value.length <= 254;
}

async function ask(label, { defaultValue = '', validate = () => true } = {}) {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const value = (await prompt.question(`${label}${suffix}: `)).trim() || defaultValue;
    if (validate(value)) return value;
    stdout.write('Valor inválido. Tente novamente.\n');
  }
}

async function askSecret(label) {
  stdout.write(`${label}: `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') { finish(new Error('Configuração cancelada.')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && char !== '\u007f') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

try {
  stdout.write(`Configuração de autenticação privada\nArquivo de destino: ${configPath}\n\n`);
  const email = await ask('E-mail autorizado', { validate: validEmail });
  const host = await ask('Servidor SMTP', { validate: (value) => /^[a-zA-Z0-9.-]+$/u.test(value) });
  const secureMode = await ask('Segurança SMTP (starttls ou ssl)', { defaultValue: 'starttls', validate: (value) => ['starttls', 'ssl'].includes(value.toLowerCase()) }).then((value) => value.toLowerCase());
  const portText = await ask('Porta SMTP', { defaultValue: secureMode === 'ssl' ? '465' : '587', validate: (value) => /^\d{1,5}$/u.test(value) && Number(value) > 0 && Number(value) <= 65535 });
  const fromName = await ask('Nome remetente', { defaultValue: 'Codex Web Harness', validate: (value) => value.length <= 100 && !/[\r\n]/u.test(value) });
  const fromEmail = await ask('E-mail remetente', { validate: validEmail });
  const authMode = await ask('Autenticação SMTP (password ou none)', { defaultValue: 'password', validate: (value) => ['password', 'none'].includes(value.toLowerCase()) }).then((value) => value.toLowerCase());
  let username = '';
  let password = '';
  if (authMode === 'password') {
    username = await ask('Usuário SMTP', { validate: (value) => value.length > 0 && value.length <= 254 && !/[\r\n]/u.test(value) });
    prompt.close();
    password = await askSecret('Senha SMTP (não será exibida)');
    if (!password || password.length > 1024) throw new Error('A senha SMTP está vazia ou excede o tamanho permitido.');
  }

  const smtp = { host, port: Number(portText), secureMode, authMode, fromName, fromEmail };
  if (authMode === 'password') Object.assign(smtp, { username, password });
  const config = {
    version: 1,
    email,
    sessionPepper: randomBytes(32).toString('base64url'),
    smtp,
    sessions: [],
    emailSendTimestamps: [],
  };

  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const file = await open(configPath, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8'); }
  finally { await file.close(); }
  stdout.write(`Configuração salva com permissão restrita. Próximo passo: iniciar o serviço e concluir o primeiro acesso pelo navegador.\n`);
} catch (error) {
  console.error(error.message || 'Não foi possível concluir a configuração.');
  process.exitCode = 1;
} finally {
  prompt.close();
}

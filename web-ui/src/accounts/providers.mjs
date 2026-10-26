// Provider presets. A preset says how to run a CLI agent headlessly, how to keep each
// account's login isolated, how to tell whether it is signed in and how to sign in.
// Accounts can override any field (bin, args, env, parser...), and the `custom`
// preset lets new CLIs be added from configuration alone.
//
// Arg templates: strings may contain {prompt} {model} {effort} {sessionId} {cwd}
// {permissionMode}; a nested array is an optional group, dropped when any of its
// placeholders is empty (e.g. ['--model', '{model}']).

export const PROVIDERS = {
  codex: {
    label: 'Codex (OpenAI)',
    kind: 'codex',
    bin: 'codex',
    isolation: { env: 'CODEX_HOME' },
    status: { command: ['login', 'status'] },
    login: 'codex login --device-auth',
    logout: 'codex logout',
    usage: 'reported',
    setup: {
      install: 'npm install -g @openai/codex',
      notes: 'A conta principal do chat nunca é alterada aqui: cada conta extra tem o próprio CODEX_HOME, com a mesma configuração (config.toml e AGENTS.md) da principal.',
      flows: [{
        id: 'device', label: 'Código de dispositivo (recomendado)', command: ['codex', 'login', '--device-auth'], cols: 120,
        steps: ['Toque em Iniciar: o Codex mostra um link e um código.', 'Abra o link, entre na conta ChatGPT desta conta e digite o código.', 'Aguarde: o harness detecta o login sozinho.'],
      }],
    },
  },
  'claude-code': {
    label: 'Claude Code (Anthropic)',
    kind: 'cli',
    bin: 'claude',
    isolation: { env: 'CLAUDE_CONFIG_DIR' },
    args: ['-p', '{prompt}', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ['--model', '{model}'], ['--effort', '{effort}'], ['--permission-mode', '{permissionMode}']],
    resumeArgs: ['--resume', '{sessionId}'],
    permissionMode: 'acceptEdits',
    parser: 'claude',
    status: { files: ['.credentials.json'], secret: 'CLAUDE_CODE_OAUTH_TOKEN' },
    login: 'claude   # depois digite /login e siga o link',
    logout: 'claude   # depois digite /logout',
    usage: 'events',
    setup: {
      install: 'npm install -g @anthropic-ai/claude-code',
      notes: 'Conecte pelo login oficial da Claude com /login. O harness não pede nem armazena a senha da sua conta. A disponibilidade de modelo depende do plano e é confirmada pelo Claude ao iniciar uma tarefa.',
      flows: [
        {
          id: 'interactive', label: 'Entrar com a conta Claude (recomendado)', command: ['claude'], cols: 320,
          steps: ['Toque em Iniciar. Se aparecerem perguntas de tema ou de confiança na pasta, responda com as setas e Enter.', 'Digite /login e envie; escolha a conta Claude.', 'Abra o link, autorize e cole o código de volta.', 'Quando o login concluir, o harness detecta e encerra a tela.'],
        },
        {
          id: 'token', label: 'Conectar com token de longa duração', command: ['claude', 'setup-token'], cols: 320,
          capture: { pattern: 'sk-ant-oat[0-9]*-[A-Za-z0-9_-]{20,}', env: 'CLAUDE_CODE_OAUTH_TOKEN' },
          steps: ['Gere o token usando a CLI oficial da Anthropic.', 'Cole o token no terminal para o harness salvá-lo apenas nesta conta.'],
        },
      ],
      secret: { env: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Já tenho um token (gerado com claude setup-token em outro computador)', placeholder: 'sk-ant-oat01-…' },
    },
  },
  antigravity: {
    label: 'Antigravity CLI (Google)',
    kind: 'cli',
    bin: 'agy',
    isolation: { env: 'HOME' },
    args: ['-p', '{prompt}', '--output-format', 'stream-json', ['--model', '{model}'], ['--effort', '{effort}']],
    resumeArgs: ['--conversation', '{sessionId}'],
    parser: 'generic',
    status: { command: ['models'], secret: 'GEMINI_API_KEY' },
    login: 'agy   # abre um link de autorização para concluir em outro dispositivo',
    logout: 'agy   # depois digite /logout',
    usage: 'errors',
    setup: {
      install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      notes: 'A conexão usa o fluxo oficial de autorização Google; o harness não pede a senha Google. Em servidores sem chaveiro do sistema o agy pode não conseguir guardar o login. Se o terminal mostrar erro de keyring, configure o chaveiro da VPS ou use uma chave de API do Gemini (cobrada separadamente).',
      flows: [{
        id: 'google', label: 'Conta Google', command: ['agy'], cols: 320,
        steps: ['Toque em Iniciar: o agy mostra um link de autorização.', 'Abra o link, entre na conta Google desta conta e autorize.', 'Copie o código exibido e cole no campo abaixo do terminal.', 'O harness confere o login e encerra a tela.'],
      }],
      secret: { env: 'GEMINI_API_KEY', label: 'Usar chave de API do Gemini (cobrada por uso, não usa a assinatura)', placeholder: 'AIza…', settings: { file: '.gemini/antigravity-cli/settings.json', merge: { modelProvider: 'gemini' } } },
    },
  },
  'gemini-cli': {
    label: 'Gemini CLI (Google)',
    kind: 'cli',
    bin: 'gemini',
    isolation: { env: 'HOME' },
    args: ['-p', '{prompt}', '--output-format', 'stream-json', ['-m', '{model}'], ['--approval-mode', '{permissionMode}']],
    permissionMode: 'auto_edit',
    parser: 'generic',
    status: { files: ['.gemini/oauth_creds.json'], secret: 'GEMINI_API_KEY' },
    login: 'gemini   # escolha "Login with Google" e siga o link',
    logout: 'gemini   # depois digite /auth',
    usage: 'errors',
    setup: {
      install: 'npm install -g @google/gemini-cli',
      notes: 'Desde junho de 2026 o Google indica o Antigravity CLI para contas sem plano pago; prefira o preset Antigravity nesses casos.',
      flows: [{
        id: 'google', label: 'Login com Google', command: ['gemini'], env: { NO_BROWSER: 'true' }, cols: 320,
        steps: ['Toque em Iniciar. No menu de autenticação escolha "Login with Google" (Enter).', 'Abra o link, entre na conta Google e autorize.', 'Cole o código de autorização no campo abaixo do terminal.', 'O harness detecta as credenciais e encerra a tela.'],
      }],
      secret: { env: 'GEMINI_API_KEY', label: 'Usar chave de API do Gemini', placeholder: 'AIza…' },
    },
  },
  custom: {
    label: 'CLI personalizada',
    kind: 'cli',
    bin: '',
    isolation: { env: 'HOME' },
    args: ['{prompt}'],
    parser: 'text',
    status: {},
    login: '',
    logout: '',
    usage: 'errors',
    setup: { install: '', notes: 'Defina bin, args e o comando de login desta CLI em web-accounts.json.', flows: [] },
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/** Expand an args template. Optional groups disappear when a placeholder is empty. */
export function expandArgs(template, values) {
  const fill = (part) => part.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
  const hasAll = (part) => [...part.matchAll(/\{(\w+)\}/g)].every(([, key]) => values[key] != null && String(values[key]) !== '');
  const out = [];
  for (const part of template || []) {
    if (Array.isArray(part)) { if (part.every(hasAll)) out.push(...part.map(fill)); }
    else out.push(fill(part));
  }
  return out;
}

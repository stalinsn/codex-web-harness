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
  },
  'claude-code': {
    label: 'Claude Code (Anthropic)',
    kind: 'cli',
    bin: 'claude',
    isolation: { env: 'CLAUDE_CONFIG_DIR' },
    args: ['-p', '{prompt}', '--output-format', 'stream-json', '--verbose', ['--model', '{model}'], ['--permission-mode', '{permissionMode}']],
    resumeArgs: ['--resume', '{sessionId}'],
    permissionMode: 'acceptEdits',
    parser: 'claude',
    status: { files: ['.credentials.json'] },
    login: 'claude   # depois digite /login e siga o link',
    logout: 'claude   # depois digite /logout',
    usage: 'events',
  },
  antigravity: {
    label: 'Antigravity CLI (Google)',
    kind: 'cli',
    bin: 'agy',
    isolation: { env: 'HOME' },
    args: ['-p', '{prompt}', '--output-format', 'stream-json', ['--model', '{model}'], ['--effort', '{effort}']],
    resumeArgs: ['--conversation', '{sessionId}'],
    parser: 'generic',
    status: { command: ['models'] },
    login: 'agy   # abre um link de autorização para concluir em outro dispositivo',
    logout: 'agy   # depois digite /logout',
    usage: 'errors',
  },
  'gemini-cli': {
    label: 'Gemini CLI (Google)',
    kind: 'cli',
    bin: 'gemini',
    isolation: { env: 'HOME' },
    args: ['-p', '{prompt}', '--output-format', 'stream-json', ['-m', '{model}'], ['--approval-mode', '{permissionMode}']],
    permissionMode: 'auto_edit',
    parser: 'generic',
    status: { files: ['.gemini/oauth_creds.json'] },
    login: 'gemini   # escolha "Login with Google" e siga o link',
    logout: 'gemini   # depois digite /auth',
    usage: 'errors',
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

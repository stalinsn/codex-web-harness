// Codex Web Harness entry point.
import { createServer } from 'node:http';
import { ChatHandoff } from './src/accounts/chat-handoff.mjs';
import { AccountRegistry } from './src/accounts/registry.mjs';
import { LoginSessions } from './src/accounts/login-sessions.mjs';
import { AccountService } from './src/accounts/service.mjs';
import { createRequestHandler } from './src/app.mjs';
import { AuthManager } from './src/auth/auth-manager.mjs';
import { CodexAppServer } from './src/codex/app-server.mjs';
import { config } from './src/config.mjs';
import { EventHub } from './src/events.mjs';
import { StaticAssets } from './src/http/static.mjs';
import { TaskOrchestrator } from './src/tasks/orchestrator.mjs';
import { LocalThreadStore } from './src/threads/local-store.mjs';
import { ProviderChat } from './src/threads/provider-chat.mjs';

const ACCOUNT_POLL_MS = 5 * 60 * 1000;

const events = new EventHub();
const emit = (type, data, options) => events.emit(type, data, options);
const codex = new CodexAppServer({ bin: config.codexBin, homeDir: config.homeDir, codexHome: config.codexHome, emit });
const auth = new AuthManager(config.authFile);
const registry = await new AccountRegistry().load();
const accounts = new AccountService({ registry, primaryCodex: codex, emit });
const localThreads = await new LocalThreadStore().load();
const orchestrator = new TaskOrchestrator({ accounts, primaryCodex: codex, emit, localThreads });
const chatHandoff = new ChatHandoff({ primaryCodex: codex, accounts, orchestrator, emit });
accounts.onOrchestratedThread = (threadId) => chatHandoff.markOrchestrated(threadId);
const logins = new LoginSessions({ accounts, emit });
const providerChat = new ProviderChat({ store: localThreads, accounts, emit });
const assets = new StaticAssets({ publicDir: config.publicDir, prefix: config.prefix, dev: config.dev });
const server = createServer(createRequestHandler({ auth, codex, events, assets, accounts, orchestrator, logins, localThreads, providerChat }));

await Promise.all([auth.initialize(), assets.load()]);

server.listen(config.port, config.host, () => {
  console.log(`Codex web UI ouvindo em ${config.host}:${config.port}.`);
  codex.start();
  orchestrator.load().catch((error) => console.error('Não foi possível carregar as tarefas contínuas:', error.message));
  setTimeout(() => accounts.checkAll().catch(() => {}), 5000).unref();
});

setInterval(() => { if (codex.ready) codex.refreshAccountData(true).catch(() => {}); }, ACCOUNT_POLL_MS).unref();

function stop() {
  orchestrator.stopAll();
  logins.stopAll();
  providerChat.stopAll();
  accounts.stop();
  codex.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

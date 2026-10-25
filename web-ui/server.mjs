// Codex Web Harness entry point.
import { createServer } from 'node:http';
import { createRequestHandler } from './src/app.mjs';
import { AuthManager } from './src/auth/auth-manager.mjs';
import { CodexAppServer } from './src/codex/app-server.mjs';
import { config } from './src/config.mjs';
import { EventHub } from './src/events.mjs';
import { StaticAssets } from './src/http/static.mjs';

const ACCOUNT_POLL_MS = 5 * 60 * 1000;

const events = new EventHub();
const codex = new CodexAppServer({
  bin: config.codexBin,
  homeDir: config.homeDir,
  codexHome: config.codexHome,
  emit: (type, data) => events.emit(type, data),
});
const auth = new AuthManager(config.authFile);
const assets = new StaticAssets({ publicDir: config.publicDir, prefix: config.prefix, dev: config.dev });
const server = createServer(createRequestHandler({ auth, codex, events, assets }));

await Promise.all([auth.initialize(), assets.load()]);

server.listen(config.port, config.host, () => {
  console.log(`Codex web UI ouvindo em ${config.host}:${config.port}.`);
  codex.start();
});

setInterval(() => { if (codex.ready) codex.refreshAccountData(true).catch(() => {}); }, ACCOUNT_POLL_MS).unref();

function stop() {
  codex.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

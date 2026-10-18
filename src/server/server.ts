import { createApp } from './app';
import { resolve } from 'node:path';

export { createApp } from './app';
function configuredPanelOrigins(value: string | undefined): string[] | undefined {
  if (value === undefined || value === '') return undefined;
  const items = value.split(',').map(item => item.trim());
  if (items.some(item => !item)) throw new Error('MBOARD_PANEL_ORIGINS contains an empty origin');
  return items;
}
export function startServer(env: Record<string, string | undefined> = process.env) {
  const port = Number(env.MBOARD_PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MBOARD_PORT must be an integer from 1 to 65535');
  const hostname = env.MBOARD_HOST || '127.0.0.1';
  const dataDir = resolve(env.MBOARD_DATA_DIR || './data');
  const panelOrigins = configuredPanelOrigins(env.MBOARD_PANEL_ORIGINS);
  const app = createApp({ dbPath: resolve(dataDir, 'mboard.sqlite'), distDir: resolve(import.meta.dir, '../../dist'), publicOrigin: env.MBOARD_PUBLIC_ORIGIN, subscriptionOrigin: env.MBOARD_SUBSCRIPTION_ORIGIN, panelOrigins, loginLimit: env.MBOARD_LOGIN_LIMIT === undefined ? undefined : Number(env.MBOARD_LOGIN_LIMIT), peerLoginLimit: env.MBOARD_PEER_LOGIN_LIMIT === undefined ? undefined : Number(env.MBOARD_PEER_LOGIN_LIMIT) });
  // The fetch handler enforces 1 MiB while streaming. Bun's lower native cutoff bypasses JSON error envelopes.
  const server = Bun.serve({ hostname, port, idleTimeout: 20, maxRequestBodySize: Number.MAX_SAFE_INTEGER, fetch: (req, server) => app.fetch(req, server) });
  console.log(`mboard listening on ${server.url}`);
  let closed = false;
  const stop = () => { if (!closed) { closed = true; server.stop(true); app.close(); } };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return { server, app, stop };
}
if (import.meta.main) startServer();

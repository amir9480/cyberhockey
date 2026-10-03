import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGameServer } from './app';
import { DEFAULT_CONFIG } from './config';

// Both server/src (dev) and server/dist (built) sit two levels below the repo root.
const webDir = process.env.WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const port = Number(process.env.PORT) || 3000;
// All IPv4 interfaces, so other devices on the network can connect. HOST=:: also takes IPv6.
const host = process.env.HOST ?? '0.0.0.0';

if (!existsSync(webDir)) console.warn(`No frontend at ${webDir}: run \`pnpm build\` first (or wait for \`pnpm dev\` to finish its first build).`);
/** A whole number from the environment, or `fallback` when unset or invalid. */
const envInt = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return process.env[name] && Number.isInteger(v) && v >= 0 ? v : fallback;
};
const server = createGameServer({
  webDir,
  maxConnsPerIp: envInt('MAX_CONNS_PER_IP', DEFAULT_CONFIG.maxConnsPerIp),
  maxConns: envInt('MAX_CONNS', DEFAULT_CONFIG.maxConns),
  // Behind nginx/Caddy/a load balancer: how many of them, so the per-address limit sees real client addresses.
  trustProxy: envInt('TRUST_PROXY', DEFAULT_CONFIG.trustProxy),
  appUrl: process.env.APP_URL || DEFAULT_CONFIG.appUrl,
  idleTimeout: envInt('IDLE_TIMEOUT', DEFAULT_CONFIG.idleTimeout / 1000) * 1000,
});
await server.listen(port, host);
console.log(`airhockey server listening on ${host}:${port} (http://localhost:${port})`);

const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

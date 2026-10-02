import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGameServer } from './app';

// Both server/src (dev) and server/dist (built) sit two levels below the repo root.
const webDir = process.env.WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const port = Number(process.env.PORT) || 3000;
// All IPv4 interfaces, so other devices on the network can connect. HOST=:: also takes IPv6.
const host = process.env.HOST ?? '0.0.0.0';

if (!existsSync(webDir)) console.warn(`No frontend at ${webDir}: run \`pnpm build\` first (or wait for \`pnpm dev\` to finish its first build).`);
const server = createGameServer({ webDir });
await server.listen(port, host);
console.log(`airhockey server listening on ${host}:${port} (http://localhost:${port})`);

const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

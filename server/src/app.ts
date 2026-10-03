import { decodeClient } from '@airhockey/shared/binary';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import { WebSocketServer, type RawData } from 'ws';
import { CLOSE_IDLE, MAX_FRAME_BYTES, cleanName, type ClientMsg } from '@airhockey/shared/protocol';
import { GuestAuth, type AuthProvider } from './auth';
import { BUILD_ID } from './build';
import { Client } from './client';
import { DEFAULT_CONFIG, type ServerConfig } from './config';
import { Hub } from './hub';
import { clientIp, ipKey } from './limits';
import { originAllowed, securityHeaders } from './security';

/** Over-the-rate messages a connection may send before it is closed. */
const MAX_DROPPED = 1000;

export interface GameServer {
  hub: Hub;
  http: Server;
  /** Starts listening (port 0 picks a free one) and resolves to the port. */
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export function createGameServer(overrides: Partial<ServerConfig> = {}, auth: AuthProvider = new GuestAuth()): GameServer {
  const cfg: ServerConfig = { ...DEFAULT_CONFIG, ...overrides };
  const hub = new Hub(cfg);
  const appOrigin = new URL(cfg.appUrl).origin;

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders(cfg.appUrl));
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  if (cfg.webDir) {
    // The page carries this run's build id, so it is never cached: a reload always gets the current one.
    const indexFile = join(cfg.webDir, 'index.html');
    app.get(['/', '/index.html'], async (_req, res, next) => {
      let html: string;
      try {
        html = await readFile(indexFile, 'utf8');
      } catch {
        return next();
      }
      res.set('Cache-Control', 'no-cache').type('html').send(html.replace('<head>', `<head>\n    <meta name="build" content="${BUILD_ID}" />`));
    });
    // The built frontend, same in dev and production; /privacy finds privacy.html.
    app.use(express.static(cfg.webDir, { index: false, extensions: ['html'] }));
  }

  const http = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const clients = new Set<Client>();
  /** Open (or opening) websockets per address (per /64 block for IPv6). */
  const perIp = new Map<string, number>();
  let open = 0;

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (!originAllowed(req, appOrigin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const ip = ipKey(clientIp(req, cfg.trustProxy));
    const fromIp = perIp.get(ip) ?? 0;
    if (fromIp >= cfg.maxConnsPerIp || open >= cfg.maxConns) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    // Counted from now until the socket closes, whether or not the handshake succeeds.
    perIp.set(ip, fromIp + 1);
    open++;
    socket.once('close', () => {
      open--;
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n > 0) perIp.set(ip, n);
      else perIp.delete(ip);
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
      const { identity, token } = auth.identify(url.searchParams.get('token') ?? undefined);
      const client = new Client(ws, identity.id, cleanName(url.searchParams.get('name')));
      clients.add(client);
      hub.connected(client);
      client.send({ t: 'hello', id: identity.id, token, build: BUILD_ID });
      ws.on('message', (data: RawData, isBinary: boolean) => {
        client.lastSeen = Date.now();
        if (!(isBinary ? client.inputRate : client.commandRate).take()) {
          // Over the rate: dropped. A real client never gets here; one that keeps flooding is cut off.
          if (++client.dropped > MAX_DROPPED) ws.terminate();
          return;
        }
        let msg: ClientMsg | null;
        if (isBinary) {
          const buf = data as Buffer;
          msg = decodeClient(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
          if (!msg) return;
        } else {
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }
        }
        if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
        if (msg.t !== 'ping') client.lastActive = Date.now();
        try {
          hub.handle(client, msg);
        } catch (err) {
          console.error('handler error', err);
        }
      });
      ws.on('pong', () => {
        client.lastSeen = Date.now();
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        clients.delete(client);
        hub.disconnect(client);
      });
    });
  });

  // Ping everyone; drop connections that have been silent for three beats, and close idle ones.
  const beat = setInterval(() => {
    const now = Date.now();
    for (const c of clients) {
      if (now - c.lastSeen > cfg.heartbeat * 3) c.ws.terminate();
      else if (now - c.lastActive > cfg.idleTimeout) c.ws.close(CLOSE_IDLE, 'idle');
      else c.ws.ping();
    }
  }, cfg.heartbeat);

  return {
    hub,
    http,
    listen: (port, host = '0.0.0.0') =>
      new Promise<number>((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, host, () => resolve((http.address() as AddressInfo).port));
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(beat);
        hub.close();
        for (const c of clients) c.ws.terminate();
        wss.close();
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}

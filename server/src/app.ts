import { decodeClient } from '@airhockey/shared/binary';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import { WebSocketServer, type RawData } from 'ws';
import { MAX_FRAME_BYTES, cleanName, type ClientMsg } from '@airhockey/shared/protocol';
import { GuestAuth, type AuthProvider } from './auth';
import { BUILD_ID } from './build';
import { Client } from './client';
import { DEFAULT_CONFIG, type ServerConfig } from './config';
import { Hub } from './hub';

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

  const app = express();
  app.disable('x-powered-by');
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
    app.use(express.static(cfg.webDir, { index: false })); // the built frontend, same in dev and production
  }

  const http = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const clients = new Set<Client>();

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const { identity, token } = auth.identify(url.searchParams.get('token') ?? undefined);
      const client = new Client(ws, identity.id, cleanName(url.searchParams.get('name')));
      clients.add(client);
      hub.connected(client);
      client.send({ t: 'hello', id: identity.id, token, build: BUILD_ID });
      ws.on('message', (data: RawData, isBinary: boolean) => {
        client.lastSeen = Date.now();
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

  // Ping everyone; drop connections that have been silent for three beats.
  const beat = setInterval(() => {
    const now = Date.now();
    for (const c of clients) {
      if (now - c.lastSeen > cfg.heartbeat * 3) c.ws.terminate();
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

import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { decodeServer } from '@airhockey/shared/binary';
import { createGameServer, type GameServer } from '../src/app';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Msg = Record<string, any> & { t: string };

export const TEST_CONFIG = { pauseBudget: 0.3, countdown: 0.05, grace: 200, heartbeat: 1000 };

export async function startServer() {
  const server = createGameServer(TEST_CONFIG);
  const port = await server.listen(0);
  return { server, port };
}

export const newToken = () => randomBytes(16).toString('hex');

/** A websocket client that records everything it receives. */
export class TestClient {
  readonly history: Msg[] = [];
  private cursor = 0;
  private waiters: (() => void)[] = [];
  ws!: WebSocket;
  id = '';

  constructor(
    private port: number,
    readonly token = newToken(),
    readonly name = 'Player',
  ) {}

  async open() {
    this.ws = new WebSocket(`ws://localhost:${this.port}/ws?token=${this.token}&name=${encodeURIComponent(this.name)}`);
    this.ws.on('message', (d, isBinary) => {
      const buf = d as Buffer;
      const msg = isBinary ? decodeServer(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)) : JSON.parse(d.toString());
      if (msg) this.history.push(msg as Msg);
      for (const w of this.waiters.splice(0)) w();
    });
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    const hello = await this.next((m) => m.t === 'hello');
    this.id = hello.id;
    return this;
  }

  send(msg: Msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Next unread message matching `pred`; earlier non-matching ones are skipped. */
  async next(pred: (m: Msg) => boolean, timeout = 4000): Promise<Msg> {
    const deadline = Date.now() + timeout;
    for (;;) {
      while (this.cursor < this.history.length) {
        const m = this.history[this.cursor++];
        if (pred(m)) return m;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        const tail = this.history.slice(-6).map((m) => JSON.stringify(m).slice(0, 120));
        throw new Error(`timeout waiting for message; last: ${tail.join(' | ')}`);
      }
      await new Promise<void>((res) => {
        const t = setTimeout(res, left);
        this.waiters.push(() => {
          clearTimeout(t);
          res();
        });
      });
    }
  }

  nextType(t: string, timeout?: number) {
    return this.next((m) => m.t === t, timeout);
  }

  /** The newest `room` message that satisfies `pred` (waits for one if none yet). */
  async room(pred: (m: Msg) => boolean = () => true) {
    const found = [...this.history].reverse().find((m) => m.t === 'room' && pred(m));
    return found ?? this.next((m) => m.t === 'room' && pred(m));
  }

  /** Drop the cursor to the end: ignore everything received so far. */
  skip() {
    this.cursor = this.history.length;
  }

  close() {
    this.ws.close();
  }

  async closed() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise((res) => this.ws.once('close', res));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type { GameServer };

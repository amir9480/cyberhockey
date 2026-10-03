import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import type { Conn } from '@airhockey/shared/host/conn';
import type { Room } from '@airhockey/shared/host/room';
import type { ErrorCode, ServerMsg } from '@airhockey/shared/protocol';
import { Bucket } from './limits';

/** A client that lets this much data pile up unsent is dropped instead of stalling its room. */
export const MAX_BUFFERED = 1_000_000;

/** One websocket connection (one per browser tab). */
export class Client implements Conn {
  room: Room | null = null;
  lobby = false;
  lastSeen = Date.now();
  /** Last message other than a keep-alive ping: what the player did, not what their tab does by itself. */
  lastActive = Date.now();
  /** Round trip the client last reported, ms (0: unknown). */
  rtt = 0;
  /** This connection (not player): what P2P signalling is addressed to. */
  readonly sid = randomBytes(8).toString('hex');
  /** Binary frames (mallet input, sent every frame). */
  readonly inputRate = new Bucket(500, 1000);
  /** JSON messages (commands, pings, WebRTC set-up). */
  readonly commandRate = new Bucket(30, 120);
  /** Messages dropped for going over a rate. */
  dropped = 0;

  constructor(
    readonly ws: WebSocket,
    readonly id: string,
    public name: string,
  ) {}

  send(msg: ServerMsg | string | Uint8Array) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED) {
      this.ws.terminate();
      return;
    }
    if (typeof msg === 'string') this.ws.send(msg);
    else if (msg instanceof Uint8Array) this.ws.send(msg, { binary: true });
    else this.ws.send(JSON.stringify(msg));
  }

  error(code: ErrorCode, msg: string) {
    this.send({ t: 'error', code, msg });
  }
}

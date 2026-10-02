import { WebSocket } from 'ws';
import type { ServerMsg } from '@airhockey/shared/protocol';
import type { Room } from './room';

/** A client that lets this much data pile up unsent is dropped instead of stalling its room. */
export const MAX_BUFFERED = 1_000_000;

/** One websocket connection (one per browser tab). */
export class Client {
  room: Room | null = null;
  lobby = false;
  lastSeen = Date.now();
  /** Round trip the client last reported, ms (0: unknown). */
  rtt = 0;

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

  error(code: Extract<ServerMsg, { t: 'error' }>['code'], msg: string) {
    this.send({ t: 'error', code, msg });
  }
}

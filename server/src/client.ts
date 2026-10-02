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

  constructor(
    readonly ws: WebSocket,
    readonly id: string,
    public name: string,
  ) {}

  send(msg: ServerMsg | string) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED) {
      this.ws.terminate();
      return;
    }
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  error(code: Extract<ServerMsg, { t: 'error' }>['code'], msg: string) {
    this.send({ t: 'error', code, msg });
  }
}

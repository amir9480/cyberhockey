import { decodeServer } from '@airhockey/shared/binary';
import type { ClientMsg, ServerMsg } from '@airhockey/shared/protocol';

type Hello = Extract<ServerMsg, { t: 'hello' }>;

/**
 * A connection to whatever runs this player's room: the server (websocket), a P2P host's browser (WebRTC), or this
 * very browser when it is the P2P host (loopback). Room and game code only use this.
 */
export interface Transport {
  /** Smoothed round-trip time in ms, 0 until measured. */
  readonly rtt: number;
  /** Add this to `Date.now()` for the room runner's clock, ms. */
  readonly clockOffset: number;
  /** Open, and greeted by the other end (`hello`). */
  readonly connected: boolean;
  onMessage: (m: ServerMsg) => void;
  /** Every successful (re)connection, after the other end's `hello`. */
  onOpen: () => void;
  onClose: () => void;
  send(msg: ClientMsg): void;
  /** A binary frame (see `shared/src/binary.ts`). */
  sendBytes(bytes: Uint8Array): void;
  close(): void;
}

const PING_EVERY = 2000;

/** What every transport does the same: decoding, the `hello` greeting, and pings for round trip and clock offset. */
export abstract class BaseTransport implements Transport {
  rtt = 0;
  clockOffset = 0;
  connected = false;
  /** Has been greeted at least once. */
  opened = false;
  onMessage: (m: ServerMsg) => void = () => {};
  onOpen: () => void = () => {};
  onClose: () => void = () => {};
  private samples: { rtt: number; off: number }[] = [];
  private pinger: ReturnType<typeof setInterval> | null = null;
  private bursts: ReturnType<typeof setTimeout>[] = [];

  send(msg: ClientMsg) {
    this.write(JSON.stringify(msg));
  }

  sendBytes(bytes: Uint8Array) {
    this.write(bytes);
  }

  abstract close(): void;

  /** Puts one message on the wire. */
  protected abstract write(data: string | Uint8Array): void;

  /** The other end greeted us. */
  protected greeted(_m: Hello) {}

  /** One message off the wire. */
  protected receive(data: string | ArrayBuffer | Uint8Array) {
    if (typeof data !== 'string') {
      const bin = decodeServer(data);
      if (bin) this.onMessage(bin);
      return;
    }
    let m: ServerMsg;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.t === 'pong') {
      const sample = performance.now() - m.c;
      this.rtt = this.rtt ? this.rtt * 0.8 + sample * 0.2 : sample;
      // The offset from the quickest recent round trip is the most trustworthy one.
      this.samples.push({ rtt: sample, off: m.st + sample / 2 - Date.now() });
      if (this.samples.length > 8) this.samples.shift();
      this.clockOffset = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
      return;
    }
    if (m.t === 'hello') {
      this.greeted(m);
      this.connected = true;
      this.opened = true;
      this.startPing();
      this.onMessage(m);
      this.onOpen();
      return;
    }
    this.onMessage(m);
  }

  /** The connection closed. */
  protected lost() {
    this.connected = false;
    this.stopPing();
    this.onClose();
  }

  /** Forget the measurements (a fresh connection may be to somewhere else). */
  protected resetStats() {
    this.rtt = 0;
    this.samples = [];
    this.clockOffset = 0;
  }

  private startPing() {
    this.stopPing();
    const ping = () => this.send({ t: 'ping', c: performance.now(), rtt: Math.round(this.rtt) });
    ping();
    // A quick burst, so the clock is known before the first game starts.
    this.bursts = [100, 250, 500].map((ms) => setTimeout(ping, ms));
    this.pinger = setInterval(ping, PING_EVERY);
  }

  protected stopPing() {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
    for (const b of this.bursts) clearTimeout(b);
    this.bursts = [];
  }
}

/** Stands in while there is no connection: sends go nowhere. */
export class NoTransport implements Transport {
  readonly rtt = 0;
  readonly clockOffset = 0;
  readonly connected = false;
  onMessage = () => {};
  onOpen = () => {};
  onClose = () => {};
  send() {}
  sendBytes() {}
  close() {}
}

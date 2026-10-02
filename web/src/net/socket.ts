import { decodeServer } from '@airhockey/shared/binary';
import type { ClientMsg, ServerMsg } from '@airhockey/shared/protocol';
import { adoptToken, getName, getToken } from './identity';

const PING_EVERY = 2000;
/** Debug: `?lag=200` delays every message each way by that many ms (plus a little jitter), to test a bad connection. */
const LAG = Math.max(0, Number(new URLSearchParams(location.search).get('lag')) || 0);
/** Delivery times only ever move forward, as they do on a real (TCP) connection: messages are late but in order. */
function lagger() {
  let last = 0;
  return (fn: () => void) => {
    if (!LAG) return fn();
    last = Math.max(last, performance.now() + LAG + Math.random() * LAG * 0.1);
    setTimeout(fn, last - performance.now());
  };
}
const lagOut = lagger();
const lagIn = lagger();
const BACKOFF = [300, 600, 1200, 2500, 5000];

/** One websocket to the server, reconnecting with backoff. Measures a smoothed round-trip time. */
export class Socket {
  /** Smoothed round-trip time in ms, 0 until measured. */
  rtt = 0;
  /** Add this to `Date.now()` for the server's clock, ms. */
  clockOffset = 0;
  connected = false;
  onMessage: (m: ServerMsg) => void = () => {};
  /** Every successful (re)connection, after the server's `hello`. */
  onOpen: () => void = () => {};
  onClose: () => void = () => {};
  private ws: WebSocket | null = null;
  private wanted = false;
  private tries = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private samples: { rtt: number; off: number }[] = [];
  private pinger: ReturnType<typeof setInterval> | null = null;

  connect() {
    this.wanted = true;
    this.open();
  }

  close() {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this.rtt = 0;
    this.samples = [];
    this.clockOffset = 0;
    ws?.close();
  }

  send(msg: ClientMsg) {
    lagOut(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    });
  }

  /** A binary frame (see `shared/src/binary.ts`). */
  sendBytes(bytes: Uint8Array) {
    lagOut(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(bytes.buffer as ArrayBuffer);
    });
  }

  private open() {
    if (this.ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ token: getToken(), name: getName() ?? '' });
    const ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    const handle = (e: MessageEvent) => {
      if (typeof e.data !== 'string') {
        const bin = decodeServer(e.data as ArrayBuffer);
        if (bin) this.onMessage(bin);
        return;
      }
      let m: ServerMsg;
      try {
        m = JSON.parse(e.data);
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
        adoptToken(m.token);
        this.connected = true;
        this.tries = 0;
        this.startPing();
        this.onMessage(m);
        this.onOpen();
        return;
      }
      this.onMessage(m);
    };
    ws.onmessage = (e) => lagIn(() => handle(e));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.stopPing();
      this.onClose();
      if (this.wanted) this.retry = setTimeout(() => this.open(), BACKOFF[Math.min(this.tries++, BACKOFF.length - 1)]);
    };
    ws.onerror = () => {};
  }

  private startPing() {
    this.stopPing();
    const ping = () => this.send({ t: 'ping', c: performance.now() });
    ping();
    // A quick burst, so the server clock is known before the first game starts.
    for (const ms of [100, 250, 500]) setTimeout(ping, ms);
    this.pinger = setInterval(ping, PING_EVERY);
  }

  private stopPing() {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
  }
}

import type { ClientMsg, ServerMsg } from '@airhockey/shared/protocol';
import { adoptToken, getName, getToken } from './identity';

const PING_EVERY = 2000;
const BACKOFF = [300, 600, 1200, 2500, 5000];

/** One websocket to the server, reconnecting with backoff. Measures a smoothed round-trip time. */
export class Socket {
  /** Smoothed round-trip time in ms, 0 until measured. */
  rtt = 0;
  connected = false;
  onMessage: (m: ServerMsg) => void = () => {};
  /** Every successful (re)connection, after the server's `hello`. */
  onOpen: () => void = () => {};
  onClose: () => void = () => {};
  private ws: WebSocket | null = null;
  private wanted = false;
  private tries = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
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
    ws?.close();
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private open() {
    if (this.ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ token: getToken(), name: getName() ?? '' });
    const ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
    this.ws = ws;
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let m: ServerMsg;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'pong') {
        const sample = performance.now() - m.c;
        this.rtt = this.rtt ? this.rtt * 0.8 + sample * 0.2 : sample;
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
    this.pinger = setInterval(ping, PING_EVERY);
  }

  private stopPing() {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
  }
}

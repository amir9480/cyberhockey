import type { ServerMsg } from '@airhockey/shared/protocol';
import { adoptToken, getName, getToken } from './identity';
import { BaseTransport } from './transport';

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

/** The server run this page came from (stamped in by the server; absent under the Vite dev server). */
const PAGE_BUILD = document.querySelector<HTMLMetaElement>('meta[name="build"]')?.content;
const RELOADED_KEY = 'airhockey.reloadedFor';

/**
 * True when the server has restarted (a deploy) since this page loaded, so the page should reload. Only once per
 * server build, so a page served stale despite `no-cache` can't loop.
 */
function staleBuild(build: string | undefined): boolean {
  if (!PAGE_BUILD || !build || build === PAGE_BUILD) return false;
  try {
    if (sessionStorage.getItem(RELOADED_KEY) === build) return false;
    sessionStorage.setItem(RELOADED_KEY, build);
  } catch {
    return false;
  }
  return true;
}

/** One websocket to the server, reconnecting with backoff. Measures a smoothed round-trip time. */
export class Socket extends BaseTransport {
  private ws: WebSocket | null = null;
  private wanted = false;
  private tries = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;

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
    this.resetStats();
    ws?.close();
  }

  protected write(data: string | Uint8Array) {
    lagOut(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send(typeof data === 'string' ? data : (data.buffer as ArrayBuffer));
    });
  }

  protected greeted(m: Extract<ServerMsg, { t: 'hello' }>) {
    if (staleBuild(m.build)) {
      location.reload();
      return;
    }
    adoptToken(m.token);
    this.tries = 0;
  }

  private open() {
    if (this.ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ token: getToken(), name: getName() ?? '' });
    const ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => lagIn(() => this.receive(e.data as string | ArrayBuffer));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.lost();
      if (this.wanted) this.retry = setTimeout(() => this.open(), BACKOFF[Math.min(this.tries++, BACKOFF.length - 1)]);
    };
    ws.onerror = () => {};
  }
}

import type { IncomingMessage } from 'node:http';
import { isIPv6 } from 'node:net';

/** Token bucket: `rate` actions a second on average, up to `burst` at once. */
export class Bucket {
  private tokens: number;
  private at = Date.now();

  constructor(
    private rate: number,
    private burst: number,
  ) {
    this.tokens = burst;
  }

  /** Spends a token; false when there is none left. */
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

/**
 * The address a request came from. Behind `trustProxy` reverse proxies, each appends the address it saw to
 * X-Forwarded-For, so the client is that many entries from the end (anything earlier the client could have forged).
 */
export function clientIp(req: IncomingMessage, trustProxy: number): string {
  let ip = req.socket.remoteAddress ?? '';
  if (trustProxy > 0) {
    const chain = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (chain.length) ip = chain[Math.max(0, chain.length - trustProxy)];
  }
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * What per-address limits count by: an IPv4 address as is, an IPv6 address by its /64 block (one home or phone gets a
 * whole /64, so its single addresses cost nothing to change).
 */
export function ipKey(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const addr = ip.split('%')[0]; // zone id
  const [head, tail] = addr.split('::') as [string, string | undefined];
  const groups = (s: string | undefined) => (s ? s.split(':') : []);
  // An embedded IPv4 tail (a.b.c.d) takes the place of two groups.
  const width = (g: string[]) => g.reduce((n, x) => n + (x.includes('.') ? 2 : 1), 0);
  const h = groups(head);
  const t = groups(tail);
  const full = tail === undefined ? h : [...h, ...Array<string>(8 - width(h) - width(t)).fill('0'), ...t];
  return `${full
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

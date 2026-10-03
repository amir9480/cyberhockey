import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ipKey } from '../src/limits';
import { CLOSE_IDLE } from '@airhockey/shared/protocol';
import { TestClient, newToken, sleep, startServer, type GameServer } from './helpers';

let server: GameServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

/** Opens a socket with `origin`; resolves 'open' or the refusal's status code. */
function tryOpen(port: number, origin?: string) {
  return new Promise<string>((res) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=${newToken()}`, origin ? { origin } : {});
    ws.once('open', () => {
      ws.terminate();
      res('open');
    });
    ws.once('unexpected-response', (_req, r) => res(String(r.statusCode)));
    ws.once('error', () => {});
  });
}

describe('origin check', () => {
  it('lets in APP_URL, the same host, and non-browsers; refuses other sites', async () => {
    let port: number;
    ({ server, port } = await startServer({ appUrl: 'https://cyberhockey.example/' }));
    expect(await tryOpen(port, 'https://cyberhockey.example')).toBe('open');
    expect(await tryOpen(port, `http://localhost:${port}`)).toBe('open');
    expect(await tryOpen(port)).toBe('open');
    expect(await tryOpen(port, 'https://evil.example')).toBe('403');
    expect(await tryOpen(port, 'null')).toBe('403');
  });
});

describe('ipKey', () => {
  it('keeps IPv4 and groups IPv6 by /64', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:0db8:0001:0002::1')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(ipKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
  });
});

describe('security headers', () => {
  it('allows embedding, sets the usual headers, and HSTS only over https', async () => {
    let port: number;
    ({ server, port } = await startServer({ appUrl: 'https://cyberhockey.example' }));
    const r = await fetch(`http://localhost:${port}/api/health`);
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('frame-ancestors *');
    expect(csp).toContain("object-src 'none'");
    expect(r.headers.get('x-frame-options')).toBeNull();
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(r.headers.get('permissions-policy')).toContain('camera=()');
    await server.close();

    ({ server, port } = await startServer());
    const local = await fetch(`http://localhost:${port}/api/health`);
    expect(local.headers.get('strict-transport-security')).toBeNull();
    expect(local.headers.get('content-security-policy')).not.toContain('upgrade-insecure-requests');
  });
});

describe('idle connections', () => {
  it('closes a connection that only pings, and keeps one that is used', async () => {
    let port: number;
    ({ server, port } = await startServer({ idleTimeout: 300, heartbeat: 100 }));
    const open = () => new TestClient(port).open();
    const [idle, busy] = await Promise.all([open(), open()]);
    const closed = new Promise<number>((res) => idle.ws.once('close', (code) => res(code)));
    const pinger = setInterval(() => idle.send({ t: 'ping', c: 0 }), 50);
    const user = setInterval(() => busy.send({ t: 'lobby' }), 50);
    expect(await closed).toBe(CLOSE_IDLE);
    clearInterval(pinger);
    await sleep(200);
    expect(busy.ws.readyState).toBe(WebSocket.OPEN);
    clearInterval(user);
    busy.ws.terminate();
  });
});

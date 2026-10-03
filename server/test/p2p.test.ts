import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestClient, newToken, startServer, type GameServer } from './helpers';

let server: GameServer;
let port: number;
let clients: TestClient[] = [];

beforeEach(async () => {
  ({ server, port } = await startServer());
  clients = [];
});
afterEach(async () => {
  for (const c of clients) c.ws?.terminate();
  await server.close();
});

async function connect(name = 'Player') {
  const c = await new TestClient(port, newToken(), name).open();
  clients.push(c);
  return c;
}

const report = (id: string, extra: Record<string, unknown> = {}) => ({
  t: 'p2pHost',
  room: { id, host: 'Hosty', players: 1, cap: 4, status: 'lobby', winScore: 10, malletScale: 1, public: true, quick: false, fresh: false, ...extra },
});

describe('P2P registry', () => {
  it('creates, lists, finds and forgets a hosted room', async () => {
    const host = await connect('Hosty');
    const watcher = await connect('Watcher');
    watcher.send({ t: 'lobby' });
    expect((await watcher.nextType('lobby')).p2p).toEqual([]);

    host.send({ t: 'p2pCreate', public: true });
    const made = await host.nextType('p2pRoom');
    expect(made.peer).toBeNull();
    expect(made.host).toEqual({ public: true, quick: false, cap: 4 });

    host.send(report(made.room));
    const listed = await watcher.next((m) => m.t === 'lobby' && m.p2p.length === 1);
    expect(listed.p2p[0]).toMatchObject({ id: made.room, host: 'Hosty', players: 1, cap: 4 });
    const peer = listed.p2p[0].peer as string;

    const joiner = await connect('Joiner');
    joiner.send({ t: 'p2pFind', room: made.room });
    expect(await joiner.nextType('p2pRoom')).toMatchObject({ room: made.room, peer });

    host.close();
    await watcher.next((m) => m.t === 'lobby' && m.p2p.length === 0);
  });

  it('sanitises what a host reports and ignores reports for rooms it does not own', async () => {
    const host = await connect('Hosty');
    const other = await connect('Other');
    other.send({ t: 'lobby' });
    host.send({ t: 'p2pCreate', public: true });
    const { room } = await host.nextType('p2pRoom');
    host.send(report(room, { players: 99, winScore: 5000, host: '' }));
    const listed = await other.next((m) => m.t === 'lobby' && m.p2p.length === 1 && m.p2p[0].players === 4);
    expect(listed.p2p[0]).toMatchObject({ players: 4, winScore: 100, host: 'Room' });

    other.send(report(room, { host: 'Thief', players: 2 }));
    other.send({ t: 'p2pUnhost', room });
    host.send(report(room, { players: 3 }));
    const after = await other.next((m) => m.t === 'lobby' && m.p2p[0]?.players === 3);
    expect(after.p2p[0].host).toBe('Hosty');
  });

  it('an unknown code makes the asker host it under that code', async () => {
    const a = await connect();
    a.send({ t: 'p2pFind', room: 'abcdefgh' });
    expect(await a.nextType('p2pRoom')).toMatchObject({ room: 'abcdefgh', peer: null, host: { public: false, quick: false, cap: 4 } });
  });

  it('quick play: the first hosts, the next joins them', async () => {
    const a = await connect('A');
    const b = await connect('B');
    const c = await connect('C');
    a.send({ t: 'p2pQuick', size: 2 });
    const first = await a.nextType('p2pRoom');
    expect(first.host).toEqual({ public: false, quick: true, cap: 2 });

    b.send({ t: 'p2pQuick', size: 2 });
    const second = await b.nextType('p2pRoom');
    expect(second.room).toBe(first.room);
    expect(typeof second.peer).toBe('string');

    // The seat b took is counted at once: c gets a room of its own.
    c.send({ t: 'p2pQuick', size: 2 });
    const third = await c.nextType('p2pRoom');
    expect(third.room).not.toBe(first.room);
    expect(third.peer).toBeNull();
  });

  it('relays signals to hosts with the sender vouched for, and refuses others', async () => {
    const host = await connect('Hosty');
    const joiner = await connect('Joiner');
    const stranger = await connect('Stranger');
    host.send({ t: 'p2pCreate', public: true });
    const { room } = await host.nextType('p2pRoom');
    joiner.send({ t: 'p2pFind', room });
    const { peer } = await joiner.nextType('p2pRoom');

    joiner.send({ t: 'signal', to: peer, data: { l: 'link1', k: 'offer', sdp: 'v=0' } });
    const got = await host.nextType('signal');
    expect(got).toMatchObject({ id: joiner.id, name: 'Joiner', data: { l: 'link1', k: 'offer', sdp: 'v=0' } });

    // The host answers the joiner: allowed, since the sender is a host.
    host.send({ t: 'signal', to: got.from, data: { l: 'link1', k: 'answer', sdp: 'v=0' } });
    expect((await joiner.nextType('signal')).data).toMatchObject({ k: 'answer' });

    // Neither end hosts: refused, as a goodbye on that link.
    joiner.send({ t: 'signal', to: got.from, data: { l: 'link2', k: 'offer', sdp: 'v=0' } });
    expect((await joiner.nextType('signal')).data).toEqual({ k: 'bye', l: 'link2' });
    stranger.skip();
    expect(stranger.history.some((m) => m.t === 'signal')).toBe(false);
  });
});

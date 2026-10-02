import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestClient, newToken, sleep, startServer, type GameServer } from './helpers';

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

async function connect(name = 'Player', token = newToken()) {
  const c = await new TestClient(port, token, name).open();
  clients.push(c);
  return c;
}

/** Host creates a room, the others join it and ready up. Returns the room id. */
async function setupRoom(host: TestClient, others: TestClient[], isPublic = false) {
  host.send({ t: 'create', public: isPublic });
  const room = await host.nextType('room');
  for (const o of others) {
    o.send({ t: 'join', room: room.id });
    await o.room((m) => m.id === room.id);
    o.send({ t: 'ready', on: true });
  }
  await host.room((m) => m.members.length === others.length + 1 && m.members.every((x: any) => x.id === host.id || x.ready));
  return room.id as string;
}

describe('custom room flow', () => {
  it('create, join, ready, start, pause, vote kick, forfeit', async () => {
    const host = await connect('Host');
    const watcher = await connect('Watcher');
    watcher.send({ t: 'lobby' });
    expect((await watcher.nextType('lobby')).rooms).toEqual([]);

    host.send({ t: 'create', public: true, winScore: 500, malletScale: 1.33 });
    const created = await host.nextType('room');
    expect(created.settings).toEqual({ winScore: 100, malletScale: 1.35 });
    expect(created.host).toBe(host.id);
    expect(created.id).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/);

    const list = await watcher.next((m) => m.t === 'lobby' && m.rooms.length === 1);
    expect(list.rooms[0]).toMatchObject({ id: created.id, host: 'Host', players: 1, cap: 4, status: 'lobby', winScore: 100, malletScale: 1.35 });

    const guest = await connect('  Bob\u0000  ');
    guest.send({ t: 'join', room: created.id });
    const joined = await guest.room((m) => m.members.length === 2);
    expect(joined.members.map((m: any) => m.name)).toEqual(['Host', 'Bob']);

    // Colours are unique: taking the host's colour fails.
    const hostColor = joined.members[0].color;
    expect(joined.members[1].color).not.toBe(hostColor);
    guest.send({ t: 'color', color: hostColor });
    expect((await guest.nextType('error')).code).toBe('color_taken');

    host.send({ t: 'start' });
    const err = await host.nextType('error');
    expect(err.code).toBe('cannot_start');

    guest.send({ t: 'start' }); // non-host: ignored
    guest.send({ t: 'ready', on: true });
    await host.room((m) => m.members.find((x: any) => x.id === guest.id)?.ready);
    host.skip();
    guest.send({ t: 'start' });
    await sleep(50);
    expect(host.history.some((m) => m.t === 'start')).toBe(false);

    host.send({ t: 'start' });
    const hs = await host.nextType('start');
    const gs = await guest.nextType('start');
    expect(hs.players).toBe(2);
    expect(new Set([hs.seat, gs.seat]).size).toBe(2);
    expect(hs.seats).toHaveLength(2);
    const snap = await host.nextType('s');
    expect(snap.m).toHaveLength(4);
    expect(snap.b).toHaveLength(2);

    const playing = await watcher.next((m) => m.t === 'lobby' && m.rooms[0]?.status === 'playing');
    expect(playing.rooms).toHaveLength(1);

    // Guest pauses, spends the budget, becomes kickable; the host votes them out.
    guest.send({ t: 'pause' });
    const p1 = await host.next((m) => m.t === 'pause' && m.paused.length === 1);
    expect(p1.paused[0]).toMatchObject({ id: guest.id, kickable: false, need: 1 });
    const p2 = await host.next((m) => m.t === 'pause' && m.paused[0]?.kickable);
    expect(p2.paused[0].left).toBe(0);
    host.send({ t: 'vote', id: guest.id });
    expect((await guest.nextType('left')).reason).toBe('kicked');
    const over = await host.nextType('over');
    expect(over.reason).toBe('forfeit');
    expect(over.winner).toBe(hs.seat);
    const back = await host.room((m) => m.status === 'lobby' && m.members.length === 1);
    expect(back.members[0].id).toBe(host.id);
  });

  it('does not accept a vote before the budget is spent', async () => {
    const [a, b] = [await connect('A'), await connect('B')];
    await setupRoom(a, [b]);
    a.send({ t: 'start' });
    await a.nextType('start');
    b.send({ t: 'pause' });
    await a.next((m) => m.t === 'pause' && m.paused.length === 1);
    a.send({ t: 'vote', id: b.id });
    await sleep(100);
    expect(b.history.some((m) => m.t === 'left')).toBe(false);
  });

  it('resume starts a countdown', async () => {
    const [a, b] = [await connect('A'), await connect('B')];
    await setupRoom(a, [b]);
    a.send({ t: 'start' });
    await a.nextType('start');
    a.send({ t: 'pause' });
    await b.next((m) => m.t === 'pause' && m.paused.length === 1);
    a.send({ t: 'resume' });
    await b.next((m) => m.t === 'pause' && m.paused.length === 0);
    b.skip();
    const s = await b.next((m) => m.t === 's' && m.cd > 0);
    expect(s.cd).toBeGreaterThan(0);
  });
});

describe('disconnect and reconnect', () => {
  it('turns a dropped seat into AI and lets the player reclaim it', async () => {
    const [a, b, c] = [await connect('A'), await connect('B'), await connect('C')];
    const roomId = await setupRoom(a, [b, c]);
    a.send({ t: 'start' });
    const startB = await b.nextType('start');
    expect(startB.players).toBe(3);
    const bSeat = startB.seat;

    b.close();
    await b.closed();
    const seats = await a.next((m) => m.t === 'seats' && m.seats[bSeat].ai);
    expect(seats.seats[bSeat].ai).toBe(true);

    // Same token: same identity, same seat.
    const b2 = await connect('B', b.token);
    expect(b2.id).toBe(b.id);
    b2.send({ t: 'join', room: roomId });
    const again = await b2.nextType('start');
    expect(again.seat).toBe(bSeat);
    expect(again.seats[bSeat].ai).toBe(false);
    const back = await a.next((m) => m.t === 'seats' && !m.seats[bSeat].ai);
    expect(back.seats[bSeat].ai).toBe(false);
  });

  it('ends the game when only one human is left', async () => {
    const [a, b] = [await connect('A'), await connect('B')];
    await setupRoom(a, [b]);
    a.send({ t: 'start' });
    await a.nextType('start');
    b.close();
    const over = await a.nextType('over');
    expect(over.reason).toBe('forfeit');
  });

  it('lets a late joiner take an AI seat', async () => {
    const [a, b, c] = [await connect('A'), await connect('B'), await connect('C')];
    const roomId = await setupRoom(a, [b, c]);
    a.send({ t: 'start' });
    const sb = await b.nextType('start');
    b.send({ t: 'leave' });
    await b.nextType('left');
    await a.next((m) => m.t === 'seats' && m.seats[sb.seat].ai);
    const d = await connect('D');
    d.send({ t: 'join', room: roomId });
    const sd = await d.nextType('start');
    expect(sd.seat).toBe(sb.seat);
    expect(sd.seats[sb.seat]).toMatchObject({ id: d.id, ai: false });
  });
});

describe('quick play', () => {
  it('groups four players, auto-starts, and gives a fifth a new room', async () => {
    const four = await Promise.all([1, 2, 3, 4].map((i) => connect(`P${i}`)));
    const watcher = await connect('W');
    watcher.send({ t: 'lobby' });
    for (const c of four) {
      c.send({ t: 'quick', size: 4 });
      await c.nextType('room');
    }
    const starts = await Promise.all(four.map((c) => c.nextType('start')));
    expect(new Set(starts.map((s) => s.seat)).size).toBe(4);
    expect(starts[0].players).toBe(4);
    const rooms = await Promise.all(four.map((c) => c.room()));
    expect(new Set(rooms.map((r) => r.id)).size).toBe(1);
    expect(rooms[0].quick).toBe(true);

    const fifth = await connect('P5');
    fifth.send({ t: 'quick', size: 4 });
    const r5 = await fifth.nextType('room');
    expect(r5.id).not.toBe(rooms[0].id);
    expect(r5.members).toHaveLength(1);
    expect(r5.status).toBe('lobby');

    // Quick rooms stay out of the public list.
    expect((await watcher.nextType('lobby')).rooms).toEqual([]);
  });

  it('quick colours are locked', async () => {
    const a = await connect('A');
    a.send({ t: 'quick', size: 2 });
    await a.nextType('room');
    a.send({ t: 'color', color: 3 });
    expect((await a.nextType('error')).code).toBe('color_locked');
  });
});

describe('host and grace', () => {
  it('keeps the host through a reload within the grace period', async () => {
    const [a, b] = [await connect('A'), await connect('B')];
    const roomId = await setupRoom(a, [b]);
    a.close();
    await a.closed();
    await sleep(50);
    const a2 = await connect('A', a.token);
    a2.send({ t: 'join', room: roomId });
    const room = await a2.room((m) => m.id === roomId);
    expect(room.host).toBe(a.id);
    expect(room.members).toHaveLength(2);
    await sleep(350); // past the grace period: still there
    expect((await a2.room()).members).toHaveLength(2);
  });

  it('removes a dropped member after the grace period', async () => {
    const [a, b] = [await connect('A'), await connect('B')];
    await setupRoom(a, [b]);
    b.close();
    const offline = await a.room((m) => m.members.some((x: any) => !x.online));
    expect(offline.members).toHaveLength(2);
    const gone = await a.room((m) => m.members.length === 1);
    expect(gone.members[0].id).toBe(a.id);
  });

  it('passes host to the next member when the host leaves', async () => {
    const [a, b] = [await connect('A'), await connect('B')];
    await setupRoom(a, [b]);
    a.send({ t: 'leave' });
    expect((await a.nextType('left')).reason).toBe('left');
    const room = await b.room((m) => m.host === b.id);
    expect(room.members).toHaveLength(1);
  });

  it('bans a kicked member and reports unknown rooms', async () => {
    const [a, b] = [await connect('A'), await connect('B')];
    const roomId = await setupRoom(a, [b]);
    a.send({ t: 'kick', id: b.id });
    expect((await b.nextType('left')).reason).toBe('kicked');
    b.send({ t: 'join', room: roomId });
    expect((await b.nextType('error')).code).toBe('kicked');
    b.send({ t: 'join', room: 'zzzzzzzz' });
    expect((await b.nextType('error')).code).toBe('not_found');
  });

  it('closes an empty room and drops it from the list', async () => {
    const [a, w] = [await connect('A'), await connect('W')];
    w.send({ t: 'lobby' });
    a.send({ t: 'create', public: true });
    await w.next((m) => m.t === 'lobby' && m.rooms.length === 1);
    a.send({ t: 'leave' });
    await w.next((m) => m.t === 'lobby' && m.rooms.length === 0);
    expect(server.hub.rooms.size).toBe(0);
  });

  it('replaces the connection when the same player joins from a second tab', async () => {
    const a = await connect('A');
    a.send({ t: 'create', public: false });
    const room = await a.nextType('room');
    const a2 = await connect('A', a.token);
    a2.send({ t: 'join', room: room.id });
    expect((await a.nextType('left')).reason).toBe('replaced');
    await a2.room((m) => m.id === room.id);
    a.send({ t: 'settings', winScore: 50 }); // stale connection: ignored
    await sleep(50);
    expect((await a2.room()).settings.winScore).toBe(10);
  });
});

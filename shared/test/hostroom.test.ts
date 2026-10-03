import { afterEach, describe, expect, it } from 'vitest';
import type { Conn, RoomOwner } from '../src/host/conn';
import { Room } from '../src/host/room';
import type { ServerMsg } from '../src/protocol';
import { DEFAULT_ROOM } from '../src/room';

const CFG = { pauseBudget: 1, countdown: 0.05, grace: 100 };

class FakeConn implements Conn {
  room: Room | null = null;
  rtt = 0;
  got: ServerMsg[] = [];
  constructor(
    readonly id: string,
    public name = id,
  ) {}
  send(msg: ServerMsg | string | Uint8Array) {
    if (typeof msg === 'string') this.got.push(JSON.parse(msg));
    else if (!(msg instanceof Uint8Array)) this.got.push(msg);
  }
  error(code: Extract<ServerMsg, { t: 'error' }>['code'], msg: string) {
    this.send({ t: 'error', code, msg });
  }
  last<T extends ServerMsg['t']>(t: T) {
    return [...this.got].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
  }
}

const owner = (): RoomOwner & { closed: number } => ({
  closed: 0,
  roomChanged() {},
  roomClosed() {
    this.closed++;
  },
});

let rooms: Room[] = [];
afterEach(() => {
  for (const r of rooms) r.close();
  rooms = [];
});

function makeRoom(hostBound: boolean) {
  const o = owner();
  const room = new Room('abcdefgh', o, CFG, { public: true, quick: false, cap: 4, settings: { ...DEFAULT_ROOM }, hostBound });
  rooms.push(room);
  const host = new FakeConn('host');
  const guest = new FakeConn('guest');
  room.join(host);
  room.join(guest);
  return { room, o, host, guest };
}

describe('host-bound rooms (P2P)', () => {
  it('end for everyone when the host leaves', () => {
    const { room, o, host, guest } = makeRoom(true);
    room.leave(host);
    expect(guest.last('left')?.reason).toBe('hostLeft');
    expect(o.closed).toBe(1);
  });

  it('end for everyone when the host drops, even mid-game', () => {
    const { room, o, host, guest } = makeRoom(true);
    room.handle(guest, { t: 'ready', on: true });
    room.handle(host, { t: 'start' });
    expect(room.status).toBe('playing');
    room.drop(host);
    expect(guest.last('left')?.reason).toBe('hostLeft');
    expect(o.closed).toBe(1);
  });

  it('a server room passes the host on instead', () => {
    const { room, o, host, guest } = makeRoom(false);
    room.leave(host);
    expect(o.closed).toBe(0);
    expect(room.hostId).toBe(guest.id);
  });
});

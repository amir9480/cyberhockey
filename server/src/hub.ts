import { randomInt } from 'node:crypto';
import { ROOM_ID_ALPHABET, ROOM_ID_LENGTH, cleanName, isRoomId, type ClientMsg, type LobbyRoom } from '@airhockey/shared/protocol';
import { clampMalletScale, clampWinScore } from '@airhockey/shared/room';
import type { Client } from './client';
import type { ServerConfig } from './config';
import { Room, defaultSettings } from './room';

/** All rooms and the public room list. Single instance, in memory. */
export class Hub {
  readonly rooms = new Map<string, Room>();
  private lobbySubs = new Set<Client>();
  /** JSON of each listed room's summary, to tell whether anything actually changed. */
  private summaries = new Map<string, string>();
  private listJson = '{"t":"lobby","rooms":[]}';

  constructor(private cfg: ServerConfig) {}

  handle(client: Client, msg: ClientMsg) {
    switch (msg.t) {
      case 'ping':
        client.send({ t: 'pong', c: Number(msg.c) || 0, st: Date.now() });
        if (Number.isFinite(msg.rtt)) client.rtt = Math.max(0, Math.min(9999, Math.round(Number(msg.rtt))));
        return;
      case 'name':
        client.name = cleanName(msg.name);
        client.room?.rename(client);
        return;
      case 'lobby':
        client.lobby = true;
        this.lobbySubs.add(client);
        client.send(this.listJson);
        return;
      case 'unlobby':
        client.lobby = false;
        this.lobbySubs.delete(client);
        return;
      case 'create': {
        this.leaveCurrent(client);
        const room = this.newRoom({
          public: !!msg.public,
          quick: false,
          cap: 4,
          settings: {
            ...defaultSettings(),
            ...(msg.winScore !== undefined && { winScore: clampWinScore(Number(msg.winScore)) }),
            ...(msg.malletScale !== undefined && { malletScale: clampMalletScale(Number(msg.malletScale)) }),
          },
        });
        room.join(client);
        return;
      }
      case 'join': {
        const room = typeof msg.room === 'string' ? this.rooms.get(msg.room) : undefined;
        if (!room) {
          // An unknown code (a room that has closed, or a typo): start a new private room. Under that code when it is a
          // valid one, so the link keeps working for whoever else follows it.
          this.leaveCurrent(client);
          const opts = { public: false, quick: false, cap: 4, settings: defaultSettings() };
          const fresh = this.newRoom(opts, isRoomId(msg.room) ? msg.room : undefined);
          fresh.join(client);
          return;
        }
        const err = room.canJoin(client.id);
        if (err) return client.error(err, err === 'full' ? 'Room is full' : 'You were kicked from this room');
        if (client.room && client.room !== room) this.leaveCurrent(client);
        room.join(client);
        return;
      }
      case 'quick': {
        const size = msg.size === 4 ? 4 : 2;
        this.leaveCurrent(client);
        let best: Room | null = null;
        for (const r of this.rooms.values()) {
          if (!r.quick || r.cap !== size || r.autoStarted || r.status !== 'lobby' || r.members.size >= r.cap) continue;
          if (r.canJoin(client.id)) continue;
          if (!best || r.members.size > best.members.size) best = r; // fill the fullest first
        }
        const room = best ?? this.newRoom({ public: false, quick: true, cap: size, settings: defaultSettings() });
        room.join(client);
        return;
      }
      case 'leave':
        client.room?.leave(client);
        return;
      default:
        client.room?.handle(client, msg);
    }
  }

  disconnect(client: Client) {
    this.lobbySubs.delete(client);
    client.room?.drop(client);
  }

  private leaveCurrent(client: Client) {
    client.room?.leave(client);
  }

  /** A new room, under `wanted` if given and free, else a random id. */
  private newRoom(opts: ConstructorParameters<typeof Room>[3], wanted?: string) {
    let id = wanted && !this.rooms.has(wanted) ? wanted : '';
    while (!id || this.rooms.has(id)) {
      id = Array.from({ length: ROOM_ID_LENGTH }, () => ROOM_ID_ALPHABET[randomInt(ROOM_ID_ALPHABET.length)]).join('');
    }
    const room = new Room(id, this, this.cfg, opts);
    this.rooms.set(id, room);
    return room;
  }

  /** A room changed: refresh its public-list entry and tell subscribers if the list differs. */
  roomChanged(room: Room) {
    const s = room.summary();
    const json = s ? JSON.stringify(s) : null;
    if ((this.summaries.get(room.id) ?? null) === json) return;
    if (json) this.summaries.set(room.id, json);
    else this.summaries.delete(room.id);
    this.publishList();
  }

  roomClosed(room: Room) {
    this.rooms.delete(room.id);
    this.roomChanged(room);
  }

  private publishList() {
    const listed: LobbyRoom[] = [];
    for (const r of this.rooms.values()) {
      const s = r.summary();
      if (s) listed.push(s);
    }
    // Rooms still in the lobby first, each group oldest first (Map keeps creation order).
    listed.sort((a, b) => Number(a.status === 'playing') - Number(b.status === 'playing'));
    this.listJson = JSON.stringify({ t: 'lobby', rooms: listed });
    for (const c of this.lobbySubs) c.send(this.listJson);
  }

  close() {
    for (const r of [...this.rooms.values()]) r.close();
    this.lobbySubs.clear();
  }
}

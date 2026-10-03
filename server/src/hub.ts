import { handleConnMsg, newRoomId, type RoomOwner } from '@airhockey/shared/host/conn';
import { Room, defaultSettings, type RoomOptions } from '@airhockey/shared/host/room';
import { isRoomId, type ClientMsg, type LobbyRoom } from '@airhockey/shared/protocol';
import { clampMalletScale, clampWinScore } from '@airhockey/shared/room';
import type { Client } from './client';
import type { ServerConfig } from './config';
import { P2pRegistry } from './p2p';

/** All rooms and the public room list (with the P2P rooms players host). Single instance, in memory. */
export class Hub implements RoomOwner {
  readonly rooms = new Map<string, Room>();
  readonly p2p = new P2pRegistry(() => this.publishList());
  private lobbySubs = new Set<Client>();
  /** JSON of each listed room's summary, to tell whether anything actually changed. */
  private summaries = new Map<string, string>();
  private listJson = '{"t":"lobby","rooms":[],"p2p":[]}';
  /** Open connections per player: one browser, several tabs. */
  private byPlayer = new Map<string, Set<Client>>();

  constructor(private cfg: ServerConfig) {}

  connected(client: Client) {
    let tabs = this.byPlayer.get(client.id);
    if (!tabs) this.byPlayer.set(client.id, (tabs = new Set()));
    tabs.add(client);
    this.p2p.connected(client);
  }

  handle(client: Client, msg: ClientMsg) {
    if (handleConnMsg(client, msg)) return;
    const target = this.entering(msg);
    if (target !== undefined && this.inOtherGame(client, target)) {
      return client.error('busy', 'You are already in a game in another tab');
    }
    if (this.p2p.handle(client, msg)) return;
    switch (msg.t) {
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
      default:
        client.room?.handle(client, msg);
    }
  }

  disconnect(client: Client) {
    const tabs = this.byPlayer.get(client.id);
    tabs?.delete(client);
    if (tabs?.size === 0) this.byPlayer.delete(client.id);
    this.lobbySubs.delete(client);
    this.p2p.disconnected(client);
    client.room?.drop(client);
  }

  /**
   * The game `msg` would put its sender in: a server room (`s:<id>`), a P2P room (`p:<id>`), null for a new one, or
   * undefined when it doesn't enter a game at all.
   */
  private entering(msg: ClientMsg): string | null | undefined {
    switch (msg.t) {
      case 'create':
      case 'quick':
      case 'p2pCreate':
      case 'p2pQuick':
        return null;
      case 'join':
        return typeof msg.room === 'string' && this.rooms.has(msg.room) ? `s:${msg.room}` : null;
      case 'p2pFind':
        return typeof msg.room === 'string' && this.p2p.has(msg.room) ? `p:${msg.room}` : null;
      default:
        return undefined;
    }
  }

  /**
   * Another tab of this player is in a game other than `target`: a player plays one game at a time. The same game is
   * fine (the new tab takes the seat over). P2P rooms count only where this player hosts: the server doesn't see who
   * joins them.
   */
  private inOtherGame(client: Client, target: string | null) {
    for (const tab of this.byPlayer.get(client.id) ?? []) {
      if (tab === client) continue;
      const hosted = this.p2p.hostedBy(tab);
      const at = tab.room ? `s:${tab.room.id}` : hosted ? `p:${hosted}` : null;
      if (at && at !== target) return true;
    }
    return false;
  }

  private leaveCurrent(client: Client) {
    client.room?.leave(client);
  }

  /** A new room, under `wanted` if given and free, else a random id. */
  private newRoom(opts: RoomOptions, wanted?: string) {
    let id = wanted && !this.rooms.has(wanted) ? wanted : '';
    while (!id || this.rooms.has(id)) id = newRoomId();
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
    this.listJson = JSON.stringify({ t: 'lobby', rooms: listed, p2p: this.p2p.list() });
    for (const c of this.lobbySubs) c.send(this.listJson);
  }

  close() {
    for (const r of [...this.rooms.values()]) r.close();
    this.lobbySubs.clear();
    this.byPlayer.clear();
  }
}

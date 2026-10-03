import { newRoomId } from '@airhockey/shared/host/conn';
import {
  cleanName,
  isRoomId,
  type ClientMsg,
  type P2pHostOpts,
  type P2pLobbyRoom,
  type P2pRoomInfo,
} from '@airhockey/shared/protocol';
import { clampMalletScale, clampWinScore, DEFAULT_ROOM } from '@airhockey/shared/room';
import type { Client } from './client';

/** Biggest relayed WebRTC message, as JSON. */
const MAX_SIGNAL = 12_000;

interface Hosted {
  info: P2pRoomInfo;
  host: Client;
}

/**
 * P2P rooms run in their host's browser; the server only introduces players. It keeps where each room is hosted (for
 * links, quick play and the public list) and relays the WebRTC set-up messages between connections.
 */
export class P2pRegistry {
  private rooms = new Map<string, Hosted>();
  private bySid = new Map<string, Client>();

  constructor(private onListChange: () => void) {}

  connected(c: Client) {
    this.bySid.set(c.sid, c);
  }

  /** A host's connection closed: its rooms are gone from the list (it re-reports them if it comes back). */
  disconnected(c: Client) {
    this.bySid.delete(c.sid);
    let changed = false;
    for (const [id, r] of this.rooms) {
      if (r.host === c) {
        this.rooms.delete(id);
        changed = true;
      }
    }
    if (changed) this.onListChange();
  }

  /** Handles the P2P messages; false for anything else. */
  handle(c: Client, msg: ClientMsg): boolean {
    switch (msg.t) {
      case 'p2pCreate': {
        const id = this.freeId();
        this.hostNew(c, id, { public: !!msg.public, quick: false, cap: 4 });
        return true;
      }
      case 'p2pFind': {
        const r = typeof msg.room === 'string' ? this.rooms.get(msg.room) : undefined;
        if (r) c.send({ t: 'p2pRoom', room: r.info.id, peer: r.host.sid });
        else this.hostNew(c, isRoomId(msg.room) && !this.rooms.has(msg.room) ? msg.room : this.freeId(), { public: false, quick: false, cap: 4 });
        return true;
      }
      case 'p2pQuick': {
        const size = msg.size === 4 ? 4 : 2;
        let best: Hosted | null = null;
        for (const r of this.rooms.values()) {
          const i = r.info;
          if (r.host === c || !i.quick || !i.fresh || i.cap !== size || i.status !== 'lobby' || i.players >= i.cap) continue;
          if (!best || i.players > best.info.players) best = r; // fill the fullest first
        }
        if (best) {
          // Counted at once, so a burst of quick players doesn't all pile into the last free seat.
          best.info.players++;
          c.send({ t: 'p2pRoom', room: best.info.id, peer: best.host.sid });
        } else this.hostNew(c, this.freeId(), { public: false, quick: true, cap: size });
        return true;
      }
      case 'p2pHost': {
        const info = sanitize(msg.room);
        if (!info) return true;
        const r = this.rooms.get(info.id);
        if (r && r.host !== c) return true; // someone else's
        this.rooms.set(info.id, { info, host: c });
        this.onListChange();
        return true;
      }
      case 'p2pUnhost': {
        const r = typeof msg.room === 'string' ? this.rooms.get(msg.room) : undefined;
        if (r?.host === c) {
          this.rooms.delete(msg.room);
          this.onListChange();
        }
        return true;
      }
      case 'signal': {
        const to = typeof msg.to === 'string' ? this.bySid.get(msg.to) : undefined;
        if (JSON.stringify(msg.data ?? null).length > MAX_SIGNAL) return true;
        // Only to and from hosts: a player can't use the relay to bother arbitrary connections.
        if (!to || !(this.isHost(to) || this.isHost(c))) {
          if (typeof msg.to === 'string') c.send({ t: 'signal', from: msg.to, id: '', name: '', data: { k: 'bye', l: linkOf(msg.data) } });
          return true;
        }
        to.send({ t: 'signal', from: c.sid, id: c.id, name: c.name, data: msg.data });
        return true;
      }
      default:
        return false;
    }
  }

  /** Public P2P rooms, for the lobby list. */
  list(): P2pLobbyRoom[] {
    const out: P2pLobbyRoom[] = [];
    for (const { info, host } of this.rooms.values()) {
      if (!info.public || info.quick || info.players === 0) continue;
      const { id, host: name, players, cap, status, winScore, malletScale } = info;
      out.push({ id, host: name, players, cap, status, winScore, malletScale, peer: host.sid });
    }
    return out.sort((a, b) => Number(a.status === 'playing') - Number(b.status === 'playing'));
  }

  private isHost(c: Client) {
    for (const r of this.rooms.values()) if (r.host === c) return true;
    return false;
  }

  /** Tell `c` to host a new room, holding its place until the host's first report fills it in. */
  private hostNew(c: Client, id: string, opts: P2pHostOpts) {
    this.rooms.set(id, {
      host: c,
      info: {
        id,
        host: c.name,
        players: 1,
        cap: opts.cap,
        status: 'lobby',
        winScore: DEFAULT_ROOM.winScore,
        malletScale: DEFAULT_ROOM.malletScale,
        public: opts.public,
        quick: opts.quick,
        fresh: opts.quick,
      },
    });
    c.send({ t: 'p2pRoom', room: id, peer: null, host: opts });
    this.onListChange();
  }

  private freeId() {
    let id = newRoomId();
    while (this.rooms.has(id)) id = newRoomId();
    return id;
  }
}

/** The link id a signal is about, so a refusal can name it. */
function linkOf(data: unknown): string {
  const l = (data as { l?: unknown } | null)?.l;
  return typeof l === 'string' ? l.slice(0, 32) : '';
}

/** A host's report is just a claim from a browser: keep it to sane values. */
function sanitize(raw: unknown): P2pRoomInfo | null {
  const r = raw as Partial<P2pRoomInfo> | null;
  if (!r || !isRoomId(r.id)) return null;
  const cap = r.cap === 2 || r.cap === 3 ? r.cap : 4;
  return {
    id: r.id,
    host: cleanName(r.host, 'Room'),
    players: Math.max(0, Math.min(cap, Math.floor(Number(r.players)) || 0)),
    cap,
    status: r.status === 'playing' ? 'playing' : 'lobby',
    winScore: clampWinScore(Number(r.winScore)),
    malletScale: clampMalletScale(Number(r.malletScale)),
    public: !!r.public,
    quick: !!r.quick,
    fresh: !!r.fresh,
  };
}

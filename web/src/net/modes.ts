import type { P2pHostOpts, ServerMsg } from '@airhockey/shared/protocol';
import { getName } from './identity';
import { P2pHost } from './p2phost';
import { RtcTransport, type Signaler } from './rtc';
import type { Socket } from './socket';
import { NoTransport, type Transport } from './transport';

export type NetKind = 'server' | 'p2p';

/** Why a mode lost its room's connection for good. */
export type LostReason = 'unreachable' | 'lost';

/**
 * How this player reaches a room: through the server (`ServerMode`), or straight to a player's browser that runs it
 * over WebRTC (`P2pMode`). The multiplayer client only talks to a room through this.
 */
export interface NetMode {
  readonly kind: NetKind;
  /** Room and game traffic. */
  readonly link: Transport;
  /** This player hosts the room (and so runs the game for everyone). */
  readonly hosting: boolean;
  /** A message from the room. */
  onMessage: (m: ServerMsg) => void;
  /** The room's connection is gone for good. */
  onLost: (why: LostReason) => void;
  create(pub: boolean): void;
  join(id: string): void;
  quick(size: 2 | 4): void;
  leave(): void;
  /** The server connection (re)opened. `room`: the room this player should be in, if any. */
  serverOpened(room: string | null): void;
  /** A message from the server other than the lobby list. */
  fromServer(m: ServerMsg): void;
  dispose(): void;
}

/** Rooms on the server: the websocket is the room connection, and it reconnects by itself. */
export class ServerMode implements NetMode {
  readonly kind = 'server';
  readonly hosting = false;
  onMessage: (m: ServerMsg) => void = () => {};
  onLost: (why: LostReason) => void = () => {};

  constructor(private socket: Socket) {}

  get link(): Transport {
    return this.socket;
  }

  create(pub: boolean) {
    this.socket.send({ t: 'create', public: pub });
  }

  join(id: string) {
    this.socket.send({ t: 'join', room: id });
  }

  quick(size: 2 | 4) {
    this.socket.send({ t: 'quick', size });
  }

  leave() {
    this.socket.send({ t: 'leave' });
  }

  serverOpened(room: string | null) {
    if (room) this.join(room);
  }

  fromServer(m: ServerMsg) {
    this.onMessage(m);
  }

  dispose() {
    this.leave();
  }
}

/** Goodbyes get this long to go out before a link closes. */
const FLUSH_MS = 300;

/**
 * P2P rooms: the server only says where a room is hosted. Joining connects over WebRTC to the host's browser;
 * creating (or a quick play nobody is waiting in) makes this browser the host, running the room for everyone.
 */
export class P2pMode implements NetMode {
  readonly kind = 'p2p';
  onMessage: (m: ServerMsg) => void = () => {};
  onLost: (why: LostReason) => void = () => {};
  private current: Transport | null = null;
  private host: P2pHost | null = null;
  /** This player's id, from the server. */
  private me = '';
  private readonly none = new NoTransport();
  private readonly onPageHide = () => this.host?.dispose();

  constructor(
    private socket: Socket,
    private sig: Signaler,
  ) {
    addEventListener('pagehide', this.onPageHide);
  }

  get link(): Transport {
    return this.current ?? this.none;
  }

  get hosting() {
    return !!this.host;
  }

  create(pub: boolean) {
    this.socket.send({ t: 'p2pCreate', public: pub });
  }

  join(id: string) {
    this.socket.send({ t: 'p2pFind', room: id });
  }

  quick(size: 2 | 4) {
    this.socket.send({ t: 'p2pQuick', size });
  }

  leave() {
    const link = this.current;
    const host = this.host;
    this.current = null;
    this.host = null;
    if (!link) return;
    link.onClose = () => {};
    // The room's answer still counts, unless this player has moved on to another room meanwhile.
    link.onMessage = (m) => {
      if (m.t === 'left' && !this.current) this.onMessage(m);
    };
    link.send({ t: 'leave' });
    setTimeout(() => {
      link.close();
      host?.dispose();
    }, FLUSH_MS);
  }

  serverOpened(room: string | null) {
    if (this.host) this.host.report();
    else if (room && !this.current) this.join(room);
  }

  fromServer(m: ServerMsg) {
    if (m.t === 'hello') this.me = m.id;
    else if (m.t === 'p2pRoom') {
      if (m.peer) this.connect(m.peer, m.room);
      else if (m.host) this.hostRoom(m.room, m.host);
    }
  }

  dispose() {
    this.leave();
    removeEventListener('pagehide', this.onPageHide);
  }

  /** Join the room hosted by connection `peer`. */
  private connect(peer: string, room: string) {
    this.leave();
    const t = new RtcTransport(this.sig, peer);
    this.attach(t, room);
    t.onClose = () => {
      if (this.current !== t) return;
      this.current = null;
      this.onLost(t.opened ? 'lost' : 'unreachable');
    };
  }

  /** Become the host of `room`. */
  private hostRoom(room: string, opts: P2pHostOpts) {
    this.leave();
    this.host = new P2pHost(room, opts, this.socket, this.sig, this.me, getName() ?? 'Player');
    this.attach(this.host.local, room);
  }

  private attach(t: Transport, room: string) {
    this.current = t;
    t.onMessage = (m) => this.onMessage(m);
    t.onOpen = () => t.send({ t: 'join', room });
  }
}

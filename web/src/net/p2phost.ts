import { decodeClient } from '@airhockey/shared/binary';
import { DEFAULT_ROOM_CONFIG } from '@airhockey/shared/host/config';
import { handleConnMsg, type Conn, type RoomOwner } from '@airhockey/shared/host/conn';
import { Room } from '@airhockey/shared/host/room';
import { cleanName, type ClientMsg, type ErrorCode, type P2pHostOpts, type P2pRoomInfo, type ServerMsg } from '@airhockey/shared/protocol';
import { DEFAULT_ROOM } from '@airhockey/shared/room';
import { PeerLink, type SignalData, type Signaler } from './rtc';
import type { Socket } from './socket';
import { workerEvery } from './ticker';
import { BaseTransport } from './transport';

/** Most links open at once: players, plus lobby browsers measuring their ping to this room. */
const MAX_LINKS = 16;
/** After the room closes, links stay open this long so the goodbye gets through. */
const FLUSH_MS = 500;

type Wire = string | Uint8Array;

const serialize = (msg: ServerMsg | string | Uint8Array): Wire =>
  typeof msg === 'string' || msg instanceof Uint8Array ? msg : JSON.stringify(msg);

/** A player's connection as the room sees it, on a P2P host: messages go out through `out`. */
class HostConn implements Conn {
  room: Room | null = null;
  rtt = 0;

  constructor(
    readonly id: string,
    public name: string,
    private out: (data: Wire) => void,
  ) {}

  send(msg: ServerMsg | string | Uint8Array) {
    this.out(serialize(msg));
  }

  error(code: ErrorCode, msg: string) {
    this.send({ t: 'error', code, msg });
  }
}

/** The host's own player: talks to the room in this same page. Asynchronous, like a real connection. */
export class LoopbackTransport extends BaseTransport {
  private closed = false;

  constructor(private deliver: (data: Wire) => void) {
    super();
  }

  /** A message from the room. */
  push(data: Wire) {
    queueMicrotask(() => {
      if (!this.closed) this.receive(data);
    });
  }

  protected write(data: Wire) {
    const copy = typeof data === 'string' ? data : data.slice();
    queueMicrotask(() => {
      if (!this.closed) this.deliver(copy);
    });
  }

  close() {
    this.closed = true;
    this.connected = false;
    this.stopPing();
  }
}

/**
 * A P2P room, run in the host's browser: the same `Room` the server runs, with players connected over WebRTC instead
 * of websockets (the host itself through a loopback). The server only keeps the room findable.
 */
export class P2pHost implements RoomOwner {
  readonly room: Room;
  /** The host's own connection to the room. */
  readonly local: LoopbackTransport;
  private localConn: HostConn;
  private links = new Set<PeerLink>();
  private closed = false;

  constructor(
    id: string,
    opts: P2pHostOpts,
    private socket: Socket,
    private sig: Signaler,
    /** The host's player id and name. */
    private me: string,
    name: string,
  ) {
    const room = { public: opts.public, quick: opts.quick, cap: opts.cap, settings: { ...DEFAULT_ROOM }, hostBound: true };
    this.room = new Room(id, this, DEFAULT_ROOM_CONFIG, room, workerEvery);
    this.local = new LoopbackTransport((d) => this.receive(this.localConn, d));
    this.localConn = new HostConn(me, name, (d) => this.local.push(d));
    sig.onOffer = (from, pid, pname, d) => this.accept(from, pid, pname, d);
    this.localConn.send({ t: 'hello', id: me, token: '' });
  }

  /** Tell the server how the room is now (also after the server connection comes back). */
  report() {
    if (this.closed) return;
    const r = this.room;
    const info: P2pRoomInfo = {
      id: r.id,
      host: r.members.get(r.hostId)?.name ?? this.localConn.name,
      players: r.members.size,
      cap: r.cap,
      status: r.status,
      winScore: r.settings.winScore,
      malletScale: r.settings.malletScale,
      public: r.public,
      quick: r.quick,
      fresh: r.quick && !r.autoStarted,
    };
    this.socket.send({ t: 'p2pHost', room: info });
  }

  roomChanged() {
    this.report();
  }

  roomClosed() {
    if (this.closed) return;
    this.closed = true;
    this.socket.send({ t: 'p2pUnhost', room: this.room.id });
    setTimeout(() => this.closeLinks(), FLUSH_MS);
  }

  /** The page is going away: end the room now. */
  dispose() {
    this.room.close('hostLeft');
    this.closeLinks();
    this.local.close();
  }

  private closeLinks() {
    for (const l of [...this.links]) l.close();
    this.sig.onOffer = (from, _id, _name, d) => this.sig.send(from, { l: d.l, k: 'bye' });
  }

  /** Someone connecting: a player joining, or a lobby measuring its ping to us. */
  private accept(from: string, id: string, name: string, offer: SignalData) {
    if (this.closed || !id || this.links.size >= MAX_LINKS) {
      this.sig.send(from, { l: offer.l, k: 'bye' });
      return;
    }
    const link = new PeerLink(this.sig, from, offer.l);
    const conn = new HostConn(id, cleanName(name), (d) => link.send(d));
    this.links.add(link);
    link.onOpen = () => conn.send({ t: 'hello', id, token: '' });
    link.onData = (d) => this.receive(conn, d);
    link.onClose = () => {
      this.links.delete(link);
      conn.room?.drop(conn);
    };
    void link.answer(offer);
  }

  private receive(conn: HostConn, data: string | ArrayBuffer | Uint8Array) {
    let msg: ClientMsg | null;
    if (typeof data === 'string') {
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
    } else msg = decodeClient(data instanceof Uint8Array ? data : new Uint8Array(data));
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    try {
      this.handle(conn, msg);
    } catch (err) {
      console.error('p2p host handler error', err);
    }
  }

  private handle(conn: HostConn, msg: ClientMsg) {
    if (handleConnMsg(conn, msg)) return;
    if (msg.t === 'join') {
      if (this.closed || msg.room !== this.room.id) return conn.error('not_found', 'This room has closed');
      // The host's player id, from somewhere else: the host in another tab. Taking over would end the room.
      if (conn.id === this.me && conn !== this.localConn) return conn.error('not_found', 'You are hosting this room in another tab');
      const err = this.room.canJoin(conn.id);
      if (err) return conn.error(err, err === 'full' ? 'Room is full' : 'You were kicked from this room');
      this.room.join(conn);
      return;
    }
    this.room.handle(conn, msg);
  }
}

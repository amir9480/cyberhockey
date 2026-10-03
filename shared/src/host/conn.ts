import { ROOM_ID_ALPHABET, ROOM_ID_LENGTH, cleanName, type ClientMsg, type ErrorCode, type ServerMsg } from '../protocol';
import type { Room } from './room';

/**
 * One player's connection to whatever runs their room: a websocket on the server, a WebRTC data channel or an
 * in-memory loopback on a P2P host. The room only ever talks through this.
 */
export interface Conn {
  /** Player id (stable across reconnects). */
  readonly id: string;
  name: string;
  room: Room | null;
  /** Round trip the client last reported, ms (0: unknown). */
  rtt: number;
  /** A message, pre-serialised JSON, or a binary frame (see `binary.ts`). */
  send(msg: ServerMsg | string | Uint8Array): void;
  error(code: ErrorCode, msg: string): void;
}

/** Who owns rooms and lists them: the server's hub, or a P2P host. */
export interface RoomOwner {
  roomChanged(room: Room): void;
  roomClosed(room: Room): void;
}

/** Messages any room runner answers the same way. Returns whether `msg` was one of them. */
export function handleConnMsg(conn: Conn, msg: ClientMsg): boolean {
  switch (msg.t) {
    case 'ping':
      conn.send({ t: 'pong', c: Number(msg.c) || 0, st: Date.now() });
      if (Number.isFinite(msg.rtt)) conn.rtt = Math.max(0, Math.min(9999, Math.round(Number(msg.rtt))));
      return true;
    case 'name':
      conn.name = cleanName(msg.name);
      conn.room?.rename(conn);
      return true;
    case 'leave':
      conn.room?.leave(conn);
      return true;
    default:
      return false;
  }
}

/** A random room id. */
export function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_ID_LENGTH));
  return Array.from(bytes, (b) => ROOM_ID_ALPHABET[b % ROOM_ID_ALPHABET.length]).join('');
}

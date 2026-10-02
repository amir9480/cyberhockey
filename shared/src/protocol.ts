import type { PlayerCount } from './layout';
import type { StateFrame } from './binary';
import type { RoomSettings } from './room';

export const ROOM_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const ROOM_ID_LENGTH = 8;
export const NAME_MAX = 16;
export const MAX_FRAME_BYTES = 4096;

/** Cleans a display name: control characters stripped, trimmed, 1–16 chars (empty becomes `fallback`). */
export function cleanName(raw: unknown, fallback = 'Player'): string {
  if (typeof raw !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  const cut = Array.from(s).slice(0, NAME_MAX).join('').trim();
  return cut || fallback;
}

// --- client -> server --------------------------------------------------------

export type ClientMsg =
  | { t: 'ping'; c: number }
  | { t: 'name'; name: string }
  | { t: 'lobby' }
  | { t: 'unlobby' }
  | { t: 'create'; public: boolean; winScore?: number; malletScale?: number }
  | { t: 'join'; room: string }
  | { t: 'quick'; size: 2 | 4 }
  | { t: 'leave' }
  | { t: 'color'; color: number }
  | { t: 'ready'; on: boolean }
  | { t: 'settings'; public?: boolean; winScore?: number; malletScale?: number }
  | { t: 'kick'; id: string }
  | { t: 'start' }
  /**
   * This player's mallet at the end of ticks `tick`, `tick + 1`, … (`m` is x,y pairs). The client runs ahead of the
   * server, so these arrive before the server simulates those ticks and its puck meets the same mallet the player
   * saw. Binary on the wire.
   */
  | { t: 'in'; tick: number; m: number[] }
  | { t: 'pause' }
  | { t: 'resume' }
  | { t: 'vote'; id: string };

// --- server -> client --------------------------------------------------------

export type ErrorCode =
  | 'not_found'
  | 'full'
  | 'kicked'
  | 'color_taken'
  | 'color_locked'
  | 'cannot_start'
  | 'quick_room'
  | 'bad_request';

export interface LobbyRoom {
  id: string;
  host: string;
  players: number;
  cap: number;
  status: 'lobby' | 'playing';
  winScore: number;
  malletScale: number;
}

export interface MemberInfo {
  id: string;
  name: string;
  color: number;
  ready: boolean;
  online: boolean;
  /** Seat in the running game, or -1. */
  seat: number;
}

export interface SeatInfo {
  id: string | null;
  name: string;
  color: number;
  ai: boolean;
}

export interface PauseEntry {
  id: string;
  name: string;
  /** Remaining pause budget in seconds (1 decimal). */
  left: number;
  kickable: boolean;
  votes: string[];
  need: number;
}

export type LeftReason = 'kicked' | 'closed' | 'replaced' | 'left';

export type ServerMsg =
  | { t: 'hello'; id: string; token: string }
  | { t: 'pong'; c: number; st: number }
  | { t: 'error'; code: ErrorCode; msg: string }
  | { t: 'lobby'; rooms: LobbyRoom[] }
  | {
      t: 'room';
      id: string;
      public: boolean;
      quick: boolean;
      /** A quick-play room still waiting for its one automatic start. */
      fresh: boolean;
      cap: number;
      /** Player id of the host. */
      host: string;
      status: 'lobby' | 'playing';
      settings: RoomSettings;
      members: MemberInfo[];
    }
  | { t: 'left'; reason: LeftReason }
  | {
      t: 'start';
      players: PlayerCount;
      seat: number;
      seats: SeatInfo[];
      settings: RoomSettings;
      scores: number[];
      /** The game as of server tick `state.tick`. */
      state: StateFrame;
      /** Countdown still to run, seconds. */
      cd: number;
    }
  /** The whole game after server tick `tick`, 60 times a second: everything a client needs to predict on from there. */
  | ({ t: 'st' } & StateFrame)
  /** A mallet hit the puck during server tick `tick`. Binary on the wire. */
  | { t: 'hit'; s: number; tick: number; i: number }
  /** The puck bounced off a wall hard enough to hear. Binary on the wire. */
  | { t: 'wall'; tick: number; i: number }
  /** `tick`: server tick of the goal / serve. */
  | { t: 'goal'; s: number; c: number; sc: number[]; tick: number }
  | { t: 'serve'; s: number; p: [number, number]; tick: number }
  | { t: 'seats'; seats: SeatInfo[] }
  /** `cd` > 0: nobody is paused any more, count down this many seconds before play resumes. */
  | { t: 'pause'; paused: PauseEntry[]; cd: number }
  | { t: 'over'; winner: number; scores: number[]; seats: SeatInfo[]; reason: 'score' | 'forfeit' };

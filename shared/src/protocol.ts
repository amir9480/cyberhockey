import type { PlayerCount } from './layout';
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
  /** Where this player wants the mallet (the server's mallet eases toward it). */
  | { t: 'in'; x: number; y: number }
  /**
   * This player's mallet touched the puck as drawn on their screen, which shows server time `at` (ms): the mallet's
   * position `q` and velocity `w` then. The server rewinds the puck to that time and judges the touch itself.
   */
  | { t: 'hit'; at: number; q: [number, number]; w: [number, number] }
  /** Ask for the server's puck now (after a goal here that the server hasn't confirmed). */
  | { t: 'resync' }
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
      puck: PuckState;
      /** Mallet positions, x0,y0,x1,y1,… by seat. */
      mallets: number[];
      /** Countdown still to run, seconds. */
      cd: number;
      /** Server time (ms) when the puck is let go after the countdown, or 0. */
      thaw: number;
    }
  /**
   * A mallet hit the puck. The server worked it out at server time `at` (ms) from the puck as it was at `from` (earlier
   * when it judged a late claim); `p` is the puck at `at`, after the hit. Binary on the wire.
   */
  | { t: 'hit'; s: number; from: number; at: number; p: [number, number]; impact: number }
  /** The server judged a hit claim of yours a miss: the ball goes on as the server's positions have it. */
  | { t: 'miss' }
  /** The puck bounced off a wall hard enough to hear. */
  | { t: 'wall'; at: number; i: number }
  /** The server's puck on request, or frozen during a pause. */
  | { t: 'puck'; puck: PuckState }
  /** The server's puck position at server time `at` (ms), about 60 times a second. Binary on the wire. */
  | { t: 'pk'; at: number; p: [number, number] }
  /** `at`: server time (ms) of the goal / serve. */
  | { t: 'goal'; s: number; c: number; sc: number[]; at: number }
  | { t: 'serve'; s: number; p: [number, number]; at: number }
  | { t: 'seats'; seats: SeatInfo[] }
  /** `cd` > 0: nobody is paused any more, count down this many seconds before play resumes. */
  | { t: 'pause'; paused: PauseEntry[]; cd: number; thaw: number; puck: PuckState }
  | Snapshot
  | { t: 'over'; winner: number; scores: number[]; seats: SeatInfo[]; reason: 'score' | 'forfeit' };

/** The puck as of server time `at` (ms). */
export interface PuckState {
  at: number;
  p: [number, number];
  /** False while it is hidden between rounds. */
  vis: boolean;
}

/**
 * Mallets that moved since the last snapshot, about 60 times a second.
 * `d` is `seat, x, y` triples. Binary on the wire.
 */
export interface Snapshot {
  t: 's';
  /** Server time, ms. */
  at: number;
  d: number[];
}

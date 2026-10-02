import type { PlayerCount } from './layout';
import type { MatchEvent } from './match';
import type { RoomSettings } from './room';

/** Server simulation rate; snapshot `n` counts ticks of 1/TICK_RATE seconds. */
export const TICK_RATE = 120;
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
  | { t: 'in'; x: number; y: number }
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
  | { t: 'pong'; c: number }
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
  | { t: 'start'; players: PlayerCount; seat: number; seats: SeatInfo[]; settings: RoomSettings; scores: number[] }
  | { t: 'seats'; seats: SeatInfo[] }
  | { t: 'pause'; paused: PauseEntry[] }
  | Snapshot
  | { t: 'over'; winner: number; scores: number[]; seats: SeatInfo[]; reason: 'score' | 'forfeit' };

/** 60/s state for seated players. Built by hand on the server (hot path). */
export interface Snapshot {
  t: 's';
  /** Server tick; time = n / TICK_RATE. */
  n: number;
  /** Puck position. */
  b: [number, number];
  /** 1 while the puck is in play, 0 while hidden between rounds. */
  v: 0 | 1;
  /** Mallet positions, x0,y0,x1,y1,… by seat. */
  m: number[];
  /** Seconds left of the countdown, when one runs. */
  cd?: number;
  e?: MatchEvent[];
}

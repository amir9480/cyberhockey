/**
 * Rules that belong to a game room. Local for now; with multiplayer the room owner picks
 * them and the server sends them to everyone, so keep them in one plain object.
 */
export interface RoomSettings {
  /** Multiplier on every mallet's size (visual and physical). */
  malletScale: number;
  /** Points needed to win the game. */
  winScore: number;
}

export const MALLET_SCALE = { min: 0.6, max: 1.6, step: 0.05 };

export const WIN_SCORE = { min: 10, max: 100, step: 1 };

export const DEFAULT_ROOM: RoomSettings = { malletScale: 1, winScore: 10 };

export function clampWinScore(v: number): number {
  return Math.min(WIN_SCORE.max, Math.max(WIN_SCORE.min, Math.round(v)));
}

export function clampMalletScale(v: number): number {
  return Math.min(MALLET_SCALE.max, Math.max(MALLET_SCALE.min, v));
}

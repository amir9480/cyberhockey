import * as THREE from 'three';

/** Colours a player can pick from. Rivals take the ones left over. */
export const PALETTE_HEX = [0x00e5ff, 0xff2bd6, 0xffb400, 0x39ff6a, 0x9d5cff, 0x3d7bff, 0xe8ff3a, 0xff6a3d];
const PALETTE = PALETTE_HEX.map((c) => new THREE.Color(c));

/** Per-seat colours. Rebuild the table/mallets after changing them (they copy at creation). */
export const SEAT_COLORS = [0, 1, 2, 3].map((i) => PALETTE[i].clone());

/** Seat 0 gets palette colour `mine`; every other seat gets a distinct random one of the rest. */
export function assignSeatColors(mine: number) {
  const rest = PALETTE.map((_, i) => i).filter((i) => i !== mine);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  SEAT_COLORS[0].copy(PALETTE[mine]);
  for (let s = 1; s < SEAT_COLORS.length; s++) SEAT_COLORS[s].copy(PALETTE[rest[s - 1]]);
}

/** Colour for a seat index. */
export function seatColor(seat: number): THREE.Color {
  return SEAT_COLORS[seat % SEAT_COLORS.length];
}

/** Ball colour before anyone has hit it. */
export const BALL_NEUTRAL = new THREE.Color(1, 1, 1);

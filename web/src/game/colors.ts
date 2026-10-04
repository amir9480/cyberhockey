import * as THREE from 'three';

/**
 * Colours a player can pick from. Rivals take the ones left over. Soft, part-desaturated hues (easy on the eyes
 * against the dark table) that stay distinct from each other. The order is the hue each index has always had
 * (cyan, pink, gold, green, violet, blue, lime, coral): saved picks and room colour indices keep their meaning.
 */
export const PALETTE_HEX = [0x38c8ec, 0xe85cc8, 0xf0b440, 0x4fd67a, 0x9a72ec, 0x4f86f0, 0xd2ea56, 0xf07450];
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

/** Online: seat `i` takes palette colour `indices[i]`. Rebuild the table/mallets after changing them. */
export function setSeatColors(indices: number[]) {
  indices.forEach((c, s) => {
    if (s < SEAT_COLORS.length && PALETTE[c]) SEAT_COLORS[s].copy(PALETTE[c]);
  });
}

/** Colour for a seat index. */
export function seatColor(seat: number): THREE.Color {
  return SEAT_COLORS[seat % SEAT_COLORS.length];
}

/** Ball colour before anyone has hit it. */
export const BALL_NEUTRAL = new THREE.Color(1, 1, 1);

import type { ClientMsg, ServerMsg } from './protocol';

/**
 * Compact frames for the hot messages (mallet positions, puck positions, hits, mallet input, hit claims).
 * Everything else is JSON. Little-endian. Mallet coordinates are int16 in 1/QUANT units; puck coordinates float32.
 */
export const QUANT = 500;

const T_SNAP = 1; // s -> client
const T_KEY = 2; // pk -> client
const T_HIT = 3; // hit -> client
const T_WALL = 4; // wall -> client
const T_IN = 0x10; // in -> server
const T_CLAIM = 0x11; // hit -> server

type Bytes = ArrayBuffer | Uint8Array;
const view = (b: Bytes) => (b instanceof Uint8Array ? new DataView(b.buffer, b.byteOffset, b.byteLength) : new DataView(b));
const q = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * QUANT)));
const u8 = (v: number, max = 255) => Math.max(0, Math.min(max, Math.round(v)));

/** Rounds a position the way the wire does, so both ends hold the same value. */
export const quantize = (v: number) => q(v) / QUANT;

// --- server -> client --------------------------------------------------------------

/** `d`: seat, x, y triples of the mallets that moved. */
export function encodeSnapshot(at: number, d: number[]): Uint8Array {
  const n = Math.floor(d.length / 3);
  const buf = new Uint8Array(10 + n * 5);
  const v = view(buf);
  v.setUint8(0, T_SNAP);
  v.setFloat64(1, at, true);
  v.setUint8(9, n);
  for (let i = 0; i < n; i++) {
    v.setUint8(10 + i * 5, d[i * 3]);
    v.setInt16(11 + i * 5, q(d[i * 3 + 1]), true);
    v.setInt16(13 + i * 5, q(d[i * 3 + 2]), true);
  }
  return buf;
}

export function encodeKey(at: number, p: [number, number]): Uint8Array {
  const buf = new Uint8Array(17);
  const v = view(buf);
  v.setUint8(0, T_KEY);
  v.setFloat64(1, at, true);
  v.setFloat32(9, p[0], true);
  v.setFloat32(13, p[1], true);
  return buf;
}

export function encodeHitRelay(s: number, from: number, at: number, p: [number, number], impact: number): Uint8Array {
  const buf = new Uint8Array(27);
  const v = view(buf);
  v.setUint8(0, T_HIT);
  v.setUint8(1, s);
  v.setFloat64(2, from, true);
  v.setFloat64(10, at, true);
  v.setFloat32(18, p[0], true);
  v.setFloat32(22, p[1], true);
  v.setUint8(26, u8(impact * 4));
  return buf;
}

export function encodeWall(at: number, impact: number): Uint8Array {
  const buf = new Uint8Array(10);
  const v = view(buf);
  v.setUint8(0, T_WALL);
  v.setFloat64(1, at, true);
  v.setUint8(9, u8(impact * 4));
  return buf;
}

export function decodeServer(b: Bytes): ServerMsg | null {
  if (b.byteLength < 1) return null;
  const v = view(b);
  switch (v.getUint8(0)) {
    case T_SNAP: {
      if (b.byteLength < 10) return null;
      const n = v.getUint8(9);
      if (b.byteLength < 10 + n * 5) return null;
      const d: number[] = [];
      for (let i = 0; i < n; i++) d.push(v.getUint8(10 + i * 5), v.getInt16(11 + i * 5, true) / QUANT, v.getInt16(13 + i * 5, true) / QUANT);
      return { t: 's', at: v.getFloat64(1, true), d };
    }
    case T_KEY: {
      if (b.byteLength < 17) return null;
      return { t: 'pk', at: v.getFloat64(1, true), p: [v.getFloat32(9, true), v.getFloat32(13, true)] };
    }
    case T_HIT: {
      if (b.byteLength < 27) return null;
      return {
        t: 'hit',
        s: v.getUint8(1),
        from: v.getFloat64(2, true),
        at: v.getFloat64(10, true),
        p: [v.getFloat32(18, true), v.getFloat32(22, true)],
        impact: v.getUint8(26) / 4,
      };
    }
    case T_WALL: {
      if (b.byteLength < 10) return null;
      return { t: 'wall', at: v.getFloat64(1, true), i: v.getUint8(9) / 4 };
    }
    default:
      return null;
  }
}

// --- client -> server --------------------------------------------------------------

/** Where the player wants the mallet. */
export function encodeIn(x: number, y: number): Uint8Array {
  const buf = new Uint8Array(5);
  const v = view(buf);
  v.setUint8(0, T_IN);
  v.setInt16(1, q(x), true);
  v.setInt16(3, q(y), true);
  return buf;
}

/** A touch of the puck: the time of the picture, the mallet's position and velocity. */
export function encodeClaim(at: number, m: [number, number], w: [number, number]): Uint8Array {
  const buf = new Uint8Array(25);
  const v = view(buf);
  v.setUint8(0, T_CLAIM);
  v.setFloat64(1, at, true);
  [m[0], m[1], w[0], w[1]].forEach((f, i) => v.setFloat32(9 + i * 4, f, true));
  return buf;
}

export function decodeClient(b: Bytes): ClientMsg | null {
  if (b.byteLength < 1) return null;
  const v = view(b);
  switch (v.getUint8(0)) {
    case T_IN:
      if (b.byteLength < 5) return null;
      return { t: 'in', x: v.getInt16(1, true) / QUANT, y: v.getInt16(3, true) / QUANT };
    case T_CLAIM: {
      if (b.byteLength < 25) return null;
      const f = (i: number) => v.getFloat32(9 + i * 4, true);
      const at = v.getFloat64(1, true);
      return [at, f(0), f(1), f(2), f(3)].every(Number.isFinite) ? { t: 'hit', at, q: [f(0), f(1)], w: [f(2), f(3)] } : null;
    }
    default:
      return null;
  }
}

import type { ClientMsg, ServerMsg } from './protocol';

/**
 * Compact frames for the hot messages (game state, hits, wall bounces, mallet input). Everything else is JSON.
 * Little-endian. Mallet coordinates are int16 in 1/QUANT units; the puck is float32 (position and velocity).
 */
export const QUANT = 500;
/** Most mallet positions one input frame may carry (a stalled tab catching up sends several frames). */
export const MAX_INPUTS = 120;

const T_STATE = 1; // state -> client
const T_HIT = 3; // hit -> client
const T_WALL = 4; // wall -> client
const T_IN = 0x10; // in -> server

type Bytes = ArrayBuffer | Uint8Array;
const view = (b: Bytes) => (b instanceof Uint8Array ? new DataView(b.buffer, b.byteOffset, b.byteLength) : new DataView(b));
const q = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * QUANT)));
const u8 = (v: number, max = 255) => Math.max(0, Math.min(max, Math.round(v)));
const i8 = (v: number) => Math.max(-128, Math.min(127, Math.round(v)));

/** Rounds a position the way the wire does, so both ends hold the same value. */
export const quantize = (v: number) => q(v) / QUANT;

// --- server -> client --------------------------------------------------------------

export interface StateFrame {
  tick: number;
  /** Server clock (ms) when the tick was simulated. */
  at: number;
  /** Ticks the puck stays frozen after `tick` (countdown); FREEZE_HELD (net.ts): until further notice (pause, between rounds). */
  freeze: number;
  /** The puck is on the table (false between a goal and the next serve). */
  vis: boolean;
  p: [number, number];
  v: [number, number];
  /** Mallet positions x0,y0,x1,y1,… by seat. */
  m: number[];
  /** Per seat: how many ticks early its latest inputs arrived (negative: late), for the client's clock. */
  slack: number[];
}

export function encodeState(s: StateFrame): Uint8Array {
  const n = s.m.length / 2;
  const buf = new Uint8Array(33 + n * 5);
  const v = view(buf);
  v.setUint8(0, T_STATE);
  v.setUint32(1, s.tick, true);
  v.setFloat64(5, s.at, true);
  v.setUint16(13, Math.min(0xffff, Math.max(0, Math.ceil(s.freeze))), true);
  v.setUint8(15, s.vis ? 1 : 0);
  v.setFloat32(16, s.p[0], true);
  v.setFloat32(20, s.p[1], true);
  v.setFloat32(24, s.v[0], true);
  v.setFloat32(28, s.v[1], true);
  v.setUint8(32, n);
  for (let i = 0; i < n; i++) {
    v.setInt16(33 + i * 4, q(s.m[i * 2]), true);
    v.setInt16(35 + i * 4, q(s.m[i * 2 + 1]), true);
    v.setInt8(33 + n * 4 + i, i8(s.slack[i] ?? 127));
  }
  return buf;
}

export function encodeHit(s: number, tick: number, impact: number): Uint8Array {
  const buf = new Uint8Array(7);
  const v = view(buf);
  v.setUint8(0, T_HIT);
  v.setUint8(1, s);
  v.setUint32(2, tick, true);
  v.setUint8(6, u8(impact * 4));
  return buf;
}

export function encodeWall(tick: number, impact: number): Uint8Array {
  const buf = new Uint8Array(6);
  const v = view(buf);
  v.setUint8(0, T_WALL);
  v.setUint32(1, tick, true);
  v.setUint8(5, u8(impact * 4));
  return buf;
}

export function decodeServer(b: Bytes): ServerMsg | null {
  if (b.byteLength < 1) return null;
  const v = view(b);
  switch (v.getUint8(0)) {
    case T_STATE: {
      if (b.byteLength < 33) return null;
      const n = v.getUint8(32);
      if (b.byteLength < 33 + n * 5) return null;
      const m: number[] = [];
      const slack: number[] = [];
      for (let i = 0; i < n; i++) {
        m.push(v.getInt16(33 + i * 4, true) / QUANT, v.getInt16(35 + i * 4, true) / QUANT);
        slack.push(v.getInt8(33 + n * 4 + i));
      }
      return {
        t: 'st',
        tick: v.getUint32(1, true),
        at: v.getFloat64(5, true),
        freeze: v.getUint16(13, true),
        vis: v.getUint8(15) === 1,
        p: [v.getFloat32(16, true), v.getFloat32(20, true)],
        v: [v.getFloat32(24, true), v.getFloat32(28, true)],
        m,
        slack,
      };
    }
    case T_HIT: {
      if (b.byteLength < 7) return null;
      return { t: 'hit', s: v.getUint8(1), tick: v.getUint32(2, true), i: v.getUint8(6) / 4 };
    }
    case T_WALL: {
      if (b.byteLength < 6) return null;
      return { t: 'wall', tick: v.getUint32(1, true), i: v.getUint8(5) / 4 };
    }
    default:
      return null;
  }
}

// --- client -> server --------------------------------------------------------------

/** The local mallet's position at the end of ticks `tick`, `tick + 1`, …: `m` is x0,y0,x1,y1,… */
export function encodeIn(tick: number, m: number[]): Uint8Array {
  const n = Math.min(MAX_INPUTS, Math.floor(m.length / 2));
  const buf = new Uint8Array(6 + n * 4);
  const v = view(buf);
  v.setUint8(0, T_IN);
  v.setUint32(1, tick, true);
  v.setUint8(5, n);
  for (let i = 0; i < n; i++) {
    v.setInt16(6 + i * 4, q(m[i * 2]), true);
    v.setInt16(8 + i * 4, q(m[i * 2 + 1]), true);
  }
  return buf;
}

export function decodeClient(b: Bytes): ClientMsg | null {
  if (b.byteLength < 1) return null;
  const v = view(b);
  switch (v.getUint8(0)) {
    case T_IN: {
      if (b.byteLength < 6) return null;
      const n = v.getUint8(5);
      if (n > MAX_INPUTS || b.byteLength < 6 + n * 4) return null;
      const m: number[] = [];
      for (let i = 0; i < n; i++) m.push(v.getInt16(6 + i * 4, true) / QUANT, v.getInt16(8 + i * 4, true) / QUANT);
      return { t: 'in', tick: v.getUint32(1, true), m };
    }
    default:
      return null;
  }
}

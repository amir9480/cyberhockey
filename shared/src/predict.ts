import type { StateFrame } from './binary';
import { buildLayout, type PlayerCount, type TableLayout, type Vec2 } from './layout';
import { SimMallet } from './mallet';
import type { MatchEvent } from './match';
import { FREEZE_HELD, TICK } from './net';
import { Physics, PUCK_RADIUS, type MalletBody } from './physics';

const RING = 1024; // ticks of history kept (8.5 s)
const EXTRAPOLATE = 12; // ticks a remote mallet keeps its last velocity before it is assumed to stop (100 ms)
const SAME_EVENT = 4; // ticks apart that two reports of one hit (predicted, then from the server) may be
const STALE_EVENT = 30; // ticks: an event this far behind the picture is too late to play
const LOUD_WALL = 1.5; // wall bounces softer than this make no sound (as on the server)

interface Tracked {
  tick: number;
  e: MatchEvent;
  /** Reported by the server (else only predicted). */
  auth: boolean;
  played: boolean;
}

/** One tick of the game as drawn: the puck and every mallet. */
export interface Sample {
  x: number;
  y: number;
  vis: boolean;
  /** Mallet positions x0,y0,x1,y1,… by seat. */
  m: number[];
}

/**
 * Client-side prediction for an online game: the same physics as the server, run ahead of it.
 *
 * The latest server state is the truth up to its tick. From there the game is re-simulated tick by tick up to the
 * present with the local mallet's own positions (exactly what the server will use, as they reach it in time) and the
 * other mallets carried on at their last speed for a moment. A new state replaces the prediction from its tick on;
 * between states the prediction just runs forward.
 *
 * Every tick is kept in a ring, server truth up to the latest state and prediction after it, so the display can show
 * any moment of the recent past or the present.
 */
export class Predictor {
  readonly layout: TableLayout;
  private physics: Physics;
  private bodies: MalletBody[];
  /** For each seat's zone clamp and radius. */
  private shapes: SimMallet[];
  private auth: StateFrame | null = null;
  private prevAuth: StateFrame | null = null;
  private dirty = false;
  /** Last tick simulated (prediction holds up to here). */
  private simTick = -1;
  /** Furthest tick ever simulated: events past it are new. */
  private frontier = -1;
  private frozenUntil = 0;
  private stopped = false;
  private vis = true;
  private simAt = 0;
  private remoteVel: Vec2[] = [];
  /** The local mallet's position at the end of each tick, as sent to the server. */
  private inputs = new Map<number, [number, number]>();
  private events: Tracked[] = [];
  /** Server states not yet written into the ring. */
  private unwritten: { prev: StateFrame | null; st: StateFrame }[] = [];
  /** First tick ever written. */
  private first = -1;

  // the ring: frame of tick t lives at t % RING
  private rTick = new Int32Array(RING).fill(-1);
  private rX = new Float64Array(RING);
  private rY = new Float64Array(RING);
  private rVis = new Uint8Array(RING);
  private rM: Float64Array;

  constructor(
    players: PlayerCount,
    scale: number,
    readonly seat: number,
  ) {
    this.layout = buildLayout(players);
    this.shapes = this.layout.seats.map((s) => new SimMallet(this.layout, s.index, scale));
    this.bodies = this.shapes.map((m) => ({ seat: m.seat, radius: m.radius, prev: { x: 0, y: 0 }, cur: { x: 0, y: 0 } }));
    this.rM = new Float64Array(RING * players * 2);
    this.remoteVel = this.shapes.map(() => ({ x: 0, y: 0 }));
    this.physics = new Physics(this.layout, {
      onHit: (s, impact) => this.predicted({ t: 'hit', s, i: Math.round(impact * 100) / 100 }),
      onWall: (impact) => impact > LOUD_WALL && this.predicted({ t: 'wall', i: Math.round(impact * 100) / 100 }),
      onGoal: () => {
        this.stopped = true;
      },
    });
    this.physics.setPuckRadius(PUCK_RADIUS * scale);
  }

  get players() {
    return this.shapes.length;
  }

  /** Tick of the latest server state, or -1. */
  get authTick() {
    return this.auth?.tick ?? -1;
  }

  /** Newest tick there is a picture for. */
  get latest() {
    return this.simTick;
  }

  /** A server state. Older than the one we have: ignored. */
  setAuth(st: StateFrame) {
    if (this.auth && st.tick <= this.auth.tick) return;
    this.prevAuth = this.auth;
    this.auth = st;
    this.dirty = true;
    const prev = this.prevAuth;
    // Remote mallets: their speed over the last stretch, to carry them on with.
    this.shapes.forEach((_, s) => {
      const v = this.remoteVel[s];
      const n = prev ? st.tick - prev.tick : 0;
      v.x = n > 0 && n <= 8 ? (st.m[s * 2] - prev!.m[s * 2]) / n : 0;
      v.y = n > 0 && n <= 8 ? (st.m[s * 2 + 1] - prev!.m[s * 2 + 1]) / n : 0;
    });
    // Written into the picture at the next `advance`, not now: a caller measuring how the picture changed across
    // `advance` (to glide the difference away) then sees this change too.
    this.unwritten.push({ prev, st });
    // The server reports its hits before the state that follows them, so a predicted hit it hasn't confirmed by now
    // didn't happen; the ones after this tick are predicted afresh.
    this.events = this.events.filter((e) => e.auth || e.played);
  }

  /** The local mallet's position at the end of `tick`. */
  addInput(tick: number, x: number, y: number) {
    this.inputs.set(tick, [x, y]);
    this.inputs.delete(tick - RING);
  }

  /**
   * Bring the prediction up to `tick`: re-simulated from the latest server state if one came, else stepped on.
   * Returns true when the picture was rewritten (a new server state), so already drawn moments may have moved.
   */
  advance(tick: number): boolean {
    const a = this.auth;
    if (!a) return false;
    const rewrote = this.dirty;
    if (this.dirty) {
      this.dirty = false;
      for (const { prev, st } of this.unwritten.splice(0)) this.writeAuth(prev, st);
      this.restore(a);
    }
    // Never more than the ring holds.
    if (tick - this.simTick > RING - 8) this.restore(a);
    const to = Math.min(tick, this.simTick + RING - 8);
    while (this.simTick < to) this.stepTick(this.simTick + 1);
    return rewrote;
  }

  /** The picture at fractional tick `t` (clamped to what is known). */
  sample(t: number, out: Sample): Sample {
    const hi = this.simTick;
    if (hi < 0) return out;
    const lo = Math.max(hi - RING + 1, this.first);
    const c = Math.max(lo, Math.min(hi, t));
    const t0 = Math.floor(c);
    const t1 = Math.min(hi, t0 + 1);
    const i0 = this.slot(t0, lo);
    const i1 = this.slot(t1, lo);
    const both = this.rVis[i0] === 1 && this.rVis[i1] === 1;
    const k = both ? c - t0 : 0;
    out.x = this.rX[i0] + (this.rX[i1] - this.rX[i0]) * k;
    out.y = this.rY[i0] + (this.rY[i1] - this.rY[i0]) * k;
    out.vis = this.rVis[i0] === 1;
    const n = this.players * 2;
    out.m.length = n;
    for (let j = 0; j < n; j++) {
      const a = this.rM[i0 * n + j];
      out.m[j] = a + (this.rM[i1 * n + j] - a) * (c - t0);
    }
    return out;
  }

  /** A hit or wall bounce the server reports: merged with the predicted one, if the prediction had it. */
  report(tick: number, e: MatchEvent) {
    const same = this.events.find((x) => this.same(x, tick, e));
    if (same) {
      same.auth = true;
      same.tick = tick;
      same.e = e;
    } else this.events.push({ tick, e, auth: true, played: false });
  }

  /** Events the picture has reached by tick `t` that haven't been played yet (each is returned once). */
  due(t: number): MatchEvent[] {
    const out: MatchEvent[] = [];
    for (const e of this.events) {
      if (e.played || e.tick > t) continue;
      e.played = true;
      if (e.tick >= t - STALE_EVENT) out.push(e.e);
    }
    this.events = this.events.filter((e) => e.tick > t - RING / 2);
    return out;
  }

  // --- simulation -------------------------------------------------------------------

  /** Server truth for `st.tick`, and the ticks since the state before it (states come every few ticks) on a straight line. */
  private writeAuth(prev: StateFrame | null, st: StateFrame) {
    this.write(st.tick, st.p[0], st.p[1], st.vis, st.m);
    if (!prev || !prev.vis || !st.vis || st.tick - prev.tick > 8) return;
    const n = st.tick - prev.tick;
    for (let k = 1; k < n; k++) {
      const f = k / n;
      const m = st.m.map((v, i) => prev.m[i] + (v - prev.m[i]) * f);
      this.write(prev.tick + k, prev.p[0] + (st.p[0] - prev.p[0]) * f, prev.p[1] + (st.p[1] - prev.p[1]) * f, true, m);
    }
  }

  private restore(a: StateFrame) {
    this.physics.pos.x = a.p[0];
    this.physics.pos.y = a.p[1];
    this.physics.vel.x = a.v[0];
    this.physics.vel.y = a.v[1];
    this.bodies.forEach((b, s) => {
      b.cur.x = b.prev.x = a.m[s * 2];
      b.cur.y = b.prev.y = a.m[s * 2 + 1];
    });
    this.frozenUntil = a.freeze >= FREEZE_HELD ? Infinity : a.tick + a.freeze;
    this.vis = a.vis;
    this.stopped = false;
    this.simTick = a.tick;
  }

  private stepTick(t: number) {
    const a = this.auth!;
    this.bodies.forEach((b, s) => {
      b.prev.x = b.cur.x;
      b.prev.y = b.cur.y;
      const p = this.malletAt(s, t, a);
      if (p) {
        b.cur.x = p.x;
        b.cur.y = p.y;
      }
    });
    this.simAt = t;
    if (this.vis && t > this.frozenUntil && !this.stopped) this.physics.step(TICK, this.bodies);
    this.simTick = t;
    if (t > this.frontier) this.frontier = t;
    const m = this.bodies.flatMap((b) => [b.cur.x, b.cur.y]);
    this.write(t, this.physics.pos.x, this.physics.pos.y, this.vis, m);
  }

  /** Where seat `s`'s mallet is at the end of tick `t`, or null to leave it where it is. */
  private malletAt(s: number, t: number, a: StateFrame): Vec2 | null {
    if (s === this.seat) {
      const p = this.inputs.get(t);
      return p ? { x: p[0], y: p[1] } : null;
    }
    const n = Math.min(t - a.tick, EXTRAPOLATE);
    const v = this.remoteVel[s];
    return this.shapes[s].clamp({ x: a.m[s * 2] + v.x * n, y: a.m[s * 2 + 1] + v.y * n });
  }

  private predicted(e: MatchEvent) {
    const t = this.simAt;
    // Ticks simulated before were already reported (or replaced by the server's word).
    if (t <= this.authTick) return;
    if (this.events.some((x) => this.same(x, t, e))) return;
    this.events.push({ tick: t, e, auth: false, played: false });
  }

  private same(x: Tracked, tick: number, e: MatchEvent) {
    if (x.e.t !== e.t || Math.abs(x.tick - tick) > SAME_EVENT) return false;
    return e.t !== 'hit' || (x.e.t === 'hit' && x.e.s === e.s);
  }

  private write(t: number, x: number, y: number, vis: boolean, m: number[]) {
    if (this.first < 0) this.first = t;
    const i = t % RING;
    this.rTick[i] = t;
    this.rX[i] = x;
    this.rY[i] = y;
    this.rVis[i] = vis ? 1 : 0;
    const n = this.players * 2;
    for (let j = 0; j < n; j++) this.rM[i * n + j] = m[j];
  }

  /** Ring slot of tick `t`, or of the nearest earlier one present (at least `lo`). */
  private slot(t: number, lo: number) {
    while (t > lo && this.rTick[t % RING] !== t) t--;
    return t % RING;
  }
}

/**
 * How far into the past a thing at `p` is drawn, from 0 (now) to 1 (the full display depth), for the player at `seat`.
 * Near your own goal everything is drawn as it is now, so your mallet meets the puck you see; near the others' goals
 * as the server last confirmed it, so their hits are seen as they really happened. In between, the puck's time slides
 * smoothly from one to the other (it speeds up a little coming toward you and slows down going away).
 */
export function lagWeight(layout: TableLayout, seat: number, p: Vec2): number {
  const mine = layout.seats[seat].goalCenter;
  const dMine = Math.hypot(p.x - mine.x, p.y - mine.y);
  let dOther = Infinity;
  for (const s of layout.seats) {
    if (s.index === seat) continue;
    dOther = Math.min(dOther, Math.hypot(p.x - s.goalCenter.x, p.y - s.goalCenter.y));
  }
  const r = dMine / (dMine + dOther || 1);
  // As wide a ramp as possible, for the gentlest slide. Its corners would make the drawn speed jump; `DisplayTime`
  // rounds them off.
  return Math.max(0, Math.min(1, (r - 0.15) / 0.7));
}

const RATE_SMOOTH = 0.15; // s: how quickly the drawn time's rate follows its target
const CATCH_UP = 0.3; // s: time constant for closing the gap to the target time
const RATE_MIN = 0.4;
const RATE_MAX = 2;
const LANDING = 0.25; // s: drawn time slows to real time over about this much before it reaches the present

/**
 * The moment something is drawn at, following a target that moves (see `lagWeight`). It never jumps: the rate at
 * which drawn time passes changes smoothly, so the drawn speed of the puck changes smoothly too.
 */
export class DisplayTime {
  t: number;
  private rate = 1;
  private follow = 1;
  private lastTarget = NaN;

  constructor(t: number) {
    this.t = t;
  }

  /** Advance by `dt` seconds toward `target` (ticks), staying within [oldest, present]. */
  update(target: number, dt: number, present: number, oldest: number): number {
    if (dt <= 0) return this.t;
    const ticks = dt / TICK;
    const a = 1 - Math.exp(-dt / RATE_SMOOTH);
    // How fast the target itself moves (smoothed), plus a gentle pull to close any gap.
    if (!Number.isNaN(this.lastTarget)) this.follow += ((target - this.lastTarget) / ticks - this.follow) * a;
    this.lastTarget = target;
    const want = this.follow + (target - this.t) / (CATCH_UP / TICK);
    this.rate += (want - this.rate) * a;
    // Arrive at the present gently: running into it at full rate would stop the puck's catch-up all at once.
    const room = 1 + (present - this.t) / (LANDING / TICK);
    this.rate = Math.max(RATE_MIN, Math.min(RATE_MAX, room, this.rate));
    this.t = Math.max(oldest, Math.min(present, this.t + this.rate * ticks));
    return this.t;
  }
}

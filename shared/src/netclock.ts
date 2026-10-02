import type { StateFrame } from './binary';
import { TICK_MS, TICK_RATE } from './net';

const LEAD_START = 25; // ms above half the round trip
const LEAD_MIN = 1; // ticks
const LEAD_MAX = 72;
const SLACK_LOW = 1; // ticks: inputs arriving with less to spare than this push the lead up
const SLACK_HIGH = 3; // more to spare than this lets it come down (every tick of lead is a tick of display depth)
const NO_SLACK = 127; // the server has no inputs to judge yet
const LEAD_UP = 4; // ticks per second
const LEAD_DOWN = 1.5;
const SNAP = 24; // ticks off before the clock jumps instead of drifting
const DRIFT = 0.03; // the clock runs at most this much fast or slow to catch up (everything drawn speeds up with it)
const DEPTH_MARGIN = 2; // ticks beyond the usual age of the newest state
const DEPTH_UP = 6; // ticks per second: a changing depth speeds up or slows down the far side of the table
const DEPTH_DOWN = 2;
const GAP_WINDOW = 3000; // ms of state ages kept

/**
 * An online client's sense of time, in server ticks.
 *
 * `now` (the present, where the local mallet lives) runs `lead` ticks AHEAD of the server, so each input reaches the
 * server just before it simulates that tick. The server reports how early inputs arrive (`slack`); the lead grows
 * quickly when they are late and shrinks slowly when they are early.
 *
 * `depth` is how old the newest server state usually is when measured against `now` (95th percentile, plus a little):
 * drawn that far back, the others' side of the table is always server-confirmed.
 */
export class NetClock {
  now: number;
  lead: number;
  depth: number;
  /** Server tick = base + server clock (ms) / TICK_MS. */
  private base: number;
  private slack = NO_SLACK;
  private gaps: { at: number; ticks: number }[] = [];

  /** `st`: the state the game starts from; `rtt`: round trip, ms (0 if unknown); `serverNow`: server clock, ms. */
  constructor(st: StateFrame, rtt: number, serverNow: number) {
    const half = rtt ? rtt / 2 : 60;
    this.base = st.tick - st.at / TICK_MS;
    this.lead = Math.min(LEAD_MAX, (half + LEAD_START) / TICK_MS);
    this.depth = this.lead + half / TICK_MS + DEPTH_MARGIN;
    this.now = this.serverTick(serverNow) + this.lead;
  }

  /** The server's tick at server clock `serverNow` (estimated). */
  serverTick(serverNow: number) {
    return this.base + serverNow / TICK_MS;
  }

  /** A state arrived at local monotonic time `at` (ms). */
  onState(st: StateFrame, seat: number, at: number) {
    // The server's tick count against its clock: smoothed, but a stall on the server moves it at once.
    const b = st.tick - st.at / TICK_MS;
    this.base += Math.abs(b - this.base) > 6 ? b - this.base : (b - this.base) * 0.05;
    this.slack = st.slack[seat] ?? NO_SLACK;
    this.gaps.push({ at, ticks: this.now - st.tick });
    while (this.gaps.length && at - this.gaps[0].at > GAP_WINDOW) this.gaps.shift();
  }

  /** Advance by `dt` seconds of real time. */
  update(dt: number, serverNow: number) {
    if (this.slack < SLACK_LOW) this.lead += LEAD_UP * dt;
    else if (this.slack > SLACK_HIGH && this.slack !== NO_SLACK) this.lead -= LEAD_DOWN * dt;
    this.lead = Math.max(LEAD_MIN, Math.min(LEAD_MAX, this.lead));

    const diff = this.serverTick(serverNow) + this.lead - this.now;
    if (Math.abs(diff) > SNAP) this.now += diff;
    else this.now += dt * TICK_RATE * (1 + Math.max(-DRIFT, Math.min(DRIFT, diff * 0.02)));

    if (this.gaps.length >= 5) {
      const sorted = this.gaps.map((g) => g.ticks).sort((a, b) => a - b);
      const want = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] + DEPTH_MARGIN;
      const d = want - this.depth;
      this.depth += Math.max(-DEPTH_DOWN * dt, Math.min(DEPTH_UP * dt, d));
    }
  }
}

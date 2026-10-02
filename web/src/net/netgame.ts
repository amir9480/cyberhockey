import { encodeClaim, encodeIn } from '@airhockey/shared/binary';
import type { PlayerCount } from '@airhockey/shared/layout';
import type { MatchCore, MatchEvent } from '@airhockey/shared/match';
import { bounceOff, MAX_MALLET_SPEED, sweepEntry } from '@airhockey/shared/physics';
import type { PuckState, SeatInfo, ServerMsg, Snapshot } from '@airhockey/shared/protocol';
import type { RoomSettings } from '@airhockey/shared/room';
import type { View } from '../game/view';
import type { Socket } from './socket';

type StartMsg = Extract<ServerMsg, { t: 'start' }>;
type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

/*
 * The server simulates the game and sends verified positions: the puck about 60 times a second, the mallets that
 * moved, and every hit, goal and serve. The puck and the other mallets are drawn by moving between those positions
 * (never beyond the newest one), on one shared timeline `delay` ms behind the server clock. The delay follows how
 * late the server's messages really arrive, so there is nearly always a newer position to move toward.
 *
 * Hits are predicted so they never wait for the network, and fixed by the server's value when it arrives:
 *  - Your own mallet is drawn in real time and collides with the puck as drawn, at once. The touch is reported with
 *    the time of the picture it was seen in; the server rewinds the puck to then, judges it, and sends the result.
 *  - Another mallet (a player's or an AI's) touching the puck in the picture bounces it the same moment, using the
 *    mallet's drawn position and speed, instead of waiting for the server's hit message to cross the network.
 *  Contact is found by maths, not by sampling: between one frame's positions and the next, both the puck and the
 *    mallet move in a straight line, and the first moment they are a radius-sum apart is solved exactly. So a fast
 *    puck (or a fast flick) can't step over a mallet between two frames.
 * Either way the predicted bounce is shown until the picture reaches the server's result (or a `miss` says it
 * didn't count), and then the ball moves on to the server's positions, gliding away any difference.
 */

const DELAY_START = 80; // ms
const DELAY_MIN = 40;
const DELAY_MAX = 600;
const DELAY_MARGIN = 25; // ms above the 95th-percentile lateness
const DELAY_UP = 150; // ms per second the delay may grow (a bad patch)
const DELAY_DOWN = 15; // ms per second it shrinks (fine again)
const LATE_WINDOW = 5000; // ms of lateness samples kept
const CLOCK_SLEW = 5; // ms per second the clock estimate may move
const CLOCK_SNAP = 50;
const SEND_EVERY = 1000 / 60; // ms, at most 60 mallet updates a second
const CLAIM_EVERY = 16; // ms, at most this often while the mallet keeps pushing the puck
const GOAL_WAIT = 700; // ms the puck waits in a goal for the server before asking where it really is
const GLIDE_MAX = 8; // a handover bigger than this (table units) is a real jump, not drift
const KEEP_MS = 600; // ms of puck positions kept behind the drawn time (a late hit rewrites that stretch)
const MAX_POINTS = 200;
const MAX_FRAMES = 120;
const PREDICT_EXTRA = 500; // ms beyond a round trip before an unconfirmed local hit is given up
const SIM_RATE = 240; // steps per second of the local simulation (mallet speed = movement per step)
const MIN_PREDICT_IMPACT = 0.5; // a predicted bounce of another mallet needs at least this closing speed

interface Frame {
  t: number;
  /** Mallet positions x0,y0,x1,y1,… by seat. */
  m: number[];
}

interface Point {
  t: number;
  x: number;
  y: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Drives an online game on the `View`. See the note at the top of the file. */
export class NetGame {
  seats: SeatInfo[];
  scores: number[];
  /** Seconds left of the countdown shown on screen, 0 when none. */
  countdown = 0;
  onCountdown: (secs: number) => void = () => {};
  private players: PlayerCount;
  private seat: number;
  private settings: RoomSettings;
  private paused = false;
  private cd = 0;
  private stopped = false;
  /** Sound, colour and effects for an event (the match's own handler). */
  private fx: ((e: MatchEvent) => void) | null = null;

  // timeline
  private clk: number;
  private delay = DELAY_START;
  private delayTarget = DELAY_START;
  private late: { at: number; ms: number }[] = [];
  private lateAt = 0;

  // other mallets
  private frames: Frame[] = [];
  private lastM: number[] = [];

  // puck
  private points: Point[] = [];
  /** A predicted bounce is showing (ours, or another mallet's): drawn until the server's result is in the picture. */
  private predicting = false;
  /** Whose hit is being predicted. */
  private predictSeat = -1;
  /** When each seat's predicted hit was heard, so the server's message about it isn't played twice. */
  private predictedAt = new Map<number, number>();
  private predictSince = 0;
  /** Server time the picture must reach before the local bounce hands over (Infinity: no answer yet). */
  private confirmAt = Infinity;
  private latestClaim = 0;

  // sending
  private lastSent = '';
  private lastSendAt = 0;
  private lastClaimAt = 0;
  /** The puck and every mallet as drawn last frame: the other end of this frame's motion. */
  private before: { puck: { x: number; y: number }; mallets: { x: number; y: number }[] } | null = null;
  private pendingClaim: { at: number; q: [number, number]; w: [number, number] } | null = null;
  private goalSince = 0;
  private lastCd = -1;

  constructor(
    private view: View,
    private socket: Socket,
    msg: StartMsg,
  ) {
    this.players = msg.players;
    this.seat = msg.seat;
    this.settings = msg.settings;
    this.seats = msg.seats;
    this.scores = [...msg.scores];
    this.clk = socket.clockOffset;
    this.build();
    this.load(msg);
    view.onFrame = (dt, now) => this.update(dt, now);
  }

  get localSeat() {
    return this.seat;
  }

  private get core(): MatchCore {
    return this.view.match!.core;
  }

  /** Server time now, ms (smoothed clock). */
  private serverNow() {
    return Date.now() + this.clk;
  }

  /** Server time of the picture on screen, ms. */
  private renderMs() {
    return this.serverNow() - this.delay;
  }

  private build() {
    this.view.setupNet(
      this.players,
      this.seat,
      this.seats.map((s) => s.color),
      this.settings,
      this.scores,
    );
    const core = this.core;
    this.fx = core.onEvent;
    // Local bounces count only for our own hits (a prediction); wall sounds come from the server.
    core.onEvent = (e) => {
      if (e.t === 'wall') return;
      this.fx?.(e);
      this.onEvent(e);
    };
    core.onLocalGoal = () => (this.goalSince = performance.now());
    core.setCollide([this.seat]);
    core.hold = this.cd > 0 || this.paused;
    this.frames = [];
    this.lastSent = '';
    this.pendingClaim = null;
  }

  /** Take the game state a `start` message carries. */
  private load(msg: StartMsg) {
    this.cd = msg.cd;
    this.core.hold = this.cd > 0 || this.paused;
    this.lastM = [...msg.mallets];
    this.core.mallets.forEach((m, i) => {
      if (msg.mallets[i * 2] !== undefined) m.place(msg.mallets[i * 2], msg.mallets[i * 2 + 1]);
    });
    this.freezeAt(msg.puck, msg.thaw);
  }

  /** The puck stands still where the server says (start, pause) and moves on from `thaw`, a server time, if given. */
  private freezeAt(st: PuckState, thaw = 0) {
    this.points = [{ t: st.at, x: st.p[0], y: st.p[1] }];
    if (thaw > st.at) this.points.push({ t: thaw, x: st.p[0], y: st.p[1] });
    this.predicting = false;
    this.core.applyPuck({ x: st.p[0], y: st.p[1] }, { x: 0, y: 0 }, 0, st.vis);
    const g = this.view.match!.glide;
    g.x = g.y = 0;
  }

  /** The server re-sent `start` (reclaimed or took a seat, or reconnected): rebuild from it. */
  restart(msg: StartMsg) {
    this.players = msg.players;
    this.seat = msg.seat;
    this.settings = msg.settings;
    this.seats = msg.seats;
    this.scores = [...msg.scores];
    this.build();
    this.load(msg);
  }

  /** Seat owners, names, AI flags or colours changed. Colours are baked into the table, so they rebuild it. */
  setSeats(seats: SeatInfo[]) {
    const recolour = seats.some((s, i) => s.color !== this.seats[i]?.color);
    this.seats = seats;
    if (!recolour) return;
    const core = this.core;
    const keep = { p: { ...core.physics.pos }, vis: core.visible, m: core.mallets.map((m) => ({ ...m.pos })) };
    this.scores = [...core.scores];
    this.build();
    this.core.mallets.forEach((m, i) => m.place(keep.m[i].x, keep.m[i].y));
    this.core.applyPuck(keep.p, { x: 0, y: 0 }, 0, keep.vis);
  }

  // --- from the server -----------------------------------------------------------

  /** How late a server message was (ms): the delay is set from the late ones. */
  private sample(serverAt: number) {
    const now = performance.now();
    this.late.push({ at: now, ms: this.serverNow() - serverAt });
    while (this.late.length && now - this.late[0].at > LATE_WINDOW) this.late.shift();
  }

  /** Mallets that moved: merge into the full picture and keep it for interpolation. */
  snapshot(s: Snapshot) {
    this.sample(s.at);
    for (let i = 0; i + 2 < s.d.length; i += 3) {
      this.lastM[s.d[i] * 2] = s.d[i + 1];
      this.lastM[s.d[i] * 2 + 1] = s.d[i + 2];
    }
    this.frames.push({ t: s.at, m: [...this.lastM] });
    if (this.frames.length > MAX_FRAMES) this.frames.shift();
  }

  /** The server's puck position. */
  track(m: Msg<'pk'>) {
    this.sample(m.at);
    this.points.push({ t: m.at, x: m.p[0], y: m.p[1] });
    if (this.points.length > MAX_POINTS) this.points.shift();
  }

  /** Run `fn` when the picture on screen reaches server time `at` (at once if it has). */
  private fireAt(at: number, fn: () => void) {
    setTimeout(
      () => {
        if (!this.stopped) fn();
      },
      Math.max(0, at - this.renderMs()),
    );
  }

  /**
   * A hit, judged by the server. The puck positions it sent after the moment the hit was judged against are
   * from before the hit: they are dropped, and the puck's position now (after the hit) takes their place, so the
   * ball moves from the hit point straight along its new path.
   */
  hit(m: Msg<'hit'>) {
    this.points = this.points.filter((p) => p.t <= m.from);
    this.points.push({ t: m.at, x: m.p[0], y: m.p[1] });
    if (this.predicting && m.s === this.predictSeat && (m.s !== this.seat || m.from >= this.latestClaim - 60)) {
      // The answer to the bounce being shown: once the picture reaches it, the ball moves on to the server's positions.
      this.confirmAt = m.at;
    }
    // Hits we already heard when we predicted them aren't played twice.
    if (performance.now() - (this.predictedAt.get(m.s) ?? -1e9) < this.socket.rtt + 400) return;
    this.fireAt(m.at, () => this.fx?.({ t: 'hit', s: m.s, i: m.impact }));
  }

  /** The server judged our hit a miss: the ball goes on as its positions have it (the local bounce glides away). */
  miss() {
    if (this.predicting && this.predictSeat === this.seat) this.confirmAt = -Infinity;
  }

  wall(m: Msg<'wall'>) {
    this.fireAt(m.at, () => this.fx?.({ t: 'wall', i: m.i }));
  }

  /** The server's puck on request: take it now. */
  puck(st: PuckState) {
    this.points = [{ t: st.at, x: st.p[0], y: st.p[1] }];
    this.predicting = false;
    this.core.applyPuck({ x: st.p[0], y: st.p[1] }, { x: 0, y: 0 }, 0, st.vis);
    this.goalSince = 0;
  }

  goal(m: Msg<'goal'>) {
    this.goalSince = 0;
    this.fireAt(m.at, () => {
      this.scores = m.sc;
      this.predicting = false;
      this.core.applyGoal(m.s, m.c, m.sc);
    });
  }

  serve(m: Msg<'serve'>) {
    this.goalSince = 0;
    this.points = [{ t: m.at, x: m.p[0], y: m.p[1] }];
    this.fireAt(m.at, () => this.core.applyServe(m.s, { x: m.p[0], y: m.p[1] }));
  }

  /** Someone paused or resumed. `cd` > 0: the last pause ended; count down before the puck moves. */
  pauseChanged(m: Msg<'pause'>) {
    this.paused = m.paused.length > 0;
    this.cd = this.paused ? 0 : m.cd;
    this.core.hold = this.cd > 0 || this.paused;
    this.freezeAt(m.puck, m.thaw);
  }

  // --- to the server -------------------------------------------------------------

  /** A mallet's velocity as the physics sees it: movement in the last step, capped. */
  private malletVelocity() {
    const m = this.core.mallets[this.seat];
    let x = (m.pos.x - m.prev.x) * SIM_RATE;
    let y = (m.pos.y - m.prev.y) * SIM_RATE;
    const sp = Math.hypot(x, y);
    if (sp > MAX_MALLET_SPEED) {
      x *= MAX_MALLET_SPEED / sp;
      y *= MAX_MALLET_SPEED / sp;
    }
    return { x, y };
  }

  /** Core events: our own mallet hit the puck. Show the bounce now and report the touch. */
  private onEvent(e: MatchEvent, when?: number, speed?: { x: number; y: number }) {
    if (e.t !== 'hit' || e.s !== this.seat) return;
    const now = performance.now();
    const m = this.core.mallets[this.seat];
    const w = speed ?? this.malletVelocity();
    // The puck we hit is the one in the picture, whose time is the picture's.
    const at = when ?? Math.floor(this.renderMs());
    if (!this.predicting) this.predictSince = now;
    this.predicting = true;
    this.predictSeat = this.seat;
    this.confirmAt = Infinity;
    this.latestClaim = at;
    this.predictedAt.set(this.seat, now);
    this.pendingClaim = { at, q: [r3(m.pos.x), r3(m.pos.y)], w: [r3(w.x), r3(w.y)] };
  }

  /** Per frame: clocks, countdown, other mallets, the puck, and where we want our mallet. */
  private update(dt: number, nowMs: number) {
    const { ball, mallets, mallet } = this.view;
    if (!ball || !mallet) return;

    this.adapt(dt, nowMs);

    if (this.cd > 0) {
      this.cd = Math.max(0, this.cd - dt);
      this.core.hold = this.cd > 0 || this.paused;
    }
    if (this.cd > 0 || this.lastCd > 0) this.onCountdown(this.cd);
    this.lastCd = this.cd;
    this.countdown = this.cd;

    const R = this.renderMs();
    this.moveMallets(R, mallets);
    this.movePuck(R, nowMs, dt);

    if (this.pendingClaim && nowMs - this.lastClaimAt >= CLAIM_EVERY) {
      const c = this.pendingClaim;
      this.pendingClaim = null;
      this.lastClaimAt = nowMs;
      this.socket.sendBytes(encodeClaim(c.at, c.q, c.w));
    }

    if (this.core.awaitingGoal && this.goalSince && nowMs - this.goalSince > GOAL_WAIT) {
      this.goalSince = nowMs; // the server hasn't confirmed our goal: ask where the puck is
      this.socket.send({ t: 'resync' });
    }

    if (nowMs - this.lastSendAt >= SEND_EVERY) {
      const g = mallet.goal;
      const x = r3(g.x);
      const y = r3(g.y);
      const key = `${x},${y}`;
      if (key !== this.lastSent) {
        this.lastSent = key;
        this.lastSendAt = nowMs;
        this.socket.sendBytes(encodeIn(x, y));
      }
    }
  }

  /** Follow the server clock smoothly, and the delay to how late messages really are. */
  private adapt(dt: number, nowMs: number) {
    const off = this.socket.clockOffset - this.clk;
    this.clk += Math.abs(off) > CLOCK_SNAP ? off : Math.max(-CLOCK_SLEW * dt, Math.min(CLOCK_SLEW * dt, off));

    if (nowMs - this.lateAt > 400 && this.late.length >= 10) {
      this.lateAt = nowMs;
      const sorted = this.late.map((l) => l.ms).sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      this.delayTarget = Math.max(DELAY_MIN, Math.min(DELAY_MAX, p95 + DELAY_MARGIN));
    }
    const d = this.delayTarget - this.delay;
    this.delay += Math.max(-DELAY_DOWN * dt, Math.min(DELAY_UP * dt, d));
  }

  /** The other mallets: between the two snapshots around the drawn time. Never beyond the newest. */
  private moveMallets(R: number, mallets: View['mallets']) {
    const f = this.frames;
    if (!f.length) return;
    // Drop frames that are fully in the past, keeping the one at or before R.
    while (f.length > 2 && f[1].t <= R) f.shift();
    const a = f[0];
    const b = f[1];
    const k = b && b.t > a.t ? Math.min(1, Math.max(0, (R - a.t) / (b.t - a.t))) : 0;
    for (const m of mallets) {
      if (m.seat === this.seat) continue;
      const i = m.seat * 2;
      if (i + 1 >= a.m.length) continue;
      if (!b || k === 0) m.sim.place(a.m[i], a.m[i + 1]);
      else m.sim.place(a.m[i] + (b.m[i] - a.m[i]) * k, a.m[i + 1] + (b.m[i + 1] - a.m[i + 1]) * k);
    }
  }

  /** The puck as the server's positions put it at server time `R`, with its velocity along that stretch. */
  private puckAt(R: number): { x: number; y: number; vx: number; vy: number } | null {
    const p = this.points;
    while (p.length > 2 && p[1].t < R - KEEP_MS) p.shift();
    if (!p.length) return null;
    // The stretch between the last position at or before R and the next one.
    let i = p.length - 1;
    while (i > 0 && p[i].t > R) i--;
    const a = p[i];
    const b = p[i + 1];
    if (!b || b.t <= a.t) return { x: a.x, y: a.y, vx: 0, vy: 0 };
    const k = Math.min(1, Math.max(0, (R - a.t) / (b.t - a.t)));
    const sec = (b.t - a.t) / 1000;
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, vx: (b.x - a.x) / sec, vy: (b.y - a.y) / sec };
  }

  private movePuck(R: number, nowMs: number, dt: number) {
    const core = this.core;
    if (core.hold || core.awaitingGoal || !core.visible) {
      this.before = null;
      return;
    }
    const match = this.view.match!;
    const target = this.puckAt(R);

    if (this.predicting) {
      this.before = null;
      const due = R >= this.confirmAt || nowMs - this.predictSince > this.socket.rtt + PREDICT_EXTRA;
      if (!due || !target) return; // the local bounce keeps flying (the core's own steps)
      // Hand over: from where the local ball is to the server's, gliding away any difference.
      this.predicting = false;
      const dx = core.physics.pos.x + match.glide.x - target.x;
      const dy = core.physics.pos.y + match.glide.y - target.y;
      const near = Math.hypot(dx, dy) < GLIDE_MAX;
      match.glide.x = near ? dx : 0;
      match.glide.y = near ? dy : 0;
    }
    if (!target) return;
    core.physics.pos.x = target.x;
    core.physics.pos.y = target.y;
    core.physics.vel.x = target.vx;
    core.physics.vel.y = target.vy;
    this.findContact(target, R, dt);
    match.syncBall();
  }

  /**
   * Did a mallet touch the puck between last frame and this one? Both moved in a straight line, so the first moment
   * they were a radius-sum apart is solved exactly (not sampled). If one did, the puck is put at that moment's place
   * and bounced there, with the mallet's own speed: our mallet's hit is reported to the server, any other is a
   * prediction of the hit the server is about to announce.
   */
  private findContact(target: { x: number; y: number; vx: number; vy: number }, R: number, dt: number) {
    const core = this.core;
    const now = {
      puck: { x: target.x, y: target.y },
      mallets: this.view.mallets.map((m) => ({ x: m.sim.pos.x, y: m.sim.pos.y })),
    };
    const was = this.before;
    this.before = now;
    if (!was || dt <= 0 || dt > 0.1) return;

    let first: { s: number; seat: number; min: number } | null = null;
    this.view.mallets.forEach((m, i) => {
      const min = m.sim.radius + core.physics.radius;
      const a = was.mallets[i];
      const b = now.mallets[i];
      if (!a || !b) return;
      // The puck relative to this mallet, before and after.
      const s = sweepEntry(was.puck.x - a.x, was.puck.y - a.y, now.puck.x - b.x, now.puck.y - b.y, min);
      if (s !== null && (!first || s < first.s)) first = { s, seat: m.seat, min };
    });
    if (!first) return;
    const { s, seat, min } = first as { s: number; seat: number; min: number };
    const a = was.mallets[seat];
    const b = now.mallets[seat];
    // The mallet's speed over the frame, as the physics would see it (capped).
    let wx = (b.x - a.x) / dt;
    let wy = (b.y - a.y) / dt;
    const sp = Math.hypot(wx, wy);
    if (sp > MAX_MALLET_SPEED) {
      wx *= MAX_MALLET_SPEED / sp;
      wy *= MAX_MALLET_SPEED / sp;
    }
    const p = { x: was.puck.x + (now.puck.x - was.puck.x) * s, y: was.puck.y + (now.puck.y - was.puck.y) * s };
    const v = { x: target.vx, y: target.vy };
    const impact = bounceOff(p, v, a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s, wx, wy, min);
    if (impact < MIN_PREDICT_IMPACT) return; // they were moving apart, or barely touching: not a hit
    core.physics.pos.x = p.x;
    core.physics.pos.y = p.y;
    core.physics.vel.x = v.x;
    core.physics.vel.y = v.y;
    this.before = null;
    const hitAt = performance.now();
    this.predicting = true;
    this.predictSeat = seat;
    this.predictSince = hitAt;
    this.confirmAt = Infinity;
    this.predictedAt.set(seat, hitAt);
    const e: MatchEvent = { t: 'hit', s: seat, i: impact };
    this.fx?.(e);
    // The touch happened (1 - s) of a frame ago in the picture.
    if (seat === this.seat) this.onEvent(e, Math.floor(R - (1 - s) * dt * 1000), { x: wx, y: wy });
  }

  stop() {
    this.stopped = true;
    this.view.onFrame = null;
  }
}

import { encodeIn, quantize, type StateFrame } from '@airhockey/shared/binary';
import type { PlayerCount } from '@airhockey/shared/layout';
import type { MatchCore, MatchEvent } from '@airhockey/shared/match';
import { TICK, TICK_RATE } from '@airhockey/shared/net';
import { NetClock } from '@airhockey/shared/netclock';
import { lagWeight, Predictor, type Sample } from '@airhockey/shared/predict';
import type { SeatInfo, ServerMsg } from '@airhockey/shared/protocol';
import type { RoomSettings } from '@airhockey/shared/room';
import type { View } from '../game/view';
import type { Socket } from './socket';

type StartMsg = Extract<ServerMsg, { t: 'start' }>;
type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

/*
 * The server runs the game; this client predicts it, and draws each thing at the moment that makes it fair to look at.
 *
 * Clock: the client runs AHEAD of the server, by about half a round trip plus a little. The local mallet's position
 * for each tick is sent at once, so it reaches the server just before the server simulates that tick: the server's
 * puck meets exactly the mallet the player moved. The server reports how early the inputs arrive (`slack`) and the
 * lead follows it. No hit claims, no rewinding: the server simply has your input in time.
 *
 * Prediction (`Predictor`): from each server state (the puck's position and velocity, every mallet) the game is re-run
 * up to the present with your own inputs and the other mallets carried on, using the same physics as the server.
 *
 * Display (a "local perception filter"): your mallet and a puck near you are drawn in the present, where your hits
 * happen. Things near the other players are drawn `depth` ticks in the past, where the server has already confirmed
 * them, so their hits are seen as they happened rather than predicted and corrected. In between, the puck's time
 * slides from one to the other.
 */

const CLOCK_SLEW = 5; // ms per second the server clock estimate may move
const CLOCK_JUMP = 50;
const TIME_MIN = 0.3; // the puck's time runs at least this fast...
const TIME_MAX = 3; // ...and at most this fast, relative to real time
const GLIDE_MAX = 6; // a correction bigger than this (table units) jumps instead of gliding
const MAX_TICKS_PER_FRAME = 60;

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
  private cd = 0;
  private lastCd = -1;
  /** Sound, colour and effects for an event (the match's own handler). */
  private fx: ((e: MatchEvent) => void) | null = null;
  private pred!: Predictor;

  // clock
  private clk: number;
  private clock!: NetClock;
  /** Last tick the local mallet was moved for (and sent). */
  private inputTick = 0;

  // display
  private puckTime = -1;
  private malletTime: number[] = [];
  private shown: Sample = { x: 0, y: 0, vis: true, m: [] };
  private scratch: Sample = { x: 0, y: 0, vis: true, m: [] };
  /** Goals and serves from the server, played when the picture reaches them. */
  private queued: { tick: number; fn: () => void }[] = [];

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
    view.onFrame = (dt) => this.update(dt);
  }

  get localSeat() {
    return this.seat;
  }

  private get core(): MatchCore {
    return this.view.match!.core;
  }

  /** Server clock now, ms (smoothed). */
  private serverNow() {
    return Date.now() + this.clk;
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
  }

  /** Take the game state a `start` message carries and set the clock from it. */
  private load(msg: StartMsg) {
    const st = msg.state;
    this.cd = msg.cd;
    this.pred = new Predictor(this.players, this.settings.malletScale, this.seat);
    this.core.mallets.forEach((m, i) => m.place(st.m[i * 2], st.m[i * 2 + 1]));
    this.clock = new NetClock(st, this.socket.rtt, this.serverNow());
    this.inputTick = Math.floor(this.clock.now);
    this.queued = [];
    this.state(st);
    this.pred.advance(this.inputTick);
    this.puckTime = this.inputTick - this.clock.depth;
    this.malletTime = this.core.mallets.map(() => this.puckTime);
    this.draw(0);
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
    const own = this.core.mallets[this.seat];
    const keep = { pos: { ...own.pos }, target: { ...own.target } };
    this.scores = [...this.core.scores];
    this.build();
    const m = this.core.mallets[this.seat];
    m.place(keep.pos.x, keep.pos.y);
    m.moveTo(keep.target);
    this.draw(0);
  }

  // --- from the server -----------------------------------------------------------

  /** A server state: the truth up to its tick. */
  state(st: StateFrame) {
    this.pred.setAuth(st);
    this.clock.onState(st, this.seat, performance.now());
  }

  hit(m: Msg<'hit'>) {
    this.pred.report(m.tick, { t: 'hit', s: m.s, i: m.i });
  }

  wall(m: Msg<'wall'>) {
    this.pred.report(m.tick, { t: 'wall', i: m.i });
  }

  goal(m: Msg<'goal'>) {
    this.queue(m.tick, () => {
      this.scores = [...m.sc];
      this.core.notify({ t: 'goal', s: m.s, c: m.c, sc: m.sc });
    });
  }

  serve(m: Msg<'serve'>) {
    this.queue(m.tick, () => this.core.notify({ t: 'serve', s: m.s }));
  }

  /** Someone paused or resumed. `cd` > 0: the last pause ended; count down before the puck moves. */
  pauseChanged(m: Msg<'pause'>) {
    this.cd = m.paused.length > 0 ? 0 : m.cd;
  }

  private queue(tick: number, fn: () => void) {
    this.queued.push({ tick, fn });
    this.queued.sort((a, b) => a.tick - b.tick);
  }

  // --- per frame -----------------------------------------------------------------

  private update(dt: number) {
    if (!this.view.ball || !this.view.mallet) return;
    if (this.cd > 0) this.cd = Math.max(0, this.cd - dt);
    if (this.cd > 0 || this.lastCd > 0) this.onCountdown(this.cd);
    this.lastCd = this.cd;
    this.countdown = this.cd;

    this.tickClock(dt);
    this.moveOwnMallet();
    const before = this.pred.authTick;
    // Where the puck is drawn now, before a new state changes the prediction: the difference glides away.
    this.pred.sample(this.puckTime, this.scratch);
    const was = { x: this.scratch.x, y: this.scratch.y };
    this.pred.advance(this.inputTick);
    if (this.pred.authTick !== before) {
      this.pred.sample(this.puckTime, this.scratch);
      const g = this.view.match!.glide;
      const dx = was.x - this.scratch.x;
      const dy = was.y - this.scratch.y;
      if (Math.hypot(g.x + dx, g.y + dy) < GLIDE_MAX) {
        g.x += dx;
        g.y += dy;
      } else g.x = g.y = 0;
    }
    this.draw(dt);
  }

  /** Follow the server clock (see `NetClock`). */
  private tickClock(dt: number) {
    const off = this.socket.clockOffset - this.clk;
    this.clk += Math.abs(off) > CLOCK_JUMP ? off : Math.max(-CLOCK_SLEW * dt, Math.min(CLOCK_SLEW * dt, off));
    this.clock.update(dt, this.serverNow());
  }

  /** The local mallet, one tick at a time up to the present; each position is kept for prediction and sent. */
  private moveOwnMallet() {
    const m = this.core.mallets[this.seat];
    const to = Math.floor(this.clock.now);
    if (to <= this.inputTick) return;
    // Way behind (a sleeping tab): skip ahead instead of replaying it all.
    if (to - this.inputTick > MAX_TICKS_PER_FRAME) this.inputTick = to - MAX_TICKS_PER_FRAME;
    const first = this.inputTick + 1;
    const sent: number[] = [];
    for (let t = first; t <= to; t++) {
      m.update(TICK);
      m.pos.x = quantize(m.pos.x);
      m.pos.y = quantize(m.pos.y);
      this.pred.addInput(t, m.pos.x, m.pos.y);
      sent.push(m.pos.x, m.pos.y);
    }
    this.inputTick = to;
    this.socket.sendBytes(encodeIn(first, sent));
  }

  /** Puck and other mallets at their display times; play what the picture reached. */
  private draw(dt: number) {
    const core = this.core;
    const layout = this.pred.layout;
    const present = Math.min(this.clock.now, this.pred.latest);
    const depth = this.clock.depth;
    const step = dt * TICK_RATE;

    // The puck: its time depends on where it is, which depends on its time. A few rounds settle it.
    let t = this.puckTime;
    for (let i = 0; i < 3; i++) {
      this.pred.sample(t, this.scratch);
      t = present - depth * lagWeight(layout, this.seat, this.scratch);
    }
    if (dt > 0) t = Math.max(this.puckTime + step * TIME_MIN, Math.min(this.puckTime + step * TIME_MAX, t));
    t = Math.max(present - depth - 4, Math.min(present, t));
    this.puckTime = t;
    const s = this.pred.sample(t, this.shown);
    core.physics.pos.x = s.x;
    core.physics.pos.y = s.y;
    core.visible = s.vis;

    // Other mallets: each at the time of where it is.
    this.view.mallets.forEach((m) => {
      if (m.seat === this.seat) return;
      this.pred.sample(present - depth, this.scratch);
      const at = { x: this.scratch.m[m.seat * 2], y: this.scratch.m[m.seat * 2 + 1] };
      let mt = present - depth * lagWeight(layout, this.seat, at);
      const prev = this.malletTime[m.seat] ?? mt;
      if (dt > 0) mt = Math.max(prev + step * TIME_MIN, Math.min(prev + step * TIME_MAX, mt));
      mt = Math.max(present - depth - 4, Math.min(present, mt));
      this.malletTime[m.seat] = mt;
      this.pred.sample(mt, this.scratch);
      m.sim.place(this.scratch.m[m.seat * 2], this.scratch.m[m.seat * 2 + 1]);
    });

    for (const e of this.pred.due(t)) this.fx?.(e);
    while (this.queued.length && this.queued[0].tick <= t) this.queued.shift()!.fn();
    this.view.match!.syncBall();
  }

  stop() {
    this.view.onFrame = null;
  }
}

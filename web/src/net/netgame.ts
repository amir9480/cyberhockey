import { TICK_RATE, type SeatInfo, type ServerMsg, type Snapshot } from '@airhockey/shared/protocol';
import type { RoomSettings } from '@airhockey/shared/room';
import type { PlayerCount } from '@airhockey/shared/layout';
import type { View } from '../game/view';
import type { Socket } from './socket';

type StartMsg = Extract<ServerMsg, { t: 'start' }>;

/** Render this far behind the estimated server time, so there is usually a newer snapshot to blend toward. */
const RENDER_DELAY = 0.05;
const OFFSET_SNAP = 0.25; // a clock jump bigger than this (e.g. after a pause) is taken at once
const OFFSET_RATE = 0.05;
const SEND_EVERY = 1000 / 60; // ms, at most 60 mallet updates a second
const MAX_BUFFER = 120;

interface Frame {
  t: number;
  bx: number;
  by: number;
  v: number;
  m: number[];
}

/** Drives an online game on the `View`: predicts the local mallet, interpolates everything else from snapshots. */
export class NetGame {
  seats: SeatInfo[];
  scores: number[];
  /** Seconds left of the countdown shown on screen, 0 when none. */
  countdown = 0;
  onCountdown: (secs: number) => void = () => {};
  private players: PlayerCount;
  private seat: number;
  private settings: RoomSettings;
  private buf: Frame[] = [];
  private offset = 0;
  private haveOffset = false;
  private lastSent = { x: NaN, y: NaN };
  private lastSendAt = 0;
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
    this.build();
    view.onFrame = (_dt, now) => this.update(now);
  }

  get localSeat() {
    return this.seat;
  }

  private build() {
    this.view.setupNet(
      this.players,
      this.seat,
      this.seats.map((s) => s.color),
      this.settings,
      this.scores,
    );
    this.buf = [];
    this.haveOffset = false;
    this.lastSent = { x: NaN, y: NaN };
  }

  /** The server re-sent `start` (reclaimed or took a seat, or reconnected): rebuild from it. */
  restart(msg: StartMsg) {
    this.players = msg.players;
    this.seat = msg.seat;
    this.settings = msg.settings;
    this.seats = msg.seats;
    this.scores = [...msg.scores];
    this.build();
  }

  /** Seat owners, names, AI flags or colours changed. Colours are baked into the table, so they rebuild it. */
  setSeats(seats: SeatInfo[]) {
    const recolour = seats.some((s, i) => s.color !== this.seats[i]?.color);
    this.seats = seats;
    if (recolour) this.build();
  }

  snapshot(s: Snapshot) {
    const now = performance.now() / 1000;
    const t = s.n / TICK_RATE;
    const off = t - now;
    if (!this.haveOffset || Math.abs(off - this.offset) > OFFSET_SNAP) {
      this.offset = off;
      this.haveOffset = true;
    } else this.offset += (off - this.offset) * OFFSET_RATE;
    this.buf.push({ t, bx: s.b[0], by: s.b[1], v: s.v, m: s.m });
    if (this.buf.length > MAX_BUFFER) this.buf.shift();

    for (const e of s.e ?? []) {
      if (e.t === 'goal') this.scores = e.sc;
      this.view.netFx?.handle(e);
    }
    const cd = s.cd ?? 0;
    if (cd > 0 || this.lastCd > 0) {
      this.countdown = cd;
      this.onCountdown(cd);
    }
    this.lastCd = cd;
  }

  /** Per frame: blend the buffered snapshots at the render time and send the local mallet's target. */
  private update(nowMs: number) {
    const { ball, mallets, mallet } = this.view;
    if (!ball) return;

    if (this.buf.length) {
      const renderT = nowMs / 1000 + this.offset - RENDER_DELAY;
      // Drop frames that are fully in the past, keeping the one at or before renderT.
      while (this.buf.length > 2 && this.buf[1].t <= renderT) this.buf.shift();
      const a = this.buf[0];
      const b = this.buf[1];
      // Never extrapolate: past the newest snapshot, hold it.
      const k = b && b.t > a.t ? Math.min(1, Math.max(0, (renderT - a.t) / (b.t - a.t))) : 0;
      const to = k > 0 ? b : a;
      ball.setPosition({ x: a.bx + (to.bx - a.bx) * k, y: a.by + (to.by - a.by) * k });
      ball.group.visible = a.v === 1;
      for (const m of mallets) {
        if (m === mallet) continue;
        const i = m.seat * 2;
        if (i + 1 >= a.m.length || i + 1 >= to.m.length) continue;
        m.sim.place(a.m[i] + (to.m[i] - a.m[i]) * k, a.m[i + 1] + (to.m[i + 1] - a.m[i + 1]) * k);
      }
    }

    if (mallet && nowMs - this.lastSendAt >= SEND_EVERY) {
      const g = mallet.goal;
      if (g.x !== this.lastSent.x || g.y !== this.lastSent.y) {
        this.lastSent = { x: g.x, y: g.y };
        this.lastSendAt = nowMs;
        this.socket.send({ t: 'in', x: Math.round(g.x * 1000) / 1000, y: Math.round(g.y * 1000) / 1000 });
      }
    }
  }

  stop() {
    this.view.onFrame = null;
  }
}

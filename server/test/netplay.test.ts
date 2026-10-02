import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { decodeServer, encodeIn, quantize, type StateFrame } from '@airhockey/shared/binary';
import { buildLayout } from '@airhockey/shared/layout';
import { SimMallet } from '@airhockey/shared/mallet';
import { TICK } from '@airhockey/shared/net';
import { NetClock } from '@airhockey/shared/netclock';
import { Predictor, type Sample } from '@airhockey/shared/predict';
import type { ServerMsg } from '@airhockey/shared/protocol';
import { newToken, sleep, startServer, type GameServer } from './helpers';

const ONE_WAY = 100; // ms each way: a 200 ms ping

let server: GameServer;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  ({ server, port } = await startServer());
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await server.close();
});

/**
 * A headless online client: the same clock and prediction as the browser's NetGame, over a connection that delays
 * everything by ONE_WAY ms each way. Its mallet chases the puck as this client predicts it now.
 */
class Bot {
  ws: WebSocket;
  seat = -1;
  clock: NetClock | null = null;
  pred: Predictor | null = null;
  mallet: SimMallet | null = null;
  inputTick = 0;
  /** Ticks this client showed its own hits at (as it happened on screen, no waiting). */
  shownHits: number[] = [];
  /** Ticks the server says this seat hit the puck. */
  serverHits: number[] = [];
  lateStates = 0;
  /** Distance between the predicted puck and the server's, per state. */
  errors: number[] = [];
  settleTick = Infinity;
  lastStateTick = 0;
  private side = 1.5;
  states = 0;
  goals = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = performance.now();
  private s: Sample = { x: 0, y: 0, vis: true, m: [] };

  constructor(name: string) {
    this.ws = new WebSocket(`ws://localhost:${port}/ws?token=${newToken()}&name=${name}`);
    sockets.push(this.ws);
    this.ws.on('message', (d, isBinary) => {
      const buf = d as Buffer;
      const msg = isBinary ? decodeServer(new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))) : JSON.parse(d.toString());
      if (msg) setTimeout(() => this.onMessage(msg as ServerMsg), ONE_WAY);
    });
  }

  opened() {
    return new Promise<void>((res) => this.ws.once('open', () => res()));
  }

  send(bytesOrMsg: Uint8Array | object) {
    setTimeout(() => {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      if (bytesOrMsg instanceof Uint8Array) this.ws.send(bytesOrMsg);
      else this.ws.send(JSON.stringify(bytesOrMsg));
    }, ONE_WAY);
  }

  private onMessage(m: ServerMsg) {
    if (m.t === 'start') {
      this.seat = m.seat;
      this.side = m.seat === 0 ? 1.6 : -1.6;
      this.pred = new Predictor(m.players, m.settings.malletScale, m.seat);
      this.mallet = new SimMallet(buildLayout(m.players), m.seat, m.settings.malletScale);
      this.mallet.place(m.state.m[m.seat * 2], m.state.m[m.seat * 2 + 1]);
      this.clock = new NetClock(m.state, ONE_WAY * 2, Date.now());
      this.inputTick = Math.floor(this.clock.now);
      this.settleTick = m.state.tick + 240;
      this.pred.setAuth(m.state);
      this.timer = setInterval(() => this.frame(), 8);
    } else if (m.t === 'st' && this.pred && this.clock) {
      const st = m as StateFrame;
      // What this client had predicted for that tick, against the truth.
      if (st.vis && this.pred.latest >= st.tick && st.tick > this.settleTick) {
        this.pred.sample(st.tick, this.s);
        this.errors.push(Math.hypot(this.s.x - st.p[0], this.s.y - st.p[1]));
      }
      this.pred.setAuth(st);
      this.clock.onState(st, this.seat, performance.now());
      this.states++;
      this.lastStateTick = st.tick;
      if (st.slack[this.seat] < 0 && st.tick > this.settleTick) this.lateStates++;
    } else if (m.t === 'hit') {
      if (m.s === this.seat) this.serverHits.push(m.tick);
      this.pred?.report(m.tick, { t: 'hit', s: m.s, i: m.i });
    } else if (m.t === 'goal') this.goals++;
  }

  private frame() {
    const now = performance.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    const { clock, pred, mallet } = this;
    if (!clock || !pred || !mallet) return;
    clock.update(dt, Date.now());
    // Play the puck as predicted now: get behind it, then strike through it toward the other goal.
    pred.sample(pred.latest, this.s);
    const layout = pred.layout;
    const puck = { x: this.s.x, y: this.s.y };
    const goal = layout.seats[1 - this.seat].goalCenter;
    const d = Math.hypot(goal.x - puck.x, goal.y - puck.y) || 1;
    const dir = { x: (goal.x - puck.x) / d, y: (goal.y - puck.y) / d };
    const mine = layout.seats[this.seat].goalCenter;
    const ours = Math.hypot(puck.x - mine.x, puck.y - mine.y) < Math.hypot(puck.x - goal.x, puck.y - goal.y);
    const behind = (mallet.pos.x - puck.x) * dir.x + (mallet.pos.y - puck.y) * dir.y < -1;
    if (!ours) mallet.moveTo({ x: mine.x * 0.75, y: mine.y * 0.75 });
    else if (behind) mallet.moveTo({ x: puck.x + dir.x * 3, y: puck.y + dir.y * 3 });
    else mallet.moveTo({ x: puck.x - dir.x * 2.5 + this.side, y: puck.y - dir.y * 2.5 });
    const to = Math.floor(clock.now);
    if (to > this.inputTick) {
      const first = this.inputTick + 1;
      const sent: number[] = [];
      for (let t = first; t <= to; t++) {
        mallet.update(TICK);
        mallet.pos.x = quantize(mallet.pos.x);
        mallet.pos.y = quantize(mallet.pos.y);
        pred.addInput(t, mallet.pos.x, mallet.pos.y);
        sent.push(mallet.pos.x, mallet.pos.y);
      }
      this.inputTick = to;
      this.send(encodeIn(first, sent));
    }
    pred.advance(this.inputTick);
    // Own hits show the moment they are predicted (the puck near you is drawn in the present).
    for (const e of pred.due(this.inputTick)) if (e.t === 'hit' && e.s === this.seat) this.shownHits.push(this.inputTick);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

describe('online play at a 200 ms ping', () => {
  it('server and players agree on every hit: inputs arrive in time, no ghost hits', async () => {
    const a = new Bot('A');
    const b = new Bot('B');
    await Promise.all([a.opened(), b.opened()]);
    await sleep(50);
    a.send({ t: 'quick', size: 2 });
    b.send({ t: 'quick', size: 2 });
    await sleep(8000);
    a.stop();
    b.stop();

    for (const bot of [a, b]) {
      expect(bot.states).toBeGreaterThan(300);
      // After the clock settles, the server has every input before it needs it.
      expect(bot.lateStates / bot.states).toBeLessThan(0.1);
    }
    const all = [a, b];
    // A mallet pushing the puck is reported every substep: one touch is hits less than TOUCH ticks apart.
    const TOUCH = 20;
    const near = (ticks: number[], t: number) => ticks.some((h) => Math.abs(h - t) <= TOUCH);
    const touches = (ticks: number[]) => ticks.filter((t, i) => i === 0 || t - ticks[i - 1] > TOUCH);
    // Judged only between the clock settling and the last reports still on their way.
    const judged = (x: Bot, t: number) => t > x.settleTick && t < x.lastStateTick - TOUCH;
    const shown = all.flatMap((x) => touches(x.shownHits).filter((t) => judged(x, t)).map((t) => ({ x, t })));
    // Only the other player can make a hit you saw not happen, by touching the puck less than a round trip before
    // (news of it can't reach you sooner). Any other miss would be the netcode's fault.
    const RTT_TICKS = Math.ceil((ONE_WAY * 2) / (TICK * 1000)) + 24;
    const ghosts = shown.filter(({ x, t }) => {
      const other = all.find((y) => y !== x)!;
      return !near(x.serverHits, t) && !other.serverHits.some((h) => h <= t && t - h <= RTT_TICKS);
    });
    const real = all.flatMap((x) => touches(x.serverHits).filter((t) => judged(x, t)).map((t) => ({ x, t })));
    const unseen = real.filter(({ x, t }) => !near(x.shownHits, t));
    const errs = all.flatMap((x) => x.errors).sort((p, q) => p - q);
    const pct = (q: number) => errs[Math.min(errs.length - 1, Math.floor(errs.length * q))] ?? 0;
    console.log(
      `own touches shown ${shown.length}, ghosts ${ghosts.length}; server touches ${real.length}, never shown ${unseen.length}; ` +
        `puck prediction error p50 ${pct(0.5).toFixed(3)} p95 ${pct(0.95).toFixed(3)} max ${pct(1).toFixed(3)}`,
    );
    expect(real.length).toBeGreaterThan(0);
    expect(ghosts).toHaveLength(0);
    expect(unseen).toHaveLength(0);
    // The predicted puck is where the server has it, except for a moment after the other player touches it.
    expect(pct(0.95)).toBeLessThan(0.05);
  }, 20000);
});

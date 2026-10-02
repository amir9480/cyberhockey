import { describe, expect, it } from 'vitest';
import { decodeClient, decodeServer, encodeHit, encodeIn, encodeState, encodeWall, quantize, type StateFrame } from '../src/binary';
import { serveSpot } from '../src/layout';
import { MatchCore } from '../src/match';
import { FREEZE_HELD, TICK } from '../src/net';
import { MAX_MALLET_SPEED, Physics, sweepEntry, type MalletBody } from '../src/physics';
import { DisplayTime, lagWeight, pathWeight, Predictor, type Sample } from '../src/predict';

describe('binary frames', () => {
  it('round-trips a game state, hits, wall bounces and mallet input', () => {
    const st: StateFrame = { tick: 1234, at: 1_700_000_000_123, freeze: 7, vis: true, p: [1.5, -2.25], v: [12.5, -3], m: [0, -5, 1.25, 5], slack: [3, -2] };
    const d = decodeServer(encodeState(st));
    expect(d).toMatchObject({ t: 'st', tick: 1234, at: st.at, freeze: 7, vis: true, p: [1.5, -2.25], v: [12.5, -3], slack: [3, -2] });
    expect((d as { m: number[] }).m).toEqual([0, -5, 1.25, 5]);
    expect(decodeServer(encodeState({ ...st, freeze: FREEZE_HELD, vis: false, slack: [Infinity, -500] }))).toMatchObject({ freeze: FREEZE_HELD, vis: false, slack: [127, -128] });
    expect(decodeServer(encodeHit(1, 5000, 12.5))).toEqual({ t: 'hit', s: 1, tick: 5000, i: 12.5 });
    expect(decodeServer(encodeWall(5000, 7.25))).toEqual({ t: 'wall', tick: 5000, i: 7.25 });
    expect(decodeClient(encodeIn(77, [1.5, -2.25, 1.6, -2.2]))).toEqual({ t: 'in', tick: 77, m: [1.5, -2.25, 1.6, -2.2] });
  });

  it('ignores truncated or unknown frames', () => {
    expect(decodeServer(new Uint8Array([1, 0, 0]))).toBeNull();
    expect(decodeServer(new Uint8Array([99]))).toBeNull();
    expect(decodeClient(new Uint8Array([0x10, 1]))).toBeNull();
    expect(decodeClient(encodeIn(1, [1, 2, 3, 4]).slice(0, 8))).toBeNull();
    expect(decodeClient(new Uint8Array())).toBeNull();
  });
});

describe('sweepEntry (continuous contact)', () => {
  it('finds the first moment a point moving in a line gets within a radius', () => {
    expect(sweepEntry(-5, 0, 5, 0, 1)).toBeCloseTo(0.4, 6);
    expect(sweepEntry(0.5, 0, 9, 9, 1)).toBe(0);
    expect(sweepEntry(-5, 2, 5, 2, 1)).toBeNull();
    expect(sweepEntry(-5, 0, -3, 0, 1)).toBeNull();
    expect(sweepEntry(-5, 0, -9, 0, 1)).toBeNull();
    const s = sweepEntry(-50, 0.2, 50, 0.2, 1.3);
    expect(-50 + 100 * (s as number)).toBeCloseTo(-Math.sqrt(1.3 ** 2 - 0.2 ** 2), 6);
  });
});

describe('physics: nothing passes through a mallet', () => {
  const quiet = { onHit: () => {}, onWall: () => {}, onGoal: () => {} };
  const match = () => new MatchCore(2, 1, 5);

  it('a flicked mallet hits a resting puck instead of jumping over it', () => {
    const m = match();
    const ph = new Physics(m.layout, quiet);
    ph.reset({ x: 0, y: 3 });
    // A mallet moving far faster than allowed, 3 units in one tick, straight through the puck.
    const body: MalletBody = { seat: 0, radius: 0.75, prev: { x: -1.5, y: 3 }, cur: { x: 1.5, y: 3 } };
    ph.step(TICK, [body]);
    expect(ph.vel.x).toBeGreaterThan(5);
    expect(ph.pos.x).toBeGreaterThan(1.5 + 1.29);
  });

  it('a fast puck bounces off a still mallet', () => {
    const m = match();
    const ph = new Physics(m.layout, quiet);
    ph.reset({ x: 0, y: 6 });
    ph.vel.y = -38;
    const body: MalletBody = { seat: 0, radius: 0.75, prev: { x: 0, y: 3 }, cur: { x: 0, y: 3 } };
    for (let i = 0; i < 30; i++) ph.step(TICK, [body]);
    expect(ph.vel.y).toBeGreaterThan(0);
    expect(ph.pos.y).toBeGreaterThan(3);
  });

  it('a mallet never moves faster than the cap', () => {
    const m = match();
    const mallet = m.mallets[0];
    mallet.moveTo({ x: -100, y: 100 });
    const was = { ...mallet.pos };
    mallet.update(TICK);
    expect(Math.hypot(mallet.pos.x - was.x, mallet.pos.y - was.y)).toBeLessThanOrEqual(MAX_MALLET_SPEED * TICK + 1e-9);
  });
});

/** A server match with both seats driven by exact positions, as in an online game. */
function serverMatch() {
  const m = new MatchCore(2, 1, 5);
  m.setDriven(0, true);
  m.setDriven(1, true);
  const state = (tick: number): StateFrame => ({
    tick,
    at: 0,
    freeze: m.visible ? 0 : FREEZE_HELD,
    vis: m.visible,
    p: [m.physics.pos.x, m.physics.pos.y],
    v: [m.physics.vel.x, m.physics.vel.y],
    m: m.mallets.flatMap((x) => [x.pos.x, x.pos.y]),
    slack: [0, 0],
  });
  return { m, state };
}

/** Seat 0's mallet path: from home, behind the puck, then through it toward the far goal. */
function shotPath(m: MatchCore) {
  const puck = serveSpot(m.layout, 0, 1);
  m.physics.reset(puck);
  const goal = m.layout.seats[1].goalCenter;
  const d = Math.hypot(goal.x - puck.x, goal.y - puck.y);
  const dir = { x: (goal.x - puck.x) / d, y: (goal.y - puck.y) / d };
  const back = { x: puck.x - dir.x * 2, y: puck.y - dir.y * 2 };
  const path: [number, number][] = [];
  let p = { ...m.mallets[0].pos };
  const toward = (q: { x: number; y: number }, speed: number, extra = 0) => {
    for (let i = 0; i < 400; i++) {
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-3) break;
      const s = Math.min(len, speed * TICK);
      p = m.mallets[0].clamp({ x: p.x + (dx / len) * s, y: p.y + (dy / len) * s });
      path.push([quantize(p.x), quantize(p.y)]);
    }
    for (let i = 0; i < extra; i++) path.push([quantize(p.x), quantize(p.y)]);
  };
  toward(back, 20, 10);
  toward({ x: puck.x + dir.x * 3, y: puck.y + dir.y * 3 }, 30, 20);
  return path;
}

describe('Predictor', () => {
  it('re-simulates from an old server state to exactly the server\'s present, own hit included', () => {
    const { m, state } = serverMatch();
    const path = shotPath(m);
    const still = { ...m.mallets[1].pos };
    const pred = new Predictor(2, 1, 0);
    const hits: number[] = [];
    m.onEvent = (e) => e.t === 'hit' && hits.push(tick);
    let tick = 100;
    pred.setAuth(state(tick));
    const lag = 40; // the client is 40 ticks ahead of the newest state it has (330 ms)
    const states: StateFrame[] = [];
    for (const [x, y] of path) {
      tick++;
      m.drive(0, { x, y });
      m.drive(1, still);
      m.step(TICK);
      pred.addInput(tick, x, y);
      states.push(state(tick));
      const known = states[states.length - 1 - lag];
      if (known) pred.setAuth(known);
      pred.advance(tick);
      const s = pred.sample(tick, { x: 0, y: 0, vis: true, m: [] } as Sample);
      // The prediction of the present matches the server's present, to float32 rounding of the state.
      expect(Math.hypot(s.x - m.physics.pos.x, s.y - m.physics.pos.y)).toBeLessThan(1e-3);
    }
    expect(hits.length).toBeGreaterThan(0);
    expect(Math.hypot(m.physics.vel.x, m.physics.vel.y)).toBeGreaterThan(5);
  });

  it('plays a predicted hit once, merges the server\'s report of it, and drops one the server never had', () => {
    // Where the server has the hit.
    const ref = serverMatch();
    const path = shotPath(ref.m);
    let hitTick = -1;
    ref.m.onEvent = (e) => e.t === 'hit' && hitTick < 0 && (hitTick = t);
    let t = 100;
    for (const [x, y] of path) {
      t++;
      ref.m.drive(0, { x, y });
      ref.m.step(TICK);
    }
    expect(hitTick).toBeGreaterThan(100);

    const run = () => {
      const { m, state } = serverMatch();
      shotPath(m);
      const pred = new Predictor(2, 1, 0);
      pred.setAuth(state(100));
      path.forEach(([x, y], i) => pred.addInput(101 + i, x, y));
      pred.advance(100 + path.length);
      return { pred, state };
    };

    const a = run().pred;
    expect(a.due(hitTick - 1).filter((e) => e.t === 'hit')).toHaveLength(0);
    expect(a.due(hitTick)).toContainEqual(expect.objectContaining({ t: 'hit', s: 0 }));
    // The server's report of the same hit, a tick off, is not played again.
    a.report(hitTick + 1, { t: 'hit', s: 0, i: 10 });
    expect(a.due(hitTick + 20).filter((e) => e.t === 'hit')).toHaveLength(0);

    // Not yet played, and a server state past it arrives without the server having reported it: it never happened.
    const { pred: b } = run();
    const { m: other, state: otherState } = serverMatch();
    other.physics.reset({ x: 0, y: 0 });
    b.setAuth({ ...otherState(hitTick + 5) });
    b.advance(hitTick + 10);
    expect(b.due(hitTick + 10).filter((e) => e.t === 'hit')).toHaveLength(0);
  });

  it('keeps server truth for the past and prediction after it', () => {
    const { m, state } = serverMatch();
    m.physics.reset({ x: 0, y: 0 });
    m.physics.vel.x = 5;
    const pred = new Predictor(2, 1, 0);
    pred.setAuth(state(10));
    pred.advance(30);
    const at20 = pred.sample(20, { x: 0, y: 0, vis: true, m: [] });
    expect(at20.x).toBeCloseTo(5 * 10 * TICK, 1);
    // Halfway between two ticks is halfway between their positions.
    const a = pred.sample(20, { x: 0, y: 0, vis: true, m: [] }).x;
    const b = pred.sample(21, { x: 0, y: 0, vis: true, m: [] }).x;
    expect(pred.sample(20.5, { x: 0, y: 0, vis: true, m: [] }).x).toBeCloseTo((a + b) / 2, 6);
  });
});

describe('lagWeight', () => {
  it('is 0 near your own goal, 1 near the others\', and grows in between', () => {
    const m = new MatchCore(2, 1, 5);
    const mine = m.layout.seats[0].goalCenter;
    const theirs = m.layout.seats[1].goalCenter;
    expect(lagWeight(m.layout, 0, mine)).toBe(0);
    expect(lagWeight(m.layout, 0, theirs)).toBe(1);
    let last = -1;
    for (let k = 0; k <= 10; k++) {
      const p = { x: mine.x + (theirs.x - mine.x) * (k / 10), y: mine.y + (theirs.y - mine.y) * (k / 10) };
      const w = lagWeight(m.layout, 0, p);
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
    }
    expect(lagWeight(m.layout, 0, { x: 0, y: 0 })).toBeCloseTo(0.5, 5);
  });
});

describe('DisplayTime', () => {
  /** The puck flying straight at the local goal at `speed`, drawn as NetGame draws it: its drawn speed per frame. */
  function drawnSpeeds(speed: number, depth = 33) {
    const pred = new Predictor(2, 1, 0);
    const L = pred.layout;
    const mine = L.seats[0].goalCenter;
    const theirs = L.seats[1].goalCenter;
    const len = Math.hypot(mine.x - theirs.x, mine.y - theirs.y);
    const dir = { x: (mine.x - theirs.x) / len, y: (mine.y - theirs.y) / len };
    const p = { x: theirs.x + dir.x * 2 + 2, y: theirs.y + dir.y * 2 };
    // Mallets out of the way.
    pred.setAuth({ tick: 0, at: 0, freeze: 0, vis: true, p: [p.x, p.y], v: [dir.x * speed, dir.y * speed], m: [-4, mine.y * 0.8, 4, theirs.y * 0.8], slack: [0, 0] });
    const dt = 1 / 60;
    let now = 40;
    const time = new DisplayTime(now - depth);
    const s: Sample = { x: 0, y: 0, vis: true, m: [] };
    const out: { v: number; lag: number }[] = [];
    let last: { x: number; y: number } | null = null;
    for (let f = 0; f < 70; f++) {
      now += dt / TICK;
      pred.advance(Math.ceil(now));
      let target = time.t;
      for (let i = 0; i < 3; i++) {
        pred.sample(target, s);
        target = now - depth * lagWeight(L, 0, s);
      }
      time.update(target, dt, now, now - depth - 4);
      const at = pred.sample(time.t, s);
      if (last) out.push({ v: Math.hypot(at.x - last.x, at.y - last.y) / dt, lag: now - time.t });
      last = { x: at.x, y: at.y };
    }
    return out;
  }

  it('keeps a puck bouncing back off the far wall near its true speed, without a kick at the bounce', () => {
    for (const speed of [18, 30]) {
      const pred = new Predictor(2, 1, 0);
      // Straight at the far end wall beside the goal, mallets out of the way.
      pred.setAuth({ tick: 0, at: 0, freeze: 0, vis: true, p: [3.2, 0], v: [0, -speed], m: [-4, 8, -4, -8], slack: [0, 0] });
      const depth = 34;
      const dt = 1 / 120;
      let now = 40;
      // As NetGame draws the puck: path-averaged target, rate held within [0.8, 1.25].
      const time = new DisplayTime(now - depth, 0.8, 1.25);
      const s: Sample = { x: 0, y: 0, vis: true, m: [] };
      const ratio: number[] = [];
      let last: { x: number; y: number } | null = null;
      for (let f = 0; f < 150; f++) {
        now += dt / TICK;
        pred.advance(Math.ceil(now));
        const look = Math.max(0, Math.min(15, now - time.t));
        time.update(now - depth * pathWeight(pred, 0, time.t, look, s), dt, now, now - depth - 4);
        const p = pred.sample(time.t, s);
        const at = { x: p.x, y: p.y };
        pred.sample(time.t - 2, s);
        const truth = Math.hypot(at.x - s.x, at.y - s.y) * (1 / (2 * TICK));
        // Frames straddling the bounce have no meaningful true speed (the 2-tick chord cuts across the wall).
        if (last && truth > speed * 0.8) ratio.push(Math.hypot(at.x - last.x, at.y - last.y) / dt / truth);
        else ratio.push(NaN);
        last = at;
      }
      const ok = ratio.filter((r) => !Number.isNaN(r));
      expect(Math.min(...ok)).toBeGreaterThan(0.75);
      expect(Math.max(...ok)).toBeLessThan(1.32);
      for (let i = 7; i < ratio.length; i++) {
        if (Number.isNaN(ratio[i]) || Number.isNaN(ratio[i - 7])) continue;
        expect(Math.abs(Math.log(ratio[i] / ratio[i - 7]))).toBeLessThan(Math.log(1.35));
      }
    }
  });

  it('changes the drawn speed of a free-flying puck gradually, never in a jump', () => {
    const v = drawnSpeeds(10);
    for (let i = 1; i < v.length; i++) expect(Math.abs(v[i].v - v[i - 1].v)).toBeLessThan(0.5);
    // The far side is drawn in the past and your side in the present.
    expect(v[0].lag).toBeGreaterThan(25);
    expect(v[v.length - 1].lag).toBeLessThan(1);
  });
});

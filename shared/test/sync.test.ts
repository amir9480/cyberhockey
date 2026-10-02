import { describe, expect, it } from 'vitest';
import { decodeClient, decodeServer, encodeClaim, encodeHitRelay, encodeIn, encodeKey, encodeSnapshot, encodeWall, QUANT } from '../src/binary';
import { MatchCore } from '../src/match';
import { sweepEntry } from '../src/physics';

describe('binary frames', () => {
  it('round-trips a snapshot of changed mallets (positions only)', () => {
    const m = decodeServer(encodeSnapshot(1_700_000_000_123, [0, 1.234, -5.5, 2, -3, 4]));
    expect(m).toMatchObject({ t: 's', at: 1_700_000_000_123 });
    const d = (m as { d: number[] }).d;
    expect(d.filter((_, i) => i % 3 === 0)).toEqual([0, 2]);
    expect(d[1]).toBeCloseTo(1.234, 2);
    expect(d[2]).toBeCloseTo(-5.5, 2);
  });

  it('round-trips puck positions, hits, wall bounces, mallet input and hit claims', () => {
    expect(decodeServer(encodeKey(5000, [1, 2]))).toMatchObject({ t: 'pk', at: 5000, p: [1, 2] });
    expect(decodeServer(encodeHitRelay(1, 4900, 5000, [1.5, 2], 12.5))).toMatchObject({ t: 'hit', s: 1, from: 4900, at: 5000, p: [1.5, 2], impact: 12.5 });
    expect(decodeServer(encodeWall(5000, 7.25))).toMatchObject({ t: 'wall', at: 5000, i: 7.25 });
    expect(decodeClient(encodeIn(1.5, -2.25))).toMatchObject({ t: 'in', x: 1.5, y: -2.25 });
    expect(decodeClient(encodeClaim(7000, [0.5, 0.25], [9, -9]))).toMatchObject({ t: 'hit', at: 7000, q: [0.5, 0.25], w: [9, -9] });
  });

  it('ignores truncated, unknown or non-finite frames', () => {
    expect(decodeServer(new Uint8Array([1, 0, 0]))).toBeNull();
    expect(decodeServer(new Uint8Array([99]))).toBeNull();
    expect(decodeClient(new Uint8Array([0x10, 1]))).toBeNull();
    expect(decodeClient(new Uint8Array([0x77, 0, 0, 0, 0]))).toBeNull();
    expect(decodeClient(new Uint8Array())).toBeNull();
    expect(decodeClient(encodeClaim(NaN, [0, 0], [0, 0]))).toBeNull();
  });

  it('is a fraction of the JSON size', () => {
    const snap = encodeSnapshot(1_700_000_000_123, [0, 1.2, 3.4, 1, -1.2, -3.4]).byteLength;
    const json = JSON.stringify({ t: 's', at: 1700000000123, d: [0, 1.2, 3.4, 1, -1.2, -3.4] }).length;
    expect(snap).toBeLessThan(json / 1.5);
    expect(QUANT).toBeGreaterThan(100);
  });
});

/** A 2-player match with the puck sent flying along the table at a still mallet. */
function target() {
  const m = new MatchCore(2, 1, 5);
  m.setCollide([]); // no mallet hits on its own: a hit only comes as a claim
  const seat = 0;
  const mallet = m.mallets[seat];
  // Put the puck in the seat's zone, heading straight at the mallet.
  const q = { x: mallet.pos.x, y: mallet.pos.y };
  const dir = { x: -m.layout.seats[seat].inward.x, y: -m.layout.seats[seat].inward.y };
  m.physics.pos.x = q.x - dir.x * 8;
  m.physics.pos.y = q.y - dir.y * 8;
  m.physics.vel.x = dir.x * 14;
  m.physics.vel.y = dir.y * 14;
  return { m, seat, q, dir };
}

describe('sweepEntry (continuous contact)', () => {
  it('finds the first moment a point moving in a line gets within a radius', () => {
    // Straight at the centre, radius 1, from 5 away to 5 past: touches after 4 of the 10 units.
    expect(sweepEntry(-5, 0, 5, 0, 1)).toBeCloseTo(0.4, 6);
    // Starts inside: at once.
    expect(sweepEntry(0.5, 0, 9, 9, 1)).toBe(0);
    // Passes by outside the radius, or stops short, or moves away.
    expect(sweepEntry(-5, 2, 5, 2, 1)).toBeNull();
    expect(sweepEntry(-5, 0, -3, 0, 1)).toBeNull();
    expect(sweepEntry(-5, 0, -9, 0, 1)).toBeNull();
    // Grazes the edge.
    expect(sweepEntry(-5, 0.8, 5, 0.8, 1)).toBeCloseTo((5 - Math.sqrt(1 - 0.64)) / 10, 6);
  });

  it('is not fooled by a step far longer than the circle is wide', () => {
    // 100 units in one step, straight through a circle of radius 1.3: no sampled end point is near it.
    const s = sweepEntry(-50, 0.2, 50, 0.2, 1.3);
    expect(s).not.toBeNull();
    expect(-50 + 100 * (s as number)).toBeCloseTo(-Math.sqrt(1.3 ** 2 - 0.2 ** 2), 6);
  });

  it('works for a puck and a mallet that both move, using their relative motion', () => {
    // Puck goes right at 10/step, mallet goes left at 10/step, 30 apart: they meet in the middle after 14 of 20 units
    // of closing (a 2.6 radius-sum): relative start -30, relative end -30 + 20 = -10 ... they never touch in one step.
    expect(sweepEntry(-30, 0, -10, 0, 2.6)).toBeNull();
    // 12 apart: relative -12 to +8 passes through the mallet.
    const s = sweepEntry(-12, 0, 8, 0, 2.6) as number;
    expect(s).toBeCloseTo((12 - 2.6) / 20, 6);
  });
});

describe('rewindHit (lag compensation)', () => {
  it('judges a hit against the puck as the player saw it, and replays to now', () => {
    // Reference: the puck meets a mallet in real time.
    const live = target();
    live.m.setCollide([live.seat]);
    let liveHit = -1;
    live.m.onEvent = (e) => {
      if (e.t === 'hit' && liveHit < 0) liveHit = steps;
    };
    let steps = 0;
    for (; steps < 140 && liveHit < 0; steps++) live.m.step(1 / 120);
    expect(liveHit).toBeGreaterThan(0);
    for (let i = 0; i < 12; i++) live.m.step(1 / 120);

    // Lagged: the server only hears about the touch 12 steps (100 ms) after it happened.
    const lag = target();
    let hits = 0;
    lag.m.onEvent = (e) => e.t === 'hit' && hits++;
    for (let i = 0; i < liveHit + 12; i++) lag.m.step(1 / 120);
    expect(hits).toBe(0); // the puck passed through the mallet on the server: nothing happened yet
    const impact = lag.m.rewindHit(lag.seat, lag.q, { x: 0, y: 0 }, 12);
    expect(impact).toBeGreaterThan(5);
    expect(hits).toBe(1);
    // The puck now is where it would be had the hit counted on time.
    expect(Math.hypot(lag.m.physics.pos.x - live.m.physics.pos.x, lag.m.physics.pos.y - live.m.physics.pos.y)).toBeLessThan(1.5);
    expect(lag.m.physics.vel.x * live.m.physics.vel.x + lag.m.physics.vel.y * live.m.physics.vel.y).toBeGreaterThan(0);
  });

  it('still catches a very fast puck when the claimed moment is a few steps off', () => {
    for (const off of [-5, -3, 0, 3, 5]) {
      const t = target();
      // Faster than anything in a real game: 38 units/s is about 0.3 per step, a mallet and puck are 1.3 apart.
      const dir = t.dir;
      t.m.physics.vel.x = dir.x * 38;
      t.m.physics.vel.y = dir.y * 38;
      let steps = 0;
      let nearest = Infinity;
      let nearestAt = 0;
      for (; steps < 60; steps++) {
        t.m.step(1 / 120);
        const d = Math.hypot(t.m.physics.pos.x - t.q.x, t.m.physics.pos.y - t.q.y);
        if (d < nearest) {
          nearest = d;
          nearestAt = steps;
        }
        if (d < 0.3) break; // it went straight through the mallet on the server
      }
      for (let i = 0; i < 6; i++) t.m.step(1 / 120);
      const ago = steps + 6 - nearestAt + off; // the claim names a moment `off` steps wrong
      expect(t.m.rewindHit(t.seat, t.q, { x: 0, y: 0 }, ago)).toBeGreaterThan(10);
    }
  });

  it('catches a puck so fast that no recorded step is on the mallet', () => {
    const q = { x: 0, y: 3 };
    const t = target();
    // 400 units/s is 3.3 units per step: the puck jumps clean over a mallet 2.6 wide between two steps.
    t.m.physics.pos.x = -5;
    t.m.physics.pos.y = 3;
    t.m.physics.vel.x = 400;
    t.m.physics.vel.y = 0;
    const xs: number[] = [];
    for (let i = 0; i < 4; i++) {
      t.m.step(1 / 120);
      xs.push(t.m.physics.pos.x);
    }
    // Check the premise: the puck skipped over the mallet without ever being within its reach at a step.
    expect(xs.some((x) => Math.abs(x - q.x) < 1.3)).toBe(false);
    expect(xs[0]).toBeLessThan(-1.3);
    expect(xs[xs.length - 1]).toBeGreaterThan(1.3);
    const hit = t.m.rewindHit(t.seat, q, { x: 0, y: 0 }, 2);
    expect(hit).toBeGreaterThan(10);
  });

  it('does not rewrite more than the compensation limit: a very late hit starts its flight later', () => {
    // The puck crosses open table sideways at 14 u/s; a mallet touches it at q, but the server hears 400 ms later.
    const q = { x: 0, y: 3 };
    const setup = () => {
      const t = target();
      t.m.physics.pos.x = -5;
      t.m.physics.pos.y = 3;
      t.m.physics.vel.x = 14;
      t.m.physics.vel.y = 0;
      return t;
    };
    const probe = setup();
    let touchAt = -1;
    for (let i = 0; i < 100 && touchAt < 0; i++) {
      probe.m.step(1 / 120);
      if (Math.hypot(probe.m.physics.pos.x - q.x, probe.m.physics.pos.y - q.y) < 1.3) touchAt = i;
    }
    expect(touchAt).toBeGreaterThan(0);

    const late = 48; // steps (400 ms) between the touch and the claim reaching the server
    const t = setup();
    for (let i = 0; i < touchAt + late; i++) t.m.step(1 / 120);
    const hit = t.m.rewindHit(t.seat, q, { x: -10, y: 0 }, late);
    expect(hit).toBeGreaterThan(10);
    // Flown from the hit for 150 ms only, not for the whole 400 ms: the puck is bounced back (the mallet moves
    // toward it), so it is a few units from the mallet instead of most of the way across the table.
    const away = Math.hypot(t.m.physics.pos.x - q.x, t.m.physics.pos.y - q.y);
    expect(away).toBeGreaterThan(1.3);
    expect(away).toBeLessThan(7.5);
    // The history stays lined up with the clock, so a later claim is still judged (the puck is moving off the mallet: no hit).
    expect(t.m.rewindHit(t.seat, q, { x: 0, y: 0 }, 1)).toBe(0);
    // ...and one for the puck as the first claimant saw it, a moment earlier, still finds it at the mallet.
    const again = t.m.rewindHit(t.seat, { x: q.x + 0.4, y: q.y }, { x: -10, y: 0 }, 20);
    expect(again).toBeGreaterThanOrEqual(0);
  });

  it('refuses a touch that did not happen, a stale one, or junk', () => {
    const t = target();
    for (let i = 0; i < 20; i++) t.m.step(1 / 120);
    const before = { ...t.m.physics.pos };
    // The mallet is nowhere near the puck.
    expect(t.m.rewindHit(t.seat, { x: t.q.x + 5, y: t.q.y }, { x: 0, y: 0 }, 3)).toBe(0);
    // Further back than the server remembers.
    expect(t.m.rewindHit(t.seat, t.q, { x: 0, y: 0 }, 500)).toBe(0);
    expect(t.m.rewindHit(t.seat, t.q, { x: 0, y: 0 }, -1)).toBe(0);
    // A mallet faster than the physics allows.
    expect(t.m.rewindHit(t.seat, t.q, { x: 400, y: 0 }, 2)).toBe(0);
    expect(t.m.rewindHit(t.seat, t.q, { x: NaN, y: 0 }, 2)).toBe(0);
    expect(t.m.physics.pos.x).toBe(before.x); // nothing moved the puck
  });

  it('forgets the past after a goal, so a claim cannot hit the reset puck', () => {
    const t = target();
    t.m.physics.pos.x = 0;
    t.m.physics.pos.y = 0;
    for (let i = 0; i < 5; i++) t.m.step(1 / 120);
    t.m.clearTrail();
    expect(t.m.rewindHit(t.seat, t.q, { x: 0, y: 0 }, 1)).toBe(0);
  });
});

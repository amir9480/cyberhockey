import { describe, expect, it } from 'vitest';
import { buildLayout, type PlayerCount } from '../src/layout';
import { MatchCore, GOAL_PAUSE, type MatchEvent } from '../src/match';
import { SimMallet } from '../src/mallet';

const DT = 1 / 120;

function aiMatch(players: PlayerCount, winScore: number, scale = 1) {
  const m = new MatchCore(players, scale, winScore);
  for (let s = 0; s < players; s++) m.setAI(s, true);
  return m;
}

/** Runs until done; returns simulated seconds, or Infinity when it hits the limit. */
function runToEnd(m: MatchCore, limit: number) {
  let t = 0;
  while (!m.done && t < limit) {
    m.step(DT);
    t += DT;
  }
  return m.done ? t : Infinity;
}

describe('SimMallet', () => {
  it('ignores NaN and Infinity targets', () => {
    const l = buildLayout(2);
    const m = new SimMallet(l, 0);
    const before = { ...m.target };
    m.moveTo({ x: NaN, y: 1 });
    m.moveTo({ x: 1, y: Infinity });
    expect(m.target).toEqual(before);
  });

  it('stays inside its zone at any scale', () => {
    for (const players of [2, 3, 4] as PlayerCount[]) {
      const l = buildLayout(players);
      for (const scale of [0.6, 1, 1.6]) {
        for (let seat = 0; seat < players; seat++) {
          const m = new SimMallet(l, seat, scale);
          for (const p of [
            { x: 0, y: 0 },
            { x: 100, y: 100 },
            { x: -100, y: 50 },
            { x: 0, y: -100 },
            { x: 3, y: 100 },
          ]) {
            m.moveTo(p);
            for (let i = 0; i < 200; i++) m.update(1 / 120);
            const c = m.clamp(m.pos);
            expect(Math.hypot(c.x - m.pos.x, c.y - m.pos.y)).toBeLessThan(1e-3);
            expect(l.zones[seat].every((pl) => pl.n.x * m.pos.x + pl.n.y * m.pos.y - pl.d - m.radius >= -1e-3)).toBe(true);
          }
        }
      }
    }
  });
});

describe('MatchCore', () => {
  it('only moves human seats via setTarget', () => {
    const m = new MatchCore(2, 1, 10);
    m.setAI(1, true);
    const before = { ...m.mallets[1].target };
    m.setTarget(1, { x: 1, y: -3 });
    expect(m.mallets[1].target).toEqual(before);
    m.setTarget(0, { x: 1, y: 3 });
    expect(m.mallets[0].target).not.toEqual(m.mallets[0].pos);
  });

  it.each([2, 3, 4] as PlayerCount[])('AI-only %iP match finishes', (players) => {
    const m = aiMatch(players, 3);
    expect(runToEnd(m, 1800)).toBeLessThan(Infinity);
    expect(m.winner).toBeGreaterThanOrEqual(0);
  });

  it('serves after the goal pause, in order', () => {
    const m = aiMatch(2, 10);
    const events: MatchEvent[] = [];
    m.onEvent = (e) => events.push(e);
    let goalAt = -1;
    let serveAt = -1;
    let t = 0;
    while (serveAt < 0 && t < 600) {
      m.step(DT);
      t += DT;
      if (goalAt < 0 && events.some((e) => e.t === 'goal')) goalAt = t;
      if (events.some((e) => e.t === 'serve')) serveAt = t;
    }
    expect(goalAt).toBeGreaterThan(0);
    expect(serveAt - goalAt).toBeGreaterThanOrEqual(GOAL_PAUSE - 2 * DT);
    const g = events.findIndex((e) => e.t === 'goal');
    const s = events.findIndex((e) => e.t === 'serve');
    expect(g).toBeLessThan(s);
    const goal = events[g] as Extract<MatchEvent, { t: 'goal' }>;
    expect(goal.sc.reduce((a, b) => a + b, 0)).toBe(1);
    const serve = events[s] as Extract<MatchEvent, { t: 'serve' }>;
    expect(serve.s).toBe(goal.c); // the loser serves
  });

  it('rounds event impacts to 2 decimals', () => {
    const m = aiMatch(2, 10);
    const impacts: number[] = [];
    m.onEvent = (e) => {
      if (e.t === 'hit' || e.t === 'wall') impacts.push(e.i);
    };
    for (let i = 0; i < 120 * 60; i++) m.step(DT);
    expect(impacts.length).toBeGreaterThan(0);
    for (const i of impacts) expect(Math.abs(i * 100 - Math.round(i * 100))).toBeLessThan(1e-3);
  });

  it('400 AI-only 3P games to 2 points all finish within 30 simulated minutes', () => {
    const stalled: number[] = [];
    for (let g = 0; g < 400; g++) {
      const m = aiMatch(3, 2);
      if (runToEnd(m, 30 * 60) === Infinity) stalled.push(g);
    }
    expect(stalled).toEqual([]);
  }, 600000);
});

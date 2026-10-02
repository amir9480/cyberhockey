import type { MatchCore, MatchEvent } from '@airhockey/shared/match';

const f3 = (v: number) => v.toFixed(3);

/** Builds the snapshot JSON by hand: it is sent 60 times a second per room. */
export function buildSnapshot(tick: number, match: MatchCore, countdown: number, events: MatchEvent[]): string {
  const { pos } = match.physics;
  let m = '';
  for (let i = 0; i < match.mallets.length; i++) {
    const p = match.mallets[i].pos;
    m += (i ? ',' : '') + f3(p.x) + ',' + f3(p.y);
  }
  let s = `{"t":"s","n":${tick},"b":[${f3(pos.x)},${f3(pos.y)}],"v":${match.visible ? 1 : 0},"m":[${m}]`;
  if (countdown > 0) s += `,"cd":${countdown.toFixed(2)}`;
  if (events.length) s += `,"e":${JSON.stringify(events)}`;
  return s + '}';
}

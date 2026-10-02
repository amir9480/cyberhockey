import { encodeSnapshot, quantize } from '@airhockey/shared/binary';
import type { SimMallet } from '@airhockey/shared/mallet';

const FULL_EVERY = 60; // snapshots; a full one now and then heals anything a client missed

/** Builds mallet snapshots with only the mallets that moved since the last one. */
export class SnapshotBuilder {
  private last: ({ x: number; y: number } | null)[] = [];
  private count = 0;

  /** Null when nothing changed. */
  build(now: number, mallets: SimMallet[]): Uint8Array | null {
    const full = this.count++ % FULL_EVERY === 0;
    const d: number[] = [];
    mallets.forEach((m, i) => {
      const cur = { x: quantize(m.pos.x), y: quantize(m.pos.y) };
      const prev = this.last[i];
      if (full || !prev || prev.x !== cur.x || prev.y !== cur.y) {
        d.push(i, cur.x, cur.y);
        this.last[i] = cur;
      }
    });
    return d.length ? encodeSnapshot(now, d) : null;
  }
}

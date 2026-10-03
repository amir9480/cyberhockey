import { seatColor } from './colors';
import { ui } from '../ui';

/** Where to put one seat's name: screen px (client coords). */
export interface NameAnchor {
  seat: number;
  x: number;
  y: number;
}

/** Every player's name floating above their mallets during the countdown cinematic; hidden in play. */
export class SeatNames {
  constructor(
    /** The name shown for a seat; asked each time a label comes on. */
    private nameOf: (seat: number) => string,
  ) {}

  /** Place a label at each anchor; seats without one fade out where they were. */
  update(anchors: NameAnchor[]) {
    const labels = ui.seatNames;
    for (const a of anchors) {
      const x = Math.round(a.x);
      const y = Math.round(a.y);
      const l = labels.find((s) => s.seat === a.seat);
      if (!l) {
        labels.push({ seat: a.seat, name: this.nameOf(a.seat), color: `#${seatColor(a.seat).getHexString()}`, x, y, on: true });
        continue;
      }
      if (!l.on) {
        l.name = this.nameOf(a.seat);
        l.color = `#${seatColor(a.seat).getHexString()}`;
        l.on = true;
      }
      if (l.x !== x) l.x = x;
      if (l.y !== y) l.y = y;
    }
    for (const l of labels) if (l.on && !anchors.some((a) => a.seat === l.seat)) l.on = false;
  }

  /** Drop every label at once (a new table: seats may differ). */
  clear() {
    if (ui.seatNames.length) ui.seatNames = [];
  }
}

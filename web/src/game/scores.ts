import * as THREE from 'three';
import type { TableLayout } from '@airhockey/shared/layout';
import { seatColor } from './colors';
import { SevenSegment } from './segment';
import type { WinUniforms } from './effects';

/** One seven-segment score display in front of each goal, upright for the goal's owner. */
export class Scoreboard {
  readonly group = new THREE.Group();
  private displays: SevenSegment[] = [];

  constructor(
    layout: TableLayout,
    private fx: WinUniforms,
  ) {
    const height = layout.creaseRadius * 0.32;
    const dist = layout.creaseRadius * 0.5;
    layout.seats.forEach((seat, i) => {
      const d = new SevenSegment(height, seatColor(i), fx, i);
      d.mesh.position.set(seat.goalCenter.x + seat.inward.x * dist, 0.02, seat.goalCenter.y + seat.inward.y * dist);
      // Digit "up" points into the table, so it reads upright from the owner's side.
      d.mesh.rotation.y = Math.atan2(-seat.inward.x, -seat.inward.y);
      this.group.add(d.mesh);
      this.displays.push(d);
    });
  }

  setScore(seat: number, value: number) {
    this.displays[seat]?.setValue(value);
  }

  /** Per frame: the scorer's display flashes, the others don't. */
  update() {
    const { uWinSeat, uFlash } = this.fx;
    this.displays.forEach((d, i) => d.setFlash(i === uWinSeat.value ? uFlash.value : 0));
  }

  dispose() {
    for (const d of this.displays) d.dispose();
  }
}

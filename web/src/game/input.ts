import type { Vec2 } from '@airhockey/shared/layout';
import type { View } from './view';

/**
 * How the pointer drives the mallet:
 * - `drag` (default): it moves the same way, and as far (times `sensitivity`), as the table surface under the finger /
 *   cursor moved. Both ends of each move are cast onto the table and the mallet's goal shifts by the difference, so it
 *   never jumps to the pointer and a plain tap does nothing. A locked mouse has no screen position, so its moves are
 *   cast at the mallet's own spot on screen; without the lock (e.g. `?debug`), where the cursor is.
 * - `point`: the mallet heads for the table point under the finger / cursor (nearest spot in its zone), touching
 *   included. Needs the cursor's real position: no pointer lock.
 * Mouse: only while `mouseActive` (fullscreen play). Touch: touch events.
 */
export type InputMode = 'drag' | 'point';
export const INPUT_MODES: readonly InputMode[] = ['drag', 'point'];

export class Input {
  /** False while the pause menu is up. */
  enabled = true;
  /** Mouse drives the mallet only in fullscreen play. */
  mouseActive = false;
  mode: InputMode = 'drag';
  /** `drag` mode: multiplies how far the mallet moves for a pointer move (1 = as far as the table under the pointer moved). */
  sensitivity = 1;
  /** Testing aid (`?cursor`): mark on the table where the pointer's ray lands. */
  showAim = false;
  private touchId: number | null = null;
  private last = { x: 0, y: 0 };
  /** Unlocked mouse: the cursor's last position, or null until it moves. */
  private lastMouse: Vec2 | null = null;

  constructor(
    private view: View,
    private canvas: HTMLCanvasElement,
  ) {
    canvas.addEventListener('pointermove', this.mouseMove);
    // Touch uses touch events: the most widely supported route, and preventDefault on
    // touchmove stops the browser from scrolling / pull-to-refresh / zooming instead.
    canvas.addEventListener('touchstart', this.touchStart, { passive: false });
    window.addEventListener('touchmove', this.touchMove, { passive: false });
    window.addEventListener('touchend', this.touchEnd);
    window.addEventListener('touchcancel', this.touchEnd);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /**
   * The pointer moved from screen point `a` to `b`: shift the mallet's goal by how far the table point under it moved,
   * times `sensitivity`. The goal (not the eased position, so fast motion isn't lost to lag) is clamped to the zone
   * each time, so pushing past an edge and coming back has no dead zone.
   */
  private drag(a: Vec2, b: Vec2, mark: boolean) {
    const mallet = this.view.mallet;
    const p = this.view.screenToTable(a.x, a.y);
    const q = this.view.screenToTable(b.x, b.y);
    if (mark && this.showAim) this.view.setAimMarker(q);
    if (!mallet || !p || !q) return;
    const g = mallet.goal;
    const k = this.sensitivity;
    mallet.moveTo({ x: g.x + (q.x - p.x) * k, y: g.y + (q.y - p.y) * k });
  }

  /** `point` mode: the mallet heads for the table point under screen point (x, y); a ray off the table is ignored. */
  private point(x: number, y: number) {
    const p = this.view.screenToTable(x, y);
    if (this.showAim) this.view.setAimMarker(p);
    if (p) this.view.mallet?.moveTo(p);
  }

  private touchStart = (e: TouchEvent) => {
    e.preventDefault();
    // A touch device doesn't want the mouse-style pointer lock.
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.touchId !== null || !this.enabled) return;
    const t = e.changedTouches[0];
    this.touchId = t.identifier;
    this.last = { x: t.clientX, y: t.clientY };
    if (this.mode === 'point') this.point(t.clientX, t.clientY);
  };

  private touchMove = (e: TouchEvent) => {
    if (this.touchId === null) return;
    e.preventDefault();
    if (!this.enabled) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== this.touchId) continue;
      const now = { x: t.clientX, y: t.clientY };
      if (this.mode === 'point') this.point(now.x, now.y);
      else this.drag(this.last, now, true);
      this.last = now;
    }
  };

  private touchEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) if (t.identifier === this.touchId) this.touchId = null;
  };

  private mouseMove = (e: PointerEvent) => {
    const mallet = this.view.mallet;
    if (e.pointerType !== 'mouse' || !mallet || !this.enabled || !this.mouseActive) return;
    if (this.mode === 'point') {
      this.point(e.clientX, e.clientY);
    } else if (document.pointerLockElement === this.canvas) {
      const s = this.view.tableToScreen(mallet.goal, 0);
      this.drag(s, { x: s.x + e.movementX, y: s.y + e.movementY }, false);
    } else {
      const now = { x: e.clientX, y: e.clientY };
      if (this.lastMouse) this.drag(this.lastMouse, now, true);
      this.lastMouse = now;
    }
  };

  /** Drop any held touch (e.g. when pausing). */
  release() {
    this.touchId = null;
    this.lastMouse = null;
    if (this.showAim) this.view.setAimMarker(null);
  }
}

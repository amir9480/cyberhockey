import type { View } from './view';

/**
 * Mouse: while `mouseActive` (fullscreen play), with pointer lock the cursor deltas (scaled by
 * `sensitivity`) drive the mallet; without it the absolute cursor position does.
 * Touch (touch events): dragging anywhere moves the mallet by the finger's movement, so it never jumps
 * under the finger and a plain tap does nothing.
 */
export class Input {
  /** False while the pause menu is up. */
  enabled = true;
  /** Mouse drives the mallet only in fullscreen play. */
  mouseActive = false;
  /** Pointer speed multiplier (mouse and touch). */
  sensitivity = 1;
  private touchId: number | null = null;
  private last = { x: 0, y: 0 };

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

  /** Move the mallet's goal by a screen-space delta, so a pinned pointer can never stop it. */
  private nudge(dx: number, dy: number) {
    const mallet = this.view.mallet;
    if (!mallet) return;
    // Base on the target, not the eased position, so fast motion isn't lost to lag.
    const s = this.view.tableToScreen(mallet.goal, 0);
    const p = this.view.screenToTable(s.x + dx * this.sensitivity, s.y + dy * this.sensitivity);
    if (p) mallet.moveTo(p);
  }

  private touchStart = (e: TouchEvent) => {
    e.preventDefault();
    // A touch device doesn't want the mouse-style pointer lock.
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.touchId !== null || !this.enabled) return;
    const t = e.changedTouches[0];
    this.touchId = t.identifier;
    this.last = { x: t.clientX, y: t.clientY };
  };

  private touchMove = (e: TouchEvent) => {
    if (this.touchId === null) return;
    e.preventDefault();
    if (!this.enabled) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== this.touchId) continue;
      this.nudge(t.clientX - this.last.x, t.clientY - this.last.y);
      this.last = { x: t.clientX, y: t.clientY };
    }
  };

  private touchEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) if (t.identifier === this.touchId) this.touchId = null;
  };

  private mouseMove = (e: PointerEvent) => {
    const mallet = this.view.mallet;
    if (e.pointerType !== 'mouse' || !mallet || !this.enabled || !this.mouseActive) return;
    if (document.pointerLockElement === this.canvas) {
      this.nudge(e.movementX, e.movementY);
    } else {
      // No pointer lock: follow the cursor's absolute position (reaches the whole table).
      const p = this.view.screenToTable(e.clientX, e.clientY);
      if (p) mallet.moveTo(p);
    }
  };

  /** Drop any held touch (e.g. when pausing). */
  release() {
    this.touchId = null;
  }
}

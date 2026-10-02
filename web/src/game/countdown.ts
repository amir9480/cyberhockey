import type { Sound } from './sound';

const GO_MS = 700; // how long GO stays up

/** The big 3, 2, 1, GO before play starts, with a beep for each. */
export class Countdown {
  private shown = '';
  private goTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private el: HTMLElement,
    private sound: Sound,
  ) {}

  /** Seconds left (fed every frame while counting). Reaching 0 from a running count shows GO. */
  set(secs: number) {
    if (secs > 0) this.show(String(Math.ceil(secs)));
    else if (this.shown && this.shown !== 'GO') {
      this.show('GO');
      this.goTimer = setTimeout(() => this.clear(), GO_MS);
    }
  }

  /** Hide at once, without a GO (paused, game over, left). */
  clear() {
    if (this.goTimer) clearTimeout(this.goTimer);
    this.goTimer = null;
    this.shown = '';
    this.el.hidden = true;
  }

  private show(label: string) {
    if (label === this.shown) return;
    if (this.goTimer) clearTimeout(this.goTimer);
    this.goTimer = null;
    this.shown = label;
    this.el.textContent = label;
    this.el.hidden = false;
    if (label === 'GO') this.sound.go();
    else this.sound.count();
  }
}

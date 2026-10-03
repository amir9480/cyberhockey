import type { Sound } from './sound';

const GO_MS = 700; // how long GO stays up
const OUT_MS = 450; // longest exit animation (index.html): a label still there after this is removed anyway

/** The big 3, 2, 1, GO before play starts, with a beep for each. Each label spins and zooms in, the last one out. */
export class Countdown {
  private shown = '';
  /** The label on screen (others may still be animating out). */
  private cur: HTMLElement | null = null;
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
      this.goTimer = setTimeout(() => {
        this.goTimer = null;
        this.shown = '';
        this.swap(null);
      }, GO_MS);
    }
  }

  /** Hide at once, without a GO or exit animation (paused, game over, left). */
  clear() {
    if (this.goTimer) clearTimeout(this.goTimer);
    this.goTimer = null;
    this.shown = '';
    this.cur = null;
    this.el.replaceChildren();
    this.el.hidden = true;
  }

  private show(label: string) {
    if (label === this.shown) return;
    if (this.goTimer) clearTimeout(this.goTimer);
    this.goTimer = null;
    this.shown = label;
    this.el.hidden = false;
    this.swap(label);
    if (label === 'GO') this.sound.go();
    else this.sound.count();
  }

  /** Send the current label out and bring `label` in (none: just the exit). */
  private swap(label: string | null) {
    const old = this.cur;
    if (old) {
      old.classList.replace('in', 'out');
      const drop = () => old.remove();
      old.addEventListener('animationend', drop, { once: true });
      setTimeout(drop, OUT_MS);
    }
    this.cur = null;
    if (label === null) return;
    const span = document.createElement('span');
    span.textContent = label;
    span.className = label === 'GO' ? 'go in' : 'in';
    this.el.append(span);
    this.cur = span;
  }
}

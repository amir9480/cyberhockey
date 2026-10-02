import { clampToSeat, malletHome, type TableLayout, type Vec2 } from './layout';
import { MAX_MALLET_SPEED } from './physics';

/** Radius at scale 1. */
export const MALLET_RADIUS = 0.75;
export const MALLET_WALL = 0.4 + 0.1; // wall thickness + small gap
const FOLLOW = 45; // 1/s, how tightly the mallet chases its target

/** A seat's mallet without any rendering: position, easing toward a target and the zone clamp. */
export class SimMallet {
  readonly pos: Vec2 = { x: 0, y: 0 };
  /** Position at the start of the last update; with `pos` gives the mallet's motion. */
  readonly prev: Vec2 = { x: 0, y: 0 };
  /** Current radius, after the room's size setting. */
  radius: number;
  /** Where the mallet is heading (its eased position catches up to this). */
  target: Vec2 = { x: 0, y: 0 };

  constructor(
    private layout: TableLayout,
    readonly seat: number,
    scale = 1,
  ) {
    this.radius = MALLET_RADIUS * scale;
    const home = this.clamp(malletHome(layout, seat));
    this.pos.x = this.prev.x = this.target.x = home.x;
    this.pos.y = this.prev.y = this.target.y = home.y;
  }

  /** Alias of `target`, kept for callers that read the goal. */
  get goal(): Vec2 {
    return this.target;
  }

  clamp(p: Vec2): Vec2 {
    return clampToSeat(this.layout, this.seat, p, this.radius, MALLET_WALL);
  }

  /** Resize the mallet; keeps it inside its zone. */
  setScale(scale: number) {
    this.radius = MALLET_RADIUS * scale;
    const p = this.clamp(this.pos);
    this.pos.x = this.prev.x = p.x;
    this.pos.y = this.prev.y = p.y;
    this.target = this.clamp(this.target);
  }

  /** Where the mallet should be; it eases toward it. Non-finite input is ignored. */
  moveTo(p: Vec2) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    this.target = this.clamp(p);
  }

  /** Put the mallet somewhere without easing or motion (it didn't move there, it is there). */
  place(x: number, y: number) {
    this.pos.x = this.prev.x = this.target.x = x;
    this.pos.y = this.prev.y = this.target.y = y;
  }

  /** Move the mallet to (x, y) over one step: it hits the puck with that motion (a networked player's mallet). */
  drive(x: number, y: number) {
    this.prev.x = this.pos.x;
    this.prev.y = this.pos.y;
    this.pos.x = this.target.x = x;
    this.pos.y = this.target.y = y;
  }

  update(dt: number) {
    this.prev.x = this.pos.x;
    this.prev.y = this.pos.y;
    const k = 1 - Math.exp(-FOLLOW * dt);
    let dx = (this.target.x - this.pos.x) * k;
    let dy = (this.target.y - this.pos.y) * k;
    // Never faster than the physics counts a mallet's speed: a mallet can't jump over the puck in one step.
    const d = Math.hypot(dx, dy);
    const max = MAX_MALLET_SPEED * dt;
    if (d > max) {
      dx *= max / d;
      dy *= max / d;
    }
    this.pos.x += dx;
    this.pos.y += dy;
  }
}

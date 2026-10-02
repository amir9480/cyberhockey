import type { TableLayout, Vec2 } from './layout';

/** Puck radius, shared with rendering. */
export const PUCK_RADIUS = 0.55;

const WALL_THICKNESS = 0.4;
const SUBSTEP = 1 / 240;
/** Free flight (no mallets) is always stepped in these exact steps, so the server and every client get identical paths. */
export const FLIGHT_STEP = SUBSTEP;
export const FLIGHT_STEPS_PER_MS = 0.24;
export const FLIGHT_MS_PER_STEP = 1000 / 240;
const WALL_BOUNCE = 0.95;
export const MALLET_BOUNCE = 0.92;
const DAMPING = 0.25; // 1/s, air hockey tables are nearly frictionless
export const MAX_SPEED = 38;
export const MAX_MALLET_SPEED = 55; // ignore absurd flicks when transferring momentum

export interface MalletBody {
  seat: number;
  radius: number;
  /** Position at the start and end of this frame. */
  prev: Vec2;
  cur: Vec2;
}

export interface PhysicsEvents {
  /** `impact` is the closing speed along the contact normal. */
  onHit(seat: number, impact: number): void;
  onWall(impact: number): void;
  onGoal(seat: number): void;
}

/**
 * Continuous collision test. A point moves in a straight line from offset (r0x, r0y) to (r1x, r1y) relative to the
 * centre of a circle of radius `R` (use relative positions when both move: the puck's minus the mallet's). Returns
 * the first moment `s` in [0, 1] it is within `R` of the centre (0 if it starts inside), or null if it never is.
 * Solves |r0 + s (r1 - r0)| = R, so a fast puck can't step over a mallet between two positions.
 */
export function sweepEntry(r0x: number, r0y: number, r1x: number, r1y: number, R: number): number | null {
  if (r0x * r0x + r0y * r0y <= R * R) return 0;
  const dx = r1x - r0x;
  const dy = r1y - r0y;
  const a = dx * dx + dy * dy;
  if (a < 1e-12) return null;
  const b = 2 * (r0x * dx + r0y * dy);
  const c = r0x * r0x + r0y * r0y - R * R;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const s = (-b - Math.sqrt(disc)) / (2 * a);
  return s >= 0 && s <= 1 ? s : null;
}

/**
 * A puck touching a mallet at (mx, my) moving at (mvx, mvy): puts the puck on the mallet's rim and bounces it.
 * Returns the closing speed (> 0) when it was a hit, 0 when the puck was already moving away.
 * The server uses this same function to decide a claimed hit, so both ends get the same result.
 */
export function bounceOff(pos: Vec2, vel: Vec2, mx: number, my: number, mvx: number, mvy: number, min: number): number {
  const dx = pos.x - mx;
  const dy = pos.y - my;
  const d = Math.hypot(dx, dy);
  // Exactly overlapping: push up the table.
  const nx = d > 1e-6 ? dx / d : 0;
  const ny = d > 1e-6 ? dy / d : -1;
  pos.x = mx + nx * min;
  pos.y = my + ny * min;
  const vn = (vel.x - mvx) * nx + (vel.y - mvy) * ny;
  if (vn >= 0) return 0;
  vel.x -= (1 + MALLET_BOUNCE) * vn * nx;
  vel.y -= (1 + MALLET_BOUNCE) * vn * ny;
  const sp = Math.hypot(vel.x, vel.y);
  if (sp > MAX_SPEED) {
    vel.x *= MAX_SPEED / sp;
    vel.y *= MAX_SPEED / sp;
  }
  return -vn;
}

const dot = (ax: number, ay: number, bx: number, by: number) => ax * bx + ay * by;

/** 2D air hockey puck: walls, rounded corners, open goals and moving mallets. Pure, no Three.js. */
export class Physics {
  readonly pos: Vec2 = { x: 0, y: 0 };
  readonly vel: Vec2 = { x: 0, y: 0 };
  private puckR = PUCK_RADIUS;
  /** Puck centre stays within the inset polygon grown by this. */
  private reach: number;

  constructor(
    private layout: TableLayout,
    private events: PhysicsEvents,
  ) {
    this.reach = this.computeReach();
  }

  /** Current puck radius (the room can scale it). */
  get radius() {
    return this.puckR;
  }

  setPuckRadius(r: number) {
    this.puckR = r;
    this.reach = this.computeReach();
  }

  private computeReach() {
    return Math.max(0, this.layout.cornerRadius - WALL_THICKNESS - this.puckR);
  }

  reset(p: Vec2) {
    this.pos.x = p.x;
    this.pos.y = p.y;
    this.vel.x = 0;
    this.vel.y = 0;
  }

  /** Advance by `dt`; returns false once a goal is scored (the step stops there). */
  step(dt: number, mallets: MalletBody[]): boolean {
    const n = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / n;
    const damp = Math.exp(-DAMPING * h);
    for (let i = 1; i <= n; i++) {
      this.pos.x += this.vel.x * h;
      this.pos.y += this.vel.y * h;
      this.vel.x *= damp;
      this.vel.y *= damp;

      const f = i / n;
      for (const m of mallets) this.collideMallet(m, f, dt);
      this.collideWalls();

      const scored = this.goalAt();
      if (scored !== -1) {
        this.events.onGoal(scored);
        return false;
      }
    }
    return true;
  }

  private collideMallet(m: MalletBody, f: number, dt: number) {
    const mx = m.prev.x + (m.cur.x - m.prev.x) * f;
    const my = m.prev.y + (m.cur.y - m.prev.y) * f;
    let mvx = (m.cur.x - m.prev.x) / dt;
    let mvy = (m.cur.y - m.prev.y) / dt;
    const ms = Math.hypot(mvx, mvy);
    if (ms > MAX_MALLET_SPEED) {
      mvx *= MAX_MALLET_SPEED / ms;
      mvy *= MAX_MALLET_SPEED / ms;
    }

    const dx = this.pos.x - mx;
    const dy = this.pos.y - my;
    const min = m.radius + this.puckR;
    if (dx * dx + dy * dy >= min * min) return;
    const impact = bounceOff(this.pos, this.vel, mx, my, mvx, mvy, min);
    if (impact > 0) this.events.onHit(m.seat, impact);
  }

  private collideWalls() {
    const { inset, seats, goalWidth } = this.layout;
    const n = inset.length;
    const px = this.pos.x;
    const py = this.pos.y;

    // Closest point on the inset polygon's boundary; zero distance if inside.
    let inside = true;
    let best = Infinity;
    let cx = 0;
    let cy = 0;
    let edge = 0;
    for (let i = 0; i < n; i++) {
      const a = inset[i];
      const b = inset[(i + 1) % n];
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const len2 = ex * ex + ey * ey;
      const t = Math.max(0, Math.min(1, dot(px - a.x, py - a.y, ex, ey) / len2));
      const qx = a.x + ex * t;
      const qy = a.y + ey * t;
      const d2 = (px - qx) ** 2 + (py - qy) ** 2;
      if (d2 < best) {
        best = d2;
        cx = qx;
        cy = qy;
        edge = i;
      }
      // Outside this edge? (polygon is convex; the interior is on the seat-inward side)
      if (this.signedSide(i, px, py) < 0) inside = false;
    }
    if (inside) return;

    const d = Math.sqrt(best);
    if (d <= this.reach) return;

    // Goal mouths are open: no wall there.
    for (const st of seats) {
      if (st.edge !== edge) continue;
      const lateral = dot(px - st.goalCenter.x, py - st.goalCenter.y, st.tangent.x, st.tangent.y);
      if (Math.abs(lateral) < goalWidth / 2) return;
    }

    const nx = (px - cx) / d;
    const ny = (py - cy) / d;
    this.pos.x = cx + nx * this.reach;
    this.pos.y = cy + ny * this.reach;
    const vn = dot(this.vel.x, this.vel.y, nx, ny);
    if (vn > 0) {
      this.vel.x -= (1 + WALL_BOUNCE) * vn * nx;
      this.vel.y -= (1 + WALL_BOUNCE) * vn * ny;
      this.events.onWall(vn);
    }
  }

  /** Signed distance of (x, y) from edge `i` of the inset polygon, positive toward the table centre. */
  private signedSide(i: number, x: number, y: number): number {
    const { inset } = this.layout;
    const a = inset[i];
    const b = inset[(i + 1) % inset.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    let nx = -ey / len;
    let ny = ex / len;
    if (dot(nx, ny, -a.x, -a.y) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return dot(nx, ny, x - a.x, y - a.y);
  }

  /** Seat whose goal the puck has entered, or -1. */
  private goalAt(): number {
    for (const st of this.layout.seats) {
      const rx = this.pos.x - st.goalCenter.x;
      const ry = this.pos.y - st.goalCenter.y;
      const depth = dot(rx, ry, st.inward.x, st.inward.y);
      const lateral = dot(rx, ry, st.tangent.x, st.tangent.y);
      if (depth < 0 && Math.abs(lateral) < this.layout.goalWidth / 2 + 0.3) return st.index;
    }
    return -1;
  }
}

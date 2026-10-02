import type { TableLayout, Vec2 } from './layout';
import type { Mallet } from './mallet';

export const DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

interface Params {
  /** Mallet speed while defending / lining up a shot (units/s). */
  speed: number;
  /** Mallet speed during the shot itself. */
  strike: number;
  /** Max aim error in radians. */
  aimError: number;
  /** Seconds between looks at the puck; the AI plays on stale info in between. */
  reaction: number;
  /** 0..1: how much it leads a moving puck. */
  predict: number;
  /** Only attacks a puck slower than this (units/s). */
  attackSpeed: number;
  /** Picks the best shot (open angle, bank shots) instead of just aiming at the goal. */
  smart: boolean;
}

const PARAMS: Record<Difficulty, Params> = {
  easy: { speed: 7, strike: 8, aimError: 0.4, reaction: 0.35, predict: 0, attackSpeed: 7, smart: false },
  medium: { speed: 11, strike: 13, aimError: 0.2, reaction: 0.18, predict: 0.3, attackSpeed: 13, smart: false },
  hard: { speed: 16, strike: 19, aimError: 0.08, reaction: 0.08, predict: 0.7, attackSpeed: 22, smart: false },
  expert: { speed: 22, strike: 26, aimError: 0.02, reaction: 0.03, predict: 1, attackSpeed: 40, smart: true },
};

const LEAD_TIME = 0.3; // seconds of puck motion a full-prediction AI looks ahead
const STRIKE_TIME = 0.3;

export interface PuckState {
  pos: Vec2;
  vel: Vec2;
  radius: number;
}

type Phase = 'defend' | 'approach' | 'strike';

/** Drives one rival mallet: defends its goal, and shoots at an opponent when the puck is in its zone. */
export class AiPlayer {
  private params = PARAMS.medium;
  private targets: number[] = [];
  private virt: Vec2; // where the mallet is heading; the mallet eases to it
  private seen = { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } };
  private sense = 0;
  private phase: Phase = 'defend';
  private aimPoint: Vec2 = { x: 0, y: 0 };
  private aimErr = 0;
  private aimSeat = 0;
  private strikeTarget: Vec2 = { x: 0, y: 0 };
  private strikeLeft = 0;
  private retreatLeft = 0;

  constructor(
    private layout: TableLayout,
    private mallet: Mallet,
    difficulty: Difficulty,
    /** Every mallet on the table, to read where the defenders stand. */
    private all: Mallet[] = [],
  ) {
    this.virt = { ...mallet.pos };
    this.setDifficulty(difficulty);
  }

  setDifficulty(d: Difficulty) {
    this.params = PARAMS[d];
    const seat = this.mallet.seat;
    const others = this.layout.seats.map((s) => s.index).filter((i) => i !== seat);
    // Expert: everyone goes after the human (seat 0). Otherwise rivals also shoot at each other.
    this.targets = d === 'expert' ? [0] : others;
  }

  /** Back off to the goal for a moment (used to free a puck pinned against a wall). */
  retreat(seconds: number) {
    this.retreatLeft = seconds;
    this.phase = 'defend';
  }

  update(dt: number, puck: PuckState) {
    const p = this.params;
    if (this.retreatLeft > 0) {
      this.retreatLeft -= dt;
      this.moveTo(this.defendSpot({ x: 0, y: 0 }), p.speed, dt);
      return;
    }
    this.sense -= dt;
    if (this.sense <= 0) {
      this.seen.pos = { ...puck.pos };
      this.seen.vel = { ...puck.vel };
      this.sense = p.reaction;
    }
    const pp = this.seen.pos;
    const pv = this.seen.vel;
    const speed = Math.hypot(pv.x, pv.y);

    if (this.phase === 'strike') {
      this.strikeLeft -= dt;
      this.moveTo(this.strikeTarget, p.strike, dt);
      if (this.strikeLeft <= 0) this.phase = 'defend';
      return;
    }

    if (this.inZone(pp) && speed < p.attackSpeed) {
      if (this.phase === 'defend') this.pickAim();
      this.phase = 'approach';
      const dir = this.aimDir(pp, puck.radius);
      const gap = this.mallet.radius + puck.radius;
      const behind = { x: pp.x - dir.x * (gap + 0.15), y: pp.y - dir.y * (gap + 0.15) };
      if (Math.hypot(this.virt.x - behind.x, this.virt.y - behind.y) < 0.45) {
        this.strikeTarget = { x: pp.x + dir.x * (gap + 1.4), y: pp.y + dir.y * (gap + 1.4) };
        this.strikeLeft = STRIKE_TIME;
        this.phase = 'strike';
      } else {
        this.moveTo(behind, p.speed, dt);
      }
      return;
    }

    this.phase = 'defend';
    const lead = LEAD_TIME * p.predict;
    this.moveTo(this.defendSpot({ x: pp.x + pv.x * lead, y: pp.y + pv.y * lead }), p.speed, dt);
  }

  /** On the line from the goal to the puck, at the mallet's home distance. */
  private defendSpot(puck: Vec2): Vec2 {
    const st = this.layout.seats[this.mallet.seat];
    const d = this.layout.creaseRadius * 0.8;
    const rx = puck.x - st.goalCenter.x;
    const ry = puck.y - st.goalCenter.y;
    const depth = Math.max(rx * st.inward.x + ry * st.inward.y, 0.5);
    const lateral = rx * st.tangent.x + ry * st.tangent.y;
    const half = this.layout.goalWidth / 2;
    const l = Math.max(-half, Math.min(half, (lateral * d) / depth));
    return {
      x: st.goalCenter.x + st.inward.x * d + st.tangent.x * l,
      y: st.goalCenter.y + st.inward.y * d + st.tangent.y * l,
    };
  }

  private inZone(p: Vec2): boolean {
    return this.layout.zones[this.mallet.seat].every((pl) => pl.n.x * p.x + pl.n.y * p.y > 0.4);
  }

  private pickAim() {
    const seat = this.targets[Math.floor(Math.random() * this.targets.length)] ?? 0;
    this.aimSeat = seat;
    const st = this.layout.seats[seat];
    const spread = this.layout.goalWidth * 0.3;
    const off = (Math.random() * 2 - 1) * spread;
    this.aimPoint = { x: st.goalCenter.x + st.tangent.x * off, y: st.goalCenter.y + st.tangent.y * off };
    this.aimErr = (Math.random() * 2 - 1) * this.params.aimError;
  }

  /**
   * Best shot from `from`: tries a spread of points across the target goal, directly and as one-bounce
   * bank shots, and keeps the one that keeps farthest from the defender, that the mallet can actually
   * line up behind (not blocked by a wall or corner), preferring direct shots.
   */
  private bestShot(from: Vec2, radius: number): Vec2 | null {
    const L = this.layout;
    const st = L.seats[this.aimSeat];
    if (!st) return null;
    const defender = this.all.find((m) => m.seat === this.aimSeat);
    const gap = this.mallet.radius + radius + 0.15;
    const half = L.goalWidth / 2;
    const reach = Math.max(0, L.cornerRadius - 0.4 - radius);
    let best: Vec2 | null = null;
    let bestScore = -Infinity;

    // Distance from point c to segment a-b.
    const segDist = (a: Vec2, b: Vec2, c: Vec2) => {
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((c.x - a.x) * ex + (c.y - a.y) * ey) / (ex * ex + ey * ey || 1)));
      return Math.hypot(a.x + ex * t - c.x, a.y + ey * t - c.y);
    };
    const consider = (dirTarget: Vec2, legs: [Vec2, Vec2][], penalty: number) => {
      const dx = dirTarget.x - from.x;
      const dy = dirTarget.y - from.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-3) return;
      const behind = { x: from.x - (dx / len) * gap, y: from.y - (dy / len) * gap };
      const c = this.mallet.clamp(behind);
      if (Math.hypot(c.x - behind.x, c.y - behind.y) > 0.25) return; // can't get behind the puck for this angle
      let clear = 6;
      if (defender) for (const [a, b] of legs) clear = Math.min(clear, segDist(a, b, defender.pos) - defender.radius);
      const score = Math.min(clear, 4) - penalty;
      if (score > bestScore) {
        bestScore = score;
        best = dirTarget;
      }
    };

    const samples = [-0.8, -0.4, 0, 0.4, 0.8];
    for (const k of samples) {
      const A = { x: st.goalCenter.x + st.tangent.x * half * k, y: st.goalCenter.y + st.tangent.y * half * k };
      consider(A, [[from, A]], Math.abs(k) * 0.3);

      // One bounce off each wall edge: aim at the goal point mirrored across that wall.
      const n = L.inset.length;
      for (let i = 0; i < n; i++) {
        if (L.seats.some((s) => s.edge === i)) continue; // goal edges are open
        const e0 = L.inset[i];
        const e1 = L.inset[(i + 1) % n];
        const ex = e1.x - e0.x;
        const ey = e1.y - e0.y;
        const el = Math.hypot(ex, ey);
        let ox = ey / el;
        let oy = -ex / el;
        if (ox * e0.x + oy * e0.y < 0) {
          ox = -ox;
          oy = -oy;
        }
        const q = { x: e0.x + ox * reach, y: e0.y + oy * reach };
        const dA = (A.x - q.x) * ox + (A.y - q.y) * oy;
        const dF = (from.x - q.x) * ox + (from.y - q.y) * oy;
        if (dA >= 0 || dF >= 0) continue; // both ends must be on the table side
        const M = { x: A.x - 2 * dA * ox, y: A.y - 2 * dA * oy };
        // Where the path to the mirror image crosses the wall line.
        const t = dF / (dF - (dA < 0 ? (M.x - q.x) * ox + (M.y - q.y) * oy : 0));
        const hit = { x: from.x + (M.x - from.x) * t, y: from.y + (M.y - from.y) * t };
        const along = ((hit.x - e0.x) * ex + (hit.y - e0.y) * ey) / (el * el);
        if (along < 0.05 || along > 0.95) continue; // misses the straight part of the wall
        consider(M, [[from, hit], [hit, A]], 1.5 + Math.abs(k) * 0.3);
      }
    }
    return best;
  }

  private aimDir(from: Vec2, radius: number): Vec2 {
    const target = (this.params.smart && this.bestShot(from, radius)) || this.aimPoint;
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const l = Math.hypot(dx, dy) || 1;
    const c = Math.cos(this.aimErr);
    const s = Math.sin(this.aimErr);
    return { x: (dx * c - dy * s) / l, y: (dx * s + dy * c) / l };
  }

  private moveTo(target: Vec2, speed: number, dt: number) {
    const dx = target.x - this.virt.x;
    const dy = target.y - this.virt.y;
    const len = Math.hypot(dx, dy);
    const step = speed * dt;
    if (len <= step) {
      this.virt = { ...target };
    } else {
      this.virt.x += (dx / len) * step;
      this.virt.y += (dy / len) * step;
    }
    this.virt = this.mallet.clamp(this.virt);
    this.mallet.moveTo(this.virt);
  }
}

import { AiPlayer, type Difficulty } from './ai';
import { buildLayout, serveSpot, type PlayerCount, type TableLayout, type Vec2 } from './layout';
import { SimMallet } from './mallet';
import { bounceOff, MAX_MALLET_SPEED, Physics, PUCK_RADIUS, sweepEntry, type MalletBody } from './physics';

const REWIND_WINDOW = 6; // steps either side of the claimed moment (about 50 ms)
const TRAIL_STEPS = 120; // 1 s at 120 steps a second
/**
 * A hit is judged against the puck as its player saw it, but the new path never starts more than this many steps
 * (150 ms) before now. A player on a bad connection sees the puck up to half a second late; rewriting all of that
 * would drop the puck on the other player already near their goal, with no time to see it coming.
 */
const MAX_COMPENSATION = 18
const STUCK_SPEED = 1.5; // puck slower than this while touching a mallet counts as stuck
const STUCK_TIME = 1.2; // seconds stuck before we step in
const RETREAT_TIME = 0.8; // how long a rival backs off
const NUDGE_SPEED = 4; // gentle shove
const IDLE_SPEED = 0.5; // puck slower than this with nobody near it counts as idle
const IDLE_TIME = 2; // seconds idle before it gets nudged
/** The goal effect plays out for this long before the next serve. */
export const GOAL_PAUSE = 1.0;

export type MatchEvent =
  | { t: 'hit'; s: number; i: number }
  | { t: 'wall'; i: number }
  | { t: 'goal'; s: number; c: number; sc: number[] }
  | { t: 'serve'; s: number };

/** Who gets the point when `conceded` lets the puck in: the latest other hitter (or the opponent in 2P). */
export function scorerFor(hitters: number[], conceded: number, seats: number): number | undefined {
  const s = [...hitters].reverse().find((h) => h !== conceded);
  if (s === undefined && seats === 2) return 1 - conceded;
  return s;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Game rules without rendering or sound: physics, rounds, scoring, AI seats. Emits events. */
export class MatchCore {
  readonly layout: TableLayout;
  readonly mallets: SimMallet[];
  readonly scores: number[];
  readonly physics: Physics;
  /** Seat that serves the current round. */
  starter: number;
  /** Seat that reached the winning score, or -1 while the game is on. */
  winner = -1;
  /** True once the winning goal's effect has played out. */
  done = false;
  /** False between a goal and the next serve. */
  visible = true;
  onEvent: ((e: MatchEvent) => void) | null = null;
  /**
   * Online: the server owns the rules (goals, serves, scores, idle nudges). This copy only flies the puck,
   * collides it with the mallets in `setCollide`, runs the AIs it was given, and applies what the server says.
   */
  net = false;
  /** Online: the puck stands still (countdown, pause). */
  hold = false;
  /** Online: the puck is in a goal here and waits for the server to confirm it. */
  onLocalGoal: ((seat: number) => void) | null = null;
  private waitGoal = false;
  private active: MalletBody[] | null = null;

  private ais = new Map<number, AiPlayer>();
  private bodies: MalletBody[];
  /** Recent distinct hitters, oldest first. */
  private hitters: number[] = [];
  private loser = -1;
  private pause = 0;
  private stuckFor = 0;
  private idleFor = 0;
  private difficulty: Difficulty = 'medium';

  constructor(
    players: PlayerCount,
    private scale: number,
    private winScore: number,
  ) {
    this.layout = buildLayout(players);
    this.scores = this.layout.seats.map(() => 0);
    this.mallets = this.layout.seats.map((s) => new SimMallet(this.layout, s.index, scale));
    this.bodies = this.mallets.map((m) => ({
      seat: m.seat,
      // Read live: the room can resize mallets mid-game.
      get radius() {
        return m.radius;
      },
      prev: m.prev,
      cur: m.pos,
    }));
    this.physics = new Physics(this.layout, {
      onHit: (seat, impact) => {
        if (this.hitters[this.hitters.length - 1] !== seat) this.hitters.push(seat);
        if (this.hitters.length > 8) this.hitters.shift();
        this.emit({ t: 'hit', s: seat, i: round2(impact) });
      },
      onWall: (impact) => {
        if (impact > 1.5) this.emit({ t: 'wall', i: round2(impact) });
      },
      onGoal: (seat) => (this.net ? this.netGoal(seat) : this.goal(seat)),
    });
    this.physics.setPuckRadius(PUCK_RADIUS * scale);
    this.starter = Math.floor(Math.random() * this.layout.seats.length);
    this.physics.reset(serveSpot(this.layout, this.starter, scale));
  }

  private emit(e: MatchEvent) {
    this.onEvent?.(e);
  }

  /** Room size rule: the puck scales with the mallets. */
  setScale(scale: number) {
    this.scale = scale;
    this.physics.setPuckRadius(PUCK_RADIUS * scale);
    for (const m of this.mallets) m.setScale(scale);
  }

  setWinScore(n: number) {
    this.winScore = n;
  }

  isAI(seat: number) {
    return this.ais.has(seat);
  }

  /** Give a seat to an AI (`on`) or back to a human. */
  setAI(seat: number, on: boolean, difficulty: Difficulty = this.difficulty) {
    const m = this.mallets[seat];
    if (!m) return;
    if (!on) {
      this.ais.delete(seat);
      return;
    }
    if (!this.ais.has(seat)) this.ais.set(seat, new AiPlayer(this.layout, m, difficulty, this.mallets));
  }

  setDifficulty(d: Difficulty) {
    this.difficulty = d;
    for (const ai of this.ais.values()) ai.setDifficulty(d);
  }

  /** Where a human seat's mallet should head. AI seats ignore this. */
  setTarget(seat: number, p: Vec2) {
    if (this.ais.has(seat)) return;
    this.mallets[seat]?.moveTo(p);
  }

  /** Mallets ease toward their targets without any game happening (countdowns). */
  moveMallets(dt: number) {
    for (const m of this.mallets) m.update(dt);
  }

  /** Online: only these seats' mallets hit the puck here (null: all). Others hit it where their owner runs. */
  setCollide(seats: number[] | null) {
    this.active = seats ? this.bodies.filter((b) => seats.includes(b.seat)) : null;
  }

  private get collidable() {
    return this.active ?? this.bodies;
  }

  step(dt: number) {
    if (this.net) {
      for (const ai of this.ais.values()) ai.update(dt, this.physics);
      this.moveMallets(dt);
      if (!this.hold && !this.waitGoal && this.visible) {
        this.physics.step(dt, this.collidable);
        this.freeStuckPuck(dt);
      }
      return;
    }
    if (this.pause > 0) {
      this.moveMallets(dt);
      this.pause -= dt;
      if (this.pause <= 0) {
        if (this.winner >= 0) this.done = true;
        else this.nextRound();
      }
      return;
    }
    if (this.done) return;
    for (const ai of this.ais.values()) ai.update(dt, this.physics);
    this.moveMallets(dt);
    this.physics.step(dt, this.collidable);
    if (this.pause <= 0) {
      this.freeStuckPuck(dt);
      this.record(dt);
    }
  }

  // --- lag compensation ------------------------------------------------------------

  /** The puck at the end of each of the last steps, oldest first (a hit is judged against the past). */
  private trail: { x: number; y: number; vx: number; vy: number }[] = [];
  private trailDt = 0;

  private record(dt: number) {
    this.trailDt = dt;
    const { pos, vel } = this.physics;
    this.trail.push({ x: pos.x, y: pos.y, vx: vel.x, vy: vel.y });
    if (this.trail.length > TRAIL_STEPS) this.trail.shift();
  }

  /** Forget the past (the puck was reset or the game was held). */
  clearTrail() {
    this.trail.length = 0;
  }

  /**
   * A player's mallet touched the puck `stepsAgo` steps ago, as that player saw it. Rewinds the puck to then,
   * checks the mallet really touches it, bounces it off the mallet, and replays the steps since (walls and goals).
   * Returns the closing speed, or 0 if it was a miss. The puck's state is left as it is now, after the hit.
   */
  rewindHit(seat: number, q: Vec2, w: Vec2, stepsAgo: number): number {
    const mallet = this.mallets[seat];
    const n = this.trail.length;
    if (!mallet || this.net || this.done || this.pause > 0 || !this.visible || stepsAgo < 0 || stepsAgo >= n) return 0;
    const wSpeed = Math.hypot(w.x, w.y);
    if (!Number.isFinite(wSpeed) || wSpeed > MAX_MALLET_SPEED * 1.01) return 0;
    const min = mallet.radius + this.physics.radius;
    // The claimed moment is only as exact as the clocks, so look a few steps either side. The touch is the first
    // moment the puck reaches the mallet, found on the path between two recorded steps (a fast puck covers more than
    // a mallet is wide in one step, so no recorded step need be on the mallet at all).
    const mid = n - 1 - stepsAgo;
    let i = -1;
    let was = this.trail[0];
    for (let k = Math.max(0, mid - REWIND_WINDOW); k <= Math.min(n - 1, mid + REWIND_WINDOW) && i < 0; k++) {
      const b = this.trail[k];
      const a = k > 0 ? this.trail[k - 1] : b;
      const t = sweepEntry(a.x - q.x, a.y - q.y, b.x - q.x, b.y - q.y, min);
      if (t !== null) {
        i = k;
        was = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, vx: b.vx, vy: b.vy };
      }
    }
    if (i < 0) {
      // Never on the path: a near miss still counts (the player saw them touch on a puck a moment off the server's);
      // judge it at the closest recorded step.
      let best = Infinity;
      for (let k = Math.max(0, mid - REWIND_WINDOW); k <= Math.min(n - 1, mid + REWIND_WINDOW); k++) {
        const d = Math.hypot(this.trail[k].x - q.x, this.trail[k].y - q.y);
        if (d < best) {
          best = d;
          i = k;
        }
      }
      if (i < 0 || best > min + 0.8 + 0.04 * wSpeed) return 0;
      was = this.trail[i];
    }
    const { pos, vel } = this.physics;
    const keep = { x: pos.x, y: pos.y, vx: vel.x, vy: vel.y };
    pos.x = was.x;
    pos.y = was.y;
    vel.x = was.vx;
    vel.y = was.vy;
    const impact = bounceOff(pos, vel, q.x, q.y, w.x, w.y, min);
    if (impact <= 0) {
      pos.x = keep.x;
      pos.y = keep.y;
      vel.x = keep.vx;
      vel.y = keep.vy;
      return 0;
    }
    this.trail[i] = { x: pos.x, y: pos.y, vx: vel.x, vy: vel.y };
    // The steps since: the puck flies on from the hit (a goal on the way is a goal), but for no more than the
    // compensation limit. A hit older than that starts its flight later than it really did: the puck waits at the
    // hit point for the difference, which gives the other player the time back. The history stays lined up with the
    // clock either way, so later claims can still be judged.
    const late = n - 1 - i;
    const hold = Math.max(0, late - MAX_COMPENSATION);
    const start = { x: pos.x, y: pos.y, vx: vel.x, vy: vel.y };
    for (let j = 1; j <= hold; j++) this.trail[i + j] = start;
    for (let j = 1; j <= late - hold; j++) {
      if (!this.physics.step(this.trailDt, [])) return this.afterHit(seat, impact);
      this.trail[i + hold + j] = { x: pos.x, y: pos.y, vx: vel.x, vy: vel.y };
    }
    return this.afterHit(seat, impact);
  }

  private afterHit(seat: number, impact: number) {
    if (this.hitters[this.hitters.length - 1] !== seat) this.hitters.push(seat);
    if (this.hitters.length > 8) this.hitters.shift();
    this.emit({ t: 'hit', s: seat, i: round2(impact) });
    return impact;
  }

  private touching() {
    const { pos, radius } = this.physics;
    return this.collidable.filter((b) => Math.hypot(pos.x - b.cur.x, pos.y - b.cur.y) < b.radius + radius + 0.25);
  }

  /**
   * A puck pinned between a mallet and a wall corner can sit there forever. If it hardly moves
   * while an AI mallet touches it, those AIs back off and it gets a small nudge toward the centre.
   * A puck lying idle where nobody is near it (e.g. on a zone boundary no AI attacks) is nudged too.
   */
  private freeStuckPuck(dt: number) {
    const { pos, vel } = this.physics;
    const speed = Math.hypot(vel.x, vel.y);
    const touching = this.touching();

    // Online the server nudges idle pucks and frees stuck ones; here an AI just backs off.
    if (!this.net && touching.length === 0 && speed < IDLE_SPEED) {
      this.idleFor += dt;
      if (this.idleFor >= IDLE_TIME) {
        this.idleFor = 0;
        // Toward a random seat's zone, so someone has a reason to go and hit it.
        const seat = Math.floor(Math.random() * this.layout.seats.length);
        const home = serveSpot(this.layout, seat, this.scale);
        const d = Math.hypot(home.x - pos.x, home.y - pos.y) || 1;
        vel.x = ((home.x - pos.x) / d) * NUDGE_SPEED;
        vel.y = ((home.y - pos.y) / d) * NUDGE_SPEED;
      }
    } else {
      this.idleFor = 0;
    }

    // Only AIs are made to back off; a human holding the puck is left alone.
    if (!touching.some((b) => this.ais.has(b.seat)) || speed > STUCK_SPEED) {
      this.stuckFor = 0;
      return;
    }
    this.stuckFor += dt;
    if (this.stuckFor < STUCK_TIME) return;
    this.stuckFor = 0;
    for (const b of touching) this.ais.get(b.seat)?.retreat(RETREAT_TIME);
    if (this.net) return;
    const d = Math.hypot(pos.x, pos.y) || 1;
    vel.x = (-pos.x / d) * NUDGE_SPEED;
    vel.y = (-pos.y / d) * NUDGE_SPEED;
  }

  private goal(conceded: number) {
    // The most recent player other than the one who conceded scores, so a defender
    // deflecting the puck into their own goal still gives the last attacker the point.
    const scorer = scorerFor(this.hitters, conceded, this.scores.length);
    if (scorer !== undefined) {
      this.scores[scorer]++;
      if (this.scores[scorer] >= this.winScore) this.winner = scorer;
    }
    this.loser = conceded;
    this.trail.length = 0;
    this.pause = GOAL_PAUSE;
    this.visible = false;
    this.emit({ t: 'goal', s: scorer ?? -1, c: conceded, sc: [...this.scores] });
  }

  // --- online: what the server tells us ----------------------------------------------

  private netGoal(seat: number) {
    this.waitGoal = true;
    this.onLocalGoal?.(seat);
  }

  /** Whether the puck sits in a goal waiting for the server. */
  get awaitingGoal() {
    return this.waitGoal;
  }

  /** Puck state from the server (`age` seconds old): take it and let it fly on for the time that passed. */
  applyPuck(p: Vec2, v: Vec2, age = 0, visible = true) {
    this.visible = visible;
    this.waitGoal = false;
    this.physics.pos.x = p.x;
    this.physics.pos.y = p.y;
    this.physics.vel.x = v.x;
    this.physics.vel.y = v.y;
    let left = Math.min(Math.max(age, 0), 0.5);
    while (visible && !this.hold && left > 1e-4 && !this.waitGoal) {
      const dt = Math.min(left, 1 / 60);
      this.physics.step(dt, []);
      left -= dt;
    }
  }

  /** Online: show an event (sound, effects) without changing any state. */
  notify(e: MatchEvent) {
    this.emit(e);
  }

  applyGoal(scorer: number, conceded: number, scores: number[]) {
    this.scores.splice(0, this.scores.length, ...scores);
    this.visible = false;
    this.waitGoal = true;
    this.emit({ t: 'goal', s: scorer, c: conceded, sc: [...scores] });
  }

  applyServe(starter: number, p: Vec2) {
    this.physics.reset(p);
    this.visible = true;
    this.waitGoal = false;
    this.emit({ t: 'serve', s: starter });
  }

  private nextRound() {
    this.starter = this.loser; // the loser serves
    this.physics.reset(serveSpot(this.layout, this.starter, this.scale));
    this.trail.length = 0;
    this.hitters = [];
    this.stuckFor = 0;
    this.idleFor = 0;
    this.visible = true;
    this.emit({ t: 'serve', s: this.starter });
  }
}

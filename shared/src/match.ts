import { AiPlayer, type Difficulty } from './ai';
import { buildLayout, serveSpot, type PlayerCount, type TableLayout, type Vec2 } from './layout';
import { SimMallet } from './mallet';
import { Physics, PUCK_RADIUS, type MalletBody } from './physics';

const STUCK_MOVE = 1.5; // a puck that stays within this distance of one spot counts as stuck (a pinned puck jitters)...
const STUCK_TIME = 5; // ...for this many seconds: then it is served again on the side it was stuck on
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
   * Online client: the server owns the game and `NetGame` predicts and draws it, writing the puck and mallets here.
   * `step` does nothing.
   */
  net = false;

  private ais = new Map<number, AiPlayer>();
  private bodies: MalletBody[];
  /** Seats whose mallet is moved by `drive` (a networked player's exact positions), not by easing to a target. */
  private driven = new Map<number, Vec2 | null>();
  /** Recent distinct hitters, oldest first. */
  private hitters: number[] = [];
  private loser = -1;
  private pause = 0;
  private stuckFor = 0;
  /** Where the puck was when it started touching a mallet. */
  private stuckAt: Vec2 = { x: 0, y: 0 };
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
      onGoal: (seat) => this.goal(seat),
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

  /** Server: a seat's mallet follows the exact positions its player sends (`drive`), or eases to a target again. */
  setDriven(seat: number, on: boolean) {
    if (on) this.driven.set(seat, null);
    else this.driven.delete(seat);
  }

  isDriven(seat: number) {
    return this.driven.has(seat);
  }

  /** Where a driven mallet is at the end of the next step. Without a new position it stands still. */
  drive(seat: number, p: Vec2) {
    if (this.driven.has(seat)) this.driven.set(seat, p);
  }

  /** Mallets stand still for one step (countdowns): a driven mallet's position for it is dropped. */
  holdMallets() {
    for (const m of this.mallets) {
      m.prev.x = m.pos.x;
      m.prev.y = m.pos.y;
      if (this.driven.has(m.seat)) this.driven.set(m.seat, null);
    }
  }

  /** Mallets move one step without any game happening (pauses, between rounds). */
  moveMallets(dt: number) {
    for (const m of this.mallets) {
      if (!this.driven.has(m.seat)) {
        m.update(dt);
        continue;
      }
      const p = this.driven.get(m.seat) ?? m.pos;
      m.drive(p.x, p.y);
      this.driven.set(m.seat, null);
    }
  }

  step(dt: number) {
    if (this.net) return;
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
    this.physics.step(dt, this.bodies);
    if (this.pause <= 0) this.freeStuckPuck(dt);
  }

  private touching() {
    const { pos, radius } = this.physics;
    return this.bodies.filter((b) => Math.hypot(pos.x - b.cur.x, pos.y - b.cur.y) < b.radius + radius + 0.25);
  }

  /**
   * A puck pinned in a corner (by a mallet, or wedged on its own) can sit there forever: if it stays in one spot for
   * STUCK_TIME, it is served again, standing still on the serve spot of the side it was stuck on, like a new round.
   * A puck lying idle where nobody is near it (e.g. on a zone boundary no AI attacks) is nudged toward a seat.
   */
  private freeStuckPuck(dt: number) {
    const { pos, vel } = this.physics;
    const speed = Math.hypot(vel.x, vel.y);
    const touching = this.touching();

    if (touching.length === 0 && speed < IDLE_SPEED) {
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

    // Judged by how far it gets, not by its speed: a pinned puck can jitter fast in place.
    if (Math.hypot(pos.x - this.stuckAt.x, pos.y - this.stuckAt.y) > STUCK_MOVE) {
      this.stuckFor = 0;
      this.stuckAt = { x: pos.x, y: pos.y };
      return;
    }
    this.stuckFor += dt;
    if (this.stuckFor < STUCK_TIME) return;
    this.stuckFor = 0;
    this.idleFor = 0;
    const side = this.sideOf(pos);
    const spot = serveSpot(this.layout, side, this.scale);
    this.physics.reset(spot);
    this.stuckAt = { ...spot };
    this.emit({ t: 'serve', s: side });
  }

  /** The seat whose zone `p` is in (the nearest goal's, on a boundary). */
  private sideOf(p: Vec2): number {
    const inZone = this.layout.zones.findIndex((planes) => planes.every((pl) => pl.n.x * p.x + pl.n.y * p.y >= pl.d));
    if (inZone >= 0) return inZone;
    let best = 0;
    for (const st of this.layout.seats) {
      const g = this.layout.seats[best].goalCenter;
      if (Math.hypot(p.x - st.goalCenter.x, p.y - st.goalCenter.y) < Math.hypot(p.x - g.x, p.y - g.y)) best = st.index;
    }
    return best;
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
    this.pause = GOAL_PAUSE;
    this.visible = false;
    this.emit({ t: 'goal', s: scorer ?? -1, c: conceded, sc: [...this.scores] });
  }

  /** Online client: show an event the server reported (sound, effects) without changing any state. */
  notify(e: MatchEvent) {
    if (e.t === 'goal') this.scores.splice(0, this.scores.length, ...e.sc);
    this.emit(e);
  }

  private nextRound() {
    this.starter = this.loser; // the loser serves
    this.physics.reset(serveSpot(this.layout, this.starter, this.scale));
    this.hitters = [];
    this.stuckFor = 0;
    this.idleFor = 0;
    this.visible = true;
    this.emit({ t: 'serve', s: this.starter });
  }
}

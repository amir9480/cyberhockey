import { AiPlayer, type Difficulty } from './ai';
import { buildLayout, serveSpot, type PlayerCount, type TableLayout, type Vec2 } from './layout';
import { SimMallet } from './mallet';
import { Physics, PUCK_RADIUS, type MalletBody } from './physics';

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

  /** Mallets ease toward their targets without any game happening (countdowns). */
  moveMallets(dt: number) {
    for (const m of this.mallets) m.update(dt);
  }

  step(dt: number) {
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
   * A puck pinned between a mallet and a wall corner can sit there forever. If it hardly moves
   * while an AI mallet touches it, those AIs back off and it gets a small nudge toward the centre.
   * A puck lying idle where nobody is near it (e.g. on a zone boundary no AI attacks) is nudged too.
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

    // Only AIs are made to back off; a human holding the puck is left alone.
    if (!touching.some((b) => this.ais.has(b.seat)) || speed > STUCK_SPEED) {
      this.stuckFor = 0;
      return;
    }
    this.stuckFor += dt;
    if (this.stuckFor < STUCK_TIME) return;
    this.stuckFor = 0;
    for (const b of touching) this.ais.get(b.seat)?.retreat(RETREAT_TIME);
    const d = Math.hypot(pos.x, pos.y) || 1;
    vel.x = (-pos.x / d) * NUDGE_SPEED;
    vel.y = (-pos.y / d) * NUDGE_SPEED;
  }

  private goal(conceded: number) {
    // The most recent player other than the one who conceded scores, so a defender
    // deflecting the puck into their own goal still gives the last attacker the point.
    let scorer = [...this.hitters].reverse().find((s) => s !== conceded);
    // Nobody else touched it: with two players the opponent still gets the point.
    if (scorer === undefined && this.scores.length === 2) scorer = 1 - conceded;
    if (scorer !== undefined) {
      this.scores[scorer]++;
      if (this.scores[scorer] >= this.winScore) this.winner = scorer;
    }
    this.loser = conceded;
    this.pause = GOAL_PAUSE;
    this.visible = false;
    this.emit({ t: 'goal', s: scorer ?? -1, c: conceded, sc: [...this.scores] });
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

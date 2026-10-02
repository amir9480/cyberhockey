import { AiPlayer, type Difficulty } from './ai';
import type { Ball } from './ball';
import { WIN_DURATION, type WinEffect } from './effects';
import type { TableLayout } from './layout';
import type { Mallet } from './mallet';
import { Physics, PUCK_RADIUS, type MalletBody } from './physics';
import { Round } from './round';
import { DEFAULT_ROOM } from './room';
import type { Scoreboard } from './scores';
import type { Sound } from './sound';

const STUCK_SPEED = 1.5; // puck slower than this while touching a mallet counts as stuck
const STUCK_TIME = 1.2; // seconds stuck before we step in
const RETREAT_TIME = 0.8; // how long a rival backs off
const NUDGE_SPEED = 4; // gentle shove toward the centre
const GOAL_PAUSE = WIN_DURATION; // the win effect plays out before the next serve

/** Ties physics, rounds, scoring and the ball's colour together. */
export class Match {
  readonly scores: number[];
  readonly round: Round;
  private physics: Physics;
  /** Recent distinct hitters, oldest first. */
  private hitters: number[] = [];
  private loser = -1;
  private pause = 0;
  private bodies: MalletBody[];
  private ais: AiPlayer[];
  private rivals: Mallet[];
  private stuckFor = 0;
  private winScore = DEFAULT_ROOM.winScore;
  /** Seat that reached the winning score, or -1 while the game is on. */
  winner = -1;
  private reported = false;
  /** Called once, after the final goal's effect has played out. */
  onOver: ((winner: number, scores: number[]) => void) | null = null;

  constructor(
    layout: TableLayout,
    private ball: Ball,
    mallets: Mallet[],
    private board: Scoreboard,
    difficulty: Difficulty,
    private fx: WinEffect,
    private sound: Sound,
    scale: number,
  ) {
    this.scores = layout.seats.map(() => 0);
    this.physics = new Physics(layout, {
      onHit: (seat, impact) => {
        this.sound.hit(impact / 25);
        if (this.hitters[this.hitters.length - 1] !== seat) this.hitters.push(seat);
        if (this.hitters.length > 8) this.hitters.shift();
        this.ball.setLastHitter(seat);
      },
      onWall: (impact) => {
        if (impact > 1.5) this.sound.wall(impact / 25);
      },
      onGoal: (seat) => this.goal(seat),
    });
    this.bodies = mallets.map((m) => ({
      seat: m.seat,
      // Read live: the room can resize mallets mid-game.
      get radius() {
        return m.radius;
      },
      prev: m.prev,
      cur: m.pos,
    }));
    this.rivals = mallets.filter((m) => m.seat !== 0);
    this.ais = this.rivals.map((m) => new AiPlayer(layout, m, difficulty, mallets));
    this.physics.setPuckRadius(PUCK_RADIUS * scale);
    this.round = new Round(layout, ball, scale);
    this.physics.reset(ball.pos);
  }

  /** Room size rule: the puck scales with the mallets. */
  setScale(scale: number) {
    this.physics.setPuckRadius(PUCK_RADIUS * scale);
    this.round.scale = scale;
  }

  setWinScore(n: number) {
    this.winScore = n;
  }

  get over() {
    return this.winner >= 0;
  }

  setDifficulty(d: Difficulty) {
    for (const ai of this.ais) ai.setDifficulty(d);
  }

  update(dt: number) {
    if (this.pause > 0) {
      this.pause -= dt;
      if (this.pause <= 0) {
        if (this.over) {
          if (!this.reported) {
            this.reported = true;
            this.onOver?.(this.winner, [...this.scores]);
          }
        } else this.nextRound();
      }
      return;
    }
    if (this.over) return;
    for (const ai of this.ais) ai.update(dt, this.physics);
    for (const m of this.rivals) m.update(dt);
    this.physics.step(dt, this.bodies);
    if (this.pause <= 0) this.ball.setPosition(this.physics.pos);
    this.freeStuckPuck(dt);
  }

  /**
   * A puck pinned between a mallet and a wall corner can sit there forever. If it hardly moves
   * while touching a mallet, the rivals touching it back off and it gets a small nudge toward the centre.
   */
  private freeStuckPuck(dt: number) {
    const { pos, vel, radius } = this.physics;
    const touching = this.bodies.filter((b) => Math.hypot(pos.x - b.cur.x, pos.y - b.cur.y) < b.radius + radius + 0.25);
    // Only rivals are made to back off; a human holding the puck is left alone.
    if (!touching.some((b) => b.seat !== 0) || Math.hypot(vel.x, vel.y) > STUCK_SPEED) {
      this.stuckFor = 0;
      return;
    }
    this.stuckFor += dt;
    if (this.stuckFor < STUCK_TIME) return;
    this.stuckFor = 0;
    this.ais.forEach((ai, i) => {
      if (touching.some((b) => b.seat === this.rivals[i].seat)) ai.retreat(RETREAT_TIME);
    });
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
      this.board.setScore(scorer, this.scores[scorer]);
      if (this.scores[scorer] >= this.winScore) this.winner = scorer;
    }
    this.fx.trigger(scorer ?? null, conceded);
    if (scorer === 0) this.sound.win();
    else if (conceded === 0) this.sound.lose();
    else if (scorer !== undefined) this.sound.other();
    this.loser = conceded;
    this.pause = GOAL_PAUSE;
    this.ball.group.visible = false;
  }

  private nextRound() {
    this.round.next(this.loser); // the loser serves
    this.physics.reset(this.ball.pos);
    this.hitters = [];
    this.ball.group.visible = true;
  }
}

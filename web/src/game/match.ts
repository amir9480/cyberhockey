import type { Difficulty } from '@airhockey/shared/ai';
import type { TableLayout } from '@airhockey/shared/layout';
import { MatchCore } from '@airhockey/shared/match';
import type { Ball } from './ball';
import type { WinEffect } from './effects';
import type { CyberFx } from './cyber';
import { GameFx } from './gamefx';
import type { Scoreboard } from './scores';
import type { Sound } from './sound';

/** A game (single player, or the local copy of an online one): the shared `MatchCore` plus sound, ball, scoreboard and win effect. Seat 0 is human. */
export class Match {
  readonly core: MatchCore;
  private reported = false;
  /** Online: a correction moved the puck by this much; the drawn ball glides it away instead of jumping. */
  readonly glide = { x: 0, y: 0 };
  /** Called once, after the final goal's effect has played out. */
  onOver: ((winner: number, scores: number[]) => void) | null = null;

  constructor(
    private ball: Ball,
    board: Scoreboard,
    difficulty: Difficulty,
    fx: WinEffect,
    sound: Sound,
    cyber: CyberFx,
    players: TableLayout['players'],
    scale: number,
    winScore: number,
    /** Online: the seat this client plays; the server owns the rules and nobody here is an AI by default. */
    online?: { localSeat: number },
  ) {
    this.core = new MatchCore(players, scale, winScore);
    if (online) this.core.net = true;
    else for (let s = 1; s < players; s++) this.core.setAI(s, true, difficulty);
    const gfx = new GameFx(ball, board, fx, sound, cyber, online?.localSeat ?? 0);
    this.core.onEvent = (e) => gfx.handle(e);
    this.ball.setPosition(this.core.physics.pos);
  }

  get scores() {
    return this.core.scores;
  }

  /** Room size rule: the puck scales with the mallets. */
  setScale(scale: number) {
    this.core.setScale(scale);
  }

  setWinScore(n: number) {
    this.core.setWinScore(n);
  }

  setDifficulty(d: Difficulty) {
    this.core.setDifficulty(d);
  }

  /** Draw the ball where the core has the puck (plus any glide). */
  syncBall() {
    if (!this.core.visible) return;
    const p = this.core.physics.pos;
    this.ball.setPosition({ x: p.x + this.glide.x, y: p.y + this.glide.y });
  }

  /** Countdown before play: mallets move, the puck waits. */
  hold(dt: number) {
    this.core.moveMallets(dt);
  }

  update(dt: number) {
    this.core.step(dt);
    this.ball.group.visible = this.core.visible;
    const k = Math.exp(-dt * 10);
    this.glide.x *= k;
    this.glide.y *= k;
    if (this.core.visible) {
      const p = this.core.physics.pos;
      this.ball.setPosition({ x: p.x + this.glide.x, y: p.y + this.glide.y });
    }
    if (this.core.done && !this.reported) {
      this.reported = true;
      this.onOver?.(this.core.winner, [...this.core.scores]);
    }
  }
}

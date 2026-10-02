import type { Difficulty } from '@airhockey/shared/ai';
import type { TableLayout } from '@airhockey/shared/layout';
import { MatchCore } from '@airhockey/shared/match';
import type { Ball } from './ball';
import type { WinEffect } from './effects';
import { GameFx } from './gamefx';
import type { Scoreboard } from './scores';
import type { Sound } from './sound';

/** Single-player game: the shared `MatchCore` plus sound, ball, scoreboard and win effect. Seat 0 is human. */
export class Match {
  readonly core: MatchCore;
  private reported = false;
  /** Called once, after the final goal's effect has played out. */
  onOver: ((winner: number, scores: number[]) => void) | null = null;

  constructor(
    private ball: Ball,
    board: Scoreboard,
    difficulty: Difficulty,
    fx: WinEffect,
    sound: Sound,
    players: TableLayout['players'],
    scale: number,
    winScore: number,
  ) {
    this.core = new MatchCore(players, scale, winScore);
    for (let s = 1; s < players; s++) this.core.setAI(s, true, difficulty);
    const gfx = new GameFx(ball, board, fx, sound, 0);
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

  update(dt: number) {
    this.core.step(dt);
    this.ball.group.visible = this.core.visible;
    if (this.core.visible) this.ball.setPosition(this.core.physics.pos);
    if (this.core.done && !this.reported) {
      this.reported = true;
      this.onOver?.(this.core.winner, [...this.core.scores]);
    }
  }
}

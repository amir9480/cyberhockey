import type { MatchEvent } from '@airhockey/shared/match';
import type { Ball } from './ball';
import { BALL_NEUTRAL, seatColor } from './colors';
import type { CyberFx } from './cyber';
import type { WinEffect } from './effects';
import type { Scoreboard } from './scores';
import type { Sound } from './sound';

/** Turns game events into what the player sees and hears: sound, ball colour, scoreboard, win effect, ripples and sparks. */
export class GameFx {
  constructor(
    private ball: Ball,
    private board: Scoreboard,
    private fx: WinEffect,
    private sound: Sound,
    private cyber: CyberFx,
    /** The seat this client plays. */
    private localSeat: number,
  ) {}

  handle(e: MatchEvent) {
    switch (e.t) {
      case 'hit':
        this.sound.hit(e.i / 25);
        this.ball.setLastHitter(e.s);
        this.cyber.impact(this.ball.pos, seatColor(e.s), e.i / 25);
        break;
      case 'wall':
        this.sound.wall(e.i / 25);
        this.cyber.impact(this.ball.pos, this.ball.color, (e.i / 25) * 0.6);
        break;
      case 'goal': {
        const scorer = e.s >= 0 ? e.s : null;
        if (scorer !== null) this.board.setScore(scorer, e.sc[scorer]);
        this.fx.trigger(scorer, e.c);
        this.cyber.goal(this.ball.pos, scorer !== null ? seatColor(scorer) : BALL_NEUTRAL);
        if (scorer === this.localSeat) this.sound.win();
        else if (e.c === this.localSeat) this.sound.lose();
        else if (scorer !== null) this.sound.other();
        break;
      }
      case 'serve':
        this.ball.resetColor();
        break;
    }
  }
}

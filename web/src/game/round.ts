import type { Ball } from './ball';
import { serveSpot, type TableLayout } from './layout';

/** Round flow: who serves and where the ball starts. */
export class Round {
  number = 1;
  starter: number;

  constructor(
    private layout: TableLayout,
    private ball: Ball,
    /** Mallet / puck size multiplier, for the serve gap. */
    public scale = 1,
  ) {
    // First round: a random player serves.
    this.starter = Math.floor(Math.random() * layout.seats.length);
    this.place();
  }

  /** Start the next round; the loser of the last one serves. */
  next(loser: number) {
    this.number++;
    this.starter = loser;
    this.place();
  }

  private place() {
    this.ball.setPosition(serveSpot(this.layout, this.starter, this.scale));
    this.ball.resetColor();
  }
}

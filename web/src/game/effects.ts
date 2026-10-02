import * as THREE from 'three';
import { seatColor } from './colors';

/** Uniforms shared by every material that reacts to a win. */
export interface WinUniforms {
  /** Colour everything tints toward. */
  uWinColor: { value: THREE.Color };
  /** 0 = normal colours, 1 = fully the winner's colour. */
  uWinAmt: { value: number };
  /** Seat that scored, or -1. */
  uWinSeat: { value: number };
  /** Red tint for the local player's own lights after they lose a round. */
  uLoseColor: { value: THREE.Color };
  uLoseAmt: { value: number };
  /** Seat that gets the lose colour (the local player, seat 0) or -1. */
  uLoseSeat: { value: number };
  /** 0..1 flash pulse for the winner's segments and spotlight. */
  uFlash: { value: number };
}

export const WIN_DURATION = 1.0; // seconds
const RISE = 0.1;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Win effect: for one second the whole table takes the scorer's colour and cools back down,
 * while the scorer's seven-segment display and spotlight flash twice.
 */
export class WinEffect {
  readonly uniforms: WinUniforms = {
    uWinColor: { value: new THREE.Color(1, 1, 1) },
    uWinAmt: { value: 0 },
    uWinSeat: { value: -1 },
    uLoseColor: { value: new THREE.Color(1, 0.06, 0.1) },
    uLoseAmt: { value: 0 },
    uLoseSeat: { value: -1 },
    uFlash: { value: 0 },
  };
  private hasWinner = false;
  private mainLost = false;
  private t = WIN_DURATION;

  /** `scorer` is null when nobody got the point; `loser` is the seat that conceded. */
  trigger(scorer: number | null, loser: number) {
    this.hasWinner = scorer !== null;
    this.mainLost = loser === 0;
    if (scorer !== null) this.uniforms.uWinColor.value.copy(seatColor(scorer));
    this.uniforms.uWinSeat.value = scorer ?? -1;
    this.uniforms.uLoseSeat.value = this.mainLost ? 0 : -1;
    this.t = 0;
    this.apply();
  }

  update(dt: number) {
    if (this.t >= WIN_DURATION) return;
    this.t += dt;
    this.apply();
  }

  private apply() {
    const u = this.uniforms;
    if (this.t >= WIN_DURATION) {
      u.uWinAmt.value = 0;
      u.uLoseAmt.value = 0;
      u.uFlash.value = 0;
      u.uWinSeat.value = -1;
      u.uLoseSeat.value = -1;
      return;
    }
    const env = Math.min(this.t / RISE, 1) * (1 - smooth(0.45, 1, this.t));
    u.uWinAmt.value = this.hasWinner ? env : 0;
    u.uLoseAmt.value = this.mainLost ? env : 0;
    // Two pulses in the second: peaks at 0.25 s and 0.75 s.
    u.uFlash.value = !this.hasWinner ? 0 : Math.pow(0.5 - 0.5 * Math.cos(4 * Math.PI * this.t), 1.5);
  }
}

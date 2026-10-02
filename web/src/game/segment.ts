import * as THREE from 'three';
import vert from '../shaders/segment.vert?raw';
import frag from '../shaders/segment.frag?raw';
import type { WinUniforms } from './effects';

// Must match WIDTH / PAD in segment.frag. Cell height is 1.
const WIDTH = 1.34;
const PAD = 0.3;
const MAX = 99;

/**
 * Two-digit seven-segment display lying flat on the floor (text "up" = -z).
 * Lit segments glow in `color`; unlit ones are barely visible. The tens digit
 * has every segment unlit until the value reaches 10.
 */
export class SevenSegment {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private mat: THREE.ShaderMaterial;
  private uniforms: Record<string, { value: unknown }> = {
    uColor: { value: new THREE.Color(1, 1, 1) },
    uTens: { value: 0 },
    uOnes: { value: 0 },
    uShowTens: { value: 0 },
    uFlash: { value: 0 },
  };

  /** @param height digit height in world units */
  constructor(height: number, color: THREE.Color, fx: WinUniforms, seat: number, value = 0) {
    // Win tint is shared; the flash pulse is per display.
    this.uniforms.uWinColor = fx.uWinColor;
    this.uniforms.uWinAmt = fx.uWinAmt;
    this.uniforms.uLoseColor = fx.uLoseColor;
    this.uniforms.uLoseAmt = fx.uLoseAmt;
    this.uniforms.uLoseSeat = fx.uLoseSeat;
    this.uniforms.uSeat = { value: seat };
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: this.uniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.scale.set((WIDTH + 2 * PAD) * height, 1, (1 + 2 * PAD) * height);
    this.mesh.renderOrder = 2;
    this.setColor(color);
    this.setValue(value);
  }

  setValue(value: number) {
    const v = Math.max(0, Math.min(MAX, Math.floor(value)));
    this.uniforms.uTens.value = Math.floor(v / 10);
    this.uniforms.uOnes.value = v % 10;
    this.uniforms.uShowTens.value = v >= 10 ? 1 : 0;
  }

  /** Flash pulse 0..1: lit segments burn brighter and whiter. */
  setFlash(v: number) {
    this.uniforms.uFlash.value = v;
  }

  setColor(color: THREE.Color) {
    (this.uniforms.uColor.value as THREE.Color).copy(color);
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}

import * as THREE from 'three';
import malletVert from '../shaders/mallet.vert?raw';
import malletFrag from '../shaders/mallet.frag?raw';
import { seatColor } from './colors';
import type { WinUniforms } from './effects';
import type { Vec2 } from '@airhockey/shared/layout';
import { MALLET_RADIUS, type SimMallet } from '@airhockey/shared/mallet';

export { MALLET_RADIUS };

/** Render layer of a seat's mallet: the shared `SimMallet` holds position, easing and clamping. */
export class Mallet {
  readonly group = new THREE.Group();
  private geo: THREE.LatheGeometry;
  private mat: THREE.ShaderMaterial;
  private mirrorMat: THREE.ShaderMaterial;
  private color: { value: THREE.Color };

  constructor(
    readonly sim: SimMallet,
    fx: WinUniforms,
  ) {
    const seat = sim.seat;
    this.color = { value: seatColor(seat).clone() };
    const profile = [
      [0.0, 0.0],
      [0.68, 0.0],
      [0.75, 0.05],
      [0.75, 0.18],
      [0.7, 0.27],
      [0.52, 0.3],
      [0.36, 0.33],
      [0.3, 0.42],
      [0.28, 0.58],
      [0.22, 0.68],
      [0.12, 0.72],
      [0.0, 0.73],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    this.geo = new THREE.LatheGeometry(profile, 40);

    const make = (mirror: number) =>
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: malletVert,
        fragmentShader: malletFrag,
        side: THREE.DoubleSide,
        uniforms: { ...fx, uMirror: { value: mirror }, uColor: this.color, uSeat: { value: seat } },
      });
    this.mat = make(0);
    this.mirrorMat = make(1);

    const body = new THREE.Mesh(this.geo, this.mat);
    body.renderOrder = 3;
    const reflection = new THREE.Mesh(this.geo, this.mirrorMat);
    reflection.scale.y = -1;
    reflection.renderOrder = 0;
    this.group.add(body, reflection);
    this.group.scale.setScalar(sim.radius / MALLET_RADIUS);
    this.sync();
  }

  get seat() {
    return this.sim.seat;
  }
  get pos() {
    return this.sim.pos;
  }
  get radius() {
    return this.sim.radius;
  }
  /** Online: where to draw the mallet when that isn't where it is (drawn at another moment); null: where it is. */
  drawAt: Vec2 | null = null;
  /** Where the mallet is drawn. */
  get shown(): Vec2 {
    return this.drawAt ?? this.sim.pos;
  }
  /** Where the mallet is heading (its eased position catches up to this). */
  get goal(): Vec2 {
    return this.sim.target;
  }

  /** Resize the mallet (visual and physical); keeps it inside its zone. */
  setScale(scale: number) {
    this.sim.setScale(scale);
    this.group.scale.setScalar(scale);
    this.sync();
  }

  /** Where the mallet should be; it eases toward it. */
  moveTo(p: Vec2) {
    this.sim.moveTo(p);
  }

  update(dt: number) {
    this.sim.update(dt);
    this.sync();
  }

  /** Copy the drawn position onto the mesh. */
  sync() {
    const p = this.shown;
    this.group.position.set(p.x, 0, p.y);
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.mirrorMat.dispose();
  }
}

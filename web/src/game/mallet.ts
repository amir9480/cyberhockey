import * as THREE from 'three';
import malletVert from '../shaders/mallet.vert?raw';
import malletFrag from '../shaders/mallet.frag?raw';
import { seatColor } from './colors';
import type { WinUniforms } from './effects';
import { clampToSeat, malletHome, type TableLayout, type Vec2 } from './layout';

/** Radius at scale 1. */
export const MALLET_RADIUS = 0.75;
const WALL = 0.4 + 0.1; // wall thickness + small gap
const FOLLOW = 45; // 1/s, how tightly the mallet chases its target

/** A seat's mallet. Seat 0 is the local player (bottom); the others are AI-driven. */
export class Mallet {
  readonly group = new THREE.Group();
  readonly pos: Vec2 = { x: 0, y: 0 };
  /** Position at the start of the last update; with `pos` gives the mallet's motion. */
  readonly prev: Vec2 = { x: 0, y: 0 };
  /** Current radius, after the room's size setting. */
  radius = MALLET_RADIUS;
  private target: Vec2 = { x: 0, y: 0 };
  private geo: THREE.LatheGeometry;
  private mat: THREE.ShaderMaterial;
  private mirrorMat: THREE.ShaderMaterial;
  private color: { value: THREE.Color };

  constructor(
    private layout: TableLayout,
    readonly seat: number,
    fx: WinUniforms,
  ) {
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

    const home = malletHome(layout, seat);
    this.pos = this.clamp(home);
    this.target = { ...this.pos };
    this.prev.x = this.pos.x;
    this.prev.y = this.pos.y;
    this.apply();
  }

  /** Where the mallet is heading (its eased position catches up to this). */
  get goal(): Vec2 {
    return this.target;
  }

  clamp(p: Vec2): Vec2 {
    return clampToSeat(this.layout, this.seat, p, this.radius, WALL);
  }

  /** Resize the mallet (visual and physical); keeps it inside its zone. */
  setScale(scale: number) {
    this.radius = MALLET_RADIUS * scale;
    this.group.scale.setScalar(scale);
    const p = this.clamp(this.pos);
    this.pos.x = p.x;
    this.pos.y = p.y;
    this.prev.x = p.x;
    this.prev.y = p.y;
    this.target = this.clamp(this.target);
    this.apply();
  }

  /** Where the mallet should be; it eases toward it. */
  moveTo(p: Vec2) {
    this.target = this.clamp(p);
  }

  update(dt: number) {
    this.prev.x = this.pos.x;
    this.prev.y = this.pos.y;
    const k = 1 - Math.exp(-FOLLOW * dt);
    this.pos.x += (this.target.x - this.pos.x) * k;
    this.pos.y += (this.target.y - this.pos.y) * k;
    this.apply();
  }

  private apply() {
    this.group.position.set(this.pos.x, 0, this.pos.y);
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.mirrorMat.dispose();
  }
}

import * as THREE from 'three';
import vert from '../shaders/mallet.vert?raw'; // same varyings: normal, view dir, local pos, height
import frag from '../shaders/ball.frag?raw';
import { BALL_NEUTRAL, seatColor } from './colors';
import type { Vec2 } from '@airhockey/shared/layout';
import { PUCK_RADIUS } from '@airhockey/shared/physics';
import { Trail } from './trail';

/** Radius at scale 1. */
export const BALL_RADIUS = PUCK_RADIUS;
const COLOR_RATE = 6; // 1/s, how fast the colour eases to the last hitter's

/** Glowing air hockey puck. Takes the colour of the last player who hit it (white until then). */
export class Ball {
  readonly group = new THREE.Group();
  readonly pos: Vec2 = { x: 0, y: 0 };
  /** Current radius, after the room's size setting. */
  radius = BALL_RADIUS;
  private body: THREE.Mesh;
  private reflection: THREE.Mesh;
  private geo: THREE.LatheGeometry;
  private mats: THREE.ShaderMaterial[];
  private color = { value: BALL_NEUTRAL.clone() };
  private targetColor = BALL_NEUTRAL.clone();
  private trail: Trail;

  constructor() {
    const r = BALL_RADIUS;
    const h = 0.2;
    const bevel = 0.05;
    const profile = [
      [0, 0],
      [r - bevel, 0],
      [r, bevel],
      [r, h - bevel],
      [r - bevel, h],
      [0, h],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    this.geo = new THREE.LatheGeometry(profile, 48);

    const make = (mirror: number) =>
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: vert,
        fragmentShader: frag,
        side: THREE.DoubleSide,
        uniforms: { uColor: this.color, uMirror: { value: mirror } },
      });
    this.mats = [make(0), make(1)];
    const body = new THREE.Mesh(this.geo, this.mats[0]);
    body.renderOrder = 4;
    const reflection = new THREE.Mesh(this.geo, this.mats[1]);
    reflection.scale.y = -1;
    reflection.renderOrder = 0;
    this.body = body;
    this.reflection = reflection;
    this.trail = new Trail(this.color, BALL_RADIUS);
    this.group.add(this.trail.mesh, body, reflection);
  }

  /** Resize the puck (the trail is built in world units, so only the meshes scale). */
  setScale(scale: number) {
    this.radius = BALL_RADIUS * scale;
    this.body.scale.setScalar(scale);
    this.reflection.scale.set(scale, -scale, scale);
    this.trail.setRadius(this.radius);
  }

  setPosition(p: Vec2) {
    this.pos.x = p.x;
    this.pos.y = p.y;
    this.group.position.set(p.x, 0, p.y);
  }

  /** Seat of the last player to hit the ball, or null for white. */
  setLastHitter(seat: number | null) {
    this.targetColor.copy(seat === null ? BALL_NEUTRAL : seatColor(seat));
  }

  /** Back to white instantly, e.g. when a new round starts. */
  resetColor() {
    this.targetColor.copy(BALL_NEUTRAL);
    this.color.value.copy(BALL_NEUTRAL);
  }

  update(dt: number) {
    if (this.group.visible) this.trail.update(dt, this.pos);
    else this.trail.clear();
    this.color.value.lerp(this.targetColor, 1 - Math.exp(-COLOR_RATE * dt));
  }

  dispose() {
    this.geo.dispose();
    this.trail.dispose();
    for (const m of this.mats) m.dispose();
  }
}

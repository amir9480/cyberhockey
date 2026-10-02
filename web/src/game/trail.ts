import * as THREE from 'three';
import vert from '../shaders/trail.vert?raw';
import frag from '../shaders/trail.frag?raw';
import type { Vec2 } from '@airhockey/shared/layout';

const MAX_POINTS = 40;
const LIFE = 0.25; // seconds a trail point lives
const MIN_GAP = 1 / 120; // seconds between recorded points
const HEIGHT = 0.04; // just above the floor
const FULL_SPEED = 20; // units/s at which the tail reaches full strength
const MIN_SPEED = 4; // gentle movement leaves no tail

interface Point {
  x: number;
  y: number;
  t: number;
}

/**
 * Soft fading ribbon behind a moving ball, flat on the floor. Built from the ball's recent
 * positions, so it follows the real path (bounces included). Lives in the ball's local space.
 */
export class Trail {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private pos = new Float32Array(MAX_POINTS * 2 * 3);
  private age = new Float32Array(MAX_POINTS * 2);
  private side = new Float32Array(MAX_POINTS * 2);
  private points: Point[] = []; // newest first
  private time = 0;
  private lastPos: Vec2 | null = null;
  private strength = { value: 0 };

  constructor(
    color: { value: THREE.Color },
    private radius: number,
  ) {
    for (let i = 0; i < MAX_POINTS; i++) {
      this.side[i * 2] = -1;
      this.side[i * 2 + 1] = 1;
      this.age[i * 2] = this.age[i * 2 + 1] = 1;
    }
    const index: number[] = [];
    for (let i = 0; i < MAX_POINTS - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setIndex(index);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSide', new THREE.BufferAttribute(this.side, 1));

    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uColor: color, uStrength: this.strength },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  setRadius(r: number) {
    this.radius = r;
  }

  clear() {
    this.points.length = 0;
    this.lastPos = null;
    this.strength.value = 0;
  }

  /** Call every frame with the ball's world position. */
  update(dt: number, ball: Vec2) {
    this.time += dt;

    // A jump (new serve) is not motion: start a fresh tail.
    let speed = 0;
    if (this.lastPos) {
      const d = Math.hypot(ball.x - this.lastPos.x, ball.y - this.lastPos.y);
      if (d > 3) this.clear();
      else speed = dt > 0 ? d / dt : 0;
    }
    this.lastPos = { x: ball.x, y: ball.y };
    const target = THREE.MathUtils.smoothstep(speed, MIN_SPEED, FULL_SPEED);
    this.strength.value += (target - this.strength.value) * Math.min(1, dt * 12);

    const head = this.points[0];
    if (!head || this.time - head.t >= MIN_GAP) this.points.unshift({ x: ball.x, y: ball.y, t: this.time });
    else this.points[0] = { x: ball.x, y: ball.y, t: head.t };
    while (this.points.length > MAX_POINTS || (this.points.length > 1 && this.time - this.points[this.points.length - 1].t > LIFE)) {
      this.points.pop();
    }
    this.rebuild(ball);
  }

  private rebuild(ball: Vec2) {
    const pts = this.points;
    const n = pts.length;
    for (let i = 0; i < MAX_POINTS; i++) {
      const p = pts[Math.min(i, n - 1)];
      const alive = i < n;
      const age = alive ? Math.min((this.time - p.t) / LIFE, 1) : 1;
      // Direction of travel here, from the neighbouring points.
      const prev = pts[Math.max(i - 1, 0)] ?? p;
      const next = pts[Math.min(i + 1, n - 1)] ?? p;
      let tx = prev.x - next.x;
      let ty = prev.y - next.y;
      const l = Math.hypot(tx, ty) || 1;
      tx /= l;
      ty /= l;
      const w = alive ? this.radius * (1 - age) : 0;
      const x = p.x - ball.x;
      const z = p.y - ball.y;
      const o = i * 6;
      this.pos[o] = x - ty * w;
      this.pos[o + 1] = HEIGHT;
      this.pos[o + 2] = z + tx * w;
      this.pos[o + 3] = x + ty * w;
      this.pos[o + 4] = HEIGHT;
      this.pos[o + 5] = z - tx * w;
      this.age[i * 2] = this.age[i * 2 + 1] = age;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aAge as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}

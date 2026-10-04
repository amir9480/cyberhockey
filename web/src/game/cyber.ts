import * as THREE from 'three';
import sparkVert from '../shaders/spark.vert?raw';
import sparkFrag from '../shaders/spark.frag?raw';
import type { Vec2 } from '@airhockey/shared/layout';

/** Effect level: 0 = low (shader tweaks only), 1 = medium (+ sparks, backdrop, post), 2 = high (+ scanlines). */
export type FxLevel = 0 | 1 | 2;

export const MAX_RIPPLES = 4;
const MAX_SPARKS = 256;
const SPARK_LIFE = 0.5; // seconds; the vertex shader uses the same value
const BURST = [0, 12, 22]; // sparks per hit, by level
// Hits and wall bounces share a spark budget that refills over time: a puck jammed between mallet and wall fires a
// hit or bounce every few frames, and a full burst each time piled up into a flashing blob. One hard hit still gets
// its full burst; a rapid string of them gets fewer and fewer sparks each.
const SPARK_BUDGET = 1.2; // most impact sparks at once, in full bursts of the current level
const SPARK_REFILL = 1.5; // full bursts' worth regained per second
const KICK_DECAY = 6; // 1/s
const SHAKE = 0.006; // screen fraction at full kick
const HIT_RIPPLE = 0.2; // hit and wall ripples are this faint next to a goal's

/** Uniforms shared by the table, mallets, puck, backdrop and post pass. */
export interface CyberUniforms {
  /** Seconds since start. */
  uTime: { value: number };
  /** Effect level (see `FxLevel`). */
  uFx: { value: number };
  /** Floor ripples: xy table position, z start time, w strength (0 = unused). */
  uRip: { value: THREE.Vector4[] };
  uRipCol: { value: THREE.Color[] };
  /** 0..1 impulse from hits and goals: rails flare, the screen shakes. */
  uKick: { value: number };
  /** Puck: xy table position, z 1 when it is shown. */
  uPuck: { value: THREE.Vector3 };
}

const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The "cyber" layer on top of the game: floor ripples, sparks, and the impulse that drives the rail flare and screen
 * shake. Everything animates on the GPU from start times; the CPU only writes a few values per event.
 */
export class CyberFx {
  readonly uniforms: CyberUniforms = {
    uTime: { value: 0 },
    uFx: { value: 2 },
    uRip: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -10, 0)) },
    uRipCol: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Color()) },
    uKick: { value: 0 },
    uPuck: { value: new THREE.Vector3() },
  };
  /** Screen shake offset for the post pass, in UV units. */
  readonly shake = new THREE.Vector2();
  readonly sparks: THREE.Points;
  /** Pixels per world unit at distance 1, for the spark size (set on resize). */
  readonly pxScale = { value: 500 };
  private level: FxLevel = 2;
  private nextRipple = 0;
  private nextSpark = 0;
  /** Impact sparks that may spawn right now, in full bursts (see SPARK_BUDGET). */
  private sparkBudget = SPARK_BUDGET;
  private budgetT = 0;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private origin = new Float32Array(MAX_SPARKS * 3);
  private vel = new Float32Array(MAX_SPARKS * 3);
  private birth = new Float32Array(MAX_SPARKS).fill(-10);
  private color = new Float32Array(MAX_SPARKS * 3);

  constructor() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.origin, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aBirth', new THREE.BufferAttribute(this.birth, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: sparkVert,
      fragmentShader: sparkFrag,
      uniforms: { uTime: this.uniforms.uTime, uPx: this.pxScale },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.sparks = new THREE.Points(this.geo, this.mat);
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 5;
  }

  setLevel(level: FxLevel) {
    this.level = level;
    this.uniforms.uFx.value = level;
    this.sparks.visible = level > 0;
  }

  /** Something hit the puck or a wall at `p`; `strength` is about 0..1. */
  impact(p: Vec2, color: THREE.Color, strength: number) {
    const s = Math.min(1, Math.max(0, strength));
    if (s < 0.05) return;
    this.ripple(p, color, (0.3 + s * 0.7) * HIT_RIPPLE);
    this.kick(s * 0.45);
    this.burst(p, color, this.spend(Math.round(BURST[this.level] * (0.4 + 0.6 * s))), 3 + s * 9);
  }

  /** Take up to `count` impact sparks from the budget; how many may spawn. */
  private spend(count: number): number {
    const full = BURST[this.level];
    if (!full) return 0;
    const t = this.uniforms.uTime.value;
    this.sparkBudget = Math.min(SPARK_BUDGET, this.sparkBudget + Math.max(0, t - this.budgetT) * SPARK_REFILL);
    this.budgetT = t;
    const n = Math.min(count, Math.floor(this.sparkBudget * full));
    this.sparkBudget -= n / full;
    return n;
  }

  /** A goal at `p`: a big ripple, a big kick and a shower of sparks. */
  goal(p: Vec2, color: THREE.Color) {
    this.ripple(p, color, 2);
    this.kick(1);
    this.burst(p, color, BURST[this.level] * 2, 12);
  }

  private ripple(p: Vec2, color: THREE.Color, strength: number) {
    const i = this.nextRipple;
    this.nextRipple = (i + 1) % MAX_RIPPLES;
    this.uniforms.uRip.value[i].set(p.x, p.y, this.uniforms.uTime.value, strength);
    this.uniforms.uRipCol.value[i].copy(color);
  }

  private kick(amount: number) {
    this.uniforms.uKick.value = Math.max(this.uniforms.uKick.value, amount);
  }

  private burst(p: Vec2, color: THREE.Color, count: number, speed: number) {
    if (count <= 0) return;
    const t = this.uniforms.uTime.value;
    for (let n = 0; n < count; n++) {
      const i = this.nextSpark;
      this.nextSpark = (i + 1) % MAX_SPARKS;
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      this.origin.set([p.x, 0.12, p.y], i * 3);
      this.vel.set([Math.cos(a) * v, 1.5 + Math.random() * 3, Math.sin(a) * v], i * 3);
      this.birth[i] = t;
      // Most sparks take the colour, some burn white-hot.
      const hot = Math.random() < 0.3 ? 1 : 0;
      this.color.set([color.r + hot, color.g + hot, color.b + hot], i * 3);
    }
    for (const name of ['position', 'aVel', 'aBirth', 'aColor']) (this.geo.attributes[name] as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Call every frame with the time since start (s) and the frame time (s). */
  update(t: number, dt: number) {
    this.uniforms.uTime.value = t;
    const k = (this.uniforms.uKick.value *= Math.exp(-KICK_DECAY * dt));
    if (reducedMotion || this.level === 0 || k < 0.01) this.shake.set(0, 0);
    else {
      const a = Math.random() * Math.PI * 2;
      this.shake.set(Math.cos(a), Math.sin(a)).multiplyScalar(k * k * SHAKE);
    }
    // Sparks still alive keep the points drawn; none alive skips the draw call.
    this.sparks.visible = this.level > 0 && this.birth.some((b) => t - b < SPARK_LIFE);
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}

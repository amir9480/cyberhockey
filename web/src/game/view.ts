import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { PlayerCount, Vec2 } from '@airhockey/shared/layout';
import type { SimMallet } from '@airhockey/shared/mallet';
import { createTable, WALL_HEIGHT, type Table } from './table';
import { Mallet } from './mallet';
import { DEFAULT_ROOM, clampMalletScale, clampWinScore, type RoomSettings } from '@airhockey/shared/room';
import { Scoreboard } from './scores';
import { Ball } from './ball';
import { Match } from './match';
import type { Difficulty } from '@airhockey/shared/ai';
import { WinEffect } from './effects';
import { setSeatColors } from './colors';
import { Sound } from './sound';

const SIM_STEP = 1 / 240; // fixed simulation step, seconds
const MAX_STEPS = 60; // at most 0.25 s of catch-up per frame

export type Quality = 'low' | 'medium' | 'high';
export const QUALITIES: Quality[] = ['low', 'medium', 'high'];
const QUALITY: Record<Quality, { dpr: number; bloom: number; shadows: boolean }> = {
  low: { dpr: 1, bloom: 0, shadows: false }, // bloom 0 = pass off
  medium: { dpr: 1.5, bloom: 0.4, shadows: true },
  high: { dpr: 2, bloom: 0.6, shadows: true },
};

/** Camera tilt above the table plane, in degrees: 90 would be straight down. */
export const DEFAULT_PITCH = 50;
export const MIN_PITCH = 15;
export const MAX_PITCH = 89; // not 90: looking exactly down makes lookAt degenerate

export class View {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
  private table: Table | null = null;
  /** The local player's mallet. */
  mallet: Mallet | null = null;
  /** Every seat's mallet, by seat (the local one included). */
  mallets: Mallet[] = [];
  ball: Ball | null = null;
  /** The running game: single player, or the local copy of an online one (the server validates it). */
  match: Match | null = null;
  /** The seat shown at the bottom of the screen. */
  private localSeat = 0;
  /** Camera sits this far along this horizontal direction from the table centre. */
  private camDir: Vec2 = { x: 0, y: 1 };
  /** Called every frame before rendering (the online driver predicts and places things here). */
  onFrame: ((dt: number, now: number) => void) | null = null;
  /** Rendered frames per second, refreshed twice a second. */
  fps = 0;
  onFps: ((fps: number) => void) | null = null;
  private fpsFrames = 0;
  private fpsT = performance.now();
  /** False while paused: the game freezes but keeps rendering. */
  running = false;
  private difficulty: Difficulty = 'medium';
  private players: PlayerCount = 2;
  /** Fired when someone reaches the winning score. */
  onGameOver: ((winner: number, scores: number[]) => void) | null = null;
  private fx = new WinEffect();
  private room: RoomSettings = { ...DEFAULT_ROOM };
  private acc = 0;
  private quality: Quality = 'high';
  private probe: { t0: number; startAt: number; frames: number; warmup: number; window: number; done: (fps: number) => void } | null = null;
  readonly sound = new Sound();
  private pitch = THREE.MathUtils.degToRad(DEFAULT_PITCH);
  scores: Scoreboard | null = null;
  private last = performance.now();
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private camDist = 30;
  private start = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x05030a);

    this.scene.fog = new THREE.FogExp2(0x05030a, 0.012);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.7, 0.3);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    addEventListener('resize', this.resize);
    this.resize();
    this.renderer.setAnimationLoop(this.frame);
  }

  /** Throw the current game away and start a fresh one on the same table. */
  restart() {
    this.setPlayers(this.players);
  }

  setPlayers(n: PlayerCount) {
    this.players = n;
    this.teardown();
    this.localSeat = 0;
    this.fx.localSeat = 0;
    this.table = createTable(n, this.fx.uniforms);
    this.scene.add(this.table.group);
    this.ball = new Ball();
    this.ball.setScale(this.room.malletScale);
    this.scene.add(this.ball.group);
    this.scores = new Scoreboard(this.table.layout, this.fx.uniforms);
    this.scene.add(this.scores.group);
    this.match = new Match(this.ball, this.scores, this.difficulty, this.fx, this.sound, n, this.room.malletScale, this.room.winScore);
    this.match.onOver = (w, s) => this.onGameOver?.(w, s);
    this.addMallets(this.match.core.mallets);
    this.finishSetup();
  }

  /**
   * Online table: every seat's mallet is built, `mallet` is the local seat's and the camera looks from its
   * side. `seatColors[seat]` is the palette index of each seat. Mallets
   * other than the local one, and the puck, are placed by `NetGame` from its prediction.
   */
  setupNet(players: PlayerCount, localSeat: number, seatColors: number[], settings: RoomSettings, scores: number[] = []) {
    this.players = players;
    this.teardown();
    setSeatColors(seatColors);
    this.room = { ...settings };
    this.localSeat = localSeat;
    this.fx.localSeat = localSeat;
    this.table = createTable(players, this.fx.uniforms);
    this.scene.add(this.table.group);
    this.ball = new Ball();
    this.ball.setScale(settings.malletScale);
    this.scene.add(this.ball.group);
    this.scores = new Scoreboard(this.table.layout, this.fx.uniforms);
    this.scene.add(this.scores.group);
    scores.forEach((v, s) => this.scores?.setScore(s, v));
    this.match = new Match(this.ball, this.scores, this.difficulty, this.fx, this.sound, players, settings.malletScale, settings.winScore, {
      localSeat,
    });
    this.addMallets(this.match.core.mallets);
    this.finishSetup();
  }

  private teardown() {
    if (this.table) {
      this.scene.remove(this.table.group);
      this.table.dispose();
    }
    for (const m of this.mallets) {
      this.scene.remove(m.group);
      m.dispose();
    }
    this.mallets = [];
    this.mallet = null;
    this.match = null;
    if (this.ball) {
      this.scene.remove(this.ball.group);
      this.ball.dispose();
    }
    if (this.scores) {
      this.scene.remove(this.scores.group);
      this.scores.dispose();
    }
  }

  private addMallets(sims: SimMallet[]) {
    this.mallets = sims.map((s) => new Mallet(s, this.fx.uniforms));
    for (const m of this.mallets) this.scene.add(m.group);
    this.mallet = this.mallets[this.localSeat];
  }

  private finishSetup() {
    const layout = this.table!.layout;
    const inward = layout.seats[this.localSeat].inward;
    this.camDir = { x: -inward.x, y: -inward.y };
    this.table!.setShadows(QUALITY[this.quality].shadows);
    this.fitCamera();
  }

  /** Apply room rules live (mallet size resizes every mallet immediately). */
  setRoom(patch: Partial<RoomSettings>) {
    this.room = { ...this.room, ...patch };
    this.room.malletScale = clampMalletScale(this.room.malletScale);
    this.room.winScore = clampWinScore(this.room.winScore);
    this.match?.setWinScore(this.room.winScore);
    // Mallets are resized by the match (single player); the puck scales with them.
    if (this.match) {
      this.match.setScale(this.room.malletScale);
      for (const m of this.mallets) m.setScale(this.room.malletScale);
    }
    this.ball?.setScale(this.room.malletScale);
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.table?.setShadows(QUALITY[q].shadows);
    this.resize();
  }

  /** Average frames per second over `window` ms, after `warmup` ms (shader compiles hitch the start). */
  measureFps(warmup = 600, window = 1200): Promise<number> {
    return new Promise((done) => {
      const now = performance.now();
      this.probe = { t0: now, startAt: 0, frames: 0, warmup, window, done };
    });
  }

  /** Camera angle in degrees (side view .. top-down). */
  setPitch(deg: number) {
    this.pitch = THREE.MathUtils.degToRad(Math.min(MAX_PITCH, Math.max(MIN_PITCH, deg)));
    this.fitCamera();
  }

  setDifficulty(d: Difficulty) {
    this.difficulty = d;
    this.match?.setDifficulty(d);
  }

  private resize = () => {
    const w = innerWidth;
    const h = innerHeight;
    const q = QUALITY[this.quality];
    const dpr = Math.min(devicePixelRatio, q.dpr);
    const bs = q.bloom || 0.5;
    this.bloom.enabled = q.bloom > 0;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w * bs, h * bs);
    this.bloom.setSize(w * bs, h * bs);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fitCamera();
  };

  private place(dist: number) {
    const y = Math.sin(this.pitch) * dist;
    const z = Math.cos(this.pitch) * dist;
    this.camera.position.set(this.camDir.x * z, y, this.camDir.y * z);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
  }

  /** Smallest camera distance that keeps the whole table (with margin) on screen. */
  private fitCamera() {
    if (!this.table) return;
    const poly: Vec2[] = this.table.layout.polygon;
    const pts: THREE.Vector3[] = [];
    const r = this.table.layout.cornerRadius;
    for (const v of poly) {
      // Pull corners in slightly: rounded corners never reach the sharp polygon vertex.
      const d = Math.hypot(v.x, v.y);
      const k = (d - r * 0.4) / d;
      pts.push(new THREE.Vector3(v.x * k, 0, v.y * k), new THREE.Vector3(v.x * k, WALL_HEIGHT, v.y * k));
    }
    // Fit the table's projected bounds into the free screen area (HUD at the top),
    // then shift the view so the table is centred in that area.
    const marginX = 0.82;
    const top = 0.78; // leave room for the HUD
    const bottom = -0.82;
    const w = innerWidth;
    const h = innerHeight;
    this.camera.clearViewOffset();

    const p = new THREE.Vector3();
    const bounds = () => {
      let maxX = 0;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const pt of pts) {
        p.copy(pt).project(this.camera);
        maxX = Math.max(maxX, Math.abs(p.x));
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      return { maxX, minY, maxY };
    };

    let lo = 5;
    let hi = 250;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      this.place(mid);
      const b = bounds();
      if (b.maxX <= marginX && b.maxY - b.minY <= top - bottom) hi = mid;
      else lo = mid;
    }
    this.camDist = hi;
    this.place(this.camDist);

    const b = bounds();
    const shift = (top + bottom) / 2 - (b.minY + b.maxY) / 2; // NDC units, + = move up
    if (Math.abs(shift) > 1e-4) this.camera.setViewOffset(w, h, 0, (shift * h) / 2, w, h);
  }

  /** Screen px (client coords) to a point on the table plane. */
  screenToTable(cx: number, cy: number): Vec2 | null {
    const ndc = new THREE.Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.ray.intersectPlane(this.plane, new THREE.Vector3());
    return hit ? { x: hit.x, y: hit.z } : null;
  }

  /** Table point to screen px (client coords). */
  tableToScreen(p: Vec2, height = 0): Vec2 {
    const v = new THREE.Vector3(p.x, height, p.y).project(this.camera);
    return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
  }

  private frame = () => {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.25);
    this.last = now;
    const t = (now - this.start) / 1000;
    if (this.table) this.table.update(t);

    // The simulation runs in fixed steps, however many frames per second we render, so
    // game speed is the same on every quality level and refresh rate.
    if (this.running) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= SIM_STEP && steps < MAX_STEPS) {
        this.match?.update(SIM_STEP);
        this.acc -= SIM_STEP;
        steps++;
      }
      if (steps === MAX_STEPS) this.acc = 0; // way behind (e.g. tab was asleep): drop the backlog
      this.fx.update(dt);
    } else {
      this.acc = 0;
    }
    this.onFrame?.(dt, now);
    for (const m of this.mallets) m.sync();
    this.scores?.update();
    if (this.ball) this.ball.update(dt);
    // Everything that casts a shadow from the goal lights.
    if (this.table && this.mallet && this.ball) {
      const casters = this.mallets.map((m) => ({ x: m.pos.x, y: m.pos.y, r: m.radius }));
      // A hidden ball (between rounds) casts no shadow.
      if (this.ball.group.visible) casters.push({ x: this.ball.pos.x, y: this.ball.pos.y, r: this.ball.radius });
      this.table.setOccluders(casters);
    }
    this.composer.render();
    this.fpsFrames++;
    if (now - this.fpsT >= 500) {
      this.fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsT));
      this.fpsFrames = 0;
      this.fpsT = now;
      this.onFps?.(this.fps);
    }
    if (this.probe) this.sample(now);
  };

  private sample(now: number) {
    const p = this.probe!;
    if (document.hidden) {
      // A background tab throttles frames; start over when it's back.
      p.t0 = now;
      p.startAt = 0;
      p.frames = 0;
      return;
    }
    if (now - p.t0 < p.warmup) return;
    if (!p.startAt) {
      p.startAt = now;
      return;
    }
    p.frames++;
    if (now - p.startAt >= p.window) {
      this.probe = null;
      p.done((p.frames * 1000) / (now - p.startAt));
    }
  }
}

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import neonGlsl from '../shaders/neon.glsl?raw';
import backdropVert from '../shaders/backdrop.vert?raw';
import backdropFrag from '../shaders/backdrop.frag?raw';
import postFrag from '../shaders/post.frag?raw';
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
import { CyberFx, type FxLevel } from './cyber';
import type { NameAnchor, SeatNames } from './seatnames';

const SIM_STEP = 1 / 240; // fixed simulation step, seconds
const MAX_STEPS = 60; // at most 0.25 s of catch-up per frame

export type Quality = 'low' | 'medium' | 'high';
export const QUALITIES: Quality[] = ['low', 'medium', 'high'];
/**
 * Per level: max device pixel ratio, bloom resolution scale (0 = pass off), light shadows, and the effect level
 * (low: shader-only touches; medium: + sparks, backdrop, vignette/grain/shake; high: + aberration, scanlines).
 */
const QUALITY: Record<Quality, { dpr: number; bloom: number; shadows: boolean; fx: FxLevel }> = {
  low: { dpr: 1.5, bloom: 0, shadows: false, fx: 0 },
  medium: { dpr: 1.75, bloom: 0.4, shadows: true, fx: 1 },
  high: { dpr: 2, bloom: 0.6, shadows: true, fx: 2 },
};

const POST_VERT = `varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** Camera tilt above the table plane, in degrees: 90 would be straight down. */
export const DEFAULT_PITCH = 50;
export const MIN_PITCH = 15;
export const MAX_PITCH = 89; // not 90: looking exactly down makes lookAt degenerate
/** Camera zoom, percent of the distance that just fits the table: above 100 is closer, below is further. */
export const DEFAULT_ZOOM = 100;
export const MIN_ZOOM = 60;
export const MAX_ZOOM = 160;

// Countdown cinematic: the camera orbits the table, lingering low behind each opponent and whipping on to the next
// seat on each count, ending behind the player when play starts.
const CINE_PITCH = THREE.MathUtils.degToRad(22);
const CINE_ZOOM = 0.85; // closer than the fitted distance
const CINE_DRIFT = THREE.MathUtils.degToRad(5); // very slow orbit while lingering, per second
const CINE_SWING = 0.1; // seconds the whip to the next seat takes

/** Where the camera looks from: horizontal direction from the table centre, tilt, and distance relative to the fit. */
interface Shot {
  dir: Vec2;
  pitch: number;
  zoom: number;
}

export class View {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private output: OutputPass;
  private post: ShaderPass;
  private backdrop: THREE.Mesh;
  private backdropMat: THREE.ShaderMaterial;
  private cyber = new CyberFx();
  private scene = new THREE.Scene();
  /** The camera rendered: the player's view, or the countdown cinematic's. */
  private camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
  /** Always the player's view: the pointer is mapped onto the table through it, whatever the camera shows. */
  private aim = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
  /** The countdown cinematic running: seconds of countdown it spans and has left, and seconds since it hit 0. */
  private cine: { total: number; left: number; after: number } | null = null;
  /** Players' name labels, shown during the countdown cinematic. */
  names: SeatNames | null = null;
  /** Labels were placed last frame (so the frame after the last one hides them, and idle frames skip the work). */
  private namesShown = false;
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
  /** Single player: seconds of countdown before the puck and mallets move. */
  countdown = 0;
  /** Single player: called each frame of a countdown with the seconds left, and once with 0 when it ends. */
  onCountdown: ((secs: number) => void) | null = null;
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
  /** Player's camera distance, relative to the one that just fits the table (0.5 = twice as close). */
  private dist = 1;
  scores: Scoreboard | null = null;
  private last = performance.now();
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private start = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x05030a);

    this.scene.fog = new THREE.FogExp2(0x05030a, 0.012);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.25, 0.2, 0.45);
    this.composer.addPass(this.bloom);
    this.output = new OutputPass();
    this.composer.addPass(this.output);
    // Replaces the output pass from medium up: the same sRGB conversion plus the screen effects.
    this.post = new ShaderPass(
      new THREE.ShaderMaterial({
        vertexShader: POST_VERT,
        fragmentShader: postFrag,
        uniforms: {
          tDiffuse: { value: null },
          uTime: this.cyber.uniforms.uTime,
          uFx: this.cyber.uniforms.uFx,
          uKick: this.cyber.uniforms.uKick,
          uShake: { value: this.cyber.shake },
        },
      }),
    );
    this.composer.addPass(this.post);

    // Backdrop (medium up): a far grid and dust behind everything, one full-screen triangle.
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.backdropMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: backdropVert,
      fragmentShader: backdropFrag.replace('//NEON', neonGlsl),
      uniforms: {
        uInvVP: { value: new THREE.Matrix4() },
        uTime: this.cyber.uniforms.uTime,
        uWinColor: this.fx.uniforms.uWinColor,
        uWinAmt: this.fx.uniforms.uWinAmt,
      },
      depthTest: false,
      depthWrite: false,
    });
    this.backdrop = new THREE.Mesh(tri, this.backdropMat);
    this.backdrop.frustumCulled = false;
    this.backdrop.renderOrder = -10;
    this.scene.add(this.backdrop, this.cyber.sparks);

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
    this.table = createTable(n, this.fx.uniforms, this.cyber.uniforms);
    this.scene.add(this.table.group);
    this.ball = new Ball(this.cyber.uniforms.uTime);
    this.ball.setScale(this.room.malletScale);
    this.scene.add(this.ball.group);
    this.scores = new Scoreboard(this.table.layout, this.fx.uniforms);
    this.scene.add(this.scores.group);
    this.match = new Match(this.ball, this.scores, this.difficulty, this.fx, this.sound, this.cyber, n, this.room.malletScale, this.room.winScore);
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
    this.table = createTable(players, this.fx.uniforms, this.cyber.uniforms);
    this.scene.add(this.table.group);
    this.ball = new Ball(this.cyber.uniforms.uTime);
    this.ball.setScale(settings.malletScale);
    this.scene.add(this.ball.group);
    this.scores = new Scoreboard(this.table.layout, this.fx.uniforms);
    this.scene.add(this.scores.group);
    scores.forEach((v, s) => this.scores?.setScore(s, v));
    this.match = new Match(this.ball, this.scores, this.difficulty, this.fx, this.sound, this.cyber, players, settings.malletScale, settings.winScore, {
      localSeat,
    });
    this.addMallets(this.match.core.mallets);
    this.finishSetup();
  }

  private teardown() {
    this.names?.clear();
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
    this.mallets = sims.map((s) => new Mallet(s, this.fx.uniforms, this.cyber.uniforms.uTime));
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

  /** Points that win the current game. */
  get winScore() {
    return this.room.winScore;
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

  /** Camera zoom in percent (see DEFAULT_ZOOM). */
  setZoom(percent: number) {
    this.dist = 100 / Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, percent));
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
    this.cyber.setLevel(q.fx);
    this.post.enabled = q.fx > 0;
    this.output.enabled = !this.post.enabled;
    this.backdrop.visible = q.fx > 0;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w * bs, h * bs);
    this.bloom.setSize(w * bs, h * bs);
    for (const cam of [this.camera, this.aim]) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
    this.fitCamera();
    // Spark size: pixels per world unit at distance 1.
    this.cyber.pxScale.value = (h * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  };

  /** The player's own view: behind their goal, at their chosen tilt and zoom. */
  private get playerShot(): Shot {
    return { dir: this.camDir, pitch: this.pitch, zoom: this.dist };
  }

  /** Re-fit the player's view (aim camera, and the rendered one unless the cinematic owns it). */
  private fitCamera() {
    this.fit(this.aim, this.playerShot);
    if (!this.cine) this.fit(this.camera, this.playerShot);
  }

  private static place(cam: THREE.PerspectiveCamera, shot: Shot, dist: number) {
    const y = Math.sin(shot.pitch) * dist;
    const z = Math.cos(shot.pitch) * dist;
    cam.position.set(shot.dir.x * z, y, shot.dir.y * z);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
  }

  /** Put `cam` at `shot`, at the smallest distance that keeps the whole table (with margin) on screen, times its zoom. */
  private fit(cam: THREE.PerspectiveCamera, shot: Shot) {
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
    cam.clearViewOffset();

    const p = new THREE.Vector3();
    const bounds = () => {
      let maxX = 0;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const pt of pts) {
        p.copy(pt).project(cam);
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
      View.place(cam, shot, mid);
      const b = bounds();
      if (b.maxX <= marginX && b.maxY - b.minY <= top - bottom) hi = mid;
      else lo = mid;
    }
    View.place(cam, shot, hi * shot.zoom);

    const b = bounds();
    const shift = (top + bottom) / 2 - (b.minY + b.maxY) / 2; // NDC units, + = move up
    if (Math.abs(shift) > 1e-4) cam.setViewOffset(w, h, 0, (shift * h) / 2, w, h);
  }

  /**
   * Countdown cinematic, fed each frame with the countdown's seconds left; 0 when it ends (the camera then whips back
   * to the player). A countdown that starts again (a restart) starts the cinematic over.
   */
  cinematic(left: number) {
    if (left > 0) {
      if (!this.cine || left > this.cine.left + 1e-6) this.cine = { total: Math.ceil(left - 1e-6), left, after: 0 };
      else this.cine.left = left;
    } else if (this.cine) this.cine.left = 0;
  }

  /** Cut the cinematic short (a pause): straight back to the player's view, where the camera settings show. */
  stopCinematic() {
    if (!this.cine) return;
    this.cine = null;
    this.fit(this.camera, this.playerShot);
  }

  /**
   * The cinematic's shot `e` seconds in. The camera goes round the table in one direction, lingering at a stop on each
   * count (drifting on round while there) and whipping on to the next stop as the count changes, the last whip landing
   * behind the player as play starts. The stops are each opponent's end in turn, and with fewer than three
   * opponents the player's own end on 1. Two players: the opponent's end from either side of them (3, 2).
   */
  private cineShot(e: number, total: number): Shot {
    const seats = this.table!.layout.seats;
    const yaw = (i: number) => Math.atan2(-seats[i].inward.y, -seats[i].inward.x);
    const own = yaw(this.localSeat);
    const tau = Math.PI * 2;
    const deg = THREE.MathUtils.degToRad;
    // Each stop's angle past the player's, in the orbit's direction.
    const opponents = seats
      .filter((s) => s.index !== this.localSeat)
      .map((s) => (((yaw(s.index) - own) % tau) + tau) % tau)
      .sort((p, q) => p - q);
    // Low and to one side at the player's own end: the last count, when there are counts to spare.
    const mine = deg(300);
    const stops =
      seats.length === 2
        ? [deg(150), deg(210), mine]
        : seats.length === 3
          ? [...opponents, mine]
          : opponents;
    const opp = stops.slice(-total);
    const m = opp.length;
    const startOf = (j: number) => (j === 0 ? 0 : total - m + j);
    const endOf = (j: number) => total - m + j + 1;
    // Angle past the player's while lingering at stop j (j === m: the player's own seat, a full turn on).
    const at = (j: number, t: number) =>
      j === m ? tau : opp[j] + CINE_DRIFT * (t - (startOf(j) + endOf(j)) / 2);
    const shot = (a: number, pitch: number, zoom: number): Shot => ({
      dir: { x: Math.cos(own + a), y: Math.sin(own + a) },
      pitch,
      zoom,
    });

    let j = 0;
    while (j < m && e >= endOf(j)) j++;
    // Whipping from stop j - 1 to stop j?
    const b = j > 0 ? endOf(j - 1) : -Infinity;
    if (e < b + CINE_SWING) {
      const u = (e - b) / CINE_SWING;
      const k = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
      const from = at(j - 1, b);
      const to = at(j, b + CINE_SWING);
      const home = j === m ? k : 0;
      return shot(
        from + (to - from) * k,
        CINE_PITCH + (this.pitch - CINE_PITCH) * home,
        CINE_ZOOM + (this.dist - CINE_ZOOM) * home,
      );
    }
    return j === m ? this.playerShot : shot(at(j, e), CINE_PITCH, CINE_ZOOM);
  }

  /** Move the rendered camera along the cinematic; once the last whip has landed, hand back the player's view. */
  private updateCinematic(dt: number) {
    const c = this.cine;
    if (!c || !this.table) return;
    if (c.left <= 0) {
      c.after += dt;
      if (c.after >= CINE_SWING) {
        this.stopCinematic();
        return;
      }
    }
    this.fit(this.camera, this.cineShot(c.total - c.left + c.after, c.total));
  }

  /** While counting down in the cinematic: a spot just above each mallet, as the rendered camera sees it. */
  private nameAnchors(): NameAnchor[] {
    if (!this.cine || this.cine.left <= 0) return [];
    const out: NameAnchor[] = [];
    const v = new THREE.Vector3();
    for (const m of this.mallets) {
      const p = m.shown;
      v.set(p.x, m.radius * 1.8, p.y).project(this.camera);
      if (v.z > 1) continue; // behind the camera
      out.push({ seat: m.seat, x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight });
    }
    return out;
  }

  /** Screen px (client coords) to a point on the table plane, as the player sees it. */
  screenToTable(cx: number, cy: number): Vec2 | null {
    const ndc = new THREE.Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
    this.ray.setFromCamera(ndc, this.aim);
    const hit = this.ray.ray.intersectPlane(this.plane, new THREE.Vector3());
    return hit ? { x: hit.x, y: hit.z } : null;
  }

  /** Table point to screen px (client coords), as the player sees it. */
  tableToScreen(p: Vec2, height = 0): Vec2 {
    const v = new THREE.Vector3(p.x, height, p.y).project(this.aim);
    return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
  }

  private frame = () => {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.25);
    this.last = now;
    const t = (now - this.start) / 1000;
    this.cyber.update(t, dt);

    // The simulation runs in fixed steps, however many frames per second we render, so
    // game speed is the same on every quality level and refresh rate.
    if (this.running) {
      this.acc += dt;
      let steps = 0;
      const counting = this.countdown > 0;
      while (this.acc >= SIM_STEP && steps < MAX_STEPS) {
        if (this.countdown > 0) {
          this.countdown = Math.max(0, this.countdown - SIM_STEP);
          this.match?.hold();
        } else this.match?.update(SIM_STEP);
        this.acc -= SIM_STEP;
        steps++;
      }
      if (steps === MAX_STEPS) this.acc = 0; // way behind (e.g. tab was asleep): drop the backlog
      if (counting) {
        this.onCountdown?.(this.countdown);
        this.cinematic(this.countdown);
      }
      this.fx.update(dt);
    } else {
      this.acc = 0;
    }
    this.onFrame?.(dt, now);
    this.updateCinematic(dt);
    for (const m of this.mallets) m.sync();
    const anchors = this.nameAnchors();
    if (anchors.length || this.namesShown) this.names?.update(anchors);
    this.namesShown = anchors.length > 0;
    this.scores?.update();
    if (this.ball) this.ball.update(dt);
    // Everything that casts a shadow from the goal lights.
    if (this.table && this.mallet && this.ball) {
      const casters = this.mallets.map((m) => ({ x: m.shown.x, y: m.shown.y, r: m.radius }));
      // A hidden ball (between rounds) casts no shadow.
      if (this.ball.group.visible) casters.push({ x: this.ball.pos.x, y: this.ball.pos.y, r: this.ball.radius });
      this.table.setOccluders(casters);
      this.cyber.uniforms.uPuck.value.set(this.ball.pos.x, this.ball.pos.y, this.ball.group.visible ? 1 : 0);
    }
    if (this.backdrop.visible) {
      this.backdropMat.uniforms.uInvVP.value.multiplyMatrices(this.camera.matrixWorld, this.camera.projectionMatrixInverse);
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

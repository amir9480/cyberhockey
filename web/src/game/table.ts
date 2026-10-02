import * as THREE from 'three';
import neonGlsl from '../shaders/neon.glsl?raw';
import railVert from '../shaders/rail.vert?raw';
import railFrag from '../shaders/rail.frag?raw';
import floorVert from '../shaders/floor.vert?raw';
import floorFrag from '../shaders/floor.frag?raw';
import type { PlayerCount, TableLayout, Vec2 } from '@airhockey/shared/layout';
import { buildLayout } from '@airhockey/shared/layout';
import { seatColor } from './colors';
import type { WinUniforms } from './effects';

const WALL_HEIGHT = 0.55;
const WALL_THICKNESS = 0.4;
const ARC_STEPS = 10;
const MAX_N = 4;
const MAX_OCC = 8;
const LIGHT_BACK = 2.0;

/** Something that casts a light shadow on the floor: position and radius. */
export interface Occluder {
  x: number;
  y: number;
  r: number;
}

interface RailPoint {
  p: Vec2;
  /** Outward normal at this point. */
  n: Vec2;
}

/** Walk the rounded contour, leaving a gap at each goal. */
function railPolylines(layout: TableLayout): RailPoint[][] {
  const { inset, cornerRadius: r, seats, goalWidth } = layout;
  const n = inset.length;
  const goalByEdge = new Map(seats.map((s) => [s.edge, s]));

  const outward = (edge: number): Vec2 => {
    const a = inset[edge];
    const b = inset[(edge + 1) % n];
    const t = { x: b.x - a.x, y: b.y - a.y };
    const l = Math.hypot(t.x, t.y);
    // Edge normal pointing away from the centroid (origin).
    let o = { x: t.y / l, y: -t.x / l };
    if (o.x * a.x + o.y * a.y < 0) o = { x: -o.x, y: -o.y };
    return o;
  };

  const out: RailPoint[][] = [];
  let cur: RailPoint[] = [];

  // Start just after the gap of the first goal edge (edge 0 is always a goal).
  const first = goalByEdge.get(0)!;
  cur.push({
    p: { x: first.goalCenter.x + first.tangent.x * goalWidth / 2, y: first.goalCenter.y + first.tangent.y * goalWidth / 2 },
    n: outward(0),
  });

  for (let m = 1; m <= n; m++) {
    const k = m % n;
    const o0 = outward((k + n - 1) % n);
    const o1 = outward(k);
    const a0 = Math.atan2(o0.y, o0.x);
    let da = Math.atan2(o1.y, o1.x) - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    for (let s = 0; s <= ARC_STEPS; s++) {
      const a = a0 + (da * s) / ARC_STEPS;
      const dir = { x: Math.cos(a), y: Math.sin(a) };
      cur.push({ p: { x: inset[k].x + dir.x * r, y: inset[k].y + dir.y * r }, n: dir });
    }
    const seat = goalByEdge.get(k);
    if (seat) {
      const hw = goalWidth / 2;
      const nn = outward(k);
      cur.push({
        p: { x: seat.goalCenter.x - seat.tangent.x * hw, y: seat.goalCenter.y - seat.tangent.y * hw },
        n: nn,
      });
      out.push(cur);
      cur = [];
      if (m < n) {
        cur.push({
          p: { x: seat.goalCenter.x + seat.tangent.x * hw, y: seat.goalCenter.y + seat.tangent.y * hw },
          n: nn,
        });
      }
    }
  }
  return out;
}

/** Wall ribbon: inner face, top, outer face. Merged into one geometry. */
function buildRailGeometry(polylines: RailPoint[][]): THREE.BufferGeometry {
  const pos: number[] = [];
  const len: number[] = [];
  const hgt: number[] = [];
  const idx: number[] = [];
  let base = 0;
  let total = 0;

  for (const line of polylines) {
    let acc = total;
    for (let i = 0; i < line.length; i++) {
      const { p, n } = line[i];
      if (i > 0) acc += Math.hypot(p.x - line[i - 1].p.x, p.y - line[i - 1].p.y);
      const ix = p.x - n.x * WALL_THICKNESS;
      const iy = p.y - n.y * WALL_THICKNESS;
      // inner bottom, inner top, outer top, outer bottom
      pos.push(ix, 0, iy, ix, WALL_HEIGHT, iy, p.x, WALL_HEIGHT, p.y, p.x, 0, p.y);
      hgt.push(0, 1, 1, 0);
      len.push(acc, acc, acc, acc);
    }
    const count = line.length;
    for (let i = 0; i < count - 1; i++) {
      const a = base + i * 4;
      const b = a + 4;
      for (let f = 0; f < 3; f++) idx.push(a + f, b + f, b + f + 1, a + f, b + f + 1, a + f + 1);
    }
    // End caps so the wall ends at goals are closed.
    for (const at of [0, count - 1]) {
      const a = base + at * 4;
      idx.push(a, a + 1, a + 2, a, a + 2, a + 3);
    }
    total = acc;
    base += count * 4;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aLen', new THREE.Float32BufferAttribute(len, 1));
  g.setAttribute('aH', new THREE.Float32BufferAttribute(hgt, 1));
  g.setIndex(idx);
  return g;
}

export interface Table {
  group: THREE.Group;
  layout: TableLayout;
  update(time: number): void;
  setOccluders(list: Occluder[]): void;
  setShadows(on: boolean): void;
  dispose(): void;
}

export function createTable(players: PlayerCount, fx: WinUniforms): Table {
  const layout = buildLayout(players);
  const uTime = { value: 0 };
  const group = new THREE.Group();

  const withNeon = (src: string) => src.replace('//NEON', neonGlsl);

  // Floor (also draws the outer halo).
  const pad = 9;
  const floorGeo = new THREE.PlaneGeometry((layout.radius + pad) * 2, (layout.radius + pad) * 2);
  floorGeo.rotateX(-Math.PI / 2);

  const pad4 = (arr: Vec2[]) => {
    const v = arr.map((a) => new THREE.Vector2(a.x, a.y));
    while (v.length < MAX_N) v.push(new THREE.Vector2());
    return v;
  };

  const occ = Array.from({ length: MAX_OCC }, () => new THREE.Vector3());
  const uOccN = { value: 0 };
  const uShadows = { value: 1 };

  const floorMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: floorVert,
    fragmentShader: withNeon(floorFrag),
    transparent: true,
    uniforms: {
      ...fx,
      uTime,
      uCount: { value: layout.inset.length },
      uV: { value: pad4(layout.inset) },
      uR: { value: layout.cornerRadius },
      uSeats: { value: layout.seats.length },
      uGC: { value: pad4(layout.seats.map((s) => s.goalCenter)) },
      uGN: { value: pad4(layout.seats.map((s) => s.inward)) },
      uGCol: {
        value: Array.from({ length: MAX_N }, (_, i) => seatColor(i).clone()),
      },
      uGW: { value: layout.goalWidth },
      uLH: { value: LIGHT_BACK },
      uLRange: { value: layout.lightRange },
      uZN: {
        value: Array.from({ length: MAX_N * 2 }, (_, i) => {
          const zone = layout.zones[Math.floor(i / 2)] ?? [];
          const pl = zone[i % 2] ?? zone[0]; // 2P has one plane: repeat it
          return new THREE.Vector2(pl?.n.x ?? 0, pl?.n.y ?? 0);
        }),
      },
      uOccN: uOccN,
      uShadows,
      uOcc: { value: occ },
      uCenterR: { value: layout.centerRadius },
      uCreaseR: { value: layout.creaseRadius },
      uDivN: { value: layout.dividers.length },
      uDiv: { value: pad4(layout.dividers) },
    },
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.renderOrder = 1;
  group.add(floor);

  // Neon rails + mirrored copy for a cheap reflective floor.
  const railGeo = buildRailGeometry(railPolylines(layout));
  const makeRailMat = (mirror: number) =>
    new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: railVert,
      fragmentShader: withNeon(railFrag),
      side: THREE.DoubleSide,
      uniforms: { ...fx, uTime, uMirror: { value: mirror } },
    });
  const railMat = makeRailMat(0);
  const mirrorMat = makeRailMat(1);

  const rails = new THREE.Mesh(railGeo, railMat);
  rails.renderOrder = 2;
  const mirror = new THREE.Mesh(railGeo, mirrorMat);
  mirror.scale.y = -1;
  mirror.renderOrder = 0;
  group.add(rails, mirror);

  return {
    group,
    layout,
    update(t) {
      uTime.value = t;
    },
    setShadows(on) {
      uShadows.value = on ? 1 : 0;
    },
    setOccluders(list) {
      uOccN.value = Math.min(list.length, MAX_OCC);
      for (let i = 0; i < uOccN.value; i++) occ[i].set(list[i].x, list[i].y, list[i].r);
    },
    dispose() {
      floorGeo.dispose();
      railGeo.dispose();
      floorMat.dispose();
      railMat.dispose();
      mirrorMat.dispose();
    },
  };
}

export { WALL_HEIGHT };

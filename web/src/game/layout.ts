/**
 * Pure table geometry. No Three.js here so the same layout can drive
 * physics / server simulation later.
 *
 * Coordinates: x = right, y = toward the viewer (maps to world z).
 * Seat 0 is always the bottom edge (local player).
 */

export type PlayerCount = 2 | 3 | 4;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Plane {
  n: Vec2;
  d: number;
}

export interface Seat {
  index: number;
  /** Index of the polygon edge this seat guards. */
  edge: number;
  /** Goal center on the table contour. */
  goalCenter: Vec2;
  /** Unit vector pointing into the table from the goal. */
  inward: Vec2;
  /** Unit vector along the goal line. */
  tangent: Vec2;
}

export interface TableLayout {
  players: PlayerCount;
  /** Sharp outer polygon, convex. */
  polygon: Vec2[];
  /** Polygon shrunk by cornerRadius; the rounded contour is this + radius. */
  inset: Vec2[];
  cornerRadius: number;
  goalWidth: number;
  /** Marking radii, sized so rings never overlap each other. */
  centerRadius: number;
  creaseRadius: number;
  /** Unit directions from the center splitting the table into per-seat zones . */
  dividers: Vec2[];
  /** Half-planes (dot(n, p) >= d) bounding each seat's own zone. */
  zones: Plane[][];
  seats: Seat[];
  /** Distance from the table centre to the nearest goal. */
  reach: number;
  /** How far a goal light may reach into the table. */
  lightRange: number;
  /** Furthest contour point from the origin. */
  radius: number;
}

const CORNER_RADIUS = 1.2;
const GOAL_WIDTH = 4.4;

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const norm = (a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y);
  return { x: a.x / l, y: a.y / l };
};

function basePolygon(n: PlayerCount): { polygon: Vec2[]; seatEdges: number[] } {
  switch (n) {
    case 2: {
      const hw = 5.5, hd = 8.5;
      return {
        polygon: [
          { x: -hw, y: hd },
          { x: hw, y: hd },
          { x: hw, y: -hd },
          { x: -hw, y: -hd },
        ],
        seatEdges: [0, 2], // bottom, top
      };
    }
    case 3: {
      const side = 17;
      const h = (side * Math.sqrt(3)) / 2;
      const bottom = h / 3; // centroid at origin
      return {
        polygon: [
          { x: -side / 2, y: bottom },
          { x: side / 2, y: bottom },
          { x: 0, y: bottom - h },
        ],
        seatEdges: [0, 2, 1], // bottom, upper-left, upper-right
      };
    }
    case 4: {
      const h = 7.5;
      return {
        polygon: [
          { x: -h, y: h },
          { x: h, y: h },
          { x: h, y: -h },
          { x: -h, y: -h },
        ],
        seatEdges: [0, 3, 2, 1], // bottom, left, top, right
      };
    }
  }
}

export function buildLayout(players: PlayerCount): TableLayout {
  const { polygon, seatEdges } = basePolygon(players);
  const n = polygon.length;

  // Inward unit normal + offset per edge: dot(normal, p) = offset.
  const lines = polygon.map((a, i) => {
    const b = polygon[(i + 1) % n];
    const t = norm(sub(b, a));
    let normal = { x: -t.y, y: t.x };
    if (dot(normal, sub({ x: 0, y: 0 }, a)) < 0) normal = { x: -normal.x, y: -normal.y };
    return { normal, offset: dot(normal, a), tangent: t };
  });

  // Inset polygon: intersect adjacent edge lines each offset inward by radius.
  const inset = polygon.map((_, i) => {
    const l0 = lines[(i + n - 1) % n];
    const l1 = lines[i];
    const c0 = l0.offset + CORNER_RADIUS;
    const c1 = l1.offset + CORNER_RADIUS;
    const det = l0.normal.x * l1.normal.y - l0.normal.y * l1.normal.x;
    return {
      x: (c0 * l1.normal.y - c1 * l0.normal.y) / det,
      y: (l0.normal.x * c1 - l1.normal.x * c0) / det,
    };
  });

  const seats: Seat[] = seatEdges.map((edge, index) => {
    const l = lines[edge];
    const a = inset[edge];
    const b = inset[(edge + 1) % n];
    const outward = { x: -l.normal.x, y: -l.normal.y };
    return {
      index,
      edge,
      goalCenter: {
        x: (a.x + b.x) / 2 + outward.x * CORNER_RADIUS,
        y: (a.y + b.y) / 2 + outward.y * CORNER_RADIUS,
      },
      inward: l.normal,
      tangent: l.tangent,
    };
  });

  const radius = Math.max(...inset.map((v) => Math.hypot(v.x, v.y))) + CORNER_RADIUS;

  // Distance from the center to the nearest goal; rings must fit in it without touching.
  const reach = Math.min(...seats.map((st) => Math.hypot(st.goalCenter.x, st.goalCenter.y)));
  const creaseRadius = Math.min(3, reach * 0.5);
  const centerRadius = Math.min(2.4, reach - creaseRadius - 1.2);

  // Zone borders run from the center to each corner, equidistant from the neighbouring goals.
  // 2P: zones are split by the midline, running out to both side walls.
  const dividers = players === 2 ? [{ x: 1, y: 0 }, { x: -1, y: 0 }] : inset.map((v) => norm(v));

  // Per-seat zone: 2P is the half of the table on the seat's side of the midline,
  // 3P/4P is the wedge between the two dividers running to the seat's edge corners.
  const zones: Plane[][] = seats.map((st) => {
    if (players === 2) return [{ n: { x: -st.inward.x, y: -st.inward.y }, d: 0 }];
    return [st.edge, (st.edge + 1) % n].map((i) => {
      const dv = dividers[i];
      let pn = { x: -dv.y, y: dv.x };
      if (dot(pn, st.goalCenter) < 0) pn = { x: -pn.x, y: -pn.y };
      return { n: pn, d: 0 };
    });
  });

  return {
    players,
    polygon,
    inset,
    cornerRadius: CORNER_RADIUS,
    goalWidth: GOAL_WIDTH,
    centerRadius,
    creaseRadius,
    dividers,
    zones,
    seats,
    reach,
    lightRange: reach * 0.95,
    radius,
  };
}

/**
 * Closest point to `p` that keeps a disc of radius `r` inside the seat's zone and
 * inside the playfield (walls are `wall` thick, measured from the table contour).
 */
export function clampToSeat(layout: TableLayout, seat: number, p: Vec2, r: number, wall: number): Vec2 {
  const { polygon } = layout;
  const n = polygon.length;
  const planes: Plane[] = [...layout.zones[seat]];
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const t = norm(sub(polygon[(i + 1) % n], a));
    let normal = { x: -t.y, y: t.x };
    if (dot(normal, sub({ x: 0, y: 0 }, a)) < 0) normal = { x: -normal.x, y: -normal.y };
    // Goal edges stay closed: the mallet never leaves the table.
    planes.push({ n: normal, d: dot(normal, a) + wall });
  }
  let q = { x: p.x, y: p.y };
  for (let k = 0; k < 4; k++) {
    for (const pl of planes) {
      const s = dot(pl.n, q) - pl.d - r;
      if (s < 0) q = { x: q.x - pl.n.x * s, y: q.y - pl.n.y * s };
    }
  }
  return q;
}

/** Distance from a goal to its mallet's resting spot: just inside the crease, on the goal's centre line. */
function malletDist(layout: TableLayout) {
  return layout.creaseRadius * 0.8;
}

/** Resting spot of a seat's mallet: centred on its gate, just in front of it. */
export function malletHome(layout: TableLayout, seat: number): Vec2 {
  const st = layout.seats[seat];
  const d = malletDist(layout);
  return { x: st.goalCenter.x + st.inward.x * d, y: st.goalCenter.y + st.inward.y * d };
}

/** Where the ball is placed when this seat serves: just ahead of its mallet, inside its zone. */
export function serveSpot(layout: TableLayout, seat: number, scale = 1): Vec2 {
  const st = layout.seats[seat];
  // Bigger mallets and puck need a bigger gap between them.
  const d = Math.min(malletDist(layout) + 1.9 * Math.max(1, scale), layout.reach * 0.9);
  return { x: st.goalCenter.x + st.inward.x * d, y: st.goalCenter.y + st.inward.y * d };
}

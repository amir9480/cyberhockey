precision highp float;
#define MAX_N 6 // polygon corners (3P is a hexagon); seats are fewer
#define MAX_OCC 8
#define MAX_RIP 4
#define RIPPLE_SPEED 10.0 // units/s
#define RIPPLE_LIFE 1.0   // seconds
#define SCAN_SPEED 6.0    // units/s of the scan ring sweeping out from the center
#define SCAN_PERIOD 7.0   // seconds between scans
#define WALL_GLOW 0.15 // light spilling from the walls onto the floor
#define HALO_GLOW 0.07 // soft haze outside the table
#define BEAM_STRENGTH 0.32 // goal spotlight brightness: lower = dimmer

uniform float uTime;
uniform int uCount;
uniform vec2 uV[MAX_N];      // inset polygon
uniform float uR;            // corner radius
uniform int uSeats;
uniform vec2 uGC[MAX_N];     // goal centers
uniform vec2 uGN[MAX_N];     // goal inward normals
uniform vec3 uGCol[MAX_N];   // static per-seat colour
uniform float uGW;           // goal width
uniform float uLH;           // how far behind the goal line the hidden light sits
uniform float uLRange;       // how far a goal light reaches from its goal line
uniform vec2 uZN[MAX_N * 2]; // per-seat zone half-plane normals (two each)
uniform vec3 uWinColor;
uniform float uWinAmt;
uniform vec3 uLoseColor;
uniform float uLoseAmt;
uniform int uLoseSeat;
uniform int uWinSeat;
uniform float uFlash;
uniform int uShadows;        // 0 on low quality: skip the shadow rays
uniform int uOccN;
uniform vec3 uOcc[MAX_OCC];  // shadow casters: xy position, z radius (mallets, ball)
uniform float uCenterR;      // center ring radius
uniform float uCreaseR;      // goal crease radius
uniform int uDivN;           // zone divider count
uniform vec2 uDiv[MAX_N];    // zone divider directions
uniform float uFx;           // effect level: 0 low, 1 medium, 2 high
uniform vec4 uRip[MAX_RIP];  // ripples: xy position, z start time, w strength
uniform vec3 uRipCol[MAX_RIP];
uniform float uKick;         // 0..1 impulse from hits and goals
uniform vec3 uPuck;          // xy position, z 1 when shown
uniform float uRadius;       // table radius

in vec2 vP;
out vec4 outColor;

//NEON

// Signed distance to a convex polygon.
float sdPoly(vec2 p) {
  float d = dot(p - uV[0], p - uV[0]);
  float s = 1.0;
  for (int i = 0; i < MAX_N; i++) {
    if (i >= uCount) break;
    int j = (i + uCount - 1) % uCount;
    vec2 e = uV[j] - uV[i];
    vec2 w = p - uV[i];
    vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= uV[i].y, p.y < uV[j].y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}

// 1 = lit, 0 = in shadow: is the segment light -> p blocked by a caster disc?
float shadowAt(vec2 light, vec2 p) {
  if (uShadows == 0) return 1.0;
  vec2 d = p - light;
  float len = length(d);
  vec2 dir = d / len;
  float sh = 1.0;
  for (int k = 0; k < MAX_OCC; k++) {
    if (k >= uOccN) break;
    vec2 oc = uOcc[k].xy - light;
    float t = dot(oc, dir);
    float perp = length(oc - dir * t);
    float r = uOcc[k].z;
    float behind = step(0.0, t) * smoothstep(t, t + 0.3, len);
    float edge = r + 0.04 * (len - t); // penumbra widens with distance behind the caster
    float blocked = (1.0 - smoothstep(r * 0.6, edge + 0.1, perp)) * behind;
    sh = min(sh, 1.0 - blocked * 0.92);
  }
  return sh;
}

float lineMask(float d, float w, float aa) {
  return 1.0 - smoothstep(w - aa, w + aa, d);
}

// Distance from p to the nearest edge of a hexagonal tiling (cells 1 unit across the flats).
float hexEdge(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(p, s) - s * 0.5;
  vec2 b = mod(p - s * 0.5, s) - s * 0.5;
  vec2 q = abs(dot(a, a) < dot(b, b) ? a : b);
  return 0.5 - max(dot(q, s * 0.5), q.x);
}

// Dashes around a circle: `count` per turn, `duty` of each lit, turning at `spin` turns/s.
float dashes(float ang, float count, float duty, float spin) {
  float x = fract(ang / 6.2831853 + uTime * spin) * count;
  float f = abs(fract(x) - 0.5);
  float fw = min(fwidth(x), 0.2); // the atan seam has a huge derivative: cap it
  return 1.0 - smoothstep(duty * 0.5 - fw, duty * 0.5 + fw, f);
}

void main() {
  vec2 p = vP;
  float sd = sdPoly(p) - uR;
  float aa = max(fwidth(sd), 1e-4);
  float inside = 1.0 - smoothstep(-aa, aa, sd);

  float ang = atan(p.y, p.x);
  float band = 0.5 + 0.5 * cos(ang - uTime * 0.35);
  vec3 winN = uWinColor * (0.8 / max(dot(uWinColor, vec3(0.2126, 0.7152, 0.0722)), 0.1));
  vec3 edgeCol = mix(neon(uTime * 0.035 + ang / 6.2831853), winN, uWinAmt) * (0.6 + 0.4 * band);

  // Dark glossy base.
  vec3 col = vec3(0.012, 0.010, 0.028) + vec3(0.02, 0.014, 0.05) * exp(-dot(p, p) * 0.012);

  // Anti-aliased grid, pulsing outward from the center.
  vec2 g = p / 1.0;
  vec2 gw = fwidth(g);
  vec2 gl = abs(fract(g - 0.5) - 0.5) / max(gw, vec2(1e-4));
  float grid = 1.0 - min(min(gl.x, gl.y), 1.0);
  vec3 gridCol = mix(neon(uTime * 0.035), winN, uWinAmt);

  // The grid wakes up around the mallets and puck...
  float lit = 0.0;
  for (int k = 0; k < MAX_OCC; k++) {
    if (k >= uOccN) break;
    vec2 o = p - uOcc[k].xy;
    float r = uOcc[k].z * 2.2;
    lit += exp(-dot(o, o) / (r * r));
  }
  // ...behind a scan ring that sweeps out from the center now and then...
  float scanR = mod(uTime, SCAN_PERIOD) * SCAN_SPEED;
  float scan = exp(-pow(length(p) - scanR, 2.0) * 1.5) * (1.0 - smoothstep(uRadius * 0.6, uRadius, scanR));
  // ...and under ripples from every hit.
  vec3 rip = vec3(0.0);
  for (int i = 0; i < MAX_RIP; i++) {
    vec4 r = uRip[i];
    float age = uTime - r.z;
    if (r.w <= 0.0 || age < 0.0 || age > RIPPLE_LIFE) continue;
    float w = 0.25 + age * 0.8;
    float dd = length(p - r.xy) - age * RIPPLE_SPEED;
    float fade = 1.0 - age / RIPPLE_LIFE;
    float crisp = lineMask(abs(dd), 0.05, aa * 1.5); // sharp leading edge on top of the soft band
    rip += uRipCol[i] * (exp(-dd * dd / (w * w)) * 0.6 + crisp) * fade * fade * r.w;
  }
  col += gridCol * grid * 0.07 * (1.0 + uWinAmt * 2.0 + lit * 5.0 + scan * 3.0);
  col += rip * (0.35 + grid * 1.5);

  // Faint hexagonal plating under the grid.
  if (uFx > 0.5) {
    vec2 hp = p * 0.9;
    float he = hexEdge(hp);
    float hex = lineMask(he, 0.0, fwidth(hp.x) * 1.2);
    col += gridCol * hex * 0.018 * (1.0 + lit * 3.0 + scan * 2.0);
  }
  col += winN * uWinAmt * 0.05 * exp(-dot(p, p) * 0.01);

  // Inner glow hugging the walls.
  col += edgeCol * exp(sd * 1.6) * WALL_GLOW;

  // Center markings.
  vec3 mark = mix(neon(uTime * 0.035 + 0.5), winN, uWinAmt);
  float pr = length(p);
  float pang = atan(p.y, p.x);
  float ring = lineMask(abs(pr - uCenterR), 0.05, aa * 1.5);
  float dotc = lineMask(pr, 0.18, aa * 1.5);
  // HUD around the center ring: a slowly turning dashed ring outside, counter-turning ticks inside.
  ring += lineMask(abs(pr - uCenterR - 0.4), 0.025, aa * 1.5) * dashes(pang, 48.0, 0.55, 0.012) * 0.8;
  float tickA = fract(pang / 6.2831853 * 72.0 - uTime * 0.6) - 0.5; // 72 ticks, turning the other way
  float tick = lineMask(abs(tickA) * 6.2831853 * pr / 72.0, 0.018, aa * 1.5);
  ring += tick * step(uCenterR - 0.32, pr) * step(pr, uCenterR - 0.14) * 0.7;
  // Zone dividers: start at the center ring, run to the corners.
  float divs = 0.0;
  for (int i = 0; i < MAX_N; i++) {
    if (i >= uDivN) break;
    vec2 d = uDiv[i];
    float along = dot(p, d);
    float perp = abs(d.x * p.y - d.y * p.x);
    divs = max(divs, lineMask(perp, 0.04, aa * 1.5) * step(uCenterR, along));
  }
  col += mark * (ring + dotc + divs) * 0.5 * (1.0 + uWinAmt * 0.8);

  // Goals: crease arc + spotlight, tinted per seat.
  for (int s = 0; s < MAX_N; s++) {
    if (s >= uSeats) break;
    vec2 q = p - uGC[s];
    vec2 n = uGN[s];
    vec2 t = vec2(-n.y, n.x);
    float depth = dot(q, n);
    vec3 gc = mix(uGCol[s], uWinColor, uWinAmt); // every seat's lights take the winner's colour
    if (s == uLoseSeat) gc = mix(uGCol[s], uLoseColor, uLoseAmt); // local player lost: red
    float ql = length(q);
    float arc = lineMask(abs(ql - uCreaseR), 0.04, aa * 1.5) * step(0.0, depth);
    // Dashed outer arc, and chevrons streaming into the goal; both brighten as the puck closes in.
    float danger = uPuck.z * exp(-dot(uPuck.xy - uGC[s], uPuck.xy - uGC[s]) / (uCreaseR * uCreaseR * 2.0));
    float qa = atan(dot(q, t), depth);
    arc += lineMask(abs(ql - uCreaseR - 0.3), 0.02, aa * 1.5) * step(0.0, depth) * dashes(qa, 40.0, 0.5, 0.0) * 0.6;
    float lateral = abs(dot(q, t));
    float chevV = depth - lateral * 0.7;
    float chev = abs(fract(chevV * 1.1 + uTime * 1.2) - 0.5);
    float chevBand = (1.0 - smoothstep(0.4, 0.6, lateral)) * smoothstep(0.3, 0.6, depth) * (1.0 - smoothstep(1.2, 1.6, depth));
    arc += lineMask(chev, 0.04, aa * 2.0) * chevBand * (0.12 + danger * 1.5);
    arc *= 1.0 + danger * 1.2;

    // Spot light: a hidden point behind the goal line shines through the goal mouth.
    vec2 L = uGC[s] - n * uLH;
    vec2 ld = p - L;
    float dp = dot(ld, n);
    float lat = dot(ld, t) * uLH / max(dp, 1e-3); // where the ray crosses the goal line
    float aperture = 1.0 - smoothstep(uGW * 0.5 - 1.4, uGW * 0.5, abs(lat));
    float llen = length(ld);
    float beam = aperture * smoothstep(uLH, uLH + 0.3, dp) * (0.5 + 0.5 * dp / llen);
    // Stay inside this seat's own zone and range so lights never overlap.
    float zone = smoothstep(0.0, 1.5, dot(uZN[s * 2], p)) * smoothstep(0.0, 1.5, dot(uZN[s * 2 + 1], p));
    // Circular pool centred on the goal; eases out smoothly so the edge is barely visible.
    float k = clamp(length(q) / uLRange, 0.0, 1.0);
    float range = (1.0 - k) * (1.0 - k) * (1.0 - k);
    beam *= zone * range * shadowAt(L, p);
    float flash = (s == uWinSeat) ? uFlash : 0.0; // the scorer's spotlight flashes
    col += gc * (arc * 0.45 * (1.0 + flash * 3.0) + beam * BEAM_STRENGTH * (1.0 + flash * 7.0));
    col += vec3(flash * beam * 0.5);
  }

  // Outside the table: soft neon halo that fades into the dark.
  float halo = exp(-max(sd, 0.0) * 0.7) * HALO_GLOW;
  vec3 haloCol = edgeCol * halo;

  vec3 rgb = mix(haloCol, col, inside);
  float alpha = mix(halo, 0.84, inside);
  outColor = vec4(rgb, alpha);
}

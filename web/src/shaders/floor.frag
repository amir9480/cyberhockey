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
#define SPEC_STRENGTH 0.8  // metal floor's reflection of the goal force fields: lower = dimmer
#define SPEC_ROUGH 0.07    // blur of that reflection per unit of distance: higher = softer, wider
#define SHEEN 0.18         // wide, faint lobe around the sharp reflection
#define PLATE_TILT 0.035   // each hex plate is tilted a little, so reflections break up plate by plate

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
uniform vec2 uGF[MAX_N];     // goal force fields: base centre (on the walls' inner face)
uniform vec2 uGT[MAX_N];     // goal force fields: direction of their uv.x (as in buildGoalFields)
uniform float uFieldH;       // goal force field height

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

// Hexagonal tiling, cells 1 unit across the flats: xy = p relative to its cell's centre, zw = that centre.
vec4 hexCell(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(p, s) - s * 0.5;
  vec2 b = mod(p - s * 0.5, s) - s * 0.5;
  vec2 q = dot(a, a) < dot(b, b) ? a : b;
  return vec4(q, p - q);
}

// Distance from a point at `q` (relative to its cell's centre) to the cell's edge.
float hexEdge(vec2 q) {
  q = abs(q);
  return 0.5 - max(dot(q, vec2(0.5, 0.8660254)), q.x);
}

// Cheap hash without sin (precise on old GPUs): 0..1 per cell.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
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

  // Hex grid: one cell lookup per pixel, lines a pixel or so wide whatever the distance.
  vec4 hc = hexCell(p);
  float he = hexEdge(hc.xy);
  float hw = max(fwidth(he), 1e-4);
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
  // ...and under ripples from every hit: a soft band running outward that lights up only the hex lines it crosses
  // (brighter and a little thicker), strongest for goals.
  vec3 rip = vec3(0.0);
  for (int i = 0; i < MAX_RIP; i++) {
    vec4 r = uRip[i];
    float age = uTime - r.z;
    if (r.w <= 0.0 || age < 0.0 || age > RIPPLE_LIFE) continue;
    float w = 0.25 + age * 0.8;
    float dd = length(p - r.xy) - age * RIPPLE_SPEED;
    float fade = 1.0 - age / RIPPLE_LIFE;
    rip += uRipCol[i] * exp(-dd * dd / (w * w)) * fade * fade * r.w;
  }
  float ripI = min(max(rip.r, max(rip.g, rip.b)), 2.0);
  float hex = 1.0 - smoothstep(0.0, hw * (1.2 + ripI * 1.5), he);
  col += gridCol * hex * 0.07 * (1.0 + uWinAmt * 2.0 + lit * 5.0 + scan * 3.0);
  col += rip * hex * 2.0;

  // Now and then a few cells flicker on: a quick soft fill, brightest at the rim.
  if (uFx > 0.5) {
    float h = hash12(hc.zw);
    float f = fract(uTime * (0.05 + h * 0.07) + h * 7.0);
    float on = step(0.6, fract(h * 13.7)) * smoothstep(0.0, 0.015, f) * (1.0 - smoothstep(0.015, 0.06, f));
    col += gridCol * on * (0.025 + 0.06 * (1.0 - smoothstep(0.0, 0.18, he)));
  }
  col += winN * uWinAmt * 0.05 * exp(-dot(p, p) * 0.01);

  // Inner glow hugging the walls.
  col += edgeCol * exp(sd * 4.0) * WALL_GLOW;

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

  // Brushed metal plating: the view ray bounces off the floor (each hex plate slightly tilted, slightly rougher or
  // smoother) and is traced into the goal force fields below, which act as area lights.
  vec3 P = vec3(p.x, 0.0, p.y);
  vec3 V = normalize(cameraPosition - P);
  float plate = hash12(hc.zw);
  vec2 tilt = vec2(hash12(hc.zw + 17.3), hash12(hc.zw + 41.9)) - 0.5;
  vec3 N = normalize(vec3(tilt.x * PLATE_TILT, 1.0, tilt.y * PLATE_TILT));
  vec3 R = reflect(-V, N);
  float rough = SPEC_ROUGH * (0.7 + 0.6 * plate);
  float fres = 0.65 + 0.35 * pow(1.0 - max(dot(N, V), 0.0), 5.0); // metal: reflective even head on

  // Goals: crease arc + spotlight + reflected force field, tinted per seat.
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

    // Reflection of this goal's force field: the bounced ray meets the field's plane at (u, v) in the field's own uv,
    // where the field is drawn exactly as goal.frag draws it (same colour, scan lines, shimmer and fades). Roughness
    // times distance blurs it: the scan lines smear into their average, the edges soften.
    float toward = -dot(R.xz, n);
    float back = dot(p - uGF[s], n); // distance from the field's plane, inside the table
    if (toward > 1e-3 && back > 0.0) {
      float dist = back / toward;
      vec3 H = P + R * dist;
      float u = dot(H.xz - uGF[s], uGT[s]) / uGW + 0.5;
      float v = H.y / uFieldH;
      float bu = rough * dist / uGW + 1e-3; // blur, in field uv
      float bv = rough * dist / uFieldH + 1e-3;
      // goal.frag's field, with each term blurred by bu/bv.
      vec3 fc = mix(uGCol[s], uWinColor, uWinAmt);
      fc *= 0.6 / max(dot(fc, vec3(0.2126, 0.7152, 0.0722)), 0.1);
      float lines = pow(0.5 + 0.5 * sin(v * 38.0 - uTime * 5.0), 8.0);
      lines = mix(lines, 0.2, smoothstep(0.004, 0.03, bv)); // too blurred to resolve: their average
      float shimmer = 0.75 + 0.25 * sin(u * 23.0 + uTime * 3.0) * sin(u * 9.0 - uTime * 2.1);
      float near = uPuck.z * exp(-dot(uPuck.xy - uGC[s], uPuck.xy - uGC[s]) * 0.12);
      float vc = clamp(v, 0.0, 1.0);
      float fade = pow(1.0 - vc, 1.6)
        * smoothstep(-bu, 0.06 + bu, u) * (1.0 - smoothstep(0.94 - bu, 1.0 + bu, u))
        * smoothstep(-bv, bv, v);
      float field = (0.12 + lines * 0.35 * shimmer + near * 0.6 + uKick * 0.3) * fade;
      // Wide faint sheen around it, so rough plates still catch some of the field's light.
      float wu = bu * 6.0 + 0.1;
      float wv = bv * 6.0 + 0.1;
      float sheen = smoothstep(-wu, wu, u) * (1.0 - smoothstep(1.0 - wu, 1.0 + wu, u)) * smoothstep(-wv, wv, v) * exp(-max(v, 0.0) * 2.0);
      float glint = (field + sheen * SHEEN * (0.2 + near * 0.6 + uKick * 0.3)) * fres / (1.0 + dist * 0.12);
      col += fc * glint * SPEC_STRENGTH * (1.0 + flash * 3.0);
    }
  }

  // Outside the table: soft neon halo that fades into the dark.
  float halo = exp(-max(sd, 0.0) * 2.5) * HALO_GLOW;
  vec3 haloCol = edgeCol * halo;

  vec3 rgb = mix(haloCol, col, inside);
  float alpha = mix(halo, 0.84, inside);
  outColor = vec4(rgb, alpha);
}

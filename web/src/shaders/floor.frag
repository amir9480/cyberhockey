precision highp float;
#define MAX_N 4
#define MAX_OCC 8
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
  col += mix(neon(uTime * 0.035), winN, uWinAmt) * grid * 0.07 * (1.0 + uWinAmt * 2.0);
  col += winN * uWinAmt * 0.05 * exp(-dot(p, p) * 0.01);

  // Inner glow hugging the walls.
  col += edgeCol * exp(sd * 1.6) * WALL_GLOW;

  // Center markings.
  vec3 mark = mix(neon(uTime * 0.035 + 0.5), winN, uWinAmt);
  float ring = lineMask(abs(length(p) - uCenterR), 0.05, aa * 1.5);
  float dotc = lineMask(length(p), 0.18, aa * 1.5);
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
    float arc = lineMask(abs(length(q) - uCreaseR), 0.04, aa * 1.5) * step(0.0, depth);

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

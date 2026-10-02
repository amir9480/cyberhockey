precision highp float;
#define FLOOR_Y -9.0     // the far grid lies this far below the table
#define CELL 3.0         // grid spacing, world units
#define GRID_GLOW 0.11
uniform float uTime;
uniform vec3 uWinColor;
uniform float uWinAmt;
in vec3 vDir;
out vec4 outColor;

//NEON

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec3 d = normalize(vDir);
  vec3 col = vec3(0.0016, 0.0009, 0.0032) + vec3(0.006, 0.002, 0.012) * (1.0 - abs(d.y));
  vec3 tint = mix(neon(uTime * 0.02 + 0.6), uWinColor, uWinAmt * 0.6);

  // A vast grid far beneath the table, fading into the dark, with slow pulses running outward.
  if (d.y < -0.02) {
    float t = (FLOOR_Y - cameraPosition.y) / d.y;
    vec2 p = cameraPosition.xz + d.xz * t;
    vec2 g = p / CELL;
    vec2 gw = fwidth(g);
    vec2 gl = abs(fract(g - 0.5) - 0.5) / max(gw, vec2(1e-4));
    float line = 1.0 - min(min(gl.x, gl.y), 1.0);
    line *= 1.0 - smoothstep(0.15, 0.6, max(gw.x, gw.y)); // too dense to resolve: fade instead of shimmering
    float r = length(p);
    float pulse = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(r * 0.18 - uTime * 1.2), 6.0);
    col += tint * line * GRID_GLOW * pulse * exp(-t * 0.018);
  }

  // Glow along the horizon (seen at low camera angles).
  col += tint * exp(-abs(d.y + 0.03) * 14.0) * 0.05;

  // Drifting dust motes.
  vec2 uv = d.xz / (1.0 + abs(d.y)) * 60.0 + vec2(uTime * 0.25, uTime * 0.1);
  vec2 cell = floor(uv);
  float h = hash(cell);
  if (h > 0.93) {
    vec2 c = vec2(hash(cell + 7.1), hash(cell + 3.7)) * 0.6 + 0.2;
    float dist = length(fract(uv) - c);
    float twinkle = 0.5 + 0.5 * sin(uTime * (1.0 + h * 3.0) + h * 40.0);
    col += tint * (1.0 - smoothstep(0.0, 0.08, dist)) * twinkle * 0.35;
  }

  outColor = vec4(col, 1.0);
}

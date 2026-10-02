precision highp float;
uniform vec3 uColor;
uniform vec3 uWinColor;
uniform float uWinAmt;
uniform vec3 uLoseColor;
uniform float uLoseAmt;
uniform int uLoseSeat;
uniform int uSeat;
uniform float uFlash;   // this display's own flash pulse
uniform int uTens;      // 0..9
uniform int uOnes;      // 0..9
uniform int uShowTens;  // 0 = tens digit has every segment off (score < 10)
in vec2 vUv;
out vec4 outColor;

#define CELL_W 0.6
#define PITCH 0.74
#define WIDTH 1.34   // two cells, height is 1.0
#define PAD 0.3

// Segment bits: a=1 b=2 c=4 d=8 e=16 f=32 g=64.
const int DIGITS[10] = int[10](0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F);

const float HT = 0.05; // half thickness

// Hexagonal bar with pointed ends; negative inside.
float bar(vec2 q, vec2 c, float hl, bool horizontal) {
  vec2 d = abs(q - c);
  if (!horizontal) d = d.yx;
  return max(d.y - HT, d.x + d.y - hl);
}

// Signed distance to segment `i` (0..6 = a..g) of a digit cell.
float seg(vec2 q, int i) {
  if (i == 0) return bar(q, vec2(0.30, 0.94), 0.20, true);
  if (i == 1) return bar(q, vec2(0.54, 0.72), 0.17, false);
  if (i == 2) return bar(q, vec2(0.54, 0.28), 0.17, false);
  if (i == 3) return bar(q, vec2(0.30, 0.06), 0.20, true);
  if (i == 4) return bar(q, vec2(0.06, 0.28), 0.17, false);
  if (i == 5) return bar(q, vec2(0.06, 0.72), 0.17, false);
  return bar(q, vec2(0.30, 0.50), 0.20, true);
}

vec3 digit(vec2 q, int mask, float aa) {
  vec3 color = mix(uColor, uWinColor, uWinAmt);
  if (uSeat == uLoseSeat) color = mix(uColor, uLoseColor, uLoseAmt); // local player lost: red
  float on = 0.0;
  float halo = 0.0;
  float off = 0.0;
  for (int i = 0; i < 7; i++) {
    float d = seg(q, i);
    float shape = 1.0 - smoothstep(-aa, aa, d);
    if (((mask >> i) & 1) == 1) {
      on = max(on, shape);
      halo = max(halo, exp(-max(d, 0.0) * 22.0));
    } else {
      off = max(off, shape);
    }
  }
  vec3 hot = mix(color, vec3(1.0), 0.45 + 0.4 * uFlash);
  return hot * on * 0.9 * (1.0 + uFlash * 3.0) + color * halo * 0.45 * (1.0 + uFlash * 2.0) * (1.0 - on * 0.5) + color * off * 0.05;
}

void main() {
  // Quad covers the two digits plus PAD on every side so the glow isn't clipped.
  vec2 p = vUv * vec2(WIDTH + 2.0 * PAD, 1.0 + 2.0 * PAD) - PAD;
  float aa = max(fwidth(p.y), 1e-4);

  vec3 c = digit(p - vec2(PITCH, 0.0), DIGITS[uOnes], aa);
  c += digit(p, uShowTens == 1 ? DIGITS[uTens] : 0, aa);
  outColor = vec4(c, 1.0);
}

precision highp float;
#define RAIL_BRIGHTNESS 0.5 // wall neon brightness: lower = dimmer
#define RAIL_SATURATION 0.75 // 1 = the raw neon cycle, lower = softer, closer to white (like the player palette)
#define RAIL_BLOOM 0.35// share of the rails' light that blooms (alpha is the bloom mask, see View)
uniform float uTime;
uniform float uMirror;
uniform vec3 uWinColor;
uniform float uWinAmt;
in float vLen;
in float vH;
in float vY;
in vec2 vXZ;
out vec4 outColor;

//NEON

void main() {
  // Colour and a soft highlight both travel slowly around the table.
  float ang = atan(vXZ.y, vXZ.x);
  vec3 col = neon(uTime * 0.035 + ang / 6.2831853);
  col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, RAIL_SATURATION); // soften the harsh neon
  col *= RAIL_BRIGHTNESS / max(dot(col, vec3(0.2126, 0.7152, 0.0722)), 0.1); // even brightness for every hue
  vec3 win = uWinColor * (RAIL_BRIGHTNESS / max(dot(uWinColor, vec3(0.2126, 0.7152, 0.0722)), 0.1));
  col = mix(col, win, uWinAmt);
  float band = 0.5 + 0.5 * cos(ang - uTime * 0.35);
  float pulse = 0.55 + 0.45 * band * band; // never fully dark
  float glow = pow(vH, 5.0);
  vec3 c = col * (0.04 + glow * pulse);
  if (uMirror > 0.5) c *= 0.35 * exp(vY * 0.9); // fade reflection with depth (vY < 0)
  outColor = vec4(c, RAIL_BLOOM);
}

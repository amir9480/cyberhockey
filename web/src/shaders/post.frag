// Final pass (three adds the colour-space functions): linear -> sRGB, plus vignette and grain (medium) and chromatic aberration and scanlines (high).
uniform sampler2D tDiffuse;
uniform float uTime;
uniform float uFx;
uniform float uKick;
uniform vec2 uShake;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = vUv + uShake;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  vec3 col;
  if (uFx > 1.5) {
    // Colour fringes toward the edges; a hit kicks them wider.
    vec2 off = c * r2 * (0.02 + uKick * 0.06);
    col.r = texture2D(tDiffuse, uv + off).r;
    col.g = texture2D(tDiffuse, uv).g;
    col.b = texture2D(tDiffuse, uv - off).b;
  } else {
    col = texture2D(tDiffuse, uv).rgb;
  }
  col *= 1.0 - smoothstep(0.12, 0.6, r2) * 0.5; // vignette
  vec4 outc = sRGBTransferOETF(vec4(col, 1.0));
  if (uFx > 1.5) outc.rgb *= 0.95 + 0.05 * sin(gl_FragCoord.y * 2.1); // fine scanlines
  outc.rgb += (hash(gl_FragCoord.xy + fract(uTime * 7.0) * 100.0) - 0.5) * 0.025; // grain
  gl_FragColor = outc;
}

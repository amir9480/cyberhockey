precision highp float;
uniform vec3 uColor;
uniform float uMirror;
uniform float uTime;
in vec3 vN;
in vec3 vV;
in vec3 vLocal;
in float vY;
out vec4 outColor;

void main() {
  vec3 col = uColor * (0.85 / max(dot(uColor, vec3(0.2126, 0.7152, 0.0722)), 0.1)); // even brightness
  vec3 n = normalize(vN);
  float rim = pow(1.0 - abs(dot(n, normalize(vV))), 2.0);
  float top = smoothstep(0.55, 0.9, abs(n.y));
  float side = 1.0 - top;
  float rr = length(vLocal.xz);
  float ring = (1.0 - smoothstep(0.0, 0.04, abs(rr - 0.34))) * top;
  float ang = atan(vLocal.z, vLocal.x);
  float ticks = step(0.7, fract(ang / 6.2831853 * 3.0 - uTime * 0.8)) * (1.0 - smoothstep(0.0, 0.03, abs(rr - 0.44))) * top;
  float scan = 0.8 + 0.2 * sin(vY * 90.0 - uTime * 6.0);
  vec3 hot = mix(col, vec3(1.0), 0.45);
  vec3 c = vec3(0.02) + col * (0.18 + rim * 0.5) + hot * (side * 0.75 * scan + ring * 0.9 + ticks * 0.8);
  if (uMirror > 0.5) c *= 0.35 * exp(vY * 0.9);
  outColor = vec4(c, 1.0);
}

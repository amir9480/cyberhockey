precision highp float;
in vec3 vColor;
in float vFade;
out vec4 outColor;

void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = dot(q, q);
  if (d > 1.0) discard;
  float core = exp(-d * 4.0);
  outColor = vec4(vColor * core * vFade * 2.2, 1.0);
}

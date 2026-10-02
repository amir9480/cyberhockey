// Cyberpunk palette: smooth loop through cyan -> blue -> violet -> magenta -> hot pink.
vec3 neon(float t) {
  const vec3 stops[5] = vec3[5](
    vec3(0.00, 0.85, 1.00),
    vec3(0.12, 0.28, 1.00),
    vec3(0.55, 0.12, 1.00),
    vec3(1.00, 0.08, 0.72),
    vec3(1.00, 0.22, 0.38)
  );
  float x = fract(t) * 5.0;
  int i = int(x);
  float f = smoothstep(0.0, 1.0, fract(x));
  return mix(stops[i], stops[(i + 1) % 5], f);
}

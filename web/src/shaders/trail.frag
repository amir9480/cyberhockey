precision highp float;
uniform vec3 uColor;
uniform float uStrength; // 0 when the ball is slow, so a resting ball has no tail
in float vAge;
in float vSide;
out vec4 outColor;

#define TAIL_OPACITY 0.08 // peak opacity of the tail: lower = more subtle

void main() {
  vec3 col = uColor * (0.85 / max(dot(uColor, vec3(0.2126, 0.7152, 0.0722)), 0.1)); // even brightness
  float along = pow(1.0 - vAge, 2.5); // dies off fast, so only a short wisp is visible
  float across = pow(1.0 - vSide * vSide, 1.5); // soft edges, brightest along the centre line
  outColor = vec4(col, along * across * TAIL_OPACITY * uStrength);
}

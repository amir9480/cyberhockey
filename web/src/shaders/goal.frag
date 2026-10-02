precision highp float;
uniform float uTime;
uniform vec3 uWinColor;
uniform float uWinAmt;
uniform float uKick;
uniform vec3 uPuck; // xy position, z 1 when shown
in vec2 vUv;        // x across the goal mouth, y up
in vec3 vColor;
in vec2 vGoal;
out vec4 outColor;

// Force-field curtain across a goal mouth: rising scan lines, brighter when the puck is near.
void main() {
  vec3 base = mix(vColor, uWinColor, uWinAmt);
  base *= 0.6 / max(dot(base, vec3(0.2126, 0.7152, 0.0722)), 0.1);
  float lines = pow(0.5 + 0.5 * sin(vUv.y * 38.0 - uTime * 5.0), 8.0);
  float shimmer = 0.75 + 0.25 * sin(vUv.x * 23.0 + uTime * 3.0) * sin(vUv.x * 9.0 - uTime * 2.1);
  float near = uPuck.z * exp(-dot(uPuck.xy - vGoal, uPuck.xy - vGoal) * 0.12);
  float fade = pow(1.0 - vUv.y, 1.6) * smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
  float a = (0.12 + lines * 0.35 * shimmer + near * 0.6 + uKick * 0.3) * fade;
  outColor = vec4(base * a, 1.0);
}

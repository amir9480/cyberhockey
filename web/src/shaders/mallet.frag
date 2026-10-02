precision highp float;
uniform float uMirror;
uniform vec3 uColor;
uniform vec3 uWinColor;
uniform float uWinAmt;
uniform vec3 uLoseColor;
uniform float uLoseAmt;
uniform int uLoseSeat;
uniform int uSeat;
in vec3 vN;
in vec3 vV;
in vec3 vLocal;
in float vY;
out vec4 outColor;

void main() {
  vec3 base = mix(uColor, uWinColor, uWinAmt);
  if (uSeat == uLoseSeat) base = mix(uColor, uLoseColor, uLoseAmt); // local player lost: red
  vec3 col = base * (0.7 / max(dot(base, vec3(0.2126, 0.7152, 0.0722)), 0.1)); // even brightness

  vec3 n = normalize(vN);
  float rim = pow(1.0 - abs(dot(n, normalize(vV))), 2.2);
  float rr = length(vLocal.xz);
  float top = smoothstep(0.55, 0.9, abs(n.y)); // faces pointing up/down
  float ring = (1.0 - smoothstep(0.0, 0.05, abs(rr - 0.56))) * top;
  float knob = smoothstep(0.36, 0.3, rr) * top; // handle cap

  vec3 body = vec3(0.025, 0.02, 0.05) + col * 0.05;
  vec3 c = body + col * (rim * 0.75 + ring * 0.9 + knob * 0.2 + 0.1);
  if (uMirror > 0.5) c *= 0.35 * exp(vY * 0.9);
  outColor = vec4(c, 1.0);
}

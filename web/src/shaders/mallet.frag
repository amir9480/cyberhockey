precision highp float;
uniform float uMirror;
uniform vec3 uColor;
uniform vec3 uWinColor;
uniform float uWinAmt;
uniform vec3 uLoseColor;
uniform float uLoseAmt;
uniform int uLoseSeat;
uniform int uSeat;
uniform float uTime;
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

  // Hologram touches: a dashed ring turning on the top face, scan lines rising up the sides, a cool fringe on the rim.
  float ang = atan(vLocal.z, vLocal.x);
  float dash = step(0.45, fract(ang / 6.2831853 * 16.0 + uTime * 0.5));
  float ring2 = (1.0 - smoothstep(0.0, 0.025, abs(rr - 0.66))) * top * dash;
  float scan = 0.8 + 0.2 * sin(vY * 70.0 - uTime * 5.0);
  vec3 fringe = mix(col, vec3(0.7, 0.95, 1.0), 0.6) * pow(rim, 4.0) * 0.3;

  vec3 body = vec3(0.025, 0.02, 0.05) + col * 0.05;
  vec3 c = body + col * (rim * 0.75 * scan + ring * 0.9 + ring2 * 0.7 + knob * 0.2 + 0.1) + fringe;
  if (uMirror > 0.5) c *= 0.35 * exp(vY * 0.9);
  outColor = vec4(c, 0.0); // alpha 0: kept out of bloom (see View)
}

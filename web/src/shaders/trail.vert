in float aAge;   // 0 at the ball, 1 at the end of the tail
in float aSide;  // -1 / +1 across the ribbon
out float vAge;
out float vSide;

void main() {
  vAge = aAge;
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}

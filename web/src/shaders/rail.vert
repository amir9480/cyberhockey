in float aLen;
in float aH;
uniform float uMirror;
out float vLen;
out float vH;
out float vY;
out vec2 vXZ;

void main() {
  vLen = aLen;
  vH = aH;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vY = world.y;
  vXZ = world.xz;
  gl_Position = projectionMatrix * viewMatrix * world;
}

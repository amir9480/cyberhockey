out vec2 vP;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vP = world.xz;
  gl_Position = projectionMatrix * viewMatrix * world;
}

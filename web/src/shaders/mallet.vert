out vec3 vN;
out vec3 vV;
out vec3 vLocal;
out float vY;

void main() {
  vLocal = position;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vY = world.y;
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - world.xyz);
  gl_Position = projectionMatrix * viewMatrix * world;
}

in vec3 aColor;
in vec2 aGoal; // goal center
out vec2 vUv;
out vec3 vColor;
out vec2 vGoal;

void main() {
  vUv = uv;
  vColor = aColor;
  vGoal = aGoal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}

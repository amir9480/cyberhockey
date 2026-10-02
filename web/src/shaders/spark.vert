in vec3 aVel;
in float aBirth;
in vec3 aColor;
uniform float uTime;
uniform float uPx; // pixels per world unit at distance 1
out vec3 vColor;
out float vFade;

#define LIFE 0.5   // seconds; CyberFx uses the same value
#define DRAG 2.5   // 1/s
#define GRAVITY 14.0
#define SIZE 0.17  // world units

void main() {
  float age = uTime - aBirth;
  if (age < 0.0 || age > LIFE) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off screen
    gl_PointSize = 0.0;
    return;
  }
  // Exponential drag on the floor plane, a hop up that falls back to the floor.
  float travel = (1.0 - exp(-DRAG * age)) / DRAG;
  vec3 p = position + vec3(aVel.x * travel, 0.0, aVel.z * travel);
  p.y = max(0.02, position.y + aVel.y * age - 0.5 * GRAVITY * age * age);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float life = age / LIFE;
  vFade = (1.0 - life) * (1.0 - life);
  vColor = aColor;
  gl_PointSize = SIZE * (1.0 - 0.5 * life) * uPx / -mv.z;
  gl_Position = projectionMatrix * mv;
}

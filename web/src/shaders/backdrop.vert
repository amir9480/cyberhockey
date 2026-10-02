uniform mat4 uInvVP; // inverse of projection * view
out vec3 vDir;

// One full-screen triangle at the far plane; the world ray through each pixel is interpolated.
void main() {
  vec4 far = uInvVP * vec4(position.xy, 1.0, 1.0);
  vDir = far.xyz / far.w - cameraPosition;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}

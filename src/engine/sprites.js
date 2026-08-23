// Instanced additive/premultiplied quad batch. One draw call per flush.
import { compile, buffer, GLSL_COMMON } from './gl.js';
import { SPRITE_GAMMA } from './textures.js';

const FLOATS = 10; // pos2 size2 rot1 color4 layer1

const VS = `
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aSize;
layout(location=2) in float aRot;
layout(location=3) in vec4 aColor;
layout(location=4) in float aLayer;

uniform vec2 uCamPos;
uniform vec2 uCamScale;   // world units -> clip
uniform float uCamRot;

out vec2 vUv;
out vec4 vColor;
out float vLayer;

void main(){
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vUv = c;
  vec2 o = (c - 0.5) * aSize;
  float cs = cos(aRot), sn = sin(aRot);
  o = vec2(o.x * cs - o.y * sn, o.x * sn + o.y * cs);

  vec2 w = aPos + o - uCamPos;
  float cc = cos(uCamRot), ss = sin(uCamRot);
  w = vec2(w.x * cc - w.y * ss, w.x * ss + w.y * cc);

  vColor = aColor;
  vLayer = aLayer;
  gl_Position = vec4(w * uCamScale, 0.0, 1.0);
}`;

const FS = `
${GLSL_COMMON}
uniform highp sampler2DArray uAtlas;
uniform float uGamma;
uniform float uDebugLayers;   // >0: false-colour every quad by its atlas layer

in vec2 vUv;
in vec4 vColor;
in float vLayer;
out vec4 outColor;

void main(){
  float m = texture(uAtlas, vec3(vUv, vLayer)).a;
  m = pow(m, uGamma);
  float a = m * vColor.a;
  vec3 c = vColor.rgb;
  if (uDebugLayers > 0.5) {
    // Decorrelated hue per layer, so an artefact's colour names its layer.
    float h = fract(vLayer * 0.14758);
    c = 3.0 * (0.5 + 0.5 * cos(6.28318530718 * (h + vec3(0.0, 0.33, 0.67))));
  }
  outColor = vec4(c * a, a);
}`;

/**
 * Debug switches, driven by query params in main.js. `layers` false-colours
 * every quad by its atlas layer so an artefact's colour names its source;
 * `off` skips the whole pass, which is how you find out whether an artefact
 * is a sprite at all.
 */
export const SpriteDebug = { layers: false, off: false };

export class SpriteBatch {
  constructor(gl, atlas, capacity = 4096) {
    this.gl = gl; this.atlas = atlas; this.cap = capacity; this.n = 0;
    this.data = new Float32Array(capacity * FLOATS);
    this.prog = compile(gl, VS, FS, 'sprites');
    this.vbo = buffer(gl, this.data.byteLength, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const S = FLOATS * 4;
    const at = (loc, size, off) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, S, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    };
    at(0, 2, 0); at(1, 2, 2); at(2, 1, 4); at(3, 4, 5); at(4, 1, 9);
    gl.bindVertexArray(null);
  }

  reset() { this.n = 0; return this; }

  /** Queue one quad. Colour rgb is HDR (values > 1 are welcome). */
  push(x, y, w, h, rot, r, g, b, a, layer) {
    if (this.n >= this.cap) this.grow();
    const d = this.data, i = this.n * FLOATS;
    d[i] = x; d[i + 1] = y; d[i + 2] = w; d[i + 3] = h; d[i + 4] = rot;
    d[i + 5] = r; d[i + 6] = g; d[i + 7] = b; d[i + 8] = a; d[i + 9] = layer;
    this.n++;
  }

  /** Convenience: uniform square sprite from a [r,g,b] triple. */
  puts(x, y, size, col, alpha, layer, rot = 0) {
    this.push(x, y, size, size, rot, col[0], col[1], col[2], alpha, layer);
  }

  grow() {
    const gl = this.gl;
    this.cap *= 2;
    const nd = new Float32Array(this.cap * FLOATS);
    nd.set(this.data); this.data = nd;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, nd.byteLength, gl.DYNAMIC_DRAW);
  }

  flush(cam) {
    if (this.n === 0) return 0;
    if (SpriteDebug.off) { const n = this.n; this.n = 0; return n; }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.n * FLOATS);
    gl.useProgram(this.prog.program);
    gl.uniform2f(this.prog.u.uCamPos, cam.x, cam.y);
    gl.uniform2f(this.prog.u.uCamScale, cam.sx, cam.sy);
    gl.uniform1f(this.prog.u.uCamRot, cam.rot || 0);
    gl.uniform1f(this.prog.u.uGamma, SPRITE_GAMMA);
    gl.uniform1f(this.prog.u.uDebugLayers, SpriteDebug.layers ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas);
    gl.uniform1i(this.prog.u.uAtlas, 0);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
    gl.bindVertexArray(null);
    const drawn = this.n;
    this.n = 0;
    return drawn;
  }
}

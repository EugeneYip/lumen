// Glowing polyline / ribbon renderer. CPU-expanded triangles, one draw call.
// The v coordinate runs -1..1 across the ribbon; the fragment shader turns that
// into a gaussian cross-section, so a 1px logical line still reads as light.
import { compile, buffer, GLSL_COMMON } from './gl.js';

const FLOATS = 8; // pos2 v1 color4 falloff1

const VS = `
layout(location=0) in vec2 aPos;
layout(location=1) in float aV;
layout(location=2) in vec4 aColor;
layout(location=3) in float aFalloff;

uniform vec2 uCamPos;
uniform vec2 uCamScale;
uniform float uCamRot;

out float vV;
out vec4 vColor;
out float vFalloff;

void main(){
  vec2 w = aPos - uCamPos;
  float cc = cos(uCamRot), ss = sin(uCamRot);
  w = vec2(w.x * cc - w.y * ss, w.x * ss + w.y * cc);
  vV = aV; vColor = aColor; vFalloff = aFalloff;
  gl_Position = vec4(w * uCamScale, 0.0, 1.0);
}`;

const FS = `
${GLSL_COMMON}
in float vV;
in vec4 vColor;
in float vFalloff;
out vec4 outColor;

void main(){
  float x = clamp(abs(vV), 0.0, 1.0);
  // core + halo cross-section: sharp filament inside a soft sheath
  float core = exp(-x * x * vFalloff);
  float halo = pow(max(0.0, 1.0 - x), 2.5) * 0.30;
  float m = min(1.0, core + halo);
  float a = m * vColor.a;
  outColor = vec4(vColor.rgb * a, a);
}`;

export class Ribbons {
  constructor(gl, capacityVerts = 24576) {
    this.gl = gl; this.cap = capacityVerts; this.n = 0;
    this.data = new Float32Array(capacityVerts * FLOATS);
    this.prog = compile(gl, VS, FS, 'ribbons');
    this.vbo = buffer(gl, this.data.byteLength, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const S = FLOATS * 4;
    const at = (loc, size, off) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, S, off * 4);
    };
    at(0, 2, 0); at(1, 1, 2); at(2, 4, 3); at(3, 1, 7);
    gl.bindVertexArray(null);
    this._nx = new Float32Array(512);
    this._ny = new Float32Array(512);
  }

  reset() { this.n = 0; return this; }

  _vert(x, y, v, r, g, b, a, f) {
    if (this.n >= this.cap) this.grow();
    const d = this.data, i = this.n * FLOATS;
    d[i] = x; d[i + 1] = y; d[i + 2] = v;
    d[i + 3] = r; d[i + 4] = g; d[i + 5] = b; d[i + 6] = a; d[i + 7] = f;
    this.n++;
  }

  grow() {
    const gl = this.gl;
    this.cap *= 2;
    const nd = new Float32Array(this.cap * FLOATS);
    nd.set(this.data); this.data = nd;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, nd.byteLength, gl.DYNAMIC_DRAW);
  }

  /**
   * Stroke a polyline.
   * @param pts flat [x0,y0,x1,y1,...]
   * @param opts.width      full width in world units (or a fn(t) => width)
   * @param opts.color      [r,g,b]
   * @param opts.alpha      number or fn(t) => alpha
   * @param opts.falloff    gaussian tightness of the core (higher = thinner filament)
   */
  stroke(pts, { width = 4, color = [1, 1, 1], alpha = 1, falloff = 9 } = {}) {
    const count = pts.length >> 1;
    if (count < 2) return;
    const wf = typeof width === 'function' ? width : () => width;
    const af = typeof alpha === 'function' ? alpha : () => alpha;
    let nx = this._nx, ny = this._ny;
    if (nx.length < count) { nx = this._nx = new Float32Array(count * 2); ny = this._ny = new Float32Array(count * 2); }

    // per-vertex normals (averaged, miter-limited)
    for (let i = 0; i < count; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(count - 1, i + 1);
      let dx = pts[i1 * 2] - pts[i0 * 2], dy = pts[i1 * 2 + 1] - pts[i0 * 2 + 1];
      const L = Math.hypot(dx, dy) || 1;
      dx /= L; dy /= L;
      nx[i] = -dy; ny[i] = dx;
    }

    const r = color[0], g = color[1], b = color[2];
    for (let i = 0; i < count - 1; i++) {
      const t0 = i / (count - 1), t1 = (i + 1) / (count - 1);
      const h0 = wf(t0) * 0.5, h1 = wf(t1) * 0.5;
      const a0 = af(t0), a1 = af(t1);
      const x0 = pts[i * 2], y0 = pts[i * 2 + 1], x1 = pts[i * 2 + 2], y1 = pts[i * 2 + 3];
      const ax = x0 - nx[i] * h0, ay = y0 - ny[i] * h0;
      const bx = x0 + nx[i] * h0, by = y0 + ny[i] * h0;
      const cx = x1 - nx[i + 1] * h1, cy = y1 - ny[i + 1] * h1;
      const dx2 = x1 + nx[i + 1] * h1, dy2 = y1 + ny[i + 1] * h1;
      this._vert(ax, ay, -1, r, g, b, a0, falloff);
      this._vert(bx, by, 1, r, g, b, a0, falloff);
      this._vert(cx, cy, -1, r, g, b, a1, falloff);
      this._vert(bx, by, 1, r, g, b, a0, falloff);
      this._vert(dx2, dy2, 1, r, g, b, a1, falloff);
      this._vert(cx, cy, -1, r, g, b, a1, falloff);
    }
  }

  /** Single straight segment - the common case, skips normal averaging. */
  segment(x0, y0, x1, y1, width, color, alpha = 1, falloff = 9) {
    let dx = x1 - x0, dy = y1 - y0;
    const L = Math.hypot(dx, dy) || 1;
    const nxv = -dy / L * width * 0.5, nyv = dx / L * width * 0.5;
    const r = color[0], g = color[1], b = color[2];
    this._vert(x0 - nxv, y0 - nyv, -1, r, g, b, alpha, falloff);
    this._vert(x0 + nxv, y0 + nyv, 1, r, g, b, alpha, falloff);
    this._vert(x1 - nxv, y1 - nyv, -1, r, g, b, alpha, falloff);
    this._vert(x0 + nxv, y0 + nyv, 1, r, g, b, alpha, falloff);
    this._vert(x1 + nxv, y1 + nyv, 1, r, g, b, alpha, falloff);
    this._vert(x1 - nxv, y1 - nyv, -1, r, g, b, alpha, falloff);
  }

  flush(cam) {
    if (this.n === 0) return 0;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.n * FLOATS);
    gl.useProgram(this.prog.program);
    gl.uniform2f(this.prog.u.uCamPos, cam.x, cam.y);
    gl.uniform2f(this.prog.u.uCamScale, cam.sx, cam.sy);
    gl.uniform1f(this.prog.u.uCamRot, cam.rot || 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.n);
    gl.bindVertexArray(null);
    const drawn = this.n;
    this.n = 0;
    return drawn / 6;
  }
}

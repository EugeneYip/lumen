// WebGL2 helper layer. Thin, explicit, no magic.

export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false,
    powerPreference: 'high-performance', desynchronized: false,
  });
  if (!gl) throw new Error('WebGL2 unavailable');
  const caps = {
    colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
    floatBlend: !!gl.getExtension('EXT_float_blend'),
    texFloatLinear: !!gl.getExtension('OES_texture_float_linear'),
    maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    renderer: (() => { const e = gl.getExtension('WEBGL_debug_renderer_info');
      return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; })(),
  };
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  return { gl, caps };
}

const HEADER = `#version 300 es
precision highp float;
precision highp int;
`;

export function compile(gl, vsSrc, fsSrc, name = 'shader') {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, HEADER + src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      const numbered = (HEADER + src).split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
      throw new Error(`[${name}] ${type === gl.VERTEX_SHADER ? 'VS' : 'FS'} compile failed:\n${log}\n${numbered}`);
    }
    return s;
  };
  const p = gl.createProgram();
  const vs = mk(gl.VERTEX_SHADER, vsSrc), fs = mk(gl.FRAGMENT_SHADER, fsSrc);
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`[${name}] link failed: ${gl.getProgramInfoLog(p)}`);
  gl.deleteShader(vs); gl.deleteShader(fs);

  // Reflect uniforms + attributes so call sites stay terse.
  const uniforms = {}, attribs = {};
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) { const u = gl.getActiveUniform(p, i);
    uniforms[u.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, u.name); }
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) { const a = gl.getActiveAttrib(p, i); attribs[a.name] = gl.getAttribLocation(p, a.name); }
  return { program: p, u: uniforms, a: attribs, name };
}

/** Set uniforms from a plain object. Arrays -> vecN, numbers -> float, {tex,unit} -> sampler. */
export function setUniforms(gl, prog, vals) {
  for (const k in vals) {
    const loc = prog.u[k];
    if (loc == null) continue;
    const v = vals[k];
    if (typeof v === 'number') gl.uniform1f(loc, v);
    else if (typeof v === 'boolean') gl.uniform1i(loc, v ? 1 : 0);
    else if (Array.isArray(v) || v instanceof Float32Array) {
      if (v.length === 2) gl.uniform2fv(loc, v); else if (v.length === 3) gl.uniform3fv(loc, v);
      else if (v.length === 4) gl.uniform4fv(loc, v); else if (v.length === 9) gl.uniformMatrix3fv(loc, false, v);
      else if (v.length === 16) gl.uniformMatrix4fv(loc, false, v); else gl.uniform1fv(loc, v);
    }
  }
}

// ---------- buffers ----------
export function buffer(gl, data, target = gl.ARRAY_BUFFER, usage = gl.STATIC_DRAW) {
  const b = gl.createBuffer(); gl.bindBuffer(target, b);
  if (typeof data === 'number') gl.bufferData(target, data, usage); else gl.bufferData(target, data, usage);
  return b;
}

/** Full-screen pass geometry: one oversized triangle, no VBO needed (gl_VertexID). */
export const FS_VS = `
out vec2 vUv;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export function drawFullscreen(gl) { gl.drawArrays(gl.TRIANGLES, 0, 3); }

// ---------- textures ----------
export function texture2D(gl, {
  width, height, data = null, internalFormat = gl.RGBA8, format = gl.RGBA, type = gl.UNSIGNED_BYTE,
  filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE, mips = false,
} = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (mips) gl.generateMipmap(gl.TEXTURE_2D);
  return t;
}

export function textureArray(gl, { width, height, layers, filter = gl.LINEAR, mips = true } = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
  const levels = mips ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, width, height, layers);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export function uploadLayer(gl, tex, layer, width, height, data) {
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, width, height, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
}

export function bindTex(gl, unit, tex, target) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(target || gl.TEXTURE_2D, tex);
}

// ---------- render targets ----------
export class RenderTarget {
  constructor(gl, w, h, { float = true, filter = null } = {}) {
    this.gl = gl; this.float = float;
    this.filter = filter ?? gl.LINEAR;
    this.fbo = gl.createFramebuffer();
    this.tex = null;
    this.resize(w, h);
  }
  resize(w, h) {
    const gl = this.gl;
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    if (this.w === w && this.h === h) return this;
    this.w = w; this.h = h;
    if (this.tex) gl.deleteTexture(this.tex);
    this.tex = texture2D(gl, {
      width: w, height: h,
      internalFormat: this.float ? gl.RGBA16F : gl.RGBA8,
      type: this.float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      filter: this.filter,
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this;
  }
  bind(clear = false) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.w, this.h);
    if (clear) { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    return this;
  }
  dispose() { this.gl.deleteFramebuffer(this.fbo); this.gl.deleteTexture(this.tex); }
}

// ---------- blend presets ----------
export const Blend = {
  none(gl) { gl.disable(gl.BLEND); },
  add(gl) { gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE); },
  premul(gl) { gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); },
  alpha(gl) { gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); },
};

// ---------- shared GLSL ----------
export const GLSL_COMMON = `
#define TAU 6.28318530718
#define PI  3.14159265359
float sat(float x){ return clamp(x,0.0,1.0); }
vec2  sat2(vec2 x){ return clamp(x,0.0,1.0); }
float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec2  hash22(vec2 p){ vec3 p3=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
  p3+=dot(p3,p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
vec3  hash33(vec3 p3){ p3=fract(p3*vec3(0.1031,0.1030,0.0973));
  p3+=dot(p3,p3.yxz+33.33); return fract((p3.xxy+p3.yxx)*p3.zyx); }
float vnoise(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float a=hash12(i), b=hash12(i+vec2(1,0)), c=hash12(i+vec2(0,1)), d=hash12(i+vec2(1,1));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
float fbm(vec2 p, int oct){
  float s=0.0, a=0.5, n=0.0;
  mat2 rot = mat2(0.8,0.6,-0.6,0.8);
  for(int i=0;i<8;i++){ if(i>=oct) break; s+=a*vnoise(p); n+=a; a*=0.5; p=rot*p*2.02; }
  return s/max(n,1e-4);
}
// ACES filmic (Narkowicz fit) — cheap, filmic shoulder.
vec3 aces(vec3 x){
  const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0);
}
// AgX-ish contrast curve for richer midtones
vec3 filmContrast(vec3 c, float k){
  return mix(c, c*c*(3.0-2.0*c), k);
}
vec3 linearToSrgb(vec3 c){
  return mix(c*12.92, 1.055*pow(max(c,1e-5),vec3(1.0/2.4))-0.055, step(0.0031308,c));
}
vec3 srgbToLinear(vec3 c){
  return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045,c));
}
`;

// HDR post-processing chain.
//
//   scene(RGBA16F) -> brightpass -> 6-level downsample -> tent upsample
//                  -> composite(bloom + streak + dirt + grade + optics)
//
// The bloom is the COD/Unity progressive-blur approach: a 13-tap box-ish
// downsample followed by a 3x3 tent upsample with additive accumulation. It is
// cheap, stable under motion, and has no visible ringing or tiling.
import { compile, RenderTarget, drawFullscreen, FS_VS, GLSL_COMMON, Blend } from './gl.js';

const clampN = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerpN = (a, b, t) => a + (b - a) * t;

const BRIGHT_FS = `
${GLSL_COMMON}
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold, uKnee, uExposure;
in vec2 vUv; out vec4 outColor;

void main(){
  // 4-tap Karis average kills fireflies before they can flicker.
  vec3 a = texture(uSrc, vUv + uTexel * vec2(-1,-1)).rgb;
  vec3 b = texture(uSrc, vUv + uTexel * vec2( 1,-1)).rgb;
  vec3 c = texture(uSrc, vUv + uTexel * vec2(-1, 1)).rgb;
  vec3 d = texture(uSrc, vUv + uTexel * vec2( 1, 1)).rgb;
  float wa = 1.0/(1.0+max(max(a.r,a.g),a.b));
  float wb = 1.0/(1.0+max(max(b.r,b.g),b.b));
  float wc = 1.0/(1.0+max(max(c.r,c.g),c.b));
  float wd = 1.0/(1.0+max(max(d.r,d.g),d.b));
  vec3 col = (a*wa + b*wb + c*wc + d*wd) / max(1e-4, wa+wb+wc+wd);
  col *= uExposure;

  float br = max(max(col.r, col.g), col.b);
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0*uKnee);
  soft = soft * soft / (4.0*uKnee + 1e-5);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);
  outColor = vec4(col * contrib, 1.0);
}`;

const DOWN_FS = `
${GLSL_COMMON}
uniform sampler2D uSrc;
uniform vec2 uTexel;
in vec2 vUv; out vec4 outColor;

void main(){
  vec2 t = uTexel;
  vec3 A = texture(uSrc, vUv + t*vec2(-2,-2)).rgb;
  vec3 B = texture(uSrc, vUv + t*vec2( 0,-2)).rgb;
  vec3 C = texture(uSrc, vUv + t*vec2( 2,-2)).rgb;
  vec3 D = texture(uSrc, vUv + t*vec2(-1,-1)).rgb;
  vec3 E = texture(uSrc, vUv + t*vec2( 1,-1)).rgb;
  vec3 F = texture(uSrc, vUv + t*vec2(-2, 0)).rgb;
  vec3 G = texture(uSrc, vUv).rgb;
  vec3 H = texture(uSrc, vUv + t*vec2( 2, 0)).rgb;
  vec3 I = texture(uSrc, vUv + t*vec2(-1, 1)).rgb;
  vec3 J = texture(uSrc, vUv + t*vec2( 1, 1)).rgb;
  vec3 K = texture(uSrc, vUv + t*vec2(-2, 2)).rgb;
  vec3 L = texture(uSrc, vUv + t*vec2( 0, 2)).rgb;
  vec3 M = texture(uSrc, vUv + t*vec2( 2, 2)).rgb;
  vec3 c = (D+E+I+J) * 0.125;
  c += (A+B+G+F) * 0.03125;
  c += (B+C+H+G) * 0.03125;
  c += (F+G+L+K) * 0.03125;
  c += (G+H+M+L) * 0.03125;
  outColor = vec4(c, 1.0);
}`;

const UP_FS = `
${GLSL_COMMON}
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
in vec2 vUv; out vec4 outColor;

void main(){
  vec2 t = uTexel * uRadius;
  vec3 c = texture(uSrc, vUv + t*vec2(-1,-1)).rgb * 1.0;
  c += texture(uSrc, vUv + t*vec2( 0,-1)).rgb * 2.0;
  c += texture(uSrc, vUv + t*vec2( 1,-1)).rgb * 1.0;
  c += texture(uSrc, vUv + t*vec2(-1, 0)).rgb * 2.0;
  c += texture(uSrc, vUv).rgb                 * 4.0;
  c += texture(uSrc, vUv + t*vec2( 1, 0)).rgb * 2.0;
  c += texture(uSrc, vUv + t*vec2(-1, 1)).rgb * 1.0;
  c += texture(uSrc, vUv + t*vec2( 0, 1)).rgb * 2.0;
  c += texture(uSrc, vUv + t*vec2( 1, 1)).rgb * 1.0;
  outColor = vec4(c / 16.0, 1.0);
}`;

// Anamorphic streak: two 1-D passes with growing stride, horizontal only.
const STREAK_FS = `
${GLSL_COMMON}
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uStride;
in vec2 vUv; out vec4 outColor;

void main(){
  vec3 c = vec3(0.0);
  float wsum = 0.0;
  for(int i=-6;i<=6;i++){
    float fi = float(i);
    float w = exp(-fi*fi*0.09);
    c += texture(uSrc, vUv + vec2(uTexel.x * fi * uStride, 0.0)).rgb * w;
    wsum += w;
  }
  outColor = vec4(c / wsum, 1.0);
}`;

const COMPOSITE_FS = `
${GLSL_COMMON}
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uStreak;
uniform sampler2D uDirt;
uniform vec2  uRes;
uniform float uTime;
uniform float uExposure, uBloomStrength, uStreakStrength, uDirtAmount;
uniform float uChroma, uBarrel, uVignette, uGrain, uSaturation, uContrast, uLift;
uniform float uRadialBlur;     // speed streaks
uniform float uFlash;          // full-screen additive flash
uniform vec3  uFlashCol;
uniform float uFade;           // 1 = normal, 0 = black
uniform vec4  uWave0;          // xy centre(uv), z radius, w amplitude
uniform vec4  uWave1;
uniform float uAberrationBoost;
uniform float uDesat;
in vec2 vUv; out vec4 outColor;

// Interleaved gradient noise - free, tight, temporally stable dither.
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

vec2 shockwave(vec2 uv, vec4 w){
  if(w.w <= 0.0001) return uv;
  vec2 d = uv - w.xy;
  d.x *= uRes.x / uRes.y;
  float r = length(d);
  float band = exp(-pow((r - w.z) / 0.045, 2.0));
  return uv + normalize(d + 1e-6) * band * w.w;
}

void main(){
  vec2 uv = vUv;

  // --- lens geometry: mild barrel + shockwave warp ---
  vec2 cc = uv - 0.5;
  float r2 = dot(cc, cc);
  uv = 0.5 + cc * (1.0 + uBarrel * r2);
  uv = shockwave(uv, uWave0);
  uv = shockwave(uv, uWave1);

  // --- radial speed blur, sampled toward screen centre ---
  vec3 scene = vec3(0.0);
  if(uRadialBlur > 0.001){
    vec2 dir = (uv - 0.5);
    float wsum = 0.0;
    for(int i=0;i<8;i++){
      float t = float(i) / 7.0;
      float w = 1.0 - t * 0.7;
      scene += texture(uScene, uv - dir * t * uRadialBlur).rgb * w;
      wsum += w;
    }
    scene /= wsum;
  } else {
    scene = texture(uScene, uv).rgb;
  }

  // --- chromatic aberration: radial, stronger at the edges ---
  float ca = (uChroma + uAberrationBoost) * (0.35 + r2 * 2.4);
  vec2 dirC = normalize(cc + 1e-6);
  scene.r = texture(uScene, uv + dirC * ca).r;
  scene.b = texture(uScene, uv - dirC * ca).b;

  vec3 bloom  = texture(uBloom,  uv).rgb;
  vec3 bloomR = texture(uBloom,  uv + dirC * ca * 2.0).rgb;
  vec3 bloomB = texture(uBloom,  uv - dirC * ca * 2.0).rgb;
  bloom = vec3(bloomR.r, bloom.g, bloomB.b);

  vec3 streak = texture(uStreak, uv).rgb;
  float dirt  = texture(uDirt, uv * vec2(uRes.x/uRes.y, 1.0) * 0.9).r;

  vec3 col = scene * uExposure;
  col += bloom * uBloomStrength * (1.0 + dirt * uDirtAmount * 3.0);
  col += streak * uStreakStrength;
  col += uFlashCol * uFlash;

  // --- grade ---
  col = max(col, 0.0);
  col = aces(col);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, uSaturation * (1.0 - uDesat));
  col = filmContrast(col, uContrast);
  col += uLift * (1.0 - col);

  // --- vignette (two-lobe: broad falloff + tight corner crush) ---
  float v = 1.0 - uVignette * smoothstep(0.25, 1.25, r2 * 2.0);
  v *= 1.0 - 0.30 * uVignette * smoothstep(0.55, 1.6, r2 * 2.6);
  col *= v;

  col *= uFade;

  // --- grain: luminance-weighted so shadows stay clean-ish, highlights breathe ---
  float g = ign(gl_FragCoord.xy + fract(uTime * 60.0) * 1731.0) - 0.5;
  col += g * uGrain * (0.35 + 0.9 * sqrt(max(lum, 0.0)));

  // --- output dither to kill 8-bit banding in the deep blacks ---
  col = linearToSrgb(max(col, 0.0));
  col += (ign(gl_FragCoord.xy + 17.0) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}`;

const BLOOM_LEVELS = 6;

/**
 * The look, in one place. This file owns the grade: main.js hands over raw
 * frame state and everything below is a post-processing decision.
 */
export const GRADE = {
  exposure: 1.16,
  threshold: 0.80,
  knee: 0.55,
  bloomStrength: 0.72,
  bloomRadius: 1.0,
  streakStrength: 0.30,
  chroma: 0.0016,
  barrel: 0.020,
  vignette: 0.44,
  grain: 0.030,
  dirt: 0.34,
  saturation: 1.07,
  contrast: 0.14,
  lift: 0.008,
};

export class Post {
  constructor(gl, tex) {
    this.gl = gl;
    this.tex = tex;
    this.scene = new RenderTarget(gl, 2, 2, { float: true });
    this.mips = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) this.mips.push(new RenderTarget(gl, 2, 2, { float: true }));
    this.streakA = new RenderTarget(gl, 2, 2, { float: true });
    this.streakB = new RenderTarget(gl, 2, 2, { float: true });

    this.pBright = compile(gl, FS_VS, BRIGHT_FS, 'bright');
    this.pDown = compile(gl, FS_VS, DOWN_FS, 'down');
    this.pUp = compile(gl, FS_VS, UP_FS, 'up');
    this.pStreak = compile(gl, FS_VS, STREAK_FS, 'streak');
    this.pComp = compile(gl, FS_VS, COMPOSITE_FS, 'composite');
    this.w = 0; this.h = 0;
  }

  resize(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.scene.resize(w, h);
    let mw = Math.max(1, w >> 1), mh = Math.max(1, h >> 1);
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.mips[i].resize(mw, mh);
      mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1);
    }
    this.streakA.resize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.streakB.resize(Math.max(1, w >> 2), Math.max(1, h >> 2));
  }

  beginScene() { this.scene.bind(true); return this.scene; }

  _pass(prog, target, srcTex, uniforms, additive = false) {
    const gl = this.gl;
    target.bind(!additive);
    gl.useProgram(prog.program);
    if (additive) Blend.add(gl); else Blend.none(gl);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    if (prog.u.uSrc) gl.uniform1i(prog.u.uSrc, 0);
    for (const k in uniforms) {
      const loc = prog.u[k]; if (!loc) continue;
      const v = uniforms[k];
      if (typeof v === 'number') gl.uniform1f(loc, v);
      else gl.uniform2f(loc, v[0], v[1]);
    }
    drawFullscreen(gl);
    Blend.none(gl);
  }

  /**
   * Map frame state -> post parameters. This is the dynamic half of the look:
   * how the lens reacts to speed, danger and impacts.
   */
  grade(ctx) {
    const dead = ctx.mode === 'dead';
    const sk = ctx.speedK, hp = ctx.hushProx, lg = ctx.launchGlow;
    const waves = (ctx.waves || []).map((w) => {
      if (!w.live) return [0, 0, 0, 0];
      const t = w.t / w.dur;
      const uv = ctx.cam.worldToUv(w.x, w.y);
      return [uv[0], uv[1], 0.02 + t * 0.55, (1 - t) * (1 - t) * 0.045];
    });
    while (waves.length < 2) waves.push([0, 0, 0, 0]);

    return {
      time: ctx.t,
      exposure: GRADE.exposure * (dead ? lerpN(1, 0.72, clampN(ctx.deadT)) : 1),
      threshold: GRADE.threshold,
      knee: GRADE.knee,
      bloomStrength: GRADE.bloomStrength * (1 + sk * 0.16),
      bloomRadius: GRADE.bloomRadius,
      streakStrength: GRADE.streakStrength * (1 + sk * 0.9 + lg * 1.2),
      dirt: GRADE.dirt,
      chroma: GRADE.chroma,
      aberrationBoost: sk * 0.0022 + hp * 0.004 + ctx.slow * 0.003,
      barrel: GRADE.barrel + sk * 0.010,
      vignette: GRADE.vignette + hp * 0.20,
      grain: GRADE.grain,
      saturation: GRADE.saturation,
      contrast: GRADE.contrast,
      lift: GRADE.lift,
      radialBlur: sk * 0.030 + lg * 0.020,
      flash: ctx.flash,
      flashCol: ctx.flashCol,
      fade: ctx.fade,
      desat: dead ? clampN(ctx.deadT * 0.8) * 0.45 : 0,
      wave0: waves[0], wave1: waves[1],
    };
  }

  /**
   * Turn raw frame state into the final image.
   * @param ctx frameCtx from main.js (see Game.frameCtx)
   */
  render(ctx) {
    const gl = this.gl;
    const g = this.grade(ctx);
    Blend.none(gl);

    // brightpass -> mip0
    this._pass(this.pBright, this.mips[0], this.scene.tex, {
      uTexel: [1 / this.scene.w, 1 / this.scene.h],
      uThreshold: g.threshold ?? 0.85, uKnee: g.knee ?? 0.5, uExposure: g.exposure,
    });
    // downsample chain
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      this._pass(this.pDown, this.mips[i], this.mips[i - 1].tex,
        { uTexel: [1 / this.mips[i - 1].w, 1 / this.mips[i - 1].h] });
    }
    // upsample + accumulate
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      const dst = this.mips[i - 1], src = this.mips[i];
      dst.bind(false);
      gl.useProgram(this.pUp.program);
      Blend.add(gl);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(this.pUp.u.uSrc, 0);
      gl.uniform2f(this.pUp.u.uTexel, 1 / src.w, 1 / src.h);
      gl.uniform1f(this.pUp.u.uRadius, g.bloomRadius ?? 1);
      drawFullscreen(gl);
      Blend.none(gl);
    }

    // anamorphic streak: two widening horizontal passes off the brightest mip
    this._pass(this.pStreak, this.streakA, this.mips[1].tex,
      { uTexel: [1 / this.streakA.w, 1 / this.streakA.h], uStride: 2.0 });
    this._pass(this.pStreak, this.streakB, this.streakA.tex,
      { uTexel: [1 / this.streakB.w, 1 / this.streakB.h], uStride: 10.0 });

    // composite
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    const p = this.pComp;
    gl.useProgram(p.program);
    const bind = (unit, tex, name) => {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
      if (p.u[name]) gl.uniform1i(p.u[name], unit);
    };
    bind(0, this.scene.tex, 'uScene');
    bind(1, this.mips[0].tex, 'uBloom');
    bind(2, this.streakB.tex, 'uStreak');
    bind(3, this.tex.dirt, 'uDirt');
    const U = p.u;
    gl.uniform2f(U.uRes, this.w, this.h);
    gl.uniform1f(U.uTime, g.time);
    gl.uniform1f(U.uExposure, g.exposure);
    gl.uniform1f(U.uBloomStrength, g.bloomStrength);
    gl.uniform1f(U.uStreakStrength, g.streakStrength);
    gl.uniform1f(U.uDirtAmount, g.dirt);
    gl.uniform1f(U.uChroma, g.chroma);
    gl.uniform1f(U.uBarrel, g.barrel);
    gl.uniform1f(U.uVignette, g.vignette);
    gl.uniform1f(U.uGrain, g.grain);
    gl.uniform1f(U.uSaturation, g.saturation);
    gl.uniform1f(U.uContrast, g.contrast);
    gl.uniform1f(U.uLift, g.lift);
    gl.uniform1f(U.uRadialBlur, g.radialBlur || 0);
    gl.uniform1f(U.uFlash, g.flash || 0);
    gl.uniform3f(U.uFlashCol, ...(g.flashCol || [1, 1, 1]));
    gl.uniform1f(U.uFade, g.fade ?? 1);
    gl.uniform1f(U.uAberrationBoost, g.aberrationBoost || 0);
    gl.uniform1f(U.uDesat, g.desat || 0);
    gl.uniform4f(U.uWave0, ...(g.wave0 || [0, 0, 0, 0]));
    gl.uniform4f(U.uWave1, ...(g.wave1 || [0, 0, 0, 0]));
    drawFullscreen(gl);
  }
}

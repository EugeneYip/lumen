// The abyss. One fullscreen pass, drawn before everything, straight into HDR.
//
// Reads world-space so parallax is exact: each layer reconstructs its own
// world position at a different depth, which gives true perspective drift
// rather than the usual "scroll the texture slower" fake.
import { compile, drawFullscreen, FS_VS, GLSL_COMMON, Blend } from '../engine/gl.js';
import { PAL } from '../art/palette.js';

const FS = `
${GLSL_COMMON}
uniform sampler2D uNoise;
uniform vec2  uRes;
uniform vec2  uCamPos;
uniform vec2  uViewSize;     // world units covered by the screen
uniform float uCamRot;
uniform float uTime;
uniform float uHushX;        // world x of the advancing dark
uniform float uSurfaceY;     // world y where the water surface sits (negative = above)
uniform float uFloorY;       // world y of the trench floor
uniform float uIntensity;    // global env brightness (dips on death)

uniform vec3 uVoid, uDeep, uMid, uHigh, uSurf, uSilt, uHushEdge, uHushGlow;

in vec2 vUv; out vec4 outColor;

vec2 toWorld(vec2 uv, float parallax){
  vec2 p = (uv - 0.5) * uViewSize;
  float c = cos(-uCamRot), s = sin(-uCamRot);
  p = vec2(p.x*c - p.y*s, p.x*s + p.y*c);
  return uCamPos * parallax + p;
}

float ntex(vec2 p){ return texture(uNoise, p).r; }
float ntex2(vec2 p){ return texture(uNoise, p).g; }

// Ridged silhouette horizon. Returns coverage 0..1 for "rock is here".
float ridge(vec2 w, float scale, float amp, float baseY, float seed){
  float x = w.x / scale + seed;
  float h = 0.0;
  h += ntex(vec2(x*0.11, seed*0.37)) * 0.55;
  h += ntex(vec2(x*0.27, seed*0.71)) * 0.28;
  h += ntex(vec2(x*0.63, seed*1.13)) * 0.13;
  h = pow(h, 1.35);
  float top = baseY - h * amp;
  return sat((w.y - top) / (uViewSize.y * 0.02));
}

void main(){
  vec2 uv = vUv;
  vec2 w  = toWorld(uv, 1.0);

  // ---------- water column ----------
  // Depth is measured from the surface; the gradient is the single biggest
  // readability lever, so it is authored, not procedural.
  float depth = sat((w.y - uSurfaceY) / max(1.0, (uFloorY - uSurfaceY)));
  vec3 col = uSurf;
  col = mix(col, uHigh, smoothstep(0.00, 0.16, depth));
  col = mix(col, uMid,  smoothstep(0.10, 0.42, depth));
  col = mix(col, uDeep, smoothstep(0.34, 0.78, depth));
  col = mix(col, uVoid, smoothstep(0.72, 1.00, depth));
  col *= 0.34;

  // subtle horizontal thermocline banding
  float band = ntex(vec2(w.x * 0.00016, w.y * 0.0012 + uTime * 0.006));
  col *= 0.90 + 0.20 * band;

  // ---------- god rays from the surface ----------
  // Screen-anchored fan, world-modulated so they slide as you travel.
  float rayFade = exp(-depth * 3.1);
  if(rayFade > 0.002){
    float ang = (uv.x - 0.42) / max(0.35, (1.0 - uv.y * 0.55));
    float sweep = 0.0;
    sweep += pow(sat(0.5 + 0.5*sin(ang*11.0 + uTime*0.13 + w.x*0.0006)), 6.0) * 0.55;
    sweep += pow(sat(0.5 + 0.5*sin(ang*23.0 - uTime*0.09 + w.x*0.0011)), 9.0) * 0.35;
    sweep += pow(sat(0.5 + 0.5*sin(ang*41.0 + uTime*0.21 + w.x*0.0019)), 14.0) * 0.22;
    float grow = smoothstep(1.0, 0.05, uv.y);
    col += uSurf * sweep * grow * rayFade * 0.30;
  }

  // ---------- caustic shimmer on the upper water ----------
  float causticFade = exp(-depth * 4.6);
  if(causticFade > 0.003){
    vec2 cp = w * 0.0022;
    float c1 = ntex(cp + vec2(uTime*0.010, uTime*0.006));
    float c2 = ntex2(cp*1.9 - vec2(uTime*0.014, uTime*0.004));
    float caus = pow(sat(1.0 - abs(c1 + c2 - 1.0) * 2.2), 3.2);
    col += uSurf * caus * causticFade * 0.20;
  }

  // ---------- distant trench walls (three parallax layers) ----------
  vec2 wFar  = toWorld(uv, 0.30);
  vec2 wMid  = toWorld(uv, 0.55);
  vec2 wNear = toWorld(uv, 0.78);

  float floorFar  = ridge(wFar,  900.0, 520.0, uFloorY + 120.0, 3.1);
  float ceilFar   = 1.0 - ridge(wFar, 1100.0, 460.0, uSurfaceY + 700.0, 8.7);
  float floorMid  = ridge(wMid,  620.0, 380.0, uFloorY + 40.0, 17.3);
  float floorNear = ridge(wNear, 420.0, 260.0, uFloorY - 30.0, 29.9);

  vec3 rockFar  = mix(col, uVoid * 1.9 + uSilt * 0.16, 0.72);
  vec3 rockMid  = mix(col, uVoid * 1.25 + uSilt * 0.09, 0.86);
  vec3 rockNear = mix(col, uVoid * 0.7, 0.94);

  col = mix(col, rockFar, floorFar * 0.85);
  col = mix(col, rockFar, (1.0 - ceilFar) * 0.55);
  col = mix(col, rockMid, floorMid * 0.92);
  col = mix(col, rockNear, floorNear);

  // rim light on the near ridge, catching the surface glow
  float rimN = sat(floorNear) - sat(ridge(wNear + vec2(0.0, uViewSize.y*0.012), 420.0, 260.0, uFloorY - 30.0, 29.9));
  col += uHigh * max(0.0, rimN) * 0.55 * exp(-depth * 1.6);

  // ---------- marine snow (three depth slices) ----------
  for(int L=0; L<3; L++){
    float fl = float(L);
    float par = 0.42 + fl * 0.24;
    vec2 sw = toWorld(uv, par) * (0.010 + fl * 0.004);
    sw.y += uTime * (0.030 + fl * 0.020);
    vec2 cell = floor(sw);
    vec2 f = fract(sw);
    float h = hash12(cell + fl * 31.7);
    if(h > 0.62){
      vec2 c = hash22(cell + fl * 7.3);
      float d = length((f - c) * vec2(1.0, 1.0));
      float sz = 0.030 + 0.055 * hash12(cell + 3.7);
      float dot_ = exp(-pow(d / sz, 2.0));
      float tw = 0.6 + 0.4 * sin(uTime * (0.8 + h * 2.0) + h * 30.0);
      col += uHigh * dot_ * tw * (0.30 - fl * 0.07) * exp(-depth * 1.1);
    }
  }

  // ---------- volumetric silt haze, low and slow ----------
  float hazeN = ntex(w * 0.00035 + vec2(uTime * 0.004, 0.0));
  float low = smoothstep(0.55, 1.0, depth);
  col += uSilt * hazeN * low * 0.16;

  // ---------- the Hush ----------
  // Everything to the left of uHushX is being unmade. Violet fringe, then void.
  float dx = (w.x - uHushX) / max(1.0, uViewSize.x);
  float inHush = 1.0 - smoothstep(-0.02, 0.10, dx);
  if(inHush > 0.001){
    float crawl = ntex(vec2(w.y * 0.0016, uTime * 0.05)) * 0.06;
    float e = 1.0 - smoothstep(-0.03 + crawl, 0.055 + crawl, dx);
    col = mix(col, uHushGlow * 0.55, e * 0.75);
    float edge = exp(-pow((dx - 0.012 - crawl) / 0.022, 2.0));
    col += uHushEdge * edge * 0.85;
    float deepIn = 1.0 - smoothstep(-0.34, -0.03, dx);
    col = mix(col, vec3(0.0012, 0.0006, 0.003), deepIn);
  }

  col *= uIntensity;
  outColor = vec4(max(col, 0.0), 1.0);
}`;

export class Background {
  constructor(gl, tex) {
    this.gl = gl; this.tex = tex;
    this.prog = compile(gl, FS_VS, FS, 'background');
  }
  draw(ctx) {
    const { cam, world, t: time, envDim: intensity = 1 } = ctx;
    const gl = this.gl, p = this.prog;
    Blend.none(gl);
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.noise);
    gl.uniform1i(p.u.uNoise, 0);
    gl.uniform2f(p.u.uRes, cam.pixelW, cam.pixelH);
    gl.uniform2f(p.u.uCamPos, cam.x, cam.y);
    gl.uniform2f(p.u.uViewSize, cam.viewW, cam.viewH);
    gl.uniform1f(p.u.uCamRot, cam.rot || 0);
    gl.uniform1f(p.u.uTime, time);
    gl.uniform1f(p.u.uHushX, world.hushX);
    gl.uniform1f(p.u.uSurfaceY, world.surfaceY);
    gl.uniform1f(p.u.uFloorY, world.floorY);
    gl.uniform1f(p.u.uIntensity, intensity);
    gl.uniform3fv(p.u.uVoid, PAL.voidDeep);
    gl.uniform3fv(p.u.uDeep, PAL.waterDeep);
    gl.uniform3fv(p.u.uMid, PAL.waterMid);
    gl.uniform3fv(p.u.uHigh, PAL.waterHigh);
    gl.uniform3fv(p.u.uSurf, PAL.surface);
    gl.uniform3fv(p.u.uSilt, PAL.silt);
    gl.uniform3fv(p.u.uHushEdge, PAL.hushEdge);
    gl.uniform3fv(p.u.uHushGlow, PAL.hushGlow);
    drawFullscreen(gl);
  }
}

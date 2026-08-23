// The abyss. One fullscreen pass, drawn before everything, straight into HDR.
//
// The trench you see and the trench the physics uses are the same rock: every
// frame the exact `bandTop`/`bandBot` profile is sampled into a strip texture,
// so the silhouette on screen *is* the collision boundary. Everything else is
// built off that one source of truth - the roof casts the shadow, gaps in the
// roof aim the light shafts, the floor pools the silt and carries the vents.
//
// Depth comes from perspective, not scroll speed: each wall layer reconstructs
// world space through `toLayer`, which divides the screen offset by the layer's
// apparent scale. Distant walls therefore converge toward the view centre and
// shrink, the way a canyon actually recedes.
import { compile, drawFullscreen, FS_VS, GLSL_COMMON, Blend, texture2D } from '../engine/gl.js';
import { PAL } from '../art/palette.js';

const STRIP = 768;   // band-profile samples across the visible x range
const MAXL  = 7;     // in-scattering lights: the mote plus nearby anchors

const FS = `
${GLSL_COMMON}
uniform sampler2D uNoise;
uniform sampler2D uBand;     // RG strip: R = bandTop(x), G = bandBot(x)
uniform vec2  uRes;
uniform vec2  uCamPos;
uniform vec2  uViewSize;     // world units covered by the screen
uniform vec2  uBandMap;      // strip u = (worldX - x) * y
uniform float uCamRot;
uniform float uTime;
uniform float uHushX;        // world x of the advancing dark
uniform float uSurfaceY;     // world y where the water surface sits
uniform float uFloorY;       // world y of the trench floor
uniform float uIntensity;    // global env brightness (dips on death)
uniform float uHushProx;
uniform float uSpeedK;
uniform float uDraft;
uniform float uDiff;
uniform vec4  uLights[${MAXL}];   // xy world pos, z strength, w warmth

uniform vec3 uVoid, uDeep, uMid, uHigh, uSurf, uSilt, uHushEdge, uHushGlow;

in vec2 vUv; out vec4 outColor;

const vec3 ROCK_COOL = vec3(0.0062, 0.0104, 0.0148);
const vec3 ROCK_WARM = vec3(0.0158, 0.0116, 0.0078);
const float SUN_SLANT = 0.185;   // world x the light drifts per unit of descent

vec2 camRot(vec2 p){ float c = cos(-uCamRot), s = sin(-uCamRot); return vec2(p.x*c - p.y*s, p.x*s + p.y*c); }

// Scroll-parallax: same scale, slower drift. Right for the volumetrics, which
// have no silhouette and so nothing to converge.
vec2 toWorld(vec2 uv, float parallax){ return uCamPos * parallax + camRot((uv - 0.5) * uViewSize); }

// Perspective layer. 's' is apparent scale (1 = the plane the player swims on).
vec2 toLayer(vec2 uv, float s){ return uCamPos + camRot((uv - 0.5) * uViewSize) / s; }

float ntex (vec2 p){ return texture(uNoise, p).r; }
float ntex2(vec2 p){ return texture(uNoise, p).g; }
float ntex3(vec2 p){ return texture(uNoise, p).b; }

vec2 bandAt(float wx){
  return texture(uBand, vec2(clamp((wx - uBandMap.x) * uBandMap.y, 0.0, 1.0), 0.5)).rg;
}

float depthOf(float wy){ return sat((wy - uSurfaceY) / max(1.0, uFloorY - uSurfaceY)); }

// Water eats red first. Palette coefficients, exaggerated ~3x so the hue shift
// survives a screen this dark.
vec3 absorb(vec3 c, float dist){
  return c * exp(-dist * vec3(0.000126, 0.000048, 0.000027));
}

// The single biggest readability lever, so it is authored, not procedural.
vec3 waterAt(float wy){
  float d = depthOf(wy);
  vec3 c = uSurf;
  c = mix(c, uHigh, smoothstep(0.02, 0.32, d));
  c = mix(c, uMid,  smoothstep(0.28, 0.60, d));
  c = mix(c, uDeep, smoothstep(0.56, 0.82, d));
  c = mix(c, uVoid, smoothstep(0.80, 0.99, d));
  return c * mix(1.30, 0.22, smoothstep(0.30, 0.97, d));
}

// Gaps in the trench roof. Light only gets in here, which is what makes the
// shafts belong to the world instead of to the screen.
float fissure(float wx, float soft){
  float v = ntex(vec2(wx * 0.000152, 0.13)) * 0.74 + ntex2(vec2(wx * 0.00046, 0.61)) * 0.40;
  return smoothstep(0.55 - soft * 0.12, 0.93 + soft * 0.60, v);
}

// Downwelling light reaching w, traced back to where its ray left the roof.
float shaftAt(vec2 w, float roofY){
  float t = w.y - roofY;
  if(t < 0.0) return 1.0;
  float ex = w.x - SUN_SLANT * t;
  float f = fissure(ex, sat(t / 2400.0));
  if(f < 0.002) return 0.0;
  float shim = 0.70 + 0.30 * sin(ex * 0.0082 + uTime * 0.40) * sin(ex * 0.021 - uTime * 0.26 + t * 0.0024);
  return f * shim * exp(-t / 1500.0);
}

// Relief on the drawn silhouette, biased into the rock so the visible edge
// never intrudes on the swimmable band.
float relief(float wx, float seed){
  float a = ntex (vec2(wx * 0.00182 + seed, seed * 0.71));
  float b = ntex2(vec2(wx * 0.0061 + seed * 1.7, seed * 0.29));
  return (a * 0.66 + b * 0.34 - 0.28) * 54.0;
}

// Sedimentary bedding, shared by floor and ceiling so the geology reads as one
// formation the trench was cut through.
vec3 rockBody(vec2 w, float lit){
  float tilt = (ntex(vec2(w.x * 0.000118, 0.41)) - 0.5) * 1250.0;
  float sy = (w.y + tilt) * 0.0082;
  float bi = floor(sy), bf = fract(sy);
  float bh = hash11(bi * 1.37 + 0.5);
  float bed = smoothstep(0.0, 0.16, bf) * (1.0 - smoothstep(0.70, 1.0, bf));
  float lam = 0.90 + 0.15 * sin(sy * 8.3 + tilt * 0.004);
  float veins = 1.0 - 0.52 * (1.0 - smoothstep(0.0, 0.05, abs(ntex3(w * 0.0021) - 0.5)));
  float grain = 0.84 + 0.30 * ntex2(w * 0.0098);
  return mix(ROCK_COOL, ROCK_WARM, bh * 0.72) * mix(0.52, 1.34, bh)
       * (0.60 + 0.50 * bed) * lam * veins * grain * lit;
}

// The rock the physics uses. Coverage in .a.
vec4 trenchRock(vec2 w){
  vec2 bd = bandAt(w.x);
  float top = bd.x - relief(w.x, 3.1);
  float bot = bd.y + relief(w.x, 11.7);
  float soft = uViewSize.y * 0.0030;
  float dTop = top - w.y, dBot = w.y - bot;
  float cTop = sat(dTop / soft), cBot = sat(dBot / soft);
  float cov = max(cTop, cBot);
  if(cov < 0.002) return vec4(0.0);

  bool roof = cTop > cBot;
  float into = roof ? dTop : dBot;
  vec3 c = rockBody(w, exp(-into / 300.0) * 0.82 + 0.18);

  float h = 26.0;
  vec2 bl = bandAt(w.x - h), br = bandAt(w.x + h);
  float slope = ((roof ? br.x : br.y) - (roof ? bl.x : bl.y)) / (2.0 * h);
  float edge = exp(-into / 34.0);

  if(roof){
    // Backlit underside: reads as silhouette. What light it has is bounced up
    // off the water, plus the glow leaking around the fissures beside it.
    float leak = fissure(w.x, 0.30);
    c += uHigh * edge * (0.30 + 1.30 * leak) * 0.50;
    c += uSurf * edge * sat(abs(slope) * 1.3) * 0.20;
    c += uSilt * exp(-into / 150.0) * 0.055;
  } else {
    float pool = shaftAt(vec2(w.x, bot), bd.x);
    c += uHigh * edge * (0.26 + 1.00 * pool) * 0.62;
    c += uSurf * exp(-into / 105.0) * pool * 0.34;
    c += uSilt * exp(-into / 190.0) * 0.11;
  }
  return vec4(mix(absorb(c, 140.0), waterAt(w.y), 0.14), cov);
}

// A trench wall further back. Smaller 's' converges it toward the view centre,
// drops its contrast and buries it in fog - that is what makes the air.
vec4 farWall(vec2 uv, float s, float seed, float openT, float openB, float amp,
             float fog, float dist, vec3 fogCol){
  vec2 w = toLayer(uv, s);
  float a = ntex (vec2(w.x * 0.000146 + seed, seed * 0.37));
  float b = ntex2(vec2(w.x * 0.00051 + seed * 1.7, seed * 0.83));
  float nT = a * 0.66 + b * 0.34;
  float nB = ntex (vec2(w.x * 0.000205 + seed * 3.1, seed * 0.19)) * 0.62
           + ntex3(vec2(w.x * 0.00088 + seed * 2.3, seed * 1.29)) * 0.38;
  float top = -openT - nT * amp;
  float bot =  openB + nB * amp * 0.88;
  float soft = (uViewSize.y * 0.006) / s;
  float dT = top - w.y, dB = w.y - bot;
  float cov = max(sat(dT / soft), sat(dB / soft));
  if(cov < 0.003) return vec4(0.0);

  bool roof = dT > dB;
  float into = roof ? dT : dB;
  // shallower rock is closer to the light, so it keeps a little more value
  float up = 1.0 - depthOf(w.y);
  vec3 c = mix(ROCK_COOL, ROCK_WARM, 0.22)
         * (exp(-into / (1400.0 * s + 300.0)) * 0.62 + 0.38)
         * (roof ? 0.62 : 1.00) * mix(0.55, 1.9, up * up);
  c += uHigh * exp(-into / (240.0 / s)) * (roof ? 0.09 : 0.20);
  return vec4(mix(absorb(c, dist), fogCol, fog), cov);
}

void main(){
  vec2 uv = vUv;
  vec2 w  = toWorld(uv, 1.0);
  vec2 bdN = bandAt(w.x);
  float dep = depthOf(w.y);

  // ---------- water column ----------
  vec3 col = waterAt(w.y);
  vec3 fogCol = col;

  // Slow currents wobbling the whole medium, so nothing sits perfectly still.
  vec2 flow = vec2(ntex (vec2(w.x * 0.00021 + uTime * 0.004, w.y * 0.00033)) - 0.5,
                   ntex2(vec2(w.x * 0.00027, w.y * 0.00041 - uTime * 0.005)) - 0.5);

  // Roof shadow: the trench interior is lit only by what gets past the ceiling.
  float underRoof = sat((w.y - bdN.x) / 760.0);
  col *= mix(1.06, 0.46, underRoof);

  // Thermocline: real water is layered, and the layers show as faint interfaces.
  for(int i = 0; i < 3; i++){
    float y0 = -1620.0 + float(i) * 1180.0;
    float wob = (ntex(vec2(w.x * 0.00026 + float(i) * 3.1, uTime * 0.009)) - 0.5) * 150.0;
    float d = w.y - y0 - wob;
    col *= 1.0 + 0.055 * (1.0 - smoothstep(0.0, 70.0, abs(d))) - 0.030 * (1.0 - smoothstep(0.0, 260.0, abs(d + 150.0)));
  }

  // ---------- the trench, receding ----------
  vec4 r3 = farWall(uv, 0.205, 4.3, 1010.0, 830.0, 900.0, 0.885, 5400.0, fogCol);
  col = mix(col, r3.rgb, r3.a);
  vec4 r2 = farWall(uv, 0.315, 19.7, 930.0, 720.0, 830.0, 0.745, 3100.0, fogCol);
  col = mix(col, r2.rgb, r2.a);
  vec4 r1 = farWall(uv, 0.520, 37.1, 880.0, 680.0, 720.0, 0.520, 1450.0, fogCol);
  col = mix(col, r1.rgb, r1.a);

  // ---------- volumetric light from the surface ----------
  // The roof is opaque, so light only arrives through the fissures. Ramped so
  // the shafts are dimmest right under the roof, where the player flies.
  float roofY = bdN.x;
  float sh = shaftAt(w, roofY);
  float ramp = smoothstep(0.0, 520.0, w.y - roofY);
  float mote = 0.58 + 0.42 * ntex(vec2(w.x * 0.0011 + flow.x * 0.06, w.y * 0.0019 - uTime * 0.026));
  vec3 shaftCol = absorb(uSurf, max(0.0, w.y - uSurfaceY) * 0.85);
  vec3 rays = shaftCol * sh * ramp * mote * 0.62;
  // wide in-scatter halo around each shaft
  rays += uHigh * fissure(w.x - SUN_SLANT * max(0.0, w.y - roofY), 0.95)
        * exp(-max(0.0, w.y - roofY) / 2200.0) * 0.30;
  // caustics, only where they could be seen at all
  float caus = exp(-dep * 5.4);
  if(caus > 0.004){
    vec2 cp = w * 0.0021;
    float c1 = ntex (cp + vec2(uTime * 0.010, uTime * 0.006));
    float c2 = ntex2(cp * 1.9 - vec2(uTime * 0.014, uTime * 0.004));
    rays += uSurf * pow(sat(1.0 - abs(c1 + c2 - 1.0) * 2.2), 3.2) * caus * 0.55;
  }
  col += rays * 0.74;

  // ---------- hydrothermal vents ----------
  // One cell per vent, placed clear of the boundaries so a single lookup does.
  float vent = 0.0;
  {
    const float CELL = 1250.0;
    float ci = floor(w.x / CELL);
    float h1 = hash11(ci * 0.7317 + 3.7);
    if(h1 > 0.30){
      float vx = (ci + 0.5 + (h1 - 0.5) * 0.40) * CELL;
      float hgt = bandAt(vx).y - w.y;
      if(hgt > -80.0 && hgt < 1700.0){
        float hh = max(hgt, 0.0);
        float wob = (ntex(vec2(w.y * 0.0013 + ci, uTime * 0.05)) - 0.5) * (34.0 + hh * 0.34);
        float rad = 24.0 + hh * 0.21;
        float dx = w.x - vx - wob;
        float plume = exp(-(dx * dx) / (rad * rad)) * exp(-hh / (420.0 + h1 * 560.0));
        float rip = 0.58 + 0.42 * ntex2(vec2(w.x * 0.0052 + ci, w.y * 0.0021 - uTime * 0.27));
        vent = plume * rip;
        col += absorb(uSurf, 1600.0) * vent * (0.15 + uDraft * 0.34);
        col += uSilt * vent * 0.26;
        col += vec3(0.30, 0.105, 0.032) * exp(-(dx * dx) / 900.0 - (hh * hh) / 6400.0) * (0.55 + 0.8 * uDraft);
      }
    }
  }

  // ---------- the rock the physics uses ----------
  // Warped inside a vent plume: heat shimmer bending the silhouette behind it.
  vec2 wr = w + vec2(sin(w.y * 0.021 + uTime * 1.6) * vent * 11.0, -vent * 7.0);
  vec4 r0 = trenchRock(wr);
  col = mix(col, r0.rgb, r0.a);
  col += rays * 0.26 * (1.0 - r0.a * 0.55);   // medium in front of the rock

  // ---------- silt: pools on the floor, thins with height ----------
  float above = max(0.0, bdN.y - w.y);
  float siltN = ntex(vec2(w.x * 0.00040 - uTime * 0.004 + flow.x * 0.05, w.y * 0.00085 + uTime * 0.002));
  col += absorb(uSilt, 900.0) * exp(-above / (300.0 + 260.0 * siltN)) * (0.34 + 0.52 * siltN) * 0.62;
  col += uSilt * siltN * smoothstep(0.62, 0.98, dep) * 0.10;

  // ---------- marine snow, four depths ----------
  float snowKill = 1.0 - r0.a * 0.92;
  for(int L = 0; L < 4; L++){
    float fl = float(L);
    float par = 0.34 + fl * 0.26;
    vec2 g = toWorld(uv, par) * (0.0072 + fl * 0.0034);
    g.y += uTime * (0.020 + fl * 0.019);
    g.x += flow.x * 0.30 + sin(uTime * 0.06 + fl * 2.1) * 0.09;
    vec2 cell = floor(g), f = fract(g);
    float hs = hash12(cell + fl * 31.7);
    if(hs > 0.615){
      vec2 c = hash22(cell + fl * 7.3);
      float sz = 0.024 + 0.058 * hash12(cell + 3.7);
      vec2 dv = f - c;
      dv.x /= 1.0 + uSpeedK * 2.3 * (0.35 + fl * 0.30);
      float tw = 0.52 + 0.48 * sin(uTime * (0.7 + hs * 2.2) + hs * 41.0);
      col += absorb(uHigh, 260.0 / max(par, 0.2)) * exp(-dot(dv, dv) / (sz * sz))
           * tw * (0.46 - fl * 0.075) * snowKill;
    }
  }

  // ---------- in-scattering: bright things sit in the haze they light ----------
  for(int i = 0; i < ${MAXL}; i++){
    vec4 Lg = uLights[i];
    if(Lg.z <= 0.0) continue;
    vec2 dl = w - Lg.xy;
    float g = 62000.0 / (dot(dl, dl) + 62000.0);
    col += mix(vec3(0.10, 0.44, 0.70), vec3(0.80, 0.44, 0.15), Lg.w) * g * g * Lg.z * 0.055;
  }

  // ---------- the Hush ----------
  float dxh = w.x - uHushX;
  if(dxh < 2100.0){
    // A torn frontier, not a gradient: three scales of writhe along y, plus
    // tongues of nothing licking forward.
    float front = (ntex (vec2(w.y * 0.00072, uTime * 0.019)) - 0.5) * 330.0
                + (ntex2(vec2(w.y * 0.0031 + 7.1, uTime * 0.041)) - 0.5) * 145.0
                + (ntex3(vec2(w.y * 0.0105, uTime * 0.075)) - 0.5) * 50.0;
    front += pow(sat(ntex2(vec2(w.y * 0.0042 - 3.3, uTime * 0.026)) * 1.28), 5.0) * 540.0;
    float e = dxh - front;

    // the water goes still, then quiet, then dead
    col *= mix(1.0, 0.30, (1.0 - smoothstep(0.0, 1200.0, max(e, 0.0))) * 0.88);

    float inside = 1.0 - smoothstep(-32.0, 36.0, e);
    if(inside > 0.001){
      float churn = ntex(vec2(w.x * 0.00075 + uTime * 0.008, w.y * 0.0011));
      col = mix(col, vec3(0.0008, 0.0004, 0.0024) + uHushGlow * 0.05 * churn * churn, inside);
    }

    float rimVar = 0.38 + 0.92 * ntex(vec2(w.y * 0.0033 + 11.0, uTime * 0.05));
    col += uHushEdge * (exp(-(e * e) / 2100.0) * 0.60 + exp(-(e * e) / 125.0) * 2.40) * rimVar;
    col += uHushGlow * exp(-(e * e) / 52900.0) * 0.34 * rimVar;

    // matter coming apart as it crosses: flecks streaming into the edge
    if(e > -60.0 && e < 640.0){
      vec2 g = vec2(w.x * 0.0125 + uTime * 1.15, w.y * 0.0125);
      vec2 cl = floor(g), fr = fract(g);
      if(hash12(cl + 51.7) > 0.52){
        vec2 dv = (fr - hash22(cl + 13.1)) * vec2(2.6, 1.0);
        col += mix(uHushEdge, vec3(1.0), 0.22) * exp(-dot(dv, dv) / 0.030)
             * (1.0 - sat(e / 640.0)) * 0.60;
      }
    }
  }

  // approach pressure: a violet bruise creeping in from the left
  if(uHushProx > 0.01){
    float g = pow(1.0 - uv.x, 2.2) * uHushProx;
    col = mix(col, col * vec3(0.74, 0.64, 1.06), g * 0.55);
    col += uHushGlow * g * 0.05;
  }

  col *= uIntensity * mix(1.0, 0.88, uDiff);

  // Deep blacks are where banding shows. Static screen-space dither, scaled by
  // local value so it never becomes visible grain in the lit areas.
  float lum = dot(col, vec3(0.25, 0.62, 0.13));
  col += (hash12(gl_FragCoord.xy + uRes * 0.0) - 0.5) * (0.00028 + lum * 0.030);

  outColor = vec4(max(col, 0.0), 1.0);
}`;

export class Background {
  constructor(gl, tex) {
    this.gl = gl; this.tex = tex;
    this.prog = compile(gl, FS_VS, FS, 'background');
    this.stripData = new Float32Array(STRIP * 2);
    this.strip = texture2D(gl, {
      width: STRIP, height: 1, internalFormat: gl.RG16F, format: gl.RG, type: gl.FLOAT,
      filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE,
    });
    this.bandMap = new Float32Array(2);
    this.lights = new Float32Array(MAXL * 4);
  }

  /**
   * Sample the real collision profile into the strip. Padding covers camera
   * roll, the silhouette relief and the vent lookups, which reach up to most of
   * a vent cell sideways.
   */
  _updateStrip(world, cam) {
    const gl = this.gl, n = STRIP, d = this.stripData;
    const pad = cam.viewW * 0.10 + 980;
    const x0 = cam.x - cam.viewW * 0.5 - pad, x1 = cam.x + cam.viewW * 0.5 + pad;
    const step = (x1 - x0) / (n - 1);
    const hasBand = typeof world.bandTop === 'function' && typeof world.bandBot === 'function';
    for (let i = 0; i < n; i++) {
      const x = x0 + i * step;
      d[i * 2] = hasBand ? world.bandTop(x) : -1100;
      d[i * 2 + 1] = hasBand ? world.bandBot(x) : 900;
    }
    // Map world x to texel centres so the linear filter interpolates exactly.
    this.bandMap[0] = x0 - step * 0.5;
    this.bandMap[1] = 1 / (n * step);
    gl.bindTexture(gl.TEXTURE_2D, this.strip);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, 1, gl.RG, gl.FLOAT, d);
  }

  /** The mote plus the nearest few anchors, so their light fogs the water. */
  _updateLights(world, player, cam) {
    const L = this.lights;
    let n = 0;
    if (player) { L[0] = player.x; L[1] = player.y; L[2] = 1.0; L[3] = 0.0; n = 1; }
    const as = world.anchors;
    if (as) {
      const reach = cam.viewW * 0.6;
      for (let i = 0; i < as.length && n < MAXL; i++) {
        const a = as[i];
        if (a.alive === false || Math.abs(a.x - cam.x) > reach) continue;
        L[n * 4] = a.x; L[n * 4 + 1] = a.y;
        L[n * 4 + 2] = a.big ? 0.85 : 0.55; L[n * 4 + 3] = 1.0;
        n++;
      }
    }
    for (let i = n; i < MAXL; i++) { L[i * 4] = 0; L[i * 4 + 1] = 0; L[i * 4 + 2] = 0; L[i * 4 + 3] = 0; }
  }

  draw(ctx) {
    const { cam, world, player, t: time, envDim: intensity = 1 } = ctx;
    const gl = this.gl, p = this.prog, u = p.u;
    this._updateStrip(world, cam);
    this._updateLights(world, player, cam);

    Blend.none(gl);
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.noise);
    gl.uniform1i(u.uNoise, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.strip);
    gl.uniform1i(u.uBand, 1);

    gl.uniform2f(u.uRes, cam.pixelW, cam.pixelH);
    gl.uniform2f(u.uCamPos, cam.x, cam.y);
    gl.uniform2f(u.uViewSize, cam.viewW, cam.viewH);
    gl.uniform2fv(u.uBandMap, this.bandMap);
    gl.uniform1f(u.uCamRot, cam.rot || 0);
    gl.uniform1f(u.uTime, time);
    gl.uniform1f(u.uHushX, world.hushX);
    gl.uniform1f(u.uSurfaceY, world.surfaceY ?? -3400);
    gl.uniform1f(u.uFloorY, world.floorY ?? 1500);
    gl.uniform1f(u.uIntensity, intensity);
    gl.uniform1f(u.uHushProx, ctx.hushProx || 0);
    gl.uniform1f(u.uSpeedK, ctx.speedK || 0);
    gl.uniform1f(u.uDraft, ctx.inDraft || 0);
    gl.uniform1f(u.uDiff, ctx.difficulty || 0);
    gl.uniform4fv(u.uLights, this.lights);

    gl.uniform3fv(u.uVoid, PAL.voidDeep);
    gl.uniform3fv(u.uDeep, PAL.waterDeep);
    gl.uniform3fv(u.uMid, PAL.waterMid);
    gl.uniform3fv(u.uHigh, PAL.waterHigh);
    gl.uniform3fv(u.uSurf, PAL.surface);
    gl.uniform3fv(u.uSilt, PAL.silt);
    gl.uniform3fv(u.uHushEdge, PAL.hushEdge);
    gl.uniform3fv(u.uHushGlow, PAL.hushGlow);
    drawFullscreen(gl);
    gl.activeTexture(gl.TEXTURE0);
  }
}

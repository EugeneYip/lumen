// The abyss. One fullscreen pass, drawn before everything, straight into HDR.
//
// One field does the lighting: 'skyAt' - how much downwelling light survives to
// a point, given the open water above the trench and the roof that seals it.
// The water value, the god rays, the rim on the rock, the haze the far walls
// sink into, the silt and the marine snow are all reads of that single field.
// That is why the light looks like it belongs to this trench rather than to the
// screen: nothing here is visible unless light actually reaches it.
//
// Values are authored in absolute scene-linear terms (the V_ constants below).
// The palette supplies chromaticity only - normalised to peak 1.0 on upload -
// so no brightness is ever the accident of six sub-1.0 factors multiplied
// together, which is how an environment ends up at 2% of its intended value.
//
// The trench you see and the trench the physics uses are the same rock: every
// frame the exact bandTop/bandBot profile is sampled into a strip texture, so
// the silhouette on screen *is* the collision boundary. Relief is biased into
// the rock, never out of it, so the drawn edge cannot lie about the arena.
//
// Depth comes from perspective, not scroll speed: each wall layer reconstructs
// world space through 'toLayer', which divides the screen offset by the layer's
// apparent scale, so distant walls converge toward the view centre and shrink
// the way a canyon actually recedes.
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
uniform float uFloorY;       // world y of the abyssal floor
uniform float uIntensity;    // global env brightness (dips on death)
uniform float uHushProx;
uniform float uSpeedK;
uniform float uDraft;
uniform float uDiff;
uniform vec4  uLights[${MAXL}];   // xy world pos, z strength, w warmth

// Chromaticities: peak channel is 1.0, brightness comes from the V_ constants.
uniform vec3 uCVoid, uCDeep, uCMid, uCHigh, uCSurf, uCSilt, uCHush, uCHushGlow;

in vec2 vUv; out vec4 outColor;

// ---- the value budget, scene-linear, pre-exposure -------------------------
// Measured through the actual chain (ACES at 1.16x, then filmContrast 0.14 and
// lift 0.008): scene 0.006 lands at sRGB 25, 0.042 at 60, 0.098 at 100, 0.18 at
// 150. The grade's lift pins the display black at ~24, so range has to be won
// at the top of the ladder, not by crushing the bottom.
const float V_LIT   = 0.235;   // water directly under an open fissure
const float V_FLOOR = 0.0016;  // the medium's own faint bioluminescence
const float V_ROCK  = 0.105;   // rock albedo under full light
const float V_RIM   = 0.340;   // grazing light on a rock edge
const float V_SHAFT = 0.240;   // core of a god ray
const float V_SILT  = 0.030;   // suspended sediment under full light
const float V_SNOW  = 0.260;   // one lit fleck of marine snow
const float V_VENT  = 0.900;   // vent throat - superwhite on purpose
const float V_HUSH  = 3.400;   // the fracture edge - superwhite on purpose

// Warm rock against cold water is the frame's only colour contrast, and the
// only thing keeping a teal-dominated palette from reading as monochrome.
const vec3 ROCK_COOL = vec3(0.46, 0.72, 1.00);
const vec3 ROCK_WARM = vec3(1.00, 0.62, 0.30);
const float SUN_SLANT = 0.215;   // world x the light drifts per unit of descent

vec4  N (vec2 p){ return texture(uNoise, p); }
float N1(vec2 p){ return texture(uNoise, p).r; }

// uNoise packs four octaves into RGBA, so one fetch buys four frequencies. But
// the tile is built by cross-fading four shifted copies, which averages the
// variance away: a plain weighted SUM of channels sampled along a line measures
// sd 0.04 about a mean of 0.6 - a field with no contrast, which is what starved
// the first two passes of this file. Build from mean-centred deviations with an
// explicit gain instead. GAIN is measured, not guessed: it restores sd ~0.21.
const float DEBUG_FIELDS = 1.0;   // TEMP: field visualisation
const float GAIN = 2.6;
float dev(float v){ return v - 0.5; }

vec2 unrot(vec2 p){ float c = cos(-uCamRot), s = sin(-uCamRot); return vec2(p.x*c - p.y*s, p.x*s + p.y*c); }

// Screen -> world offset. sprites.js projects through uCamScale.y = -2/viewH,
// so screen-up is world -y. Getting this sign wrong mirrors the whole trench
// against the physics and puts the roof at the bottom of the frame.
vec2 offs(vec2 uv){ return unrot(vec2((uv.x - 0.5) * uViewSize.x, (0.5 - uv.y) * uViewSize.y)); }

vec2 toWorld(vec2 uv){ return uCamPos + offs(uv); }

// Scroll-parallax: same scale, slower drift. Right for things with no
// silhouette - haze, snow - which have nothing to converge.
vec2 toDrift(vec2 uv, float par){ return uCamPos * par + offs(uv); }

// Perspective layer. 's' is apparent scale (1 = the plane the player swims on).
vec2 toLayer(vec2 uv, float s){ return uCamPos + offs(uv) / s; }

vec2 bandAt(float wx){
  return texture(uBand, vec2(clamp((wx - uBandMap.x) * uBandMap.y, 0.0, 1.0), 0.5)).rg;
}

float depthOf(float wy){ return sat((wy - uSurfaceY) / max(1.0, uFloorY - uSurfaceY)); }

// Water eats red first. Tuned so a warm source visibly goes cold across a
// screen width - the cue that says 'this is deep water', not tinted air.
vec3 absorb(vec3 c, float dist){
  return c * exp(-dist * vec3(0.00110, 0.00030, 0.00016));
}

// ---------------------------------------------------------------- lighting --
// How open the trench roof is above x. Two incommensurate scales so the pattern
// does not repeat inside a run; returned raw because callers want several
// thresholds off it and a soft halo must not cost another fetch.
float roofRaw(float wx){
  vec4 a = N(vec2(wx * 0.0000431, 0.137));
  vec4 b = N(vec2(wx * 0.0001400, 0.611));
  return 0.5 + (dev(a.r) * 1.12 + dev(a.g) * 0.34
              + dev(b.g) * 0.30 + dev(b.a) * 0.14) * GAIN;
}
// Measured against the real field: at soft=0, 20% of the trench is fully open
// and 59% sealed, with median lit and sealed stretches both ~950 world units -
// one bright hall and one dark reach per screen, the rhythm the frame hangs on.
// 'soft' widens the transition about a FIXED midpoint, so blurring the beam
// with depth spreads its light instead of deleting it. Widening one side only
// costs real brightness: it is what left the mid-band water at 11% of target.
float openAt(float raw, float soft){
  float halfw = 0.110 + soft * 0.420;
  return smoothstep(0.650 - halfw, 0.650 + halfw, raw);
}

// Downwelling light surviving to a point 'below' units under the roof. The
// diffuse term uses a soft threshold that blurs with depth (many scatterings);
// the shafts take a sharp threshold off the same raw field, which is the honest
// split between ambient in-scatter and the direct beam.
float skyAt(float below, float raw){
  float open = openAt(raw, sat(below / 1900.0));
  float leak = 0.055 + 0.20 * openAt(raw, 1.0);   // thin rock, and bounce
  return mix(leak, 1.0, open) * exp(-below / 1400.0);
}

vec3 mediumHue(float d){
  vec3 h = mix(uCSurf, uCHigh, smoothstep(0.00, 0.30, d));
  h = mix(h, uCMid,  smoothstep(0.26, 0.58, d));
  h = mix(h, uCDeep, smoothstep(0.54, 0.84, d));
  return mix(h, uCVoid, smoothstep(0.82, 1.00, d));
}

// The medium. Hue from absolute depth, value from how much sky arrives. Keeping
// them separate is what gives a single screen a real vertical ramp, when the
// absolute depth across that screen barely changes at all.
vec3 medium(float wy, float sky){
  return mediumHue(depthOf(wy)) * (V_FLOOR + V_LIT * mix(sky, sqrt(sky), 0.30));
}

// ------------------------------------------------------------------- rock ---
// Sedimentary bedding, shared by roof and floor so the geology reads as one
// formation the trench was cut through. Built additively so the mean stays at
// 1.0 and V_ROCK really is the albedo.
float strata(vec2 w, out float fine){
  float tilt = (N1(vec2(w.x * 0.0000745, 0.41)) - 0.5) * 1750.0;
  float sy = (w.y + tilt) * 0.0074;              // ~135 world units per bed
  float bi = floor(sy), bf = fract(sy);
  float bh = hash11(bi * 1.37 + 0.5);
  float bed = smoothstep(0.0, 0.13, bf) * (1.0 - smoothstep(0.74, 1.0, bf));
  vec4 g = N(w * 0.00135);                       // 185 / 93 / 46 / 23 units
  fine = sat(0.5 + (dev(g.b) * 0.85 + dev(g.a) * 0.50) * 1.9);
  float lam = sin(sy * 9.7 + tilt * 0.0042);
  float vein = 1.0 - smoothstep(0.022, 0.0, abs(g.g - 0.5));
  return max(0.06, 1.0 + 1.15 * (bh - 0.5) + 0.34 * (bed - 0.5)
                       + 0.16 * lam + 0.40 * (fine - 0.5) - 0.34 * vein);
}

// Surface roughness on the drawn silhouette. Deliberately small and strictly
// one-signed: the drawn rock is always a little THICKER than the collision
// rock, never thinner. A frame that draws rock as water gives the player an
// invisible wall to crash into, which is the one lie this file must not tell.
// The band's own 680-unit swing is the silhouette; this is just its texture.
float relief(float wx, float seed){
  vec4 a = N(vec2(wx * 0.00046 + seed, seed * 0.71));
  float broad = sat(0.5 + (dev(a.r) * 1.00 + dev(a.g) * 0.46) * GAIN);
  float notch = sat(0.5 + (dev(a.b) * 0.90 + dev(a.a) * 0.55) * GAIN);
  return 34.0 * pow(broad, 1.35) + 18.0 * pow(notch, 2.0);
}

// The rock the physics uses. Coverage in .a.
vec4 trenchRock(vec2 w, float sky, float open, float caus){
  vec2 bd = bandAt(w.x);
  float top = bd.x + relief(w.x, 3.1);
  float bot = bd.y - relief(w.x, 11.7);
  float soft = uViewSize.y * 0.0028;
  float dTop = top - w.y, dBot = w.y - bot;
  float cTop = sat(dTop / soft), cBot = sat(dBot / soft);
  float cov = max(cTop, cBot);
  if(cov < 0.002) return vec4(0.0);

  bool roof = cTop > cBot;
  float into = roof ? dTop : dBot;

  float fine;
  float alb = strata(w, fine);
  vec3 body = mix(ROCK_COOL, ROCK_WARM, sat(0.34 + 0.62 * (alb - 1.0)));
  // Diffuse rock falls off linearly with irradiance, faster than the water's
  // in-scatter, which is exactly what keeps it reading as silhouette.
  vec3 c = body * V_ROCK * alb * (0.045 + 0.955 * exp(-into / 240.0))
         * (0.022 + 0.978 * sky);

  float h = 26.0;
  vec2 bl = bandAt(w.x - h), br = bandAt(w.x + h);
  float slope = ((roof ? br.x : br.y) - (roof ? bl.x : bl.y)) / (2.0 * h);
  float rim = exp(-into / 20.0) + 0.34 * exp(-into / 88.0);

  if(roof){
    // Backlit underside. What light it has is bounced up off the water plus the
    // glow leaking around the fissures beside it, so the edge lights up exactly
    // where the roof is broken - which is where the beams are too.
    c += uCHigh * V_RIM * rim * (0.26 + 1.05 * open) * 0.46;
    c += uCSurf * V_RIM * rim * sat(abs(slope) * 1.2) * 0.16 * sky;
    c += uCSilt * V_SILT * 0.7 * exp(-into / 150.0) * sqrt(sat(sky * 3.0));
  } else {
    // Upward-facing: takes the beam directly, and takes its caustic net.
    c += uCSurf * V_RIM * rim * sky * (0.55 + 1.30 * caus);
    c += uCSurf * V_SHAFT * 0.55 * exp(-into / 130.0) * sky * caus;
    c += uCSilt * V_SILT * 1.1 * exp(-into / 190.0) * sqrt(sat(sky * 3.0));
  }
  return vec4(c, cov);
}

// A trench wall further back. A smaller 's' converges it toward the view centre
// and shrinks it; the value and the contrast come down with it, and that
// difference in contrast - not the parallax rate - is what makes the air.
// 'haze' must be the medium at the pixel's REAL depth, not at the layer's: a
// layer at s=0.135 spans 8000 world units of y across one screen, so reading
// depthOf() off it paints a false lit surface at the top of the frame and a
// false void across the bottom. The haze between eye and wall is real water.
vec4 farWall(vec2 uv, float s, float seed, float openT, float openB, float amp,
             float fog, float dist, vec3 haze){
  vec2 w = toLayer(uv, s);
  vec4 na = N(vec2(w.x * 0.0000630 + seed, seed * 0.37));
  vec4 nb = N(vec2(w.x * 0.0001970 + seed * 1.7, seed * 0.83));
  float nT = sat(0.5 + (dev(na.r) * 1.00 + dev(na.g) * 0.42 + dev(nb.b) * 0.20) * GAIN);
  float nB = sat(0.5 + (dev(na.b) * 0.95 + dev(nb.g) * 0.48 + dev(nb.a) * 0.24) * GAIN);
  float top = -openT - nT * amp;
  float bot =  openB + nB * amp * 0.92;
  float soft = (uViewSize.y * 0.0055) / s;
  float dT = top - w.y, dB = w.y - bot;
  float cov = max(sat(dT / soft), sat(dB / soft));
  if(cov < 0.004) return vec4(0.0);

  bool roof = dT > dB;
  float into = roof ? dT : dB;
  // Cheap sky: a distant wall needs value and contrast, not beam accuracy.
  float sky = (0.10 + 0.34 * nT) * exp(-max(0.0, w.y - top) / 1500.0);
  float bi = floor((w.y + na.r * 900.0) * 0.0062);
  float alb = 0.55 + 1.00 * hash11(bi * 1.37 + seed);
  vec3 c = mix(ROCK_COOL, ROCK_WARM, 0.30) * V_ROCK * alb
         * (0.10 + 0.90 * exp(-into / (900.0 * s + 240.0)))
         * (0.030 + 0.970 * sky);
  vec3 o = mix(absorb(c, dist), haze, fog);
  // The lit edge is allowed to survive the haze. It is what makes the receding
  // ladder of ledges read at all - fogged rock alone is a 7% value difference.
  o += uCHigh * V_RIM * sky * (roof ? 0.22 : 0.60) * (1.0 - fog * 0.60)
     * (exp(-into / (26.0 / s)) + 0.40 * exp(-into / (120.0 / s)));
  return vec4(o, cov);
}

// Caustic net: two drifting fields ridged against each other. Only ever applied
// where a beam actually lands, so it reads as the beam's footprint.
float caustic(vec2 p){
  vec4 a = N(p * 0.90 + vec2(uTime * 0.0110, uTime * 0.0072));
  vec4 b = N(p * 1.73 - vec2(uTime * 0.0148, uTime * 0.0051));
  float r1 = 1.0 - abs(a.r + b.g - 1.0) * 2.1;
  float r2 = 1.0 - abs(a.g + b.r - 1.0) * 2.7;
  return pow(sat(r1), 3.0) * 0.72 + pow(sat(r2), 4.0) * 0.52;
}

void main(){
  vec2 uv = vUv;
  vec2 w  = toWorld(uv);
  vec2 bdN = bandAt(w.x);

  // Slow currents wobbling the whole medium, so nothing sits perfectly still.
  vec4 fl = N(vec2(w.x * 0.00021 + uTime * 0.0040, w.y * 0.00033 - uTime * 0.0026));
  vec2 flow = vec2(fl.r - 0.5, fl.g - 0.5);

  // ---------- lighting, once, for everything ----------
  float below   = max(0.0, w.y - bdN.x);           // how deep under the roof
  float traceX  = w.x - SUN_SLANT * below;         // trace the ray back up
  float raw     = roofRaw(traceX);
  float sky     = skyAt(below, raw);
  float openSft = openAt(raw, 1.0);
  float openShp = openAt(raw, sat(below / 2600.0) * 0.45);

  float caus = sky > 0.05 ? caustic(w * 0.0023) : 0.0;

  // ---------- the water column ----------
  vec3 col = medium(w.y, sky);

  // Thermocline: real water is layered, and the layers show as faint
  // interfaces - but only where there is light to catch them.
  vec4 tn = N(vec2(w.x * 0.00026, uTime * 0.009));
  for(int i = 0; i < 3; i++){
    float y0 = -1500.0 + float(i) * 1140.0;
    float wob = ((i == 0 ? tn.r : i == 1 ? tn.g : tn.b) - 0.5) * 170.0;
    float d = w.y - y0 - wob;
    col *= 1.0 + (0.085 * (1.0 - smoothstep(0.0, 62.0, abs(d)))
                - 0.045 * (1.0 - smoothstep(0.0, 250.0, abs(d + 160.0)))) * sat(sky * 4.0);
  }

  // ---------- the trench, receding ----------
  // Four walls, each smaller, lower-contrast and closer to the haze than the
  // last. The contrast difference, not the parallax rate, is what makes air.
  vec3 haze = col;
  vec4 r4 = farWall(uv, 0.135, 4.3,  1060.0, 880.0, 980.0, 0.860, 6800.0, haze);
  col = mix(col, r4.rgb, r4.a);
  vec4 r3 = farWall(uv, 0.225, 19.7,  980.0, 790.0, 900.0, 0.740, 4200.0, haze);
  col = mix(col, r3.rgb, r3.a);
  vec4 r2 = farWall(uv, 0.360, 37.1,  920.0, 730.0, 800.0, 0.600, 2500.0, haze);
  col = mix(col, r2.rgb, r2.a);
  vec4 r1 = farWall(uv, 0.580, 61.9,  880.0, 690.0, 720.0, 0.420, 1250.0, haze);
  col = mix(col, r1.rgb, r1.a);

  // ---------- volumetric light from the surface far above ----------
  // The roof is opaque, so light only arrives through the fissures. Ramped off
  // at the roofline so a beam never appears inside the rock.
  float ramp = smoothstep(0.0, 240.0, below);
  float shim = 0.72 + 0.34 * sin(traceX * 0.0079 + uTime * 0.42)
                          * sin(traceX * 0.0215 - uTime * 0.27 + below * 0.0026);
  float dust = 0.40 + 1.20 * sat(0.5 + dev(N1(vec2(w.x * 0.00092 + flow.x * 0.05,
                                     w.y * 0.00165 - uTime * 0.028))) * 2.1);
  vec3 beamHue = absorb(uCSurf, below * 0.55 + 300.0);
  vec3 rays = beamHue * V_SHAFT * openShp * ramp * shim * dust * exp(-below / 1500.0);
  // The wide in-scatter halo either side of each beam.
  rays += uCHigh * V_SHAFT * 0.34 * openSft * ramp * exp(-below / 2400.0);
  // Caustic banding inside the beam - the shimmer that says 'moving water'.
  rays += beamHue * V_SHAFT * 0.42 * openShp * ramp * caus * exp(-below / 1900.0);
  col += rays;

  // ---------- hydrothermal vents ----------
  // One cell per vent, placed clear of the boundaries so a single lookup does.
  float vent = 0.0, ventHot = 0.0;
  {
    const float CELL = 1150.0;
    float ci = floor(w.x / CELL);
    float h1 = hash11(ci * 0.7317 + 3.7);
    if(h1 > 0.34){
      float vx = (ci + 0.5 + (h1 - 0.5) * 0.52) * CELL;
      float hgt = bandAt(vx).y - w.y;          // height above the floor
      if(hgt > -90.0 && hgt < 2000.0){
        float hh = max(hgt, 0.0);
        float rad = 26.0 + hh * 0.20;
        float wob = (N1(vec2(w.y * 0.0011 + ci, uTime * 0.045)) - 0.5) * (30.0 + hh * 0.40);
        float dx = w.x - vx - wob;
        float rip = 0.40 + 1.05 * sat(0.5 + dev(N1(vec2(w.x * 0.0046 + ci,
                                       w.y * 0.0019 - uTime * 0.30))) * 2.2);
        vent = exp(-(dx * dx) / (rad * rad)) * exp(-hh / (430.0 + h1 * 640.0)) * rip;
        ventHot = exp(-(dx * dx) / 1500.0 - (hh * hh) / 11000.0);
      }
    }
  }
  col += absorb(uCSurf, 1400.0) * V_SILT * 1.7 * vent
       * (0.45 + 1.5 * uDraft) * (0.20 + 0.80 * sat(sky * 3.0));
  col += uCSilt * V_SILT * 0.9 * vent;
  col += vec3(1.00, 0.34, 0.085) * V_VENT * ventHot * (0.30 + 0.85 * uDraft);

  // ---------- the rock the physics uses ----------
  // Warped inside a vent plume: heat shimmer bending the silhouette behind it.
  vec2 wr = w + vec2(sin(w.y * 0.021 + uTime * 1.6) * vent * 12.0, vent * 8.0);
  vec4 r0 = trenchRock(wr, sky, openSft, caus);
  col = mix(col, r0.rgb, r0.a);
  col += rays * 0.30 * (1.0 - r0.a * 0.60);   // the medium in front of the rock

  // ---------- silt: pools on the floor, and only where light finds it --------
  float above = max(0.0, bdN.y - w.y);
  vec4 sn = N(vec2(w.x * 0.00022 - uTime * 0.0035, w.y * 0.00052 + uTime * 0.0018));
  float billow = sat(0.5 + (dev(sn.r) * 1.00 + dev(sn.g) * 0.50 + dev(sn.b) * 0.28) * 2.1);
  col += absorb(uCSilt, 700.0) * V_SILT * exp(-above / (200.0 + 300.0 * billow))
       * (0.35 + 0.90 * billow) * sqrt(sat(sky * 3.0));

  // ---------- marine snow, four depths ----------
  float snowKill = 1.0 - r0.a * 0.94;
  float snowLit = V_SNOW * (0.30 + 0.70 * sat(sky * 2.6)) * snowKill;
  for(int L = 0; L < 4; L++){
    float fp = float(L);
    float par = 0.30 + fp * 0.24;
    vec2 g = toDrift(uv, par) * (0.0058 + fp * 0.0030);
    g.y -= uTime * (0.018 + fp * 0.016);
    g.x += flow.x * 0.26 + sin(uTime * 0.055 + fp * 2.1) * 0.08;
    vec2 cell = floor(g), f = fract(g);
    float hs = hash12(cell + fp * 31.7);
    if(hs > 0.74){
      vec2 c = hash22(cell + fp * 7.3);
      float sz = 0.018 + 0.052 * pow(hash12(cell + 3.7), 2.2);
      vec2 dv = f - c;
      dv.x /= 1.0 + uSpeedK * 2.6 * (0.30 + fp * 0.28);
      float tw = 0.55 + 0.45 * sin(uTime * (0.6 + hs * 2.4) + hs * 41.0);
      col += absorb(uCHigh, 200.0 / max(par, 0.2)) * snowLit
           * exp(-dot(dv, dv) / (sz * sz)) * tw * (0.55 - fp * 0.10);
    }
  }

  // ---------- in-scattering: bright things sit in the haze they light --------
  for(int i = 0; i < ${MAXL}; i++){
    vec4 Lg = uLights[i];
    if(Lg.z <= 0.0) continue;
    vec2 dl = w - Lg.xy;
    float g = 46000.0 / (dot(dl, dl) + 46000.0);
    col += mix(vec3(0.16, 0.62, 1.00), vec3(1.00, 0.50, 0.16), Lg.w) * g * g * Lg.z * 0.075;
  }

  // ---------- the Hush ----------
  // maxLag keeps the wall 1750-2900 units behind the player, so it is usually
  // just off the left edge. Its reach, not the wall, is what has to be legible.
  float dxh = w.x - uHushX;
  if(dxh < 3000.0){
    // A torn frontier, not a gradient: three scales of writhe along y, plus
    // tongues of nothing licking forward.
    vec4 fr = N(vec2(w.y * 0.00072, uTime * 0.019));
    float front = (dev(fr.r) * 780.0 + dev(fr.g) * 330.0 + dev(fr.b) * 120.0);
    front += pow(sat(0.5 + dev(N1(vec2(w.y * 0.0042 - 3.3, uTime * 0.026))) * 2.4), 4.0) * 620.0;
    float e = dxh - front;

    // Behind the front the water is unmade: it goes still, then colourless,
    // then gone. Desaturating before crushing is what makes it read as loss.
    float still = 1.0 - smoothstep(0.0, 1400.0, max(e, 0.0));
    float lum0 = dot(col, vec3(0.25, 0.62, 0.13));
    col = mix(col, mix(col, vec3(lum0), 0.70) * 0.16, still * 0.92);

    float inside = 1.0 - smoothstep(-40.0, 44.0, e);
    if(inside > 0.001){
      float churn = N1(vec2(w.x * 0.00068 + uTime * 0.007, w.y * 0.00098));
      col = mix(col, vec3(0.0006, 0.0003, 0.0016)
                   + uCHushGlow * V_HUSH * 0.006 * churn * churn, inside);
    }

    float rimVar = 0.40 + 0.95 * N1(vec2(w.y * 0.0031 + 11.0, uTime * 0.048));
    col += uCHush * V_HUSH * rimVar
         * (exp(-(e * e) / 165.0) * 0.85 + exp(-(e * e) / 3400.0) * 0.15);
    // Far glow: inverse-square, not Gaussian, so the dread arrives on screen
    // well before the wall does.
    float far = max(e, 0.0) / 430.0;
    col += uCHushGlow * V_HUSH * 0.090 * rimVar / (1.0 + far * far);

    // Fracture: hairline cracks reaching ahead of the front, the water coming
    // apart before it goes. Row spacing warped so it never reads as a grid.
    if(e > 0.0 && e < 1000.0){
      float row = floor(w.y * 0.0206 + N1(vec2(w.y * 0.0012, 3.7)) * 3.4);
      float rh = hash11(row * 1.731 + 5.3);
      float reach = 190.0 + rh * 760.0;
      if(rh > 0.40 && e < reach){
        float yc = (row + 0.5 + (rh - 0.5) * 0.7) / 0.0206;
        float dy = w.y - yc;
        col += uCHush * V_HUSH * 0.30 * exp(-dy * dy / (4.0 + rh * 9.0))
             * (1.0 - e / reach) * (0.5 + 0.5 * sin(uTime * (1.4 + rh * 3.0) + rh * 30.0));
      }
    }

    // Matter coming apart as it crosses: flecks streaming into the edge.
    if(e > -60.0 && e < 700.0){
      vec2 g = vec2(w.x * 0.0125 + uTime * 1.15, w.y * 0.0125);
      vec2 cl = floor(g), fc = fract(g);
      if(hash12(cl + 51.7) > 0.52){
        vec2 dv = (fc - hash22(cl + 13.1)) * vec2(2.6, 1.0);
        col += mix(uCHush, vec3(1.0), 0.24) * V_HUSH * 0.20
             * exp(-dot(dv, dv) / 0.030) * (1.0 - sat(e / 700.0));
      }
    }
  }

  // Approach pressure: a violet bruise creeping in from the left, so the wall
  // is felt even when it is entirely off screen.
  if(uHushProx > 0.01){
    float g = pow(1.0 - uv.x, 2.0) * uHushProx;
    col = mix(col, mix(col, vec3(dot(col, vec3(0.25, 0.62, 0.13))), 0.30)
                 * vec3(0.72, 0.60, 1.14), g * 0.70);
    col += uCHushGlow * V_HUSH * 0.020 * g;
  }

  col *= uIntensity * mix(1.0, 0.90, uDiff);

  // Deep blacks are where banding shows. Static screen-space dither, sized to
  // roughly one 8-bit step after the grade so it never becomes visible grain.
  float lum = dot(col, vec3(0.25, 0.62, 0.13));
  col += (hash12(gl_FragCoord.xy) - 0.5) * (0.00055 + lum * 0.0075);

  outColor = vec4(max(col, 0.0), 1.0);
  if(DEBUG_FIELDS > 0.5){
    // R = sharp beam mask, G = diffuse sky, B = far-wall coverage.
    outColor = vec4(openShp, sky, r4.a + r3.a * 0.5, 1.0);
  }
}`;

/** Palette entries are hue authorities only; brightness lives in the shader. */
function chroma(c) {
  const m = Math.max(c[0], c[1], c[2]) || 1;
  return new Float32Array([c[0] / m, c[1] / m, c[2] / m]);
}

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
    this.c = {
      vd: chroma(PAL.voidDeep), dp: chroma(PAL.waterDeep), md: chroma(PAL.waterMid),
      hi: chroma(PAL.waterHigh), sf: chroma(PAL.surface), st: chroma(PAL.silt),
      he: chroma(PAL.hushEdge), hg: chroma(PAL.hushGlow),
    };
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
    const gl = this.gl, p = this.prog, u = p.u, c = this.c;
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

    gl.uniform3fv(u.uCVoid, c.vd);
    gl.uniform3fv(u.uCDeep, c.dp);
    gl.uniform3fv(u.uCMid, c.md);
    gl.uniform3fv(u.uCHigh, c.hi);
    gl.uniform3fv(u.uCSurf, c.sf);
    gl.uniform3fv(u.uCSilt, c.st);
    gl.uniform3fv(u.uCHush, c.he);
    gl.uniform3fv(u.uCHushGlow, c.hg);
    drawFullscreen(gl);
    gl.activeTexture(gl.TEXTURE0);
  }
}

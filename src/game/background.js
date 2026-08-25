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
// The governing rule, arrived at by measurement: BUY DETAIL WITH CONTRAST, NOT
// WITH LEVEL. Every broad soft term here has been pushed down toward black and
// the legibility given back as a narrow high-contrast feature - bedding seams,
// joints, grain, block edges, cobbles, drift lips. That reads as more material
// than a mid-grey mass with faint modulation, and it is also the only way an
// abyss gets to contain actual blacks: measured with the sprite and ribbon
// passes disabled, the tenth percentile of this shader used to sit at linear
// 0.004-0.006, twice the value that encodes to sRGB L8, so the frame could not
// reach black no matter what the grade did with it.
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
//
// Debug kill switches, matching render.js's noSprites/noRibbons: append
// bgNoSnow / bgNoRays / bgNoVents / bgNoHush, or bgNoFar / bgNoSilt /
// bgNoGrain / bgNoBreak, to drop one feature group and attribute an artefact -
// or a value floor - to it. Eight uniform multiplies. They are how the
// axis-aligned-rectangle bug was pinned on the marine snow after two sessions
// of blaming other people's passes, and how the missing blacks were pinned on
// this file rather than on the grade; keep them.
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
uniform vec4  uKill;         // debug: x snow, y rays, z vents, w hush (1 = on)
uniform vec4  uKill2;        // debug: x far walls, y silt, z grain, w silhouette
uniform vec4  uLights[${MAXL}];   // xy world pos, z strength, w warmth

// Chromaticities: peak channel is 1.0, brightness comes from the V_ constants.
uniform vec3 uCVoid, uCDeep, uCMid, uCHigh, uCSurf, uCSilt, uCHush, uCHushGlow;

in vec2 vUv; out vec4 outColor;

// ---- the value budget, scene-linear, pre-exposure -------------------------
// Authored against tools/check.mjs's HDR contract, which is measured on the
// linear scene BEFORE tonemapping: p50 < 0.030, p90 < 0.150, p99 > 0.250.
// Tuning to the graded PNG instead is what produced a milky mid-grey wall -
// the grade's lift pins display black around sRGB 24, so chasing 'brighter
// shadows' on screen just marches the whole bulk into the midtones.
//
// check.mjs measures LUMINANCE, and this palette is almost entirely blue: the
// water hues carry luminance ~0.54 per unit, the violet Hush only ~0.18. Every
// number below is the value BEFORE that factor, so a cyan highlight needs to
// reach ~0.46 to clear the 0.25 p99 bar.
//
// The split the contract is really asking for: the bulk (water, rock, haze,
// silt) lives at 0.0005-0.02, and ONLY emissive or directly-lit things - rays,
// rim light, caustics, vents, the Hush edge - are allowed above 0.25.
const float V_LIT   = 0.104;   // water directly under an open fissure
const float V_FLOOR = 0.0007;  // the medium's own faint bioluminescence
const float V_ROCK  = 0.028;   // rock albedo: near-black mass, by design
const float V_RIM   = 0.850;   // grazing light on a near rock edge
// Distant rims need their own, far smaller budget. Four layers x two edges is
// eight full-width bands: even narrow, that touches most of the frame, and at
// near-rock strength it single-handedly put p90 at twice its ceiling. Aerial
// perspective says a distant highlight is veiled anyway.
const float V_FARRIM = 0.078;
// Core of a god ray. The slot field is sat()-clamped, so above raw 0.99 it is a
// PLATEAU: every pixel across the widest part of a shaft carries the identical
// peak value and no reshaping exponent can touch it, which is why the shafts
// measured as slabs and why the last of their mass has to come off the level
// rather than off the profile. 0.700 puts the brightest broad environment
// feature at linear ~0.58 against the mote core's 15+, and drops the shaft
// blocks at hushNear from 7.4 units of highlight energy to below the hero's.
const float V_SHAFT = 0.700;
const float V_SILT  = 0.050;   // suspended sediment under full light
// The water's own life, and the backscatter between the eye and a far wall.
// Both ride one mottled cloud field - see 'cloud' in main() - because a lift
// that does NOT ride it is a pedestal: measured, every flat version of these
// two terms took a lit frame from 14% of its pixels below sRGB 8 to 3% while
// the frame's p95-p20 spread fell, which is the milky failure this whole file
// exists to avoid. Riding the field, the same mean lifts a fixed FRACTION of
// whatever was black, which is the only shape that fits both ends of the
// contract at once: 'fast' has to give up a third of its blacks and 'tethered'
// can only afford four tenths of its own.
const float V_ABYSS = 0.021;
// The floor the glow puts under a receding plane. See farWall.
const float V_GLOW  = 0.078;
const float V_VEIL  = 0.018;
const float V_SNOW  = 0.450;   // one lit fleck of marine snow
const float V_BIO   = 2.350;   // a living mote - carries its own light
const float V_VENT  = 2.500;   // vent throat - superwhite on purpose
// The Hush edge budget. The multipliers off it are deliberately small: an
// art-direction pass measured the Hush's streaks clipping to 255 while the
// avatar peaked at 217, so the threat out-highlighted the protagonist and the
// frame's value hierarchy was inverted. The wall is a mass of DARK; only its
// tearing seam is allowed to be bright, and not brighter than the mote.
const float V_HUSH  = 6.000;
// The hierarchy ceiling. A blind review measured the mote as the 43rd most
// salient bright cluster in its own frame, out-massed 6:1 by the light shafts:
// the environment was competing for the top of the value ladder with the one
// object the player has to be able to find. Nothing this file draws is allowed
// past this, which tonemaps to about 0.72 against the mote core's 0.95.
//
// Applied once, at the end of main(), on the peak channel. Once, because eight
// multiplicative terms cannot each be trusted to stay in their lane as they are
// retuned; on the peak channel, because a per-channel clamp clips one channel
// before the others and shifts hue on the way. A soft knee rather than a min():
// a hard clamp flattens the top of whatever hits it into a plateau, which is
// the slab this pass spends most of its budget trying not to be.
const float V_ENVKNEE = 1.100;
const float V_ENVMAX  = 2.600;

// Warm rock against cold water is the frame's only colour contrast, and the
// only thing keeping a teal-dominated palette from reading as monochrome.
const vec3 ROCK_COOL = vec3(0.46, 0.72, 1.00);
const vec3 ROCK_WARM = vec3(1.00, 0.62, 0.30);
const vec3 BIO_MINT  = vec3(0.40, 1.00, 0.70);
const vec3 BIO_ICE   = vec3(0.34, 0.82, 1.00);
const float SUN_SLANT = 0.215;   // world x the light drifts per unit of descent
const float BEDY = 135.135;      // nominal world units per sedimentary bed

// Every fetch in this file takes an EXPLICIT mip level. It has to. uNoise is
// built with mips and LINEAR_MIPMAP_LINEAR, so a plain texture() picks its
// level from implicit screen-space derivatives, and derivatives are undefined
// in non-uniform control flow - which is most of this shader, since it fetches
// from inside cell branches, coverage rejects and early returns. Undefined
// meant "whatever was in the neighbouring lane", which is not a function of
// the shader inputs: five renders of one frozen state produced five different
// linear buffers, cycling per draw call, which breaks the blind A/B that this
// project judges quality with.
//
// Why it only bit once terrain grain arrived: the LOD is clamped at 0, and
// before grain() no fetch here was ever minified. The finest scale was
// 0.00135/unit, which at 1.2 world units per pixel is 0.41 texels per pixel -
// a negative LOD for any garbage derivative, so every wrong answer rounded to
// the same level 0. grain() samples at 0.0195/unit, about 6 texels per pixel
// (LOD 2.6), and the vent puff field at 3.5 (LOD 1.8). Those are the first
// fetches whose level could legitimately differ, so those are the ones that
// disagreed - which is exactly what the kill-switch bisect showed: bgNoGrain
// alone took the variance out of the tonemapped frame.
//
// The scale argument is the world-units-to-uv factor used to build p, so the
// footprint is scale * (world units per pixel) * (texels across the tile).
// Deterministic, uniform over the frame - so it can never draw a LOD seam -
// and it is the correct filter width, which the implicit path only was by
// accident. It is also what stops the finest grain octaves shimmering.
float pxWorld(){ return uViewSize.x / max(uRes.x, 1.0); }
float lodOf(float scale, float px){
  return log2(max(scale * px * float(textureSize(uNoise, 0).x), 1.0));
}
// z-suffixed variants take the pixel footprint of another space: a parallax
// layer at apparent scale s covers px/s world units per pixel.
vec4  Nz (vec2 p, float scale, float px){ return textureLod(uNoise, p, lodOf(scale, px)); }
float N1z(vec2 p, float scale, float px){ return Nz(p, scale, px).r; }
vec4  N  (vec2 p, float scale){ return Nz(p, scale, pxWorld()); }
float N1 (vec2 p, float scale){ return Nz(p, scale, pxWorld()).r; }

// uNoise packs four octaves into RGBA, so one fetch buys four frequencies: at
// sample scale s the channels carry features of 1/(4s), 1/(8s), 1/(16s) and
// 1/(32s) world units. But the tile is built by cross-fading four shifted
// copies, which averages the variance away: a plain weighted SUM of channels
// sampled along a line measures sd 0.04 about a mean of 0.6 - a field with no
// contrast, which is what starved the first two passes of this file. Build from
// mean-centred deviations with an explicit gain instead. GAIN is measured, not
// guessed: it restores sd ~0.21.
const float GAIN = 2.6;
float dev(float v){ return v - 0.5; }

// A smooth pseudo-random driver with a KNOWN range, -1..1, and a known maximum
// slope of 1.5*f. The noise tile's per-channel variance is small and written
// down nowhere, so anything needing a calibrated swing - per-shaft variance,
// the bedding warp, the fracture shear - cannot be built from it without
// measuring the tile first, and the tile is someone else's file. Two
// incommensurate sinusoids cost less than a fetch and cannot drift out of range
// when textures.js changes underneath.
float wave(float x, float f, float ph){
  return sin(x * f + ph) * 0.62 + sin(x * f * 2.317 + ph * 2.7) * 0.38;
}

// ------------------------------------------------------- cell point sprites --
// A hash cell draws one sprite and never looks at its neighbours, so the sprite
// MUST fall to zero before the cell boundary. When it does not, the boundary
// becomes the silhouette, and the frame fills with hard-edged axis-aligned
// rectangles that have a soft bright core in them. That is exactly what shipped
// here: a bio mote's halo was authored as 3-5x the fleck radius with a x7 skirt
// on top, an effective radius of 0.93 cells, truncated at 0.5 - so every mote
// was a grey square with a glow inside it, and the speed smear widened the
// footprint another 4.7x on top. Three guards, because one was not enough:
// inset the centre, cap every radius against that inset, and window to exactly
// zero at the edge so a future radius tweak degrades into a soft fade instead
// of a square.
const float CELL_INSET = 0.26;    // centres live in [0.26, 0.74]
const float CELL_RMAX  = 0.062;   // base tail radius; x CELL_GROW still dies by 0.26
const float CELL_GROW  = 1.85;    // most any sprite may stretch on one axis

vec2 cellCentre(vec2 h){ return 0.5 + (h - 0.5) * (1.0 - 2.0 * CELL_INSET); }

// Zero at the boundary, 1.0 anywhere a correctly-sized sprite has any energy,
// so on a correct sprite this costs four ops and changes nothing.
float cellWindow(vec2 f){
  vec2 e = min(f, 1.0 - f);
  return smoothstep(0.0, CELL_INSET * 0.60, min(e.x, e.y));
}

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
  return textureLod(uBand, vec2(clamp((wx - uBandMap.x) * uBandMap.y, 0.0, 1.0), 0.5), 0.0).rg;
}

float depthOf(float wy){ return sat((wy - uSurfaceY) / max(1.0, uFloorY - uSurfaceY)); }

// Water eats red first. Tuned so a warm source visibly goes cold across a
// screen width - the cue that says 'this is deep water', not tinted air.
vec3 absorb(vec3 c, float dist){
  return c * exp(-dist * vec3(0.00110, 0.00030, 0.00016));
}

// ------------------------------------------------------------- the geology --
// The sedimentary bedding grid, tilted. Shared by the near rock and by every
// far wall, so a bed is the same bed at every distance: that is what makes four
// parallax layers read as one formation the trench was cut through, instead of
// four unrelated noise fields that happen to be stacked.
float bedTilt(float wx, float px){ return (N1z(vec2(wx * 0.0000745, 0.41), 0.0000745, px) - 0.5) * 1750.0; }

// Beds are NOT of constant thickness. A perfectly even 135-unit stack reads as
// ruled paper, which is the single loudest regularity a strata field can have.
// Warping the bedding COORDINATE - rather than displacing the seams off a
// regular grid - keeps every pixel on a bed agreeing which bed it is on, which
// displacement does not: displace it and the mapping folds and pinches. The
// amplitude is chosen against the analytic slope below so local thickness runs
// 102-201 units and the sequence can never invert.
float bedFrom(float y){ return y / BEDY + wave(y, 0.00260, 1.7) * 0.62; }
float bedSlope(float y){
  float f = 0.00260;
  return 1.0 / BEDY + 0.62 * f * (0.62 * cos(y * f + 1.7) + 0.880 * cos(y * f * 2.317 + 4.59));
}
// Snap a profile height onto the bedding grid: a bench forms where a resistant
// bed outcrops, not at an arbitrary height. One Newton step inverts the warp,
// and an error of a few units is invisible against a 135-unit bed.
float snapBed(float y, float tilt){
  float u = bedFrom(y + tilt);
  return y + (floor(u) + 0.5 - u) / bedSlope(y + tilt);
}

// Sediment grain, four world-space octaves off two fetches. The finest is faded
// out as its projected size approaches a pixel: grain finer than that does not
// read as texture, it shimmers, and a camera that zooms with speed will find
// it. This is the term that decides whether rock has a surface at 1:1.
float grain(vec2 w){
  vec4 a = N(w * 0.00310, 0.00310);        // 81 / 40 / 20 / 10 world units
  vec4 b = N(w * 0.01950 + 7.3, 0.01950);  // 13 / 6.4 / 3.2 / 1.6 world units
  float g = dev(a.r) * 0.52 + dev(a.b) * 0.44 + dev(b.r) * 0.42 + dev(b.g) * 0.34
          + dev(b.b) * 0.30;
  return g * GAIN;
}

// Joints: the near-vertical fractures a rock mass breaks along, cutting across
// the beds. A level set of a SHEARED x, so a joint leans and wanders while
// every pixel on it still resolves to the same joint. Broken along its length,
// because a joint is a chain of segments and an unbroken one reads as a drawn
// line rather than as a crack.
float joints(vec2 w){
  float sx = (w.x + w.y * (0.14 + wave(w.x, 0.00029, 2.2) * 0.30)) / 186.0
           + wave(w.y, 0.00130, 3.1) * 0.30;
  float ji = floor(sx);
  float jh = hash11(ji * 3.17 + 1.9);
  if(jh < 0.45) return 0.0;
  float d = abs(fract(sx) - 0.5 + (jh - 0.5) * 0.42);
  float thick = 0.018 + jh * 0.026;
  float seg = sat(0.32 + dev(N1(vec2(w.y * 0.0034 + ji * 0.41, 0.77), 0.0034)) * 3.2);
  return exp(-(d * d) / (thick * thick)) * seg;
}

// Strata. Built additively so the mean albedo stays near 1.0 and V_ROCK really
// is the albedo. Two seams per bed do the work the body tone cannot: a dark
// parting at the base and a resistant cap near the top. Those are the features
// the eye actually reads strata from, and the only ones still legible in a mass
// that is - correctly - near black.
float strata(vec2 w, float det, out float fine, out float seam, out vec2 bedf){
  float sy = bedFrom(w.y + bedTilt(w.x, pxWorld()));
  float bi = floor(sy), bf = fract(sy);
  float bh  = hash11(bi * 1.37 + 0.5);      // bed albedo
  float chr = hash11(bi * 2.71 + 9.1);      // bed character: shale or sandstone
  float part = 1.0 - smoothstep(0.0, 0.030 + 0.055 * chr, bf);
  float cap  = smoothstep(0.66, 0.80, bf) * (1.0 - smoothstep(0.90, 1.00, bf));
  seam = max(part, cap * 0.85) * det;
  float jnt = joints(w) * det;
  bedf = vec2(cap * det - part * det, jnt);
  float g = grain(w) * det;
  fine = sat(0.5 + g * 0.42);
  // Cross-lamination, in the beds that have it. A fine internal fabric at an
  // angle to the bedding is the difference between rock and a flat fill.
  float lam = step(0.52, chr) * sin(bf * (14.0 + chr * 22.0) + w.x * 0.0043 * (0.5 + chr))
            * smoothstep(0.0, 0.16, bf) * (1.0 - smoothstep(0.84, 1.00, bf));
  return max(0.05, 1.0 + 1.05 * (bh - 0.5) + 0.44 * (cap - part)
                       + 0.20 * lam * det + 0.46 * g - 0.80 * jnt);
}

// ------------------------------------------------------ broken silhouettes --
// Surface relief on the drawn silhouette. Deliberately bounded and strictly
// one-signed: the drawn rock is always a little THICKER than the collision
// rock, never thinner. A frame that draws rock as water gives the player an
// invisible wall to crash into, which is the one lie this file must not tell.
// The band's own 680-unit swing is the silhouette; this is its texture.
//
// The old version was two smooth octaves at a 2170-unit wavelength - about one
// bump per screen - which is why the edge read as razor-straight. Rock does not
// erode into a smooth curve: it breaks along its joints and its beds into a
// staircase of blocks, and the debris rests at the foot as cobbles. The risers
// are softened over a few world units on purpose: a floor() edge in x gets no
// antialiasing at all from a coverage term that only softens in y, and
// stair-steps at one pixel.
float blocks(float wx, float cell, float amp, float sd){
  float u = wx / cell;
  float i = floor(u), f = fract(u);
  float q0 = floor(hash11(i * sd + 4.7) * 3.0);
  float q1 = floor(hash11((i + 1.0) * sd + 4.7) * 3.0);
  return amp * mix(q0, q1, smoothstep(0.90, 1.0, f));
}

// A dome with tangential edges: exponent > 1 sends the slope to zero where the
// stone meets the bed, so its outline antialiases instead of aliasing.
float dome(float f, float halfw){ return pow(sat(1.0 - abs(f) / halfw), 1.15); }

float reliefRoof(float wx, float det){
  vec4 a = N(vec2(wx * 0.00046 + 3.1, 2.20), 0.00046);
  float broad = sat(0.5 + (dev(a.r) * 1.00 + dev(a.g) * 0.46) * GAIN);
  float notch = sat(0.5 + (dev(a.b) * 0.90 + dev(a.a) * 0.55) * GAIN);
  float r = 22.0 * pow(broad, 1.35) + 11.0 * pow(notch, 2.0);
  r += det * blocks(wx, 118.0, 9.0, 1.93);
  r += det * blocks(wx, 47.0, 4.5, 2.71);
  // Teeth. Narrow, so they read as the rock's own broken edge rather than as
  // an obstacle the physics has not been told about.
  float pu = wx / 224.0;
  float ph = hash11(floor(pu) * 4.11 + 2.3);
  if(ph > 0.56) r += det * (26.0 + ph * 34.0) * dome(fract(pu) - 0.26 - ph * 0.46, 0.055 + ph * 0.05);
  // Saturating combine: the terms can pile up, and a hard min() would clip the
  // tops flat. Keeps small values untouched and asymptotes at the budget.
  return 84.0 * (1.0 - exp(-r / 84.0));
}

float reliefFloor(float wx, float det){
  vec4 a = N(vec2(wx * 0.00046 + 11.7, 9.40), 0.00046);
  float broad = sat(0.5 + (dev(a.r) * 1.00 + dev(a.g) * 0.46) * GAIN);
  float notch = sat(0.5 + (dev(a.b) * 0.90 + dev(a.a) * 0.55) * GAIN);
  float r = 20.0 * pow(broad, 1.30) + 10.0 * pow(notch, 2.0);
  r += det * blocks(wx, 132.0, 8.0, 1.71);
  // Cobbles: loose stone resting on the bed, two sizes so the edge is a scatter
  // and not a row. This is the term that turns the seabed from a gradient with
  // a clean curve for an edge into something with grain size.
  for(int i = 0; i < 2; i++){
    float cs = i == 0 ? 61.0 : 27.0;
    float ci = floor(wx / cs);
    float h1 = hash11(ci * (i == 0 ? 3.31 : 5.77) + 12.7 + float(i));
    float h2 = hash11(ci * 7.13 + 3.1 + float(i) * 4.0);
    if(h1 > 0.32){
      // Inset centre, and a half-width capped against the distance to the
      // nearer boundary, so the stone reaches zero strictly inside its own
      // cell. Uncapped it was worth a 10-unit step in the silhouette every
      // 61 units - a cell edge masquerading as geology.
      float c = 0.5 + (h2 - 0.5) * 0.40;
      float hw = min(0.30 + 0.20 * h2, min(c, 1.0 - c) * 0.94);
      r += det * (i == 0 ? 26.0 : 11.0) * h1 * dome(fract(wx / cs) - c, hw);
    }
  }
  return 84.0 * (1.0 - exp(-r / 84.0));
}

// The mote and the nearest anchors, as light landing on a surface rather than
// as haze in front of one. They were only ever in-scattering into the water, so
// an anchor bulb at linear 2.4 could sit sixty units off a wall and leave that
// wall at 0.002 - the "objects float in a void instead of sitting in a world"
// read, and the reason none of the strata, joints or grain authored below was
// ever legible: albedo is not visible without light on it.
//
// nrm is the surface normal along y: +1 for a roof (faces down, y is down), -1
// for a floor, 0 for a medium with no orientation. Inverse square with a core,
// same form as the in-scatter, so a lamp cannot divide by zero at its own
// centre. Falls off over ~120 units, which is a pool of light and not a wash.
vec3 lampLight(vec2 w, float nrm){
  vec3 s = vec3(0.0);
  for(int i = 0; i < ${MAXL}; i++){
    vec4 Lg = uLights[i];
    if(Lg.z <= 0.0) continue;
    vec2 dl = Lg.xy - w;
    float r2 = dot(dl, dl);
    float nd = mix(1.0, sat(dl.y * nrm * inversesqrt(max(r2, 1.0))), abs(nrm));
    float core = mix(2600.0, 26000.0, Lg.w);
    s += mix(vec3(0.30, 0.72, 1.00), vec3(1.00, 0.56, 0.20), Lg.w)
       * Lg.z * nd * core / (r2 + core);
  }
  return s;
}

// ---------------------------------------------------------------- lighting --
// How open the trench roof is above x. Two incommensurate scales so the pattern
// does not repeat inside a run; returned raw because callers want several
// thresholds off it and a soft halo must not cost another fetch.
float roofRaw(float wx){
  vec4 a = N(vec2(wx * 0.0000431, 0.137), 0.0000431);
  vec4 b = N(vec2(wx * 0.0001400, 0.611), 0.0001400);
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
  return smoothstep(0.620 - halfw, 0.620 + halfw, raw);
}

// Downwelling light surviving to a point 'below' units under the roof. The
// diffuse term uses a soft threshold that blurs with depth (many scatterings);
// the shafts take a sharp threshold off the same raw field, which is the honest
// split between ambient in-scatter and the direct beam.
//
// 'leak' is thin rock plus bounce, and it is the floor of the entire frame: it
// multiplies the water, the rock and the silt, so every unit of it is paid for
// across the whole image. At 0.040 + 0.16 it held a sealed reach of trench at
// twice the value that can encode to black.
float skyAt(float below, float raw){
  float open = openAt(raw, sat(below / 1900.0));
  float leak = 0.024 + 0.125 * openAt(raw, 1.0);
  return mix(leak, 1.0, open) * exp(-below / 1150.0);
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
  // The exponent pushes the whole mid-range down while leaving the peak at
  // sky=1 untouched - the one lever that lowers p50 without also lowering the
  // brightest water. A sqrt lift here does the exact opposite: it raises the
  // floor and flattens everything into a single mid-grey band.
  return mediumHue(depthOf(wy)) * (V_FLOOR + V_LIT * pow(sky, 2.15));
}

// ------------------------------------------------------------------- rock ---
// The rock the physics uses. Coverage in .a.
vec4 trenchRock(vec2 w, float sky, float amb, float glowM, float open, float caus, vec4 kill2){
  vec2 bd = bandAt(w.x);
  float top = bd.x + reliefRoof(w.x, kill2.w);
  float bot = bd.y - reliefFloor(w.x, kill2.w);
  float soft = uViewSize.y * 0.0028;
  float dTop = top - w.y, dBot = w.y - bot;
  float cTop = sat(dTop / soft), cBot = sat(dBot / soft);
  float cov = max(cTop, cBot);
  if(cov < 0.002) return vec4(0.0);

  bool roof = cTop > cBot;
  float into = roof ? dTop : dBot;

  float fine, seam; vec2 bedf;
  float alb = strata(w, kill2.z, fine, seam, bedf);

  // Local shape of the profile, from one pair of samples: the slope for the rim
  // and the curvature for where sediment can rest.
  float h = 120.0;
  vec2 bl = bandAt(w.x - h), br = bandAt(w.x + h);
  float pc = roof ? bd.x : bd.y, pl = roof ? bl.x : bl.y, pr = roof ? br.x : br.y;
  float slope = (pr - pl) / (2.0 * h);
  float dip = (2.0 * pc - pl - pr) / h;      // y is down, so > 0 in a hollow

  vec3 body = mix(ROCK_COOL, ROCK_WARM, sat(0.34 + 0.62 * (alb - 1.0)));

  // Sediment veneer, floor only. Silt settles on what faces up, collects in the
  // hollows and is swept off the crests and the steep faces, so its thickness
  // follows the profile's curvature. It hides the strata under it and takes the
  // downwelling light more evenly than rock does, and its edge against bare
  // rock is one of the few real material boundaries in the frame. The term it
  // replaces was a single exponential over the whole lower frame, which is what
  // turned the trench floor into a milky wash.
  float drape = 0.0, rpp = 0.0;
  if(!roof){
    // Megaripples. Sediment under a steady current organises into transverse
    // crests, and at 10 world units per metre the readable scale is the 3-10
    // metre megaripple, not the centimetre ripple: below about 30 units a crest
    // is finer than the drift it sits on and reads as noise. Two incommensurate
    // scales, sheared slightly by y so the row is not a ruler ticked across the
    // frame.
    //
    // It goes into the ALBEDO, not into a lit term. A review called the seabed
    // an untextured band, and it was right - every feature the floor had lived
    // inside a fifteen-unit lip along its own silhouette. The first attempt at
    // this keyed the crests to sky, which is near zero on a trench floor since
    // that is the deepest point under the roof; the second added a lamp term,
    // and the lamp is 120 units of reach on a floor that is usually 500 away.
    // Albedo is light-source-agnostic: whichever of the sky, a beam, a bedding
    // seam or the mote's own lamp is doing the lighting in a given frame, the
    // ripple is in the answer.
    rpp = wave(w.x + w.y * 0.42, 0.0755, 1.7) * 0.64
        + wave(w.x - 260.0, 0.0268, 4.3) * 0.36;
    float driftN = sat(0.5 + dev(N1(vec2(w.x * 0.00043, 21.7), 0.00043)) * 1.9);
    drape = sat(0.24 + dip * 1.6) * driftN * (1.0 - sat(abs(slope) * 1.5)) * kill2.y;
    drape *= 1.0 - sat(into / (55.0 + 240.0 * driftN));
    // Mean factor 0.98, so the drape's average albedo does not move; the swing
    // either side of it is what the eye reads a grain size from.
    alb  = mix(alb, (0.92 + 0.30 * fine) * (0.70 + 0.56 * sat(rpp * 0.5 + 0.5)),
               drape * 0.80);
    body = mix(body, uCSilt, drape * 0.70);
  }

  // No ambient floor on the body: deep inside the mass the only light is what
  // the bedding planes and the joints carry. That is what lets this read as
  // layered rock rather than as a hole punched in the frame - a black mass with
  // legible seams has more material in it than a mid-grey mass with faint ones.
  // The previous version needed a 0.115 ambient term to keep a roof-filling
  // frame from going flat, and paid for it with the frame's blacks.
  // A ROOF IS BACKLIT. The light that comes down through a fissure travels PAST
  // the rock beside it and on into the trench; what reaches a downward-facing
  // face is only the fraction the water below bounces back up. Giving a ceiling
  // the same irradiance as a floor is what kept the one frame with a ceiling
  // across the top of it from ever containing a black pixel: at 16m the roof
  // sits 60 units above the top of the frame, so sky there is near its maximum
  // and the rock was drawn at full albedo - the brightest unlit surface in the
  // game. The seam, rim and lamp terms below are deliberately left alone, so
  // the roof does not become a hole punched in the frame; it becomes a black
  // mass with legible bedding in it, which is what the rest of this file is
  // built on.
  // ROCK AND WATER WERE THE SAME VALUE. medium() responds to the light field as
  // pow(sky, 2.15) - that exponent is what stops the water bulk marching into
  // the midtones - but rock took sky LINEARLY. At shallow depth, where sky sits
  // around 0.37 across the whole frame, that puts rock at 0.028 * 1.5 * 0.37 =
  // 0.0116 linear and water at 0.104 * 0.37^2.15 = 0.0123. Identical. A trench
  // whose walls are exactly as bright as the water in front of them has no
  // silhouette anywhere in it, which is why the shallowest frame in the game -
  // the first one a player ever sees - measured 90% of its pixels inside 32
  // code values with nothing at all below L8.
  //
  // Putting rock on the same response curve as the medium is the fix, and it is
  // the physically consistent choice: both are being lit by one field, so both
  // have to answer to it the same way. A slightly gentler exponent than the
  // medium's, so that deep rock keeps a little more than the water around it
  // and the mass stays legible rather than becoming a hole.
  float skyR = pow(sky, 1.70);
  float irr = roof ? (0.003 + 0.105 * skyR) : (0.010 + 0.990 * skyR);
  // ...plus the water's own glow, which in a sealed reach is the only light
  // this rock gets at all. Small, and it rides the cloud field, so it models
  // the mass rather than lifting it: rock is still the frame's black.
  irr += 0.15 * amb;
  vec3 lamp = lampLight(w, roof ? 1.0 : -1.0);
  vec3 c = body * V_ROCK * alb * exp(-into / 205.0) * irr;
  // A ROOF SEEN FROM UNDER IT IS A SURFACE, NOT A SOLID. 'into' is distance
  // behind the drawn silhouette, and at the top of frame that is a thousand
  // units - so exp(-into/205) put the entire receding ceiling at two percent of
  // its edge value. Painted white, the near rock took a fast frame from 40% of
  // its pixels below sRGB 8 to 16%: the ceiling alone was twenty-four points of
  // deleted geometry, and it is where the stalactite field and the bedding the
  // review asked for actually live. Zero for the first 260 units, so the
  // foreground buttress the review praised keeps its black edge, and carried by
  // alb so what comes back is strata and joints rather than a grey plate.
  float deep = sat((into - 55.0) / 380.0);
  vec3 gr = body * V_ROCK * alb * 2.50 * deep * (0.10 + 0.90 * glowM);
  c = sqrt(c * c + gr * gr);
  // A lamp arrives from one side, so a few tens of units of rock swallow it -
  // it must not reach as deep as the diffuse sky does, or the whole mass lifts.
  c += body * V_ROCK * alb * exp(-into / 62.0) * lamp * 2.6;
  // Bedding planes catch the little light there is, far into the mass. Reaches
  // four times deeper than the body term, which is what keeps the strata the
  // last thing to disappear rather than the first.
  c += body * V_ROCK * 0.66 * seam * (0.09 + 0.91 * sky) * exp(-into / 840.0);
  // A parting plane is a gap, so it carries a lamp further in than the body.
  c += body * V_ROCK * 1.10 * seam * lamp * exp(-into / 180.0);

  // Tight core plus a small skirt. A wide skirt is pure p90 cost: it triples
  // the lit area for a highlight the eye reads entirely from its inner edge.
  // Broken along its length by the rock's own fine grain - free, since strata
  // already fetched it. A constant-width, constant-brightness edge glow is the
  // clearest tell of a shader filter rather than light landing on rock.
  // Broken along its length by the rock own fine grain, and stepped by the
  // bedding: a resistant cap outcrops and takes the grazing light, a parting is
  // a recess that does not, and a joint is a shadow straight across the edge.
  // Without those three the rim is a constant-width constant-brightness band,
  // which is the clearest tell of a shader filter rather than light on rock.
  float rim = (exp(-into / 17.0) + 0.20 * exp(-into / 48.0)) * (0.28 + 1.40 * fine)
            * (1.0 + 0.95 * bedf.x) * (1.0 - 0.62 * bedf.y);
  // The edge nearest a lamp is the brightest rock in the frame, and it is what
  // reads the silhouette out of the dark for the player.
  c += body * V_RIM * rim * lamp * 0.40;

  if(roof){
    // Backlit underside. What light it has is bounced up off the water plus the
    // glow leaking around the fissures beside it, so the edge lights up exactly
    // where the roof is broken - which is where the beams are too.
    c += uCHigh * V_RIM * rim * (0.26 + 1.05 * open) * 0.44;
    c += uCSurf * V_RIM * rim * sat(abs(slope) * 1.5) * 0.16 * sky;
  } else {
    // Gated only SOFTLY on the drape. Hard-gated on it the ripples vanish over
    // every convex stretch of floor - drape needs a hollow and a shallow slope
    // - and that is most of what a frame shows. Bare rock on a trench floor is
    // swept by the same current and carries the same scour, just less of it.
    // Reaches 34 units in, not 12: the floor's entire lit zone is the 17-unit
    // rim, so a texture confined tighter than that has nowhere to be read.
    float crest = sat(rpp) * (0.30 + 0.70 * drape) * exp(-into / 34.0) * kill2.y;
    // Upward-facing: takes the beam directly, and takes its caustic net. Broken
    // by the ripple field, so the brightest line in the lower frame is a chain
    // of separately lit crests instead of one smooth stroke along a curve.
    c += uCSurf * V_RIM * rim * sky * (0.45 + 1.15 * caus)
       * (0.58 + 0.72 * sat(rpp * 0.55 + 0.5));
    c += uCSurf * V_SHAFT * 0.20 * exp(-into / 70.0) * sky * caus;
    // The lit surface of a drift. A sediment face is the one thing down here
    // that behaves like a diffuse Lambertian surface, so it is where the
    // downwelling light is legible as a direction rather than as a haze. Its
    // broad level is down and the difference has gone into the crests: a lee
    // slope holds almost no light, and that alternation is what gives the floor
    // a grain size instead of a value.
    c += uCSilt * V_SILT * 1.05 * drape * exp(-into / 46.0)
       * pow(sat(sky * 2.2), 1.2) * (0.42 + 1.30 * sat(rpp * 0.5 + 0.5));
    // The crest tops. Narrow, and the only part of the floor that faces the
    // light squarely, so it is the one place the seabed is allowed a highlight -
    // bought with contrast against the lee slope beside it rather than by
    // lifting the whole band.
    //
    // Lit by the sky where there is any and by the mote and the anchors where
    // there is not, which is most of the trench floor: it lies deepest under the
    // roof, so sky() there is near zero and a crest keyed to sky alone stayed
    // invisible in exactly the frames where the seabed fills the lower third.
    // A raking lamp across a rippled surface is also the strongest texture cue
    // available at this depth, and it comes for free - lamp is already in hand.
    c += (uCSurf * pow(sat(sky * 2.4), 1.1) * (0.40 + 0.80 * caus) * 1.80
          + lamp * 3.20 + body * (0.06 + 0.94 * seam) * 0.55)
       * V_SILT * 3.00 * crest * (0.45 + 0.90 * fine);
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
             float fog, vec3 haze, float cloud, float awN, float veilK,
             float glowM, float brk){
  vec2 w = toLayer(uv, s);
  // A layer at apparent scale s covers 1/s times more world per pixel, so its
  // fetches want a coarser mip than the near plane by exactly that factor.
  float pxL = pxWorld() / s;
  vec4 na = Nz(vec2(w.x * 0.0000630 + seed, seed * 0.37), 0.0000630, pxL);
  vec4 nb = Nz(vec2(w.x * 0.0001970 + seed * 1.7, seed * 0.83), 0.0001970, pxL);
  float nT = sat(0.5 + (dev(na.r) * 1.00 + dev(na.g) * 0.34 + dev(nb.b) * 0.12) * GAIN);
  float nB = sat(0.5 + (dev(na.b) * 0.95 + dev(nb.g) * 0.38 + dev(nb.a) * 0.14) * GAIN);
  // Terrace it. Sedimentary rock erodes into benches with steep risers between
  // them; a smooth noise profile reads as a procedural mountain range, which is
  // the wrong landform entirely for the inside of a canyon. Most of the
  // terracing is done below by snapping to the bedding grid, so this only has
  // to add sub-bed steps.
  nT = mix(nT, floor(nT * 6.0) / 6.0 + smoothstep(0.58, 1.0, fract(nT * 6.0)) / 6.0, 0.34);
  nB = mix(nB, floor(nB * 5.0) / 5.0 + smoothstep(0.58, 1.0, fract(nB * 5.0)) / 5.0, 0.34);
  float top = -openT - nT * amp;
  float bot =  openB + nB * amp * 0.92;
  float soft = (uViewSize.y * 0.0055) / s;
  // Conservative reject BEFORE the bedding snap and its trig. The snap can move
  // a profile by at most half a bed and the pendants hang at most 520 units, so
  // nothing further inside the open band than that can become covered. This is
  // what keeps the snap off the open water, which is most of the frame.
  float marg = BEDY * 0.55 + 520.0 * brk + soft;
  if(top - w.y < -marg && w.y - bot < -marg) return vec4(0.0);

  // A bench does not form at an arbitrary height: it forms where a resistant
  // bed outcrops. Snap the profile to the SAME warped bedding grid the near
  // rock uses - same world spacing, so perspective shrinks it correctly - and a
  // riser on a far wall lines up with a bed on the near wall. That shared
  // horizon is the whole difference between four parallax layers and one
  // geological formation seen at four distances.
  float tiltF = bedTilt(w.x, pxL);
  top = mix(top, snapBed(top, tiltF), 0.62);
  bot = mix(bot, snapBed(bot, tiltF), 0.62);

  // Pendants and spires. The roof of this trench grows teeth and the floor
  // grows pinnacles, at every distance, because sharing the feature across the
  // layers is what makes them read as one formation seen four times. It is also
  // what puts something in the upper third of a shallow frame, which measured
  // as the emptiest region of the image.
  float pu = w.x / 300.0 + seed;
  float ph = hash11(floor(pu) * 2.13 + 7.7);
  if(ph > 0.42) top += brk * (110.0 + ph * 380.0)
                     * pow(sat(1.0 - abs(fract(pu) - 0.20 - ph * 0.55) / (0.040 + ph * 0.075)), 1.7);
  float su = w.x / 262.0 + seed * 1.7;
  float sh = hash11(floor(su) * 3.71 + 2.9);
  if(sh > 0.55) bot -= brk * (80.0 + sh * 250.0)
                     * pow(sat(1.0 - abs(fract(su) - 0.25 - sh * 0.48) / (0.045 + sh * 0.070)), 1.8);

  float dT = top - w.y, dB = w.y - bot;
  float cov = max(sat(dT / soft), sat(dB / soft));
  if(cov < 0.004) return vec4(0.0);

  bool roof = dT > dB;
  // A layer's world is 1/s times larger, so every length inside it must be read
  // back into near-plane units. Not doing that is what made these walls
  // invisible: the body falloff was evaluating exp(-3060/361) where it should
  // have been exp(-413/420), so the rock collapsed to its ambient term and the
  // rim vanished entirely, leaving four layers that differed from the haze by
  // a few percent. Coverage was always correct; only the shading was wrong.
  float intoS  = (roof ? dT : dB) * s;
  float belowS = max(0.0, w.y - top) * s;
  // Cheap sky: a distant wall needs value and contrast, not beam accuracy.
  float sky = (0.07 + 0.26 * nT) * exp(-belowS / 1400.0);
  // Same bed index and the same hash as strata(), so bed N is the same shade of
  // rock at every distance.
  float syF = bedFrom(w.y + tiltF);
  float alb = 0.55 + 1.00 * hash11(floor(syF) * 1.37 + 0.5);
  // VERTICAL STRIATION, and it is the one kind of structure that costs the
  // frame no level: a joint is a shadow, so a wall that gains legibility this
  // way gains blacks with it rather than spending them. Same sheared level-set
  // and the same 186-unit spacing as joints() on the near rock, so one fracture
  // set runs through all five planes and perspective shrinks it correctly.
  // No fetch - a wave() shear instead - because this runs four times a pixel.
  float jsx = (w.x + w.y * 0.22) / 186.0 + wave(w.y, 0.00130, 3.1 + seed) * 0.30;
  float jh = hash11(floor(jsx) * 3.17 + 1.9);
  float jnt = 0.0;
  if(jh > 0.44){
    float jd = abs(fract(jsx) - 0.5 + (jh - 0.5) * 0.42);
    float jt = 0.020 + jh * 0.032;
    jnt = exp(-(jd * jd) / (jt * jt));
  }
  alb *= 1.0 - 0.88 * jnt;
  vec3 rk = mix(ROCK_COOL, ROCK_WARM, 0.30);
  // Same response curve as the near rock and the medium - see irr in
  // trenchRock. These four layers fill the top and the bottom of every shallow
  // frame, so whatever they are worth IS the value structure of that frame, and
  // on a linear response they were landing within 14% of the water they sit in.
  // The glow lights this wall too, and it is gated on THIS wall's darkness,
  // not on the near plane's: a layer four deep is somewhere else in the world,
  // and gating it by the light over the player's own head left whole receding
  // planes black in frames whose foreground was lit.
  float aw = awN;
  // A DISTANT WALL DOES NOT HAVE AN INTERIOR. The body falloff was authored
  // for the near plane, where 'into' is a few hundred units; at s = 0.58 a
  // pixel two thousand units inside the mass reads intoS = 1160 and the term
  // collapsed to four percent of its edge value. Painted white, these four
  // layers took a fast frame from 43% of its pixels below sRGB 8 to 3% - they
  // ARE the black slab the review found, and every one of them is a plane the
  // level artist built. The floor is what the eye actually sees at that
  // distance: a surface, not a solid. What it is worth still rides the cloud
  // field through 'aw', so it models the plane rather than lifting it.
  // Two responses, not one, and the split is the whole point. The SKY-lit part
  // keeps the near plane's steep body falloff, so where the glow is absent this
  // wall is exactly the near-black it was. The GLOW-lit part gets a far
  // surface's floor instead: at s = 0.58 a pixel two thousand units inside the
  // mass reads intoS = 1160 and a falloff authored for the near plane collapses
  // it to four percent of its edge - which is why these four layers, painted
  // white, took a fast frame from 43% of its pixels below sRGB 8 to 3%. They
  // ARE the black slab the review found, and every one is a plane the level
  // artist built. Folding the floor into both halves instead of one was a
  // pedestal and measured like one: a tethered frame went milky, 14% blacks to
  // 6%, because the sky term got the floor too.
  float bodyF = 0.045 + 0.955 * exp(-intoS / 380.0);
  vec3 c = rk * V_ROCK * alb
         * (bodyF * (0.015 + 0.985 * pow(sky, 1.70))
            + (0.46 + 0.54 * exp(-intoS / 380.0)) * 0.55 * aw);
  // The bedding seam, at distance. Four layers of legible strata is most of
  // what makes the far walls read as rock instead of as tinted fog, and it
  // costs nothing: the bed coordinate is already in hand.
  float bfF = fract(syF);
  float sw = max(0.11, 2.0 * pxL / BEDY);
  c += rk * V_ROCK * 0.50 * (0.11 / sw) * (1.0 - smoothstep(0.0, sw, min(bfF, 1.0 - bfF)))
     * (sky + 1.10 * aw) * exp(-intoS / 650.0);
  // Aerial perspective is the fog toward the local haze, full stop. Stacking an
  // absorb() on top of it just annihilated the rock and fought the same effect.
  // BACKSCATTER, and the reason a receding plane read as a black slab. The
  // water between the eye and a wall four layers back is itself lit, so a
  // distant surface cannot reach the black a near buttress does. Keyed to the
  // LAYER'S OWN DISTANCE, which is what makes it a depth cue and not a lift:
  // the near rock gets none of it, the open water gets none of it, and what is
  // left is the separation between a black foreground wedge and the plane
  // behind it. Measured, the top quarter of a fast frame is layer four and it
  // was arriving at linear 0.002 against the 0.007 that encodes to sRGB 8.
  vec3 o = mix(c, haze + uCMid * V_VEIL * pow(1.0 - s, 1.6) * veilK, fog);
  // A FLOOR, NOT AN ADDITION, and this is the shape the exposure contract
  // actually asks for. An additive lift moves a pixel already sitting a hair
  // under sRGB 8 as easily as one sitting five times lower, so it strips a lit
  // frame of three quarters of its blacks while a sealed frame - whose blacks
  // are genuinely deep - barely moves. A floor inside a mask lifts a fixed
  // FRACTION OF AREA instead, which is the only shape that fits both ends at
  // once: 'fast' has to give up a third of its blacks and 'tethered' can afford
  // four tenths, and a mask covering about that much of the frame does both.
  // Soft-maxed rather than min'd, so the crossing is a curve and not a contour.
  vec3 gl = uCMid * V_GLOW * pow(1.0 - s, 0.55) * glowM;
  o = sqrt(o * o + gl * gl);
  o += uCHigh * V_FARRIM * sky * (roof ? 0.40 : 1.00) * (1.0 - fog)
     * (exp(-intoS / 20.0) + 0.20 * exp(-intoS / 46.0));
  return vec4(o, cov);
}

// Caustic net: two drifting fields ridged against each other. Only ever applied
// where a beam actually lands, so it reads as the beam's footprint.
float caustic(vec2 w){
  const float S = 0.0023;
  vec2 p = w * S;
  vec4 a = N(p * 0.90 + vec2(uTime * 0.0110, uTime * 0.0072), S * 0.90);
  vec4 b = N(p * 1.73 - vec2(uTime * 0.0148, uTime * 0.0051), S * 1.73);
  float r1 = 1.0 - abs(a.r + b.g - 1.0) * 2.1;
  float r2 = 1.0 - abs(a.g + b.r - 1.0) * 2.7;
  return pow(sat(r1), 3.0) * 0.72 + pow(sat(r2), 4.0) * 0.52;
}

void main(){
  vec2 uv = vUv;
  vec2 w  = toWorld(uv);
  vec2 bdN = bandAt(w.x);
  float px = uViewSize.x / max(uRes.x, 1.0);       // world units per pixel

  // Slow currents wobbling the whole medium, so nothing sits perfectly still.
  vec4 fl = N(vec2(w.x * 0.00021 + uTime * 0.0040, w.y * 0.00033 - uTime * 0.0026), 0.00033);
  vec2 flow = vec2(fl.r - 0.5, fl.g - 0.5);

  // ---------- lighting, once, for everything ----------
  float below   = max(0.0, w.y - bdN.x);           // how deep under the roof
  float traceX  = w.x - SUN_SLANT * below;         // trace the ray back up
  float raw     = roofRaw(traceX);
  // THE DRAWN ROOF OCCLUDES. roofRaw is a statistical openness field that knows
  // nothing about the profile the player can actually see, so a point tucked
  // under a 600-unit lobe of rock received exactly as much light as one under an
  // open fissure at the same depth. Deep in the trench that hides, because
  // below is large and everything down there is dim anyway. In the SHALLOW band
  // it is the whole image: the roof is close, so exp(-below/1150) is near 1 and
  // the open/sealed threshold is at its sharpest, and the result was the
  // brightest and flattest water in the game sitting behind the first frame a
  // player ever sees - 90% of it inside 32 code values with nothing below L8.
  //
  // Two taps along the ray, against the same strip the physics uses, so the
  // shadow belongs to rock that is on screen rather than to a field nobody can
  // see. A positive tuck means the roof up-sun hangs LOWER than the roof
  // overhead, which is exactly the case where the slanted ray had to come
  // through it to get here.
  float occl = (1.0 - 0.52 * smoothstep(15.0, 230.0, bandAt(traceX * 0.45 + w.x * 0.55).x - bdN.x))
             * (1.0 - 0.52 * smoothstep(15.0, 230.0, bandAt(traceX).x - bdN.x));
  float sky     = skyAt(below, raw) * occl;
  float openSft = openAt(raw, 1.0);
  float openShp = openAt(raw, sat(below / 2600.0) * 0.24);

  float causW = smoothstep(0.020, 0.095, sky);
  float caus = causW > 0.0 ? caustic(w) * causW : 0.0;

  // ---------- the water's own light ----------
  // Under a sealed reach of roof the downwelling term is worth 0.0009 linear -
  // eight times under what encodes to sRGB 8 - so a frame with no fissure over
  // it had no water in it at all: half of 'fast' measured below L8 on both
  // seeds, and what the eye reads there is not darkness, it is absence. An
  // abyss is not empty; it is lit from the inside.
  //
  // CLOUDS, WITH REAL WATER BETWEEN THEM. Thresholded rather than floored,
  // because a floor under this is a pedestal and behaves like one. Thresholded,
  // the same mean buys mottling: the troughs stay at the medium's own near-zero
  // and are the frame's black point, the clouds carry value, and the boundary
  // between them is a shape instead of a level. Coverage is the whole design
  // parameter - it decides what FRACTION of a frame's blacks survive, and the
  // two ends of the exposure contract only both fit if that fraction is about
  // three fifths.
  //
  // Mid-heavy octaves - 600 and 300 world units, several per screen - because
  // with the coarsest octave dominant a whole frame lands inside one trough,
  // and the left third of 'fast' did, on both seeds.
  float bioC = sat(0.5 + (dev(fl.g) * 0.55 + dev(fl.b) * 1.00
                        + dev(fl.a) * 0.62) * GAIN);
  float cloud = smoothstep(0.25, 0.68, bioC);
  // Gated on darkness: it fades out wherever the sky already arrives, so it
  // costs nothing in the lit halls, cannot raise p90, and never competes with
  // the hero because it only exists in the parts of the frame he is not in.
  // The gate has to run out where the WATER clears sRGB 8 on its own, near
  // sky 0.33; cut short at 0.125 it left a band of trench too lit to glow and
  // too dark to see, which is where the left third of 'fast' was living.
  float unlit = 1.0 - sat(sky * 3.0);
  // The mote's own lantern drowns it. Without this the haze fills the annulus
  // the focal metric reads and the hero loses his surround contrast.
  vec2 dpl = w - uLights[0].xy;
  float own = dot(dpl, dpl) / (dot(dpl, dpl) + 72000.0);
  float amb = cloud * cloud * unlit * unlit * own;
  // What the far layers get. A PARTIAL floor under the cloud, because a far
  // wall's own 'sky' in this file is a statistical stand-in that knows nothing
  // about whether the trench overhead is actually open - so gating those four
  // planes on the cloud alone left them at the mercy of where the noise fell,
  // and the left half of a fast frame stayed a slab on both seeds. Gated
  // instead on the REAL darkness over the player's head, which is the thing
  // that decides whether a receding plane has any light on it at all.
  float awN = (0.32 + 0.68 * cloud) * unlit * unlit;
  // ...and the veil in front of them takes the same gate. Ungated it is the one
  // term in the pass that lifts water which is ALREADY nearly at sRGB 8, and
  // that is the whole population a lit frame's blacks are drawn from: a
  // tethered frame lost three quarters of its blacks to this alone while a
  // sealed one, whose blacks sit five times lower, barely moved.
  float veilK = cloud * unlit;
  // The mask the floor works inside. Its COVERAGE is the design parameter - it
  // decides what fraction of a frame's blacks survive - so it is authored as a
  // threshold on the cloud field and nothing else.
  float glowM = cloud * (0.58 + 0.42 * unlit);

  // ---------- the water column ----------
  vec3 col = medium(w.y, sky);
  vec3 gw = mix(mediumHue(depthOf(w.y)), BIO_MINT, 0.30) * V_ABYSS * cloud * unlit * own;
  col = sqrt(col * col + gw * gw);

  // Contact shadow. A wall shades the water in front of it, and that band is
  // the one place the medium is allowed to be darker than the medium. It is
  // also where a frame's blacks belong - packed against a silhouette, where
  // they read as occlusion - rather than spread through the bulk, where they
  // read as absence. Only inside the swimmable band: above the roofline the
  // same expression would darken the far planes this pass just recovered.
  float wallD = min(w.y - bdN.x, bdN.y - w.y);
  col *= 1.0 - 0.62 * exp(-max(wallD, 0.0) / 110.0) * step(0.0, wallD);

  // Thermocline: real water is layered, and the layers show as faint
  // interfaces - but only where there is light to catch them.
  vec4 tn = N(vec2(w.x * 0.00026, uTime * 0.009), 0.00026);
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
  float brk = uKill2.w;
  vec4 r4 = farWall(uv, 0.135, 4.3,  1060.0, 880.0, 980.0, 0.560, haze, cloud, awN, veilK, glowM, brk);
  col = mix(col, r4.rgb, r4.a * uKill2.x);
  vec4 r3 = farWall(uv, 0.225, 19.7,  980.0, 790.0, 900.0, 0.440, haze, cloud, awN, veilK, glowM, brk);
  col = mix(col, r3.rgb, r3.a * uKill2.x);
  vec4 r2 = farWall(uv, 0.360, 37.1,  920.0, 730.0, 800.0, 0.300, haze, cloud, awN, veilK, glowM, brk);
  col = mix(col, r2.rgb, r2.a * uKill2.x);
  vec4 r1 = farWall(uv, 0.580, 61.9,  880.0, 690.0, 720.0, 0.175, haze, cloud, awN, veilK, glowM, brk);
  col = mix(col, r1.rgb, r1.a * uKill2.x);

  // ---------- volumetric light from the surface far above ----------
  // The roof is opaque, so light only arrives through the fissures. Ramped off
  // at the roofline so a beam never appears inside the rock.
  float ramp = smoothstep(0.0, 240.0, below);
  // Per-shaft variance. Every shaft used to come off one threshold pair on one
  // field, so they all shared a width, a peak, an edge and a lean - a repeated
  // element, which reads as wallpaper rather than as light. Four decorrelated
  // drivers at roughly a third of the slot frequency: adjacent shafts differ,
  // and because the modulation is continuous there is no seam inside a shaft.
  float vLean = wave(traceX, 0.00026, 0.7);
  float vWide = wave(traceX, 0.00023, 2.9);
  float vPeak = wave(traceX, 0.00031, 5.1);
  float vLive = wave(traceX, 0.00019, 1.3);
  // Within an open hall the roof is broken into separate slots. Without this
  // high-frequency lateral term the 'beam' is one 400-pixel smudge: the hall
  // field's correlation length is ~800 world units, so thresholding it can only
  // ever produce a soft blob. The hall decides WHERE light gets in; the slots
  // carve it into individual shafts. 333 / 167 / 83 world units - shaft scale.
  // Each fissure is its own shape, so the beam it casts gets its own slant on
  // top of the mean one. Shafts that are not parallel is most of the cue.
  float slotX = traceX - below * SUN_SLANT * vLean * 0.55;
  vec4 sl = N(vec2(slotX * 0.00075, 0.31), 0.00075);
  // A sparse MASK, not a smooth field, and it needs its own much lower gain:
  // at this sampling frequency GAIN saturates the field, so the mask measured
  // 'on' 50% of the time and every bit of core brightness also lifted the whole
  // hall - the bulk went 0.02 -> 0.19 on one edit. Measured at gain 1.3 with
  // this threshold: mean 0.089, on 6% of x, shafts ~150 world units wide.
  float slotRaw = sat(0.5 + (dev(sl.r) * 1.20 + dev(sl.g) * 0.75 + dev(sl.b) * 0.40) * 1.30);
  // Width and edge softness come off the EXPONENT, not off the threshold pair.
  // Moving the threshold would change how much of x is lit at all, and the
  // entire bulk budget is tuned against that coverage; the exponent only
  // reshapes a shaft that is already there, so the mean barely moves.
  float sm = smoothstep(0.69, 0.99, slotRaw);
  // A fissure is not a slit of uniform transmission, so the beam it casts is
  // striated along its width. The product of two incommensurate waves gives
  // bands that are themselves unevenly spaced.
  float stri = 0.72 + 0.44 * wave(slotX, 0.0047, 1.9) * wave(slotX, 0.0131, 5.3);
  // A BEAM HAS A CORE; A SLAB HAS ONE VALUE ACROSS ITS WIDTH. This was a single
  // power of the slot field, which is flat near its top and steep at its skirt
  // - the wrong way round for a beam - and it measured as exactly that: slabs
  // of near-uniform teal 300 pixels wide whose 80-unit blocks carried 9.6 units
  // of highlight energy against the mote's 5.5, so the hero ranked 26th of 336
  // in its own frame and a player scanning a still could not find himself.
  //
  // Splitting the profile fixes the hierarchy without dimming the light: a wide
  // body at a little over half the old value, plus a narrow ridge that keeps
  // the old peak. Every pixel away from a shaft centre loses 45-70%, the peak
  // itself does not move - so the p99 the exposure contract asks for is
  // untouched, and so is the bloom seed - and the shaft gains a middle, which
  // is the whole difference between light and fog. Contrast, not level: the
  // same rule the rock in this file is built on, applied to the light at last.
  float sBody  = pow(sm, 3.30 + vWide * 0.90);
  float sRidge = pow(sm, 11.0 + vWide * 3.00);
  // A NARROW APERTURE COLLIMATES; A WIDE ONE ONLY SPILLS. sRidge is the beam's
  // core, and how much core a beam gets is a property of the hole it came
  // through: a slot in a sealed roof throws a hard shaft, a broadly open roof
  // throws a wash with no core at all. openSft is that roof measured wide, so
  // this is the one term in the pass that can tell the shallow reach - roof
  // shut, one fissure carrying the whole light source - from an open hall
  // where the water is lit from every direction at once.
  //
  // It has to be gated, because the flat version of this is measurably wrong.
  // sm^11 SATURATES wherever the roof is fully open: at 483m it sits near 1.0
  // while at 16m it only reaches 0.31, so a plain coefficient is three times
  // stronger in the frame that least needs it. Raising it flat to 1.45 bought
  // the opening frame 0.011 of luminance spread and pushed the mote from 9th
  // to 29th most salient block in the Hush frame - paying for the first frame
  // with the one the hierarchy ceiling was built to protect. Gated, the same
  // spread costs nothing there, and the Hush frame gains a place instead.
  float seal = smoothstep(0.72, 0.34, openSft);
  float slot = (0.48 * sBody + (0.62 + 1.00 * seal) * sRidge) * (1.0 + vPeak * 0.45) * stri;
  float shim = 0.72 + 0.34 * sin(traceX * 0.0079 + uTime * 0.42 + vPeak * 2.6)
                          * sin(traceX * 0.0215 - uTime * 0.27 + below * 0.0026);
  // The 0.26 was a floor UNDER the whole beam: a shaft stayed a quarter lit
  // through the clean water between sediment blooms, which is the difference
  // between a beam carrying dust and a beam painted on. Dropping the floor and
  // giving it back to the modulation holds the mean and deepens the gaps.
  float dust = 0.19 + 1.19 * sat(0.5 + dev(N1(vec2(w.x * 0.00092 + flow.x * 0.05,
                                     w.y * 0.00165 - uTime * 0.028), 0.00165)) * 2.1);
  // A second, finer scale of the same thing. One octave of blotches reads as a
  // soft cloud; two read as sediment drifting through a beam. The amplitudes are
  // trimmed from 1.24/0.54: two octaves multiplying out at 1.86 set how hot the
  // hottest BROAD pixel in the frame got, and it was hotter than anything the
  // eye is meant to be led to. Trimming the tops costs 5% of the mean and 20%
  // of the peak, which is the right trade every time.
  dust *= 0.70 + 0.52 * sat(0.5 + dev(N1(vec2(w.x * 0.0041 - flow.y * 0.04,
                                     w.y * 0.0067 - uTime * 0.075), 0.0067)) * 2.0);
  vec3 beamHue = absorb(uCSurf, below * 0.55 + 300.0);
  // Extinction varies per shaft too: some reach the floor, some are spent
  // halfway down. Uniform reach is what makes a beam field look printed on.
  vec3 rays = beamHue * V_SHAFT * openShp * slot * ramp * shim * dust
            * exp(-below / (1300.0 * (1.0 + vLive * 0.42)));
  // The wide in-scatter halo either side of each beam.
  rays += uCHigh * V_SHAFT * 0.004 * openSft * ramp * exp(-below / 2400.0);
  // Caustic banding inside the beam - the shimmer that says 'moving water'.
  rays += beamHue * V_SHAFT * 0.32 * openShp * slot * ramp * caus * exp(-below / 1900.0);
  // The mouth of the fissure. The beam ramps OFF at the roofline so it can
  // never be drawn inside rock, which left the brightest part of the whole
  // light path - the opening itself - as one of the darkest things in the
  // frame, and the upper third of a shallow frame with nothing in it at all.
  // This is in-scatter in the throat, so it is allowed right up to the rock.
  // The constant was 0.30: every open throat glowed that much whether or not
  // a shaft was coming out of it, which is a lamp in the ceiling rather than
  // in-scatter in a beam. Most of it now rides the slot that earns it.
  rays += absorb(uCSurf, 240.0) * V_SHAFT * 0.21 * openShp * (0.17 + 0.85 * slot)
        * exp(-below / 380.0) * smoothstep(0.0, 55.0, below);
  rays *= uKill.y;
  col += rays;

  // ---------- hydrothermal vents ----------
  // One cell per vent, placed clear of the boundaries so a single lookup does.
  // The plume is a buoyant, entraining column, not a cone: it leans, it breaks
  // into puffs advected upward with the flow, and it loses coherence with
  // height until it is indistinguishable from the water it has mixed into. The
  // cone it replaces read as a hard-edged triangle with an airbrush inside it.
  float vent = 0.0, ventHot = 0.0;
  {
    const float CELL = 1150.0;
    float ci = floor(w.x / CELL);
    float h1 = hash11(ci * 0.7317 + 3.7);
    if(h1 > 0.34){
      float vx = (ci + 0.5 + (h1 - 0.5) * 0.52) * CELL;
      float hgt = bandAt(vx).y - w.y;          // height above the floor
      if(hgt > -90.0 && hgt < 2600.0){
        float hh = max(hgt, 0.0);
        float wx0 = w.x - vx;
        // The lean is capped: uncapped, it walks the plume past its own cell
        // window and the window then clips it into a full-height vertical seam.
        float lean = wave(hh, 0.00185, ci * 2.7) * min(26.0 + hh * 0.16, 200.0);
        float rad = 22.0 + hh * 0.255;
        float q = (wx0 - lean) / rad;
        // Puffs, advected upward, so the structure rises with the plume instead
        // of scrolling across it - the difference between a fluid and a texture.
        float rise = uTime * 34.0;
        vec4 pf = N(vec2(w.x * 0.0037 + ci, (w.y + rise) * 0.00225), 0.0037);
        vec4 pg = N(vec2(w.x * 0.0113 - ci, (w.y + rise * 1.6) * 0.00720), 0.0113);
        float puff = sat(0.5 + (dev(pf.r) * 1.00 + dev(pf.g) * 0.55
                              + dev(pg.r) * 0.42 + dev(pg.g) * 0.26) * 1.9);
        // Coherent at the throat, shredded above it.
        float shred = sat(hh / 820.0);
        float core = exp(-q * q * mix(1.0, 0.42, shred));
        // Forced to zero inside its own cell, on both axes, and windowed on
        // WORLD x rather than on the plume-relative one. A single-cell lookup
        // cannot borrow the neighbouring plume, so a plume still bright at the
        // boundary leaves a vertical seam the full height of the frame, and one
        // still bright at its height cut leaves a horizontal one.
        vent = core * (0.30 + 1.45 * puff * (0.45 + 0.55 * shred))
             * exp(-hh / (430.0 + h1 * 640.0))
             * (1.0 - smoothstep(CELL * 0.28, CELL * 0.46, abs(wx0)))
             * (1.0 - smoothstep(1500.0, 2500.0, hh));
        ventHot = exp(-(q * q) * 2.6 - (hh * hh) / 7000.0) * (0.55 + 0.75 * puff);
      }
    }
  }
  vent *= uKill.z; ventHot *= uKill.z;
  // The plume's broad terms are cut about a third. Measured with the kill
  // switches, the vent was the single largest environmental contributor to the
  // opening frame's mean and it lifted the frame's floor as much as its
  // highlights - a haze, not a column. The throat below is untouched, so what
  // is left is the hot part.
  col += absorb(uCSurf, 1400.0) * V_SILT * 1.55 * vent
       * (0.45 + 1.5 * uDraft) * (0.20 + 0.80 * sat(sky * 3.0));
  col += uCSilt * V_SILT * 0.82 * vent;
  col += vec3(1.00, 0.34, 0.085) * V_VENT * ventHot * (0.30 + 0.85 * uDraft);

  // ---------- the rock the physics uses ----------
  // Warped inside a vent plume: heat shimmer bending the silhouette behind it.
  vec2 wr = w + vec2(sin(w.y * 0.021 + uTime * 1.6) * vent * 12.0, vent * 8.0);
  vec4 r0 = trenchRock(wr, sky, amb, glowM, openSft, caus, uKill2);
  col = mix(col, r0.rgb, r0.a);
  col += rays * 0.25 * r0.a;   // the beam still reads across the rock it lands on

  // ---------- suspended silt, hugging the drifts it was lifted from ---------
  // Strictly water-borne, and measured from the DRAWN floor rather than from
  // the collision line, or the relief buries it. Tight scale height and a
  // superlinear gate on sky: as a broad blanket with a sqrt gate this was the
  // single largest contributor to the frame's missing blacks, and it read as
  // fog rather than as sediment.
  float above = (bdN.y - reliefFloor(w.x, brk)) - w.y;
  vec4 sn = N(vec2(w.x * 0.00022 - uTime * 0.0035, w.y * 0.00052 + uTime * 0.0018), 0.00052);
  float billow = sat(0.5 + (dev(sn.r) * 1.00 + dev(sn.g) * 0.50 + dev(sn.b) * 0.28) * 2.1);
  float dens = above > 0.0 ? exp(-above / (26.0 + 155.0 * billow * billow)) : 0.0;
  col += uCSilt * V_SILT * 0.84 * dens * (0.25 + 0.95 * billow)
       * pow(sat(sky * 2.4), 1.4) * (1.0 - r0.a) * uKill2.y;

  // ---------- marine snow, four depths ----------
  float snowKill = 1.0 - r0.a * 0.94;
  float snowLit = V_SNOW * (0.30 + 0.70 * sat(sky * 2.6)) * snowKill;
  for(int L = 0; L < 4; L++){
    float fp = float(L);
    float par = 0.30 + fp * 0.24;
    float sc = 0.0058 + fp * 0.0030;               // cells per world unit
    vec2 g = toDrift(uv, par) * sc;
    g.y -= uTime * (0.018 + fp * 0.016);
    g.x += flow.x * 0.26 + sin(uTime * 0.055 + fp * 2.1) * 0.08;
    vec2 cell = floor(g), f = fract(g);
    float hs = hash12(cell + fp * 31.7);
    if(hs > 0.74){
      vec2 c = cellCentre(hash22(cell + fp * 7.3));
      // Speed smear plus a per-fleck aspect, so the field is not a grid of
      // identical circles. Both capped against CELL_GROW: the smear is the term
      // that used to widen the footprint 4.7x and clip every fleck the instant
      // the player got moving.
      vec2 warp = min(vec2(1.0 + uSpeedK * (0.45 + fp * 0.22),
                           0.88 + 0.26 * hash12(cell + 4.1)), vec2(CELL_GROW));
      vec2 dv = (f - c) / warp;
      float q = dot(dv, dv);
      float win = cellWindow(f);
      float tw = 0.55 + 0.45 * sin(uTime * (0.6 + hs * 2.4) + hs * 41.0);
      // A fleck smaller than a pixel does not get fainter, it flickers. Clamp
      // the radius in SCREEN terms - which is also why the far layers are not
      // just scaled copies of the near one.
      float szMin = 1.25 * px * sc;
      float sz = max(0.014 + 0.040 * pow(hash12(cell + 3.7), 2.2), szMin);
      // Smearing conserves light rather than creating it.
      float fall = exp(-q / (sz * sz)) * (0.55 - fp * 0.10) * tw * win
                 * inversesqrt(warp.x);
      // Most flecks are dead matter, only as bright as the light that reaches
      // them. A few are alive and carry their own - which is both what
      // 'bioluminescent trench' means and the only honest way a frame under a
      // sealed stretch of roof gets to have any highlights at all.
      float alive = step(0.888, hash12(cell + fp * 13.9 + 5.1));
      vec3 hue = mix(absorb(uCHigh, 200.0 / max(par, 0.2)),
                     mix(BIO_MINT, BIO_ICE, hash12(cell + 2.3)), alive);
      // A hot pinpoint plus a scattering halo, both sized from the cell budget
      // rather than from the fleck radius. A mote is a mote: the reach comes
      // from being genuinely hot - V_BIO is well above 1.0 - and from the bloom
      // in postfx, not from painting a 100-pixel disc into the background.
      float br = max(0.011 + 0.017 * hash12(cell + 8.9), szMin * 0.85);
      float bfall = (exp(-q / (br * br))
                   + 0.30 * exp(-q / (CELL_RMAX * CELL_RMAX))) * win
                  * (0.60 - fp * 0.10) * tw;
      col += uKill.x * hue * mix(snowLit * fall, V_BIO * (0.45 + 0.95 * tw) * bfall, alive);
    }
  }

  // ---------- in-scattering: bright things sit in the haze they light --------
  for(int i = 0; i < ${MAXL}; i++){
    vec4 Lg = uLights[i];
    if(Lg.z <= 0.0) continue;
    vec2 dl = w - Lg.xy;
    float g = 26000.0 / (dot(dl, dl) + 26000.0);
    col += mix(vec3(0.16, 0.62, 1.00), vec3(1.00, 0.50, 0.16), Lg.w) * g * g * Lg.z * 0.030;
  }

  // ---------- the Hush ----------
  // THE WALL HAS TWO FRONTS AND ONLY ONE OF THEM IS EVER ON SCREEN.
  //
  // uHushX is the annihilation front, where matter stops existing. maxLag holds
  // it 1750-2900 units behind the player and the left edge of frame is only
  // ~710 units behind him, so it sits off screen by a thousand units or more
  // for most of a run. Where it is, is world.js's business; this file cannot
  // compose the antagonist into a frame it is not in.
  //
  // What this file does own is the DRAIN front: the edge of the reach, where
  // the water has begun to lose its motion, then its colour, then its light.
  // That front is the only part of the Hush a player ever composes a frame
  // with, and it was authored as a smooth 1400-unit gradient - which is why a
  // review measuring left-edge luminance across four frames found no consistent
  // value break anywhere and called the antagonist absent from its own key art.
  // A gradient has no edge at any point along it; that is what a gradient is.
  //
  // It now gets everything the annihilation front already had: a ragged profile
  // at three scales, a value break with a hard-ish edge, tendrils licking ahead
  // of it, and a rim where it has taken a silhouette. Same phenomenon, two
  // radii - which is also why the two share their noise fields and their
  // brokenness term rather than being authored twice.
  float dxh = w.x - uHushX;

  // THE WALL IS OFF SCREEN, AND WHERE IT IS, IS LEVEL DESIGN. world.js holds
  // uHushX 1750-2900 units behind the player while the left edge of frame is
  // only ~700-1200 behind him: measured across the named scenes, the left edge
  // sits at dxh 2000-2540 through ordinary play, so the annihilation front is
  // never in shot and no honest term in this file can put it there.
  //
  // Its INFLUENCE is another matter, and that is this file's. Absorption,
  // graded along x and anchored on the real uHushX: the light goes first, then
  // the colour. It MULTIPLIES the finished frame rather than sitting in front
  // of it, so it takes the marine snow and the wall striations with it as it
  // advances - which is the whole difference between a thing and a vignette.
  // And the reach lengthens as the run does, so it is a hint at 25m and has
  // taken the left of frame by 450m.
  float hushK = uKill.w * pow(sat(uDiff * 4.0), 0.70);
  // Ragged, and fetch-free: this runs on every pixel of every frame, not just
  // the ones near the wall, so it cannot afford the noise tap the detailed
  // block below uses. Two incommensurate sinusoids have a known range and cost
  // less than a texture read.
  float reach = 800.0 + 1700.0 * hushK
              + wave(w.y, 0.00058, 0.9) * 210.0
              + pow(sat(0.5 + wave(w.y, 0.00270, 5.1 + uTime * 0.30) * 0.55), 3.0) * 320.0;
  float ed = dxh - reach;
  // Tapered off BEHIND the front, where the block below already owns the
  // crush: stacked, the two took the Hush frame to 38% below sRGB 8 and its
  // spread from 0.221 to 0.173 - a wall of dark with nothing in it.
  float drain = uKill.w * exp(-max(ed, 0.0) / 1150.0)
              * smoothstep(-460.0, -40.0, ed);
  // The leading edge is a RIPPLE in the medium, not a line drawn across it: the
  // water bends before it goes. A review found no consistent value break at any
  // left edge in the set and called the antagonist absent from its own key art;
  // a gradient has no edge at any point along it, which is what a gradient is.
  float lead = uKill.w * exp(-(ed * ed) / 26000.0);
  float rip = wave(w.y + uTime * 26.0, 0.0165, dxh * 0.0022);
  drain = sat(drain * (1.0 + 0.44 * lead * rip));
  {
    float lumD = dot(col, vec3(0.25, 0.62, 0.13));
    col = mix(col, vec3(lumD), sat(0.66 * drain + 0.34 * lead));
    // Takes the midtone, not the cores. A flat multiply here crushed the Hush
    // frame's own highlights and its p95-p20 spread fell from 0.221 to 0.173:
    // the wall of dark has to eat the water and the striations, which is where
    // the dread is, and leave the few hot things in frame to be eaten last.
    float keep = sat(lumD * 2.2);
    col *= 1.0 - 0.66 * drain * (1.0 - 0.74 * keep);
    // What the edge itself is worth. Small: the wall is a mass of dark and only
    // its seam is allowed to be bright, and not brighter than the mote.
    // A MASS OF DARK, not a violet fog. At 0.011 this alone laid a 570-pixel
    // lilac band across the deep frames and the antagonist read as weather.
    col += uCHushGlow * V_HUSH * 0.0029 * lead * (0.45 + 0.55 * sat(rip + 0.5));
  }

  if(dxh < 3000.0 && uKill.w > 0.5){
    // A torn frontier, not a gradient: three scales of writhe along y, plus
    // tongues of nothing licking forward.
    vec4 fr = N(vec2(w.y * 0.00072, uTime * 0.019), 0.00072);
    float front = (dev(fr.r) * 780.0 + dev(fr.g) * 330.0 + dev(fr.b) * 120.0);
    front += pow(sat(0.5 + dev(N1(vec2(w.y * 0.0042 - 3.3, uTime * 0.026), 0.0042)) * 2.4), 4.0) * 620.0;
    float e = dxh - front;

    // Brokenness, at two scales along y. Hoisted out of the seam below because
    // every edge the Hush draws wants it: an unbroken one is a stroked outline,
    // and a stroked outline is the tell that this is a shader and not a thing.
    float rv = 0.30 + 0.80 * N1(vec2(w.y * 0.0031 + 11.0, uTime * 0.048), 0.0031);
    rv *= 0.35 + 0.85 * sat(0.5 + dev(N1(vec2(w.y * 0.00093 - 4.1, uTime * 0.021), 0.00093)) * 2.2);

    // The drain front, ragged the same way the annihilation front is: a smooth
    // scale plus a cubed tongue term that licks forward. Its distance is the
    // Hush's reach, so it moves with the real uHushX and cannot claim a position
    // the wall does not have - at 250m back there is nothing on screen, and that
    // is the honest answer.
    //
    // Measured from dxh, NOT from e. Off e it inherits the annihilation front's
    // own tongues and the two stack: the drained zone reached dxh 3375, its
    // lobes crossed two thirds of the frame, and the break landed on lit water
    // at the right edge. This front is a different phenomenon at a different
    // scale and it gets its own raggedness, which also bounds it.
    float dReach = reach;

    // Behind the front the water is unmade: it goes still, then colourless,
    // then gone. Desaturating before crushing is what makes it read as loss.
    // The interior has to be the DARKEST thing in the frame - a mass of dark
    // whose inside glows is a contradiction, and this one glowed: the far-glow
    // term below had no falloff on the inside, so it laid a constant violet
    // wash over everything behind the front and the wall of dark ended up
    // carrying the frame's brightest pixels while its median sat at a
    // twentieth of them.
    //
    // A PLATEAU AND A BREAK, not a ramp. The interior holds a little over half
    // its value right up to the drain front and then stops inside 155 units,
    // so the boundary is a place rather than a tendency; behind it the slow
    // ramp continues to the wall, which is what gives the dark mass depth
    // instead of making it a flat cutout.
    float drained = 1.0 - smoothstep(-130.0, 25.0, ed);
    float still = drained * (0.56 + 0.44 * (1.0 - smoothstep(0.0, max(dReach, 1.0), max(e, 0.0))));
    float lum0 = dot(col, vec3(0.25, 0.62, 0.13));
    col = mix(col, mix(col, vec3(lum0), 0.72) * 0.10, still * 0.94);

    // The rim on the drain front. Faint on purpose - the wall is a mass of dark
    // and this is the only edge it gets - and several times stronger where r0
    // covers, because that is the front visibly consuming a silhouette rather
    // than merely dimming water. Half-way to the edge hue rather than the glow
    // violet: water this far gone has lost most of its colour.
    col += mix(uCHushGlow, uCHush, 0.45) * V_HUSH * (0.018 + 0.055 * r0.a)
         * exp(-(ed * ed) / 15000.0) * rv;

    float inside = 1.0 - smoothstep(-60.0, 40.0, e);
    if(inside > 0.001){
      float churn = N1(vec2(w.x * 0.00068 + uTime * 0.007, w.y * 0.00098), 0.00098);
      col = mix(col, vec3(0.0004, 0.0002, 0.0011)
                   + uCHushGlow * V_HUSH * 0.0016 * churn * churn, inside);
    }

    // The tearing seam, on the annihilation front. Its peak is deliberately
    // held under the avatar's: with the threat out-highlighting the protagonist
    // the frame's value hierarchy was inverted, measured at 255 against the
    // mote's 217. The V_ENVMAX ceiling at the end of main() now guarantees that
    // rather than leaving it to these coefficients.
    col += uCHush * V_HUSH * rv
         * (exp(-(e * e) / 190.0) * 0.34 + exp(-(e * e) / 4200.0) * 0.06);
    // Reach, not wall: the dread should arrive on screen before the front does,
    // and stop dead behind it.
    float gd = e >= 0.0 ? e / 560.0 : -e / 190.0;
    col += uCHushGlow * V_HUSH * 0.019 * rv / (1.0 + gd * gd);

    // Erosion tendrils: hairline fractures licking ahead of the DRAIN front,
    // the water coming apart before it goes.
    //
    // They used to be anchored on the annihilation front and reach 1250 units
    // out from it. Since that front is a thousand units off the left edge for
    // most of a run, all the player ever saw was the far tips of very long
    // cracks - which is why they read as evenly-spaced diagonal rain across the
    // left third of the frame rather than as something eating the water.
    // Anchored on the drain front they are a short ragged fringe ON the edge,
    // which is what a fracture process actually looks like, and they fade in
    // from just inside it so the edge is never a clean line.
    //
    // A crack is a level set of a SHEARED coordinate, not a grid row with the
    // feature displaced off it. Displacing the feature is why this used to be a
    // stack of dead-level scanlines: the moment a crack drifted more than half
    // a row it landed in a cell that computes a different row index, so the
    // pixels on it stopped agreeing which crack they were on and the drift had
    // to be dialled back to zero to keep the crack visible at all. Warping the
    // coordinate instead lets every crack lean, curve and taper while every
    // pixel on it still resolves to the same row.
    //
    // The shear multiplies dxh, not e: e carries the front's raggedness, whose
    // dy-gradient is large enough that shearing by it folds the mapping, and a
    // fold shows up as a bright pinch where two cracks merge.
    //
    // Three things were wrong with the FIELD rather than with any one crack:
    // rows were evenly spaced, the shear was one global wave so every crack
    // had the same angle, and every row was populated - so the eye read a
    // scrolling tile rather than weather. Now the row spacing varies along y,
    // the shear varies at three scales so neighbouring cracks are not
    // parallel, and the population is gated by a slow field so the cracks
    // arrive in gusts with quiet water between them.
    if(ed > -300.0 && ed < 380.0){
      // The shear has to vary SLOWLY along y. It multiplies dxh, which is a
      // couple of thousand units out here, so a shear that turns over inside a
      // few hundred units folds the mapping and a fold is a bright pinch where
      // two cracks merge. Slow shear means neighbouring rows lean alike, which
      // is why the tendrils cannot be allowed to be long: at 500 units they
      // read as evenly-spaced horizontal rain across the left third, measured
      // on seed 3. Short licks with staggered roots read as a fringe on an
      // edge, which is the thing being drawn.
      float shear = wave(w.y, 0.00021, 4.3) * 0.16 + wave(w.y, 0.00074, 1.1) * 0.11
                  + wave(w.y, 0.00160, 5.7) * 0.05;
      float sy = (w.y + max(dxh, 0.0) * shear
                      + sin(ed * 0.0043) * 14.0 + sin(ed * 0.0121 + 1.7) * 5.0) / 44.0
               + wave(w.y, 0.00135, 2.3) * 3.2
               + dev(N1(vec2(w.y * 0.0012, 3.7), 0.0012)) * 1.6;
      float row = floor(sy);
      float rh  = hash11(row * 1.731 + 5.3);
      float rb  = hash11(row * 5.11 + 2.7);
      float gust = sat(0.5 + dev(N1(vec2(w.y * 0.00058 + uTime * 0.011, 7.9), 0.00058)) * 2.4);
      // Roots staggered per row, so the tendrils do not all start on one line
      // even where the drain front happens to run straight.
      float edr = ed - (rb - 0.5) * 170.0;
      float tr = 45.0 + rh * rh * 215.0;      // how far this one licks ahead
      if(rh > 0.40 + 0.42 * (1.0 - gust) && edr > -200.0 && edr < tr){
        float p = sat(edr / tr);
        float dy = fract(sy) - 0.5 + (rh - 0.5) * 0.40;
        // Thin toward the tip, and broken along its length: a fracture is a
        // chain of segments, not a stroke of the same width end to end. The row
        // spacing varies by design, so a crack in a widely-spaced stretch is
        // several times thicker in world terms than one in a tight stretch -
        // which is why this coefficient is small: at the old 0.030-0.100 the
        // widest rows drew 25-unit bars, and a 20-pixel bar is not a hairline.
        float thick = (0.022 + rh * 0.050) * (1.0 - 0.62 * p);
        float seg = sat(0.24 + dev(N1(vec2(edr * 0.0039 + row * 0.37, 0.29), 0.0039)) * 3.6);
        col += uCHush * V_HUSH * 0.115 * exp(-(dy * dy) / (thick * thick))
             * (1.0 - p) * seg * (0.35 + 0.65 * gust)
             * smoothstep(-200.0, -20.0, edr)
             * (0.30 + 0.70 * rb)
             * (0.5 + 0.5 * sin(uTime * (1.4 + rh * 3.0) + rh * 30.0));
      }
    }

    // Matter coming apart as it crosses: flecks streaming into the edge.
    if(e > -60.0 && e < 700.0){
      vec2 g = vec2(w.x * 0.0125 + uTime * 1.15, w.y * 0.0125);
      vec2 cl = floor(g), fc = fract(g);
      if(hash12(cl + 51.7) > 0.52){
        vec2 dv = (fc - cellCentre(hash22(cl + 13.1))) / vec2(0.34, 1.55);
        col += mix(uCHush, vec3(1.0), 0.24) * V_HUSH * 0.085
             * exp(-dot(dv, dv) / (CELL_RMAX * CELL_RMAX * 2.0)) * cellWindow(fc)
             * (1.0 - sat(e / 700.0));
      }
    }
  }

  // Approach pressure: a violet bruise creeping in from the left, so the wall
  // is felt even when it is entirely off screen. Under the same kill switch as
  // the wall itself, or attributing a violet cast has to be done by reading.
  if(uHushProx > 0.01 && uKill.w > 0.5){
    float g = pow(1.0 - uv.x, 2.6) * uHushProx;
    // Drained rather than tinted: more desaturation, less added glow. The
    // additive term is what once left the left edge measuring BRIGHTER than
    // mid-frame, which is the opposite of a wall of dark approaching.
    col = mix(col, mix(col, vec3(dot(col, vec3(0.25, 0.62, 0.13))), 0.55)
                 * vec3(0.62, 0.52, 1.14), g * 0.60);
    col += uCHushGlow * V_HUSH * 0.005 * g;
  }

  col *= uIntensity * mix(1.0, 0.90, uDiff);

  // The hierarchy ceiling. See V_ENVMAX: the environment does not get onto the
  // hero's rung of the value ladder, and the only way that stays true while
  // eight multiplicative terms are retuned by different hands is to state it
  // once, here, after every one of them has landed.
  float envPk = max(max(col.r, col.g), max(col.b, 1e-5));
  float envC = V_ENVKNEE + (V_ENVMAX - V_ENVKNEE)
             * (1.0 - exp(-max(envPk - V_ENVKNEE, 0.0) / (V_ENVMAX - V_ENVKNEE)));
  col *= min(envC / envPk, 1.0);

  // Deep blacks are where banding shows. Static screen-space dither, sized to
  // roughly one 8-bit step after the grade so it never becomes visible grain.
  float lum = dot(col, vec3(0.25, 0.62, 0.13));
  col += (hash12(gl_FragCoord.xy) - 0.5) * (0.00040 + lum * 0.0075);

  outColor = vec4(max(col, 0.0), 1.0);
}`;

/** Palette entries are hue authorities only; brightness lives in the shader. */
function chroma(c) {
  const m = Math.max(c[0], c[1], c[2]) || 1;
  return new Float32Array([c[0] / m, c[1] / m, c[2] / m]);
}

/** Debug kill switches, mirroring render.js's noSprites/noRibbons. */
function killMasks() {
  let q = '';
  try { q = globalThis.location ? globalThis.location.search : ''; } catch { q = ''; }
  const p = new URLSearchParams(q);
  const on = (k) => (p.has(k) ? 0 : 1);
  return [
    new Float32Array([on('bgNoSnow'), on('bgNoRays'), on('bgNoVents'), on('bgNoHush')]),
    new Float32Array([on('bgNoFar'), on('bgNoSilt'), on('bgNoGrain'), on('bgNoBreak')]),
  ];
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
    const [k1, k2] = killMasks();
    this.kill = k1; this.kill2 = k2;
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
    gl.uniform4fv(u.uKill, this.kill);
    gl.uniform4fv(u.uKill2, this.kill2);
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

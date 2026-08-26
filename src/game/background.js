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
// The corollary, learned the expensive way: a plane needs a GRADIENT, not just
// an edge. Every receding wall here was shaded off its own profile noise, which
// is not a light source, so four planes came out as flat fills that happened to
// differ in tone - one of them measured 0.060 of luminance spread against the
// frame's 0.173, and a blind review called terrain the quality ceiling on the
// whole project. Each plane now takes its value from the same roof-openness
// field the light shafts are cut from, at its own distance, so the bright patch
// on a far wall lands under the fissure the beam in front of it came through.
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
// bgNoSnow / bgNoRays / bgNoVents / bgNoHush, bgNoFar / bgNoSilt / bgNoGrain /
// bgNoBreak, bgNoLamp / bgNoLedge / bgNoDip / bgNoTalus, bgNoMoteKey,
// bgNoJoint or bgNoAnchorLight, to
// drop one feature group and attribute an artefact - or a value floor, or a
// missing one - to it. Fifteen uniform multiplies. They are how the
// axis-aligned-rectangle bug was pinned on the marine snow after two sessions
// of blaming other people's passes, how the missing blacks were pinned on this
// file rather than on the grade, and how the lavender streak field was pinned
// on the Hush rather than on the post chain's anamorphic pass; keep them.
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
uniform vec4  uKill3;        // debug: x lamp on rock, y ledges, z dip/faults, w talus
uniform vec4  uKill4;        // debug: x mote key, y joints, z anchor lamps (1 = on)
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
// THE HERO'S OWN KEY LIGHT ON ROCK, and the largest single number in this
// file's rock budget on purpose - five times the sky-lit albedo above.
//
// 'The mote lights nothing' has been the top-ranked complaint in three
// consecutive reviews, and the last two attempts to answer it both failed for
// the same measurable reason: they were LEVEL changes to a term whose RADIUS
// was wrong. Probed on the four capture depths a reviewer was actually looking
// at, the nearest rock to a swimming mote measures 270, 447, 450 and 451 world
// units - the mote is in open water, which is where the game is played - while
// the in-scatter pool that was carrying its light has a half-value radius of 51
// and its wide lobe 195. It never arrived. Worse, when the probe isolated the
// lift by hue it found the only lifts above +15 code values anywhere in those
// frames were NEGATIVE in cyan - they were the amber anchors, which get a ten
// times wider core from the same expression. The reviewer read four frames and
// said no rock goes cyan; the instrument agrees, and says why.
//
// So this is a separate light with its own reach - see moteKey, half value at
// 464 units - and it modulates ALBEDO: it is multiplied by alb, which carries
// the strata, the joints, the cross-lamination and the grain, so what the eye
// gets is the rock's own material coming up out of the dark. Additive glow at
// the same level reads as fog in FRONT of the wall, which is the note the
// anchors already pass and this used to fail.
const float V_MOTEKEY = 0.150;
// Distant rims need their own, far smaller budget. Four layers x two edges is
// eight full-width bands: even narrow, that touches most of the frame, and at
// near-rock strength it single-handedly put p90 at twice its ceiling. Aerial
// perspective says a distant highlight is veiled anyway.
// Lowered once the rim learned where the light is: keyed to the layer's own
// roof openness it is 1.6x hotter than the flat version where the trench is
// open and a little over half its level everywhere else. That is the trade this
// file is built on, and it is also a hierarchy fix - eight full-width bands at
// a constant brightness are eight blocks competing with the hero for the top of
// the value ladder, and the mote lost five places in one frame to the first,
// unlowered version of this.
const float V_FARRIM = 0.050;
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
// The floor the glow puts under a receding plane. See farWall - the exponent
// that spreads it across the four layers matters more than the level does, and
// this number is chosen so that steepening the exponent leaves the DEEPEST
// plane at exactly the value it had before and takes the difference off the
// nearer ones. Holding the four-layer MEAN instead was measurably wrong: it
// raised layer four by 24%, that layer is what fills the empty top and bottom
// of a shallow frame, and its pixels are the ones sitting closest to sRGB 8 -
// so four scenes lost their blacks and picked up a warning each. The deepest
// plane is also the one the last round's recovery was about; it does not move.
const float V_GLOW  = 0.092;
const float V_VEIL  = 0.018;
const float V_SNOW  = 0.450;   // one lit fleck of marine snow
const float V_BIO   = 2.350;   // a living mote - carries its own light
const float V_VENT  = 2.500;   // vent throat - superwhite on purpose
// The Hush edge budget. The multipliers off it are deliberately small: an
// art-direction pass measured the Hush's streaks clipping to 255 while the
// avatar peaked at 217, so the threat out-highlighted the protagonist and the
// frame's value hierarchy was inverted. The wall is a mass of DARK; only its
// tearing seam and the last flare of what it eats are allowed to be bright, and
// neither brighter than the mote.
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
// The colour the mote's own light lands in. Blue-dominant, off PAL.moteOuter,
// so it cannot be confused with the mint of the plankton or the amber of an
// anchor: 'a rock face goes cyan when the mote swings past it' is the read the
// premise is judged on, and it only reads if the hue is unambiguous.
const vec3 MOTE_LIGHT = vec3(0.22, 0.78, 1.00);
// ...and the hue it lands in out at the DIM EDGE of the same pool.
//
// Modulating albedo honestly is what makes the lit patch read as rock, and it is
// also why on warm silt the lift comes out cool GREY rather than cyan: the
// surface is (1.00, 0.62, 0.30) and multiplying it by a cyan light leaves a
// third of the red in. The bright core has to keep that, or the material read
// goes with it. The outer pool does not: it carries the least material
// information in the frame, and it is where the eye most readily reads
// 'coloured light' instead of 'brighter rock'.
//
// Same Rec.709 luminance as MOTE_LIGHT to three figures - 0.678 against 0.677,
// which is the weighting tools/check.mjs measures with - so this is a PURE
// CHROMA move. It cannot spend p90, it cannot spend a p99 that clears its floor
// by 0.0026, and it cannot touch the focal contrast around the hero, because the
// blend is keyed to the light's own strength and the core is left exactly as it
// was. Measured by isolating the term with bgNoMoteKey and differencing, at 450m
// and 1000m, bucketed by how strong the lift is: the outer pool's red content
// falls 16% and the bright core moves 2-4%, while the mean blue lift per bucket
// and the lifted area both hold. In LINEAR terms the light's red on warm silt
// goes from 30% of blue to 5%; the graded frame only shows a sixth of that,
// because the grade's toe is steep and most of this lift lands on it. That gap
// is the ceiling on how far a hue push can be taken without spending level.
const vec3 MOTE_DEEP = vec3(0.04, 0.835, 1.00);
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

// ------------------------------------------------------------ fault blocks --
// A ROCK MASS IS NOT ONE DECK OF LAYERS. A blind review reading this frame
// cold: 'the strata are perfectly horizontal and perfectly parallel across
// every landform in the frame, at constant band thickness. Real rock dips,
// faults and offsets.' It was right, and the cause was structural rather than a
// matter of tuning: one bedding grid served the near rock and all four far
// walls, tilted only by bedTilt above - whose measured amplitude is about 70
// world units over a 3400-unit wavelength, which is two and a half degrees.
// Two and a half degrees is level.
//
// So x is partitioned into fault blocks, the beds are offset across each one,
// and the partition is a level set of a SHEARED and wandering x - the same
// construction joints() uses - so the planes are irregularly spaced instead of
// being a picket fence.
const float FAULTW = 1180.0;   // mean fault block width: ~1.6 blocks a screen
// THE PLANE MUST NEVER BE VERTICAL, AND IT WAS. A block boundary sits where
// (x + y * FAULT_LEAN) / FAULTW + faultShear(y) is an integer, so its slope in
// world space is -(FAULT_LEAN + FAULTW * faultShear'(y)) and the shear term
// alone swings +-0.253. Against the old lean of 0.19 that slope PASSES THROUGH
// ZERO, and where it does the fault draws a dead-straight vertical line down the
// whole frame. Measured on seed 7 / hazardNear with the sprite and ribbon passes
// off: the boundary at fu=12 stood at screen x=915 and moved seven world units
// across 330 pixels of height - 1.2 degrees off vertical - and it was the
// largest column-to-column step in the image at 22-31x the median. A reviewer
// reading that backdrop called it a hard vertical seam, not a fault, and was
// right to.
//
// 0.58 is chosen so the slope is bounded away from zero by more than the camera
// roll can cancel: it runs 0.33-0.83, a plane dipping 50-72 degrees, which is
// also the range a normal fault actually dips in.
const float FAULT_LEAN = 0.58;
float faultShear(float wy){ return wave(wy, 0.00042, 1.1) * 0.34; }

// A FAULT OFFSETS BEDS; IT DOES NOT RELABEL THEM. Everything about the rock mass
// except the throw is now a CONTINUOUS lateral field, and that is the other half
// of the seam fix. Dip, bed thickness and warp phase used to be hashed per
// block, so at every plane the bedding COORDINATE jumped three separate ways at
// once: the centre-anchored dip was worth up to 430 world units - three beds -
// the thickness multiplier another 1.7 beds at the bottom of frame, and the
// intended throw only 0.17-0.59 on top. Three unrelated jumps at one x is not a
// displaced layer, it is two unrelated stacks butted together, and every
// consumer of the grid inherited it: snapBedB stepped the far walls' and the
// benches' SILHOUETTE, and the far wall's per-bed albedo stepped the value of a
// whole plane. Killing the dip with bgNoDip left the seam exactly where it was,
// which is what proved the dip was never the only thing stepping.
//
// So the mass folds and fans laterally instead of being cut into rigid decks.
// The local dip still reaches fifteen degrees and the bed thickness still varies
// along the trench - which is all the review's 'perfectly horizontal, perfectly
// parallel, constant band thickness' complaint ever asked for - but now the only
// discontinuity anywhere in the frame is on the fault plane itself.
//
// wave(), not a noise fetch: these need a CALIBRATED slope and the tile's
// per-channel variance is written down nowhere. Max slope here is 0.270, so the
// steepest local dip is 15.1 degrees, and the amplitude is bounded at 120 units
// so the fold can never run away with x the way a global tilt term does.
float dipAt(float wx){ return wave(wx, 0.00150, 0.6) * 120.0; }

// x = unused, y = bed thickness multiplier, z = throw in beds, w = warp phase.
// One wave drives both thickness and phase: they co-vary, which is what a basin
// that subsided faster on one side actually does, and it costs two sines rather
// than four in a function every pixel of rock evaluates.
//
// THE THROW ALTERNATES IN SIGN WITH THE BLOCK INDEX, and that is not decoration.
// With an independent sign per block two neighbours can draw the same one and
// the RELATIVE throw - the only part of it the eye can see - goes to zero, which
// is layers lining up across a break, the one thing a fault must not do. It hid
// until now because the dip jump was three times larger and masked it.
// Alternating, the offset is 0.48-1.08 beds at every plane: horst and graben,
// with the magnitude hashed so no two breaks are worth the same.
vec4 bodyAt(float wx, float fi){
  float lat = wave(wx, 0.00041, 4.7);
  float sg = mod(fi, 2.0) < 0.5 ? -1.0 : 1.0;
  return vec4(0.0,
              1.03 + 0.17 * lat,
              sg * (0.24 + 0.30 * fract(hash11(fi * 1.731 + 8.3) * 17.31)),
              0.5 + 0.5 * lat);
}

// The bedding coordinate inside a block. Beds are NOT of constant thickness: a
// perfectly even 135-unit stack reads as ruled paper, which is the loudest
// regularity a strata field can have. Warping the bedding COORDINATE rather
// than displacing seams off a regular grid keeps every pixel on a bed agreeing
// which bed it is on - displace it instead and the mapping folds and pinches.
// With the per-block phase and multiplier, local thickness runs 79-322 units
// AND differs between neighbouring blocks at the same height, while the
// analytic slope below can never reach zero, so the sequence cannot invert.
float bedU(float y, vec4 bp){
  return y / (BEDY * bp.y) + wave(y, 0.00260, 1.7 + bp.w * 6.283) * 0.62;
}
float bedSlopeU(float y, vec4 bp){
  float f = 0.00260, ph = 1.7 + bp.w * 6.283;
  return 1.0 / (BEDY * bp.y)
       + 0.62 * f * (0.62 * cos(y * f + ph) + 0.880 * cos(y * f * 2.317 + ph * 2.7));
}

// The bedding frame at a point: which block it is in, what its beds are doing,
// and how far it is from the fault plane bounding it - in block units, so
// x FAULTW for world units. The tilt is a pure function of x and carries no
// block identity at all, so bedU, and therefore snapBedB and every bed index
// read off it, are continuous across a plane; the throw added at the end is the
// only term that steps, which is exactly the one a fault is made of.
float bedFrame(vec2 w, float px, out vec4 bp, out float tilt, out float fd){
  float fu = (w.x + w.y * FAULT_LEAN) / FAULTW + faultShear(w.y);
  float fi = floor(fu);
  bp = bodyAt(w.x, fi);
  fd = min(fract(fu), 1.0 - fract(fu));
  tilt = dipAt(w.x) * uKill3.z + bedTilt(w.x, px);
  return bedU(w.y + tilt, bp) + bp.z * uKill3.z;
}

// Snap a profile height onto the bedding grid of the block it stands in: a
// bench forms where a resistant bed outcrops, not at an arbitrary height. One
// Newton step inverts the warp, and an error of a few units is invisible
// against a bed a hundred and more units thick.
float snapBedB(float y, float tilt, vec4 bp){
  float yy = y + tilt;
  float u = bedU(yy, bp);
  return y + (floor(u) + 0.5 - u) / bedSlopeU(yy, bp);
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
  return exp(-(d * d) / (thick * thick)) * seg * uKill4.y;
}

// Strata. Built additively so the mean albedo stays near 1.0 and V_ROCK really
// is the albedo. Two seams per bed do the work the body tone cannot: a dark
// parting at the base and a resistant cap near the top. Those are the features
// the eye actually reads strata from, and the only ones still legible in a mass
// that is - correctly - near black.
float strata(vec2 w, float det, out float fine, out float seam, out vec2 bedf){
  vec4 bp; float tilt, fd;
  float sy = bedFrame(w, pxWorld(), bp, tilt, fd);
  // Bed identity is read off the UNTHROWN index, so one physical bed keeps its
  // shade on both sides of a fault and the break reads as a known layer that
  // has been displaced rather than as two unrelated stacks butted together.
  // That is the cue the eye actually uses to see a fault at all.
  float bi = floor(sy - bp.z * uKill3.z), bf = fract(sy);
  float bh  = hash11(bi * 1.37 + 0.5);      // bed albedo
  float chr = hash11(bi * 2.71 + 9.1);      // bed character: shale or sandstone
  float part = 1.0 - smoothstep(0.0, 0.030 + 0.055 * chr, bf);
  float cap  = smoothstep(0.66, 0.80, bf) * (1.0 - smoothstep(0.90, 1.00, bf));
  seam = max(part, cap * 0.85) * det;
  // The fault plane itself: a zone of crushed rock a few tens of units wide.
  // Folded into the joint channel rather than given its own, because a fault
  // interrupts the rim, the seams and the grain in exactly the way a joint
  // does, and every consumer of that channel already knows how to be broken.
  float fw = 0.0055 + 0.0105 * bp.w;
  float flt = exp(-(fd * fd) / (fw * fw)) * uKill3.z;
  float jnt = max(joints(w), flt * 0.92) * det;
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
//
// The staircase was then TOO regular, and that is a different defect with the
// same cause. A step of one of exactly three heights, in every single cell,
// with the riser always at the same 90-100% of the cell, is a crenellation:
// a blind review reading eight frames called the silhouettes "near-identical
// rectangular teeth with visible right-angle steps" and scored terrain 3 out of
// 10 against 7-8 for every other object class in the same image. The riser now
// falls anywhere across the middle of the cell, carries a continuous per-block
// draw on top of the coarse quantisation, and has its own width - so no two
// blocks share a face. Four fract-multiplies off the two hashes that were
// already being paid for; the cap on 'ew' keeps the ramp strictly inside the
// cell, or the mix would not reach q1 by f=1 and the boundary itself becomes
// the very hard step this is trying to remove.
float blocks(float wx, float cell, float amp, float sd){
  float u = wx / cell;
  float i = floor(u), f = fract(u);
  float a = hash11(i * sd + 4.7), b = hash11((i + 1.0) * sd + 4.7);
  float q0 = floor(a * 3.0) + fract(a * 47.31) * 0.62;
  float q1 = floor(b * 3.0) + fract(b * 47.31) * 0.62;
  float e  = 0.34 + fract(a * 19.73) * 0.52;
  float ew = min(0.030 + fract(a * 7.317) * 0.150, min(e, 1.0 - e) * 0.94);
  // Renormalised: adding a continuous draw on top of floor(h*3) moved the mean
  // block height from 1.00 to 1.31, and relief is one-signed, so a 31% thicker
  // roof is 31% more ceiling in frame. A ceiling is not free - the term that
  // recovered the receding roof lights its interior - and a kill-switch bisect
  // measured the silhouette relief alone at 1.2 points of a frame's blacks.
  // The mean and the maximum now match the distribution this replaced exactly;
  // only the shape of the step is new, which is the part that was the defect.
  float tread = mix(q0, q1, smoothstep(e - ew, e + ew, f));
  // NO RIGHT ANGLES LEFT. A vertical drop that ends in a square corner is the
  // tell of a drawn shape: real rock sheds, the debris piles against the foot
  // of the face at its angle of repose, and the brow above is left overhanging
  // where the joint behind it has opened. Two wedges, both strictly one-signed
  // and both dying inside the cell - a feature wider than its own cell is how
  // this file once filled a frame with axis-aligned rectangles.
  //
  // The talus is tangent at its toe (exponent > 1) and at full height where it
  // meets the riser, so it converts the corner into a concave ramp without
  // deleting the drop: at 0.52 of the step, half the riser survives as a face
  // with a pile of rubble under it, which is the read.
  float dh = q1 - q0;
  float lo = dh > 0.0 ? (e - f) : (f - e);          // > 0 on the low side
  float lw = min(0.34, (dh > 0.0 ? e : 1.0 - e) * 0.92);
  float hw = min(0.13, (dh > 0.0 ? 1.0 - e : e) * 0.92);
  float wedge = 0.52 * pow(sat(1.0 - max(lo, 0.0) / lw), 1.7)
              + 0.20 * pow(sat(1.0 - max(-lo, 0.0) / hw), 2.2);
  // Renormalised, as the step itself was: the mean of the step alone is 1.31 of
  // amp and the two wedges add 4.9% of that. Relief is one-signed, so an
  // unrenormalised talus is 5% more rock in every frame, and a kill-switch
  // bisect once measured the silhouette relief alone at 1.2 points of a frame's
  // blacks. The shape of the corner is new; the amount of rock is not.
  return amp * 0.727 * (tread + abs(dh) * wedge * uKill3.w);
}

// A dome with tangential edges: exponent > 1 sends the slope to zero where the
// stone meets the bed, so its outline antialiases instead of aliasing.
float dome(float f, float halfw){ return pow(sat(1.0 - abs(f) / halfw), 1.15); }

// A broken rock edge for the receding planes. NOT a row of teeth: one cell in
// three is empty, and the cell that is not decides for itself where its tooth
// sits, how wide it is, how deep it bites and which way it leans - all off the
// bits of one hash, so it costs one hash and three fract-multiplies.
//
// It replaces a six-level terrace stacked on a bedding snap. Two quantisations
// in series can only produce a staircase, and a staircase seen edge-on is a
// crenellation of one constant module - which is exactly what the review
// measured. Two of these at incommensurate spacings gives the third missing
// variable for free: the coarse field is the fine field's baseline.
//
// The lean multiplies |d| on the leading side only, never the trailing one. A
// factor below 1 would widen the tooth past the half-width its cap was chosen
// for, and a sprite wider than its own cell is how this file got a frame full
// of axis-aligned rectangles once already. The exponent stays above 1 so the
// tip's slope goes to zero at the baseline and the outline antialiases.
float ragged(float x, float cell, float sd, float amp){
  float u = x / cell + sd;
  float i = floor(u), f = fract(u);
  float h = hash11(i * 1.937 + sd);
  if(h < 0.30) return 0.0;
  float hw0 = fract(h * 31.71);      // width
  float hd  = fract(h * 97.13);      // depth
  float hc  = fract(h * 13.37);      // where in the cell
  float c   = 0.5 + (hc - 0.5) * 0.56;
  float hw  = min(0.10 + 0.36 * hw0, min(c, 1.0 - c) * 0.95);
  float d   = f - c;
  d *= d > 0.0 ? (1.0 + 0.85 * hd) : 1.0;
  return amp * (0.20 + 1.30 * hd * hd) * pow(sat(1.0 - abs(d) / hw), 1.15 + 1.9 * hw0);
}

float reliefRoof(float wx, float det){
  vec4 a = N(vec2(wx * 0.00046 + 3.1, 2.20), 0.00046);
  float broad = sat(0.5 + (dev(a.r) * 1.00 + dev(a.g) * 0.46) * GAIN);
  float notch = sat(0.5 + (dev(a.b) * 0.90 + dev(a.a) * 0.55) * GAIN);
  float r = 22.0 * pow(broad, 1.35) + 11.0 * pow(notch, 2.0);
  r += det * blocks(wx, 118.0, 9.0, 1.93);
  r += det * blocks(wx, 47.0, 4.5, 2.71);
  // Teeth. Narrow, so they read as the rock's own broken edge rather than as
  // an obstacle the physics has not been told about - and each with its own
  // width as well as its own height, because a row of teeth that vary only in
  // length is still a row.
  float pu = wx / 224.0;
  float ph = hash11(floor(pu) * 4.11 + 2.3);
  if(ph > 0.56){
    float pw = fract(ph * 23.71);
    // The width floor is a hierarchy guard, not a shape choice: a tooth
    // narrower than this concentrates the whole 0.85 rim budget into a handful
    // of pixels, and a handful of very hot pixels is a block competing with the
    // hero for the top of the value ladder.
    r += det * (18.0 + ph * 46.0) * dome(fract(pu) - 0.22 - ph * 0.50, 0.048 + pw * 0.095);
  }
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

// ------------------------------------------------------------- top surfaces --
// A BENCH IS A TOP SURFACE, and nothing in this frame had one. Of the three
// things a blind review asked the rock for - 'no top surface, no dip angle, no
// fault break' - this is the one that decides whether a mass reads as a solid
// or as a plane with texture on it, because it is the only one that says the
// object has a second face at all.
//
// So stretches of the drawn floor are snapped DEAD FLAT: a resistant bed
// outcrops, the softer rock above it is stripped, and what is left is a tread
// with a riser at each end. 'flat' is exported because a flat stretch shaded
// like its own face is still a cutout - the shading has to light it as a plane
// that faces up. The riser is deliberately abrupt, about eighteen units of x,
// which is the corner blocks() then sheds talus against.
float benchFlat(float wx, out float treadH){
  float u = wx / 545.0;
  float i = floor(u), f = fract(u);
  float h = hash11(i * 5.113 + 21.7);
  treadH = 16.0 + 58.0 * fract(h * 7.771);
  if(h < 0.46) return 0.0;
  float c  = 0.20 + fract(h * 13.71) * 0.34;
  float e1 = min(c + 0.18 + fract(h * 51.31) * 0.32, 0.96);
  return smoothstep(c - 0.033, c + 0.033, f)
       * (1.0 - smoothstep(e1 - 0.033, e1 + 0.033, f));
}

// The drawn floor. One function, because the silt that hugs the floor and the
// rock that IS the floor have to agree about where it is.
//
// Snapping the RELIEF flat is not enough and was the first attempt: the
// collision line underneath still swings, so a 'flat' tread inherited its
// curve. An absolute height read off the bench cell's own centre was the second,
// and it was worse in a more interesting way - it invented 300-unit plateaus
// wherever the collision line swung inside a cell, and the ledges it did draw
// came out dead level with ruler-straight leading edges. That is a trade of one
// regularity for another: the complaint being answered here is that everything
// in the frame was horizontal and parallel, and horizontal parallel LEDGES are
// no better than horizontal parallel bands.
//
// A BENCH LIES ALONG A BED. Snapping to the bedding grid makes the tread dip
// with the block it belongs to, which is the whole point, and it bounds the
// deviation to half a bed so no plateau can appear. Then clamped against the
// collision line, because relief here is strictly one-signed: drawn rock may be
// thicker than the rock the physics uses, never thinner. A frame that draws
// rock as water hands the player an invisible wall, and that is the one lie
// this file must not tell.
float drawnBot(float wx, float bandY, float det, out float fl, out float th){
  fl = benchFlat(wx, th) * det * uKill3.y;
  float bro = bandY - reliefFloor(wx, det);
  vec4 bp; float tilt, fd;
  bedFrame(vec2(wx, bro), pxWorld(), bp, tilt, fd);
  return min(mix(bro, snapBedB(bro, tilt, bp) - th * 0.35, fl * 0.90), bandY);
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
    // bgNoAnchorLight zeroes lights 1..n and keeps the mote, which is the only
    // way to price 'the anchors put no photon on the rock' - bgNoLamp cannot,
    // because the mote shares this loop and moteKey is gated on it too.
    Lg.z *= (i == 0) ? 1.0 : uKill4.z;
    if(Lg.z <= 0.0) continue;
    vec2 dl = Lg.xy - w;
    float r2 = dot(dl, dl);
    float nd = mix(1.0, sat(dl.y * nrm * inversesqrt(max(r2, 1.0))), abs(nrm));
    float core = mix(2600.0, 26000.0, Lg.w);
    // TWO LOBES, AND THE WIDE ONE IS THE WHOLE FIX. Measured with bgNoLamp on
    // the frame this replaces: the mote's light on the rock beside it was 0.00
    // code values at three of the four capture distances, and the only nonzero
    // deltas anywhere in frame came from ANCHOR lamps, which get a ten times
    // wider core out of the same mix. The reason is geometric and was invisible
    // from the code: this pool's half-value radius is 51 world units, and the
    // nearest rock to a swimming mote measures 272-450. It never arrived. A
    // bioluminescent creature that illuminates nothing is not a light source.
    //
    // The tight lobe stays exactly as it was, because it is what makes the near
    // field a POOL rather than a wash and it is the only term with any shape in
    // it. The wide lobe carries the same light as far as the wall: squared, so
    // it falls off faster than inverse square - absorption, not just spreading -
    // which keeps it from becoming an ambient lift on the far side of the trench
    // where it measures 0.004 of peak and can be ignored.
    float wide = 92000.0 / (r2 + 92000.0);
    s += mix(vec3(0.30, 0.72, 1.00), vec3(1.00, 0.56, 0.20), Lg.w)
       * Lg.z * nd * (core / (r2 + core) + 0.46 * wide * wide);
  }
  return s * uKill3.x;
}

// ...and the same lights read for BOTH surface orientations in one pass.
//
// 'The three amber anchors put not one photon on the rock beneath them.'
// Measured before believing it, with bgNoAnchorLight, which zeroes lights 1..n
// and keeps the mote - bgNoLamp cannot answer this because the mote shares the
// loop above and moteKey is gated on it as well. Seed 7 at 400m, sprite and
// ribbon passes off: the anchors move 90799 pixels by two display levels or
// more and peak at 25, and every one of those pixels is on the SEABED. The
// claim is false for the near rock and exactly true for everything else,
// because trenchRock is the only caller of lampLight - the four receding walls
// take moteKey and nothing else. In most frames the rock an anchor hangs
// against IS a far wall, which is why the read is 'nothing receives' even
// though the floor plainly does.
//
// The fix is affordable only because it does not have to be a per-anchor loop
// per layer. moteKey already records why light on a receding plane is read at
// the NEAR plane rather than at the layer's traced position - a wall behind the
// player is lit directly behind the player - and that argument makes the lamp a
// screen-space quantity, evaluated once. So one loop in main() serves all four
// walls, and the marginal cost of anchors lighting the whole trench is one
// extra pass over seven lights per pixel rather than four.
//
// Both orientations come out of that one pass because the wrapped cosine for a
// roof is the complement of the one for a floor: sat(c) and sat(-c) off the
// same c, which is two saturates and an add rather than a second loop.
//
// trenchRock deliberately keeps its own lampLight call rather than consuming
// this: it evaluates at wr, the vent-warped position, not at w, so a lamp on
// the near rock shimmers with the vent the way everything else there does.
// Two passes over seven lights per pixel measured 0.138 ms for the whole
// background at 1600x900 against 0.137 for one - best of six batches of eight
// with gl.finish(), interleaved old/new/old/new because this machine's
// full-frame number swings 10.9 to 15.6 ms on an UNCHANGED build.
void lampPair(vec2 w, out vec3 up, out vec3 dn){
  up = vec3(0.0); dn = vec3(0.0);
  for(int i = 0; i < ${MAXL}; i++){
    vec4 Lg = uLights[i];
    Lg.z *= (i == 0) ? 1.0 : uKill4.z;
    if(Lg.z <= 0.0) continue;
    vec2 dl = Lg.xy - w;
    float r2 = dot(dl, dl);
    float c = dl.y * inversesqrt(max(r2, 1.0));
    float core = mix(2600.0, 26000.0, Lg.w);
    float wide = 92000.0 / (r2 + 92000.0);
    vec3 e = mix(vec3(0.30, 0.72, 1.00), vec3(1.00, 0.56, 0.20), Lg.w)
           * Lg.z * (core / (r2 + core) + 0.46 * wide * wide);
    up += e * sat(-c);
    dn += e * sat(c);
  }
  up *= uKill3.x; dn *= uKill3.x;
}

// The mote's KEY light: the one term in this file whose job is the premise.
//
// Separate from the pool above, because the two are answering different
// questions and one falloff cannot do both. The pool is what a light looks like
// in the water immediately around it - a tight core with shape in it, and the
// reason it is tight is that a wide one is a wash. This is what a light does to
// a surface across a room, and the room here is 270-450 world units wide,
// measured against the real bandTop/bandBot at the four depths the review
// sampled. Half value at 464 units, which is chosen to sit in the middle of
// that measured range rather than picked for how it reads in one frame.
//
// The profile is inverse-fourth, not inverse-square: spreading plus absorption,
// the same argument the pool's wide lobe is built on. That is what makes a
// several-hundred-unit reach affordable - at 1000 units it is down to 12% and
// at 1600 to 3%, so it cannot become an ambient lift on rock across the frame,
// which is the failure mode that would cost the exposure contract its p90 and
// cost the hero its rank. Measured on the tail rather than assumed.
const float MOTE_R = 520000.0;
float moteKey(vec2 w, float nrm){
  vec4 Lg = uLights[0];
  if(Lg.z <= 0.0) return 0.0;
  vec2 dl = Lg.xy - w;
  float r2 = dot(dl, dl);
  float f = MOTE_R / (r2 + MOTE_R);
  // A WRAPPED cosine, not a clamped one. A face turned away from a point source
  // in scattering water is not black, but it has to be plainly darker than the
  // face turned toward it or the light has no direction and the whole thing
  // reads as fog again - which is the exact note this term exists to answer.
  float nd = mix(1.0, 0.24 + 0.76 * sat(dl.y * nrm * inversesqrt(max(r2, 1.0))), abs(nrm));
  return f * f * nd * Lg.z * uKill3.x * uKill4.x;
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
  float fl, th;
  float bot = drawnBot(w.x, bd.y, kill2.w, fl, th);
  float soft = uViewSize.y * 0.0028;
  float dTop = top - w.y, dBot = w.y - bot;
  float cTop = sat(dTop / soft), cBot = sat(dBot / soft);
  float cov = max(cTop, cBot);
  if(cov < 0.002) return vec4(0.0);

  bool roof = cTop > cBot;
  float into = roof ? dTop : dBot;

  float fine, seam; vec2 bedf;
  float alb = strata(w, kill2.z, fine, seam, bedf);

  // How deep the top surface reads before it turns into the face. A taller
  // bench supports a deeper tread, and the depth is modulated by the rock's own
  // grain so the break of slope WANDERS: a constant depth draws a second
  // perfectly horizontal line under every ledge, which is the same defect one
  // step down. Computed after strata() only because that is where 'fine' is.
  float treadT = (14.0 + 0.30 * th) * (0.62 + 0.76 * fine);
  float tr   = roof ? 0.0 : fl * (1.0 - smoothstep(treadT * 0.58, treadT, into));
  // The break of slope. The corner where a plane turns into a face is a line of
  // contact occlusion, and it is what makes the tread the TOP OF SOMETHING
  // rather than merely a brighter band across it.
  float bd2  = into - treadT * 1.30;
  float brow = roof ? 0.0 : fl * exp(-(bd2 * bd2) / (treadT * treadT * 0.26));

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
    // Sediment settles on what faces up, and a tread is the flattest thing on
    // the floor - so a bench top is where the drift is, whatever the curvature
    // of the collision line underneath it happens to say.
    drape = max(drape, tr * 0.52 * driftN * kill2.y);
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
  // A TOP SURFACE FACES THE LIGHT; A FACE ONLY GRAZES IT. One field, two
  // orientations, and that ratio is the whole read: a tread lit at the same
  // value as the face under it is not a tread, it is a stripe.
  irr *= 1.0 + 1.40 * tr;
  vec3 lamp = lampLight(w, roof ? 1.0 : -1.0);
  float key = moteKey(w, roof ? 1.0 : -1.0);
  // Cool with distance from the hero, not with position on screen. key is the
  // pool's own falloff, so the honest hue holds inside about 470 units - which
  // is the whole bright core, and the measured range of the nearest rock to a
  // swimming mote - and the deep one takes over past roughly 1100, where the
  // pool is fading out anyway. One rule, used everywhere the key lights
  // anything, so the hue cannot step across a silhouette.
  vec3 moteHue = mix(MOTE_DEEP, MOTE_LIGHT, sat(key * 2.1));
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

  // ---- the mote, landing on the wall --------------------------------------
  // The hue is pushed 62% of the way to white before the light is applied, and
  // that is a deliberate departure from strict albedo*irradiance. Warm rock
  // under cyan light is physically a dull olive; what the premise needs is for
  // the surface to plainly go the colour of the creature. Holding alb - which
  // is where the strata, the joints, the cross-lamination and the grain all
  // live - is what keeps this reading as a lit SURFACE rather than as a coloured
  // wash, and alb swings 0.05 to 2.4, so the lit patch has 3-5:1 of internal
  // contrast in it. Buying detail with contrast rather than with level is the
  // rule the rest of this file is built on; it applies to the hero's light too.
  // The whitening stays at a flat 0.62, and that is a MEASURED negative result
  // worth not repeating. Pushing it to 0.88 in the tail - suppressing the warm
  // surface as well as cooling the light - looked like the obvious other half of
  // this and is not: measured on the isolated lift at 450m and 1000m it moved
  // the outer pool's red content by under 2%, in one band the wrong way, while
  // costing 13% of level. Whitening only helps where the surface is warm. Where
  // it is ROCK_COOL, whose red is 0.46, mixing toward white RAISES red as fast
  // as it lowers it on silt, and the two cancel across a frame. Only the light's
  // own chromaticity moves the answer.
  vec3 keyC = mix(body, vec3(1.0), 0.62) * moteHue;
  // A SURFACE, NOT A SOLID - the same argument the receding ceiling and the far
  // walls are shaded on. 'into' is distance behind the drawn silhouette, and on
  // a floor filling the lower third of frame that runs to 500 units of rock the
  // player is looking straight at. The body lamp's exp(-into/62) skin is right
  // for a light raking an edge and wrong for this: it confined every previous
  // version of the mote's light to a 62-unit rind that the frames simply did
  // not contain. The radial term already handles distance honestly, in world
  // space, per pixel - so this only has to stop the mass from lighting up like
  // a lantern seen through it.
  float keyD = 0.42 + 0.58 * exp(-into / 260.0);
  c += keyC * V_MOTEKEY * alb * key * keyD;
  // Bedding planes are gaps, so they take it deeper - the same relation the sky
  // and the anchor pool already have with seam, and the reason a lit stretch of
  // wall reads as layered rather than as a patch of paint.
  c += keyC * V_MOTEKEY * 1.15 * seam * key * exp(-into / 460.0);

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
  // reads the silhouette out of the dark for the player. The mote's key gets a
  // share of it: an edge is where a light's direction is most legible, and a
  // cyan-lit silhouette against amber-lit rock is the clearest statement
  // available that the two are different sources.
  //
  // It is also the cheapest highlight energy in the pass, and that is not a
  // coincidence - rim is 17 units wide and broken by the grain and the bedding,
  // so it buys the exposure contract's p99 with almost no area. Raised from
  // 0.30 to pay back the far-wall break of slope below, which takes its 0.008
  // out of the top of the distribution rather than the bulk. Highlights spent
  // on a shadow, bought back on an edge: the same energy, in the place a
  // reviewer actually reads the hero's light from.
  c += body * V_RIM * rim * (lamp * 0.52 + moteHue * key * 0.34);

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
          + lamp * 3.20 + moteHue * key * 2.40
          + body * (0.06 + 0.94 * seam) * 0.55)
       * V_SILT * 3.00 * crest * (0.45 + 0.90 * fine);
    // THE TREAD ITSELF. Silt-toned, so it separates from the face in hue as
    // well as in value, and lit by three things on purpose: the downwelling
    // where there is any, the water's own glow where there is not, and the
    // lamp - because a bench top is the largest upward-facing surface a mote
    // ever swims over, and it is the natural place for its light to land.
    c += (uCSurf * pow(sat(sky * 2.3), 1.1) * 1.55
          + lamp * 2.60 + moteHue * key * 2.00
          + uCSilt * (0.10 + 0.90 * amb) * 0.34)
       * V_SILT * 0.82 * tr * (0.50 + 0.85 * fine) * (0.55 + 0.80 * caus)
       * (0.45 + 0.85 * sat(rpp * 0.5 + 0.5));
  }
  // The break of slope, applied last so it darkens the top of the FACE and
  // everything the floor branch put there - a corner occludes the drift and the
  // ripple crests exactly as it occludes the rock.
  c *= 1.0 - 0.55 * brow;
  return vec4(c, cov);
}

// ---------------------------------------------------- far-wall fracture sets --
// ONE fracture set on a receding plane: a level set of a warped, sheared x,
// wandering inside its own cell and broken along its length. It is a function
// rather than an inlined block because the far walls now run TWO of them at
// CONJUGATE leans, and the reason a second lattice is the only way to get a
// second mean angle is worth stating once, here:
//
//   the mean angle of a set lives INSIDE the level set. An offset applied
//   after floor() is bounded by its own cell - that is what bounds the meander
//   - and a per-joint TILT is an offset that grows without bound in y, so it
//   leaves the cell and truncates at the boundary within one screen height.
//   Measured on the traced cores: a tilt big enough to move the mean by 20 deg
//   crosses 36 cells over the deepest plane's 8000-unit span. So a second mean
//   angle costs a second lattice, or it does not exist.
//
// 'mea' is the meander amplitude in cells; 2.5 sigma of the widest core is
// 0.148, and the in-cell offset already spends 0.15, so mea must stay under
// about 0.20 or the core is cut by its own cell edge.
float fracSet(vec2 q, float wy, float W, float lean, float sf, float sph,
              float gate, float seed, float k0, float k1, vec2 wid, float mea){
  float jsx = (q.x + q.y * lean) / W + wave(q.y, sf, sph) * 0.17;
  float ji  = floor(jsx);
  float jh  = hash11(ji * k0 + 1.9);
  if(jh <= gate) return 0.0;
  // Two raw sinusoids rather than two wave() calls: the same known +-1 range
  // for half the transcendentals, and the two fields want their own phases
  // anyway. The meander leans on the low octave, the segments on the high.
  //
  // fk is a PER-JOINT frequency for both, and it is half of 'near identical
  // LENGTH'. Every joint used to break on the same two periods, 2027 and 528
  // world units, differing only in phase - so a reviewer counting strokes saw
  // one length repeated. 0.62..1.67 is a 2.7x spread of segment length, off
  // fract(p) rather than a third hash, since p is already a large number whose
  // fractional part is uncorrelated with the value that made it.
  float p  = hash11(ji * k1 + 4.7) * 43.7 + seed;
  float fk = 0.62 + fract(p * 0.317) * 1.05;
  float s1 = sin(wy * 0.0031 * fk + p);
  float s2 = sin(wy * 0.0119 * fk + p * 2.7);
  float jd = abs(fract(jsx) - 0.5 + (jh - 0.5) * 0.30
               + (s1 * 0.72 + s2 * 0.28) * mea);
  // A PER-JOINT DUTY, and it is the one axis of a per-joint weight that is
  // SAFE. A multiplicative gain on jnt is not: alb is consumed as
  // alb *= 1.0 - 0.88 * jnt, so a mean-1 gain must exceed 1 somewhere and there
  // it drives the albedo NEGATIVE - the channel stops occluding and starts
  // subtracting light, which is the mechanism AI_HANDOFF records behind the
  // black polygons. seg is clamped to 0..1 BEFORE it multiplies anything, so
  // moving its centre cannot do that.
  //
  // IT IS ALSO NOT WHERE LENGTH JITTER COMES FROM, AND THE BRIEF THAT ASKED FOR
  // '+-60% length jitter' GETS IT SOMEWHERE ELSE. +-0.312 about 0.52 IS +-60%
  // of the duty, but duty is not length: measured off seg(y) at one world unit
  // over 500 joints, run length goes from median 246 (p05 134, p95 470, CV
  // 0.385) to median 248 (p05 130, p95 484, CV 0.433). A 12% wider spread, not
  // 60% - because length is already dominated by fk's 2.7x and by where the two
  // octaves beat. What DOES move it is the bed confinement in farWall: median
  // 246 -> 102 world units, p95/p05 3.51x -> 9.24x, and three times as many
  // separate segments. Keep this term - it is nearly free and it decorrelates
  // duty from width - but do not credit it with the length variance.
  float seg = sat(0.52 + (fract(p * 0.713) - 0.5) * 0.624
                       + (s2 * 0.62 + s1 * 0.38) * 1.9);
  // WIDTH, AND WHY THE FISSURE'S IS NOT ALLOWED TO GROW. Mean seg is 0.507
  // integrated over phase, so segmenting cost the channel about half its mass,
  // and 0.023/0.036 is already 1.135x the pre-segment width to give some back -
  // 0.576 of the old mass, not 1.0. Going the rest of the way was measured and
  // goes the WRONG WAY: at 0.035 + 0.055 * jh the mass is 0.880 of the old and
  // notch rises 0.971 -> 1.032 at 900m and 1.683 -> 1.837 at 300m. A joint at
  // s = 0.135 is around a pixel, so widening it recruits more pixels into the
  // hairline instead of dissolving it. The 42% of mass that stays lost is worth
  // 0.0000 of scene mean and at most 0.3pp of pixels below L8 on any gate
  // scene. The GOUGE is wider (0.034/0.042) precisely because it is allowed to
  // be a band rather than a hairline - the same argument the fault's damage
  // zone makes below.
  float jt = wid.x + jh * wid.y;
  return exp(-(jd * jd) / (jt * jt)) * seg;
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
             float glowM, float brk, vec3 lampUp, vec3 lampDn){
  vec2 w = toLayer(uv, s);
  // A layer at apparent scale s covers 1/s times more world per pixel, so its
  // fetches want a coarser mip than the near plane by exactly that factor.
  float pxL = pxWorld() / s;
  vec4 na = Nz(vec2(w.x * 0.0000630 + seed, seed * 0.37), 0.0000630, pxL);
  vec4 nb = Nz(vec2(w.x * 0.0001970 + seed * 1.7, seed * 0.83), 0.0001970, pxL);
  float nT = sat(0.5 + (dev(na.r) * 1.00 + dev(na.g) * 0.34 + dev(nb.b) * 0.12) * GAIN);
  float nB = sat(0.5 + (dev(na.b) * 0.95 + dev(nb.g) * 0.38 + dev(nb.a) * 0.14) * GAIN);
  // This used to terrace nT and nB onto six and five discrete levels before
  // ALSO snapping the profile to the bedding grid below. Two quantisations in
  // series can only make a staircase, and a staircase seen edge-on is a row of
  // identical rectangles at one constant module - which is what a blind review
  // found across eight frames. The bench snap is the geologically real half and
  // it stays; the arbitrary terrace is gone, and the edge is broken by ragged()
  // instead, which varies width, depth and baseline independently.
  float top = -openT - nT * amp;
  float bot =  openB + nB * amp * 0.92;
  float soft = (uViewSize.y * 0.0055) / s;
  // Conservative reject BEFORE the bedding snap and its trig. The snap can move
  // a profile by at most half a bed, the pendants hang at most 520 units and
  // the broken edge bites at most 380, so nothing further inside the open band
  // than that can become covered. This is what keeps the snap off the open
  // water, which is most of the frame.
  float marg = BEDY * 0.55 + 900.0 * brk + soft;
  if(top - w.y < -marg && w.y - bot < -marg) return vec4(0.0);

  // A bench does not form at an arbitrary height: it forms where a resistant
  // bed outcrops. Snap the profile to the SAME warped bedding grid the near
  // rock uses - same world spacing, so perspective shrinks it correctly - and a
  // riser on a far wall lines up with a bed on the near wall. That shared
  // horizon is the whole difference between four parallax layers and one
  // geological formation seen at four distances.
  // Same fault blocks as the near rock, so a plane four layers back dips the
  // way its own block dips and breaks where its own fault breaks. Four walls
  // that all bed level while the foreground dips would be worse than four that
  // all bed level: the eye reads a formation, and a formation cannot disagree
  // with itself about which way its layers go.
  vec4 bpF; float tiltF, fdF;
  float syF = bedFrame(w, pxL, bpF, tiltF, fdF);
  top = mix(top, snapBedB(top, tiltF, bpF), 0.55);
  bot = mix(bot, snapBedB(bot, tiltF, bpF), 0.55);

  // The broken edge. Three things have to vary or a module forms: tooth width,
  // tooth depth, and the baseline the teeth stand on. Two ragged fields at
  // incommensurate spacings give the first two and make the coarse field the
  // fine field's baseline; a smooth displacement off the two noise channels the
  // profile itself did not use leans the whole edge on top of that.
  top += brk * (ragged(w.x, 610.0, seed, 150.0)
              + ragged(w.x, 233.0, seed * 1.7 + 4.1, 62.0)
              + dev(na.a) * GAIN * 42.0);
  bot -= brk * (ragged(w.x + 317.0, 528.0, seed * 2.3 + 1.9, 132.0)
              + ragged(w.x + 91.0, 197.0, seed * 3.1 + 7.7, 55.0)
              + dev(nb.r) * GAIN * 36.0);

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
  // A TOP SURFACE FORESHORTENS, AND THIS ONE DID NOT. intoS is already divided
  // back into near-plane units, so the constant threshold the tread below used
  // gave the bench on the deepest plane exactly the same number of PIXELS of
  // top surface as the bench in front of it - four benches at four distances
  // all showing the same amount of their own top, which is the one thing
  // perspective never does. That is why a review which accepted the near
  // benches said in the same breath that the far ones do not foreshorten.
  // Scaled by the layer's own apparent size the deepest plane shows about 11
  // pixels of tread against the nearest plane's 23: a 2:1 ladder across the
  // four, which is the ratio their shared bed spacing already projects at.
  float fsK = 0.22 + 0.78 * s;
  float belowD = max(0.0, w.y - top);
  float belowS = belowD * s;
  // THE PLANE'S OWN DAYLIGHT, AND THE REASON IT HAS A GRADIENT AT ALL.
  //
  // This was (0.07 + 0.26 * nT): keyed to the profile's own height noise, so a
  // wall was bright because it was TALL. That is not a light source, and it is
  // why four receding planes measured as flat fills that happened to differ in
  // tone - one of them 0.060 of luminance spread against the frame's 0.173,
  // which a blind review called the quality ceiling on the whole project.
  //
  // Keyed instead to the same roof-openness field the shafts are cut from, at
  // this layer's own traced x, the lit patch on a far wall lands under the same
  // fissure the beam in front of it came through: one light, several surfaces.
  // One fetch, not roofRaw's two - a distant wall needs a two-stop gradient,
  // not beam accuracy, so the dominant octave is enough. Sampled in the LAYER'S
  // world coordinates, which is what makes the patch shrink with distance
  // exactly as the geometry does.
  vec4 nc = Nz(vec2((w.x - SUN_SLANT * belowD) * 0.0000431, 0.137), 0.0000431, pxL);
  float openL = smoothstep(0.36, 0.88, 0.5 + (dev(nc.r) * 1.12 + dev(nc.g) * 0.34) * GAIN);
  float sky = (0.055 + 0.360 * openL + 0.075 * nT) * exp(-belowS / 1400.0);
  // Same bed index and the same hash as strata(), so bed N is the same shade of
  // rock at every distance.
  float alb = 0.55 + 1.00 * hash11(floor(syF - bpF.z * uKill3.z) * 1.37 + 0.5);
  // 1 on the deepest plane, 0 on the nearest of the four. Every family weight
  // below is a function of it and of 's' alone, and both are literals at the
  // four call sites, so each instantiation folds them to constants: a family
  // that is quiet on a plane costs that plane nothing.
  float farK = 1.0 - sat(s / 0.58);
  // MATERIAL. The same bed index alb reads, hashed the way strata() hashes bed
  // CHARACTER, so a bed on the fourth plane is the same rock as the bed at that
  // horizon on the near wall: high is a competent sandstone, low an incompetent
  // shale. It steps at a bed contact, and that is legal here for the reason
  // AI_HANDOFF section 6 gives - the locus already exists and is already drawn
  // at full strength, because alb steps on the SAME index by up to a whole unit
  // of albedo. This adds no boundary that was not already there.
  float chrF = hash11(floor(syF - bpF.z * uKill3.z) * 2.71 + 9.1);
  float comp = smoothstep(0.28, 0.74, chrF);
  float bfF  = fract(syF);
  // SEDIMENT BANDING - the third stroke family, and the only one that is not a
  // stroke. Round eleven scored detail 4/10 with 'no sediment, no encrustation,
  // no near/far differentiation'. These planes were not bare - there is already
  // a bright seam AT each bed CONTACT further down, and it is pixel-aware, so
  // it widens with distance instead of becoming a hairline. What was missing is
  // anything INSIDE a bed: between two contacts a far wall was one flat tone
  // with cracks in it, so the bedding read as ruling rather than as sediment.
  //
  // One smooth cycle per bed, phase-shifted by the bed's own character. A
  // sinusoid because it is exactly zero-mean over the bed, which a part/cap
  // pair is not - strata() can afford the asymmetry on one near plane, four
  // superposed planes cannot, and the p99 headroom on seed 7 launch is 0.0045.
  // A sinusoid is also the shape that CANNOT draw a hairline: the sharp parting
  // strata() uses is 7-14 world units, which at s=0.135 is a one-pixel dark
  // line every fifteen pixels - graph paper turned on its side.
  // It weakens with distance for the same reason the parting is not used at
  // all: a bed is 65 screen pixels tall on the nearest of these planes and 15
  // on the deepest, and a full cycle inside 15 pixels is a comb, not sediment.
  alb *= 1.0 + 0.26 * (0.34 + 0.66 * (1.0 - comp)) * (1.0 - 0.62 * farK)
             * sin((bfF + 0.21 * chrF) * 6.2832);
  // VERTICAL STRIATION, and it is the one kind of structure that costs the
  // frame no level: a joint is a shadow, so a wall that gains legibility this
  // way gains blacks with it rather than spending them. Same 186-unit spacing
  // as joints() on the near rock, so one fracture set runs through all five
  // planes and perspective shrinks it correctly. No fetch - wave(), sin and a
  // second hash instead - because this runs four times a pixel, and the near
  // rock's segmentation noise fetch would be four more.
  //
  // THIS DREW A RULED HATCH ACROSS THE FRAME, and the cause was the two things
  // it did NOT copy from joints(). The lean was a constant 0.22 and the shear
  // was global, so jsx = c and jsx = c+1 differ by a pure translation in x:
  // every joint on a plane stood at exactly the same angle, and four planes
  // each drawing their own parallel set at their own projected scale is a hatch
  // rather than a few cracks. And there was no segmentation term at all, so
  // each one ran unbroken from the top of the frame to the bottom. Measured
  // with tools/_hair.mjs, seed 7 at 900m, sprite and ribbon passes off: notch
  // 1.331 against a 0.581 bgNoFar floor, so the far walls owned 92% of the
  // ruling in the image.
  //
  // Two per-joint fields fix it, both off a SECOND hash so neither correlates
  // with the joint's own in-cell offset or its width:
  //  - a meander, so adjacent joints do not share an angle. Bounded to 0.105 of
  //    a cell, because a per-joint offset is applied AFTER floor() and a joint
  //    that reaches its own cell edge is truncated there - which would be the
  //    same defect again, one construction later. Worst case: centre 0.245 from
  //    the edge against a 2.5-sigma tail of 0.148.
  //  - a segment field along the length. joints() already records why: a joint
  //    is a chain of segments and an unbroken one reads as a drawn line rather
  //    than as a crack.
  //
  // AND IT STILL DREW ONE. Round nine, four rounds later: 'parallel diagonal
  // hatch strokes of near-identical length and angle across the whole rock
  // face'. Attributed by elimination, not by reading the code - seed 7 at 400m
  // and 900m with the sprite and ribbon passes off, bgNoFar deletes the whole
  // hatched mass, bgNoGrain moves nothing in it (that region is far wall, not
  // trenchRock), and differencing bgNoJoint against the base frame produces an
  // image that IS the hatch and nothing else. The near rock's own joints() moves
  // 2971 pixels by two levels in a 120m frame, all in one patch: it is not in
  // this defect, which is why the fix below is here and not there.
  //
  // The reason the last fix did not take is measurable and is worth writing
  // down, because it is a general one. The meander is a function of w.y with a
  // per-joint PHASE, so it makes each joint wobble about a mean angle that every
  // joint in the file shares - the constant 0.44. Its slope contribution is
  // +-0.109, i.e. +-6.2 degrees. Against a control of 90 strokes of identical
  // length and width, drawn at 20 degrees with a jitter of +-0, 6, 12, 18, 25,
  // 40 and 90 degrees, a directional notch statistic scores 0.617, 0.530, 0.478,
  // 0.441, 0.393, 0.291 and 0.085 - monotone, with the mean-based and
  // tail-based halves agreeing in sign at every step, which is the check
  // AI_HANDOFF section 8 asks for before an instrument is believed. Looking at
  // those controls: +-18 still reads as hatch. +-6 was never going to be enough.
  //
  // So the mean angle itself has to vary in SPACE, and the way to do that
  // without a branch is to warp the coordinate the lattice is cut from rather
  // than to bend the lattice. A curl of a scalar potential is divergence-free,
  // so it rotates the field without piling the joints up or thinning them out,
  // and because the warp is applied BEFORE floor() the cell index, the in-cell
  // offset and the joint core all move together - the truncation hazard that
  // bounded the meander to 0.105 of a cell does not exist for it. It is also
  // exactly what a joint set does in the field: fractures curve around the
  // stress field of the mass they are in.
  //
  //   psi = A sin(Kx x) sin(Ky y),  W = (dpsi/dy, -dpsi/dx)
  //
  // A is set from the largest Jacobian entry, A*Ky*Ky = 0.26, which is the local
  // rotation the warp can apply; the wavelengths are 1150 and 780 world units,
  // so two joints 186 apart see 58 degrees of warp phase between them and do not
  // share an angle even where they are parallel to their own tangent.
  //
  // A RESULT TO BE HONEST ABOUT, because it points the other way. Over four
  // rock-only regions on two seeds, the notch statistics SPLIT: at 900m both
  // _hair.mjs and the directional one improve (notch 0.959 -> 0.953 and 0.946 ->
  // 0.922; ruled 0.288 -> 0.258 and 0.446 -> 0.400) and at 400m both get worse
  // (1.106 -> 1.135 and 1.144 -> 1.157; ruled 0.300 -> 0.372 and 0.385 -> 0.410).
  // The two instruments agree with each other inside every region, so this is
  // real and not noise. It is what a notch statistic is FOR - it counts ink, and
  // the warp varies |grad jsx|, so a joint is wider where the field stretches and
  // narrower where it compresses, and the count of pixels past a fixed depth
  // threshold is convex in width. More angle costs a little more ink. Neither
  // statistic measures the thing the reviewer named, which is the angle
  // DISTRIBUTION; the field measurement below does, and the 3x crops agree with
  // it in both regions where the notch says otherwise. _hair.mjs says so itself:
  // it measures ruling, not correctness, and a rock face should have notch
  // energy in it.
  // THE LEAN MUST STAY BOUNDED AWAY FROM VERTICAL - see FAULT_LEAN above and
  // AI_HANDOFF section 6, where a level set whose slope passed through zero drew
  // a dead vertical line down the whole frame. The fan is wide now, so the base
  // lean pays a little for it - 0.50 rather than 0.44 - and NO MORE THAN THAT,
  // because the lean is not free. The lattice is cut across a sheared x, so the
  // number of joints crossing a screen is (W + L*H)/186: raising L from 0.44 to
  // 0.80 puts 16% MORE strokes on the deepest plane, which is denser hatch, not
  // less, and it showed up as a gate failure rather than as an opinion - seed 7
  // / launch p99 0.2564 -> 0.2489 against a 0.250 floor, with the far-wall lamp
  // zeroed to prove the lamp was not paying for it, and back to 0.2583 the
  // moment the joint block alone was reverted. Joint ink is highlights.
  //
  // Measured on the level set itself rather than on a frame - grain, four
  // superposed layers, camera roll and the bedding all dilute an angle
  // statistic, and the question is a property of the field. Tracing every joint
  // core down four layers and differencing the traced x gives the local lean
  // directly. Before: sd 3.13 degrees about a 23.8 mean, range 15.6..30.8, and
  // 4.70 degrees of change ALONG a joint between samples. After: sd 8.11 about
  // 26.0, range 8.4..42.2, and 12.08 degrees along a joint. The strokes fan two
  // and a half times as wide and each one now curves.
  //
  // ROUND TWELVE, AND THE ACCEPTANCE BAR IT CAME WITH IS NOT REACHABLE. THAT IS
  // A MEASUREMENT, NOT AN EXCUSE, AND IT HAS A CONTROL BEHIND IT.
  // The bar was 'no stroke may have a neighbour within 100 px sharing its angle
  // to within 5 degrees.' Traced on the level set and projected to screen -
  // toLayer divides BOTH offsets by s, so a parallax layer changes a stroke's
  // POSITION and LENGTH but not its ANGLE, and the four planes have to be
  // counted superposed because that is how the eye gets them - the shipped
  // build puts 11.5 other strokes within 100 px of the average stroke. Twelve
  // strokes cannot be pairwise 5 degrees apart inside less than 55 degrees of
  // range even if they are perfectly spaced, and no rock leans 55 degrees of
  // fan. The control says the same thing empirically: 234 strokes at INDEPENDENT
  // random angles over a 76-degree range still scores 95.3% of samples with a
  // twin. A perfectly ruled set scores 100%, so the instrument separates them -
  // it simply has no zero available at this density.
  //
  // So the number that can be driven is TWINS PER STROKE, and it was, three
  // ways: a conjugate set, so the population is bimodal instead of one fan; a
  // thinner population on the far planes; and bed confinement, which shortens
  // strokes so fewer of them reach into any 100 px disc.
  //
  //   joints only      neighbours 11.48  twins 4.06  ->  12.77  twins 2.71
  //   joints + faults  neighbours 14.53  twins 5.39  ->  16.06  twins 4.08
  //
  // Twins fall 35% while the stroke count goes UP, which is the shape the
  // reviewer actually wanted. The angle distribution goes from unimodal
  // 7.6..42.7 (sd 8.07) to bimodal -48.0..42.7 (sd 26.6), and the median
  // nearest-neighbour angle gap goes 0.8 -> 1.3 degrees. tools/_lean.mjs run
  // per family agrees: fissure median 25.5 (min 8.4 off vertical), gouge median
  // -31.0 (min 12.5), so the second family is FURTHER from vertical than the
  // first, not nearer.
  //
  // AND THE RESIDUAL HAS A NAME: THE FAULT PLANES BELOW, NOT THE JOINTS. Adding
  // them to the same trace costs 1.38 twins per stroke, 34% of everything left,
  // because FAULTW is global and faultShear is a function of y ALONE - so within
  // one plane every fault at one height has exactly the same angle, which is the
  // construction the joint set was pulled out of four rounds ago. They survive
  // for now only because the four layers read that shear at four different world
  // y for one screen y. That is the next piece of this work, and it is a
  // structural change to bedFrame's fu, not a tuning one.
  //
  // THE LEAN MUST STAY BOUNDED AWAY FROM VERTICAL - see FAULT_LEAN above and
  // AI_HANDOFF section 6, where a level set whose slope passed through zero drew
  // a dead vertical line down the whole frame. 0.17% of traced core samples come
  // within the 8.9 degrees the camera roll can cancel (bank 0.105 * 1.2 plus
  // shake 0.03) and none within 3; the minimum over the whole field is 8.4
  // degrees. The fault's case does not carry over anyway - its lean is global,
  // so when it crossed zero EVERY plane in the frame went vertical and straight
  // at once, where a warped lean is a function of position and the joint that
  // approaches vertical is already curving through it.
  float wa = w.x * 0.005464 + seed * 2.7;
  float wb = w.y * 0.008055 + seed * 1.3;
  float sa = sin(wa), ca = cos(wa), sb = sin(wb), cb = cos(wb);
  vec2 q = w + vec2(32.22 * sa * cb, -21.86 * ca * sb);
  // THREE STROKE VOCABULARIES, WHICH IS WHAT ROUND ELEVEN ASKED FOR AND WHY.
  // It called the previous build graph paper and this one better, then said the
  // job was half done: 'it is still one stroke vocabulary applied everywhere,
  // and it still produces near-twins... the worst of it is gone; the cause is
  // not.' The cause is that ONE lattice at ONE mean lean can only make one kind
  // of mark, however hard it is bent.
  //
  //  FISSURE  - narrow, dark, leaning the way the trench is cut, BED-CONFINED:
  //             it dies at the contact. Competent beds, near planes.
  //  GOUGE    - the conjugate set. Leans the other way, half again as wide,
  //             softer, sparser, and it CROSSES the beds instead of stopping at
  //             them. Incompetent beds, middle distance.
  //  SEDIMENT - not a stroke at all; see the band folded into alb above. Four
  //             planes back a fracture is under a pixel wide, so what should
  //             survive is the fabric of the bedding as TONE. That is why the
  //             stroke weights fall with farK instead of the strokes simply
  //             getting fainter - a faint hairline is still a hairline.
  //
  // The conjugate lean is -0.62 and NOT the -0.38 that first measured best: at
  // -0.38 the set's upper tail comes within 0.4 deg of screen vertical and 3.6%
  // of its traced cores sit inside the 8.9 deg the camera roll can cancel,
  // which is the FAULT_LEAN trap arriving one construction later. At -0.62 the
  // minimum over the whole superposed field is 8.0 deg and the figure is 0.31%,
  // against 7.6 deg and 0.69% for the single-set build it replaces - so adding
  // a family moved this bound the SAFE way rather than eating into it.
  // The fissure's meander stays at the 0.075 the single-set build shipped.
  // 0.090 was tried and is not worth it: twins per stroke 4.08 -> 4.02, a 1.5%
  // gain, against the minimum angle off screen vertical falling 8.0 -> 7.4 deg
  // and the share inside the camera roll's 8.9 deg going 0.21% -> 0.29%. Buying
  // 1.5% of the defect with the one bound this file has been bitten by four
  // times is a bad trade. The conjugate set is where the angle range comes from.
  float fis = fracSet(q, w.y, 186.0,  0.50, 0.00130, 3.1 + seed,
                      0.44 + 0.20 * farK, seed, 3.17, 7.13, vec2(0.023, 0.036), 0.075);
  float gou = fracSet(q, w.y, 251.0, -0.62, 0.00097, 1.7 + seed * 1.9,
                      0.60 + 0.12 * farK, seed, 4.61, 5.29, vec2(0.034, 0.042), 0.105);
  // BED CONFINEMENT. A systematic joint nucleates inside one bed and arrests at
  // the contact, so this is a clip and not a fade - but it is windowed to
  // exactly zero AT the contact, so the joint cannot draw its own end: it ends
  // on a line alb already draws. Only the fissure is confined. The gouge
  // crossing the beds is what stops every stroke in the frame from terminating
  // on the same horizon, which would be the ruled defect rotated 90 degrees.
  float conf = smoothstep(0.0, 0.075, min(bfF, 1.0 - bfF));
  // Weight by material and by distance. The far ranges soften because the
  // WEIGHTS fall, which is not the same as lowering the exposure: a fainter
  // hairline is still a hairline, and what has to go at distance is the MARK.
  // The near end was 0.62/0.42 for one pass and the gate's detail trend fell
  // about 1% on all twelve frames - the same signature AI_HANDOFF records for
  // the two rounds that were lost to over-optimising a one-sided target, so it
  // came back up. p99 is unchanged either way.
  float wFis = (0.70 + 0.40 * comp) * (1.0 - 0.32 * farK);
  float wGou = (0.45 + 0.60 * (1.0 - comp)) * (1.0 - 0.44 * farK) * 0.86;
  // PRICED, because a second set is a second lattice on every pixel four times
  // over. tools/_perf.mjs at 1600x900, interleaved new/base/new/base so a
  // contended window cannot favour one of them, min of three pairs: the
  // background pass goes 0.138/0.150/0.150 to 0.150/0.162/0.163 ms - +0.012 ms,
  // same sign and size all three times, so about +8%. The gate's own best-of-5
  // render goes 3.55 -> 3.72 (seed 7) and 4.81 -> 5.23 (seed 3) against a 12 ms
  // budget. AI_HANDOFF is right that a minimum over a contended window is not
  // an idle measurement; the interleave is what makes the DIFFERENCE trustworthy
  // even where the absolute is not.
  //
  // max, not sum: two crossing fractures are one void in the rock, and summing
  // them would put a hot black node at every intersection.
  float jnt = max(fis * wFis * mix(1.0, conf, 0.80), gou * wGou) * uKill4.y;
  // ...and the fault plane, which is the one break that must appear on every
  // plane at once. A fault that stops at the foreground is a scratch on the
  // lens; a fault that runs through all five planes is a structure the trench
  // was cut along, and it is free here because fdF is already in hand.
  //
  // IT DOES NOT HAVE TO ARRIVE AS A HAIRLINE ON EVERY PLANE, THOUGH, AND THAT
  // IS THE SECOND HALF OF THE HATCH. FAULTW is 1180 units, so the plane at
  // s = 0.135 shows ten fault planes across the frame and the four together
  // show about twenty - all at FAULT_LEAN, all unbroken by construction, which
  // is exactly what the joint set was before it was segmented. Bisected on
  // seed 7 at 300m with the sprite and ribbon passes off, this term alone is
  // worth notch 0.253 (1.847 with it, 1.594 without, against a 0.559 bgNoFar
  // floor), and with the joint channel zeroed it plainly draws its own ruled
  // set at 1:1. That is a measurement, and it says the joint channel was only
  // ever half of this defect.
  //
  // The fix is NOT to break it - see above, and it stays unbroken here - but to
  // spread it. A slip surface is a hairline; a fault DAMAGE ZONE is tens of
  // metres of broken rock, and which of the two you resolve is a question of
  // how far away you are. So the zone widens and dims with distance, exactly
  // mass-neutral (width x depth is constant, so the blacks the channel buys are
  // untouched: measured flat to four decimals of scene mean, and +-0.3pp of
  // pixels below L8). At s = 0.58 it is bit-identical to the crisp line the
  // near rock draws, and only the deep planes - which carry most of the twenty
  // lines and are the ones that must read low-contrast anyway - soften.
  // Measured, seed 7, sprite and ribbon passes off: notch 1.042 -> 0.971 at
  // 900m and 1.847 -> 1.688 at 300m on top of the joint fix.
  //
  // A per-fault size HIERARCHY off the throw hash was tried here first and is
  // recorded as a negative result: mass-neutral it moved notch by 0.015, which
  // is noise, and the version that did move it (0.996 at 900m) took seed 3
  // tethered from 6.7% to 6.4% of pixels below L8 - level, on the one scene
  // already warning for want of blacks. Width is the axis that pays; weight is
  // not.
  float fsoft = mix(2.30, 1.00, sat(s / 0.58));
  float fwF = (0.0055 + 0.0105 * bpF.w) * fsoft;
  jnt = max(jnt, exp(-(fdF * fdF) / (fwF * fwF)) * (0.90 / fsoft) * uKill3.z);
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
  // The two-stop gradient the review asked for, on the body itself. Not
  // irradiance - that is 'sky' above, which the glow-lit half deliberately does
  // not answer to - but the shading a surface takes from standing under an open
  // reach of trench rather than a sealed one. Mean held near 1.0 across the
  // field, so this buys the plane a 3.6:1 internal swing and costs the frame no
  // level, which is the same trade every other feature in this file is built on.
  float shade = 0.60 + 1.30 * openL;
  vec3 c = rk * V_ROCK * alb * shade
         * (bodyF * (0.015 + 0.985 * pow(sky, 1.70))
            + (0.46 + 0.54 * exp(-intoS / 380.0)) * 0.55 * aw);
  // The bedding seam, at distance. Four layers of legible strata is most of
  // what makes the far walls read as rock instead of as tinted fog, and it
  // costs nothing: the bed coordinate is already in hand.
  float sw = max(0.11, 2.0 * pxL / BEDY);
  c += rk * V_ROCK * 0.50 * (0.11 / sw) * (1.0 - smoothstep(0.0, sw, min(bfF, 1.0 - bfF)))
     * (sky + 1.10 * aw) * exp(-intoS / 650.0);
  // The mote reaches the first plane back and effectively nothing beyond it.
  // SCREEN-ANCHORED, AND THAT IS NOT A SHORTCUT. A wall behind the player, lit
  // by the player, shows its brightest patch DIRECTLY BEHIND HIM. toLayer
  // traces a pixel back to where it would lie on the swimming plane, which for
  // a deep layer is thousands of units off, so keying the mote's light to it
  // put the lit patch a fraction of the way from screen centre to the mote and
  // left it sitting there - a pool that does not follow the hero at all. It
  // measured exactly as badly as it sounds: three places of the mote's global
  // salience on the opening frame of both seeds, spent on a patch that was in
  // the wrong place. Read at the near plane it is a pool around the mote on
  // every layer, which is what a light behind a swimmer actually looks like.
  //
  // pow(s, 2.2) stands in for a z distance this projection does not carry:
  // layer 1 gets a third of the near-plane key, layer 4 a hundredth. Without
  // any of it the plane directly behind the player is the one large surface in
  // frame that ignores him, which is the same defect one step back. Added
  // BEFORE the fog, so aerial perspective veils the mote's light on a far wall
  // exactly as it veils the wall's own.
  float keyN = moteKey(toWorld(uv), roof ? 1.0 : -1.0);
  float keyF = keyN * pow(s, 2.2);
  // The anchors, on the same screen-anchored read and the same depth ladder as
  // the mote's key above. Warm against the wall's cool body, which is the only
  // place in the frame the 'amber means anchor' contract can be stated by
  // LIGHT rather than by an emitter drawing itself.
  //
  // Carried by alb, so what comes up out of the dark is the wall's own strata,
  // joints and per-bed shade - the same argument V_MOTEKEY makes about
  // modulating albedo rather than adding glow, and the reason this reads as a
  // lit surface rather than as amber fog in front of one.
  vec3 lampF = (roof ? lampDn : lampUp) * pow(s, 2.2);
  // Blended on the UNSCALED key, so the hue is a function of distance from the
  // hero and nothing else: keyed to keyF instead, every far plane would jump
  // straight to the deep hue and the pool would change colour across every
  // silhouette it crossed.
  c += mix(rk, vec3(1.0), 0.62) * mix(MOTE_DEEP, MOTE_LIGHT, sat(keyN * 2.1))
     * V_MOTEKEY * alb * keyF * (0.45 + 0.55 * exp(-intoS / 300.0));
  c += rk * V_ROCK * alb * 6.00 * lampF * (0.45 + 0.55 * exp(-intoS / 300.0));
  // The bedding takes it further in than the body does, exactly as it does for
  // the sky and for the mote on the near rock: a parting plane is a gap.
  c += rk * V_ROCK * 2.40 * (0.11 / sw)
     * (1.0 - smoothstep(0.0, sw, min(bfF, 1.0 - bfF)))
     * lampF * exp(-intoS / 650.0);
  // The break of slope, which is what makes a tread the top OF something. The
  // near rock has had one for two rounds - see 'brow' in trenchRock - and its
  // absence out here is the other half of why a far bench read as a stripe: a
  // bright band with nothing under it is a band; a bright band with a line of
  // contact occlusion under it is a plane seen edge on.
  //
  // ON THE ROCK, BEFORE THE FOG - and that distinction is worth two places of
  // the hero's global salience, which is how it was found. Applied to the
  // composite it darkened the BACKSCATTER as well, so it was dimming the water
  // between the eye and the wall: a shadow cast forward through open water,
  // which is not a thing, and a broad enough removal that it took the light out
  // of the mote's own backdrop. Applied here the fog lifts the shadowed rock
  // back toward the haze exactly as it lifts everything else at that distance,
  // so what is left is a shadow ON A SURFACE, which is what was wanted.
  // Measured with bgNoLedge against the same frame: this costs the exposure
  // contract's p99 exactly nothing, which is not obvious and was worth the
  // check - the top one percent of a shallow frame is light SHAFT, and a shaft
  // is added to the composite after this, so darkening the rock underneath it
  // does not touch the beam standing on it. It is paid for out of the bulk,
  // which is where an occlusion term should be paid for.
  float bd3 = intoS - 42.0 * fsK * 1.35;
  c *= 1.0 - (roof ? 0.0 : 0.28 * uKill3.y)
     * exp(-(bd3 * bd3) / (42.0 * fsK * 42.0 * fsK * 0.42));
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
  //
  // THE EXPONENT IS THE LADDER BETWEEN THE PLANES, and it matters more than the
  // level does. At 0.55 the four layers' floors spanned 1.43:1, so four planes
  // that differ in fog converged in value anyway and the review's acceptance
  // test - every depth layer distinguishable at every capture distance - could
  // not be met by any single fog setting. At 1.60 they span 2.6:1: the deepest
  // plane keeps the floor that recovered it last round, and the nearest gives
  // up half of its own, which is precisely the plane that sits behind the
  // foreground flora and was burying it.
  //
  // ...and it has to CARRY THE PLANE'S ALBEDO, or the plane has none. Measured
  // at 25m this floor was worth fourteen times the wall's own sky-lit body, so
  // every gradient authored above - the openness shading, the bedding, and in
  // particular the vertical striation a review singled out as the one thing
  // that made a recovered wall plane read - was modulating a sixth of the
  // answer while five sixths of it sat flat. One plane measured 0.060 of
  // luminance spread against 0.173 for the frame around it.
  //
  // A joint is a fracture in the rock, and rock seen through backscatter is
  // still rock: the composite has to keep the wall's identity even where the
  // water in front of it supplies most of the light. Mean held at exactly 1.0,
  // so this is contrast and costs the frame no level at all - the same trade
  // every other feature in this file is built on.
  // The depth term is the second half of the same argument. Backscatter is
  // strongest against the part of a plane the eye is closest to - its lit edge
  // and the face below it - and a receding mass a thousand units inside its own
  // silhouette is the darkest thing a shallow frame has. Flooring that as hard
  // as the edge is what put four scenes under the 8% blacks floor; a 1.7:1
  // fade, mean 0.90, gives them back without touching the edge, the crenellated
  // bottom and the striation, which is all a review ever reads a plane from.
  vec3 gl = uCMid * V_GLOW * pow(1.0 - s, 1.60) * glowM * (0.30 + 0.70 * alb)
          * (0.68 + 0.48 * exp(-intoS / 750.0));
  o = sqrt(o * o + gl * gl);
  // The rim along the edge the light actually falls on. A bench top takes the
  // downwelling squarely and is the brightest rock on a far plane; a roof's
  // edge faces down and gets only what the water bounces back. Keyed to this
  // layer's own openness, so the rim brightens under a fissure and goes out
  // under sealed roof - which is what stops it reading as a stroked outline
  // round a cutout. Its mean multiplier is BELOW the flat 1.0 it replaces, so
  // the extra contrast is paid for out of the sealed stretches, not out of p90.
  // A BENCH HAS A TREAD, and that is the difference between a receding plane
  // and a cutout with strata printed on it. The profile above is snapped to the
  // bedding, so the flat stretches of an upward-facing skyline ARE bed tops -
  // planes that face the downwelling squarely - and lighting the first forty
  // units below them at a plainly higher value than the face is what makes the
  // mass read as solid. Flat-topped and crisply terminated on purpose: a smooth
  // exponential skirt is a glow round an edge, and a glow round an edge is the
  // stroked outline this file keeps having to remove. Paid for out of the old
  // wide skirt, so the mean rim energy on a floor edge barely moves.
  // Brightened by exactly what it loses in width, so foreshortening a bench
  // costs the frame no light at all - it only redistributes it. A top surface
  // seen from further away reads as a bright LINE along a skyline rather than a
  // band, and a line at the same energy is both the stronger perspective cue
  // and the better citizen of an exposure contract that wants real highlights
  // and a dark bulk. Capped, because the deepest plane would otherwise want
  // three times the amplitude and a far bench is not a light source.
  float tread = (roof ? 0.0 : 0.30 * uKill3.y) * min(2.6, 1.0 / fsK)
              * (1.0 - smoothstep(24.0 * fsK, 42.0 * fsK, intoS));
  float rimF = exp(-intoS / 18.0) + 0.15 * exp(-intoS / 44.0) + tread;
  o += uCHigh * V_FARRIM * sky * (roof ? 0.30 : 1.00) * (0.50 + 0.95 * openL)
     * (1.0 - fog) * rimF;
  // AND THE ANCHORS GET A SHARE OF THAT EDGE. The near rock's rim already
  // splits between the lamp and the mote for a stated reason - an edge is where
  // a light's DIRECTION is most legible - and it is the cheapest highlight
  // energy in either pass, seventeen units wide against a whole plane. Measured
  // on the body term alone, tripling the level moved the peak display delta
  // from 9 to 12: the grade's toe eats a broad lift on rock this dark, so the
  // read has to be bought with contrast on an edge rather than with level on a
  // face. That is the same trade the rest of this file is built on, and it is
  // why this is here and not in the body coefficient.
  //
  // After the fog, like the rim it rides, so a warm edge four planes back is
  // still veiled by the water in front of it.
  //
  // What the whole far-wall lamp is worth, isolated by differencing against the
  // same build with the three terms zeroed, seed 7, sprite and ribbon passes
  // off: 102638 pixels moved by two display levels or more at 400m and 62553 at
  // 900m, peaking at 19 and 16. What it COSTS, across all twelve gate frames:
  // p50 +0.0005 at worst against a 0.030 ceiling, p90 +0.0006 against 0.150,
  // max unchanged to three figures, and p99 UP on nine frames - a rim is
  // highlight energy, so this pays into the statistic the contract is tightest
  // on rather than out of it. It also cleared the one standing warning on the
  // suite: seed 7 / fast crushed shadows 36.5% -> 35.2% against a 36% ceiling.
  // The number that moved the wrong way is seed 3 / launch, whose shadow
  // fraction went 9.1% -> 8.1% against an 8% floor. That is the binding
  // constraint on this term now, and it is why the body coefficient is 6.00
  // rather than higher.
  o += lampF * V_FARRIM * 3.40 * (1.0 - fog) * rimF;
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
  // The mask the floor under the far planes works inside. Its COVERAGE is the
  // design parameter - it decides what fraction of a frame's blacks survive -
  // so it is authored as a threshold on the cloud field and nothing else.
  //
  // The UNGATED half was 0.58, and in a lit frame that half is the entire term.
  // It laid a flat slate floor over four receding planes at 25m: measured, the
  // near far-wall region sat at mean 0.147 with 0.060 of luminance spread while
  // the frame around it ran 0.128 and 0.173, and killing the far planes outright
  // let the branching coral in front of them read all the way to the floor
  // instead of being amputated at the waist. A frame that has light in it does
  // not need a floor under its far walls; it needs them out of the way of what
  // is in front of them. A sealed frame, where unlit is 1, is untouched.
  float glowM = cloud * (0.30 + 0.70 * unlit);

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
  // One pass over the lights for all four receding walls - see lampPair. The
  // lamp is read at the near plane for the same reason the mote's key is, so
  // it is a screen-space quantity and evaluating it per layer would be four
  // copies of one answer.
  vec3 lampUp, lampDn; lampPair(w, lampUp, lampDn);
  vec4 r4 = farWall(uv, 0.135, 4.3,  1060.0, 880.0, 980.0, 0.560, haze, cloud, awN, veilK, glowM, brk, lampUp, lampDn);
  col = mix(col, r4.rgb, r4.a * uKill2.x);
  vec4 r3 = farWall(uv, 0.225, 19.7,  980.0, 790.0, 900.0, 0.440, haze, cloud, awN, veilK, glowM, brk, lampUp, lampDn);
  col = mix(col, r3.rgb, r3.a * uKill2.x);
  vec4 r2 = farWall(uv, 0.360, 37.1,  920.0, 730.0, 800.0, 0.300, haze, cloud, awN, veilK, glowM, brk, lampUp, lampDn);
  col = mix(col, r2.rgb, r2.a * uKill2.x);
  vec4 r1 = farWall(uv, 0.580, 61.9,  880.0, 690.0, 720.0, 0.175, haze, cloud, awN, veilK, glowM, brk, lampUp, lampDn);
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
  // Measured from the un-benched floor on purpose. drawnBot costs a noise fetch
  // for the bedding frame it snaps the tread to, and paying it twice a pixel
  // measured at a fifth of a millisecond; the silt is a billowing haze with a
  // 26-181 unit scale height that is killed inside rock by (1 - r0.a) anyway,
  // so all a bench can do to it is offset the layer slightly. The rock cares
  // where its own top surface is; the haze above it does not.
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
  // WHAT THE HUSH IS MADE OF, after three rounds of getting it wrong: a lobed
  // front, a mass of dark behind it that is the darkest thing in the frame, and
  // a rim of dying bioluminescence on it - the last flare of the motes it is
  // eating. What it is NOT made of is lines. A field of erosion tendrils lived
  // here for two rounds; both times it was retuned rather than reconsidered,
  // and the second time a blind review called it "the single ugliest region in
  // all eight images" - five or six long, straight, hard-edged lavender streaks
  // reading as a broken lens flare, running straight through the hero's own
  // motion arc at 1000m. The defect was structural: a row field sheared against
  // a vertical front can only draw near-horizontal lines, and a horizontal line
  // across a frame reads as a lens artefact whatever colour it is. A cell of
  // points cannot draw a line at all, which is why it is the right primitive.
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
  //
  // The two mid-scale terms are what make the front LOBED. Without them the
  // only raggedness was a 10800-unit wave and a 2300-unit tongue - one
  // twentieth and one half of a cycle across a screen - so the boundary was to
  // all intents a straight vertical line, and a straight line is exactly what
  // this file has twice been told the Hush must not be. At 885 and 385 units
  // the front grows two or three fingers per screen and they are not evenly
  // spaced, because the two periods are incommensurate.
  float reach = 780.0 + 1720.0 * hushK
              + wave(w.y, 0.00058, 0.9) * 210.0
              + wave(w.y + uTime * 12.0, 0.00710, 2.6) * 130.0
              + wave(w.y - uTime * 7.0, 0.01630, 4.4) * 55.0
              + pow(sat(0.5 + wave(w.y, 0.00270, 5.1 + uTime * 0.30) * 0.55), 3.0) * 320.0;
  float ed = dxh - reach;
  // Tapered off BEHIND the front, where the block below already owns the
  // crush: stacked, the two took the Hush frame to 38% below sRGB 8 and its
  // spread from 0.221 to 0.173 - a wall of dark with nothing in it.
  float drain = uKill.w * exp(-max(ed, 0.0) / 1150.0)
              * smoothstep(-460.0, -40.0, ed);
  // The leading edge is a RIPPLE in the medium, not a line drawn across it: the
  // water bends before it goes. The frequency was 0.0165 - a 380-unit period,
  // three stripes down a screen inside a 230-unit-wide band, which is a set of
  // short horizontal bars and was part of what the review read as streaks. At
  // 0.0042 it is less than one cycle per screen: a bend, not a corrugation.
  float lead = uKill.w * exp(-(ed * ed) / 26000.0);
  float rip = wave(w.y + uTime * 26.0, 0.0042, dxh * 0.0022);
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

  // GATED ON THE FRONT, NOT ON A FIXED WORLD X. This was dxh < 3000, and every
  // term inside is a function of the distance to the drain front, whose reach
  // runs 1905-3215 units - so the bound sat INSIDE the range the front itself
  // can occupy. Where reach approached 3000 the rim on the front, worth up to
  // 0.44 linear, was cut in half by a dead-straight vertical line at exactly the
  // world x the branch tested. That is the same defect class as the fault seam
  // this round fixed and it was found looking for it. On ed it is provably
  // outside everything: the front rim is exp(-ed^2/15000), dead by ed=620, and
  // the interior crush is zero past ed=25. It is also no more pixels than the
  // old bound took at a typical reach, so it costs nothing.
  if(ed < 620.0 && uKill.w > 0.5){
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
    // instead of making it a flat cutout. RESERVE BLACK FOR IT: at 0.10 the
    // interior was still a dark violet field rather than an absence, and black
    // is only a signal if nothing else in the frame is using it.
    float drained = 1.0 - smoothstep(-130.0, 25.0, ed);
    float still = drained * (0.56 + 0.44 * (1.0 - smoothstep(0.0, max(reach, 1.0), max(e, 0.0))));
    float lum0 = dot(col, vec3(0.25, 0.62, 0.13));
    col = mix(col, mix(col, vec3(lum0), 0.80) * 0.062, still * 0.94);

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
    // and stop dead behind it. The 560-unit half-width put this at a third of
    // its peak all the way out to the left edge of a 1000m frame - a flat
    // lilac field over the left quarter of the image, which is what a review
    // read as "a flat violet field" and is the opposite of a wall of dark. At
    // 360 units, and a third of the level, it is a halo on a front again.
    float gd = e >= 0.0 ? e / 360.0 : -e / 190.0;
    // The one term with a tail long enough to still be worth something at the
    // gate: a Lorentzian is at 5% four half-widths out, and 5% of this is a code
    // value or two of violet with a hard edge on it. Windowed to zero at the
    // bound, so the branch cannot draw its own boundary whatever the reach does.
    col += uCHushGlow * V_HUSH * 0.0072 * rv
         * (1.0 - smoothstep(180.0, 620.0, ed)) / (1.0 + gd * gd);

    // A RIM OF DYING BIOLUMINESCENCE. What the front is actually doing is
    // consuming the life in the water, so the honest way to draw its edge is
    // the last flare of the motes it is taking: each one brightens as the front
    // reaches it, whitens, and goes out. Points, never lines - see the note at
    // the top of this section for why that distinction is the whole fix.
    //
    // The phase is read at the cell's own centre, not at the pixel: a 139-unit
    // cell spans a fifth of the 620-unit life ramp, so evaluating it per pixel
    // makes one mote brighter on its left than its right, which is a gradient
    // across a point sprite and reads as a smear. There is no state to keep -
    // the front is what moves, so a mote's life is a function of its distance
    // ahead of the front and nothing else, and it advances exactly as fast as
    // the wall does.
    if(ed > -420.0 && ed < 300.0){
      const float DCELL = 0.0072;               // ~139 world units per cell
      vec2 g = w * DCELL + vec2(0.0, uTime * 0.021);
      vec2 cl = floor(g), fc = fract(g);
      float hd = hash12(cl + 3.9);
      if(hd > 0.46){
        vec2 ctr = cellCentre(hash22(cl + 19.3));
        vec2 dv = fc - ctr;
        float q = dot(dv, dv);
        float phC = sat(((cl.x + ctr.x) / DCELL - uHushX - reach + 300.0) / 620.0);
        float flare = exp(-(phC - 0.34) * (phC - 0.34) / 0.026)
                    * (0.55 + 0.90 * fract(hd * 37.1));
        float rr = 0.020 + 0.026 * fract(hd * 11.7);
        col += mix(mix(uCHushGlow, vec3(1.0), 0.30), BIO_MINT, sat(phC * 1.6 - 0.15))
             * V_HUSH * 0.038 * flare * cellWindow(fc)
             * (exp(-q / (rr * rr)) + 0.22 * exp(-q / (CELL_RMAX * CELL_RMAX)));
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

  // Approach pressure, so the wall is felt even when it is entirely off screen.
  // SUBTRACTIVE ONLY. What a mass of dark does at a distance is take light and
  // colour OUT of the water; it does not add a violet cast to it. This used to
  // raise blue by 14% and add a flat glow on top of that, and a review reading
  // the left quarter of a 1000m frame called the result "a flat violet field" -
  // which is a filter, not an antagonist. Every channel of the tint is now
  // below 1.0, so the only colour left is what survives the desaturation, and
  // the exponent is steeper so the pressure stays near the edge it comes from.
  // Under the same kill switch as the wall itself, or attributing a violet cast
  // has to be done by reading.
  if(uHushProx > 0.01 && uKill.w > 0.5){
    float g = pow(1.0 - uv.x, 3.2) * uHushProx;
    col = mix(col, mix(col, vec3(dot(col, vec3(0.25, 0.62, 0.13))), 0.72)
                 * vec3(0.72, 0.62, 0.96), g * 0.55);
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
    new Float32Array([on('bgNoLamp'), on('bgNoLedge'), on('bgNoDip'), on('bgNoTalus')]),
    // bgNoMoteKey isolates the HERO's light from the anchors', which bgNoLamp
    // cannot: they share one expression and the anchors are ten times wider, so
    // for three rounds every measurement of 'does the mote light the rock' was
    // actually measuring an anchor. Killing this one and diffing the frame is
    // how the 270-450 unit geometry in V_MOTEKEY's note was established, and it
    // is the only honest way to answer the question at all.
    // bgNoJoint drops the joint channel on BOTH the near rock and the far
    // walls while leaving the fault (bgNoDip) standing, which is the one
    // bisect that separates the two diagonal line sets in this file.
    new Float32Array([on('bgNoMoteKey'), on('bgNoJoint'), on('bgNoAnchorLight'), 1]),
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
    const [k1, k2, k3, k4] = killMasks();
    this.kill = k1; this.kill2 = k2; this.kill3 = k3; this.kill4 = k4;
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
    gl.uniform4fv(u.uKill3, this.kill3);
    gl.uniform4fv(u.uKill4, this.kill4);
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

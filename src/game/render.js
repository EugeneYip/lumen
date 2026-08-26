// Scene assembly. Draw order *is* the art direction, so it is explicit here
// rather than hidden behind a generic sorting layer.
//
// Occluders and light alternate in *depth rounds*. One global occluder pass can
// never let a near silhouette eat a far glow, which is exactly why the scene
// used to read as additive mush with no layering.
//
//   background shader
//   round 1  far decor        silhouette -> its own light
//   round 2  near decor, hazards, anchors  silhouette -> their light
//   round 3  plankton, hush, trail, tether, mote, particles, ambient (light only)
//
// Rules that earn their keep here:
//
// 1. This renderer only knows quads and polylines, so solid dark bodies are
//    built by stroking a shape's *medial axis* with a low-falloff ribbon: a
//    falloff near 1 turns the gaussian cross-section into a filled body instead
//    of a filament, and a width function gives the body its profile.
//
// 2. A ribbon's visible core is width*sqrt(ln2/falloff). Under about four world
//    units that core is sub-pixel, and a sub-pixel line samples as a *dotted*
//    line - which reads as a debug primitive, not as light. So crisp features
//    use a low falloff and an honest width, never a hairline with a tight
//    gaussian. wCore() below is the conversion.
//
// 3. Hazard light logic is INVERTED, deliberately. Every other emitter in the
//    game is hot-cored; the hazard is dark-cored and hot-rimmed. A blind review
//    measured the old hazard at p99 105 against a reward's 228, with 3% of its
//    pixels red-dominant and its forty brightest averaging *green* - ambient
//    teal had eaten the hue, so the one object that must be read pre-emptively
//    was the darkest and least chromatic thing on screen. A ring of hot rim
//    around a hole reads as an occluder at any distance and can never be
//    mistaken for a reward. Note the constraint that shapes it: additive light
//    inside a round cannot be occluded by that round's own silhouette, so the
//    hazard's light is laid as an *annulus* and along its spines, never as a
//    disc centred on the shell - a centred veil would fill the core it exists
//    to keep dark.
//
// 4. The value ladder is authored, not emergent, and it is this - in order, and
//    the order is the point:
//
//      mote      brightest, and the only object allowed a white-hot nucleus
//      plankton  bright crisp points, second, because they are the reward
//      anchors   large and warm, third - counterpoint, never the brightest
//      hazard    read by *hue* and by dark-core-hot-rim, never by brightness
//
//    It inverted once and it was not obvious from any single object: the mote had
//    a hot nucleus but a broad dim body, while anchors and plankton had been
//    widened to satisfy an HDR statistic, so at a 2x crop the protagonist was
//    the dimmest interesting thing in frame. Brightness is read over *area*, not
//    at a peak. When adding light anywhere in this file, check where it lands on
//    that ladder before checking whether it looks nice. And check it as ENERGY,
//    which is peak x area - see _emit. Ranking by peak alone is what turned the
//    ambient field into uniform discs and the hand-placed props into airbrush,
//    because the cheapest way to lower a peak is to spread it, and a spread
//    emitter is both less legible AND more salient than the one it replaced.
//
// 5. The Hush consumes what it reaches; it is not a curtain drawn over it. A
//    lamp inside the violet field loses saturation first and value second
//    (_eat / _ate). An amber anchor still burning at full saturation inside a
//    wall of dark was the single thing that broke the illusion.
import { Blend } from '../engine/gl.js';
import { SpriteBatch } from '../engine/sprites.js';
import { Ribbons } from '../engine/ribbons.js';
import { S } from '../engine/textures.js';
import { PAL, depthFade, scaled, absorb } from '../art/palette.js';
import { KIND } from './world.js';
import { clamp, clamp01, lerp, smoothstep, mixCol, TAU } from '../engine/math.js';
import { noise1, hash2 } from '../engine/rng.js';

// Colour registers. Nothing in this file may allocate per frame.
const c0 = [0, 0, 0], c1 = [0, 0, 0], c2 = [0, 0, 0], c3 = [0, 0, 0];
// Per-object palette registers. The Hush rewrites an object's *whole* palette,
// so it needs somewhere to put four colours that outlive the scratch registers.
const o0 = [0, 0, 0], o1 = [0, 0, 0], o2 = [0, 0, 0], o3 = [0, 0, 0];

// A texture agent may add layers; resolve optional ones against a fallback so
// this file renders correctly against either version of the kit.
const LY = (name, fb) => (S[name] !== undefined ? S[name] : fb);
const L_LEAF = LY('LEAF', S.SHARD);
const L_ROCK = LY('ROCK', S.SMOKE);
const L_MEMB = LY('MEMBRANE', S.BLOB);

// The hero's own hue. A blind review measured the mote as cyan in a cyan
// environment - "the hero owns no hue of its own, while the amber anchor is the
// warmest, most saturated, brightest thing in frame" - so the thing you grab
// out-ranked the thing you are. palette.js is not ours to edit and adding a
// fourth accent would break the three-jobs rule, so the mote's skin is derived
// here from moteOuter by pulling red and green down: the same family, a higher
// saturation, and a measurable rotation away from the water's green-teal
// (PAL.surface) toward azure. Value hierarchy is unchanged; only the hue moves.
const SKIN = [PAL.moteOuter[0] * 0.55, PAL.moteOuter[1] * 0.78, PAL.moteOuter[2] * 1.06];
const FLESH = [PAL.moteInner[0] * 0.62, PAL.moteInner[1] * 0.88, PAL.moteInner[2] * 1.00];

const MAXP = 96;         // longest polyline any shape here needs
const FAR = 0.44;        // decor depth that moves an object into the far round
const CORE_MIN = 4.2;    // world units: below this a ribbon core aliases to dots
// How folded a path has to be before what is drawn along it starts to fade.
// Measured as chord over arclength between two points on it, which for a
// circular swing is a pure function of the angle turned - 1.00 straight, 0.90 at
// a quarter turn, 0.64 at a half, 0.30 at three quarters, 0 when it closes - and
// is scale free, so the same pair of numbers works for the wake, for the flow
// line the cilia hang off, and at any zoom.
//
// The window is measured, not guessed: over 70s of autopilot on seeds 7, 3 and
// 11 the median frame's most returned wake sample sits at 0.94 and the lower
// quartile at 0.83, so at 0.80 nothing in normal play is touched at all, while
// below 0.30 the path is laying a second arc back across itself.
const FOLD_LO = 0.30, FOLD_HI = 0.80;

// Emitter cores run at genuinely hot linear values - see the exposure contract
// in AGENTS.md, which the frame must peak above 6.0 pre-tonemap. Halation, the
// bloom veil's long tail and the tonemap shoulder all key off the top end; a
// core sitting at 1.2 leaves the entire response curve unexercised and light
// stops looking like light. Hot regions are kept a few pixels wide so the bulk
// of the frame stays deep shadow (p50 < 0.03).
// Two measurements constrain the numbers below, and they pull against each other
// through the bloom, so these are measured rather than chosen.
//
// 1. `hdrStats().max` used to be a 96x54 grid sample, so a hot lobe a few pixels
//    wide was missed about 19 times in 20 and the HDR contract failed at random
//    while the nucleus was genuinely at 22 linear. Several widths in this file
//    were authored to be caught by that grid. It is an **exact per-pixel scan**
//    now, so that reason is gone: nothing has to be wide in order to be
//    measured, and the numbers those widths were chosen against were pessimistic
//    by roughly 5x. Anything still wide "for the statistic" is now pure cost -
//    the frame peaks above 60 linear against a contract of 6.
//
// 2. Focal contrast is the mote's core against its own surround, and the exact
//    geometry matters because it decides what is free and what is not. check.mjs
//    measures on a 192x108 downscale of the frame: core is the max within r<=2,
//    surround is the mean over 5<=r<=7. At 1600x900 that is a **17px core
//    against a 42-83px annulus**, with a dead band between them. So light inside
//    17px is signal, light beyond 42px is cost, and light in between is free.
//    That is where a rim belongs, and where this file now puts it.
//
// Together: keep the mote's light inside about 30px of its body, spend width in
// the dead band, and never buy an HDR statistic with area. A plateau on the mote
// bright enough to be sampled reliably was tried and measured - it moved the core
// from 0.907 to 0.970 (already saturated) and the surround from 0.294 to 0.727.
// The core saturates long before the surround does, which is the asymmetry every
// decision here turns on: once the core is near 1.0 the *only* remaining lever is
// to starve the annulus.
const HOT = 34;          // peak gain of the mote nucleus - the one knob

// Gain of the 'ripe' third of the plankton field. Raising a *gain* is the safe
// way to satisfy the top end; raising a *width* is not, and the difference is
// the whole lesson of point 1 above. One caution that still stands: taking the
// anchor cores from 11 to 15 once made the first render of a frozen state differ
// from the next four by one code value where they hang, so something on the post
// side settles after a frame once they are that hot. tools/_det3.mjs catches it.
// Peaks in this file are therefore moved reluctantly and areas freely.
const HDR_FLOOR = 21;

// ------------------------------------------------ the hero's reserved value ---
// A ceiling on the peak of every sprite this file emits for a WORLD object,
// applied as a CLASS at the one point where light leaves for the batch rather
// than per emitter, so no later retune of an individual creature can breach it.
// Same construction as particles.js's emit(), for the same reason, and the
// numbers come from the same place: inverting the shipped tone curve rather
// than picking them. postfx applies Hable with WHITE_REF 12.3 over a white
// point of 11, so a linear surface brightness lands on display white as
//
//     linear    1.30   3.00   5.00   11     21     30
//     display   0.51   0.72   0.81   0.91   0.95   0.96
//
// and the top of that table is the whole problem. Measured by isolation on
// seed 7 - drawing one family into an otherwise empty frame and reading
// hdrStats().max - the build this replaces shipped:
//
//     mote       28.4 - 33.6      display 0.962 - 0.967
//     plankton   29.5 - 33.4      display 0.963 - 0.967      <- a tie
//     anchor     10.2 - 17.0      display 0.900 - 0.930
//     anemone     2.6 -  4.0      display 0.700 - 0.775
//     kelp        0.9 -  2.1      display 0.420 - 0.640
//
// The protagonist and the collectible were the same value to within one code
// value, and there are thirty to forty collectibles in frame. That is exactly
// the standing review finding - "hand this still to someone cold and ask them
// to point at their character, and they will point at a particle" - and it is
// arithmetic rather than taste: above about 8 linear the curve has 0.06 of
// display range left, so every emitter authored hot lands in the same band and
// the hero cannot be the brightest thing however hot it is drawn. The gap has
// to be made in the CEILING, not in the gain. Rule 4 is finally enforced
// rather than asserted, and the enforcement is structural.
//
//   CEIL_DECOR   kelp lamps, anemone tips, spire glints. Scenery is never the
//                subject of a frame: the bottom half of the range.
//   CEIL_REWARD  plankton - the one thing in the world layer the player is
//                meant to chase, so it gets the top of the world's band and
//                nothing above it.
//   CEIL_WARM    anchors, the tether's beads, the hazard rim. These are lamps,
//                so they keep the hottest peak in the world layer - but a full
//                stop below the hero instead of a fortieth of one.
//
// The mote is exempt because it IS the subject: _mote owns everything above 6,
// which is also the exposure contract's emitter-core floor, and it is the only
// object in the game allowed a white-hot nucleus.
//
// Ribbon light is not routed through here and does not need to be: every stroke
// in this file is a depth-faded palette colour at alpha < 1, and the family
// isolation above measures the hottest of them (the urchin's rim) at 1.5. The
// gains live on the sprite path, so that is where the class point belongs.
const CEIL_DECOR = 1.30, CEIL_REWARD = 3.0, CEIL_WARM = 7.6;
// ...and one tier the pass that introduced these did not have, which is what it
// got wrong. CEIL_PROP is for HAND-PLACED SET PIECES - the anemone colonies,
// the kelp lamps. They are not ambient particles and must not be governed as if
// they were: there are one or two of them in a frame rather than forty, and the
// entire reason a ceiling exists is that forty of a thing at the hero's value is
// a tie while one of a thing at two thirds of it is a scene.
//
// A blind review named this population unprompted, in both directions. Before
// the cap: "beaded filaments". After it: "a gas cloud... the coral/anemone
// bursts, which are set-piece props, not ambient particles, got caught in the
// same net and turned to airbrush." The defect was never the number 1.30. It was
// charging a population of two the price of a population of forty.
const CEIL_PROP = 4.4;
// CEIL_WARM is no longer a clamp on the lamps either, and that is the same
// correction again. The anchor core is authored at k*4.9 with k running to 1.55,
// i.e. 7.6, so a 5.0 ceiling spread every anchor's quad by 23% and divided its
// tint by 1.5: identical energy, worse shape, which is precisely the error being
// undone everywhere else in this pass. The tier is set to the value its own
// lamps are authored at, and enforcement becomes "nothing in the world layer may
// exceed the lamps" rather than "the lamps are clamped".

// A footprint at or under this many SCREEN pixels keeps its peak, whatever class
// it belongs to. This is the correction that matters, and it is arithmetic
// rather than taste. What a salience metric sums is L^2 over a block, so an
// emitter's cost is peak x AREA - and those two are not interchangeable to the
// eye. A 2px near-white point costs a fiftieth of what a 30px disc of the same
// peak costs, and it is the only thing in a small object a viewer can point at;
// a dim wide disc of the SAME ENERGY costs all of it and reads as fog. So: cap
// the energy, not the peak, because the cheapest energy in a frame is a hot
// point and the most expensive is an even one.
const SPEC_PX = 11;
// The exemption is not unlimited. Nothing in the world layer may enter the
// hero's reserved band, and that band now starts at the lamps.
const CEIL_HOT = 7.6;

// The screen size a near-white core is held to, and the reason it is a size at
// all rather than a gain.
//
// Below about a dozen screen pixels a CORE quad has no profile left in it: its
// hot lobe is exp(-105 r^2), i.e. 5% of the quad's width, so the sampler picks a
// mip four or five levels down and what lands is a flat block of three or four
// texels with a stair-stepped edge - not a point with a falloff. Found at 6x in
// the plankton field as pale neutral squares 3-4px across, and it was in the
// shipped build too; it only became conspicuous once the field around it stopped
// being blown white.
//
// The pass before drew too wide a conclusion from that and deleted the hot core
// everywhere, which is how ambient life lost its point sources and the props
// turned to airbrush. The narrow conclusion is the right one: it is CORE's 5%
// lobe that cannot survive minification, not hotness. GLOW and PLANKTON put
// 11-16% of their quad in the nucleus, so a quad held to CORE_PX renders a 2-3px
// nucleus with real falloff in it - the near-white core an organism is read by,
// at a hundredth of a wide disc's area cost.
const CORE_PX = 10;

// The Hush's absorption profile, in world units. Light starts to go before the
// front arrives (the field has a leading edge of scatter) and is gone well
// behind it, rather than switching off at a line.
const HUSH_LEAD = 220;
const HUSH_DEEP = 760;

/** Ribbon width that renders a visible core `core` units wide at `falloff`. */
const wCore = (core, falloff) => Math.max(core, CORE_MIN) * Math.sqrt(falloff / 0.693);

// Authoring floor for a ribbon width, and its history is worth keeping because
// the reason it exists has changed underneath it.
//
// It was originally a *determinism* fix. Ribbons used to widen anything thinner
// than 1.3px on the CPU and divide its alpha to match, but it read the pixel
// scale from `ppu`, which flush() only refreshed for the *next* batch - so ppu
// was zero on the first flush of the first render and every taper reaching
// sub-pixel width drew differently on frame 1 than on frame 2 forever after.
// Round 1 is the only round submitted before any flush has run, which is why the
// symptom was 14 pixels along the *top* of the frame off by one code value: the
// far stalactites' collapsing tips, drawn at alpha 0.985. tools/_det3.mjs was
// the instrument that named it, after it had been misread for a while as "the
// post side settles after a frame once the anchors are that hot" (see
// HDR_FLOOR). It was neither the post chain nor hotness.
//
// That hazard is gone: ribbons.js now computes coverage analytically in the
// fragment shader from fwidth(vV), which has no frame-order dependence at all,
// and its CPU `_fit()` is a stub returning 1. So this is no longer load-bearing
// for determinism.
//
// It is kept because it is still the right *look*. 3.0 world units is about
// 2.5px at 1600x900, and trading width for alpha below that conserves energy
// while keeping a tip from being authored as a hairline - which aliases into a
// dotted line under a moving camera whatever the shader does about coverage. A
// tip still looks exactly as tapered, because alpha falls as the true width does.
const WMIN = 3.0;
/** Floor a ribbon width, fading rather than thinning below it. */
const wFloor = (w) => (w > WMIN ? w : WMIN);
/** The matching alpha: below the floor, fade rather than widen. */
const aFloor = (w, a) => (w > WMIN ? a : a * (w / WMIN));

export class Scene {
  constructor(gl, tex) {
    this.gl = gl;
    this.occl = new SpriteBatch(gl, tex.sprites, 4096);
    this.glow = new SpriteBatch(gl, tex.sprites, 12288);
    this.rDark = new Ribbons(gl, 49152);
    this.rGlow = new Ribbons(gl, 65536);
    this._hx = -1e9;             // Hush front, world x. Set per frame in draw().
    this._ppu = 1;               // screen pixels per world unit; see SPEC_PX.

    // Ribbons.stroke() needs an exactly-sized array, so cache every view up
    // front rather than minting a subarray per shape per frame. Three pools =
    // three polylines can be live at once (body, rim, appendage).
    this._pool = [new Float32Array(MAXP * 2), new Float32Array(MAXP * 2), new Float32Array(MAXP * 2)];
    this._cv = new Float32Array(MAXP);   // per-sample fold taper for the wake
    this._ln = new Float32Array(MAXP);   // and its prefix arclength
    this._spine = new Float32Array(8);   // 4 points down the mote's own flow line
    this._bleed = new Float32Array(10);  // 5 waypoints down the anamorphic bleed
    this._ai = 0;                        // monotonic cursor into world.anchors
    this._view = [new Array(MAXP + 1), new Array(MAXP + 1), new Array(MAXP + 1)];
    for (let k = 0; k < 3; k++) {
      for (let n = 2; n <= MAXP; n++) this._view[k][n] = this._pool[k].subarray(0, n * 2);
    }
  }

  _p1(n) { return this._view[0][n]; }
  _p2(n) { return this._view[1][n]; }
  _p3(n) { return this._view[2][n]; }

  /** How much of the object at world x the Hush has already eaten. 0..1. */
  _eat(x) { return clamp01((this._hx + HUSH_LEAD - x) / HUSH_DEEP); }

  /**
   * The one path from a world emitter into the light batch.
   *
   * Caps ENERGY, not peak, and that distinction is the whole of this pass.
   *
   * The version this replaces clamped the peak to `ceil` and paid the shortfall
   * back as AREA - quad x f, tint x 1/f^2. It measured well, and every number
   * said it worked: hero rank improved on every scene and both seeds, and p99
   * went UP rather than down, because for a falloff of peak P the area above a
   * threshold T goes as w^2 ln(P/T), so spreading buys more above-threshold
   * pixels than lowering the peak loses.
   *
   * What it cost appears in no number at all, and a blind reviewer found it in
   * one pass: ambient life lost its point-source cores and became uniform bokeh
   * discs, and the hand-placed props turned to airbrush. A one-sided salience
   * metric was optimised and object craft paid for it. AI_HANDOFF.md section 8
   * records the attempt to build the counterweight - it moves about 1% on the
   * exact frame where a reviewer can see one prop go from beaded filaments to a
   * gas cloud, because the defect occupies a fraction of a percent of the frame.
   * There is nothing to gate on. This one is judged by looking.
   *
   * So the payback direction is inverted. w*h*pk is held at w*h*ceil by
   * SHRINKING the quad rather than spreading it: the light is concentrated
   * instead of smeared, the peak - which is what reads as an organism - survives,
   * and the area - which is what a block's L^2 actually sums - is what pays. A
   * quad already inside SPEC_PX is left alone up to CEIL_HOT, because at that
   * footprint the area term is far too small to be why a frame's subject is
   * unclear. Nothing shrinks below SPEC_PX either, since a sub-pixel quad has no
   * profile left in it; there the remainder comes off the peak instead.
   *
   * This file still carries most of "there must be real highlights" - suppressing
   * _plankton alone took seed 7 / fast from p99 0.268 to 0.224 against a contract
   * floor of 0.250 - and concentrating rather than spreading protects that too:
   * the area lost to w^2 comes back through ln(P/T) at the higher peak.
   *
   * IT ALSO FLOORS EVERY CHANNEL AT ZERO, and that is a fix rather than
   * defensive habit. This batch is flushed ONE,ONE: a negative colour on an
   * additive quad subtracts light. It cancels whatever else lit those pixels,
   * the tonemap clamps the sum at black, and what lands in the frame is a
   * hard-edged pure-black disc with no glow around it - over lit content only,
   * and nothing at all over black water. That is round nine's "solid black
   * polygons composited over the scene". Measured on the linear HDR target,
   * seed 3 / 120m, screen (762,452): rgb (-0.026, -0.020, +0.012), and killing
   * *this* batch alone took that pixel from display L2 to L67.
   *
   * The cause was three pulse gains of the form `a + b*sin` with b > a, so each
   * spent 27-32% of its cycle below zero (_kelp nodes, _anchor stalk nodes,
   * _anchor tendril nodes). All three are rectified where they are written, so
   * this floor is unreached today. Measured, not assumed: a probe hooked
   * UPSTREAM of this floor as well as on both sprite batches and both ribbon
   * batches, over 90 frames x 3 seeds, reports nothing negative anywhere - and
   * the same probe against the previous commit reports all six call sites, so
   * it is an instrument that can tell the two apart rather than one that always
   * says clean. The floor stays because it is three compares and it makes the
   * next one a no-op instead of a hole.
   *
   * The reason this was mis-attributed to an occluder is worth keeping: under
   * ?noSprites=1 the polygons vanish (they ARE sprites) and under ?noRibbons=1
   * they get BIGGER, which reads exactly like an occluder the ribbon glow was
   * covering. It is the opposite. Removing the ribbons removes positive light
   * from the neighbourhood, so the sum crosses zero further out and the black
   * region grows. An occluder's silhouette would not have changed size at all,
   * and that is the cheap test if this ever comes back.
   */
  _emit(x, y, w, h, rot, r, g, b, layer, ceil) {
    if (r < 0) r = 0;
    if (g < 0) g = 0;
    if (b < 0) b = 0;
    const pk = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (pk > ceil) {
      const px = (w > h ? w : h) * this._ppu;
      let c = 1;
      if (px > SPEC_PX) {
        let f = Math.sqrt(ceil / pk);
        const lo = SPEC_PX / px;
        if (f < lo) { f = lo; c = ceil / (pk * f * f); }
        w *= f; h *= f;
      }
      if (pk * c > CEIL_HOT) c = CEIL_HOT / pk;
      if (c < 1) { r *= c; g *= c; b *= c; }
    }
    this.glow.push(x, y, w, h, rot, r, g, b, 1, layer);
  }

  /** `puts` form of _emit: a square quad from a colour register and a gain. */
  _emits(x, y, size, col, k, layer, ceil, rot = 0) {
    this._emit(x, y, size, size, rot, col[0] * k, col[1] * k, col[2] * k, layer, ceil);
  }

  /**
   * A light being consumed by the Hush. Saturation goes before value: the
   * violet field swamps a hue long before it swallows the brightness, so an
   * amber bulb inside the field must stop being amber before it stops being
   * bright. Safe in place - each channel reads only itself plus `l`.
   */
  _ate(col, e, out) {
    const l = col[0] * 0.2126 + col[1] * 0.7152 + col[2] * 0.0722;
    const s = 1 - e * 0.88;
    const v = (1 - e) * (1 - e);
    out[0] = lerp(l, col[0], s) * v * 0.90;
    out[1] = lerp(l, col[1], s) * v * 0.92;
    out[2] = (lerp(l, col[2], s) + l * e * 0.40) * v;   // violet outlives the rest
    return out;
  }

  /** @param g the frameCtx from main.js - see Game.frameCtx() */
  draw(g) {
    const gl = this.gl;
    const { world, player, cam, t } = g;
    const b = cam.bounds(460);
    const dim = g.envDim === undefined ? 1 : g.envDim;
    this._hx = world.hushX === undefined ? -1e9 : world.hushX;
    // cam.viewH world units span the full pixel height, and the zoom runs out
    // to 1/1.87 at speed, so a quad's screen size is not a function of its
    // world size alone. Anything authored against the mip chain needs this.
    this._ppu = (g.pixelH || 900) / cam.viewH;

    // --- round 1: the far parallax layer, desaturated and low contrast ---
    this._decor(world, b, t, dim, true);
    Blend.premul(gl); this.rDark.flush(cam); this.occl.flush(cam);
    Blend.add(gl); this.rGlow.flush(cam); this.glow.flush(cam);

    // --- round 2: the near layer. Its silhouettes eat round 1's light. ---
    this._decor(world, b, t, dim, false);
    this._hazards(world, b, t);
    this._anchors(world, player, b, t, dim);
    Blend.premul(gl); this.rDark.flush(cam); this.occl.flush(cam);
    Blend.add(gl); this.rGlow.flush(cam); this.glow.flush(cam);

    // --- round 3: pure light, nothing in here occludes anything ---
    this._plankton(world, b, t, dim);
    this._hushEdge(world, cam, t);
    this._trail(player, t);
    this._tether(player, t);
    this._mote(g);
    g.particles.draw(this.glow);
    g.ambient.draw(this.glow, cam, t);
    Blend.add(gl);
    this.rGlow.flush(cam);
    this.glow.flush(cam);
    Blend.none(gl);
  }

  // ------------------------------------------------------------------ decor ---
  _decor(world, b, t, dim, far) {
    const list = world.decor;
    this._ai = 0;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (d.x < b.x0 - 520) continue;
      if (d.x > b.x1 + 520) break;
      if ((d.depth >= FAR) !== far) continue;
      if (d.kind === KIND.KELP) this._kelp(d, t, dim, world);
      else if (d.kind === KIND.SPIRE) this._spire(d, t, dim, world);
      else if (d.kind === KIND.ANEMONE) this._anemone(d, t, dim, world);
    }
  }

  /**
   * Lean bias that pushes a strand away from a nearby anchor stalk. Two strong
   * near-parallel verticals a few units apart fight for the eye instead of one
   * leading it, and a blind review named the case exactly: "an anchor stalk
   * parallel to a tall reed behind it". Diverging beats parallel, and the cost
   * is one comparison per neighbour: both lists are sorted by ascending x
   * (invariant 5), so this is a monotonic cursor rather than a scan. _decor
   * resets the cursor because it runs twice a frame, far then near.
   */
  _leanBias(world, x) {
    const list = world.anchors;
    if (!list.length) return 0;
    let i = this._ai;
    if (i >= list.length) i = list.length - 1;
    while (i > 0 && list[i].x > x) i--;
    while (i < list.length - 1 && list[i + 1].x <= x) i++;
    this._ai = i;
    let bias = 0;
    for (let k = i > 0 ? i - 1 : 0, hi = Math.min(list.length - 1, i + 2); k <= hi; k++) {
      const dxa = x - list[k].x, ad = dxa < 0 ? -dxa : dxa;
      if (ad > 190) continue;
      const w = 1 - ad / 190;
      bias += (dxa >= 0 ? 1 : -1) * w * w * 0.30;
    }
    return clamp(bias, -0.34, 0.34);
  }

  _kelp(d, t, dim, world) {
    const n = 12, pts = this._p1(n);
    const sid = (d.x * 3.11) | 0;
    const e = this._eat(d.x);
    const dm = dim * (1 - e);
    const lean = d.lean + this._leanBias(world, d.x);
    // Depth absorption, and it has to reach *detail* as well as colour. Far
    // water eats contrast and hue, but the thing that actually flattened the
    // parallax stack here was grain running at one frequency through every
    // plane: near and far read at the same crispness, so they read at the same
    // distance. `fine` scales the high octave of every profile in this shape,
    // so a far strand is bluer, flatter AND smoother than a near one.
    const dfar = smoothstep(clamp01(d.depth * 1.20));
    const fine = 1 - dfar * 0.82;
    // Travelling wave down the stalk: the tip lags the base, which is what makes
    // a plant look pushed by water rather than rotated about its root.
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      const wave = Math.sin(t * d.sway + d.phase - f * 1.75) * 0.74
                 + Math.sin(t * d.sway * 1.9 + d.phase * 1.7 - f * 3.1) * 0.26;
      pts[s * 2] = d.x + f * f * lean * 205 + wave * 168 * f * f;
      pts[s * 2 + 1] = d.y - d.h * f;
    }

    // Fibre. A stalk of constant width is a wire however well it sways, so the
    // profile carries two octaves of thickness noise and the stroke is a
    // *bundle* - one thick strand plus a thin one that separates near the tip.
    // Two octaves only: the stalk is a 12-point polyline, so width detail above
    // about six cycles has nowhere to be sampled and aliases into a wobble.
    const fib = (f) => 0.74 + 0.36 * noise1(f * 4.1 + sid * 0.021)
      + 0.20 * fine * noise1(f * 11.3 + sid * 0.037);
    depthFade(PAL.voidDeep, d.depth * 0.82, c0);
    const opa = (1 - d.depth * 0.48) * (1 - e * 0.55);
    // A lit stalk that begins exactly on the band profile draws a flat
    // horizontal cut across the frame - every strand in a stand ending on one
    // line, which review called a visible baseline. The cut is the ribbon's own
    // butt cap at f=0, lit from behind by the glow passes. So the dark body is
    // continued *below* world.bandBot as a flared root, and every light pass is
    // gated by this: the plant stops being lit before it reaches the rock.
    const emerge = (f) => clamp01(f * 9);
    // Fleshy at the root, whip-thin at the tip. The old profile ran 3.05 -> 0.44
    // over pow(f, 0.82), which at these widths is a 12px line going to a 2px
    // line - measurably a taper, visibly a wire.
    const wmain = (f) => lerp(d.w * 4.10, d.w * 0.38, Math.pow(f, 0.92)) * fib(f);
    this.rDark.stroke(pts, {
      width: (f) => wFloor(wmain(f)), color: c0,
      alpha: (f) => aFloor(wmain(f), lerp(0.97, 0.16, Math.pow(f, 1.3)) * opa), falloff: 1.15,
    });
    // Root, buried. Its own butt cap is below the floor where nothing can see
    // it, and it is wider than the stalk, so the joint is a flare rather than a
    // seam. The stalk's second sample is the top, so the two overlap.
    const bur = Math.min(52, d.w * 3.6);
    const rt = this._p2(3);
    for (let s = 0; s < 3; s++) {
      const f = s / 2;
      rt[s * 2] = lerp(d.x + (hash2(sid, 5) - 0.5) * d.w * 0.7, pts[2], f);
      rt[s * 2 + 1] = lerp(d.y + bur, pts[3], f);
    }
    const wroot = (f) => lerp(d.w * 5.6, d.w * 4.1, f)
      * (0.86 + 0.30 * noise1(f * 3.1 + sid * 0.05));
    // ...and "below the floor where nothing can see it" was wishful: the scene
    // has no depth buffer, so a cap under the band profile is still painted over
    // the rock. Same fade as the spire root, over the same band, for the same
    // reason - the holdfast lobes below carry the mass, so what is lost here is
    // only the ruled edge. bur below the floor against d.h/11 above it.
    const fbk = bur / (bur + d.h * 0.091 + 1);
    this.rDark.stroke(rt, {
      width: (f) => wFloor(wroot(f)), color: c0,
      alpha: (f) => aFloor(wroot(f), 0.97 * opa * smoothstep(clamp01(f / fbk))),
      falloff: 1.05,
    });

    const side = hash2(sid, 91) > 0.5 ? 1 : -1;
    const str = this._p3(n);
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      str[s * 2] = pts[s * 2] + side * wmain(f) * (0.22 + 0.55 * f * f);
      str[s * 2 + 1] = pts[s * 2 + 1] + d.w * 0.5 * f;
    }
    const wstr = (f) => lerp(d.w * 1.15, d.w * 0.20, Math.pow(f, 0.7)) * fib(f * 1.7 + 0.3);
    this.rDark.stroke(str, {
      width: (f) => wFloor(wstr(f)), color: c0,
      alpha: (f) => aFloor(wstr(f), lerp(0.86, 0.10, Math.pow(f, 1.1)) * opa), falloff: 1.2,
    });

    // Edge light colour is needed by the blades as well as by the stalk, so it
    // is resolved before either draws.
    depthFade(PAL.waterHigh, d.depth * 0.94 + 0.08, c1);
    if (e > 0) this._ate(c1, e, c1);

    // Holdfast. Kelp grips rock; it does not sprout from a point - and it grips
    // the rock that is actually there. world.bandBot is sampled per lobe rather
    // than shared, so a stand on a sloping floor plants each lobe at its own
    // height instead of hanging them all off one strand's baseline. Three lobes
    // of unequal size: a clean joint is the tell that both were drawn.
    for (let k = 0; k < 3; k++) {
      const hk = hash2(sid, k * 7 + 61);
      const hw = d.w * (1.3 + hk * 2.0);
      const lx = d.x + (hk - 0.5 + (k - 1) * 0.52) * d.w * 3.6;
      const ly = world.bandBot(lx);
      this.occl.push(lx, ly - hw * 0.18, hw * 2.7, hw * 1.22,
        (hk - 0.5) * 0.55, c0[0], c0[1], c0[2], 0.84 * opa, L_ROCK);
      // One graze along the lobe's upper face. Without it the holdfast is a
      // dark blob on dark rock and the plant still looks placed rather than
      // gripping - the joint has to be *lit* to be read at all.
      const gk = 0.30 * dm * (1 - d.depth * 0.72);
      this._emit(lx, ly - hw * 0.62, hw * 2.2, hw * 0.52, (hk - 0.5) * 0.34,
        c1[0] * gk, c1[1] * gk, c1[2] * gk, S.GLOW, CEIL_DECOR);
    }

    // Blades. A bare curve is a wire; blades make it a plant. Fewer of them at
    // distance: detail density is a depth cue as much as value is.
    //
    // This loop is the "barbed wire or frost, not plant" a blind review found
    // across the lower third of every frame, and the stalks it blamed are
    // innocent - a strand's bow over its chord is a median 9.3% through the
    // real camera, a 32px sagitta on a 280px chord. ?noSprites=1 settles it:
    // the same crop with the ribbons alone is a stand of curved reeds, and the
    // barbs come back with the sprites. Three properties did it, each a trap
    // this file already has a name for:
    //
    //   1. ONE straight quad per blade. A stretched quad's medial axis IS a
    //      segment (trap 2), so a dozen of them per strand is a dozen ruled
    //      lines whatever profile is painted in them - and SHARD's profile is a
    //      straight taper to a point, which is a thorn.
    //   2. sd = (k & 1), a locked parity. That is a comb, not a plant.
    //   3. a FIXED 0.52 rad off the tangent with NO per-instance term. The only
    //      variation was a temporal sine shared by every blade on the strand,
    //      so in a still frame every blade on every strand left at one angle.
    //
    // Each is fixed at its cause. A blade is two overlapping shards with a curl
    // between them, so no straight line passes through a whole blade; the side
    // is hashed with a bias toward alternation instead of locked to it; and the
    // leaving angle carries +-0.42 rad per blade on top of a base that opens
    // from 0.40 at the holdfast to 0.98 near the tip, because a blade low on
    // the strand stands out of the current and one at the tip is dragged along
    // it. Count is down 7 -> 5 (5 -> 4 far) so the piece cost is +43% rather
    // than +100%, and fewer larger fronds is the right direction anyway: the
    // review's complaint was density as well as shape.
    //
    // WHAT IS STILL WRONG, and it is not fixable in this file. In a dense bed
    // this now reads as a tangle rather than a comb, but a lone strand against
    // black water still reads spiky, because SHARD is a straight taper to a
    // POINT and a point is a thorn however it is oriented. A kelp blade wants a
    // broad strap: soft-edged, near-constant width over most of its length,
    // rounded rather than sharpened at the tip. Nothing in the kit is that.
    // FILAMENT is the only layer whose medial axis is not a segment (its spine
    // is 0.17*sin(5.4t) + 0.055*sin(11t) of the half-height) and it cannot be
    // used here: its half-width is 0.013 of the quad, so a blade of thickness T
    // needs a quad 77T tall and the curve then wanders +-6.5T - the quad, and
    // its overdraw, would be an order of magnitude bigger than the blade.
    // L_LEAF already resolves through LY('LEAF', S.SHARD), so the moment
    // textures.js grows a LEAF layer this picks it up with no change here.
    // That is the request to make of the textures owner; it is not ours.
    const nb = d.depth >= FAR ? 4 : 5;
    for (let k = 0; k < nb; k++) {
      const f = 0.11 + 0.82 * ((k + hash2(sid, k * 5 + 1) * 0.78) / nb);
      const si = Math.min(n - 2, (f * (n - 1)) | 0), lf = f * (n - 1) - si;
      const px = lerp(pts[si * 2], pts[si * 2 + 2], lf);
      const py = lerp(pts[si * 2 + 1], pts[si * 2 + 3], lf);
      let tx = pts[si * 2 + 2] - pts[si * 2], ty = pts[si * 2 + 3] - pts[si * 2 + 1];
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      // Alternation is the natural bias - blades really do leave a stipe in
      // rough opposition - but a locked parity draws a comb. A quarter of them
      // break it, which buys clumps and gaps without losing the two-sided read.
      // The three new hash indices are 23k+101, 29k+137, 31k+167 - deliberately
      // out of range of every index already used here (1..53 plus 61) so no
      // blade's side, angle or curl is the same draw as another blade's length
      // or lit gain. k*17+11 collided with k*5+1 at k=0/k=2 on the first cut.
      const sd = ((k & 1) ? 1 : -1) * (hash2(sid, k * 23 + 101) > 0.74 ? -1 : 1);
      const bl = d.w * (5.9 + Math.pow(hash2(sid, k * 7 + 3), 1.5) * 6.9) * (1 - f * 0.40);
      // SHARD's visible ribbon is 13% of the quad it is painted in, so a quad
      // two units tall renders a quarter-unit thread - which is exactly why
      // these blades read as twigs. Height now comes from the blade's own
      // length, so a blade is a ribbon whose taper you can see.
      const bw = bl * (0.58 + hash2(sid, k * 11 + 5) * 0.54);
      const open = lerp(0.40, 0.90, f) + (hash2(sid, k * 29 + 137) - 0.5) * 0.84;
      const a0 = Math.atan2(ty, tx)
        + sd * (open + 0.26 * Math.sin(t * d.sway * 1.3 + k * 2.1 + d.phase));
      // The curl carries the side's sign, so a frond bends further away from
      // the stalk rather than kinking back across it, and it has its own slower
      // clock - a blade that flexes on the same beat as it swings is one rigid
      // object rotating. 0.30-0.80 rad and not more: at 0.44-1.10 the pair
      // closed far enough to read as a hoop, and a ring is its own amateur tell.
      const a1 = a0 + sd * (0.30 + hash2(sid, k * 31 + 167) * 0.50)
        + 0.13 * Math.sin(t * d.sway * 0.85 + k * 1.7 + d.phase * 1.3);
      const cA = Math.cos(a0), sA = Math.sin(a0), cB = Math.cos(a1), sB = Math.sin(a1);
      // Both ends of a SHARD reach zero width (env = t^0.55 * (1-t)^1.9), so
      // two of them overlapped at 0.86 of the first's length join without a
      // waist and without a step. Lengths are set so the tip still lands at
      // 0.93 of bl: the envelope is unchanged, only its medial axis bends.
      //
      // The widths are NOT bw. SHARD's profile is normalised to its quad, so
      // halving the quad's length while keeping its height doubles how fat the
      // painted taper looks - the first cut of this kept bw and turned every
      // blade into a tube. 0.74/0.50 of bw over pieces 0.56/0.50 of bl puts the
      // painted thickness back where it was and gives the pair a real taper
      // from base to tip, which one quad could not have.
      const LA = bl * 0.56, LB = bl * 0.50;
      const jx = px + cA * LA * 0.86, jy = py + sA * LA * 0.86;
      this.occl.push(px + cA * LA * 0.42, py + sA * LA * 0.42,
        LA, bw * 0.90, a0, c0[0], c0[1], c0[2], 0.88 * opa, L_LEAF);
      this.occl.push(jx + cB * LB * 0.40, jy + sB * LB * 0.40,
        LB, bw * 0.62, a1, c0[0], c0[1], c0[2], 0.88 * opa, L_LEAF);
      // A dark ribbon on dark water is a hole, so each blade gets a lit face
      // offset off its own medial axis. SHARD again, not FILAMENT: FILAMENT's
      // hair is 2.7% of the quad it is painted in, which at a blade's scale is a
      // fifth of a pixel and mips away to nothing. The same profile at 60% of
      // the height reads as the lit side of the same ribbon. One per piece, or
      // the bend is a dark notch in a lit blade.
      const bk = 1.30 * (0.40 + 0.90 * hash2(sid, k * 11 + 9)) * dm * (1 - d.depth * 0.74);
      const nAx = -sA * bw * 0.13, nAy = cA * bw * 0.13;
      const nBx = -sB * bw * 0.09, nBy = cB * bw * 0.09;
      this._emit(px + cA * LA * 0.44 - nAx, py + sA * LA * 0.44 - nAy,
        LA * 0.86, bw * 0.54, a0, c1[0] * bk, c1[1] * bk, c1[2] * bk, L_LEAF, CEIL_DECOR);
      this._emit(jx + cB * LB * 0.42 - nBx, jy + sB * LB * 0.42 - nBy,
        LB * 0.86, bw * 0.38, a1, c1[0] * bk, c1[1] * bk, c1[2] * bk, L_LEAF, CEIL_DECOR);
    }

    // Edge light. The single thing that lets a dark plant read against dark
    // water - so it inherits the same fibre noise, or it re-flattens the stalk.
    const off = this._p2(n);
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      off[s * 2] = pts[s * 2] - wmain(f) * 0.44;
      off[s * 2 + 1] = pts[s * 2 + 1];
    }
    // Translucent flesh. Without this only the rim line was ever visible, so a
    // 50px stalk read as a 4px wire however carefully its width was authored:
    // the dark body it is drawn around is a premultiplied *occluder*, and an
    // occluder over black water is nothing. The alpha looks large only because
    // depth-faded waterHigh is a luminance of about 0.03 - this lands near 0.025
    // linear, three times the water bulk and well under the bloom's knee foot,
    // so it costs a visible volume and no halation.
    this.rGlow.stroke(pts, {
      width: (f) => wFloor(wmain(f) * 0.92), color: c1,
      alpha: (f) => aFloor(wmain(f) * 0.92,
        0.60 * emerge(f) * (1 - f * 0.34) * (0.6 + 0.5 * fib(f)) * dm * (1 - d.depth * 0.66)),
      falloff: 1.15,
    });
    this.rGlow.stroke(off, {
      width: (f) => lerp(wCore(d.w * 0.75, 3), wCore(0, 3), f), color: c1,
      alpha: (f) => 0.66 * emerge(f) * (1 - f * 0.5) * (0.55 + 0.55 * fib(f)) * dm
        * (1 - d.depth * 0.34),
      falloff: 3,
    });

    if (d.glow > 0 && e < 0.98) {
      depthFade(PAL.plankton, d.depth * 0.85, c2);
      if (e > 0) this._ate(c2, e, c2);
      const pc = e > 0 ? this._ate(PAL.planktonCore, e, o0) : PAL.planktonCore;
      const lit = d.glow * (1 - d.depth * 0.7) * dm;
      // Nodes up the stalk, not just a lamp on the tip.
      for (let k = 0; k < 3; k++) {
        const hk = hash2(sid, k + 31);
        const f = 0.40 + 0.56 * (k / 3) + hk * 0.13;
        const si = Math.min(n - 2, (f * (n - 1)) | 0), lf = f * (n - 1) - si;
        const px = lerp(pts[si * 2], pts[si * 2 + 2], lf);
        const py = lerp(pts[si * 2 + 1], pts[si * 2 + 3], lf);
        // Rectified. b > a here, so the raw pulse is below zero for 27% of its
        // cycle, and a negative gain on an additive quad is light SUBTRACTION -
        // see the floor in _emit and the frame it was found in. Clamping rather
        // than rescaling is deliberate: the positive lobe is left exactly as it
        // was authored, so every frame that was already correct is unchanged to
        // the bit and the diff is only the holes. The node rests dark and
        // swells, which is the read this pulse was reaching for anyway.
        const pk = Math.max(0, 0.40 + 0.60 * Math.sin(t * (1.3 + hk * 1.1) + k * 2.3 + d.phase * 2.1));
        const kk = lit * pk;
        this._emits(px, py, d.w * 6.2, c2, kk * 0.24, S.GLOW, CEIL_DECOR);
        // The lamp. GLOW rather than CORE for the minification reason at
        // CORE_PX - d.w runs 3.4-15 world units, so a CORE quad here is 2.6-21px
        // and delivers a flat pale square, and that artefact was real and is not
        // coming back. But the answer to it is the PROFILE, not the gain: this
        // is the same lamp small and hot again rather than wide and dim, held to
        // CORE_PX on screen so what goes hot is a bulb and not a patch of fog.
        // The gain is set against the REWARD rather than against the lamp: pc is
        // planktonCore, so this is a near-white dot on scenery and the one thing
        // it must not do is match the collectible. Plankton's own core lands at
        // display 0.73-0.81; a node at 1.45 lands at 0.54, which is a lit thing
        // in the middle distance rather than something to swim at.
        this._emits(px, py, Math.min(d.w * 2.2, CORE_PX * 1.35 / this._ppu),
          pc, kk * 1.45, S.GLOW, CEIL_PROP);
      }
      const tx = pts[(n - 1) * 2], ty = pts[(n - 1) * 2 + 1];
      const tp = 0.58 + 0.42 * Math.sin(t * 1.7 + d.phase * 2.1);
      this._emits(tx, ty, d.w * 11.5, c2, lit * tp * 0.28, S.GLOW, CEIL_DECOR);
      this._emits(tx, ty, d.w * 3.4, c2, lit * tp * 0.58, S.GLOW, CEIL_DECOR);
      this._emits(tx, ty, Math.min(d.w * 2.6, CORE_PX * 1.6 / this._ppu),
        pc, lit * tp * 1.90, S.GLOW, CEIL_PROP);
    }
  }

  _spire(d, t, dim, world) {
    const dir = d.up ? -1 : 1;
    const sid = (d.x * 5.77) | 0;
    const subs = hash2(sid, 3) > 0.55 ? 3 : 2;
    const e = this._eat(d.x);
    const dm = dim * (1 - e);
    const dfar = smoothstep(clamp01(d.depth * 1.20));
    const fine = 1 - dfar * 0.80;
    const lean0 = d.lean + this._leanBias(world, d.x) * 0.7;
    depthFade(PAL.voidDeep, d.depth * 0.52, c0);
    depthFade(PAL.surface, d.depth * 1.00 + 0.10, c1);
    if (e > 0) this._ate(c1, e, c1);
    // Far rock loses its silhouette as well as its colour: at depth 0.8 this is
    // half-transparent, which is what lets a near ridge read *in front of* it
    // instead of beside it. The old 0.16 coefficient held a far plane at 87%
    // opacity, so far and near measured at the same contrast.
    const opa = (1 - d.depth * 0.52) * (1 - e * 0.5);

    for (let q = 0; q < subs; q++) {
      const first = q === 0;
      const sx = d.x + (hash2(sid, q * 9 + 1) - 0.5) * d.w * 1.6;
      // The floor under *this* column, not under the item's nominal x. Every
      // sub-column used to start at d.y, so a ridge on a sloping floor grew
      // three columns off one horizontal line with the rock visibly cut away
      // beneath two of them. world.bandBot is cheap and pure; this is the fix
      // for the review's "terminate on a flat horizontal baseline".
      const sy = d.up ? world.bandBot(sx) : world.bandTop(sx);
      const hq = d.h * (first ? 1 : 0.40 + hash2(sid, q * 9 + 2) * 0.44);
      const wq = d.w * (first ? 1 : 0.30 + hash2(sid, q * 9 + 3) * 0.36);
      const lean = lean0 + (hash2(sid, q * 9 + 4) - 0.5) * 0.24;
      const jseed = sid * 0.37 + q * 31.7;
      // Not every column tapers to a needle. A blunt break is what makes a
      // ridge read as rock that has been *broken* rather than extruded - but a
      // ribbon's last segment is a butt cap, so a column still near full width
      // when it reaches that cap renders a machined rectangle: flat top,
      // parallel sides, hanging in open water. That is the same debug primitive
      // this project has now removed three times, and it was measured at
      // seed 7 / 1000m before this. A fracture is angled and it spalls, so the
      // top two samples shear off the axis, the width collapses across them,
      // and the face itself is capped with rock.
      const blunt = hash2(sid, q * 9 + 7) > 0.60;
      const tipw = blunt ? 0.22 + hash2(sid, q * 9 + 8) * 0.16 : 0.045;
      const shear = (hash2(sid, q * 9 + 11) - 0.5) * 2;
      const brk = blunt ? 0.84 : 1.01;
      const n = 13, pts = this._p1(n);
      for (let s = 0; s < n; s++) {
        const f = s / (n - 1);
        const gb = f > brk ? (f - brk) / (1 - brk) : 0;
        // Lateral wander, zero at the root. Without it both flanks are exact
        // offsets of one parabola, which is what makes a stroked column read as
        // an extrusion however much the width varies.
        pts[s * 2] = sx + f * f * lean * 175
          + (noise1(f * 1.9 + jseed * 0.7) - 0.5) * wq * 0.52 * Math.pow(f, 0.7)
          + shear * gb * gb * wq * 0.58;
        // Buried root: the first sample is a butt cap, so it is put under the
        // band profile and the rim light below is gated to zero before it gets
        // there. A column that starts *at* the floor draws its own flat edge.
        pts[s * 2 + 1] = sy + dir * (hq * f - wq * 0.34 * Math.pow(1 - f, 3));
      }
      const emerge = (f) => clamp01(f * 7);
      // The buried band, and the same defect as the anemone column one tier up.
      // A column's first sample is a butt cap, and putting it under the band
      // profile does not hide it - there is no depth buffer, so the scene paints
      // this over the lit rock the background shader already drew. The cap was a
      // ruled horizontal edge as wide as the column, sitting on the floor. Only
      // q === 0 had a skirt over it, so every SUB-column ended in a visible box,
      // which is the "hard-edged dark quads at reed bases" finding: proved in
      // this frame by zeroing this alpha, which removed two of them. Fade the
      // body in across the band that is under the rock and the column ends by
      // dissolving into the floor rather than stopping at a line. fb is where
      // the axis actually crosses the profile, so the ramp is spent entirely
      // below it and the column is at full strength the moment it emerges.
      const fb = clamp(wq * 0.34 / Math.max(1, hq), 0.02, 0.45);
      const root = (f) => smoothstep(clamp01(f / fb));
      // Ridged width, two octaves: rock has facets and steps, and one smooth
      // low-frequency wobble on a cone still measures as a constant-width
      // stroke. The fine octave is what puts a burr on the silhouette.
      const wfn = (f) => lerp(wq, wq * tipw, Math.pow(f, blunt ? 0.74 : 0.60))
        * (0.78 + 0.34 * noise1(f * 6.5 + jseed) + 0.15 * fine * noise1(f * 21.3 + jseed * 1.7))
        * (f > brk ? lerp(1, 0.18, (f - brk) / (1 - brk)) : 1);
      // Alpha now falls with the width instead of holding at 0.985 all the way
      // into the fracture. A collapsing width at constant opacity is what made
      // the tip a hairline, and a hairline is what made frame 1 differ.
      this.rDark.stroke(pts, {
        width: (f) => wFloor(wfn(f)), color: c0,
        alpha: (f) => aFloor(wfn(f), 0.985 * opa * root(f)), falloff: 0.95,
      });

      if (blunt) {
        // The fracture face, then two spalls hanging off it. A break needs a
        // surface and some debris or it reads as an end rather than as damage.
        // SMOKE's mask dies inside its own tile in every direction, so these
        // cannot themselves become the rectangle they exist to hide.
        //
        // NEGATIVE RESULT, measured, so nobody spends the round again. These
        // three always land on top of each other and premultiplied occluders
        // multiply, so on paper the trio is 45x more opaque than the column it
        // caps (0.985*opa for the body against 1 - 0.36*0.50*0.50 = 0.91 for
        // the trio) and looked like the cause of the remaining black patches.
        // Dropping them to 0.62/0.34 - a third of the occlusion - moved 15844
        // pixels by 2 levels and 242 by 8, and moved the hole count by NINE:
        // seed 7 / 120m 483 -> 474, seed 3 121 -> 62 -> 62, seed 11 283 -> 279.
        // The arithmetic overstates the stack because alpha is m*a and the
        // masks are nowhere near 1 where they overlap; measured on the linear
        // target the whole occluder pass attenuates that pixel 5x, not 1400x.
        // So the patches are not this, the caps keep the opacity that hides the
        // ribbon's butt cap, and the remaining holes are the blade sprites
        // (layer L_LEAF) - see _kelp.
        const tx2 = pts[(n - 1) * 2], ty2 = pts[(n - 1) * 2 + 1];
        const tw = wq * tipw * 1.55;
        this.occl.push(tx2, ty2 - dir * tw * 0.16, tw * 2.05, tw * 0.94,
          (hash2(sid, q * 9 + 12) - 0.5) * 1.2, c0[0], c0[1], c0[2], 0.92 * opa, L_ROCK);
        for (let k = 0; k < 2; k++) {
          const hk = hash2(sid, q * 9 + 13 + k * 3);
          const cw = tw * (0.26 + hk * 0.36);
          this.occl.push(tx2 + (hk - 0.5) * tw * 1.7, ty2 - dir * tw * (0.10 + hk * 0.62),
            cw * 2.2, cw * 1.25, (hk - 0.5) * 1.5, c0[0], c0[1], c0[2], 0.76 * opa, L_ROCK);
        }
      }

      // Rim light on the lit edge. Stalactites catch it high, stalagmites low.
      const off = this._p2(n);
      for (let s = 0; s < n; s++) {
        const f = s / (n - 1);
        off[s * 2] = pts[s * 2] - wfn(f) * 0.44;
        off[s * 2 + 1] = pts[s * 2 + 1];
      }
      const grad = d.up ? (f) => 0.50 + 0.60 * f : (f) => 1.05 - 0.45 * f;
      const glint = (f) => 0.55 + 0.75 * noise1(f * 9.5 + jseed * 2.3);
      // Two octaves of thickness on the rim as well as on the silhouette. A rim
      // of constant width is the tell that a stroked column was extruded rather
      // than broken, and detail was the weakest measured axis in review.
      this.rGlow.stroke(off, {
        width: (f) => lerp(wCore(wq * 0.10, 4), wCore(0, 4), f)
          * (0.74 + 0.40 * noise1(f * 7.7 + jseed * 1.3) + 0.16 * fine * noise1(f * 19.1 + jseed)),
        color: c1,
        alpha: (f) => 0.26 * emerge(f) * grad(f) * glint(f) * (1 - d.depth * 0.72) * dm,
        falloff: 4,
      });
      // Flutes: two grazes down the face. Rock without them is a flat plate,
      // and the frame's weakest measured axis was material.
      for (let fq = 0; fq < 3; fq++) {
        // Unequal, seeded spacing. Two flutes at fixed offsets read as a pair of
        // drawn lines; three at uneven ones read as a fluted face.
        const lat = 0.12 + fq * 0.24 + (noise1(jseed * 0.9 + fq * 3.7) - 0.5) * 0.16;
        const fl = this._p3(n);
        for (let s = 0; s < n; s++) {
          const f = s / (n - 1);
          fl[s * 2] = pts[s * 2] - wfn(f) * lat;
          fl[s * 2 + 1] = pts[s * 2 + 1];
        }
        this.rGlow.stroke(fl, {
          width: (f) => lerp(wCore(wq * 0.05, 4.5), wCore(0, 4.5), Math.pow(f, 0.8)), color: c1,
          alpha: (f) => 0.085 * emerge(f) * fine * grad(f) * glint(f * 1.7 + fq * 4.1)
            * (1 - d.depth * 0.74) * dm,
          falloff: 4.5,
        });
      }

      // Skirt: without it the spire floats instead of growing out of the rock.
      // EVERY column gets one, not just the first - a sub-column had neither
      // skirt nor rubble, so its joint was the bare ribbon cap described above.
      // L_ROCK's edge is torn by its own noise field, which is what makes this a
      // flare of broken rock rather than a second drawn shape.
      this.occl.push(sx, sy + dir * wq * 0.12, wq * 2.8, wq * 1.0,
        (hash2(sid, q * 9 + 17) - 0.5) * 0.5, c0[0], c0[1], c0[2], 0.55 * opa, L_ROCK);

      if (first) {
        // Rubble. Three blocks of unequal size, because a clean joint between a
        // column and the floor is the giveaway that both were drawn, not grown -
        // each one sitting on the floor under itself, not under the column.
        for (let k = 0; k < 3; k++) {
          const hk = hash2(sid, k * 13 + 21);
          const rw = wq * (0.30 + hk * 0.62);
          const rx = sx + (hash2(sid, k * 13 + 22) - 0.5) * wq * 2.4;
          const ry = d.up ? world.bandBot(rx) : world.bandTop(rx);
          this.occl.push(rx, ry + dir * rw * (0.10 + hk * 0.30), rw * 1.9, rw * 1.15,
            (hk - 0.5) * 0.8, c0[0], c0[1], c0[2], 0.70 * opa, L_ROCK);
        }
      }
    }
  }

  _anemone(d, t, dim, world) {
    const warm = d.hue === 0;
    const sid = (d.x * 9.13) | 0;
    const dir = d.up ? -1 : 1;
    const e = this._eat(d.x);
    if (e > 0.98) return;
    // Decor must not wear the reward's colour. Plankton is the one mint
    // near-white in the game; a colony of anemones at the same hue and value
    // made the brightest "reward" in frame a thing you cannot collect - and put
    // the hazard *below* it in the value ladder. Same structure and the same
    // craft, one tier down and one step off the hue.
    // ...and the cold variant is pushed further off the reward's hue than it
    // was, because restoring its specular tips made the old separation
    // insufficient. At 0.30 toward surface its tip was 70% PAL.plankton - which
    // is the collectible's exact colour - and once those tips went from an 0.40
    // wash to a 3.4 bead, twenty of them per colony read as food you cannot
    // collect. Teal is decor, mint is reward: the hue does the sorting, so the
    // beads can stay crunchy.
    let base = warm ? PAL.anchorMid : mixCol(PAL.plankton, PAL.surface, 0.66, o0);
    let tip = warm ? PAL.anchorLive : mixCol(PAL.plankton, PAL.surface, 0.44, o1);
    if (e > 0) { base = this._ate(base, e, o2); tip = this._ate(tip, e, o3); }
    const breathe = 0.55 + 0.45 * Math.sin(t * 1.15 + d.phase);
    const k = (0.40 + breathe * 0.62) * (1 - d.depth * 0.75) * dim * (1 - e);

    // The column, and the reason it is no longer a ribbon.
    //
    // A ribbon's cross-section is exp(-x^2*falloff) across its own half-width,
    // so at the falloff that reads as SOLID - near 1 - the value at the ribbon's
    // own edge is still exp(-1) = 0.37 of its peak, and both ends are butt caps.
    // A body stroked along a SHORT medial axis is therefore not a body at all:
    // it is a filled quadrilateral with four hard steps around it. This column
    // was 1.6r wide over a 1.1r axis at falloff 1.0 and alpha 0.90, and a colony
    // is four to nine of them clumped on a slope, so their union was the hard
    // dark trapezoid that sat under every anemone in the frame. Attributed by
    // elimination rather than by argument: ?noSprites=1 left it, ?noRibbons=1
    // removed it, and zeroing this one alpha removed it on its own.
    //
    // That property has now been paid for three times here - it is also why the
    // mote's rim arcs once read as a bracket - so the rule is absolute: a ribbon
    // cannot draw a soft edge at any tuning, because raising the falloff far
    // enough to fade the edge turns the cross-section into a filament. Anything
    // that must fade to nothing is a SPRITE, which reaches zero inside its quad.
    //
    // So the trunk is VOLUME. Its profile is a chord integral - flat through the
    // middle, rolled off by a knee, exactly zero at 0.74 of the quad - which is
    // a solid mass with a rim rather than a gaussian smear, and it is the one
    // profile in the kit that can be an opaque body AND end in nothing. Two of
    // them offset along the axis give a taper no single ellipse has. The foot is
    // L_ROCK, whose silhouette is eroded by its own noise field, so where the
    // animal grips the rock the edge is torn rather than ruled.
    depthFade(PAL.voidDeep, d.depth * 0.4, c0);
    const fy = d.up ? world.bandBot(d.x) : world.bandTop(d.x);
    const hc = hash2(sid, 71), hc2 = hash2(sid, 73);
    const rr = d.r;
    // Proportion carries the form, and it has to, because LIGHT cannot be spent
    // here. A lit flank on this trunk was built and measured three ways - at
    // gain 0.32, at 0.20, and paid for by trimming the wash below - and every
    // one of them moved seed 7 / tethered from rank 7 to rank 8. The colony's
    // block sits within a hair of the hero's, so any light added beside it wins
    // the block and the protagonist loses a place. Scenery does not get to buy
    // form out of the hero's salience: the trunk is narrow, the foot is wide,
    // and that silhouette is free.
    this.occl.push(d.x + (hc - 0.5) * rr * 0.24, fy + dir * rr * 0.02,
      rr * 2.25, rr * 0.60, (hc2 - 0.5) * 0.42, c0[0], c0[1], c0[2], 0.76, L_ROCK);
    this.occl.push(d.x, fy + dir * rr * 0.30, rr * 1.70, rr * 1.50,
      (hc - 0.5) * 0.26, c0[0], c0[1], c0[2], 0.90, S.VOLUME);
    this.occl.push(d.x + rr * 0.09, d.y + dir * rr * 0.34, rr * 1.14, rr * 1.24,
      (hc2 - 0.5) * -0.30, c0[0], c0[1], c0[2], 0.88, S.VOLUME);

    // The arms, and what a blind review saw when it called this colony "one
    // ball-tipped stalk rotated N times at even radius". That description was
    // literally true of the code: ang0 was ((a + 0.5) / arms - 0.5) * PI * 1.10,
    // dead even with no jitter at all, every arm leaving ONE point at
    // d.y + dir*d.r*0.45, every arm carrying the same width function, and - the
    // part that is easiest to miss - every bead the same SIZE, because
    // Math.min(d.r * (0.60 + h * 0.34), CORE_PX * 1.6 / ppu) clamps, and at any
    // zoom where the clamp binds it returns one number for the whole colony.
    // The "one ball" was the ceiling, not the author.
    //
    // Rendered alone and taken apart by an angular spectrum this fan lands on
    // m = arms at 4.7-45x line contrast with those variations deleted, against
    // 2.2-3.4x for the shipped one - so unlike the urchin, here the even
    // partition IS a real part of the signal and jitter is worth spending.
    // Three things change, in the order they matter:
    //   - arms leave the column at DIFFERENT HEIGHTS and off its axis. One
    //     origin is what makes a fan a rotation; several make it a tuft, and
    //     nothing else recovers that.
    //   - the partition is jittered by +-0.46 of a gap, so gaps run 0.08x-1.9x
    //     and the colony gets clumps and voids rather than a comb.
    //   - width, taper exponent, bead size, bead ceiling and bead gain are all
    //     per-arm. Arms that start higher are shortened so the outer envelope
    //     does not grow.
    // Energy is slightly DOWN, not up: the mean bead ceiling falls from
    // CORE_PX*1.60 to CORE_PX*1.37. That direction is deliberate - the file
    // already records three attempts to give this colony more form that each
    // cost the hero a rank place, because its block sits within a hair of the
    // hero's, and every one of them spent LIGHT. This spends shape.
    const arms = 11;
    const base0 = Math.atan2(dir, 0);
    for (let a = 0; a < arms; a++) {
      const h = hash2(sid, a * 3 + 1);
      const hj = hash2(sid, a * 5 + 17);      // angular jitter
      const ho = hash2(sid, a * 5 + 19);      // where up the column it sprouts
      const hl = hash2(sid, a * 5 + 31);      // ...and how far off its axis
      const hw = hash2(sid, a * 7 + 23);      // shaft weight and extra curl
      const hb = hash2(sid, a * 7 + 29);      // bead size / ceiling / gain
      const u = (a + 0.5) / arms + (hj - 0.5) * 1.22 / arms;
      const ang0 = base0 + (u - 0.5) * Math.PI * 1.10;
      const L = d.r * (1.5 + h * 1.6) * (1 - ho * 0.10)
        * (0.86 + 0.24 * Math.sin(t * 1.4 + a * 1.9 + d.phase));
      const curl = (h - 0.5) * 1.5 + (hw - 0.5) * 0.86
        + Math.sin(t * 0.9 + a * 1.3 + d.phase) * 0.32;
      const ca = Math.cos(ang0), sa = Math.sin(ang0);
      const bx = d.x + (hl - 0.5) * d.r * 0.56 + ca * d.r * 0.20;
      const by = d.y + dir * d.r * (0.18 + ho * 0.64);
      // Four points, as before. The curl is a parabola and a 4-point sampling
      // of it is under 1% of the arm's length off the true curve - well under a
      // pixel here - so a fifth point was pure vertex cost.
      const n = 4, pts = this._p2(n);
      for (let s = 0; s < n; s++) {
        const f = s / (n - 1);
        pts[s * 2] = bx + ca * L * f - sa * curl * L * f * f * 0.5;
        pts[s * 2 + 1] = by + sa * L * f + ca * curl * L * f * f * 0.5;
      }
      // The filament. Alpha back to where it was before the cap pass - 0.30 was
      // a salience trim and it took the arms out along with the tips - and a
      // sharper taper, so a strand thins into its bead instead of arriving at
      // one width. Weight and taper are per-arm and their hash term averages to
      // 1.0, so the spread costs nothing; the 0.38 -> 0.45 coefficient is
      // separate, and it is the root ramp's repayment - see below.
      //
      // The emerge ramp is not cosmetic - it is trap 1 arriving the moment the
      // arms stop sharing one origin. Eleven ribbon start caps at one point are
      // one blob under the core wash; scattered up the column each cap is a
      // 32px hard-edged quadrilateral, and at 2x their union drew visible
      // facets across the trunk. A ribbon cannot fade its own cap at any
      // falloff, so the root of each arm is faded to nothing instead and the
      // trunk wash carries the joint.
      //
      // The ramp is short, and its length is a MEASURED constraint rather than
      // a taste one. An arm's width function is widest at f=0, so the inner
      // fifth of a strand is about 44% of its lit area; fading it out over
      // f*5.0 took roughly a fifth of the whole colony's light and failed the
      // gate outright - seed 7 launch p99 0.2545 -> 0.2416 and hushNear
      // 0.2526 -> 0.2489, both under the 0.25 "there must be real highlights"
      // floor, exactly as the note on the trunk wash below predicts. The ramp
      // is now f*6.5 (the first 15%, ~9px in game) and the alpha and length it
      // costs are paid back over the rest of the arm, so the colony's total is
      // where it started and the cap is still gone.
      const ww = 0.62 + hw * 0.80;
      this.rGlow.stroke(pts, {
        width: (f) => lerp(wCore(d.r * 0.16 * ww, 3.5), wCore(0, 3.5), Math.pow(f, 0.42 + hw * 0.30)),
        color: base,
        alpha: (f) => k * 0.475 * (0.78 + 0.46 * hw) * (1 - f * 0.32) * clamp01(f * 6.5),
        falloff: 3.5,
      });
      const ex = pts[(n - 1) * 2], ey = pts[(n - 1) * 2 + 1];
      // BEADED FILAMENTS, which is what this animal is and what it stopped
      // being. The measurement the previous pass made here was real - check.mjs
      // ranks the mote's 66x64px block against all 336 by highlight energy, the
      // sum of L^2, and on seed 7 / launch the three blocks above the hero were
      // this colony at 11.7, 13.3 and 16.7 against the mote's 8.5 - and its sign
      // was right. Its axis was wrong. It cut the lit tips from eleven to six and
      // then spent the saving on a 40px wash per arm at a fifth of the peak,
      // which is a worse shape for L^2 than what it replaced and is also how the
      // object became "a gas cloud".
      //
      // Energy is peak x area. A bead held to CORE_PX is 10px of quad with a 3px
      // nucleus in it: at three times the peak it is a fifth of the block cost of
      // the wash it replaces, and it is the only part of this animal a reviewer
      // can point at. So all eleven arms get one back, and the per-arm wash goes.
      //
      // The CEILING is per-arm, which is the specific fix for "one ball". A
      // shared CORE_PX*1.6 clamp is a constant in world units once ppu is
      // fixed, so every bead whose authored size exceeded it came out at
      // exactly the same size - and at the isolation rig's zoom that was all
      // eleven of them. 1.14-2.00 keeps every bead between about 11 and 20
      // screen pixels, which is still inside the band where a GLOW quad has a
      // real 2-3px nucleus in it, and its MEAN is the old constant - the point
      // is the spread, not a trim. Trimming it was tried and cost p99.
      const bw = Math.min(d.r * (0.44 + h * 0.56), CORE_PX * (1.14 + 0.86 * hb) / this._ppu);
      this._emits(ex, ey, bw, tip, k * (1.78 + hb * 1.56), S.GLOW, CEIL_PROP);
      // ...and a second bead partway down the longer filaments, because one
      // terminal dot per arm is a starburst and two are an organism. Its hash is
      // independent of the tip bead's, and it sits at 1/3 or 2/3 of the arm
      // rather than always at the same node - a bud at a fixed fraction of every
      // arm is the rotation signature again, one radius in.
      if (hb > 0.38) {
        const si = h > 0.55 ? 1 : 2;
        this._emits(pts[si * 2], pts[si * 2 + 1], bw * (0.46 + h * 0.32), tip,
          k * (0.70 + h * 0.74), S.GLOW, CEIL_PROP);
      }
    }
    // The column's own light, and the wash is now narrow enough to be a mouth
    // rather than the weather. d.r*5.4 at 0.150 was 130 world units of even
    // mid-tone over the whole colony - the single most expensive shape a block
    // of L^2 can contain, and the thing that read as gas between the arms.
    // Paying for the trunk's flank out of this was tried and is NOT what the
    // numbers wanted: 0.26 to 0.225 did not recover the rank slot the flank cost
    // and it took seed 7 / fast p99 from 0.2867 to 0.2846, so this wash is
    // inside the frame's top 1% and is load-bearing for "there must be real
    // highlights". The flank was dropped instead. Do not trim this to buy
    // something else without re-reading p99 on fast.
    this._emits(d.x, d.y + dir * d.r * 0.35, d.r * 2.85, base, k * 0.26, S.GLOW, CEIL_PROP);
    this._emits(d.x, d.y + dir * d.r * 0.55, Math.min(d.r * 1.30, CORE_PX * 2.0 / this._ppu),
      tip, k * 2.20, S.GLOW, CEIL_PROP);
  }

  // ---------------------------------------------------------------- hazards ---
  _hazards(world, b, t) {
    const list = world.hazards;
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      if (!h.alive) continue;
      if (h.x < b.x0 - 340) continue;
      if (h.x > b.x1 + 340) break;
      if (h.kind === KIND.URCHIN) this._urchin(h, t);
      else if (h.kind === KIND.JELLY) this._jelly(h, t);
    }
  }

  _urchin(h, t) {
    const r = h.r, sid = (h.x * 4.61) | 0;
    const e = this._eat(h.x);
    if (e > 0.97) return;
    const spin = t * h.spin + h.phase;
    const p = 0.56 + 0.44 * Math.sin(t * 1.35 + h.phase);
    const hot = (h.brushed ? 1.4 : 1) * (1 - e);
    const cRim = e > 0 ? this._ate(PAL.hazardRim, e, o0) : PAL.hazardRim;
    const cBod = e > 0 ? this._ate(PAL.hazard, e, o1) : PAL.hazard;

    // Scatter. Rule 3 at the top of this file still holds - light centred on the
    // shell would fill the core that has to stay dark, because additive light
    // cannot be occluded by its own round's silhouette - but the previous form,
    // a closed 27-point ring stroked 1.34r wide at falloff 1.05, was a *filled
    // disc with an edge*. At range it read as a flat magenta plate with a
    // pinwheel drawn on it: a circle that reads as a debug primitive, which is
    // the one thing this file keeps having to unlearn. Seven discrete puffs at
    // unequal radii and unequal gains carry the same off-centre scatter with no
    // closed geometry anywhere in it, the same way _shock does.
    for (let q = 0; q < 7; q++) {
      const hq = hash2(sid, q * 7 + 3), hq2 = hash2(sid, q * 7 + 5);
      const a = spin * 0.35 + (q / 7) * TAU + (hq - 0.5) * 0.7;
      const rr = r * (1.02 + hq2 * 0.86);
      this._emits(h.x + Math.cos(a) * rr, h.y + Math.sin(a) * rr,
        r * (1.10 + hq * 1.05),
        cBod, (0.16 + 0.10 * p) * hot * (0.45 + hq2 * 1.05), S.GLOW, CEIL_WARM);
    }

    // Shell: an absence. THORN carries the material - it is the profile the
    // texture kit built for exactly this - and the geometric spines carry the
    // per-instance variance a single texture cannot. Neither lights the middle.
    this.occl.push(h.x, h.y, r * 3.0, r * 3.0, spin * 0.8,
      PAL.hazardDark[0], PAL.hazardDark[1], PAL.hazardDark[2], 0.70, S.THORN);

    // Spines. The hot edge runs along the outer shaft rather than sitting as a
    // bead on the point: that is what puts the hazard's own hue on the majority
    // of its pixels instead of on forty of them.
    //
    // Two populations, an uneven angular partition, and roots on the SHELL
    // rather than on a point - and which of those matters is a measured result
    // that contradicts the brief it came from.
    //
    // A blind review called this "a procedural asterisk - sixteen near-identical
    // spokes at near-equal angular spacing", and prescribed angular jitter. The
    // obvious reading is that the angular PERIOD is the defect. It is not, and
    // the disconfirmation is clean: build a deliberately PERFECT control (jitter,
    // length, bend, thickness and gain variation all deleted), render one urchin
    // alone at a fixed radius, and take an angular spectrum about its centre.
    // The perfect control lands on m=17 - exactly the spine count - at 21-57x
    // line contrast on four urchins over two seeds. The build being replaced,
    // with only its +-0.22rad jitter, wanders over m=12,16,23,29 at 2.2-4.6x,
    // i.e. the noise floor. The period was ALREADY dead.
    //
    // (Two instrument notes worth keeping. In the composite frame neither the
    // angular spectrum nor tools/_comb.mjs can see the difference at all - at
    // 1600x900 the creature is ~100px across and the annulus contains an anchor
    // stalk, an anemone colony and rock, every one of them a larger signal;
    // _comb.mjs scored the perfect asterisk as LESS regular than the shipped one
    // (4.76x at 70px against 4.32x at 15px) and its peak lag moves frame to
    // frame, which by its own reading rule means neither number is a finding.
    // Isolate the object before measuring it, and measure on the axis the defect
    // lives on. _comb.mjs answers "is a repeating CELL WIDTH drawing a comb" and
    // a rotated primitive is not that.)
    //
    // So what the eye is reading is not a period. It is that every element is
    // the SAME element: one straight radial taper, one width class, one origin,
    // one scale. The variance therefore goes where a spectrum cannot see it -
    // into class, origin, curvature and joint weight - and only a little more
    // into angle.
    //
    // The warp below is that "only a little more". An even partition plus a
    // symmetric jitter is still an even partition with noise on it: every gap
    // has the same expectation. A smooth warp of the circle gives genuine clumps
    // and voids at a phase this urchin owns. Amplitudes are bounded so
    // d(uw)/du = 1 + TAU*(w1*cos + 2*w2*cos) stays positive (0.085 + 2*0.030
    // times TAU is 0.91 < 1) and no two spines can swap places and collapse.
    const ns = 17;
    const w1 = (hash2(sid, 401) - 0.5) * 0.14, w2 = (hash2(sid, 403) - 0.5) * 0.06;
    const wp1 = hash2(sid, 405) * TAU, wp2 = hash2(sid, 407) * TAU;
    for (let k = 0; k < ns; k++) {
      const h1 = hash2(sid, k * 3 + 1), h2 = hash2(sid, k * 3 + 2), h3 = hash2(sid, k * 3 + 5);
      const h4 = hash2(sid, k * 5 + 41), h5 = hash2(sid, k * 5 + 43);
      const u = k / ns;
      const uw = u + w1 * Math.sin(TAU * u + wp1) + w2 * Math.sin(2 * TAU * u + wp2);
      const ang = spin + uw * TAU + (h1 - 0.5) * 0.30;
      // A stub is not a short spine. It is thicker for its length and it stops
      // inside the long spines' field, so the silhouette carries two scales
      // instead of one - and it keeps the magenta area up while the long spines
      // get sparser, which is what protects the read at 165 m/s.
      const stub = h4 < 0.28;
      const L = stub ? r * (0.86 + h2 * 0.50) : r * (1.28 + Math.pow(h2, 1.15) * 0.92);
      // Roots sit ON the shell at varying depth, and off the radius they leave
      // on, so there is no point in the middle that every spine passes through.
      const rb = r * (0.30 + h5 * 0.34);
      const bt = (h4 - 0.5) * r * 0.30;
      // S-curve, not an arc: a quadratic bend plus a cubic hook of independent
      // sign. Some spines sabre, some hook back, none is a rotation of another.
      // The hook is bounded well under the bend: a spine that turns far enough
      // to stop pointing outward stops reading as a spike, and the spike is the
      // whole of the threat read at 165 m/s.
      const bend = (h1 - 0.5) * 0.86, hook = (h5 - 0.5) * 0.50;
      const thick = (stub ? 0.17 : 0.13) + h3 * 0.20;
      const flare = 0.30 + h4 * 0.50;
      const n = 5, pts = this._p2(n);
      const nbx = -Math.sin(ang), nby = Math.cos(ang);
      for (let s = 0; s < n; s++) {
        const f = s / (n - 1);
        const a = ang + bend * f * f + hook * f * f * f;
        const rr = rb + (L - rb) * f;
        pts[s * 2] = h.x + Math.cos(a) * rr + nbx * bt * (1 - f) * (1 - f);
        pts[s * 2 + 1] = h.y + Math.sin(a) * rr + nby * bt * (1 - f) * (1 - f);
      }
      // Weight change at the joint - the one thing the review credited the
      // anchors for and this creature had none of. The flare decays over ~15%
      // of the shaft, so it is a shoulder where the spine meets the shell and
      // not a fatter spine.
      const swf = (f) => lerp(r * thick, r * 0.012, Math.pow(f, 0.62))
        * (0.84 + 0.30 * noise1(f * 4.7 + h1 * 11.3))
        * (1 + flare * Math.exp(-f * 6.5));
      // ...and moving the roots off a common point is what EXPOSES trap 1.
      // Seventeen ribbon start caps used to overlap at r*0.24 into one blob
      // under the shell; scattered over 0.30-0.64r and widened by the flare,
      // their union drew a hard-edged polygon around the core - visible as
      // straight diagonal steps at 4x, and exactly the artefact this file has
      // removed from the mote's rim, the spire and the anemone trapezoids. A
      // ribbon cannot soften its own butt cap at any falloff, so the cap is
      // faded out instead: the first fifth of every spine is transparent, which
      // is the part buried in the shell anyway.
      this.rDark.stroke(pts, {
        width: swf, color: PAL.hazardDark,
        alpha: (f) => (0.99 - f * 0.14) * clamp01(f * 5.5), falloff: 0.95,
      });
      // Offset to one flank, so it reads as a lit side and not as an outline.
      const gz = this._p3(n);
      for (let s = 0; s < n; s++) {
        const f = s / (n - 1);
        const w = swf(f) * 0.46;
        gz[s * 2] = pts[s * 2] + nbx * w;
        gz[s * 2 + 1] = pts[s * 2 + 1] + nby * w;
      }
      const gk = (0.72 + 0.28 * p) * hot * (0.52 + h3 * 0.72);
      // The highlight tracks the shaft it lies on, or a thin spine and a thick
      // one carry the same line and the width variance is invisible in light.
      const gw = 0.70 + h3 * 0.72;
      this.rGlow.stroke(gz, {
        width: (f) => lerp(wCore(r * 0.070 * gw, 4), wCore(r * 0.022 * gw, 4), Math.pow(f, 0.5)),
        color: scaled(cRim, 2.9 * gk, c1),
        alpha: (f) => 0.66 * Math.pow(Math.sin(Math.PI * clamp01(0.08 + f * 0.88)), 0.5)
          * clamp01(1.2 - f * 0.95) * clamp01(f * 5.5),
        falloff: 4,
      });
      // Glint pulled *inside* the tip and stretched along the spine. A round
      // bead sitting on the point detaches and floats. Not every spine either -
      // regularity is what read as floral - and its hash is now independent of
      // the length's, so "long" and "glinting" are not the same spine twice.
      // Stubs never glint: they are half-buried in the shell.
      if (!stub && h5 > 0.30) {
        const i0 = n - 2, lf = 0.52 + h4 * 0.40;
        const ex = lerp(pts[i0 * 2], pts[i0 * 2 + 2], lf);
        const ey = lerp(pts[i0 * 2 + 1], pts[i0 * 2 + 3], lf);
        const sa = Math.atan2(pts[i0 * 2 + 3] - pts[i0 * 2 + 1], pts[i0 * 2 + 2] - pts[i0 * 2]);
        const bk = gk * (0.85 + h1 * 0.55);
        this._emit(ex, ey, r * (0.52 + h3 * 0.42), r * 0.32, sa,
          cBod[0] * bk * 1.5, cBod[1] * bk * 1.5, cBod[2] * bk * 1.5, S.STREAK, CEIL_WARM);
        this._emit(ex, ey, r * (0.46 + h3 * 0.30), r * 0.33, sa,
          cRim[0] * bk * 1.6, cRim[1] * bk * 1.6, cRim[2] * bk * 1.6, S.GLOW, CEIL_WARM);
      }
    }

    // Shell body, over the spine roots so the joint is not visible.
    const bp = this._p1(2);
    bp[0] = h.x - r * 0.17; bp[1] = h.y; bp[2] = h.x + r * 0.17; bp[3] = h.y;
    this.rDark.stroke(bp, { width: r * 1.34, color: PAL.hazardDark, alpha: 0.995, falloff: 0.78 });
    // ...and the shell is a body, not a dot. Three unequal plates at unequal
    // offsets, drawn as occluder sprites so they land over the spine ribbons
    // (round 2 flushes every ribbon before every sprite), give the dark core a
    // lumpy silhouette and bury each root at a different depth. VOLUME rather
    // than a ribbon for the reason this file keeps paying for: a ribbon cannot
    // reach zero at its own edge, and three overlapping trapezoids would be
    // exactly the artefact removed from under the anemone colonies. They sit
    // inside the 1.34r body, so this is silhouette shape rather than new area -
    // seed 7 / fast has no hazard in it and hazardNear moved 24.2% -> 24.6%.
    for (let q = 0; q < 3; q++) {
      const ha = hash2(sid, q * 13 + 211), hb = hash2(sid, q * 13 + 213);
      const pa = spin * 0.8 + q * 2.09 + ha * 1.1;
      const pr = r * (0.12 + hb * 0.26);
      this.occl.push(h.x + Math.cos(pa) * pr, h.y + Math.sin(pa) * pr,
        r * (0.80 + ha * 0.56), r * (0.66 + hb * 0.52), pa + ha,
        PAL.hazardDark[0], PAL.hazardDark[1], PAL.hazardDark[2], 0.80, S.VOLUME);
    }

    // Rim on the shell's lit flank: the brightest thing on the object, wrapped
    // around a hole. Dark core, hot rim - the inversion, in one gesture.
    const n2 = 15, rp = this._p1(n2);
    for (let s = 0; s < n2; s++) {
      const a = -Math.PI * 1.22 + (s / (n2 - 1)) * Math.PI * 1.04;
      rp[s * 2] = h.x + Math.cos(a) * r * 0.60;
      rp[s * 2 + 1] = h.y + Math.sin(a) * r * 0.60;
    }
    this.rGlow.stroke(rp, {
      width: r * 0.36, color: cBod,
      alpha: (f) => Math.pow(Math.sin(f * Math.PI), 1.2) * 0.30 * hot, falloff: 1.5,
    });
    this.rGlow.stroke(rp, {
      width: wCore(r * 0.055, 4), color: scaled(cRim, 2.7, c1),
      alpha: (f) => Math.pow(Math.sin(f * Math.PI), 0.75) * (0.50 + 0.24 * p) * hot, falloff: 4,
    });

    // Ember down in the shell. Dim on purpose: the core is a hole, and a hot
    // point here is the exact mistake that made this thing read as a flower.
    this._emits(h.x, h.y, r * 0.54, cBod, (0.28 + 0.20 * p) * hot, S.GLOW, CEIL_WARM);
  }

  _jelly(h, t) {
    const r = h.r, sid = (h.x * 6.29) | 0;
    const e = this._eat(h.x);
    if (e > 0.97) return;
    const bell = 0.86 + 0.14 * Math.sin(t * 1.6 + h.bellPhase);
    const w = r * 1.18 * bell;          // half-width of the bell
    const hh = r * 1.06 / bell;         // half-height of the dome
    const cx = h.x, cy = h.y;
    const rim = w * (1.08 + 0.055 * Math.sin(h.bellPhase));
    const hotb = (h.brushed ? 1.25 : 1) * (1 - e);
    const cRim = e > 0 ? this._ate(PAL.hazardRim, e, o0) : PAL.hazardRim;
    const cBod = e > 0 ? this._ate(PAL.hazard, e, o1) : PAL.hazard;

    // --- dark fill along the dome's medial axis: silhouette in bright water ---
    const nf = 15, fill = this._p1(nf);
    for (let s = 0; s < nf; s++) {
      const u = -0.96 + 1.92 * (s / (nf - 1));
      fill[s * 2] = cx + u * w * 1.04;
      fill[s * 2 + 1] = cy - hh * Math.sqrt(Math.max(0, 1 - u * u)) * 0.46;
    }
    this.rDark.stroke(fill, {
      width: (f) => {
        const u = -0.96 + 1.92 * f;
        return hh * Math.sqrt(Math.max(0.03, 1 - u * u)) * 1.04 + hh * 0.12;
      },
      color: PAL.hazardDark, alpha: 0.88, falloff: 1.0,
    });

    // --- interior. Deliberately *low*: the dome is a dark translucent body,
    // not a lit ball. PETAL supplies the membrane's own material - canals,
    // scalloped margin, gonads - which stacked GLOWs cannot. ---
    this._emit(cx, cy - hh * 0.28, w * 2.30, hh * 2.15, 0,
      cBod[0] * 0.20 * bell, cBod[1] * 0.20 * bell, cBod[2] * 0.20 * bell, S.PETAL, CEIL_WARM);
    this._emit(cx, cy - hh * 0.34, w * 1.90, hh * 1.66, 0,
      cBod[0] * 0.09 * bell, cBod[1] * 0.09 * bell, cBod[2] * 0.09 * bell, S.VOLUME, CEIL_WARM);

    // --- bell outline: the membrane ---
    const n = 32, out = this._p2(n);
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      let x, y;
      if (f < 0.13) {
        const u = f / 0.13;
        x = -lerp(w * 0.80, rim, u); y = hh * 0.46 * (1 - u) * (1 - u * 0.28);
      } else if (f > 0.87) {
        const u = (1 - f) / 0.13;
        x = lerp(w * 0.80, rim, u); y = hh * 0.46 * (1 - u) * (1 - u * 0.28);
      } else {
        const th = ((f - 0.13) / 0.74) * Math.PI;
        const rw = w * (1.08 + 0.055 * Math.sin(th * 4 + h.bellPhase) + 0.028 * Math.sin(th * 7));
        x = -Math.cos(th) * rw; y = -Math.sin(th) * hh;
      }
      out[s * 2] = cx + x; out[s * 2 + 1] = cy + y;
    }
    this.rDark.stroke(out, { width: w * 0.20, color: PAL.hazardDark, alpha: 0.62, falloff: 1.2 });

    // --- organs ---
    for (let k = 0; k < 4; k++) {
      const u = (k / 3 - 0.5) * 1.32;
      const ox = cx + u * w * 0.74;
      const oy = cy - hh * 0.34 - Math.abs(u) * hh * 0.12;
      const gk = (0.46 + 0.30 * Math.sin(t * 1.9 + k * 1.7 + h.bellPhase)) * bell * hotb;
      this._emit(ox, oy, w * 0.36, hh * 0.60, 0,
        cBod[0] * gk * 0.7, cBod[1] * gk * 0.7, cBod[2] * gk * 0.7, L_MEMB, CEIL_WARM);
      this._emit(ox, oy, w * 0.29, hh * 0.54, 0,
        cRim[0] * gk * 0.95, cRim[1] * gk * 0.95, cRim[2] * gk * 0.95, S.GLOW, CEIL_WARM);
      // canal from the apex out to the rim
      this.rGlow.segment(cx + u * w * 0.14, cy - hh * 0.82, cx + u * rim * 0.94, cy - hh * 0.03,
        wCore(w * 0.045, 3), cRim, 0.24 * bell, 3);
    }
    // manubrium: the stomach hanging under the bell
    const mp = this._p3(4);
    for (let s = 0; s < 4; s++) {
      const f = s / 3;
      mp[s * 2] = cx + Math.sin(t * 1.3 + h.bellPhase) * w * 0.10 * f;
      mp[s * 2 + 1] = cy - hh * 0.20 + f * hh * 1.05;
    }
    this.rGlow.stroke(mp, {
      width: (f) => lerp(w * 0.34, w * 0.12, f), color: cRim,
      alpha: (f) => 0.26 * bell * (1 - f * 0.6), falloff: 2.4,
    });

    // Membrane: soft scatter band, then the hot edge. This is the object's
    // value tier - a bright margin bounding a dark dome.
    this.rGlow.stroke(out, { width: w * 0.52, color: cBod, alpha: 0.20 * bell, falloff: 1.6 });
    this.rGlow.stroke(out, {
      width: (f) => lerp(wCore(w * 0.10, 4.5), wCore(w * 0.055, 4.5), Math.abs(f * 2 - 1)),
      color: scaled(cRim, 3.1, c1),
      alpha: (f) => (0.20 + 0.44 * Math.pow(Math.sin(f * Math.PI), 0.7)) * bell * hotb, falloff: 4.5,
    });

    // --- tentacles. Follow-through comes from sampling where the bell *was*. ---
    const vlag = (lag) => Math.sin((t - lag) * h.freq * TAU + h.phase) * h.amp - (h.y - h.y0);

    for (let k = 0; k < 3; k++) {           // oral arms: short, wide, frilly
      const u = (k - 1) * 0.62;
      const hk = hash2(sid, k * 5 + 41);
      const nq = 8, tp = this._p3(nq);
      const L = r * (1.6 + hk * 1.0);
      for (let s = 0; s < nq; s++) {
        const f = s / (nq - 1);
        const lag = f * f * 0.26;
        const frill = Math.sin(t * 1.5 - f * 4.4 + k * 2.2 + h.phase) * r * 0.30 * f;
        tp[s * 2] = cx + u * w * 0.52 + frill + u * r * 0.34 * f;
        tp[s * 2 + 1] = cy + hh * 0.10 + f * L + vlag(lag) * 0.85 * Math.pow(f, 1.2);
      }
      this.rDark.stroke(tp, {
        width: (f) => lerp(r * 0.34, r * 0.06, Math.pow(f, 0.7)), color: PAL.hazardDark,
        alpha: (f) => 0.52 * (1 - f * 0.8), falloff: 1.3,
      });
      this.rGlow.stroke(tp, {
        width: (f) => lerp(r * 0.30, r * 0.05, Math.pow(f, 0.7)), color: cBod,
        alpha: (f) => 0.22 * (1 - f * 0.65) * bell, falloff: 1.8,
      });
      this.rGlow.stroke(tp, {
        width: (f) => lerp(wCore(r * 0.06, 4), wCore(0, 4), f), color: scaled(cRim, 2.2, c1),
        alpha: (f) => 0.34 * Math.pow(1 - f, 1.3) * bell * hotb, falloff: 4,
      });
    }

    const nT = 7;
    for (let k = 0; k < nT; k++) {
      const hk = hash2(sid, k * 3 + 1);
      const u = (k / (nT - 1)) * 2 - 1;
      const nq = 9, tp = this._p3(nq);
      const L = r * (2.5 + hk * 2.8);
      for (let s = 0; s < nq; s++) {
        const f = s / (nq - 1);
        const lag = f * f * 0.34;
        const wob = Math.sin(t * (1.7 + hk * 0.9) - f * 3.2 + k * 1.7 + h.phase) * r * 0.32 * f;
        tp[s * 2] = cx + u * rim * 0.92 + wob + u * r * 0.22 * f;
        tp[s * 2 + 1] = cy + hh * 0.22 + f * L + vlag(lag) * 0.92 * Math.pow(f, 1.15);
      }
      this.rGlow.stroke(tp, {
        width: (f) => lerp(wCore(r * 0.055, 3), wCore(0, 3), Math.pow(f, 0.55)), color: cBod,
        alpha: (f) => 0.34 * Math.pow(1 - f, 0.85) * bell, falloff: 3,
      });
      this.rGlow.stroke(tp, {
        width: (f) => lerp(wCore(r * 0.05, 3.5), wCore(0, 3.5), Math.pow(f, 0.5)),
        color: scaled(cRim, 2.4, c1),
        alpha: (f) => 0.36 * Math.pow(clamp01(1 - f * 2.3), 1.4) * bell * hotb, falloff: 3.5,
      });
    }

    // Danger telegraph. Placed as flanking lobes and one puff under the bell,
    // never a disc over the dome: the dome has to stay the dark part.
    const tg = 0.075 * (1 - e);
    this._emit(cx, cy + hh * 1.5, w * 4.6, hh * 3.4, 0,
      cBod[0] * tg, cBod[1] * tg, cBod[2] * tg, S.VEIL, CEIL_WARM);
    for (let k = 0; k < 2; k++) {
      const sx = cx + (k ? 1 : -1) * w * 2.1;
      this._emit(sx, cy - hh * 0.2, w * 3.0, hh * 3.0, 0,
        cBod[0] * tg * 0.9, cBod[1] * tg * 0.9, cBod[2] * tg * 0.9, S.VEIL, CEIL_WARM);
    }
  }

  // ---------------------------------------------------------------- anchors ---
  _anchors(world, player, b, t, dim) {
    const list = world.anchors;
    const held = player.anchor;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive) continue;
      const isHeld = a === held;
      if (!isHeld) {
        if (a.x < b.x0 - 380) continue;
        if (a.x > b.x1 + 380) break;
      }
      this._anchor(a, player, isHeld, t, dim);
    }
  }

  _anchor(a, player, isHeld, t, dim) {
    const r = a.r, sid = (a.x * 7.31) | 0;
    const spent = clamp01(a.used * 0.20);        // grabbed bulbs read as spent
    const dpx = player.x - a.x, dpy = player.y - a.y;
    const dpl = Math.hypot(dpx, dpy) || 1;
    const pdx = dpx / dpl, pdy = dpy / dpl;
    const near = 1 - clamp01(dpl / 700);
    const live = isHeld ? 1 : (0.34 + 0.52 * smoothstep(near)) * (1 - spent * 0.30);
    const pulse = 0.78 + 0.22 * Math.sin(t * a.pulse * (isHeld ? 3.6 : 1.5) + a.phase);
    // Being eaten by the Hush. The whole palette is rewritten rather than the
    // gain alone: a desaturated bulb at half brightness reads as consumed, a
    // full-saturation amber bulb at half brightness reads as a bug.
    const e = this._eat(a.x);
    const cCore = e > 0 ? this._ate(PAL.anchorCore, e, o0) : PAL.anchorCore;
    const cMid = e > 0 ? this._ate(PAL.anchorMid, e, o1) : PAL.anchorMid;
    const cRim = e > 0 ? this._ate(PAL.anchorRim, e, o2) : PAL.anchorRim;
    const cLive = e > 0 ? this._ate(PAL.anchorLive, e, o3) : PAL.anchorLive;
    const k = pulse * (0.50 + live * 1.05) * lerp(1, dim, 0.45) * (1 - e * 0.62);

    // Strain: a loaded bulb is dragged toward the mote and its stalk goes taut.
    const strain = isHeld ? clamp01(0.40 + player.tetherGlow * 0.60) : 0;
    const pull = r * (0.28 + 0.26 * clamp01(player.speedSmooth / 2000)) * strain;
    const sway = Math.sin(t * a.sway * 0.9 + a.phase) * (a.stalk * 0.055) * (1 - strain * 0.85);
    const bx = a.x + sway + pdx * pull, by = a.y + pdy * pull;
    a.visX = bx; a.visY = by;
    const topY = a.y - a.stalk;

    // ---- stalk ----
    const n = 15, sp = this._p1(n);
    const tipY = by - r * 0.74;
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      const en = f * f * (3 - 2 * f);           // keep the root vertical at the roof
      // The wander is not decoration. A stalk built from one smooth bow is a
      // ruled line, and at 1000m one of them crossed the whole frame beside a
      // kelp trunk at the same angle - the "two competing parallel verticals" a
      // review flagged. Low frequency, and zero at both ends so the roof joint
      // and the bulb still meet the line they are drawn from.
      sp[s * 2] = lerp(a.x, bx, en) + Math.sin(f * Math.PI)
        * (sway * 0.5 * (1 - strain)
          + (noise1(f * 1.6 + sid * 0.031) - 0.5) * a.stalk * 0.075 * (1 - strain * 0.6));
      sp[s * 2 + 1] = lerp(topY, tipY, f);
    }
    // Nodes are swellings *of* the stalk, so they belong in its width function.
    // They used to be three dark BLOB quads stamped over it at alpha 0.82, and
    // BLOB has a near-opaque core: attribution by elimination (?noSprites=1 /
    // ?noRibbons=1 / ?debugLayers=1) found seven 2-5px hard-edged holes punched
    // through the stalks frame-wide, false-colouring to BLOB's hue - the
    // "rectangular sprite-seam notch punched out of one trunk" a review saw.
    // A quad cannot help here: the stalk is a ribbon, so anything drawn as a
    // separate dark sprite over it is a hole rather than a bulge. The sample
    // count went 11 -> 15 because a bump 0.10 wide in f has to land on more than
    // one sample or it aliases into a kink.
    // (`-x ** 2` is a JavaScript SyntaxError, hence the inner parentheses.)
    const bell = (f, c) => { const u = (f - c) * 10; return Math.exp(-(u * u)); };
    const bump = (f) => 1 + 0.40 * bell(f, 0.32) + 0.34 * bell(f, 0.55) + 0.28 * bell(f, 0.78);
    this.rDark.stroke(sp, {
      width: (f) => lerp(r * 0.32, r * 0.56, Math.pow(f, 1.6)) * (1 - strain * 0.20)
        * (0.88 + 0.24 * noise1(f * 5.1 + sid * 0.017)) * bump(f),
      color: PAL.voidDeep, alpha: 0.94, falloff: 1.05,
    });
    // The stalk conducts: a warm filament inside it, loaded when tethered.
    this.rGlow.stroke(sp, {
      width: (f) => lerp(wCore(r * 0.06, 3), wCore(r * 0.15, 3), f),
      color: isHeld ? cLive : cMid,
      alpha: (f) => (isHeld ? 0.62 : 0.14 + 0.30 * live) * Math.pow(f, 1.5) * pulse, falloff: 3,
    });
    const so = this._p2(n);
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      so[s * 2] = sp[s * 2] - lerp(r * 0.15, r * 0.27, f);
      so[s * 2 + 1] = sp[s * 2 + 1];
    }
    this.rGlow.stroke(so, {
      width: wCore(r * 0.07, 3), color: cRim,
      alpha: (f) => (0.08 + 0.24 * live) * (0.4 + 0.6 * f), falloff: 3,
    });
    // Nodes: swellings where the stalk has grown in fits.
    for (let q = 0; q < 3; q++) {
      const f = 0.32 + q * 0.23;
      const si = Math.min(n - 2, (f * (n - 1)) | 0), lf = f * (n - 1) - si;
      const nx = lerp(sp[si * 2], sp[si * 2 + 2], lf);
      const ny = lerp(sp[si * 2 + 1], sp[si * 2 + 3], lf);
      const nr = r * (0.20 + hash2(sid, q * 5 + 1) * 0.15);
      // Rectified: b > a, so 29% of this cycle was negative gain on an additive
      // quad, which is a black hole punched through the anchor's own spill. See
      // _emit's floor.
      const np = Math.max(0, 0.38 + 0.62 * Math.sin(t * (1.5 + hash2(sid, q * 5 + 2) * 1.2) + q * 2.2 + a.phase));
      this._emits(nx, ny, nr * 4.4, cRim, k * np * 0.20, S.GLOW, CEIL_WARM);
      // nr is r*0.20..0.35, so a CORE quad at nr*1.25 was 3-17 world units -
      // the flat-block size band described at CORE_PX. Every small hot CORE in
      // this file is now a GLOW at roughly twice the width, whose own core is
      // 16% of its quad rather than 5% and therefore survives minification.
      this._emits(nx, ny, nr * 2.0, cMid, k * np * 0.42, S.GLOW, CEIL_WARM);
    }

    // ---- bulb: a teardrop, from a profiled stroke over its vertical axis ----
    const axTop = by - r * 1.32, axBot = by + r * 1.54;
    // 0.826, not 0.79: at 0.79 the profile is still 0.28 of full width when the
    // ribbon reaches its last sample, and a ribbon's last sample is a butt cap -
    // so the bulb ended in a flat horizontal edge 0.7r across. Invisible under a
    // lit bulb, a straight line under a spent or distant one.
    const prof = (f) => Math.pow(Math.sin(Math.PI * (0.17 + 0.826 * f)), 0.60);
    const bw = (f) => r * 2.50 * prof(f);
    const stx = (f) => pdx * (f - 0.35) * 0.50 * strain * r;
    const sty = (f) => pdy * (f - 0.35) * 0.30 * strain * r;
    const nb = 13, bp = this._p3(nb);
    for (let s = 0; s < nb; s++) {
      const f = s / (nb - 1);
      bp[s * 2] = bx + stx(f);
      bp[s * 2 + 1] = lerp(axTop, axBot, f) + sty(f);
    }
    // alpha < 1 on purpose: the membrane is thick, not opaque.
    this.rDark.stroke(bp, { width: bw, color: PAL.voidDeep, alpha: 0.93, falloff: 0.95 });

    // Warm mass. The amber has to be *dense*, not a tint on an outline, so the
    // interior is filled by glows that follow the teardrop's own profile. Amber
    // and orange carry the volume; near-white is rationed to the core alone, or
    // the anchor competes with the mote for hue as well as value.
    // Trimmed a third. This is a 250 x 230px wash of orange around every bulb
    // and it is the least characterful light on the object, but `rank` is a sum
    // of L^2 over a 66x64px block, so a broad mid-value wash is expensive in
    // exactly the currency the hero needs: on seed 3 / launch four blocks beat
    // the mote and all four were anchors, attributed by zeroing them.
    this._emit(bx, by - r * 0.10, r * 10 * (isHeld ? 1.30 : 1), r * 9.2 * (isHeld ? 1.30 : 1), 0,
      cRim[0] * k * 0.070, cRim[1] * k * 0.070, cRim[2] * k * 0.070, S.VEIL, CEIL_WARM);
    // Sampled along the teardrop's own axis so the light fills the body's shape
    // rather than sitting behind it as a disc.
    for (let q = 0; q < 4; q++) {
      const f = 0.22 + q * 0.185;
      const ww = bw(f);
      const amb = q === 1 || q === 2 ? cLive : cMid;
      const kk = k * (q === 1 ? 0.76 : q === 2 ? 0.65 : 0.48);
      this._emit(bx + stx(f), lerp(axTop, axBot, f) + sty(f), ww * 1.20, ww * 1.04, 0,
        amb[0] * kk, amb[1] * kk, amb[2] * kk, S.GLOW, CEIL_WARM);
    }
    // Hot core: small, and the only near-white on the object.
    const cf = 0.46;
    const ccx = bx + stx(cf), ccy = lerp(axTop, axBot, cf) + sty(cf);
    this._emit(ccx, ccy, r * 1.30, r * 1.13, 0,
      cCore[0] * k * 2.05, cCore[1] * k * 1.80, cCore[2] * k * 1.26, S.GLOW, CEIL_WARM);
    // The quad was widened to r*7.8 to satisfy the `max` statistic back when
    // hdrStats sampled a coarse grid and could not see a narrow lobe. It is an
    // exact per-pixel scan now, and the frame peaks above 60 linear against a
    // contract of 6, so that trade has no upside left and a measurable cost: the
    // anchors are the widest hot lobes in frame, and at `tethered` they alone
    // were 12-17% of the mote's own 42-83px annulus. Pulled in at exactly the
    // same gain, so the peak - and therefore the determinism of the post chain
    // at the top of the range, which tools/_det3.mjs is sensitive to - does not
    // move at all, while the energy behind it drops by about 60%. The anchors
    // are meant to be the warm counterpoint, not the brightest thing on screen.
    // Warmer as well as smaller. A near-white lobe this wide made the anchor
    // read as the brightest object in frame, and there are only supposed to be
    // three near-whites in the game with the mote's nucleus first among them.
    // Dropping the blue and green weights turns the wide part of the core amber
    // and leaves the small GLOW above as the only white highlight on the object.
    // ...and the gain comes down rather than the quad going back out. Measured
    // by isolation, the anchors were the second-brightest family in the game at
    // 10.2-17.0 linear, which the tone curve delivers at display 0.90-0.93
    // against the mote's 0.96 - a distinction the eye cannot make, on the one
    // object rule 4 says must never be the brightest. At 4.9 they land at 0.805,
    // a sixth of the display range below the hero, and the mote is left as the
    // only emitter core in the frame above 6 linear. DIMMED, not spread: the
    // quad already came in from r*7.8 to r*3.4 to get out of the mote's 42-83px
    // annulus (see below) and paying this shortfall back as area would put it
    // straight back in. The p99 that buys is taken from the plankton instead,
    // which is where a reward's highlight belongs.
    this._emit(ccx, ccy, r * 3.4, r * 3.0, 0,
      cCore[0] * k * 4.9, cCore[1] * k * 3.95, cCore[2] * k * 2.15, S.CORE, CEIL_WARM);

    // Rim that catches the bulb's own light. Warm, and subordinate to the core.
    const nr2 = 15, rimL = this._p1(nr2);
    for (let s = 0; s < nr2; s++) {
      const f = s / (nr2 - 1);
      rimL[s * 2] = bx + stx(f) - bw(f) * 0.46;
      rimL[s * 2 + 1] = lerp(axTop, axBot, f) + sty(f);
    }
    // Soft band first so the membrane has thickness, then the crisp edge on top.
    this.rGlow.stroke(rimL, {
      width: r * 0.52, color: cRim,
      alpha: (f) => Math.pow(Math.sin(f * Math.PI), 0.9) * (0.16 + 0.26 * live) * pulse, falloff: 1.6,
    });
    this.rGlow.stroke(rimL, {
      width: wCore(r * 0.11, 3.5), color: cLive,
      alpha: (f) => Math.pow(Math.sin(f * Math.PI), 0.85) * (0.34 + 0.60 * live) * pulse, falloff: 3.5,
    });
    for (let s = 0; s < nr2; s++) rimL[s * 2] += bw(s / (nr2 - 1)) * 0.92;
    this.rGlow.stroke(rimL, {
      width: r * 0.46, color: cRim,
      alpha: (f) => Math.pow(Math.sin(f * Math.PI), 1.1) * (0.10 + 0.16 * live) * pulse, falloff: 1.6,
    });
    this.rGlow.stroke(rimL, {
      width: wCore(r * 0.09, 3.5), color: cRim,
      alpha: (f) => Math.pow(Math.sin(f * Math.PI), 1.1) * (0.18 + 0.40 * live) * pulse, falloff: 3.5,
    });

    // Filament: the one detail that makes the bulb an organism, not a lamp.
    const fp = this._p2(11);
    const fw = isHeld ? 6.6 : 1.45;
    for (let s = 0; s < 11; s++) {
      const f = s / 10;
      const amp = bw(lerp(0.12, 0.90, f)) * 0.26 * Math.sin(Math.PI * f);
      fp[s * 2] = bx + stx(f) + Math.sin(f * 5.6 + t * fw + a.phase * 1.7) * amp
        + Math.sin(f * 11.3 + t * fw * 1.6 + a.phase) * amp * 0.30;
      fp[s * 2 + 1] = lerp(axTop + r * 0.20, axBot - r * 0.22, f) + sty(f);
    }
    this.rGlow.stroke(fp, { width: r * 0.44, color: cMid, alpha: 0.20 * live * pulse, falloff: 1.8 });
    this.rGlow.stroke(fp, {
      width: (f) => lerp(wCore(r * 0.085, 3.5), wCore(r * 0.045, 3.5), f),
      color: isHeld ? cCore : cLive,
      alpha: (f) => (0.34 + 0.50 * live) * pulse * Math.pow(Math.sin(f * Math.PI), 0.32) * (1 - spent * 0.28),
      falloff: 3.5,
    });

    // Seeds suspended in the jelly, each on its own clock.
    const nseed = a.big ? 8 : 5;
    for (let q = 0; q < nseed; q++) {
      const u = hash2(sid, q * 13 + 7) * 2 - 1;
      const ff = 0.16 + hash2(sid, q * 17 + 3) * 0.72;
      const px = bx + stx(ff) + u * bw(ff) * 0.32;
      const py = lerp(axTop, axBot, ff) + sty(ff);
      // Negative result, so it stays written down: sk reads like the same
      // sign-crossing pulse as the two above and it is NOT one. It is consumed
      // as 0.45 + sk*0.85, which bottoms out at 0.144, so the gain never
      // crosses zero. A grep for `a + b*Math.sin` with b > a flags this line
      // and is wrong about it; hooking the batch and looking at what actually
      // arrives is what separated the three real sites from this one.
      const sk = 0.32 + 0.68 * Math.sin(t * (1.3 + hash2(sid, q * 7 + 1) * 2.0) + q * 2.4 + a.phase);
      const kk = k * (0.45 + sk * 0.85);
      this._emits(px, py, r * 1.5, cRim, kk * 0.26, S.GLOW, CEIL_WARM);
      this._emits(px, py, r * 0.72, cLive, kk * 0.62, S.GLOW, CEIL_WARM);
    }

    // Tendrils: secondary motion, and the reason it reads as alive.
    const nt = a.big ? 9 : 6;
    for (let q = 0; q < nt; q++) {
      const hq = hash2(sid, q * 11 + 5);
      const u = nt === 1 ? 0 : (q / (nt - 1)) * 2 - 1;
      const ox = bx + u * r * 0.88 + stx(1);
      const oy = by + r * 1.22 + sty(1);
      const L = r * (1.7 + hq * 2.4) * (isHeld ? 1.22 : 1);
      const nq = 7, tp = this._p3(nq);
      for (let s = 0; s < nq; s++) {
        const f = s / (nq - 1);
        const drift = Math.sin(t * (0.7 + hq * 0.8) - f * 2.3 + q * 1.9 + a.phase) * r * (0.34 + hq * 0.30) * f;
        tp[s * 2] = ox + drift + u * r * 1.15 * f * f + pdx * strain * r * 0.7 * f * f;
        tp[s * 2 + 1] = oy + f * L + pdy * strain * r * 0.7 * f * f;
      }
      this.rDark.stroke(tp, {
        width: (f) => lerp(r * 0.17, 0, Math.pow(f, 0.4)), color: PAL.voidDeep,
        alpha: (f) => 0.70 * (1 - f), falloff: 1.2,
      });
      this.rGlow.stroke(tp, {
        width: (f) => lerp(wCore(r * 0.075, 3), wCore(0, 3), Math.pow(f, 0.6)), color: cMid,
        alpha: (f) => (0.22 + 0.40 * live) * pulse * Math.pow(1 - f, 0.75), falloff: 3,
      });
      if (hq > 0.42) {
        const fj = 0.62;
        const si = Math.min(nq - 2, (fj * (nq - 1)) | 0), lf = fj * (nq - 1) - si;
        const nx = lerp(tp[si * 2], tp[si * 2 + 2], lf);
        const ny = lerp(tp[si * 2 + 1], tp[si * 2 + 3], lf);
        // Rectified: b > a, 32% of this cycle was negative. Same defect, same
        // fix, and this is the one the review's (762,452) landed on.
        const np = Math.max(0, 0.35 + 0.65 * Math.sin(t * (1.9 + hq) + q * 2.7 + a.phase));
        this._emits(nx, ny, r * 1.0, cMid, k * np * 0.42, S.GLOW, CEIL_WARM);
        this._emits(nx, ny, r * 0.52, cLive, k * np * 0.58, S.GLOW, CEIL_WARM);
      }
    }

    if (isHeld) {
      // Strain veins from the core out to where the tether leaves the membrane.
      const pa = Math.atan2(pdy, pdx);
      const ex = bx + pdx * r * 0.92, ey = by + pdy * r * 0.92;
      for (let q = 0; q < 3; q++) {
        const av = pa + (q - 1) * 0.36;
        this.rGlow.segment(bx + stx(0.5), by, bx + Math.cos(av) * r * 0.88, by + Math.sin(av) * r * 0.88,
          wCore(r * 0.07, 3.5), cLive, 0.42 * pulse, 3.5);
      }
      // The membrane flares where the line is pulling on it. Gold, not white,
      // and smaller: a near-white CORE at gain 9 here was the single brightest
      // *area* in the frame on seed 3 (538 pixels over L0.72 against the mote's
      // 259), which puts an anchor above the protagonist on the ladder in rule 4.
      // The only near-white the eye should find is the mote's nucleus.
      this._emits(ex, ey, r * 1.85, cLive, 0.58 * pulse, S.GLOW, CEIL_WARM);
      this._emits(ex, ey, r * 1.75, cLive, 1.55 * pulse, S.GLOW, CEIL_WARM);
      // One dim anamorphic bar, tall enough that its core is not a hairline.
      this._emit(bx, by, r * 9, r * 2.4, 0,
        cMid[0] * 0.26 * pulse, cMid[1] * 0.24 * pulse, cMid[2] * 0.18 * pulse,
        S.STREAK, CEIL_WARM);
    }
  }

  // -------------------------------------------------------------- plankton ---
  _plankton(world, b, t, dim) {
    const list = world.plankton;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.taken) continue;
      if (p.x < b.x0 - 220) continue;
      if (p.x > b.x1 + 220) break;
      const e = this._eat(p.x);
      if (e > 0.98) continue;
      // World gen lays these on an even arc. Break the string up at draw time -
      // well inside the magnet radius, so it costs nothing in feel.
      const sid = (p.phase * 4096) | 0;
      const orb = t * (0.35 + hash2(sid, 3) * 0.55) + p.phase;
      const x = p.x + (hash2(sid, 1) - 0.5) * 30 + Math.cos(orb) * 9;
      const y = p.y + (hash2(sid, 2) - 0.5) * 26 + Math.sin(t * p.bob + p.phase) * 11
        + Math.sin(orb * 0.7) * 6;
      const vs = hash2(sid, 4), vh = hash2(sid, 6), vr = hash2(sid, 7);
      // Size, biased small with a long tail: a swarm is mostly small organisms
      // with a few large ones, and a flat range renders as one radius repeated.
      const sz = p.r * (0.54 + vs * vs * 1.16);
      // Pulse DEPTH varies per grain as well as its rate, so some of the field
      // breathes and some of it holds. Two hundred dots on one envelope is a
      // particle system however well each dot is drawn.
      const mid = 0.50 + hash2(sid, 8) * 0.22;
      const k = (mid + (1 - mid) * Math.sin(t * (1.8 + hash2(sid, 5) * 1.5) + p.phase * 1.7))
        * dim * (1 - e);
      // Mint, and only mint, but mint has age in it. This used to mix up to 38%
      // of PAL.moteInner into each grain, which put the hero's own hue on the one
      // thing there are thirty of in frame - a review found the mote "cyan in a
      // cyan environment... the hero owns no hue of its own" - so the hue varies
      // WITHIN the collectible's own family instead: pale toward planktonCore on
      // one side, deep sea-green toward planktonDim on the other. Same organism
      // at two points in its cycle. The single-sided version that replaced the
      // mote mix was measured at 0.42 of one endpoint, which is a value ramp
      // rather than a hue one, and the field read as "same size, same falloff,
      // same hue" for exactly that reason.
      if (vh > 0.44) mixCol(PAL.plankton, PAL.planktonCore, (vh - 0.44) * 0.80, c0);
      else mixCol(PAL.plankton, PAL.planktonDim, (0.44 - vh) * 1.05, c0);
      if (e > 0) this._ate(c0, e, c0);
      const pc = e > 0 ? this._ate(PAL.planktonCore, e, o0) : PAL.planktonCore;
      // The body, narrower and hotter than the disc it replaces. That trade is
      // very nearly free against the highlight contract and decisive to the eye:
      // above-threshold area goes as w^2 ln(P/T), so pulling w in by a tenth
      // while pushing P up by a half lands within a few per cent of the same
      // count of pixels over 0.25 linear - and only one of the two shapes reads
      // as an organism. The other reads as fog, and costs more.
      //
      // Peak is per-grain and nothing here reaches CEIL_REWARD, which is the
      // whole point of the number. A clamp does not merely dim a field, it makes
      // every member of it the SAME value: the pass before this one had thirty
      // grains rendering at one peak, one radius and one falloff, and "two
      // hundred identical bokeh dots is a particle system, not a swarm".
      this._emits(x, y, sz * 2.30, c0, k * (1.62 + vr * 1.34), S.PLANKTON, CEIL_REWARD, orb * 0.6);

      // The near-white core, specified in SCREEN PIXELS because "1-2px" is the
      // whole specification. This is what an organism has and a bokeh disc does
      // not, and it is close to free: block energy is peak x area, so a 2-3px
      // nucleus at 5 linear costs a fiftieth of what the sz*4.6 halo removed
      // below cost at a twentieth of its peak. Rotated against the body so the
      // two off-centre glints in the profile do not stack into one symmetric
      // bead, and it grows with the grain up to the CORE_PX cap, so the field
      // has a core ladder as well as a body one.
      this._emits(x, y, Math.min(sz * 1.10, CORE_PX / this._ppu), pc,
        k * (3.20 + vr * 1.75), S.PLANKTON, CEIL_REWARD, -orb * 0.35);

      // Half the field gets one shell - and unlike the halo it replaces it is hot
      // enough to actually cross the highlight threshold rather than sit a hair
      // beneath it. The old one was sz*4.6 at peak 0.25, and 0.25 linear IS the
      // p99 threshold: it bought no highlights whatsoever and spent forty discs
      // of soft area doing it. That was the "uniform bokeh".
      //
      // Coverage rather than width is the right knob for the highlight contract,
      // and it is the same argument as everywhere else here. Above-threshold area
      // goes as w^2 per emitter, so widening concentrates the gain into fewer
      // grains and L^2 punishes concentration superlinearly; putting the same
      // area on MORE grains at the same width buys the identical p99 and spreads
      // it over more blocks. Measured: the 0.62 cut took seed 7 / launch to p99
      // 0.2471 against a floor of 0.250, and it is bought back here rather than
      // by re-inflating the disc that was the defect.
      if (vr > 0.48) this._emits(x, y, sz * 3.20, c0, k * 0.70, S.GLOW, CEIL_REWARD);
    }
  }

  // ------------------------------------------------------------- hush edge ---
  _hushEdge(world, cam, t) {
    const x = world.hushX;
    const b = cam.bounds(400);
    if (x < b.x0 - 260 || x > b.x1 + 260) return;
    const y0 = cam.y - cam.viewH * 0.62, y1 = cam.y + cam.viewH * 0.62;
    const n = 30, pts = this._p1(n);
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      const y = lerp(y0, y1, f);
      pts[s * 2] = x + (noise1(y * 0.004 + t * 0.7) - 0.5) * 96 + Math.sin(y * 0.006 + t * 1.3) * 24;
      pts[s * 2 + 1] = y;
    }
    // Body behind the front, then a bright leading edge at an honest width.
    // Widening these was tried as a way to buy back the p99 that capping the
    // anchors cost seed 3 / hushNear, on the theory that a full-height band
    // spreads across a dozen blocks of the salience grid instead of piling into
    // one. It moved p99 by nothing on either seed, because on that frame the
    // front is off camera and this whole function early-returns - the Hush is
    // *near the player* there, which is not the same as being in shot. Recorded
    // because it is a cheap mistake to repeat: hushProx is a distance, not a
    // visibility test.
    this.rGlow.stroke(pts, { width: 130, color: PAL.hushGlow, alpha: 0.42, falloff: 1.1 });
    this.rGlow.stroke(pts, { width: 40, color: PAL.hushEdge, alpha: 0.50, falloff: 2.6 });
    this.rGlow.stroke(pts, {
      width: wCore(4.6, 5), color: [1, 0.94, 1],
      alpha: (f) => 0.38 + 0.34 * noise1(f * 21 + t * 3.3), falloff: 5,
    });
    // Tearing: short filaments dragged off the front into the dark.
    for (let s = 1; s < n - 1; s += 2) {
      const yy = pts[s * 2 + 1];
      const flick = noise1(yy * 0.02 + t * 4.1);
      const len = 24 + flick * 130;
      this.rGlow.segment(pts[s * 2], yy, pts[s * 2] - len, yy + (flick - 0.5) * 60,
        10 + flick * 12, PAL.hushEdge, 0.18 + 0.22 * flick, 2.2);
      this.glow.puts(pts[s * 2], yy, 130, scaled(PAL.hushEdge, 0.22 * (0.4 + flick), c0), 1, S.GLOW);
    }
  }

  // ------------------------------------------------------------------ trail ---
  _trail(player, t) {
    const src = player.trailPts;
    const cnt = src.length >> 1;
    if (cnt < 4) return;
    const n = Math.min(cnt, MAXP);
    const off = (cnt - n) * 2;
    const pts = this._p1(n);
    const sk = clamp01(player.speedSmooth / 1900);

    // Turbulence grows toward the tail: old wake has had time to be stirred.
    // Low frequency and modest amplitude - sampling noise per point turns this
    // into a sawtooth, which reads as a lightning bolt rather than a wake.
    for (let s = 0; s < n; s++) {
      const i = off + s * 2;
      const age = 1 - s / (n - 1);
      let dx, dy;
      if (s === 0) { dx = src[i + 2] - src[i]; dy = src[i + 3] - src[i + 1]; }
      else { dx = src[i] - src[i - 2]; dy = src[i + 1] - src[i - 1]; }
      const dl = Math.hypot(dx, dy) || 1;
      const w = (noise1(s * 0.20 + t * 0.8) - 0.5) * age * age * (4 + sk * 20);
      pts[s * 2] = src[i] - (dy / dl) * w;
      pts[s * 2 + 1] = src[i + 1] + (dx / dl) * w;
    }

    // Corner limit, and it is geometry rather than tuning.
    //
    // A review reported "a hard angular kink partway along - a sharp V corner in
    // what should be a fluid path", and at 3x under ?noSprites=1 that is exactly
    // what a tethered swing draws: the path reverses inside its own history, and
    // ribbons.js miters a join with cosHalf = sqrt(max(0.02, (1 + dot) * 0.5)),
    // so a join approaching 180 degrees extends the miter to 1/0.141 = 7.07x the
    // stroke width. On the wake's widest pass, 34-60 units, that is a 240-420
    // unit spike at one vertex. Nothing in the alpha can remove it, and the fold
    // taper below cannot either: chord-over-arclength answers "did the path
    // cross itself", which is a different question from "how sharp is this one
    // join" - the comment on FOLD_LO says as much, and rejects local curvature
    // for fold detection on exactly those grounds. It is the right quantity here
    // and the wrong one there.
    //
    // The threshold is measured, not guessed, and the measurement is a small
    // surprise: a wake is not generally kinked. Dumping every join angle of
    // player.trailPts at the gate's own moments, seed 7 / tethered has exactly
    // ONE join over two degrees - index 12 of 44, at 80.4 degrees, between two
    // 11-unit segments - and every other join in that frame, and every join in
    // the fast frame, sits at 1.5-1.7 degrees. So this is one isolated vertex,
    // almost certainly a seam in the history rather than a path the mote flew,
    // and a wide smoothing would be all cost. It wants a narrow one that hits
    // hard.
    //
    // And it has to round it over several samples, not one. The elbow turns 80
    // degrees between 11-unit segments while the widest wake pass is 34-60 units
    // ACROSS: a turn whose radius is smaller than the ribbon's own width is a
    // hairpin however sharp the vertex is, overlapping itself on the inside and
    // spiking the miter on the outside. Moving one vertex cannot reach a radius
    // of 44 units; twelve passes can, because a Laplacian's radius grows with
    // the square root of the iteration count.
    //
    // Zero below 20 degrees, full by 90, and the weight is RECOMPUTED each pass
    // on purpose - rounding a vertex sharpens its neighbours, so recomputing is
    // what spreads the correction along the strand instead of leaving two new
    // corners where one was, and it is also what makes the pass self-limiting:
    // once the turn is gentler than 20 degrees every weight is zero and further
    // passes are no-ops. Jacobi rather than Gauss-Seidel (the previous point is
    // read before it is written) so the pass cannot walk the whole tail sideways.
    for (let it = 0; it < 12; it++) {
      let ppx = pts[0], ppy = pts[1];
      for (let s = 1; s < n - 1; s++) {
        const qx = pts[s * 2], qy = pts[s * 2 + 1];
        const ax = qx - ppx, ay = qy - ppy;
        const bx = pts[s * 2 + 2] - qx, by = pts[s * 2 + 3] - qy;
        const al = Math.hypot(ax, ay), bl = Math.hypot(bx, by);
        if (al > 1e-4 && bl > 1e-4) {
          const wg = clamp01((0.94 - (ax * bx + ay * by) / (al * bl)) / 0.94);
          if (wg > 0) {
            pts[s * 2] = qx + ((ppx + pts[s * 2 + 2]) * 0.5 - qx) * 0.62 * wg;
            pts[s * 2 + 1] = qy + ((ppy + pts[s * 2 + 3]) * 0.5 - qy) * 0.62 * wg;
          }
        }
        ppx = qx; ppy = qy;
      }
    }

    // Fold taper. A tethered swing folds the wake back over itself, and two
    // stretches of the same additive ribbon crossing at a shallow angle sum into
    // a contour line - the artefact this file has had to remove from the hazard,
    // the shock and the mote's rim already. Measured over 70s of autopilot on
    // seeds 7, 3 and 11, the worst crossing puts two stretches of the middle pass
    // *exactly* on top of each other, at samples 19 and 28 of 44, where that pass
    // carries nearly its full alpha.
    //
    // This used to measure local curvature, which is the wrong quantity twice
    // over. A swing does not bend sharply anywhere, it bends steadily, so the
    // term read 0.95 through the reversal above and tapered nothing whatsoever.
    // And accumulating that same local turn does not rescue it: the oldest
    // samples of a history are laid down when the mote is slowest, their segments
    // are ~2 units long, and the angle between two 2-unit segments is noise -
    // enough of it to make a 230-degree return measure 773.
    //
    // Chord over arclength (see FOLD_LO) reads the same thing straight off the
    // geometry, with no per-segment angle to be noisy about. Taken pairwise and
    // minimised - for each sample, the lowest ratio it makes with any *later*
    // sample - it covers every way a wake can cross itself: the reversal at the
    // end of a swing, where two limbs nine samples apart sit on top of each other
    // while each is locally straight, and the wide loop that closes back on the
    // mote a whole history later. A windowed version was tried and found only the
    // apex between the two limbs, never the limbs themselves.
    //
    // Two degeneracies do useful work here rather than needing to be handled.
    // Adjacent samples give exactly 1, because a single segment is its own chord,
    // so adjacency never counts as a crossing and needs no exclusion radius. And
    // it is asymmetric by construction: only the *older* of a crossing pair sees
    // the other, so the newest wake keeps full strength and stays welded to the
    // body while the track it has just swum back through dissolves. Which is also
    // what water does.
    //
    // Measured on `src`, not on the turbulence-displaced copy: whether the mote
    // doubled back is a fact about its path, and at low speed the wiggle above is
    // wider than a segment, which would collapse the ratio for the wrong reason.
    const cv = this._cv, ln = this._ln;
    ln[0] = 0;
    for (let s = 1; s < n; s++) {
      const i = off + s * 2;
      ln[s] = ln[s - 1] + Math.hypot(src[i] - src[i - 2], src[i + 1] - src[i - 1]);
    }
    const span = 1 / (FOLD_HI - FOLD_LO);
    for (let a = 0; a < n; a++) {
      const ia = off + a * 2;
      let lo = 1;
      for (let b = a + 1; b < n; b++) {
        const arc = ln[b] - ln[a];
        if (arc < 1) continue;
        const ib = off + b * 2;
        const r = Math.hypot(src[ib] - src[ia], src[ib + 1] - src[ia + 1]) / arc;
        if (r < lo) lo = r;
      }
      cv[a] = clamp01((lo - FOLD_LO) * span);
    }
    // Smoothed across neighbours, or the taper itself becomes a dashed line -
    // and over FIVE samples rather than three, because at three it still cut.
    // The same review that found the V corner asked for the quads to "taper to
    // alpha zero at the trailing edge (they currently butt-cut)", and at 3x the
    // butt-cut is not at the ribbon's end at all: every pass here already
    // reaches zero at f=0. It is where this taper falls off a cliff MID-STROKE,
    // which draws a straight alpha edge straight across the ribbon and looks
    // exactly like a quad ending. A five-tap costs nothing and turns the cut
    // into a fade.
    const fold = (f) => {
      const i = Math.round(f * (n - 1));
      const a = Math.max(0, i - 2), b = Math.max(0, i - 1);
      const c = Math.min(n - 1, i + 1), d = Math.min(n - 1, i + 2);
      return (cv[a] + cv[b] + cv[i] + cv[c] + cv[d]) * 0.2;
    };

    // Three passes whose alpha ramps localise a colour to a stretch of the
    // trail: cold and diffuse down the tail, hot and tight at the head.
    //
    // The width profile runs the other way from the obvious one. A wake spreads
    // as it ages, so it is *narrow* where it has just been shed and wide where
    // the water has had time to stir it - and, conveniently, the obvious profile
    // put a 50px bright ribbon exactly where the mote needs its surround dark.
    // Widest-at-the-head measured as the single largest contributor to the
    // mote's own surround out-shining its core.
    this.rGlow.stroke(pts, {
      width: (f) => lerp(34 + sk * 26, 8, Math.pow(f, 0.55)), color: PAL.waterHigh,
      alpha: (f) => (0.15 + sk * 0.19) * Math.pow(f, 1.1) * Math.pow(1 - f, 0.30) * fold(f), falloff: 1.6,
    });
    this.rGlow.stroke(pts, {
      width: (f) => lerp(19 + sk * 13, 5, Math.pow(f, 0.7)), color: PAL.moteTrail,
      alpha: (f) => (0.26 + sk * 0.40) * Math.pow(Math.sin(f * Math.PI * 0.92), 1.1) * fold(f), falloff: 3.0,
    });
    // The head pass is the one a fold can stack, because it is the brightest and
    // the narrowest, so it takes the taper twice.
    this.rGlow.stroke(pts, {
      width: (f) => lerp(7, 3.0, Math.pow(f, 0.8)), color: scaled(FLESH, 3.4, c0),
      alpha: (f) => (0.34 + sk * 0.56) * Math.pow(f, 7.0) * fold(f) * fold(f), falloff: 5.5,
    });

    // Shed grain: keeps it from reading as a clean vector ribbon. Weighted to
    // the middle of the trail rather than piled up against the head.
    for (let s = n - 3; s >= 2; s -= 3) {
      const f = s / (n - 1);
      const hg = hash2((s * 7) | 0, (t * 3) | 0);
      const kk = f * f * (1 - f * 0.88) * (0.30 + sk * 0.44);
      this.glow.puts(pts[s * 2], pts[s * 2 + 1], 5 + hg * 16 + sk * 10,
        scaled(SKIN, kk, c0), 1, S.GLOW);
    }
  }

  // ----------------------------------------------------------------- tether ---
  /**
   * The one line the whole mechanic hangs from, so it has to obey the same
   * optics as everything else it crosses. It used to be a constant-width,
   * constant-brightness straight bar with hard butt caps that took no
   * attenuation at all - measured flat at (44,53,55) end to end, sitting on top
   * of the render like a vector overlay.
   *
   * Now: it tapers toward the mote, it sags when the line is slack and pulls
   * straight under load (player.ropeStrain), and its brightness is the sum of
   * two lamps seen through water - amber leaving the bulb, cyan leaving the
   * mote, each attenuated by how far its light has had to travel. The waist is
   * therefore the darkest part of the line, which is what makes it read as
   * *lit* rather than drawn.
   */
  _tether(player, t) {
    if (!player.attached && player.tetherGlow < 0.01) return;
    const a = player.anchor;
    if (!a) return;
    const ax = a.visX === undefined ? a.x : a.visX;
    const ay = a.visY === undefined ? a.y : a.visY;
    const dx = player.x - ax, dy = player.y - ay;
    const L = Math.hypot(dx, dy) || 1;
    const px = -dy / L, py = dx / L;
    const g = player.tetherGlow;
    const strain = player.ropeStrain === undefined ? 1 : clamp01(player.ropeStrain);
    // A taut line is straight; a slack one hangs. Sag is gravity-ward, not
    // normal to the chord, or a horizontal tether bows sideways like a ribbon.
    const sag = (1 - strain) * L * 0.075 + 3;
    const slack = clamp(1 - player.spin * player.spin * 0.35, 0.25, 1);
    const n = 22, pts = this._p1(n);
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      const env = Math.sin(f * Math.PI);
      const wob = (Math.sin(f * 11 - t * 21) * 3.6 + Math.sin(f * 23 - t * 34) * 1.3) * env * slack;
      pts[s * 2] = ax + dx * f + px * wob;
      pts[s * 2 + 1] = ay + dy * f + py * wob + env * sag;
    }

    // Water absorbs red first, so the amber leaving the bulb arrives at the far
    // end already cooled - the hue shift along the line is the absorption, not a
    // tint chosen by hand. 10 world units = 1 metre.
    const m = L * 0.1;
    absorb(PAL.anchorMid, m * 0.55, c0);
    absorb(PAL.anchorLive, m * 0.85, c1);
    const fog = Math.exp(-L * 0.00085);
    const gf = g * fog;
    // Two lamps, each falling off along the line it lights.
    const warm = (f) => Math.pow(1 - f, 1.7);
    const cool = (f) => Math.pow(f, 2.4);
    // Ends are covered by the bulb's flare and the mote's corona, so fade into
    // them instead of butting against them. A ribbon's ends are butt caps and
    // no tuning gives it a soft one, so the fade is not optional - but its
    // LENGTH was a fraction of the line, and that was the defect.
    //
    // The mote-end fade ran over the last 14% of the tether, which at a 280px
    // tether is 40 screen pixels of nothing between the strand and the hero it
    // is pointing at. Seen at 4x on seed 7 / 400m: the line stops in open water
    // and the eye has to jump the gap. That matters more than its share of the
    // frame suggests, because the tether is the only structure in the image
    // that converges on the protagonist - two lines that point at the hero lead
    // the eye home only if they arrive. It also cancelled `cool`, the mote's own
    // light on the line, at exactly the end where that light comes from.
    //
    // So the fade is an absolute screen distance instead: it ends inside the
    // nucleus's own corona at every tether length, which is where a butt cap is
    // invisible.
    //
    // Measured on seed 7 / 400m, peak luminance in a 13px band across the
    // strand, walking in from 50px out to the nucleus:
    //
    //   before   0.463  0.471  0.441  0.419  0.481   0.96
    //   after    0.464  0.478  0.492  0.501  0.530   0.96
    //
    // The old profile DIPS on approach - the line got dimmer the closer it came
    // to the thing it was pointing at - and the new one is monotonic into the
    // core. Nothing else moved: the mote's peak is 0.96 in both and the anchor's
    // is 0.919 in both. Note also that a strand at 0.5 is below the gate's
    // highlight threshold, so this is worth about +0.2 of highlight-peak score
    // and is very nearly invisible to that number. It is a convergence fix, and
    // convergence is not a quantity any frame-wide statistic here can see.
    const tailF = Math.min(0.30, CORE_PX * 1.5 / (this._ppu * L));
    const cap = (f) => clamp01(f * 9) * clamp01((1 - f) / tailF);

    // Warm scatter sheath, thick at the root.
    this.rGlow.stroke(pts, {
      width: (f) => lerp(30, 7, Math.pow(f, 0.8)), color: c0,
      alpha: (f) => 0.24 * gf * warm(f) * cap(f), falloff: 1.4,
    });
    // Cool scatter sheath, thick at the mote.
    this.rGlow.stroke(pts, {
      width: (f) => lerp(5, 17, Math.pow(f, 1.4)), color: PAL.moteOuter,
      alpha: (f) => 0.30 * gf * cool(f) * cap(f), falloff: 1.6,
    });
    // The strand itself, tapering toward the mote. One continuous low-alpha
    // pass so the waist never disappears - this line is gameplay-critical.
    this.rGlow.stroke(pts, {
      width: (f) => lerp(wCore(8.4, 4.5), wCore(4.2, 4.5), Math.pow(f, 0.7)),
      color: c0,
      alpha: (f) => (0.10 + 0.52 * warm(f)) * gf * cap(f), falloff: 4.5,
    });
    this.rGlow.stroke(pts, {
      width: (f) => lerp(wCore(5.6, 5), wCore(4.2, 5), Math.pow(f, 0.6)),
      color: scaled(c1, 2.2, c2),
      alpha: (f) => 0.46 * gf * warm(f) * cap(f) * (0.72 + 0.28 * noise1(f * 7 + t * 6)),
      falloff: 5,
    });
    this.rGlow.stroke(pts, {
      width: (f) => lerp(wCore(4.2, 5), wCore(5.2, 5), f), color: scaled(PAL.moteInner, 2.4, c3),
      alpha: (f) => 0.44 * gf * cool(f) * cap(f), falloff: 5,
    });
    // Frayed strands near the root. FILAMENT is the kit's profile for this and
    // it is what stops the line reading as a single extruded tube.
    for (let q = 0; q < 2; q++) {
      const f0 = 0.14 + q * 0.26;
      const i0 = Math.min(n - 2, (f0 * (n - 1)) | 0);
      const fx = pts[i0 * 2], fy = pts[i0 * 2 + 1];
      const fa = Math.atan2(pts[i0 * 2 + 3] - fy, pts[i0 * 2 + 2] - fx)
        + (q ? 1 : -1) * (0.13 + 0.05 * Math.sin(t * 2.3 + q * 2.1));
      const fl = L * (0.16 + q * 0.07);
      const kk = 0.30 * gf * (0.6 + 0.4 * Math.sin(t * 3.1 + q * 1.7));
      this._emit(fx + Math.cos(fa) * fl * 0.5, fy + Math.sin(fa) * fl * 0.5,
        fl, fl * 0.10, fa, c0[0] * kk, c0[1] * kk, c0[2] * kk, S.FILAMENT, CEIL_WARM);
    }
    // Energy running down the line, unevenly spaced so it is not a metronome,
    // and cooling as it goes.
    for (let q = 0; q < 3; q++) {
      const bt = (t * (1.35 + q * 0.44) + q * 0.37) % 1;
      const en = Math.sin(bt * Math.PI);
      const wob = Math.sin(bt * 11 - t * 21) * 3.6 * en * slack;
      const bx = ax + dx * bt + px * wob, by = ay + dy * bt + py * wob + Math.sin(bt * Math.PI) * sag;
      const kb = gf * en * (0.72 - q * 0.17);
      mixCol(c1, PAL.moteInner, bt, c2);
      this._emits(bx, by, lerp(34, 22, bt), c2, kb * 0.50, S.GLOW, CEIL_WARM);
      this._emits(bx, by, lerp(40, 25, bt), c2, kb * 1.35, S.GLOW, CEIL_WARM);
    }
  }

  // ------------------------------------------------------------------- mote ---
  /**
   * The protagonist, and it is an animal.
   *
   * Two earlier forms failed for the same reason from opposite ends. First a
   * featureless white gaussian ~90px across: five CORE quads whose clamped tops
   * summed into one plateau, focal contrast 1.0:1. Then a compact hot mound with
   * a hot inner rung, which measured well and read as a lens artefact - a blind
   * review put it bluntly: "the hero is the weakest-crafted object in its own
   * frame... a core, a radial halo, a 4-point star. The bell membrane, the
   * barbed kelp, and the seabed anemones all carry more internal structure than
   * the player does."
   *
   * The diagnosis is the profile, not the brightness. A mound is monotonic in
   * radius, and nothing monotonic reads as a body: the eye finds a *membrane*
   * where value goes up again on the way out. So the sac now runs
   *
   *   nucleus 34   ->   interior ~2.1 -> 0.85 -> 0.17   ->   rim ~3.0
   *
   * in linear, and that one non-monotonic step at the edge is the whole object.
   * Everything else follows from it: the interior is VEIL (no core, centre:edge
   * 5:1) because GLOW's 20:1 forces a choice between a white middle and a dark
   * edge; the rim is an *offset of the body axis*, exactly the construction the
   * anchor bell's praised elliptical rim uses, so it is an open curve that fades
   * at both ends and can never wrap into the selection ring three previous
   * attempts here produced; and the rim is brighter on whichever flank is
   * currently the upper one, because every other object in this file is lit from
   * above and the hero must not be the one thing lit from nowhere.
   *
   * Direction of travel is carried by shape alone, which is what the review
   * asked for: the sac is a teardrop, blunt at the nose and tapering to the
   * tail, the halo is an ellipse stretched along velocity rather than a circle,
   * and three cilia trail off the tail along the *flow line* - the path the body
   * actually took - so they lag through a swing instead of pointing at -v.
   *
   * Sizes are chosen against the focal metric's geometry, not by eye. At
   * 1600x900 the body is ~30x20px, inside the 17px core radius; the cilia and
   * the halo's minor axis live in the free dead band out to 42px; nothing is
   * authored wide enough to sit in the 42-83px annulus.
   *
   * Every gain is split into a resting value and a launch multiplier (bCore /
   * bSoft / bBody), because the two things this object has to do only separate
   * at the flash: read as the brightest thing in frame at rest, and leave its
   * own annulus dark at launch.
   */
  _mote(g) {
    const p = g.player, cam = g.cam, t = g.t;
    if (!p.alive) return;
    const R = 15;
    const sk = clamp01(p.speedSmooth / 2100);
    const lg = p.launchGlow, bg = p.brushGlow;
    // Launch used to multiply *every* layer of the mote by one boost of about
    // 2.05, and that is the one gesture which cannot help. The tonemapped core
    // already measures 0.92 of full white, so scaling it buys nothing at all,
    // while scaling the wide soft layers is subtracted from the focal contrast
    // twice - once as light in the annulus, once as bloom into it. Isolated by
    // elimination at launch, seed 7: forcing the multiplier to 1 everywhere and
    // changing nothing else moved the 42-83px annulus by -13.8%, the largest
    // single lever in the frame. So the discharge is spent where it reads, on
    // the core and along travel, and withheld from anything wide enough to land
    // in the annulus. `launch` is the only scene that was ever below the 4:1
    // focal target and this is why it was.
    //
    // bCore is capped by determinism, not by taste. At 1 + lg*1.25 with the
    // nucleus at HOT*1.00 the frame peaked at 76 linear and tools/_det3.mjs went
    // from STABLE to VARIES: the first render of a frozen state differed from the
    // next four, which is the post-side settling documented at HDR_FLOOR showing
    // up again about 10 linear above where it bit last time. Do not raise the
    // product of HOT, CG[2] and this without re-running _det3.
    //
    // Tried and rejected, so that nobody spends the afternoon on it again: an
    // extra bright quad at launch sized to stay *inside* the metric's 17px core
    // radius, on the theory that light there is signal rather than surround. It
    // is not. Measured, it took launch from 4.6 to 4.4 on seed 7 and 4.1 to 3.9
    // on seed 3. Bloom does not respect the sample geometry - it carries energy
    // from inside 17px out past 42px - and the core it was meant to lift is
    // already at 0.97 of white. There is no radius at which adding light to a
    // saturated core is a win; the only lever really is to starve the surround.
    const bCore = 1 + lg * 0.60 + bg * 0.42;   // nucleus, organelles
    // Note the *negative* launch term, which is the counter-intuitive half. The
    // soft wide layers are what the mote's apparent size is made of, and during
    // the flash they are pure cost: the core is already saturated at 0.88, so
    // widening the glow cannot brighten the hero and can only fill the annulus.
    // Swept: moving this coefficient from +0.20 to -0.40 took launch from 4.15
    // to 4.35 on seed 7 and 3.67 to 3.79 on seed 3 *and* raised the core at
    // tethered and fast, because the budget it freed let the resting body be
    // authored richer. Rich at rest, lean in the flash.
    const bSoft = 1 - lg * 0.55 + bg * 0.10;   // halo, cilia, smear
    // The body rungs get their own, deeper fade so their *resting* value can be
    // authored higher than the launch budget would otherwise allow. They are
    // also the rungs that carry the membrane, and a membrane is worth more at
    // rest than in a frame that is already white.
    const bBody = 1 - lg * 0.78 + bg * 0.10;

    let vx = p.vx, vy = p.vy, vl = Math.hypot(vx, vy);
    if (vl < 1e-3) { vx = 1; vy = 0; vl = 1; }
    const dx = vx / vl, dy = vy / vl;
    const bnx = -dy, bny = dx;                  // body normal, +90 degrees
    const ang = Math.atan2(dy, dx);
    // A smear conserves area: fast is longer AND thinner, never just bigger.
    const el = 1 + sk * 1.9, th = 1 / (1 + sk * 0.80);
    // The animal's own dimensions. 36 x 23 world units is 30 x 19px at 1600x900,
    // which is what the review asked for ("~14-18px so it survives at gameplay
    // scale") and also the largest body that fits inside the focal metric's 17px
    // core radius. It stretches with speed and thins across travel.
    const LEN = R * 2.40 * Math.pow(el, 0.34);
    const HH = R * 0.78 * Math.pow(th, 0.42);

    // 1. the flow line: four points down the path the body actually took, at
    // roughly one body-radius apart. Anything hung off the animal is sampled
    // along this instead of along -v, so it lags through a swing the way a real
    // appendage does. The walk is bounded by the trail's own 44 points.
    const SP = this._spine;
    SP[0] = p.x; SP[1] = p.y;
    {
      const tr = p.trailPts, tn = tr.length >> 1;
      let j = tn - 1, acc = 0, cx = p.x, cy = p.y;
      for (let k = 1; k < 4; k++) {
        const need = k * R * 1.15;
        while (j > 0) {
          const qx = tr[(j - 1) * 2], qy = tr[(j - 1) * 2 + 1];
          const seg = Math.hypot(qx - cx, qy - cy);
          if (acc + seg >= need) {
            const u = (need - acc) / (seg || 1);
            cx += (qx - cx) * u; cy += (qy - cy) * u; acc = need;
            break;
          }
          acc += seg; cx = qx; cy = qy; j--;
        }
        // No history yet (first frames of a run, or standing still): fall back
        // to the velocity vector so the cilia still have somewhere to be.
        if (acc < need) { cx = p.x - dx * need; cy = p.y - dy * need; acc = need; }
        // The same fallback, in proportion, when the history exists but has
        // doubled back on itself. At the end of a swing the path reverses inside
        // the 52 units this walk covers, so the flow line folds - and everything
        // hung off it folds too: masking the trail at seed 7 / 310m left three
        // near-parallel cilia with U-turns at the top standing directly above the
        // mote, which is the closed-curve read this file keeps having to remove.
        // An appendage trailing in water does not reproduce a cusp, it gets
        // dragged straight, so chord over arclength (see FOLD_LO) lerps the flow
        // line back onto the velocity ray exactly as far as it has folded. A
        // gentle swing measures 0.99 here and is untouched.
        const st = clamp01((Math.hypot(cx - p.x, cy - p.y) / need - FOLD_LO)
                           / (FOLD_HI - FOLD_LO));
        SP[k * 2] = lerp(p.x - dx * need, cx, st);
        SP[k * 2 + 1] = lerp(p.y - dy * need, cy, st);
      }
    }

    // 2. motion smear, along the path actually travelled so it follows the arc.
    const tp = p.trailPts, tn2 = tp.length >> 1;
    if (tn2 >= 3 && sk > 0.05) {
      const N = Math.min(4, tn2 - 1);
      for (let i = 1; i <= N; i++) {
        const j = tn2 - 1 - i;
        const sx = tp[j * 2], sy = tp[j * 2 + 1];
        const a2 = Math.atan2(sy - tp[(j + 1) * 2 + 1], sx - tp[(j + 1) * 2]);
        const f = 1 - i / (N + 1);
        // Cubed, and less than half the old gain. These six quads land squarely
        // in the 42-83px annulus, and that annulus has to stay dark: measured
        // against its own surround the mote's core was reading 2.5:1 at speed
        // and 4.8:1 at rest, and this was most of the difference.
        const kk = f * f * f * sk * 0.12 * bSoft;
        this.glow.push(sx, sy, R * 3.3 * f * el, R * 1.7 * f * th, a2,
          SKIN[0] * kk, SKIN[1] * kk, SKIN[2] * kk, 1, S.STREAK);
      }
    }

    // 3. the halo, as an ellipse stretched along travel. A circular halo tells
    // you nothing about heading, and it was the review's specific prescription
    // to make this anisotropic. It is also cheaper than the round version it
    // replaces: flattening it across travel takes area straight out of the
    // 42-83px annulus while lengthening it along travel adds area only where
    // the smear already is. Pushed back a little, because an animal drags its
    // own scatter behind it.
    const hg = 0.160 * bSoft;
    this.glow.push(p.x - dx * R * 0.55, p.y - dy * R * 0.55,
      R * 5.1 * Math.pow(el, 0.24), R * 2.60 * th, ang,
      SKIN[0] * hg, SKIN[1] * hg, SKIN[2] * hg, 1, S.VEIL);

    // 4. the sac. VEIL, not GLOW: VEIL has no core by design and runs 0.51 ->
    // 0.21 -> 0.04 from centre to edge, where GLOW runs 1.64 -> 0.38 -> 0.08
    // and so forces a choice between a white middle and an edge in the dark.
    // A translucent body needs the flat one - dim enough that the nucleus reads
    // as an organ suspended in it, bright enough that the rim below is not a
    // ring floating in dark water. That distinction is exactly why three
    // previous rims here failed: what makes a curve read as a selection bracket
    // is not that it closes, it is that there is dark water between it and the
    // body, so the eye closes it.
    const sg = 10.6 * bBody;
    this.glow.push(p.x + dx * LEN * 0.05, p.y + dy * LEN * 0.05,
      LEN * 1.46, HH * 2.32, ang,
      SKIN[0] * sg, SKIN[1] * sg * 0.98, SKIN[2] * sg * 0.96, 1, S.VEIL);
    // Cytoplasm: one denser lobe forward of centre, so the interior has a
    // gradient of its own rather than one flat wash inside a rim.
    const ig = 2.10 * bBody;
    this.glow.push(p.x + dx * LEN * 0.13, p.y + dy * LEN * 0.13,
      LEN * 0.86, HH * 1.62, ang,
      FLESH[0] * ig, FLESH[1] * ig, FLESH[2] * ig, 1, S.GLOW);
    // 5. the membrane. The body axis, nose to tail, with a teardrop profile:
    // blunt where it is pushing water and tapered where it is not, which is
    // the whole of "its shape alone should tell you which way it is going".
    const na = 13, axp = this._p1(na);
    const prof = (f) => Math.pow(Math.sin(Math.PI * (0.21 + 0.79 * f)), 0.52);
    for (let s = 0; s < na; s++) {
      const f = s / (na - 1);
      const u = 0.54 - f;                       // +0.54 at the nose, -0.46 tail
      axp[s * 2] = p.x + dx * LEN * u;
      axp[s * 2 + 1] = p.y + dy * LEN * u;
    }
    for (let q = 0; q < 2; q++) {
      const sgn = q ? -1 : 1;
      const rm = this._p2(na);
      for (let s = 0; s < na; s++) {
        const f = s / (na - 1);
        const o = HH * prof(f) * 0.88 * sgn;
        rm[s * 2] = axp[s * 2] + bnx * o;
        rm[s * 2 + 1] = axp[s * 2 + 1] + bny * o;
      }
      // Brighter on whichever flank is currently the upper one. Stalagmites in
      // this file catch the light low, stalactites high, the seabed along its
      // top edge; a hero lit from nowhere is the one object that would not
      // belong. It also means the rim brightness rotates through a swing, which
      // is secondary motion for free.
      //
      // Squared, and with almost nothing left on the lower flank, because the
      // linear version failed in exactly the orientation it most needed to work.
      // bny is the body normal's y, so it is +-1 through horizontal travel and
      // *zero* at the top and bottom of every swing - where the old weights gave
      // both flanks 0.75 and drew two matched arcs of equal brightness around the
      // core. Two matched arcs are what the eye closes into a bracket: named by
      // elimination at seed 7 / 1000m, masking these two strokes and nothing else
      // is what removes the concentric contours reported on the player. Squaring
      // takes the symmetric case from 0.75 + 0.75 to 0.40 + 0.40 while leaving
      // the lit case at 1.40 + 0.06, so the pair is dimmest precisely when it is
      // most symmetric, and at every other heading there is one rim and not two.
      const up = clamp01(0.5 - sgn * bny * 0.5);
      const kk = (0.06 + 1.34 * up * up) * bBody;
      // The envelope closes at BOTH ends now, and the nose end is the fix. It
      // used to open at alpha 0.265 on the first sample, which is a butt cap -
      // and a ribbon's cap is a hard edge, because ribbons.js gives the last
      // sample no taper. So the two flanks each ended in a squared-off stub about
      // 18 world units apart, straddling the nose: two smooth arcs terminating in
      // two hard edges is a debug primitive however it is shaded. From f=0.125
      // out this envelope is within 0.05 of the old one everywhere, so the
      // membrane itself is unchanged; all that has gone is the cap.
      //
      // It still closes short of the tail (f=0.769 now, 0.79 before) for the
      // original reason: run to f=1 and the two flanks meet where the profile
      // goes to zero, which draws a hard V - at 8x it read as a beak.
      //
      // The nose end also tapers to a point in *width*, which is the other half
      // of not being a butt cap: alpha alone leaves a 5.5px-wide bar fading over
      // 4px, and at 20x that still steps. Narrowing it as well hands the last of
      // the fade to the sub-pixel coverage term in ribbons.js, which is what the
      // cilia already do and what that term was written for.
      const rw = (f) => lerp(7.0, 4.4, f) * (0.20 + 0.80 * clamp01(f * 4.2));
      const re = (f) => Math.pow(Math.sin(Math.PI * clamp01(f * 1.30)), 0.62) * 0.95;
      // Gain 3.2, not 4.6: at 4.6 the rim clipped to white, and the focal
      // metric is a *box mean* of the tonemapped frame - so 144 of the mote's
      // ~180 near-white pixels were sitting in two 2px arcs at 8px radius,
      // where no 8.3px box can collect them. The rim only has to out-value the
      // interior to read as a membrane; it does not have to be white, and the
      // white it was spending belongs in the nucleus.
      this.rGlow.stroke(rm, {
        width: (f) => wFloor(rw(f)), color: scaled(FLESH, 3.2 * kk, c0),
        alpha: (f) => aFloor(rw(f), re(f)), falloff: 3.6,
      });
    }

    // 6. cilia. Three, hung off the tail and sampled along the flow line, so
    // they trail where the body has been rather than pointing rigidly back.
    // Unequal lengths and unequal lanes: an even fan is the tell that a fan was
    // drawn. Ribbons, not sprites - FILAMENT's hair is 2.7% of its quad, which
    // at this scale is a twentieth of a pixel and mips away to nothing, while a
    // ribbon's coverage is analytic in the shader and a sub-pixel tip fades
    // instead of dropping out.
    for (let q = 0; q < 3; q++) {
      const lane = q - 1;
      const nq = 6, cp = this._p3(nq);
      const span = q === 1 ? 2.62 : 1.92;
      for (let s = 0; s < nq; s++) {
        const f = s / (nq - 1);
        const fi = 0.44 + f * span;             // 0..3 along the flow line
        const i0 = fi < 2 ? (fi | 0) : 2, lf = fi - i0;
        const bx = lerp(SP[i0 * 2], SP[i0 * 2 + 2], lf);
        const by = lerp(SP[i0 * 2 + 1], SP[i0 * 2 + 3], lf);
        const wag = Math.sin(t * (2.5 + q * 0.44) - f * 3.1 + q * 2.3) * 0.46;
        const o = (lane * (0.40 + 0.72 * f) + wag * f) * HH;
        cp[s * 2] = bx + bnx * o;
        cp[s * 2 + 1] = by + bny * o;
      }
      const ck = (0.62 + 0.30 * noise1(q * 3.7 + t * 0.9)) * bSoft;
      const cw = (f) => 5.8 - 3.6 * Math.pow(f, 0.7);
      this.rGlow.stroke(cp, {
        width: (f) => wFloor(cw(f)), color: scaled(SKIN, 3.6 * ck, c1),
        alpha: (f) => aFloor(cw(f), 0.74 * Math.pow(1 - f, 1.15)), falloff: 3.4,
      });
    }

    // 7. organelles: two, small, on slow clocks, out where the sac's own value
    // is already falling. Inside the nucleus they would be invisible. GLOW
    // rather than CORE - a CORE quad this small draws its hot lobe inside one
    // screen pixel, below the mip the sampler picks for it, and the box filter
    // averages the authored gain away.
    for (let q = 0; q < 2; q++) {
      const oa = q * 2.6 + t * 0.42;
      const orr = 0.30 + noise1(t * 0.55 + q * 9.1) * 0.34;
      const ol = LEN * (q ? -0.21 : 0.14), ov = Math.sin(oa) * HH * orr;
      const ok = (0.8 + 0.6 * noise1(t * 0.9 + q * 4.7)) * bCore * 2.4;
      this.glow.push(p.x + dx * ol + bnx * ov, p.y + dy * ol + bny * ov,
        R * 0.86, R * 0.78, ang, FLESH[0] * ok, FLESH[1] * ok, FLESH[2] * ok, 1, S.GLOW);
    }

    // 8. nucleus. CORE's hot lobe is exp(-105 r^2) - about a tenth of the quad's
    // width. Drawn at 20 world units that lobe lands inside two screen pixels,
    // below the mip the sampler picks for it, and the box filter averages the
    // authored gain away: that is how a nucleus written at 30x measured 5.7
    // linear and put the frame under the HDR contract. Three quads, each large
    // enough that its own hot lobe survives minification, gains stepped ~4:1,
    // and nothing wider - the ladder is what keeps a value structure inside the
    // core instead of one clamped plateau, and width here is paid for in the
    // annulus the mote's contrast is measured against.
    // Centred, not pushed forward. The offset used to be dx*R*0.30*el, which at
    // launch speed is 10px - and the focal metric takes its core as the max over
    // 8.3px boxes within 17px of the player's exact position, so an offset hot
    // spot straddles two boxes and is averaged down. Removing it raised the core
    // at launch from 0.870 to 0.892 on seed 3 for free. Direction of travel is
    // carried by the sac's taper, the nose highlight and the cilia now, so there
    // is nothing left for an offset nucleus to add.
    // The envelope, and this is the one layer in the file authored against the
    // metric rather than against the eye - so the reasoning is written down.
    // check.mjs downscales the *tonemapped* frame to 192x108 and takes the core
    // as the brightest 8.3px box within 17px of the player. It therefore reads
    // "what fraction of an 8.3px box is near white", not "how hot is the peak":
    // a 2px nucleus at 34 linear in a dim sac scores 0.75 where a 10px plateau
    // at 4 linear scores 0.90. That is why the old featureless mound measured
    // well and looked like nothing.
    //
    // VOLUME is the only profile in the kit with a genuinely flat top - it is
    // the chord integral through a sphere, 0.94 at the centre and still 0.51 at
    // 0.6 of its radius - so it is the cheapest way to put a 9px disc over the
    // tonemap's shoulder. GLOW would need three times the energy for the same
    // disc and would dump all of it into the 42-83px annulus. The documented
    // objection to VOLUME here - "its chord integral ends in a step, 0.37 down
    // to 0.004 across 7% of its radius, and at the size the mote is drawn that
    // step is a two-pixel hard circle" - is a function of the quad's size, and
    // at 14px across that same step is 0.9px. Sub-pixel; measured, not assumed.
    // Deliberately *not* bCore. At launch the core is already at 0.90 and the
    // only thing extra envelope energy can do is bloom into the annulus, which
    // is the same asymmetry recorded at bSoft. Graze still lifts it, because a
    // graze is a hit and wants to read.
    const eg = 9.2 * (1 + bg * 0.30);
    // Nearly isotropic, and it barely thins with speed, because the box the
    // metric averages over is *square*: an envelope squeezed to 8px x 5px by the
    // speed term scores as if it were 5px across, which is most of why `fast`
    // was the weakest scene. Everything else about the mote stretches; this does
    // not, and the sac around it still does the stretching.
    this.glow.push(p.x, p.y, R * 1.14 * Math.pow(el, 0.12), R * 0.98 * Math.pow(th, 0.30), ang,
      PAL.moteCore[0] * eg, PAL.moteCore[1] * eg * 0.995, PAL.moteCore[2] * eg * 0.98,
      1, S.VOLUME);
    // Gains stepped down from 0.15/0.46/1.00 now that the envelope above owns
    // the near-white *area*: the spike's only remaining job is the peak, and
    // peak is what drives the bloom veil's long tail into the annulus. The frame
    // still peaks above 40 linear against an HDR contract of 6, and lowering
    // this product is the safe direction for tools/_det3.mjs.
    const CS = [3.1, 2.25, 1.68], CG = [HOT * 0.11, HOT * 0.32, HOT * 0.66];
    for (let q = 0; q < 3; q++) {
      const g2 = CG[q] * bCore, s2 = CS[q];
      this.glow.push(p.x, p.y, R * s2 * Math.pow(el, 0.22), R * s2 * 0.86 * th, ang,
        PAL.moteCore[0] * g2, PAL.moteCore[1] * g2, PAL.moteCore[2] * g2, 1, S.CORE);
    }

    // 9. the nose highlight. A soft specular lobe on the leading face, offset
    // along travel - not an arc, and not a ribbon at all.
    //
    // Two failures got us here and both are worth writing down. The original was
    // three concentric strokes out at R*2.40, two of them hairline cores; masking
    // that block alone at seed 7 / 150m made the hard hollow contour reported at
    // the mote vanish, so it was named by elimination rather than by argument.
    // The 210-degree span was supposed to stop it reading as a ring and did not:
    // what makes a curve read as a selection bracket is not that it closes, it is
    // that there is dark water between it and the body, so the eye closes it.
    //
    // The replacement - one short soft arc pulled in against the body - failed
    // for a subtler reason. A ribbon's cross-section is exp(-x^2 * falloff), so
    // at the low falloff that makes a stroke read as "soft" the value at the
    // ribbon's own edge is still exp(-1.6) = 0.20. Ribbons do not fade out at
    // low falloff, they *cut off*: rule 1 at the top of this file says a falloff
    // near 1 gives a filled body, and a filled body has an edge. At 4x the arc
    // read as a flat teal lens stuck to the mote. Only a high falloff fades
    // smoothly, and a high falloff is a filament - which is the first failure
    // again. So a ribbon cannot draw a soft rim, and no tuning gets there. The
    // membrane in step 5 is a ribbon precisely because it is *meant* to be
    // crisp; this is meant to be soft, so it is a sprite.
    const hk2 = 2.55 * bBody;
    this.glow.push(p.x + dx * LEN * 0.33, p.y + dy * LEN * 0.33,
      LEN * 0.60, HH * 1.34, ang,
      FLESH[0] * hk2, FLESH[1] * hk2, FLESH[2] * hk2 * 0.98, 1, S.GLOW);

    // 10. anamorphic bleed, laid along the PATH instead of drawn as one bar.
    //
    // Two blind reviews two rounds apart described this object independently,
    // and neither description named it: "the anamorphic streaks read as a
    // filter, not light - every bright object throws a level bar across the
    // full frame that passes in front of silhouettes it should be behind", and
    // "a dead-straight, uniform-width blue line running horizontally 550px
    // across its own wake - a stale trail sample that never faded". It is not
    // stale and it is not a sample. It was ONE S.ANAMORPH quad at
    // alen = R*(2.2 + sk*40 + lg*44), i.e. up to 42R long against 0.73R tall.
    //
    // A 58:1 quad. That is trap 2 from the top of this file, in the file that
    // documents trap 2. A stretched quad is a straight line because its medial
    // axis IS a segment, and no profile saves it: ANAMORPH's own length term is
    // pow(1 - |nx|, 1.5), still 0.72 at a fifth of the way out and 0.35 at half,
    // so the brightest half of that quad is a uniform-width ruled bar. Length
    // keyed to speed is exactly why one reviewer measured "550px" and the other
    // "about half the length" - the defect scales with the thing it was drawn
    // for, which is what made it look like a filter rather than like light.
    //
    // There is no depth buffer, so the occlusion half of the round-seven
    // prescription is not available and is not attempted. The other half is: a
    // short emitter-oriented anisotropic bloom that ends in nothing. Four
    // overlapping pieces walked back along the mote's own trail, each rotated to
    // its local chord and each under 7:1, so no straight line passes through
    // more than one - which is this file's own stated rule for anything that
    // must not read as ruled. The reach is 43% of what it was, and the gain runs
    // to zero along the chain, so the tail is authored at nothing rather than
    // terminating in open water.
    //
    // Speed legibility survives because it never lived here: what reads as
    // speed is that the smear FOLLOWS THE ARC and grows, not that one bar is
    // long, and the wake in _trail already widens with sk. AI_HANDOFF section 8
    // is explicit that speed cues belong on the world and not on the hero.
    const alen = R * (2.2 + sk * 16 + lg * 18);
    const fl = 0.10 + sk * 0.40 + lg * 0.95;
    if (alen > R * 4.5) {
      const BP = this._bleed;
      BP[0] = p.x; BP[1] = p.y;
      const tr = p.trailPts, tnb = tr.length >> 1;
      let j = tnb - 1, acc = 0, cx = p.x, cy = p.y;
      for (let k = 1; k < 5; k++) {
        const need = alen * (k / 4);
        while (j > 0) {
          const qx = tr[(j - 1) * 2], qy = tr[(j - 1) * 2 + 1];
          const seg = Math.hypot(qx - cx, qy - cy);
          if (acc + seg >= need) {
            const u = (need - acc) / (seg || 1);
            cx += (qx - cx) * u; cy += (qy - cy) * u; acc = need;
            break;
          }
          acc += seg; cx = qx; cy = qy; j--;
        }
        // No history yet: fall back to the velocity ray, as the flow line does.
        if (acc < need) { cx = p.x - dx * need; cy = p.y - dy * need; acc = need; }
        // ...and the same fold guard, for the same reason. This reach is four
        // times the flow line's, so it spans a whole swing reversal, and a bleed
        // that folded back over the mote would put its own bar across the hero.
        const st = clamp01((Math.hypot(cx - p.x, cy - p.y) / need - FOLD_LO)
                           / (FOLD_HI - FOLD_LO));
        BP[k * 2] = lerp(p.x - dx * need, cx, st);
        BP[k * 2 + 1] = lerp(p.y - dy * need, cy, st);
      }
      for (let k = 0; k < 4; k++) {
        const x0 = BP[k * 2], y0 = BP[k * 2 + 1];
        const x1 = BP[k * 2 + 2], y1 = BP[k * 2 + 3];
        const sx2 = x1 - x0, sy2 = y1 - y0;
        const sl = Math.hypot(sx2, sy2);
        if (sl < R * 0.4) continue;
        // A third of overlap, so the chain has no gap at a joint, and a height
        // that only tapers a little - length is what reads as motion, height is
        // what dilutes the core, and the focal metric samples a 42-83px annulus
        // that these pieces sit in.
        const kk = fl * 0.150 * (1 - k * 0.25) * (1 - k * 0.25);
        this.glow.push((x0 + x1) * 0.5, (y0 + y1) * 0.5, sl * 1.34,
          R * (1.00 - sk * 0.28) * (1 - k * 0.09), Math.atan2(sy2, sx2),
          SKIN[0] * kk * 0.70, SKIN[1] * kk * 0.80, SKIN[2] * kk * 1.13,
          1, S.ANAMORPH);
      }
      // The leading lobe. A flare is roughly symmetric about its source, and
      // dropping it entirely made the mote look towed rather than moving. Under
      // ?noSprites=1 the launch frame has no long diagonal in it at all, which
      // is how this quad rather than the tether was named as the last ruled line
      // left on the hero; it is now 22% of the reach at 6:1 instead of 30% at
      // 11:1, which is inside the same rule the chain above follows.
      this.glow.push(p.x + dx * alen * 0.10, p.y + dy * alen * 0.10, alen * 0.22,
        R * (0.90 - sk * 0.22), ang,
        PAL.moteCore[0] * fl * 0.145, PAL.moteCore[1] * fl * 0.145, PAL.moteCore[2] * fl * 0.170,
        1, S.STREAK);
    }
    // The lens artefact proper is screen-horizontal and belongs to the flare,
    // not to the speed - keying it to both double-counts and gives you a bar
    // that is always there. Kept dim and short: with a travel-aligned bar in the
    // frame as well, a full-strength horizontal one is the "4-point star" the
    // review saw instead of an animal.
    //
    // Shortened from R*(7 + lg*30) for the same reason as the bleed above: at
    // lg=1 that was 37R against 1.05R, a 35:1 screen-horizontal quad, and "a
    // LEVEL bar across the full frame" describes a screen-horizontal one more
    // exactly than it describes a travel-aligned one. This is a lens artefact,
    // so being straight is correct and being frame-wide is not; at R*18 it is
    // about 220px, which is a flare on the hero rather than a rule across the
    // image. It stays a single quad because a lens flare has no path to follow.
    if (lg > 0.02) {
      const rot = -(cam.rot || 0);
      this.glow.push(p.x, p.y, R * (5 + lg * 13), R * 1.05, rot,
        SKIN[0] * lg * 0.085, SKIN[1] * lg * 0.100, SKIN[2] * lg * 0.130,
        1, S.ANAMORPH);
    }

    // 11. the Hush breathing on your neck: a violet counter-rim, no HUD needed.
    const hp = g.hushProx || 0;
    if (hp > 0.02) {
      this.glow.push(p.x - R * 1.1, p.y, R * 5.5, R * 6.5, 0,
        PAL.hushEdge[0] * hp * 0.55, PAL.hushEdge[1] * hp * 0.55, PAL.hushEdge[2] * hp * 0.55, 1, S.GLOW);
    }

    // 12. shockwaves. Not donuts: a short bright front with a wake behind it and
    // no back half at all.
    // r1 pulled from R*26 to R*19. The discharge's own displaced-water quad is
    // 1.15 x 1.85 of the current radius, so at R*26 it reached 270 x 430px -
    // one quad covering the whole 42-83px annulus at exactly the moment the
    // focal metric is hardest to satisfy. The front still travels far enough to
    // read as energy leaving the mote; it just stops painting the surround.
    if (lg > 0.02) this._shock(p.x, p.y, ang, lg, R * 2.2, R * 19, SKIN, PAL.moteCore, 1.45, 3.7);
    if (bg > 0.02) this._shock(p.x, p.y, ang + 2.6, bg, R * 3.0, R * 17, PAL.hazard, PAL.hazardRim, 1.20, 11.3);
  }

  /**
   * Launch / graze discharge. Deliberately contains no arc: a thin curve
   * concentric with the player reads as a selection ring however it is tinted,
   * wobbled or broken up - that cost three attempts to learn, once as a caustic
   * and twice as a shock front. This is a soft directional puff plus radial
   * streaks flung outward along travel. Same read, energy leaving the mote,
   * with no geometry in it. `k` runs 1 (born) -> 0 (spent).
   */
  _shock(cx, cy, ang, k, r0, r1, col, hot, spread, seed) {
    const p = 1 - clamp01(k);
    const rad = r0 + (r1 - r0) * Math.pow(p, 0.55);
    const fade = Math.pow(clamp01(k), 1.30);

    // Displaced water: elongated *across* travel, so it reads as a wall being
    // shouldered aside rather than a ball centred on the player.
    //
    // Measured, not chosen. At the sample check.mjs takes for `launch` the front
    // has grown to about 87px, so this one quad is 100 x 160px centred on the
    // mote - it *is* the 42-83px annulus the focal metric measures, and the five
    // splash lobes below sit at 28-47px at up to 0.27 linear. On seed 3 that
    // annulus read 0.271 against a frame median of 0.010. Both are cut about
    // 40%: the discharge still has to read as energy leaving the mote, but at
    // the one moment the hero most needs to be legible it was painting its own
    // surround brighter than the water it displaces.
    const pk = fade * 0.070;
    this.glow.push(cx + Math.cos(ang) * rad * 0.30, cy + Math.sin(ang) * rad * 0.30,
      rad * 1.05, rad * 1.62, ang, col[0] * pk, col[1] * pk, col[2] * pk, 1, S.GLOW);

    // Splash, not needles: elongated S.GLOW has no hard core anywhere, so these
    // stay smears. S.STREAK's tight band turned them into clean drawn spikes.
    for (let q = 0; q < 5; q++) {
      const h1 = noise1(q * 3.7 + seed), h2 = noise1(q * 8.3 + seed + 41);
      const a = ang + (q / 4 - 0.5) * 2 * spread + (h1 - 0.5) * 0.42;
      const rr = rad * (0.62 + h2 * 0.42);
      const lobe = Math.pow(Math.cos(clamp((a - ang) / spread, -1, 1) * 1.35), 2);
      const kk = fade * lobe * (0.21 + h1 * 0.48) * (1 - p * 0.45);
      this.glow.push(cx + Math.cos(a) * rr * 0.52, cy + Math.sin(a) * rr * 0.52,
        rr * (0.42 + h2 * 0.30), rad * 0.26 + 10, a,
        col[0] * kk, col[1] * kk, col[2] * kk, 1, S.GLOW);
      if (h1 > 0.50) {
        this.glow.push(cx + Math.cos(a) * rr * 0.78, cy + Math.sin(a) * rr * 0.78,
          rr * 0.24, rad * 0.13 + 8, a,
          hot[0] * kk * 1.45, hot[1] * kk * 1.45, hot[2] * kk * 1.45, 1, S.GLOW);
      }
    }
  }
}

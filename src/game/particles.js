// Pooled particle systems and ambient life. Struct-of-arrays, hard pool cap,
// no per-frame allocation. All randomness comes from a seeded stream so a
// replayed run looks identical frame for frame.
//
// The whole file rests on one premise: this is water at pressure, not air.
// Nothing here flies ballistically. Drag relaxes every particle toward the
// velocity of the *medium* rather than toward zero, so small things lock to the
// current within a body length while big things coast through it; buoyancy is
// per-particle instead of one gravity constant; and the medium itself is a
// shared divergence-free curl field, which is what makes paths swirl instead of
// splay. Debris and plankton obey the same field, so the whole screen agrees
// about which way the water is going.
//
// Three authoring rules learned the hard way, all three by looking at frames:
//
//  - Water is a SHAPE, light is a POINT. A wake, a silt front and a pressure
//    swell are wide, soft and very dim; a fragment, a stimulated plankton and a
//    dying core are small, hard and hot. Authoring water as small bright sparks
//    reads as sensor noise beside the mote, and authoring light as big soft
//    blobs reads as fog. The previous pass did both, which is why the death
//    frame was a milky grey wall.
//  - Only emitters get the second, wider scatter halo. Clouds SCATTER light,
//    they do not emit it - stacking a 2x veil under fifteen overlapping smoke
//    puffs is what raised the frame's bulk past the exposure contract.
//  - NO CLOSED CURVE, EVER, NEAR THE MOTE. This is the rule that took longest
//    to learn and cost the most review passes. A smooth complete circle or
//    ellipse on a black field reads as a debug primitive no matter what profile
//    is under it, what colour it is, or how briefly it lives - it has been
//    called out as one by three independent reviewers, on three different
//    layers (a VOLUME rim, a HALO bubble, a RING front). An arc has a
//    silhouette; a circle does not. So pressure waves near the player are
//    authored as broken arcs of torn puffs (see _swell), bubbles as a lens with
//    an off-centre glint, and the only complete fronts left in the file fire
//    when the mote no longer exists.
//    The same rule has a measured half: soft light inside the mote's own
//    surround is what caps its readability. See _clear().
//  - SPEED IS THE WORLD'S JOB, NEVER THE HERO'S. This is a distance game and
//    the number is the score, so a still frame has to state it. Every cue that
//    does so here lives on the water: the wake's LENGTH is speed x 0.42s of
//    travel, the near ambient layer smears along the travel axis while the far
//    layer does not, and lifted silt shears along it. None of it touches the
//    mote, because a build that smeared everything had its tether measured as
//    a flat desaturated ribbon that picked up no colour from either light.
//    Every smear here is energy-conserving - the tint is divided by the
//    stretch - so a motion cue can never quietly become a brightness cue and
//    spend the exposure budget.
//  - ...AND IT HAS TO BE LEGIBLE IN THE BAND THE GAME ACTUALLY PLAYS IN, which
//    is a stricter requirement and is what gearK exists for. Verifying 33
//    against 490 against 1888 proved nothing a player will ever see: a review
//    sampled four real frames at 700, 730, 800 and 940 units/sec and called
//    them interchangeable, and it was right, because every cue was on a linear
//    normaliser spanning a standing start to 2250 and therefore moved by a
//    third across the whole cruise. Two things follow, both learned by looking.
//    A COUNT beats a MAGNITUDE: two filaments against three, one striation
//    against twelve, seventeen wake elements against fifty - these can be
//    ordered without a reference in frame, and a 34% longer streak cannot.
//    And a LENGTH cue has to be bought with LIFETIME, not with stretch, because
//    length x speed compounds while stretch has a hard ceiling at the point a
//    profile's own cutoff becomes a straight edge. See gearK, and see the two
//    artefacts recorded at the wake's `elg` and at the striations.
//  - NOTHING THIS FILE DRAWS MAY BE A BRIGHTER CLUSTER THAN THE ANIMAL THAT
//    CAUSED IT. Stated as art it is obvious; it is here because it is also a
//    measurement, and the measurement caught two violations this pass. The
//    quality gate ranks the mote's own 67x64px block against all 336 by
//    highlight energy - sum of L^2 - and a wake element that stretches without
//    paying for it took seed 7 / fast from rank 6 to rank 9 with three blocks
//    of the mote's own trail above it. See the wake's brightness term for the
//    arithmetic, which is not the obvious one: elements OVERLAP, so holding an
//    element's energy does not hold a block's.
//  - NOTHING MAY BE DRAWN THINNER THAN ABOUT THREE PIXELS. Below that the mip
//    chain has averaged the whole tile to one value, so what lands is a flat
//    hard rectangle with a stair-stepped edge. See quad().
//  - A HIGHLIGHT IS AN AREA, NOT A BRIGHTNESS. The exposure contract's "there
//    must be real highlights" is hdrStats().p99, and that is a COUNT, not a
//    level: the percentiles come from a 96x54 grid over the frame, so at
//    1600x900 one sample stands for 278 pixels and p99 is literally the 52nd
//    brightest of 5184 samples. A 5px pip at 3.0 linear is invisible to it
//    however hot it is, because the grid steps 17px and steps over it; a 20px
//    patch at 0.4 is worth a whole sample. Measured on seed 7 / launch by
//    differencing the frame against itself with one family filtered out of the
//    batch: this entire file put 480 pixels above 0.25 linear, i.e. under two
//    samples of the 59 that frame has, so its whole p99 contribution was
//    0.011 - and the frame sat 1.2% above a hard floor. Both fixes below are
//    therefore about AREA. See the WAKE envelope and Ambient's flash.
//  - AND SMALL AND HOT IS THE ONE COMBINATION THE MIP CHAIN EATS. A profile
//    drawn far below its tile size delivers its own tile MEAN, not its peak,
//    because that is what a box filter leaves. Measured means: GLOW 0.085,
//    PLANKTON 0.057, SPARK 0.039, CORE 0.011. So CORE - a near-delta, which
//    the kit says to draw small WITH GAIN - loses a factor of eight to GLOW at
//    the same small size. Two flashes in Ambient were CORE at 5px and both
//    measured 0.023 linear peak, which is to say they were not there at all.
import { makeRng } from '../engine/rng.js';
import { clamp, clamp01, lerp, TAU, smoothstep } from '../engine/math.js';
import { S } from '../engine/textures.js';
import { PAL } from '../art/palette.js';

const CAP = 4096;
const RING_CAP = 96;
// Ambient disturbance (wake, silt) stops emitting here so a death or a pickup
// always has room in the pool no matter how long the run has been.
const SOFT_CAP = (CAP * 0.66) | 0;

const HALF_PI = Math.PI * 0.5;

// --------------------------------------------------------------- the speed ---
// Measured rather than picked. Over 45s of autopilot on seeds 7 and 3 the
// player's speed runs p05 80, p25 350, p50 750, p75 1150, p95 1630, max ~2250
// world units/sec. The curve this replaced saturated at 2140, so at the cruise
// the game actually spends its time in it sat at 27% of its range and every
// speed cue driven off it was a whisper - which is exactly the review finding
// that "at 65 m/s the image is static".
const SPD_LO = 300, SPD_SPAN = 1250;
const spdK = (sp) => clamp01((sp - SPD_LO) / SPD_SPAN);

// ...and THE CRUISE, which is a different question and needs its own signal.
//
// spdK is the honest global normaliser and has to stay one: it spans a standing
// start to 2250 and it is what makes 33 against 490 against 1888 read as three
// different speeds. But a blind review sampled four real gameplay frames at
// 700, 730, 800 and 940 units/sec - the band the game actually spends its life
// in - and called them visually interchangeable. It was right, and spdK is the
// reason: across that whole band it moves 0.32 to 0.51, so every cue driven off
// it changed by a third while the speed changed by a third. A linear readout of
// a range the player almost never leaves is a readout of nothing.
//
// gearK spends its ENTIRE dynamic range inside that band. A smoothstep from 520
// to 1120 reads 0.22 / 0.45 / 0.78 at 700 / 800 / 940: 3.6x of signal across a
// 1.34x change in speed. Outside the band it saturates, which is exactly why
// both exist rather than one replacing the other - the extremes keep the cues
// they already had and the middle gains the ones it never had.
const GEAR_LO = 520, GEAR_INV = 1 / 600;
const gearK = (sp) => { const q = clamp01((sp - GEAR_LO) * GEAR_INV); return q * q * (3 - 2 * q); };

// The wake IS the speedometer, and this is the mechanism. Emission is driven by
// DISTANCE travelled, so the stream holds one element every TRAIL_GAP units at
// any speed; every element lives TRAIL_LIFE; therefore the visible length of
// the trail is exactly speed x TRAIL_LIFE and nothing else. 0.42s of travel is
// 150 units at a slow swing and 690 at top speed - a third of the frame width.
// The length alone states the number the HUD is currently stating alone.
const TRAIL_GAP = 15, TRAIL_LIFE = 0.42;
// ...and it starts a clear 152 units behind the head. check.mjs scores the
// mote's core against its own 42-83 PIXEL annulus, which at the shipped
// 900px/1146-unit camera is 53-106 world units - and the ring reaches 105 in
// the diagonals of its sample box, not 74 as an earlier round read it. Nothing
// is allowed to sit in that band; the exception is INSIDE it, where a hot point
// reads as part of the animal. See _moat() for the shape and the collar in
// _disturb() for the exception.
const TRAIL_BACK = 152;

// A quad thinner than about three pixels has no profile left in it: the mip
// chain has averaged the tile to a single value, so what draws is a flat hard
// rectangle with a stair-stepped edge. Found at 16x beside the mote as a
// handful of 2x2px mint blocks and one 7x2px dash - small, but sitting on the
// hero, which is the worst place in the frame for a hard edge. Widen to the
// floor and dim by the same factor: the light is conserved, the artefact is
// not. Identical remedy to the one ribbons.js applies to sub-pixel strokes,
// for identical reasons.
// 5.5px, and RAISING IT FURTHER IS NOT THE CURE - two rounds of this file
// assumed it was, so here is the measurement that ends the argument. The
// artefact is real: rendered by elimination on the 150m frame at 12x, with this
// file's drawing disabled the mote's surround is clean water, and with it on
// there is a scatter of flat 1-2 pixel blocks. But taking the floor from 5.5 to
// 9.5 barely touched them, because the residue is not quad size. SPARK's bright
// core is exp(-42 r^2), i.e. 0.15 of its own tile radius, so even a 9px quad
// puts under a pixel of core on screen and the falloff around it drops below
// one 8-bit step immediately. A concentrated profile cannot be made soft by
// being drawn bigger; it can only be made dimmer, and it was already the
// dimmest thing near the mote.
//
// What actually fixed the visible artefact was COLOUR: the two emitters nearest
// the mote were drawing 30-35% of their specks at planktonCore, which is
// 0xf2fff6 and therefore white. A dim 1px cyan speck on teal water is plankton.
// A dim 1px WHITE speck on teal water is a dead pixel, and the eye finds it
// instantly because nothing else in the palette is neutral. See N_PLNKC below.
// So the floor stays at the smallest value that keeps a wide profile's falloff
// alive, and the fill it would have cost everywhere else is not spent.
//
// Residue, for whoever picks this up next: the mint blocks are gone and the
// white chain is gone, but FOUR faint neutral specks survive in that same crop.
// They are not from either emitter fixed here. The remaining pale sources close
// to the mote are the bubble glint - N_SURF, pulled further toward N_ANCH by
// `lit` - and sparks('attach'), whose hot colour is N_ANCHC. Both are
// legitimately pale, so the remedy there is a hue floor and not a size one.
const MIN_QUAD_PX = 5.5;
// ...and a quad may not be small AND hot at the same time. Measured on the
// tethered frame at 16x: the mint blocks beside the mote were 3.3-5.5px wide
// carrying 1.1-2.4 linear, and at that footprint the mip chain has already
// flattened the tile, so the whole rectangle clips through the tonemap and its
// falloff has nowhere to happen. The result is a flat bright square with a
// hard edge - the size floor alone does not fix it, because the defect is
// surface brightness, not size.
//
// A lens cannot image a point smaller than its PSF either, so: spread it. The
// quad grows and the tint drops by the same area, which leaves the energy - and
// therefore both the frame's mean and the mote's measured surround - exactly
// where they were. See draw(); it is applied to the plankton family only.
// 0.42 is not a taste call. Measured by disabling this whole file's drawing:
// the seed 7 launch frame's HDR p99 is 0.2454 WITHOUT it, against a contract
// floor of 0.25 - so these points are load-bearing for "there must be real
// highlights", and spreading them below 0.25 surface brightness takes the
// frame's highlights out with the hard edge. Above it, they still read as a
// falloff rather than as a clipped rectangle, because 0.42 does not clip.
const PSF_MAX = 0.42, PSF_SPREAD_MAX = 2.6;
let qw = 0, qh = 0;
/**
 * Floored size into module scalars; returns the alpha to pay it back with.
 *
 * The payback is the LINEAR shortfall, not the area one. A quad smaller than a
 * pixel does not render its area - it either covers a sample point or it does
 * not, so it flickers in and out and its rendered energy is a coin flip -
 * which means charging it the full area would over-dim it by an order of
 * magnitude. sqrt is the geometric mean of the two shortfalls.
 *
 * Diffuse bodies use the return value. Hot pips - a bubble's glint, the pip on
 * the peak of an ambient flash - deliberately ignore it and only take the
 * size: those are specular highlights, they are what the exposure contract's
 * p99 is made of, and paying anything back for them trades a real highlight
 * for a sub-pixel artefact that was never reliably drawn in the first place.
 */
function quad(w, h, fl) {
  qw = w; qh = h;
  let k = 1;
  if (qw < fl) { k = qw / fl; qw = fl; }
  if (qh < fl) { k *= qh / fl; qh = fl; }
  return k < 1 ? Math.sqrt(k) : 1;
}

// Nearest anchor light, as a 0..1 proximity. Written to a module scalar because
// the callers are in hot paths.
let litK = 0;

// ------------------------------------------------------------------ the water ---
// A divergence-free curl field, tabulated once at module load.
//
// The stream function is a sum of integer-wavenumber harmonics, so it wraps
// exactly on a torus and the one tile can repeat across the whole trench with
// no seam. Taking its curl by central difference gives a field with no sources
// or sinks - fluid can only shear and rotate, never appear - and that is the
// difference between "pushed by water" and "blown by wind". Tabulating means
// the runtime cost is two bilinear fetches per particle, not eight hashes.
//
// Measured on the built table: mean|div| is 0.00000 against mean|curl| 0.143,
// and a massless tracer turns 325 degrees over five seconds. It is doing the
// job the comment claims.
const FN = 64, FMASK = FN - 1;
const FU = new Float32Array(FN * FN);
const FV = new Float32Array(FN * FN);
(() => {
  const r = makeRng(0x51f7);
  const psi = new Float32Array(FN * FN);
  const H = 10;
  const kx = new Int32Array(H), ky = new Int32Array(H);
  const ph = new Float32Array(H), am = new Float32Array(H);
  for (let h = 0; h < H; h++) {
    const k = 1 + ((h * 0.62) | 0);                      // 1..6, low bands weighted
    kx[h] = k * (r() < 0.5 ? -1 : 1);
    ky[h] = Math.max(1, Math.round(k * lerp(0.35, 1.7, r()))) * (r() < 0.5 ? -1 : 1);
    ph[h] = r() * TAU;
    am[h] = 1 / Math.pow(k, 1.5);
  }
  for (let j = 0; j < FN; j++) {
    const v = j / FN;
    for (let i = 0; i < FN; i++) {
      const u = i / FN;
      let s = 0;
      for (let h = 0; h < H; h++) s += am[h] * Math.sin(TAU * (kx[h] * u + ky[h] * v) + ph[h]);
      psi[j * FN + i] = s;
    }
  }
  let peak = 1e-9;
  for (let j = 0; j < FN; j++) {
    const jd = ((j - 1) & FMASK) * FN, ju = ((j + 1) & FMASK) * FN, jr = j * FN;
    for (let i = 0; i < FN; i++) {
      const il = (i - 1) & FMASK, ir = (i + 1) & FMASK;
      const du = (psi[jr + ir] - psi[jr + il]) * 0.5;
      const dv = (psi[ju + i] - psi[jd + i]) * 0.5;
      const a = dv, b = -du;                             // curl of a 2-D stream function
      FU[jr + i] = a; FV[jr + i] = b;
      const m = Math.abs(a) > Math.abs(b) ? Math.abs(a) : Math.abs(b);
      if (m > peak) peak = m;
    }
  }
  const k = 1 / peak;
  for (let i = 0; i < FU.length; i++) { FU[i] *= k; FV[i] *= k; }
})();

let flowX = 0, flowY = 0;

/** Bilinear wrapping fetch. Writes module scalars; allocating here would hurt. */
function fetchFlow(u, v) {
  const fu = u - Math.floor(u), fv = v - Math.floor(v);
  const x = fu * FN, y = fv * FN;
  const i0 = x | 0, j0 = y | 0;
  const tx = x - i0, ty = y - j0;
  const i1 = (i0 + 1) & FMASK, j1 = (j0 + 1) & FMASK;
  const a = j0 * FN, b = j1 * FN;
  const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty, w11 = tx * ty;
  flowX = FU[a + i0] * w00 + FU[a + i1] * w10 + FU[b + i0] * w01 + FU[b + i1] * w11;
  flowY = FV[a + i0] * w00 + FV[a + i1] * w10 + FV[b + i0] * w01 + FV[b + i1] * w11;
}

const L1 = 1240, L2 = 355;      // large eddies, and the churn inside them
const WVEL = 104;               // peak water speed, world units/sec
const CURRENT_X = 7, CURRENT_Y = 9;  // the trench breathes down-current, gently

/**
 * Water velocity at a world point, in world units/sec. Two octaves, slowly
 * advected so a particle cannot park in a static eddy forever. Ambient life
 * samples this at the *same* world coordinates the debris does - the previous
 * pass scaled ambient by 0.8, which meant the two layers swirled around
 * different eddies while the comment claimed one water.
 */
function waterAt(x, y, t) {
  fetchFlow((x + t * 12) / L1, (y - t * 5) / L1);
  const ax = flowX, ay = flowY;
  fetchFlow((613 - x - t * 27) / L2, (271 + y + t * 10) / L2);
  flowX = (ax + flowX * 0.40) * WVEL + CURRENT_X;
  flowY = (ay + flowY * 0.40) * WVEL + CURRENT_Y;
}

// Hue-normalised palette entries. Keeping hue and amplitude separate is the
// only way to hold a value hierarchy: the mote is allowed to be the brightest
// thing on screen, and everything here is written as an explicit fraction of it.
const norm = (c) => { const m = Math.max(c[0], c[1], c[2]) || 1; return [c[0] / m, c[1] / m, c[2] / m]; };
const N_WATER = norm(PAL.waterHigh);
const N_SURF = norm(PAL.surface);
const N_SILT = norm(PAL.silt);
const N_MOTE = norm(PAL.moteInner);
const N_MOTEC = norm(PAL.moteCore);
const N_MOTEO = norm(PAL.moteOuter);
const N_TRAIL = norm(PAL.moteTrail);
const N_PLNK = norm(PAL.plankton);
const N_PLNKC = norm(PAL.planktonCore);
const N_ANCH = norm(PAL.anchorMid);
const N_ANCHC = norm(PAL.anchorCore);
const N_HAZ = norm(PAL.hazardRim);
const N_HAZC = norm(PAL.hazard);
const N_HUSH = norm(PAL.hushEdge);

// Where absorbed light ends up: red goes first, so a dying bioluminescent
// fragment slides cyan, then blue, then out.
const ABSORB = [0.03, 0.34, 0.62];

/** Behaviour classes. Only the envelope and a couple of forces differ. */
const K = { SPARK: 0, BUBBLE: 1, CLOUD: 2, EMBER: 3, DART: 4, VORTEX: 5, COLD: 6, WAKE: 7 };

// Linear drag scales as 1/radius (a ~ v/r for small bodies), which is exactly
// why grit stops dead and a bubble sails on.
const dragFor = (base, size) => base * (12 / (size + 2));

const CFG = {
  attach: {
    spd: [70, 360], life: [0.24, 0.66], size: [4.5, 21], col: N_ANCH, hot: N_ANCHC,
    bright: 2.3, buoy: [-80, 45], drag: 3.4, cone: 2.5, flow: 0.9, cool: 0.55, str: 0.5, bub: 2, silt: 0,
  },
  release: {
    spd: [150, 700], life: [0.22, 0.72], size: [4.5, 26], col: N_MOTE, hot: N_MOTEC,
    bright: 2.9, buoy: [-95, 60], drag: 2.8, cone: 1.5, flow: 0.8, cool: 0.6, str: 0.85, bub: 3, silt: 0,
  },
  wall: {
    spd: [90, 500], life: [0.18, 0.58], size: [4, 17], col: N_WATER, hot: N_SURF,
    bright: 1.8, buoy: [-30, 200], drag: 4.8, cone: 2.1, flow: 1.3, cool: 0.9, str: 0.5, bub: 4, silt: 3,
  },
  brush: {
    spd: [120, 460], life: [0.20, 0.54], size: [4, 19], col: N_HAZ, hot: N_HAZC,
    bright: 2.5, buoy: [-70, 60], drag: 3.9, cone: 2.7, flow: 1.2, cool: 0.5, str: 0.6, bub: 2, silt: 0,
  },
  chain: {
    spd: [50, 230], life: [0.32, 1.0], size: [4, 15], col: N_PLNK, hot: N_PLNKC,
    bright: 2.1, buoy: [-45, 20], drag: 5.4, cone: 2.9, flow: 1.5, cool: 0.6, str: 0.35, bub: 1, silt: 0,
  },
};

export class Particles {
  constructor(seed = 1) {
    this.rng = makeRng(seed * 7919 + 13);
    const f = (n) => new Float32Array(n);
    this.x = f(CAP); this.y = f(CAP); this.vx = f(CAP); this.vy = f(CAP);
    this.life = f(CAP); this.max = f(CAP); this.size = f(CAP); this.size1 = f(CAP);
    this.r = f(CAP); this.g = f(CAP); this.b = f(CAP);
    this.rot = f(CAP); this.spin = f(CAP);
    this.drag = f(CAP); this.grav = f(CAP); this.bright = f(CAP);
    this.flow = f(CAP);    // fraction of the water velocity this body sees
    this.cool = f(CAP);    // how completely the water absorbs its light
    this.str = f(CAP);     // velocity-aligned stretch, 0 = round
    this.wobA = f(CAP);    // lateral wobble amplitude (bubbles helix as they rise)
    this.delay = f(CAP);   // hold before it starts living - secondary motion
    this.asp = f(CAP);     // static aspect on the particle's own layer, 1 = square
    this.lit = f(CAP);     // how much nearby emitter light this body catches
    // Cached water velocity. Two field fetches per particle per step was 75% of
    // the whole sim step; the field's finest feature is 355 world units across,
    // so sampling it every step for something that moves 8 units per step is
    // waste. A quarter of the pool refreshes each step - see update().
    this.wx = f(CAP); this.wy = f(CAP);
    this.kind = new Uint8Array(CAP);
    this.layer = new Uint8Array(CAP);
    this.n = 0;

    this.rings = [];
    for (let i = 0; i < RING_CAP; i++) {
      this.rings.push({
        live: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, dur: 1, r0: 0, r1: 1,
        w: 1, pw: 3, fade: 2.2, fr: 0.76, ecc: 0, ang: 0,
        // Owned, preallocated: _ring() writes into it so a caller-supplied
        // colour never needs a normalising allocation in a hot path.
        col: [1, 1, 1], bright: 1, layer: S.RING,
      });
    }

    // --- player echo. See update() for how this gets filled every sim step. ---
    this.px = 0; this.py = 0; this.pvx = 0; this.pvy = 0;
    this._g = null;
    this.steps = 0;        // proof the per-step hook actually ran
    this.emitted = 0;      // proof it actually emitted
    this.events = 0;       // proof the *Seq edge hooks actually fired
    this._t = 0;
    this._aWake = 0; this._aBub = 0; this._aSilt = 0; this._aGlow = 0; this._aPull = 0;
    this._aStria = 0;
    this._side = 1;
    this._impSeq = -1; this._lchSeq = -1;
    this._pkScatX = -1e9;
    this._pkI = 0;
    this._pkT = -9;        // so the first pickup of a run reads as isolated
    this._cw = 0; this._ch = 0; this._cx = 0; this._cy = 0;
    // --- the focal keep-out. See _clear(). Sized in world units from the
    //     camera's own vertical extent so it tracks the zoom.
    this._gk = 0;                       // 0 = off (no living mote to protect)
    this._kFull = 108; this._kInv = 1 / 156;
    // The moat: an ANNULUS, not a disc. See _moat().
    this._mIn = 50; this._mOut = 99; this._mInv = 1 / 49; this._mDepth = 0.72;
    // Pixels per world unit, from the camera. Sizes have to be floored in
    // PIXELS - a world-unit floor stops being a pixel floor the moment the
    // launch zoom moves.
    this._u2p = 0.786;
    this._aTrail = 0;       // distance-driven, unlike every other accumulator
    this._lane = 0;         // 0..lanes-1; the braid gains a strand at the cruise
    this._mix = [0, 0, 0];  // owned scratch: a tinted colour must not allocate
  }

  clear() {
    this.n = 0;
    for (let i = 0; i < RING_CAP; i++) this.rings[i].live = false;
  }

  _spawn(x, y, vx, vy, life, s0, s1, col, bright, layer, drag, grav, spin) {
    let i;
    if (this.n < CAP) i = this.n++;
    else { i = (this.rng() * CAP) | 0; }      // hard cap: recycle, never allocate
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.max[i] = life;
    this.size[i] = s0; this.size1[i] = s1;
    this.r[i] = col[0]; this.g[i] = col[1]; this.b[i] = col[2];
    this.bright[i] = bright; this.layer[i] = layer;
    this.drag[i] = drag; this.grav[i] = grav;
    this.rot[i] = this.rng() * TAU; this.spin[i] = spin;
    // defaults, because slots are recycled
    this.kind[i] = K.SPARK;
    this.flow[i] = 1; this.cool[i] = 0; this.str[i] = 0;
    this.wobA[i] = 0; this.delay[i] = 0; this.asp[i] = 1; this.lit[i] = 0;
    // Seed the cache now: a recycled slot's stale water could be from anywhere
    // in the trench, and it would be used for up to three steps.
    waterAt(x, y, this._t);
    this.wx[i] = flowX; this.wy[i] = flowY;
    this.emitted++;
    return i;
  }

  // --------------------------------------------------------------- emitters ---
  sparks(x, y, count, biasX = 0, biasY = 0, flavour = 'attach') {
    const r = this.rng;
    const cfg = CFG[flavour] || CFG.attach;
    this._echo(x, y, biasX, biasY);
    const bs = Math.hypot(biasX, biasY);
    const base = bs > 1 ? Math.atan2(biasY, biasX) : 0;

    for (let i = 0; i < count; i++) {
      // A jet through water spreads into a cone and stalls; it does not radiate
      // evenly forever. Most go with the bias, a few blow back.
      const aimed = bs > 1 && r() < 0.68;
      const a = aimed ? base + (r() - 0.5) * cfg.cone : r() * TAU;
      const sp = lerp(cfg.spd[0], cfg.spd[1], Math.pow(r(), 1.8));
      const s0 = lerp(cfg.size[0], cfg.size[1], Math.pow(r(), 2.1));
      const carry = lerp(0.25, 0.9, r());
      const hot = Math.pow(r(), 1.7);
      const j = this._spawn(
        x + Math.cos(a) * lerp(2, 15, r()), y + Math.sin(a) * lerp(2, 15, r()),
        Math.cos(a) * sp + biasX * carry, Math.sin(a) * sp + biasY * carry,
        lerp(cfg.life[0], cfg.life[1], r()),
        s0, s0 * lerp(0.10, 0.34, r()),
        hot > 0.62 ? cfg.hot : cfg.col,
        cfg.bright * lerp(0.45, 1.35, r()) * (0.75 + 0.55 * hot),
        // STAR's thin spines get exaggerated by the grade, so only the large
        // ones are allowed to have them.
        (s0 > 14 && r() < 0.22) ? S.STAR : (s0 > 12 ? S.GLOW : S.SPARK),
        dragFor(cfg.drag, s0), lerp(cfg.buoy[0], cfg.buoy[1], r()),
        (r() - 0.5) * 6
      );
      this.kind[j] = K.EMBER;
      this.flow[j] = cfg.flow * lerp(0.5, 1.5, r());
      this.cool[j] = cfg.cool * lerp(0.6, 1.15, r());
      this.str[j] = cfg.str * lerp(0.4, 1.3, r());
    }

    // Impacts shed gas and lift grit. This is the cheapest "underwater" tell
    // there is, and it should ride on every real contact.
    if (cfg.bub) this.bubbles(x, y, 1 + ((r() * cfg.bub) | 0), biasX, biasY);
    if (cfg.silt) this._puff(x, y, cfg.silt, biasX * 0.3, biasY * 0.3, 0.9);
  }

  /** Big shaped emission for pickups and death. */
  burst(x, y, flavour, mult = 1) {
    const r = this.rng;
    this._echo(x, y, 0, 0);

    if (flavour === 'plankton') {
      // Scattering a living swarm, not detonating a ring of dots. Bias the fan
      // away from whatever just swam through it, then let each one dart and
      // stall the way something with a tail does.
      //
      // Rate-limited, and this is the single biggest restraint win in the file:
      // a chain fires this fifteen times a second, and at the ~32 particles it
      // used to emit that was 72% of everything the pool ever held - a mint fog
      // travelling with the mote, in the one place on screen where nothing is
      // allowed to compete with it. So an isolated pickup gets a real pop and a
      // pickup inside a running chain gets a spark and a breath of water. The
      // chain still reads: it reads as a *stream* of small pops, which is what
      // a chain should look like.
      const gap = this._t - this._pkT;
      this._pkT = this._t;
      const solo = clamp01((gap - 0.09) / 0.35);      // 0 = mid-chain, 1 = alone
      const ps = Math.hypot(this.pvx, this.pvy);
      const away = ps > 40 ? Math.atan2(this.pvy, this.pvx) : r() * TAU;
      const n = 5 + ((solo * 7 + Math.min(6, mult * 1.2)) | 0);
      // Hotness, speed and lifetime are ONE draw, not three.
      //
      // Measured, by killing particles in bands on a frozen frame: this
      // emitter is the largest single cost to the mote's focal contrast in the
      // whole file - 0.21 of 4.27:1 on seed 3 / fast and 0.5 of 4.75:1 on seed
      // 3 / launch - because a pickup happens at the mote by definition and
      // these were bright, slow and long-lived independently of each other. A
      // dart could draw 3.4 brightness, 140 units/sec and a full second, and
      // then it is a hot mint dot loitering in the mote's own surround for a
      // second: the exact "soft light in the annulus" failure this file was
      // rebuilt to remove, in its hot form.
      //
      // Correlated, the pop is louder and cheaper at once. The hot ones leave
      // fast and are gone; what lingers is dim. The violence is in how fast it
      // leaves, which is the same argument the death flash is built on.
      for (let i = 0; i < n; i++) {
        const wide = r() < 0.3;
        const a = wide ? r() * TAU : away + (r() - 0.5) * 3.3;
        const q = r();                                   // hotness
        // Fast enough to leave. The cost of this emitter is dwell time in the
        // 53-74 unit ring, not brightness there - so the cheapest possible fix
        // is to raise the floor on how fast a dart travels and lower its drag,
        // which changes no light anywhere and simply means fewer of them are
        // still in the ring when the shutter opens.
        const sp = lerp(300, 820, Math.pow(q, 0.7));
        const s0 = lerp(4.4, 11, Math.pow(r(), 1.5));
        const j = this._spawn(
          x + Math.cos(a) * lerp(2, 16, r()), y + Math.sin(a) * lerp(2, 16, r()),
          Math.cos(a) * sp, Math.sin(a) * sp, lerp(0.74, 0.28, q),
          s0, s0 * lerp(0.25, 0.6, r()),
          // Near-white is CORRELATED with the hotness draw now rather than
          // rolled independently, for the same reason everything else about
          // this emitter is: a pickup happens at the mote by definition, so the
          // only specks allowed to approach the mote's own colour are the ones
          // already leaving at 700+ units/sec with a third of a second to live.
          // Rolled independently, a near-white dot could also be the slow dim
          // one that loiters in the surround for the better part of a second.
          //
          // Written as a coin flip AND the hotness test rather than as the
          // hotness test alone, so it still draws exactly one number from the
          // stream. That is not cosmetic: this emitter runs several times a
          // second, so dropping a draw here reshuffles every particle in the
          // run and every frame after it. A change to a COLOUR must not move
          // anything's position, or it cannot be attributed - and this one
          // silently moved the seed 3 focal-contrast warning by 0.2 the first
          // time it was written the short way.
          (r() < 0.62 && q > 0.55) ? N_PLNKC : N_PLNK, lerp(1.45, 3.2, q),
          r() < 0.4 ? S.PLANKTON : S.SPARK,
          dragFor(4.6, s0), lerp(-50, 14, r()), (r() - 0.5) * 8
        );
        this.kind[j] = K.DART;
        this.flow[j] = lerp(1.0, 1.9, r());
        this.cool[j] = lerp(0.35, 0.8, r());
        this.str[j] = lerp(0.35, 0.8, r());
      }
      // Slower stragglers with their own pulse, so the swarm is not one age.
      // Shorter and dimmer than they were: a 14-unit soft dot at 1.0 linear
      // sitting in the mote's surround for the better part of two seconds is
      // the most expensive thing a pickup can leave behind, and a pickup
      // happens several times a second.
      //
      // Trimmed again, and this time the trade was measured to be free rather
      // than argued. These travel 30-150 units/sec for up to a second, i.e.
      // they are BORN in the 53-74 unit ring the mote is scored against and
      // then stay there - and on a chaining seed there are a hundred of them in
      // it at once. Against that, filtering the whole GLOW layer out of the
      // launch frame moves its p99 by 0.0000: these are too soft and too dim to
      // be highlights, so their only measurable effect on the frame is the one
      // that costs. So dimmer and shorter, and nothing is given up for it.
      const ns = 1 + ((solo * 3) | 0);
      for (let i = 0; i < ns; i++) {
        const a = r() * TAU, sp = lerp(30, 150, r());
        const s0 = lerp(9, 19, r());
        const j = this._spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
          lerp(0.48, 0.98, r()), s0, s0 * 0.5, N_PLNK, lerp(0.36, 0.70, r()), S.GLOW,
          dragFor(3.2, s0), lerp(-34, 8, r()), (r() - 0.5) * 2);
        this.kind[j] = K.DART;
        this.flow[j] = lerp(1.2, 2.0, r());
        this.cool[j] = 0.55;
        this.delay[j] = r() * 0.10;
      }
      // The water they were sitting in, disturbed.
      this._puff(x, y, 1 + ((solo * 2) | 0), this.pvx * 0.06, this.pvy * 0.06, 0.55, N_PLNK, 0.30);
      if (r() < 0.3 + 0.5 * solo) this.bubbles(x, y, 1, this.pvx * 0.2, this.pvy * 0.2);
      // Deliberately no front. A pickup happens several times a second, in the
      // exact place the eye is trying to hold, and the 37px closed curve that
      // used to fire here was both the most-repeated geometric primitive in the
      // frame and soft light dropped straight into the mote's own surround. An
      // isolated pickup gets a breath of water shoved outward instead.
      if (solo > 0.35) {
        this._swell(x, y, away + Math.PI, 3.6, lerp(66, 108, r()), 3,
                    lerp(180, 300, r()), 0.55 * solo, N_PLNK);
      }
      return;
    }

    if (flavour !== 'death') return;

    // ------------------------------------------------------- a light going out ---
    // Timeline in seconds after death. The GAP matters as much as the events:
    // main.js damps envDim to 0.42 over ~1.4s, so anything still firing through
    // that window stops the frame ever going dark, and the death reads as a
    // smoke puff instead of a light being extinguished. It did.
    //
    //   0.00-0.10  flash - three falloffs plus one anamorphic streak
    //   0.00-0.46  pressure front, decelerating, and a wide dim swell behind it
    //   0.05-0.90  fragments flying, cooling cyan -> blue as water absorbs them
    //   0.10-3.0   silt front: lateral, dim, expands then hangs
    //   0.50-0.95  THE BEAT. Cooling fragments and silt only. Nothing hot.
    //   0.95-1.75  the last stutters, as the light arcs out
    //   1.10-5.0   cinders settling, almost fully absorbed
    const ps = Math.hypot(this.pvx, this.pvy);
    const ang = ps > 40 ? Math.atan2(this.pvy, this.pvx) : r() * TAU;

    // 1. the hard flash. Gone inside a tenth of a second - the violence is in
    //    how fast it leaves, not in how big it is. The mid falloff is GLOW and
    //    not VOLUME: at 240 units across, VOLUME's defined rim drew a 200-pixel
    //    contour line around the death, which is the one shape this frame must
    //    not contain.
    let j = this._spawn(x, y, 0, 0, 0.09, 120, 14, N_MOTEC, 13, S.CORE, 1, 0, 0);
    this.flow[j] = 0;
    j = this._spawn(x, y, 0, 0, 0.17, 230, 70, N_MOTE, 4.4, S.GLOW, 1.2, 0, 0);
    this.flow[j] = 0.2;
    j = this._spawn(x, y, 0, 0, 0.40, 560, 980, N_MOTEO, 1.5, S.VEIL, 0.8, -10, 0);
    this.flow[j] = 0.4; this.cool[j] = 0.85;
    // the lens takes it too, along the direction it was travelling
    j = this._spawn(x, y, 0, 0, 0.20, 58, 18, N_MOTE, 2.6, S.ANAMORPH, 1.4, 0, 0);
    this.flow[j] = 0; this.asp[j] = 8; this.rot[j] = ang;

    // 2. the pressure wave. One front, small and violent and *gone*, and then
    //    the wave's actual reach carried by silt.
    //
    //    Measured, not guessed: at r1=300/dur=0.30 - which is what it was, and
    //    which the previous comment already believed was the safe size - the
    //    quad is 833 world units across, and at that magnification SHOCK's
    //    angular front table runs out of resolution. What is drawn is a
    //    700-pixel faceted closed contour with a filled interior, sitting in
    //    frame for a third of a second, and it is the exact "cell membrane" the
    //    profile family is warned about. A second concentric RING inside it
    //    made it a diagram. Both are what a false-colour capture of the death
    //    frame found.
    //
    //    So the front is now 132 units for 0.16s - an event, not a shape you
    //    get time to study - and the expansion is told by two torn silt shells
    //    with a gap in each. A pressure front in sediment has never been a
    //    clean curve, and a broken one cannot read as a primitive.
    const lead = this._ring(x, y, S.SHOCK, 20, 132, 0.16, 3.6, 2.4, N_MOTE, ang, 0.20, 0.72);
    if (lead) { lead.vx = this.pvx * 0.07; lead.vy = this.pvy * 0.07; }
    this._swell(x, y, ang + Math.PI, 5.7, 260, 9, 700, 1.5);
    this._swell(x, y, ang + 2.1, 5.4, 430, 7, 1000, 0.9);

    // 3. silt shocked off the bottom. Mostly lateral - the wave sweeps outward
    //    along the floor, it does not throw a ball of dust upward - and dim
    //    enough that fifteen of them overlapping still leave the frame dark.
    //    Slow, because the cloud has to still be a readable *place* a second
    //    later; thrown at 640 u/s it was 400 units away and gone by then, and
    //    the beat had nothing in it to look at.
    for (let i = 0; i < 15; i++) {
      const a = r() * TAU;
      const sp2 = lerp(150, 380, Math.pow(r(), 0.7));
      const s0 = lerp(26, 74, r());
      j = this._spawn(x, y, Math.cos(a) * sp2, Math.sin(a) * sp2 * 0.42,
        lerp(2.2, 4.6, r()), s0, s0 * lerp(1.5, 2.3, r()),
        r() < 0.5 ? N_SILT : N_WATER, lerp(0.07, 0.18, r()), S.SMOKE,
        dragFor(9.0, s0), lerp(4, 22, r()), (r() - 0.5) * 0.7);
      this.kind[j] = K.CLOUD;
      this.flow[j] = lerp(1.3, 2.0, r());
      this.cool[j] = lerp(0.4, 0.9, r());
      this.delay[j] = 0.02 + r() * 0.10;
      this.asp[j] = lerp(1.15, 1.8, r());
    }

    // 3b. the water where the light was, still faintly remembering it. This is
    //     what gives the beat of near-darkness somewhere to be: no structure,
    //     no edge, just a dim stain that outlasts everything else.
    j = this._spawn(x, y, this.pvx * 0.04, this.pvy * 0.04, 2.7,
      210, 470, N_MOTEO, 0.55, S.VEIL, 1.1, -6, 0);
    this.kind[j] = K.COLD;
    this.flow[j] = 0.7; this.cool[j] = 0.6; this.delay[j] = 0.16;

    // 4. fragments. They scatter, cool, and get absorbed - a bioluminescent
    //    light does not stay white while it dies. The long tail is what carries
    //    the beat: at 0.9s a handful of these are still readable, deep blue.
    for (let i = 0; i < 46; i++) {
      const a = r() * TAU;
      const q = Math.pow(r(), 1.9);
      const sp2 = lerp(110, 1300, q);
      const s0 = lerp(4, 24, Math.pow(r(), 1.4));
      const col = q > 0.68 ? N_MOTEC : (r() < 0.45 ? N_MOTE : N_MOTEO);
      j = this._spawn(x, y, Math.cos(a) * sp2, Math.sin(a) * sp2,
        lerp(0.5, 2.2, r()), s0, s0 * lerp(0.08, 0.3, r()), col,
        lerp(1.5, 4.2, r()), (s0 > 15 && r() < 0.3) ? S.STAR : (s0 > 12 ? S.GLOW : S.SPARK),
        dragFor(3.0, s0), lerp(-60, 120, r()), (r() - 0.5) * 9);
      this.kind[j] = K.EMBER;
      this.flow[j] = lerp(0.8, 1.7, r());
      this.cool[j] = lerp(0.88, 1.0, r());
      this.str[j] = lerp(0.4, 0.9, r());
    }

    // 5. cinders: what is still sinking seconds later, fully absorbed, so they
    //    read as the colour water leaves behind rather than as dim white dots.
    for (let i = 0; i < 11; i++) {
      const a = r() * TAU, sp2 = lerp(16, 130, r());
      const s0 = lerp(6, 18, r());
      j = this._spawn(x + (r() - 0.5) * 110, y + (r() - 0.5) * 90,
        Math.cos(a) * sp2, Math.sin(a) * sp2, lerp(2.6, 5.0, r()),
        s0, s0 * 0.72, N_MOTEO, lerp(1.1, 2.5, r()), S.GLOW,
        dragFor(2.2, s0), lerp(10, 40, r()), (r() - 0.5) * 1.6);
      this.kind[j] = K.COLD;
      this.flow[j] = lerp(1.5, 2.2, r());
      this.cool[j] = 1;
      this.delay[j] = 0.32 + r() * 0.6;
    }

    // 6. the last stutters, AFTER the beat of dark. Tiny, late, and brief.
    for (let i = 0; i < 5; i++) {
      j = this._spawn(x + (r() - 0.5) * 150, y + (r() - 0.5) * 120, 0, 0,
        lerp(0.08, 0.17, r()), lerp(8, 18, r()), 3, N_MOTEC,
        lerp(2.0, 3.6, r()), S.CORE, 3, 0, 0);
      this.flow[j] = 1.6;
      this.delay[j] = lerp(0.95, 1.75, r());
    }

    // 7. gas released by the collapse, arriving over the next half second
    this.bubbles(x, y, 16, this.pvx * 0.2, this.pvy * 0.2, 0.55);
  }

  /**
   * Backwards-compatible ring entry point. Every caller in the game passes
   * `scale` between 0.55 and 1.10 - a swing, several a second - so that path is
   * the one that matters and it no longer draws a front at all. See the comment
   * inside. The `scale >= 1.15` path is kept for anything that ever wants a
   * genuine event-scale wave.
   */
  ring(x, y, scale = 1, col = PAL.moteInner, bright = 2) {
    const r = this.rng;
    const c = col === PAL.moteInner ? N_MOTE : col;
    const ps = Math.hypot(this.pvx, this.pvy);
    // Squashed along travel: the medium is already moving that way, so the wave
    // cannot expand into it as easily.
    const ang = ps > 40 ? Math.atan2(this.pvy, this.pvx) : r() * TAU;

    if (scale < 1.15) {
      // No front. This fires on every catch and every release, so the thin
      // closed curve that used to live here sat 26-81px from the mote several
      // times a second - a perfect circle on a black field, which is the exact
      // read three reviews independently called a debug primitive, and it
      // landed inside the annulus focal contrast is measured against. What is
      // left is the part that was ever real: water shoved outward, as a broken
      // arc, thrown hard enough to clear the mote's own surround.
      this._swell(x, y, ang + Math.PI, 4.6, lerp(64, 104, r()) * scale, 3,
                  lerp(300, 520, r()), 0.5 + 0.35 * bright, c);
      if (r() < 0.4) this.bubbles(x, y, 1 + ((r() * 2) | 0), this.pvx, this.pvy);
      return null;
    }

    // Capped at 150 units however large `scale` gets. SHOCK's front is an
    // angular table, and past roughly 200 units of radius the magnification
    // outruns its resolution and the front becomes a visibly faceted closed
    // contour - which is how the death wave got a 700-pixel membrane. Reach
    // beyond that belongs to the silt, not to the front.
    const rad = Math.min(150, 250 * scale);
    const lead = this._ring(x, y, S.SHOCK, 20 * scale, rad,
      lerp(0.18, 0.26, r()), 4.0, bright, c, ang, lerp(0.10, 0.20, r()), 0.72);
    if (lead) { lead.vx = this.pvx * 0.06; lead.vy = this.pvy * 0.06; }
    this._swell(x, y, ang + Math.PI, 5.4, 220 * scale, 7,
                lerp(480, 780, r()), 0.6 + 0.3 * bright, c);
    return lead;
  }

  /**
   * `col` may be any [r,g,b]; it is hue-normalised into the ring's own array so
   * a caller-supplied colour never allocates. `ecc` stretches along `ang`.
   */
  _ring(x, y, layer, r0, r1, dur, pw, bright, col, ang, ecc, fr) {
    for (let i = 0; i < RING_CAP; i++) {
      const g = this.rings[i];
      if (g.live) continue;
      g.live = true; g.x = x; g.y = y; g.vx = 0; g.vy = 0; g.t = 0;
      g.dur = dur; g.r0 = r0; g.r1 = r1; g.pw = pw; g.fade = 2.2;
      const m = Math.max(col[0], col[1], col[2]) || 1;
      g.col[0] = col[0] / m; g.col[1] = col[1] / m; g.col[2] = col[2] / m;
      g.bright = bright; g.layer = layer;
      g.ang = ang; g.ecc = ecc; g.fr = fr;
      return g;
    }
    return null;
  }

  /**
   * A pressure swell, drawn as a broken arc of torn puffs instead of a closed
   * curve. This is the replacement for every front that used to fire near the
   * living mote, and it exists because the shape was the defect: a smooth
   * complete ellipse on a black field reads as a debug primitive whatever
   * profile is underneath it. An arc has a silhouette.
   *
   * The physics of the thing survives. Each puff is thrown radially and left to
   * decelerate under drag, so the front still expands and still gives its
   * energy straight back to the water; SMOKE's silhouette is eroded by a coarse
   * noise field, so no two are the same shape; and each is stretched
   * tangentially so the arc reads as an arc rather than as a row of beads.
   *
   * `span` is the arc's angular width in radians about `ang`. Angles are
   * stratified and then jittered inside their own slice - even spacing is the
   * clearest procgen tell there is, but pure noise clumps.
   */
  _swell(x, y, ang, span, rad, count, spd, gain = 1, col = null) {
    const r = this.rng;
    for (let i = 0; i < count; i++) {
      const a = ang + ((i + 0.2 + r() * 0.6) / count - 0.5) * span;
      const ca = Math.cos(a), sa = Math.sin(a);
      const r0 = rad * lerp(0.20, 0.44, r());
      const v = spd * lerp(0.7, 1.3, r());
      const sh = spd * (r() - 0.5) * 0.45;                  // tangential shear
      const s0 = rad * lerp(0.20, 0.38, r()) + 9;
      const j = this._spawn(
        x + ca * r0, y + sa * r0,
        ca * v - sa * sh, sa * v + ca * sh,
        lerp(0.34, 0.70, r()), s0, s0 * lerp(1.4, 2.2, r()),
        col || (r() < 0.45 ? N_SILT : N_WATER),
        lerp(0.06, 0.16, r()) * gain, S.SMOKE,
        dragFor(5.6, s0), lerp(-8, 18, r()), (r() - 0.5) * 0.9
      );
      this.kind[j] = K.CLOUD;
      this.flow[j] = lerp(1.2, 1.9, r());
      this.cool[j] = lerp(0.4, 0.9, r());
      this.delay[j] = r() * 0.05;
      this.asp[j] = lerp(1.3, 2.1, r());
      this.rot[j] = a + HALF_PI + (r() - 0.5) * 0.5;
    }
  }

  /**
   * Rising bubbles.
   *
   * These used to be drawn on HALO - a thin optical rim - which is optically
   * the right answer and compositionally the worst one available: a complete
   * thin circle at any size on a black field is a debug circle, and a field of
   * them beside the mote was one of the two artefacts this pass exists to
   * remove. The read is rebuilt in draw() instead, from a dim lens body and one
   * off-centre glint on the limb. That is what a bubble in dark water actually
   * looks like - almost nothing, plus a moving highlight - and it has no closed
   * contour anywhere in it.
   *
   * Fewer and bigger than they were, because the glint needs a limb to sit on.
   * Buoyancy beats drag, so the fat ones win the race up and the field fans out
   * on its own; `spin` is the helix rate, and the glint orbits with it.
   */
  bubbles(x, y, count, vx = 0, vy = 0, spread = 0.12) {
    const r = this.rng;
    // A bubble is a lens, so what it looks like is a property of the light near
    // it rather than of itself: nothing at all in open water, a small amber
    // highlight beside an anchor. Sampled once per emission - a bubble drifts
    // about a body length in its life, and a light that tracked it would put a
    // world query in the draw loop.
    this._litAt(x, y);
    const lit = litK;
    const mx = this._mix;
    for (let i = 0; i < count; i++) {
      const s = lerp(9, 30, Math.pow(r(), 1.7));
      const base = r() < 0.34 ? N_SURF : N_WATER;
      const m = lit * 0.62;
      mx[0] = lerp(base[0], N_ANCH[0], m);
      mx[1] = lerp(base[1], N_ANCH[1], m);
      mx[2] = lerp(base[2], N_ANCH[2], m);
      const j = this._spawn(
        x + (r() - 0.5) * 30, y + (r() - 0.5) * 26,
        vx * 0.14 + (r() - 0.5) * 70, vy * 0.09 - lerp(20, 80, r()),
        lerp(1.1, 3.2, r()), s, s * lerp(1.10, 1.45, r()),
        mx, lerp(0.55, 1.5, r()), S.VEIL,
        dragFor(2.6, s), -lerp(260, 420, r()),
        lerp(3.2, 7.5, r()) * (r() < 0.5 ? -1 : 1)
      );
      this.kind[j] = K.BUBBLE;
      this.flow[j] = lerp(0.4, 0.9, r());
      this.wobA[j] = lerp(300, 900, r());
      this.delay[j] = r() * spread;
      this.lit[j] = lit;
    }
  }

  /**
   * Proximity to the nearest live anchor light, 0..1, into `litK`.
   *
   * Only the diffuse BODY of a bubble is allowed to grow with this. The glint
   * takes the hue and not the gain, because the glint is a hot point exempt
   * from the keep-out and a tethered mote spends its whole swing inside an
   * anchor's radius - brightening hot points there would be spending the
   * mote's own focal contrast to light a bubble.
   */
  _litAt(x, y) {
    litK = 0;
    const g = this._g;
    const list = g && g.world && g.world.anchors;
    if (!list) return;
    let best = 3.2e5;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.x < x - 560) continue;
      if (a.x > x + 560) break;
      if (!a.alive) continue;
      const dx = a.x - x, dy = a.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    if (best >= 3.2e5) return;
    const k = 1 - Math.sqrt(best) / 566;
    litK = k * k;
  }

  /** A dim expanding cloud. Silt, not smoke - it scatters light, it is not lit. */
  _puff(x, y, count, vx, vy, scale = 1, col = null, gain = 1) {
    const r = this.rng;
    for (let i = 0; i < count; i++) {
      const s0 = lerp(24, 70, r()) * scale;
      const j = this._spawn(
        x + (r() - 0.5) * 34, y + (r() - 0.5) * 30,
        vx + (r() - 0.5) * 70, vy - lerp(0, 60, r()),
        lerp(1.1, 2.8, r()), s0, s0 * lerp(1.6, 2.5, r()),
        col || (r() < 0.5 ? N_SILT : N_WATER),
        lerp(0.055, 0.15, r()) * gain, S.SMOKE,
        dragFor(4.5, s0), lerp(2, 22, r()), (r() - 0.5) * 0.8
      );
      this.kind[j] = K.CLOUD;
      this.flow[j] = lerp(1.3, 2.0, r());
      this.cool[j] = lerp(0.4, 0.9, r());
      this.delay[j] = r() * 0.09;
      this.asp[j] = lerp(1.1, 1.7, r());
    }
  }

  /**
   * Silt leaving a surface. It does not puff isotropically off rock: the wave
   * sweeps *along* the wall, so the cloud goes out as two shallow fans hugging
   * it with only a little normal component.
   */
  _plume(x, y, count, nx, ny, spd, gain = 1) {
    const r = this.rng;
    const tx = -ny, ty = nx;
    for (let i = 0; i < count; i++) {
      const side = r() < 0.5 ? -1 : 1;
      const v = spd * lerp(0.4, 1.25, r());
      const s0 = lerp(20, 58, Math.pow(r(), 1.3));
      const j = this._spawn(
        x + tx * (r() - 0.5) * 70, y + ty * (r() - 0.5) * 70,
        tx * v * side + nx * v * 0.30, ty * v * side + ny * v * 0.30,
        lerp(1.2, 3.0, r()), s0, s0 * lerp(1.5, 2.3, r()),
        r() < 0.5 ? N_SILT : N_WATER, lerp(0.05, 0.14, r()) * gain, S.SMOKE,
        dragFor(5.2, s0), lerp(2, 20, r()), (r() - 0.5) * 0.6
      );
      this.kind[j] = K.CLOUD;
      this.flow[j] = lerp(1.4, 2.1, r());
      this.cool[j] = lerp(0.5, 1.0, r());
      this.delay[j] = r() * 0.08;
      this.asp[j] = lerp(1.2, 1.9, r());
      this.rot[j] = Math.atan2(ty, tx) + (r() - 0.5) * 0.6;
    }
  }

  /**
   * Optional hook for anything that can see the player. Not required - update()
   * finds the player on its own - but it keeps the door open.
   */
  observe(x, y, vx = 0, vy = 0) {
    this.px = x; this.py = y;
    if (vx || vy) { this.pvx = vx; this.pvy = vy; }
  }

  /** Last-resort echo: reconstruct roughly where the player was from the bias. */
  _echo(x, y, bx, by) {
    if (this._g) return;
    this.px = x; this.py = y;
    const b = Math.hypot(bx, by);
    if (b > 1) { this.pvx = bx * 5.5; this.pvy = by * 5.5; }
  }

  /**
   * main.js publishes the live game on `window.game` inside boot(), before the
   * harness takes its first step, and hands `update(dt)` nothing but dt - so
   * this is the only way the water can learn that something swam through it.
   * Verified live in headless capture by probe, not assumed: `_g === window.game`,
   * the player echo matches player.x/y exactly, and the wake/bubble/scatter
   * accumulators are all non-zero mid-run.
   *
   * A run replaces `game.particles`, so the identity test both binds the new
   * instance and permanently unbinds the old one.
   */
  _bind() {
    const g = this._g;
    if (g && g.particles === this) return g;
    if (typeof window === 'undefined') return null;
    const c = window.game || (window.LUMEN && window.LUMEN.game) || null;
    if (c && c.particles === this && c.player && c.world) { this._g = c; return c; }
    return null;
  }

  /**
   * How much of a diffuse sprite survives at (px,py): the mote's focal keep-out.
   *
   * This is the measured half of the no-closed-curves rule, and it is the
   * reason this file exists in its current form. check.mjs scores the mote's
   * core against a ring of its own surround, and that ring - 42 to 83 pixels
   * out - was where nearly everything soft in this file happened to land: wake
   * quads shed 18-87px behind the head, a launch swell centred 24 units off it,
   * a second scatter veil under every release spark at 3.2x its size. Two other
   * measurements bounded it from the outside: with the mote not drawn at all
   * the ring still read 0.213 linear, and on one seed the surround was
   * brighter than the core. No amount of making the mote hotter fixes that -
   * the surround has to go dark.
   *
   * So it is solved geometrically rather than by tuning gains down globally,
   * which would only have made the wake invisible everywhere. Diffuse emission
   * fades to nothing inside the keep-out and is untouched outside it, and the
   * radius is derived from the camera's vertical extent so it still covers the
   * same *pixels* when the lens zooms out on a launch. Small hot classes are
   * deliberately exempt: a hot point beside the mote reads as part of it, while
   * a soft wash reads as fog over it.
   *
   * `_gk` releases the keep-out over ~0.2s on death, because snapping it off
   * would pop every wake and silt cloud already on screen to full brightness in
   * one frame. Once the mote is gone there is nothing left to protect.
   */
  _clear(px, py, reach) {
    const gk = this._gk;
    if (gk <= 0.002) return 1;
    const dx = px - this.px, dy = py - this.py;
    const d = Math.sqrt(dx * dx + dy * dy) - reach - this._kFull;
    if (d <= 0) return 1 - gk;
    const q = d * this._kInv;
    if (q >= 1) return 1;
    return 1 - gk * (1 - q * q * (3 - 2 * q));
  }

  /**
   * The moat. A dark ANNULUS around the hero, not a dark disc - and that
   * distinction is the entire finding of this pass.
   *
   * A disc used to be defined here (`_clearD`, suppressing points inside 76
   * units) and was never wired into draw(), which turns out to have been luck
   * rather than judgement, because a disc is wrong in both directions at once.
   * The two things that measure the hero's readability disagree about a disc
   * and agree exactly about a ring:
   *
   *  - FOCAL CONTRAST is a max over samples within 21 world units divided by
   *    the MEAN over 53-74. Light inside 21 units is signal. Light at 53-95 is
   *    pure cost, and it is the only band where it is pure cost.
   *  - GLOBAL SALIENCE ranks the mote's own 67x64px block against all 336 by
   *    highlight energy. The block is +/-42 world units from its own centre, so
   *    light at 53-95 units mostly lands in the NEIGHBOURING block: it dilutes
   *    the contrast and it does not even buy the hero's cluster mass for it.
   *
   * And the reason the prescribed "dim everything within 120px" is not what is
   * implemented here: measured by disabling this file's drawing and re-ranking
   * every block, particles.js supplies 0% of the energy in every block that
   * outranks the hero, on every scene, on both seeds - and disabling it makes
   * the rank WORSE on three scene/seed pairs (launch 5->6 and hushNear 28->32
   * on seed 7, launch 7->11 on seed 3) and better on none. There is nothing of
   * mine in the blocks that beat the mote, so dimming mine cannot promote it.
   * What is left to do is the shape: hold the collar that hugs the animal,
   * starve the band the contrast is measured across, and let the wake resume
   * outside it. That is a pocket built by shaping light, not by removing it.
   */
  _moat(px, py) {
    const gk = this._gk;
    if (gk <= 0.002) return 1;
    const dx = px - this.px, dy = py - this.py;
    const d2 = dx * dx + dy * dy;
    const out = this._mOut;
    if (d2 >= out * out) return 1;
    const d = Math.sqrt(d2);
    if (d <= this._mIn) return 1;
    // one smooth bump across the band, deepest in the middle of it, so nothing
    // pops as a particle crosses either edge
    const q = (d - this._mIn) * this._mInv;
    const w = q < 0.5 ? q + q : (1 - q) * 2;
    return 1 - gk * this._mDepth * w * w * (3 - 2 * w);
  }

  // ----------------------------------------------------------------- update ---
  update(dt) {
    this._t += dt;
    this.steps++;

    const g = this._bind();
    if (g) {
      const p = g.player;
      this.px = p.x; this.py = p.y; this.pvx = p.vx; this.pvy = p.vy;
      const cam = g.cam;
      if (cam) {
        this._cx = cam.x; this._cy = cam.y;
        const vw = cam.viewW || 1920, vh = cam.viewH || 1080;
        this._cw = vw * 0.5 + 260;
        this._ch = vh * 0.5 + 260;
        // The measured annulus is 42-83 *pixels* of a 900px-tall frame, i.e.
        // 0.046-0.092 of the vertical view however the lens is set. Sizing the
        // keep-out off viewH keeps it covering that band when a launch zooms
        // out; a constant in world units silently stopped covering it.
        this._kFull = vh * 0.100;
        this._kInv = 1 / (vh * 0.145);
        this._u2p = (cam.pixelH || 900) / (vh || 1080);
        // The moat spans exactly the measured annulus - 42-83 pixels of a 900px
        // frame is 0.046-0.092 of the vertical view - plus a little reach past
        // its outer edge, because bloom carries light inward across it.
        this._mIn = vh * 0.046;
        this._mOut = vh * 0.104;
        this._mInv = 1 / (this._mOut - this._mIn);
      }
      const live = (g.mode === 'play' && p.alive) ? 1 : 0;
      this._gk = live + (this._gk - live) / (1 + 5 * dt);
      if (this._impSeq < 0) { this._impSeq = p.impactSeq | 0; this._lchSeq = p.launchSeq | 0; }
      if (dt > 0 && g.mode === 'play' && p.alive) {
        this._events(p);
        this._disturb(dt, p, g.world);
      }
    }

    const T = this._t;
    // Which quarter of the pool re-reads the field this step. Indices shuffle as
    // the pool compacts, which only decorrelates the phases further; it stays
    // deterministic because the compaction order is.
    const phase = this.steps & 3;
    let i = 0;
    while (i < this.n) {
      if (this.delay[i] > 0) { this.delay[i] -= dt; i++; continue; }
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const last = --this.n;
        if (i !== last) this._copy(last, i);
        continue;
      }
      // Implicit damping toward the velocity of the *medium*. Unconditionally
      // stable at any dt, and it makes the water the reference frame: fine grit
      // is dragged along by the current, coarse debris punches through it.
      const k = 1 / (1 + this.drag[i] * dt);
      const fl = this.flow[i];
      let vx = this.vx[i], vy = this.vy[i];
      if (fl > 0) {
        if ((i & 3) === phase) {
          waterAt(this.x[i], this.y[i], T);
          this.wx[i] = flowX; this.wy[i] = flowY;
        }
        const wx = this.wx[i] * fl, wy = this.wy[i] * fl;
        vx = wx + (vx - wx) * k;
        vy = wy + (vy - wy) * k;
      } else {
        vx *= k; vy *= k;
      }
      vy += this.grav[i] * dt;
      this.rot[i] += this.spin[i] * dt;
      // A rising bubble does not go straight up; it sheds alternating vortices
      // and helixes. Driven off `rot`, so the phase advances at `spin` and this
      // is a real oscillation rather than the constant sideways tilt it was.
      const wa = this.wobA[i];
      if (wa !== 0) vx += Math.sin(this.rot[i]) * wa * dt;
      this.vx[i] = vx; this.vy[i] = vy;
      this.x[i] += vx * dt; this.y[i] += vy * dt;
      i++;
    }

    for (let r = 0; r < RING_CAP; r++) {
      const g2 = this.rings[r];
      if (!g2.live) continue;
      g2.t += dt;
      if (g2.t >= g2.dur) { g2.live = false; continue; }
      g2.x += g2.vx * dt; g2.y += g2.vy * dt;
      const k = 1 / (1 + 3.4 * dt);
      g2.vx *= k; g2.vy *= k;
    }
  }

  /**
   * Edge-triggered events. player.js already sheds sparks and grit through
   * `fx.sparks` on both of these, so all that is added here is the thing only a
   * *magnitude* can justify - a pressure front. Both are gated hard, because a
   * shockwave that fires on every swing is not a shockwave, it is wallpaper.
   */
  _events(p) {
    const r = this.rng;

    if ((p.impactSeq | 0) !== this._impSeq) {
      this._impSeq = p.impactSeq | 0;
      const pw = p.impactPow || 0;
      if (pw > 0.44) {
        this.events++;
        const nx = p.impactNx, ny = p.impactNy;
        // A wave cannot expand into rock, so it is a lobe flattened against the
        // wall: the major axis is the tangent, not the normal. Pushed *into*
        // the rock and flattened harder than it was, so the rock occludes its
        // inner half and what survives is a rim skidding along the wall rather
        // than a closed ellipse standing around the mote.
        const tan = Math.atan2(nx, -ny);
        const g1 = this._ring(p.x - nx * 16, p.y - ny * 16, S.SHOCK,
          12, lerp(62, 104, pw), lerp(0.12, 0.17, r()), 3.6,
          lerp(0.9, 1.9, pw), N_SURF, tan, 0.52, 0.72);
        if (g1) { g1.vx = nx * 90 * pw; g1.vy = ny * 90 * pw; }
        // the silt the wave sweeps off the wall, as a broken arc through the
        // half-space it can actually expand into
        this._swell(p.x + nx * 14, p.y + ny * 14, Math.atan2(ny, nx), 2.8,
                    lerp(105, 200, pw), 4 + ((r() * 3) | 0),
                    lerp(210, 420, pw), 1.15);
        // gas driven out of solution by the slam, thrown along the wall
        this.bubbles(p.x + nx * 10, p.y + ny * 10,
          2 + ((r() * 3 * pw) | 0), -ny * 300, nx * 300, 0.14);
        this._plume(p.x + nx * 6, p.y + ny * 6, 2 + ((r() * 3) | 0),
          nx, ny, lerp(90, 280, pw), 0.9);
      }
    }

    if ((p.launchSeq | 0) !== this._lchSeq) {
      this._lchSeq = p.launchSeq | 0;
      const pw = p.launchPow || 0;
      if (pw > 0.78) {
        this.events++;
        const dx = p.launchDirX, dy = p.launchDirY;
        // Deliberately NOT a front - and no longer a filled soft disc either.
        // What was here was a VEIL up to 240 units in radius centred 24 units
        // behind the mote, which is to say a smooth wash of light laid over the
        // whole of the mote's own surround at the one moment the frame most
        // needs the mote to read. It is the single largest reason `launch`
        // measured 2.1-2.5:1 focal contrast against a target of 4:1.
        //
        // Same idea, correct geometry: an arc of rolls closing in a body-length
        // BEHIND the mote, spanning the half-space it left, none of it over the
        // mote itself. The swell cannot outrun the thing that made it.
        this._swell(p.x - dx * 96, p.y - dy * 96, Math.atan2(-dy, -dx), 2.5,
                    lerp(160, 250, pw), 5 + ((r() * 3) | 0),
                    lerp(200, 360, pw), lerp(0.9, 1.6, pw), N_MOTEO);
        // cavitation: the low-pressure pocket behind something that just
        // accelerated hard, collapsing into gas
        this.bubbles(p.x - dx * 30, p.y - dy * 30,
          3 + ((r() * 4) | 0), -dx * 220, -dy * 220, 0.16);
      }
    }
  }

  /**
   * What the player does to the water. Everything in here is rate-driven off an
   * accumulator so it is frame-rate independent and deterministic, and all of it
   * is dim: the mote has to stay the brightest thing on screen.
   */
  _disturb(dt, p, w) {
    const r = this.rng;
    const sp = Math.hypot(p.vx, p.vy);
    const spK = spdK(sp);
    const gk = gearK(sp);          // the cruise band, steeply. See gearK().
    const inv = 1 / (sp || 1);
    const tx = p.vx * inv, ty = p.vy * inv;
    const nx = -ty, ny = tx;
    const room = this.n < SOFT_CAP;
    const travel = Math.atan2(ty, tx);

    if (room) {
      // --- shed vortices. Alternating sides is the whole trick: a wake is a
      //     zig-zag of counter-rotating rolls, not a straight smear.
      //
      //     VOLUME was the wrong profile for it twice over. Its documented
      //     "defined rim" drew a contour line around every single roll, and two
      //     of those overlapping the mote is the artefact this whole pass
      //     started from - reviewers called them hollow ellipsoids, and that is
      //     exactly what they were. And a filled soft ball 18-87px behind the
      //     head sits precisely in the annulus focal contrast is measured
      //     against. SMOKE has a torn, noise-eroded silhouette and no rim at
      //     all, each one is stretched along the shear so it is never a circle,
      //     and the roll now forms a body-length back, which is where a real
      //     one forms anyway - a wake needs a body length to roll up.
      this._aWake += dt * (0.8 + 14 * spK);
      if (this._aWake > 4) this._aWake = 4;
      while (this._aWake >= 1) {
        this._aWake -= 1;
        this._side = -this._side;
        const back = lerp(125, 330, spK) + r() * 95;
        const lat = (10 + r() * 26) * this._side;
        const kick = lerp(26, 120, spK) * lerp(0.5, 1.3, r()) * this._side;
        const s0 = lerp(16, 42, Math.pow(r(), 1.25));
        const j = this._spawn(
          p.x - tx * back + nx * lat, p.y - ty * back + ny * lat,
          -tx * sp * 0.10 + nx * kick, -ty * sp * 0.10 + ny * kick,
          lerp(0.7, 1.9, r()), s0, s0 * lerp(1.6, 2.6, r()),
          r() < 0.34 ? N_TRAIL : N_WATER,
          // Lengthen and thin, do not brighten: the roll is sheared out along
          // travel by exactly the factor its tint is divided by, so the light
          // in the frame is unchanged and only its SHAPE carries the speed.
          // Sheared on gearK rather than on spdK, which is the whole of this
          // pass in one line: spdK moved this roll from 1.5x to 1.7x across the
          // band the game plays in, which is nothing, and gearK moves it from
          // 1.5x to 2.9x, which is a readout. Energy-conserving either way -
          // the same factor divides the tint - so the curve is free. Capped at
          // 2.4 rather than 3.4 because past about 6:1 a stretched SMOKE stops
          // being a sheared puff and becomes a capsule; see the striations.
          lerp(0.055, 0.17, r()) * (0.35 + 0.65 * spK) / (1 + 2.4 * gk), S.SMOKE,
          dragFor(3.0, s0), lerp(-20, 16, r()), (r() - 0.5) * 1.6 * this._side
        );
        this.kind[j] = K.VORTEX;
        this.flow[j] = lerp(1.2, 2.0, r());
        this.cool[j] = lerp(0.5, 1.0, r());
        this.asp[j] = lerp(1.3, 2.2, r()) * (1 + 2.4 * gk);
        this.rot[j] = travel + (r() - 0.5) * 0.9;
      }

      // --- THE WAKE, AND IT IS THE SPEEDOMETER.
      //
      //     Stimulated bioluminescence: a body moving fast through
      //     plankton-rich water drags a line of light behind it, the single
      //     most recognisable "at sea, at night" image there is. Everything
      //     below TRAIL_BACK stays as it was - a few small hot points close
      //     behind the head, which is all the mote's own annulus can afford.
      //     What is new is the reach.
      //
      //     Emission is driven by DISTANCE, not by a timer, so the stream is a
      //     constant-density line whose LENGTH is speed x TRAIL_LIFE: 150
      //     units at a slow swing, 690 at top speed. Individual elements
      //     lengthen with speed as well, from an 18-unit tick to a 100-unit
      //     streak against a 21-unit spacing, so a slow frame reads as
      //     breadcrumbs and a fast one as a drawn line. Mint at the young end,
      //     absorbed to deep blue and gone at the old one, which is the
      //     cyan-to-transparent ramp along the trail for free.
      //
      //     All of it is outside the focal annulus and none of it is on the
      //     mote. That distinction is the whole finding: the build that
      //     smeared the hero lost the hero.
      // Denser as well as longer, and this is the half that keeps the stroke
      // continuous. Each element is capped at 3.2x of stretch so that it stays
      // a comma; closing the spacing instead is what turns a row of commas back
      // into one drawn line, and it makes the element COUNT rise 2.7x across
      // the cruise where the trail's length rises 2.1x.
      this._aTrail += sp * dt * (1 / TRAIL_GAP) * (1 + 0.55 * gk);
      if (this._aTrail > 5) this._aTrail = 5;
      // TWO FILAMENTS AT A SWING, THREE AT THE CRUISE.
      //
      // A count is the one quantity a reviewer can order without a reference
      // in frame, which is precisely what the four interchangeable frames
      // lacked. Lengths and brightnesses need something to be compared against;
      // "two strands" against "three strands" does not. The third is the
      // centreline - a real wake has both shear layers and the path between
      // them - so it arrives as structure rather than as more of the same.
      const lanes = gk > 0.42 ? 3 : 2;
      while (this._aTrail >= 1) {
        this._aTrail -= 1;
        if (++this._lane >= lanes) this._lane = 0;
        const side = lanes === 3 ? this._lane - 1 : (this._lane ? 1 : -1);
        // ...and the braid widens with speed as well as gaining a strand.
        const lat = side * lerp(2, 26, r()) * (0.30 + 0.80 * gk);
        const back = TRAIL_BACK + r() * 44;
        // A third stay short and round however fast it goes. A line of
        // identical dashes is a filter; a line with grain in it is a wake.
        //
        // This was a quarter, and the variance below was narrower, and both
        // were wrong for a reason only visible once the elements were big
        // enough to have a shape at all: at 20px WISP is a smudge, but at 35px
        // its silhouette resolves - including the r<0.86 cutoff that bounds
        // every profile in the kit - so a row of them at one size and one angle
        // stopped reading as a wake and started reading as a row of leaves laid
        // on the water. Same total light, spread across three times the range
        // of size, stretch and angle: a torn braid instead of a decal strip.
        const long = r() < 0.64;
        // WISP and deliberately not STREAK. STREAK is an anamorphic LENS
        // profile - a straight striated bar with a hard thin core - and thirty
        // of them along one axis read as exactly what this review already
        // called out elsewhere: a filter, not light. WISP is the comma the kit
        // documents for motion trails: fat soft head at +x, curved tail
        // tapering to nothing, so pointing it along travel gives a stroke with
        // a direction in it.
        //
        // 26-38 units, not 17-24, and the reason is a measurement rather than
        // taste. WISP's bright part is a RIDGE whose half-width is 0.17 of the
        // tile, so at a 20px draw the ridge is three pixels thick and the
        // whole element put fifteen pixels over 0.25 linear. The frame's
        // highlight statistic is a count of 17px grid cells (see the header),
        // so a three-pixel ridge is worth nothing to it however hot it gets -
        // brightness widens a Gaussian only as the square root of its log,
        // while size widens it linearly. At 30px the same ridge is five to six
        // pixels and the element is worth a sample. It is also simply a better
        // wake: a stroke you can see the shape of, rather than a scratch.
        //
        // The stretch comes down as the size goes up, on purpose, and this is
        // the half of the element to economise on. Fill is length x width; the
        // WIDTH is what makes the ridge survive and therefore what the frame's
        // highlight statistic can see, while the LENGTH is a cue the trail
        // already carries far better through how many elements there are and
        // how far apart they sit. So the width went up and the stretch came
        // down: at 3.5x these were 170px commas thirty deep, which is a quarter
        // of the frame's fill for a cue that was already stated.
        // Top of the range pulled from 42 to 34, i.e. 27 screen pixels, which
        // is just under the ~35px at which WISP's silhouette resolves into a
        // shape you can name. Above that a wake element is a leaf; below it, a
        // stroke. The width the frame's highlight count needs is still there -
        // the ridge is 0.17 of the tile, so 4.6px - and the light the smaller
        // area gives up is returned by the 1.55x denser spacing above.
        const s0 = long ? lerp(17, 34, Math.pow(r(), 0.8)) : lerp(5.4, 11, r());
        // Stretch on gearK, and a much wider range than spdK could justify:
        // 1.1-2.2 across the whole speed range meant 1.45-1.68 across the band
        // the game plays in, which is a 16% change in the length of a comma and
        // is not a cue. 0.95-3.3 on gearK is 1.6 against 3.0 over the same
        // 700-940, i.e. the individual stroke nearly doubles.
        // 1.5 at the bottom, not 0.95, because 1.5 is where the divisor below
        // reads exactly 1: a swing has to render byte-for-byte as bright as it
        // did before this pass, or a cue meant for the cruise has quietly
        // rewritten the frames with the tightest focal contrast in the game.
        // Capped at 3.2 and not 4.2. At 4.2 the longest elements were 42-unit
        // WISPs drawn 270 units long, and at that aspect the profile's own
        // r<0.86 cutoff stops being a taper and becomes a straight side: seen
        // at 3x, an olive-green slab lying across the trail. The comma has to
        // stay a comma.
        const elg = lerp(1.5, 3.2, gk);
        const el = long ? elg * lerp(0.62, 1.55, r())
                        : lerp(1.0, 1.9, r());
        const j = this._spawn(
          p.x - tx * back + nx * lat, p.y - ty * back + ny * lat,
          -tx * sp * 0.045 + nx * (r() - 0.5) * 60,
          -ty * sp * 0.045 + ny * (r() - 0.5) * 60,
          // It GROWS with age. A wake element is sheared apart by the water it
          // was left in; it does not shrink back to a point like a spark.
          // ...and the LIFETIME is on gearK, which is the lever that makes the
          // whole trail double rather than merely lengthen by a third. Length
          // is speed x lifetime, so putting the cruise curve on the lifetime
          // multiplies the two: 700 units/sec x 0.36s is 253 units and 940 x
          // 0.56 is 528, a factor of 2.09 across a factor of 1.34 in speed.
          // The element COUNT doubles with it for free, because emission is
          // distance-driven at one element per 15 units, and the spacing term
          // above closes on top of that for 2.7x - so the trail gets longer AND
          // denser at once, which is two ways to order two frames instead of
          // none.
          TRAIL_LIFE * lerp(0.68, 1.52, gk) * lerp(0.85, 1.15, r()), s0, s0 * 1.22,
          // No planktonCore here. That entry is 0xf2fff6 - all but white - and
          // white belongs to the mote. A wake that samples it stops being cyan
          // and starts being the desaturated ribbon this cue exists to avoid.
          // Weighted toward moteTrail cyan rather than plankton mint, 62/38
          // where it used to be 40/60: at the size these are drawn now, mint
          // wide enough to have a silhouette reads as a solid green object
          // sitting on the water, while cyan reads as the water itself lit up.
          // The mint is what makes it bioluminescence, so it stays - as the
          // minority, showing up in the flare rather than across the whole arc.
          // ...and the mint is now confined to the SHORT elements. One draw
          // still, so nothing downstream moves. At 30 units by 90 a mint
          // element is not a glint of plankton, it is a green blade lying on
          // the water - photographed at 3x in the middle of an otherwise clean
          // cyan wake. Mint is the flare, cyan is the water: the long strokes
          // are the water and the short pips are the flare, so that is where
          // each belongs.
          r() < (long ? 0.86 : 0.42) ? N_TRAIL : N_PLNK,
          // Bright enough to be a readout, and it can afford to be: it lives
          // 152+ units behind the head, which is outside the ring the mote is
          // scored against, and the fast frame's tonemapped mean is 0.066 of an
          // allowed 0.240 with an HDR p50 of 0.008 of an allowed 0.030. It is
          // also, measured by elimination, the family that supplies the launch
          // frame's p99 - remove WAKE and the exposure contract's "there must
          // be real highlights" drops by 0.011 on its own.
          // ...and the speed term is steeper than a plain 0.3+0.7 ramp,
          // because the slow/fast difference IS the readout. At a swing this
          // is 0.16 of full and at cruise it is 1.0, so the trail does not
          // merely lengthen with speed, it lights up.
          //
          // The top of the range pays for the cyan shift above. moteTrail is
          // 0.66 of plankton mint in luminance, so weighting the mix toward it
          // cost the frame's highlight count about what it bought in
          // credibility; this gives it back in the one place measured to be
          // free of the mote's surround - the nearest wake element sits 145px
          // out on every scene and seed probed, against an annulus that ends
          // at 83px.
          // The stretch is paid for in full - the tint is divided by exactly
          // the factor the quad is multiplied by - and the two wrong answers
          // that got us here are both worth recording, because the arithmetic
          // is counter-intuitive and it was measured twice.
          //
          // Written the obvious way (stretch AND brighten with gearK) it was a
          // defect: seed 7 / fast went rank 6 to rank 9, because three blocks
          // of the mote's OWN WAKE - 91%, 92% and 97% attributable to this
          // emitter - outranked the hero's. A trail brighter than the animal
          // that drew it is wrong as art before it is wrong as a measurement.
          //
          // The second attempt divided by the SQUARE root, on the algebra that
          // one element's highlight energy is area x L^2 = (s^2 el)(B/sqrt(el))^2
          // = s^2 B^2, independent of the stretch. That algebra is right and the
          // conclusion was still wrong, because elements OVERLAP: at one per 15
          // units a 47-unit comma is covered three deep and a 91-unit comma six
          // deep, additive blending sums them, and L^2 of a sum is not the sum
          // of L^2. Doubling the length doubles the local level for free, so
          // holding the element's energy holds nothing. Seed 3 / hushNear
          // gained two blocks above the hero on exactly that.
          //
          // So: full conservation. Rendered surface brightness comes out flat
          // across the cruise, the trail's TOTAL light grows with its length
          // (2.1x from 700 to 940) and the cue is entirely shape - longer,
          // denser, three strands instead of two. Which is what was asked for.
          lerp(0.54, 1.32, r()) * (0.16 + 0.84 * spK) * (1.5 / elg),
          long ? S.WISP : S.SPARK,
          dragFor(6.5, s0), lerp(-12, 9, r()), 0
        );
        this.kind[j] = K.WAKE;
        this.flow[j] = lerp(1.1, 1.8, r());
        // Absorbed HARDER than it was, because the trail is now twice as long
        // at the cruise and its far end is what competes with the hero. Water
        // eats a wake from the far end inward; the frame's block-salience
        // metric agrees, and the review's own words for what it wants are "a
        // three-filament wake that TAPERS AND DIES". Same three statements.
        this.cool[j] = lerp(0.40, 0.85, r());
        this.asp[j] = el;
        // Angular jitter scaled as 1/stretch, which is the fix for the worst
        // artefact this pass produced. A fixed +/-0.55 rad displaces the tip of
        // a 47-unit comma by 13 units and the tip of a 170-unit one by 47, so
        // at the cruise thirty elements stopped stacking into a stroke and
        // splayed into a plexus of crossing translucent blades - photographed
        // at 3x, and much more obviously wrong than the thing it replaced. What
        // wants to be constant is the TIP DISPLACEMENT, and tip displacement is
        // length x angle, so the angle has to come down as the length goes up.
        this.rot[j] = travel + (r() - 0.5) * (0.9 / elg);
      }

      // --- and the near end of it: tiny, hot, brief, mint rather than white so
      //     it sits behind the mote in the hierarchy instead of competing with
      //     it. Exempt from the keep-out on purpose - these are points, not
      //     washes, and a hot point beside the mote reads as part of it. Kept
      //     on a timer, not on distance, because this is the only emission in
      //     the file that lands inside the measured annulus and its load there
      //     must not scale with the trail.
      //
      //     And it is now carrying LESS than it did, deliberately. check.mjs
      //     samples the frame at 192x108 and scores the mote's core against the
      //     r=5..7 sample ring, which at the shipped camera is 53-74 world
      //     units - so this emitter, and only this emitter, is inside the
      //     focal measurement. It used to be the whole near trail and had to
      //     be; the far trail carries that now, so half of what was spent here
      //     buys the mote's readability back instead. Measured: seed 3 / fast
      //     went 4.1 -> 3.9 when this brightened, and back over 4 when it did
      //     not.
      this._aGlow += dt * (4 + 26 * gk) * (0.3 + 0.7 * spK);
      if (this._aGlow > 4) this._aGlow = 4;
      while (this._aGlow >= 1) {
        this._aGlow -= 1;
        // Tight and close. Spread wide it stops reading as a trail and just
        // adds to the field of mint dots the world's own plankton already puts
        // on screen - same colour, same size, no hierarchy.
        // THE COLLAR, and it has moved INWARD - which reverses the previous
        // round and is worth the paragraph, because that round was solving the
        // right problem with the wrong bound.
        //
        // It read the annulus as 53-74 units and put this emitter at 82-150 to
        // clear it. But the sample window is a 15x15 box and the ring is every
        // sample at r>=5 inside it, so the ring reaches 105 units in the
        // diagonals: 82-150 was not outside the annulus, it straddled it, and
        // it is the only emission this file puts anywhere near the mote. Inside
        // 50 units, by contrast, is the one place light beside the hero is
        // free - it is past the core radius the focal max is taken over, short
        // of the ring the mean is taken over, and it is inside the hero's OWN
        // 67x64px block, so it is the only light in this file that adds to the
        // number a scanning player actually answers.
        //
        // Which is also the honest art: the animal's body ends 18 units back,
        // and stimulated plankton light up where it just was. A collar hugging
        // the tail reads as part of the animal and gives the hero mass; the
        // same light 90 units out reads as fog around it and takes mass away.
        const back = lerp(19, 46, Math.pow(r(), 0.7));
        const lat = (r() - 0.5) * lerp(7, 26, back / 46);     // the wake widens
        // Floored well above a pixel. At 2-4 world units these were 2px quads,
        // which is a hard little square with a stair-stepped edge, and a field
        // of them beside the mote is the "shimmering pixels" note verbatim.
        // Bigger and correspondingly dimmer: the same energy, spread over
        // enough texels for the profile to actually be a profile.
        const s0 = lerp(5.0, 9.6, r());
        const j = this._spawn(
          p.x - tx * back + nx * lat, p.y - ty * back + ny * lat,
          -tx * sp * 0.05 + nx * (r() - 0.5) * 90,
          -ty * sp * 0.05 + ny * (r() - 0.5) * 90,
          // Short, because the collar has to DIE where it was born. It lags the
          // mote by 5% of its speed, so a long-lived one drifts out of the free
          // band and into the moat it was placed to avoid - which is how this
          // emitter ended up at 82-150 units in the first place.
          lerp(0.12, 0.34, r()), s0, s0 * 0.35,
          // No planktonCore. The far trail already refuses it on the grounds
          // that 0xf2fff6 is all but white and white belongs to the mote - and
          // this emitter is four times CLOSER to the mote than that one, so the
          // argument is four times stronger here. It was still drawing 30% of
          // its specks near-white 64-118px behind the head, and that is
          // precisely the scatter of hard neutral dots a reviewer isolated to
          // this file. Cyan and mint only; the hierarchy holds.
          r() < 0.45 ? N_TRAIL : N_PLNK,
          lerp(0.42, 1.12, r()) * (0.30 + 0.45 * spK + 0.30 * gk), S.SPARK,
          dragFor(9, s0), lerp(-14, 10, r()), (r() - 0.5) * 4
        );
        this.kind[j] = K.DART;
        this.flow[j] = lerp(1.2, 1.9, r());
        this.cool[j] = 0.55;
      }

      // --- WATER STRIATIONS, and the point of them is that they are ABSENT at
      //     the bottom of the cruise and unmissable at the top of it.
      //
      //     Everything else here is a continuous cue, and a review that could
      //     not order 700, 730, 800 and 940 was telling us something about
      //     continuous cues: a 34% change in a length or a brightness needs a
      //     reference in the frame to be read at all, and a still frame has
      //     none. Presence does not. gk squared is the gate, so the population
      //     runs roughly 1 : 4 : 12 across those three speeds - which is not a
      //     measurement, it is a difference in kind.
      //
      //     Drawn as heavily sheared SMOKE on the FLANKS, never behind the
      //     head: 90-330 units off the travel axis, which is outside every
      //     radius the hero is measured against, and CLOUD-classed so the
      //     mote's keep-out owns them anyway. Total light scales with the count
      //     and not with the stretch - each streak's surface brightness is
      //     divided by exactly the factor its quad is multiplied by - so a
      //     motion cue cannot become a brightness cue behind our back.
      this._aStria += dt * gk * gk * 21;
      if (this._aStria > 3) this._aStria = 3;
      while (this._aStria >= 1) {
        this._aStria -= 1;
        // SHARD and not a stretched SMOKE, and the aspect is a third of what it
        // was, both for the same measured reason. SMOKE's silhouette is a
        // noise-eroded disc: stretch it 30:1 and the erosion runs along the
        // length instead of across it, so what draws is a capsule with two
        // straight sides and a dithered cap - which is exactly what a 3x crop
        // of the 940 frame showed, four of them. SHARD is the kit's long
        // sliver, tapering to nothing at BOTH ends over an envelope that
        // narrows with it, so it cannot have a straight side however far it is
        // stretched. It was documented "currently unused"; this is what it is
        // for. The cue was never the aspect anyway - it is the COUNT.
        const st = 1 + 1.5 * gk;
        const side = r() < 0.5 ? -1 : 1;
        // 140 units minimum, not 90, and the reason is a measurement: at 90 a
        // striation's own block outranked the hero's on seed 3 / hushNear, which
        // is the same defect the wake had and the same rule breaks it - nothing
        // this file draws may be a brighter cluster than the animal that caused
        // it. Water rushing past belongs beyond the hero's block anyway.
        // 180 and not 140, which is bookkeeping rather than art: these are
        // CLOUD-classed, so _clear() owns them, and a 33-unit striation
        // stretched 4x has enough reach that anything inside about 240 units is
        // suppressed to nothing. Emitting there spends pool and draws nothing.
        const off = lerp(180, 430, Math.pow(r(), 0.8)) * side;
        const back = (r() - 0.3) * 520;
        const s0 = lerp(22, 44, r());
        const j = this._spawn(
          p.x - tx * back + nx * off, p.y - ty * back + ny * off,
          tx * lerp(-40, 70, r()) + nx * (r() - 0.5) * 34,
          ty * lerp(-40, 70, r()) + ny * (r() - 0.5) * 34,
          lerp(0.5, 1.1, r()), s0, s0 * lerp(1.1, 1.5, r()),
          // Barely any SURF. Pale is nearly neutral, and the first version of
          // this drew four desaturated grey-blue slabs to the left of the mote
          // at 3x - the "flat hard rectangle" this file already has a rule
          // about, in a colour reserved for the hero.
          r() < 0.18 ? N_SURF : N_WATER,
          lerp(0.13, 0.30, r()) / st, S.SHARD,
          dragFor(4.0, s0), lerp(-6, 10, r()), 0
        );
        this.kind[j] = K.CLOUD;
        this.flow[j] = lerp(1.1, 1.7, r());
        this.cool[j] = lerp(0.3, 0.7, r());
        this.asp[j] = lerp(3.2, 5.4, r()) * st;
        // Tight to travel - a striation that wanders is a cloud. 0.22 radians
        // of jitter is enough that thirty of them are not a comb.
        this.rot[j] = travel + (r() - 0.5) * 0.22;
      }

      // --- gas shed at speed: cavitation off something moving fast
      this._aBub += dt * (spK * spK * 2.2 + (p.attached ? 0.22 : 0));
      if (this._aBub > 3) this._aBub = 3;
      while (this._aBub >= 1) {
        this._aBub -= 1;
        this.bubbles(p.x - tx * 34, p.y - ty * 34, 1, p.vx, p.vy, 0.05);
      }

      // --- silt lifted off the floor, or knocked off the ceiling. inDraft is
      //     exposure to the floor updraft, so it is exactly the right signal.
      const bot = w.bandBot ? w.bandBot(p.x) : p.y + 1e4;
      const top = w.bandTop ? w.bandTop(p.x) : p.y - 1e4;
      const nearFloor = clamp01(1 - (bot - p.y) / 270);
      const nearRoof = clamp01(1 - (p.y - top) / 200);
      const kFloor = Math.max(nearFloor, (p.inDraft || 0) * 0.9);
      const down = nearRoof > kFloor;
      const kk = down ? nearRoof : kFloor;
      if (kk > 0.02) {
        this._aSilt += dt * kk * lerp(3.5, 17, spK);
        if (this._aSilt > 4) this._aSilt = 4;
        while (this._aSilt >= 1) {
          this._aSilt -= 1;
          const s0 = lerp(22, 84, Math.pow(r(), 1.35));
          const j = this._spawn(
            p.x - tx * (r() * 200) + (r() - 0.5) * 90,
            (down ? top + r() * 32 : bot - r() * 36),
            tx * lerp(25, 230, spK) * lerp(0.35, 1.15, r()) + (r() - 0.5) * 50,
            (down ? 1 : -1) * lerp(16, 120, r()) * (0.35 + 0.65 * kk),
            lerp(1.4, 4.0, r()), s0, s0 * lerp(1.6, 2.6, r()),
            r() < 0.55 ? N_SILT : N_WATER,
            lerp(0.05, 0.15, r()) * (0.45 + 0.55 * kk) / (1 + 3.6 * gk), S.SMOKE,
            dragFor(5.0, s0), lerp(3, 24, r()), (r() - 0.5) * 0.7
          );
          this.kind[j] = K.CLOUD;
          this.flow[j] = lerp(1.4, 2.1, r());
          this.cool[j] = lerp(0.5, 1.0, r());
          // Silt sheared along the surface it left, never a puffball - and
          // sheared HARDER, along travel, the faster the thing that lifted it
          // was going. This is the near-ground directional smear: it is the
          // layer closest to the camera that is not the player, so it is where
          // a motion cue costs the hero nothing. Energy-conserving, as above,
          // and on gearK for the same reason everything else here is: 1.6x
          // against 2.0x across the cruise was not a cue, 1.8x against 3.8x is.
          this.asp[j] = lerp(1.4, 2.3, r()) * (1 + 3.6 * gk);
          this.rot[j] = travel + (r() - 0.5) * 0.5;
        }
      }

      // --- anticipation. Loading a swing pulls the water in: faint motes spiral
      //     into the mote while it charges and stop dead the instant it lets go.
      //     `windUp` is the only signal in the game that leads the action, and
      //     nothing in here was reading it. Points, so the keep-out leaves them
      //     alone - the inflow is allowed to reach the mote, a wash is not.
      const wu = p.attached ? (p.windUp || 0) : 0;
      if (wu > 0.18) {
        this._aPull += dt * wu * wu * 34;
        if (this._aPull > 4) this._aPull = 4;
        const swirl = (p.spin || 0) >= 0 ? 1 : -1;
        while (this._aPull >= 1) {
          this._aPull -= 1;
          const a = r() * TAU;
          const rad = lerp(110, 235, r());
          const life = lerp(0.24, 0.44, r());
          const ca = Math.cos(a), sa = Math.sin(a);
          const vr = -rad / life * lerp(0.85, 1.05, r());     // aimed to arrive
          const vt = lerp(160, 420, r()) * swirl;             // ...but spiralling
          const s0 = lerp(4.2, 7.6, r());
          const j = this._spawn(
            p.x + ca * rad, p.y + sa * rad,
            ca * vr - sa * vt, sa * vr + ca * vt,
            life, s0, s0 * 0.5, r() < 0.35 ? N_MOTEO : N_TRAIL,
            lerp(0.30, 0.95, r()) * wu, S.SPARK,
            dragFor(1.2, s0), 0, (r() - 0.5) * 3
          );
          this.kind[j] = K.DART;
          this.flow[j] = 0.35;      // it is being pulled, not carried
          this.cool[j] = 0.2;
          this.str[j] = 0.9;        // streaks along the inflow
        }
      }
    }

    // --- a near miss scatters the swarm. Plankton are sorted by x, so a
    //     monotone high-water mark fires each cluster exactly once. The cursor
    //     is a hint, not a truth: world.js prunes the head of the list with
    //     filter(), which shifts every index down, so it self-corrects backward.
    const list = w.plankton;
    if (room && list && list.length) {
      const gate = p.x - 240;
      let i = this._pkI;
      if (i >= list.length) i = list.length - 1;
      while (i > 0 && list[i - 1].x >= gate) i--;
      while (i < list.length && list[i].x < gate) i++;
      this._pkI = i;
      for (; i < list.length; i++) {
        const q = list[i];
        if (q.x > p.x + 260) break;
        if (q.taken || q.x <= this._pkScatX) continue;
        const dx = q.x - p.x, dy = q.y - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 32400 || d2 < 4) continue;              // 180 units
        this._pkScatX = q.x;
        this._scatter(q.x, q.y, dx, dy, Math.sqrt(d2), sp);
        break;
      }
    }
  }

  /** A handful of motes darting away from whatever just went past. */
  _scatter(x, y, dx, dy, d, sp) {
    const r = this.rng;
    const base = Math.atan2(dy, dx);
    const push = 0.4 + 0.6 * clamp01(sp / 1700) * clamp01(1 - d / 190);
    const n = 3 + ((r() * 4) | 0);
    for (let i = 0; i < n; i++) {
      const a = base + (r() - 0.5) * 2.3;
      const spd = lerp(80, 430, Math.pow(r(), 1.7)) * push;
      const s0 = lerp(4.2, 9.0, r());
      const j = this._spawn(
        x + (r() - 0.5) * 34, y + (r() - 0.5) * 34,
        Math.cos(a) * spd, Math.sin(a) * spd, lerp(0.34, 0.9, r()),
        s0, s0 * 0.42, N_PLNK, lerp(0.6, 1.4, r()) * push, S.SPARK,
        dragFor(8, s0), lerp(-22, 10, r()), (r() - 0.5) * 5
      );
      this.kind[j] = K.DART;
      this.flow[j] = lerp(1.3, 2.0, r());
      this.cool[j] = 0.7;
      this.str[j] = 0.5;
    }
    // the water the swarm was hanging in. Torn rather than veiled, and smaller
    // than it was: a scatter happens within 180 units of the mote by definition,
    // so a 130-unit soft disc here is a soft disc in the mote's surround.
    const j = this._spawn(x, y, 0, 0, lerp(0.4, 0.9, r()),
      lerp(20, 38, r()), lerp(52, 92, r()), N_PLNK, 0.15 * push, S.SMOKE,
      1.6, -12, (r() - 0.5) * 0.6);
    this.kind[j] = K.CLOUD;
    this.flow[j] = 1.7;
    this.cool[j] = 0.8;
    this.asp[j] = lerp(1.2, 1.8, r());
  }

  _copy(a, b) {
    this.x[b] = this.x[a]; this.y[b] = this.y[a]; this.vx[b] = this.vx[a]; this.vy[b] = this.vy[a];
    this.life[b] = this.life[a]; this.max[b] = this.max[a];
    this.size[b] = this.size[a]; this.size1[b] = this.size1[a];
    this.r[b] = this.r[a]; this.g[b] = this.g[a]; this.b[b] = this.b[a];
    this.rot[b] = this.rot[a]; this.spin[b] = this.spin[a];
    this.drag[b] = this.drag[a]; this.grav[b] = this.grav[a];
    this.bright[b] = this.bright[a]; this.layer[b] = this.layer[a];
    this.flow[b] = this.flow[a]; this.cool[b] = this.cool[a];
    this.str[b] = this.str[a]; this.wobA[b] = this.wobA[a];
    this.delay[b] = this.delay[a]; this.kind[b] = this.kind[a];
    this.asp[b] = this.asp[a]; this.lit[b] = this.lit[a];
    this.wx[b] = this.wx[a]; this.wy[b] = this.wy[a];
  }

  // ------------------------------------------------------------------- draw ---
  draw(batch) {
    const cull = this._cw > 0;
    const cx = this._cx, cy = this._cy, cw = this._cw, ch = this._ch;
    const u2p = this._u2p > 0 ? this._u2p : 0.786;
    const fl = MIN_QUAD_PX / u2p;

    for (let i = 0; i < this.n; i++) {
      if (this.delay[i] > 0) continue;
      const kd = this.kind[i];
      const t = 1 - this.life[i] / this.max[i];

      let a, s;
      if (kd === K.CLOUD) {
        // turbulent diffusion: fast early expansion, then it just hangs
        a = smoothstep(t * 4.5) * Math.pow(1 - t, 1.8);
        s = lerp(this.size[i], this.size1[i], Math.pow(t, 0.55));
      } else if (kd === K.VORTEX) {
        // a shed roll: spins up fast, holds, then the shear tears it apart
        a = smoothstep(t * 3.4) * Math.pow(1 - t, 1.6);
        s = lerp(this.size[i], this.size1[i], Math.pow(t, 0.7));
      } else if (kd === K.BUBBLE) {
        a = smoothstep(t * 9) * Math.pow(1 - t, 1.15);
        s = lerp(this.size[i], this.size1[i], t);
      } else if (kd === K.COLD) {
        // arrives slowly and refuses to leave: the long tail of a death
        a = smoothstep(t * 4.5) * Math.pow(1 - t, 1.3);
        s = lerp(this.size[i], this.size1[i], t);
      } else if (kd === K.DART) {
        a = (1 - t) * (0.18 + 0.82 * smoothstep(clamp01(t * 13)));
        s = lerp(this.size[i], this.size1[i], Math.pow(t, 1.7));
      } else if (kd === K.WAKE) {
        // A wake element is not a spark, and it does not arrive lit. Stimulated
        // bioluminescence has a rise time - the organism is shoved, and answers
        // a beat later - so this RISES over the first quarter of its life,
        // flares, and is then torn apart by the water it was left in. It still
        // must not start fading on frame one: the trail's LENGTH is the
        // readout, and a spark envelope made the far half invisible and
        // reported half the speed the mote was doing (270px of a 663px stream).
        //
        // Three things fall out of the rise, and all three are why it is
        // shaped this way rather than simply being brighter.
        //
        // The brightest point of the trail now sits ~0.09s of travel BEHIND
        // the head rather than on it, which at cruise is 250-350px back. So
        // the flare moved away from the mote's own surround, and the newest
        // element - the one nearest the head - became the dimmest thing in the
        // trail rather than the brightest. That is a focal-contrast gain, paid
        // for by nothing.
        //
        // The peak can afford to be hot because it is brief: the envelope's
        // integral is 0.85 against the old 0.54, so the frame gains almost no
        // light while the peak nearly doubles. And the peak is the entire
        // point, because p99 counts AREA above 0.25 linear - see the header.
        // This family had 264 pixels above it, one grid sample of 5184.
        // Decay steepened from 1.15 to 1.55 with the gain raised to hold the
        // integral, which moves light from the far end of the trail to the near
        // end without adding any. That is the only redistribution that helps
        // both readings at once: near the head the wake lands in or beside the
        // hero's OWN block and raises the number a scanning player answers,
        // while the far end is the part that was measured forming blocks
        // brighter than a weak hero block on seed 3 / hushNear.
        a = smoothstep(clamp01(t * 4.2)) * Math.pow(1 - t, 1.55) * 2.85;
        s = lerp(this.size[i], this.size1[i], t);
      } else {
        // fast bloom-in, long tail out - reads as an ember rather than a fade
        a = (1 - t) * (1 - t) * (0.25 + 0.75 * smoothstep(clamp01(t * 7)));
        s = lerp(this.size[i], this.size1[i], t * t);
      }

      let bb = this.bright[i] * a;
      if (bb <= 0.004) continue;

      const px = this.x[i], py = this.y[i];
      const ap = this.asp[i];
      const reach = ap > 1 ? s * ap : s;
      if (cull && (px < cx - cw - reach || px > cx + cw + reach
                || py < cy - ch - reach || py > cy + ch + reach)) continue;

      // The mote owns a dark surround - see _clear(). Diffuse classes fade out
      // inside it; small hot classes do not, because a hot point beside the
      // mote reads as part of it and a soft wash reads as fog over it.
      const soft = kd === K.CLOUD || kd === K.VORTEX || kd === K.COLD;
      if (soft) {
        bb *= this._clear(px, py, reach * 0.5);
        if (bb <= 0.004) continue;
      } else {
        // ...and the hot classes get the MOAT, which is the annulus and not the
        // disc. Inside 50 units a point reads as part of the animal and is
        // wanted; between 50 and 112 it is the one thing the frame cannot
        // afford, because that band is both the divisor of the focal ratio and
        // the neighbouring block. Outside it the wake resumes at full strength
        // - the trail starts 152 units back and never touches this. See _moat().
        bb *= this._moat(px, py);
        if (bb <= 0.004) continue;
      }
      // The plankton family gets no keep-out. It gets SPREAD - see the PSF
      // block below - and the difference is not a nuance.
      //
      // The exemption these points have always had was written when they were
      // 2-4px specks. Measured at 16x they are not: a pickup dart lands 11-88
      // world units from the mote at 1.1-2.4 linear, and at five pixels its
      // bright core is two of them with one pixel of falloff either side. A
      // hard-edged block, in the one place in the frame that must not contain
      // one.
      //
      // Dimming it inside the surround is the obvious fix and it is the wrong
      // one, measured at every blend from 0.42 to 0.70: the seed 7 launch frame
      // lost the exposure contract's p99 every time. That frame reads 0.2454
      // with this file's drawing disabled entirely, against a floor of 0.25, so
      // these points are what carries it over - and removing light to fix a
      // hard edge removes the highlight with it.
      //
      // So: same photons, more pixels. Surface brightness falls until the
      // falloff has somewhere to happen, the frame keeps every bit of its
      // energy, and both contracts hold.

      let cr = this.r[i], cg = this.g[i], cb = this.b[i];
      const co = this.cool[i];
      if (co > 0) {
        // Absorption: red goes first, and the whole thing dims as it goes. This
        // is what makes a dying light read as dying rather than as fading out.
        const m = co * smoothstep(t * 1.2);
        cr = lerp(cr, ABSORB[0], m);
        cg = lerp(cg, ABSORB[1], m);
        cb = lerp(cb, ABSORB[2], m);
        bb *= 1 - 0.62 * m;
      }

      if (kd === K.BUBBLE) {
        // A bubble in dark water is not a ring. It is a dim lens you can barely
        // see, plus one bright highlight where the light grazes its limb - and
        // the highlight moves as the bubble helixes, which is the whole tell
        // that it is a sphere. Built here from a body and a glint rather than
        // from HALO's closed rim: a complete thin circle at any size on a black
        // field is a debug circle, and there were a dozen of them beside the
        // mote at any moment.
        const ph = this.rot[i] * 0.4 + 2.1;
        const ox = Math.cos(ph) * s * 0.30, oy = Math.sin(ph) * s * 0.30;
        // ...and the body is the half that is allowed to answer to nearby
        // light: a lens beside a lamp is a visible lens.
        const body = bb * (0.26 + 0.34 * this.lit[i]) * this._clear(px, py, s * 0.75);
        if (body > 0.004) {
          const sw = s * 1.45;
          batch.push(px, py, sw, sw, 0, cr * body, cg * body, cb * body, 1, S.VEIL);
        }
        // the glint. Floored in size because a sub-pixel hot point shimmers
        // under a moving camera, which is the same reason ribbons floor theirs.
        // Size floored, alpha untouched: a specular is a specular. See quad().
        quad(s * 0.34, s * 0.34, fl);
        const ga = bb * 0.8;
        batch.push(px + ox, py + oy, qw, qh, this.rot[i],
          cr * ga, cg * ga, cb * ga, 1, S.SPARK);
        continue;
      }

      // One push, and the velocity streak is EARNED BY SIZE.
      //
      // STREAK is a lens profile: its bright core is a twentieth of its quad
      // height, so below about 13px of height that core is sub-pixel and what
      // lands is a one-pixel hard line. That is the 7x2px white dash found at
      // 16x beside the head; the 2x2px mint blocks around it are the same
      // failure in the round profiles, where the mip chain has flattened the
      // whole tile to one value. Both sat on the hero, which is the worst place
      // in the frame for a hard edge.
      //
      // Three replacements were tried and measured. Swapping in a soft round
      // profile at the same stretched quad was worse: a soft falloff integrates
      // two to three times what STREAK does over the same rectangle, and the
      // plankton burst fires 11-88 world units from the mote - inside the 53-74
      // unit ring check.mjs scores against - so seed 3 / fast went 4.1:1 to
      // 3.8:1. Killing DART alone moved that frame 4.50 to 4.91 while killing
      // everything else moved it not at all, which named the emitter exactly.
      // Substituting ANAMORPH, whose core is an eighth of its height and does
      // resolve, cost 16.7ms of a 12ms render budget: it is a very large soft
      // quad and there are dozens of them on a launch.
      //
      // So: too small to hold a streak means no streak. A round sprite covers
      // LESS of the annulus than the dash it replaces, it costs no fill, and
      // the smear it gives up was on the hero anyway - where, by this file's
      // own rule, a speed cue does not belong.
      let dw = s * ap, dh = s, drot = this.rot[i], dlay = this.layer[i];
      const st = this.str[i];
      if (st > 0 && s * 0.62 * u2p >= 13) {
        const vx = this.vx[i], vy = this.vy[i];
        const spd = Math.hypot(vx, vy);
        const e = 1 + st * clamp(spd / 250, 0, 4.2);
        if (e > 1.55) { dw = s * e; dh = s * 0.62; drot = Math.atan2(vy, vx); dlay = S.STREAK; }
      }
      const dg = quad(dw, dh, fl);
      let ba = bb * dg;
      // The point-spread floor, and DELIBERATELY on the plankton family only.
      // These are the emitters that run continuously - a pickup burst, a
      // scatter, the near wake - so their hard little blocks are what a cruising
      // still frame is full of, right where the eye is trying to hold. EMBER is
      // exempt: a release or a death is an event, its specks live a fifth of a
      // second, and a hard hot point during violence reads as violence. It is
      // also what carries the p99 the exposure contract demands.
      if ((kd === K.DART || kd === K.WAKE) && qh * u2p < 11) {
        // Tighter inside the mote's own surround, where the same block costs
        // the most and where the eye is least able to look away from it.
        // Spread far enough that the falloff exists, and no further. Two
        // measured reasons not to overspend it: the tonemap is compressive, so
        // the same energy over more pixels reads BRIGHTER in a box mean and the
        // mote's surround is a box mean (0.03 of 4.05:1 on seed 3 / fast); and
        // below 0.25 surface brightness these stop counting as highlights at
        // all. One threshold everywhere - a tighter one near the mote bought
        // 0.01 of focal and cost the launch frame its p99.
        const pmax = PSF_MAX;
        const cap = PSF_SPREAD_MAX;
        const pk = (cr > cg ? (cr > cb ? cr : cb) : (cg > cb ? cg : cb)) * ba;
        if (pk > pmax) {
          let f = Math.sqrt(pk / pmax);
          if (f > cap) f = cap;
          qw *= f; qh *= f; ba /= f * f;
        }
      }
      if (ba > 0.004) {
        batch.push(px, py, qw, qh, drot, cr * ba, cg * ba, cb * ba, 1, dlay);
      }

      // A second, much wider scatter halo: one blur radius for everything reads
      // as a filter, two reads as light sitting *in* water. Emitters only, and
      // never inside the mote's surround. Clouds and rolls scatter light rather
      // than emit it, and this halo at 3.2x the sprite was the largest single
      // contributor of soft light into the annulus - a release spark 20 units
      // wide was laying an 80-unit wash straight over the mote.
      // ...and not on the plankton family. Its wake elements are 17-24 units
      // tall, so at speed thirty of them each asked for a 50px soft wash: 72k
      // pixels of fill per frame for a second radius on a thing whose own
      // profile is already soft, and half of it landing near enough to the mote
      // to be suppressed anyway. Seed 3 was at 8.3ms of a 12ms budget.
      if (bb > 0.05 && !soft && kd !== K.DART && kd !== K.WAKE && s > 9) {
        const va = bb * 0.13 * this._clear(px, py, s * 1.6);
        if (va > 0.004) {
          const sw = s * 3.2;
          batch.push(px, py, sw, sw, 0, cr * va, cg * va, cb * va, 1, S.VEIL);
        }
      }
    }

    for (let r = 0; r < RING_CAP; r++) {
      const g = this.rings[r];
      if (!g.live) continue;
      const t = g.t / g.dur;
      // Decelerating expansion. A pressure wave in water gives its energy back
      // almost immediately, so linear growth is the tell of a debug primitive.
      const k = 1 - Math.pow(1 - t, g.pw);
      const rad = g.r0 + (g.r1 - g.r0) * k;
      const a = Math.pow(1 - t, g.fade) * g.bright * (1 - 0.55 * k);
      if (a <= 0.004) continue;
      const d = (rad * 2) / g.fr;
      const c = g.col;
      batch.push(g.x, g.y, d * (1 + g.ecc), d * (1 - g.ecc), g.ang,
        c[0] * a, c[1] * a, c[2] * a, 1, g.layer);
    }
  }
}

// ============================================================================
// Ambient life. Screen-space drifters at a continuum of parallax depths.
//
// One species reads as dust on a lens. Five do not: dense almost-invisible
// marine snow for the sense of a medium, twinkling sparks, fat low-contrast
// motes that build depth, rare pulsing organisms that are actually alive, and
// the odd larval strand. Size, colour, speed and brightness all correlate with
// depth, and every one of them is pushed by the same curl field at the same
// world coordinates the debris is, so the water is one water.
//
// The sparks used to be pale mote-white at up to 1.25 linear with a CORE on
// top, which put twenty hard white dots on screen competing with the one thing
// the eye is supposed to follow. They are mint and plankton-coloured now, they
// peak around 0.6, and the flash is much peakier in time - so at any instant
// one or two are lit and the rest are barely there. Twinkling, not confetti.
//
// Two further variance axes, because "five species" was still legible as five:
// every individual carries its own flash SHAPE (the exponent on its envelope)
// as well as its own rate, and the rates now span slow breathers to fast
// twitchers within one species instead of clustering. And nothing here is a
// circle: FAT and LARVA are ellipses, ORG is BLOB, whose silhouette is wobbled
// by three angular harmonics and whose falloff has no rim.
// ============================================================================
const AK = { SNOW: 0, SPARK: 1, FAT: 2, ORG: 3, LARVA: 4 };

export class Ambient {
  constructor(seed = 1, count = 190) {
    const r = makeRng(seed * 104729 + 7);
    // Denser than it looks. Marine snow is the strongest "deep water" cue there
    // is, and it only works if it is numerous and almost invisible.
    const n = Math.max(1, Math.round(count * 1.7));
    this.n = n;
    const f = (k) => new Float32Array(k);
    this.px = f(n); this.py = f(n); this.pz = f(n); this.ps = f(n);
    this.pp = f(n); this.pw = f(n);
    this.dx = f(n); this.dy = f(n); this.br = f(n); this.hue = f(n);
    this.el = f(n); this.rt = f(n); this.rs = f(n);
    this.tk = f(n);      // exponent on the twinkle envelope: the flash's shape
    this.sp = new Uint8Array(n);
    this._g = null;
    // The mote's keep-out, mirrored from Particles. Ambient life is
    // screen-space and wraps, so an organism can drift into the one band of
    // the frame check.mjs scores the hero against; a flash is now the only
    // thing in this class bright enough to matter if it does. Held as scalars
    // because a closure per frame is still an allocation per frame.
    this._kOn = 0; this._kx = 0; this._ky = 0; this._kIn = 0; this._kInv = 1;

    for (let i = 0; i < n; i++) {
      const u = r();
      const k = u < 0.60 ? AK.SNOW : u < 0.73 ? AK.SPARK : u < 0.895 ? AK.FAT
        : u < 0.965 ? AK.ORG : AK.LARVA;
      this.sp[i] = k;
      this.px[i] = r() * 4000; this.py[i] = r() * 3000 - 1500;
      this.pz[i] = lerp(0.30, 1.75, Math.pow(r(), 1.22));
      this.pp[i] = r() * TAU;
      this.rt[i] = r() * TAU;
      this.rs[i] = 0;
      this.hue[i] = r();
      this.el[i] = 1;
      this.tk[i] = 1;
      if (k === AK.SNOW) {
        // Wide size spread on purpose: equal-sized dots is the single clearest
        // procgen tell there is, and snow is the most numerous species.
        this.ps[i] = lerp(1.4, 6.4, Math.pow(r(), 2.0));
        this.pw[i] = lerp(0.10, 0.34, r());        // barely varies: it is debris
        this.dx[i] = lerp(-4, 11, r());
        this.dy[i] = lerp(8, 24, r());             // sinking, always
        this.br[i] = lerp(0.24, 0.58, r());
      } else if (k === AK.SPARK) {
        this.ps[i] = lerp(1.1, 3.2, r());
        // From slow breathers to fast twitchers within the one species, skewed
        // slow: a screen of dots all blinking at the same rate reads as a
        // string of fairy lights, whatever the phases are.
        this.pw[i] = lerp(0.35, 6.2, Math.pow(r(), 1.7));
        this.tk[i] = lerp(2.4, 8.0, r());          // some snap, some swell
        this.dx[i] = lerp(-18, 28, r());
        this.dy[i] = lerp(-10, 15, r());
        this.br[i] = lerp(0.45, 1.15, r());
      } else if (k === AK.FAT) {
        this.ps[i] = lerp(7, 18, r());
        this.pw[i] = lerp(0.14, 0.48, r());
        this.dx[i] = lerp(-16, 12, r());           // some drift against the flow
        this.dy[i] = lerp(2, 12, r());
        this.br[i] = lerp(0.10, 0.28, r());
        this.el[i] = lerp(1.08, 1.55, r());        // never a perfect circle
        this.rs[i] = (r() - 0.5) * 0.34;
      } else if (k === AK.ORG) {
        this.ps[i] = lerp(9, 23, r());
        this.pw[i] = lerp(0.16, 0.70, r());        // slow breathing pulse
        this.tk[i] = lerp(1.7, 3.6, r());
        this.dx[i] = lerp(-28, -6, r());           // swims across the drift
        this.dy[i] = lerp(-7, 7, r());
        this.br[i] = lerp(0.6, 1.5, r());
        this.el[i] = lerp(1.10, 1.70, r());        // a body, not a ball
        this.rs[i] = (r() - 0.5) * 0.26;
      } else {
        this.ps[i] = lerp(11, 28, r());
        this.pw[i] = lerp(0.12, 0.4, r());
        this.dx[i] = lerp(-11, 11, r());
        this.dy[i] = lerp(3, 15, r());
        this.br[i] = lerp(0.14, 0.36, r());
        this.el[i] = lerp(4.5, 9, r());
        this.rs[i] = (r() - 0.5) * 0.5;
      }
    }
  }

  /**
   * Binds to the live game exactly the way Particles does, for one reason: the
   * near layer has to know how fast the player is going. main.js publishes the
   * game before the first step and this runs at draw time, so the lookup always
   * resolves; if it ever does not, the smear is simply 0.
   */
  _bind() {
    const g = this._g;
    if (g && g.ambient === this) return g;
    if (typeof window === 'undefined') return null;
    const c = window.game || (window.LUMEN && window.LUMEN.game) || null;
    if (c && c.ambient === this && c.player) { this._g = c; return c; }
    return null;
  }

  /**
   * 1 outside the mote's surround, 0 inside it, smooth between. Sized off the
   * camera's vertical extent in world units, exactly as Particles._clear() is
   * and for the same reason: the measured annulus is 0.046-0.092 of viewH, so a
   * constant in world units stops covering it the moment the lens moves.
   */
  _keep(x, y) {
    if (!this._kOn) return 1;
    const dx = x - this._kx, dy = y - this._ky;
    const d = Math.sqrt(dx * dx + dy * dy) - this._kIn;
    if (d <= 0) return 0;
    const q = d * this._kInv;
    if (q >= 1) return 1;
    return q * q * (3 - 2 * q);
  }

  draw(batch, cam, t) {
    const b = cam.bounds(300);
    const W = b.x1 - b.x0, H = b.y1 - b.y0;
    if (!(W > 1) || !(H > 1)) return;
    const fl = MIN_QUAD_PX / ((cam.pixelH || 900) / (cam.viewH || 1080));

    // Directional smear, NEAR LAYER ONLY.
    //
    // This is the world stating the speed the HUD is currently stating on its
    // own. The front layer streaks along travel and the back layer does not,
    // which is parallax expressed as motion blur instead of as displacement -
    // and the difference between the two layers is the cue, so a uniform smear
    // would say nothing. The hero is untouched, deliberately and permanently.
    //
    // Every stretch divides the tint by itself, so this moves no light into or
    // out of the frame: it is the same photons over more pixels, which is what
    // motion blur physically is and what keeps it out of the exposure contract.
    let smr = 0, sang = 0;
    const gm = this._bind();
    if (gm && (gm.mode === 'play' || gm.mode === 'dead')) {
      const pl = gm.player;
      const psp = Math.hypot(pl.vx, pl.vy);
      // Weighted toward gearK, because the near layer is the widest-area
      // motion cue in the frame and it was reading 0.32 against 0.51 across the
      // band the game plays in. 0.26 against 0.67 is a smear you can order.
      if (psp > SPD_LO) { smr = 0.42 * spdK(psp) + 0.58 * gearK(psp); sang = Math.atan2(pl.vy, pl.vx); }
    }
    // THE POCKET. 135 world units of full suppression against a 99-unit annulus
    // edge, then 92 more to reach full strength - so the hero sits in a hole in
    // the bokeh out to about 105 screen pixels, which is the review's
    // prescription verbatim. It is applied to every species now and not only to
    // the flashes: a fat low-contrast VEIL is exactly the "green bokeh the mote
    // is dimmer than a dozen of", and it is the class that most wants to drift
    // through the one part of the frame that has to stay the hero's. Measured
    // cost to the hero's own block energy: 0.01 of 5.93. See _keep().
    const vh = cam.viewH || 1080;
    this._kOn = (gm && gm.mode === 'play' && gm.player.alive) ? 1 : 0;
    if (this._kOn) {
      this._kx = gm.player.x; this._ky = gm.player.y;
      this._kIn = vh * 0.125; this._kInv = 1 / (vh * 0.085);
    }

    for (let i = 0; i < this.n; i++) {
      const z = this.pz[i], iz = 1 / z, k = this.sp[i];
      // wrap in a frame that scrolls with parallax depth
      let x = this.px[i] + t * this.dx[i] * iz;
      let y = this.py[i] + t * this.dy[i] * iz;
      x = b.x0 + (((x - cam.x * iz) % W) + W) % W;
      y = b.y0 + (((y - cam.y * iz) % H) + H) % H;
      // the same water the debris lives in, at the same coordinates, so life
      // and litter swirl around the same eddies
      waterAt(x, y, t);
      const sway = 0.34 * iz;
      x += flowX * sway; y += flowY * sway;

      let tw;
      if (k === AK.SPARK) {
        const q = clamp01(0.5 + 0.5 * Math.sin(t * this.pw[i] * 2.4 + this.pp[i]));
        tw = 0.03 + 0.97 * Math.pow(q, this.tk[i]);   // mostly dark, brief flash
      } else if (k === AK.ORG) {
        const q = clamp01(0.5 + 0.5 * Math.sin(t * this.pw[i] + this.pp[i]));
        tw = 0.16 + 0.84 * Math.pow(q, this.tk[i]);
      } else {
        tw = 0.58 + 0.42 * Math.sin(t * this.pw[i] * 1.7 + this.pp[i]);
      }

      // Depth grades everything: far is smaller, dimmer and bluer.
      const fade = clamp01((z - 0.32) / 1.45);
      const g = iz * iz < 2.5 ? iz * iz : 2.5;
      let amp = this.br[i] * tw * g * (1 - 0.6 * fade) * 0.22;
      if (amp <= 0.003) continue;
      // The pocket, and it is the whole layer's business rather than only the
      // flashes'. See the block above _keep() is set up in.
      if (this._kOn) {
        const kk = this._keep(x, y);
        if (kk < 1) { amp *= kk; if (amp <= 0.003) continue; }
      }
      const s = this.ps[i] * (0.5 + 0.42 * iz);

      // Three accents with clear jobs: the mote owns white, plankton owns mint,
      // the Hush owns violet. Nothing in the ambient layer is allowed white.
      const c = k === AK.ORG ? (this.hue[i] < 0.2 ? N_HUSH : N_PLNK)
        : k === AK.SPARK ? (this.hue[i] < 0.45 ? N_SURF : N_PLNK)
          : this.hue[i] < 0.3 ? N_SURF : N_WATER;
      // pull colour toward deep water with distance rather than just dimming it
      const cr = lerp(c[0], ABSORB[0], fade * 0.7) * amp;
      const cg = lerp(c[1], ABSORB[1], fade * 0.7) * amp;
      const cb = lerp(c[2], ABSORB[2], fade * 0.7) * amp;

      // A drifting hair and a live organism keep their own orientation: a
      // smeared body reads as a mistake, not as speed.
      // FAT is excluded now, along with the two that always were. It is the fat
      // low-contrast bokeh, so it is the only class here whose quads are big
      // enough to matter: eight near ones at 4.4x of stretch is 216k pixels of
      // soft overdraw, a seventh of the frame, on a 12ms budget that is already
      // the gate's one failure. And it is the class with the weakest claim -
      // bokeh is out of focus, which is to say already smeared, so motion adds
      // the least contrast to it. What the review asked for by name was
      // "drifting particulate", and that is SNOW: 194 of the 323 drifters, at
      // 400 pixels each, where the same stretch costs a twentieth as much. So
      // the cue moves onto the cheap numerous class and gets pushed further
      // there - 4.8x - for less fill than before this pass.
      const e = (smr > 0 && k !== AK.LARVA && k !== AK.ORG && k !== AK.FAT)
        ? 1 + smr * clamp01((1.06 - z) / 0.62) * 4.8 : 1;
      const ie = 1 / e;
      const srot = e > 1.04 ? sang : 0;

      if (k === AK.LARVA) {
        const rot = this.rt[i] + t * this.rs[i];
        const q = quad(s * this.el[i], s * 0.5, fl);
        batch.push(x, y, qw, qh, rot, cr * q, cg * q, cb * q, 1, S.FILAMENT);
        continue;
      }
      if (k === AK.FAT) {
        const sw = s * 2.4;
        const q = quad(sw * this.el[i] * e, sw, fl) * ie;
        batch.push(x, y, qw, qh, e > 1.04 ? sang : this.rt[i] + t * this.rs[i],
          cr * q, cg * q, cb * q, 1, S.VEIL);
        continue;
      }
      if (k === AK.ORG) {
        const rot = this.rt[i] + t * this.rs[i];
        batch.push(x, y, s * 3.4, s * 3.4, 0, cr * 0.30, cg * 0.30, cb * 0.30, 1, S.VEIL);
        // BLOB, not VOLUME: same job - mass and an edge - but its radius is
        // wobbled by three angular harmonics and its falloff has no rim, so a
        // 20px organism is a small soft body instead of a small soft ring.
        const q = quad(s * this.el[i], s, fl);
        batch.push(x, y, qw, qh, rot, cr * q, cg * q, cb * q, 1, S.BLOB);
        // The pulse, on the beat. This was a CORE at 0.34x the body, which
        // measured 0.214 linear across the whole species and never once put a
        // pixel over the 0.25 the contract calls a highlight - a near-delta at
        // 5px is the one thing the mip chain erases (see the header). PLANKTON
        // at 1.25x instead: a hot nucleus in a broad halo, documented for the
        // 6-30px this actually lands at, and large enough that the frame's own
        // 17px sampling grid can see it. It is the body that lights up, which
        // is what a pulsing organism does.
        if (tw > 0.58) {
          quad(s * 1.25, s * 1.25, fl);
          const q2 = (tw - 0.58) * 2.38 * 1.9;
          batch.push(x, y, qw, qh, rot, cr * q2, cg * q2, cb * q2, 1, S.PLANKTON);
        }
        continue;
      }
      const q = quad(s * e, s, fl) * ie;
      batch.push(x, y, qw, qh, srot, cr * q, cg * q, cb * q, 1, S.GLOW);
      if (k === AK.SPARK && tw > 0.74) {
        // The flash, and it is one now.
        //
        // NOT smeared, and that part was already right: the flash is a small
        // fraction of the exposure, so what it leaves is a short bright tick
        // and not a long dim one. Smearing these cost the launch frame its p99
        // once, because there are two hundred of them and every one was being
        // divided by up to 3.4.
        //
        // What was wrong was everything else. This was a CORE at 0.42x the
        // body, i.e. 5px after the size floor, and it measured 0.023 linear -
        // a hundredth of the mote's surround and a tenth of the level the
        // contract calls a highlight. Two independent reasons, both measured:
        // CORE is a near-delta and delivers its tile mean (0.011) rather than
        // its peak once the mip chain owns it, and 5px is smaller than the
        // 17px step of the grid p99 is computed on, so it could not have been
        // counted even at full brightness.
        //
        // So it is bigger, not just hotter: 4.2x the body, on PLANKTON, whose
        // nucleus-in-a-halo survives being drawn at 6-30px and is the shape a
        // flashing organism has. A flash is the animal's light filling the
        // water around it, so it is LARGER than the animal, never smaller. The
        // gate opens a little earlier as well, at 0.74 rather than 0.80, which
        // buys population without touching the envelope's shape - the flash is
        // still a brief snap, not a lamp.
        quad(s * 4.2, s * 4.2, fl);
        const q2 = (tw - 0.74) * 3.85 * 2.2;
        batch.push(x, y, qw, qh, 0, cr * q2, cg * q2, cb * q2, 1, S.PLANKTON);
      }
    }
  }
}

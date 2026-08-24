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
const K = { SPARK: 0, BUBBLE: 1, CLOUD: 2, EMBER: 3, DART: 4, VORTEX: 5, COLD: 6 };

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
    this.wobA[i] = 0; this.delay[i] = 0; this.asp[i] = 1;
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
      for (let i = 0; i < n; i++) {
        const wide = r() < 0.3;
        const a = wide ? r() * TAU : away + (r() - 0.5) * 3.3;
        const sp = lerp(140, 600, Math.pow(r(), 1.7));
        const s0 = lerp(4.4, 11, Math.pow(r(), 1.5));
        const j = this._spawn(
          x + Math.cos(a) * lerp(2, 16, r()), y + Math.sin(a) * lerp(2, 16, r()),
          Math.cos(a) * sp, Math.sin(a) * sp, lerp(0.34, 1.05, r()),
          s0, s0 * lerp(0.25, 0.6, r()),
          r() < 0.35 ? N_PLNKC : N_PLNK, lerp(1.7, 3.4, r()),
          r() < 0.4 ? S.PLANKTON : S.SPARK,
          dragFor(7.5, s0), lerp(-50, 14, r()), (r() - 0.5) * 8
        );
        this.kind[j] = K.DART;
        this.flow[j] = lerp(1.0, 1.9, r());
        this.cool[j] = lerp(0.35, 0.8, r());
        this.str[j] = lerp(0.35, 0.8, r());
      }
      // Slower stragglers with their own pulse, so the swarm is not one age.
      const ns = 1 + ((solo * 3) | 0);
      for (let i = 0; i < ns; i++) {
        const a = r() * TAU, sp = lerp(30, 150, r());
        const s0 = lerp(9, 19, r());
        const j = this._spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
          lerp(0.9, 1.9, r()), s0, s0 * 0.5, N_PLNK, lerp(0.9, 1.7, r()), S.GLOW,
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
    for (let i = 0; i < count; i++) {
      const s = lerp(9, 30, Math.pow(r(), 1.7));
      const j = this._spawn(
        x + (r() - 0.5) * 30, y + (r() - 0.5) * 26,
        vx * 0.14 + (r() - 0.5) * 70, vy * 0.09 - lerp(20, 80, r()),
        lerp(1.1, 3.2, r()), s, s * lerp(1.10, 1.45, r()),
        r() < 0.34 ? N_SURF : N_WATER, lerp(0.55, 1.5, r()), S.VEIL,
        dragFor(2.6, s), -lerp(260, 420, r()),
        lerp(3.2, 7.5, r()) * (r() < 0.5 ? -1 : 1)
      );
      this.kind[j] = K.BUBBLE;
      this.flow[j] = lerp(0.4, 0.9, r());
      this.wobA[j] = lerp(300, 900, r());
      this.delay[j] = r() * spread;
    }
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
    const spK = clamp01((sp - 240) / 1900);
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
          lerp(0.055, 0.17, r()) * (0.35 + 0.65 * spK), S.SMOKE,
          dragFor(3.0, s0), lerp(-20, 16, r()), (r() - 0.5) * 1.6 * this._side
        );
        this.kind[j] = K.VORTEX;
        this.flow[j] = lerp(1.2, 2.0, r());
        this.cool[j] = lerp(0.5, 1.0, r());
        this.asp[j] = lerp(1.3, 2.2, r());
        this.rot[j] = travel + (r() - 0.5) * 0.9;
      }

      // --- stimulated bioluminescence. A body moving fast through plankton-rich
      //     water leaves a line of light behind it - the single most recognisable
      //     "at sea, at night" image there is. Tiny, hot, brief, and mint rather
      //     than white so it sits behind the mote in the hierarchy instead of
      //     competing with it. Exempt from the keep-out on purpose: these are
      //     points, not washes, and they are what carries the near trail now
      //     that nothing soft is allowed there.
      this._aGlow += dt * spK * spK * 26;
      if (this._aGlow > 4) this._aGlow = 4;
      while (this._aGlow >= 1) {
        this._aGlow -= 1;
        // Tight and close. Spread wide it stops reading as a trail and just
        // adds to the field of mint dots the world's own plankton already puts
        // on screen - same colour, same size, no hierarchy.
        const back = lerp(8, 115, Math.pow(r(), 0.7));
        const lat = (r() - 0.5) * lerp(10, 40, back / 115);   // the wake widens
        // Floored well above a pixel. At 2-4 world units these were 2px quads,
        // which is a hard little square with a stair-stepped edge, and a field
        // of them beside the mote is the "shimmering pixels" note verbatim.
        // Bigger and correspondingly dimmer: the same energy, spread over
        // enough texels for the profile to actually be a profile.
        const s0 = lerp(4.4, 8.2, r());
        const j = this._spawn(
          p.x - tx * back + nx * lat, p.y - ty * back + ny * lat,
          -tx * sp * 0.05 + nx * (r() - 0.5) * 90,
          -ty * sp * 0.05 + ny * (r() - 0.5) * 90,
          lerp(0.16, 0.5, r()), s0, s0 * 0.35,
          r() < 0.3 ? N_PLNKC : N_PLNK,
          lerp(0.55, 1.6, r()) * (0.3 + 0.7 * spK), S.SPARK,
          dragFor(9, s0), lerp(-14, 10, r()), (r() - 0.5) * 4
        );
        this.kind[j] = K.DART;
        this.flow[j] = lerp(1.2, 1.9, r());
        this.cool[j] = 0.55;
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
            lerp(0.05, 0.15, r()) * (0.45 + 0.55 * kk), S.SMOKE,
            dragFor(5.0, s0), lerp(3, 24, r()), (r() - 0.5) * 0.7
          );
          this.kind[j] = K.CLOUD;
          this.flow[j] = lerp(1.4, 2.1, r());
          this.cool[j] = lerp(0.5, 1.0, r());
          // silt sheared along the surface it left, never a puffball
          this.asp[j] = lerp(1.4, 2.3, r());
          this.rot[j] = (r() - 0.5) * 0.5;
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
    this.asp[b] = this.asp[a];
    this.wx[b] = this.wx[a]; this.wy[b] = this.wy[a];
  }

  // ------------------------------------------------------------------- draw ---
  draw(batch) {
    const cull = this._cw > 0;
    const cx = this._cx, cy = this._cy, cw = this._cw, ch = this._ch;

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
      }

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
        const body = bb * 0.26 * this._clear(px, py, s * 0.75);
        if (body > 0.004) {
          const sw = s * 1.45;
          batch.push(px, py, sw, sw, 0, cr * body, cg * body, cb * body, 1, S.VEIL);
        }
        // the glint. Floored in size because a sub-pixel hot point shimmers
        // under a moving camera, which is the same reason ribbons floor theirs.
        const gs = s * 0.34 > 3.4 ? s * 0.34 : 3.4;
        const ga = bb * 0.8;
        batch.push(px + ox, py + oy, gs, gs, this.rot[i], cr * ga, cg * ga, cb * ga, 1, S.SPARK);
        continue;
      }

      const st = this.str[i];
      let stretched = false;
      if (st > 0) {
        const vx = this.vx[i], vy = this.vy[i];
        const spd = Math.hypot(vx, vy);
        const e = 1 + st * clamp(spd / 250, 0, 4.2);
        if (e > 1.55) {
          batch.push(px, py, s * e, s * 0.62, Math.atan2(vy, vx),
            cr * bb, cg * bb, cb * bb, 1, S.STREAK);
          stretched = true;
        }
      }
      if (!stretched) {
        batch.push(px, py, s * ap, s, this.rot[i], cr * bb, cg * bb, cb * bb, 1, this.layer[i]);
      }

      // A second, much wider scatter halo: one blur radius for everything reads
      // as a filter, two reads as light sitting *in* water. Emitters only, and
      // never inside the mote's surround. Clouds and rolls scatter light rather
      // than emit it, and this halo at 3.2x the sprite was the largest single
      // contributor of soft light into the annulus - a release spark 20 units
      // wide was laying an 80-unit wash straight over the mote.
      if (bb > 0.05 && !soft && s > 9) {
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

  draw(batch, cam, t) {
    const b = cam.bounds(300);
    const W = b.x1 - b.x0, H = b.y1 - b.y0;
    if (!(W > 1) || !(H > 1)) return;

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
      const amp = this.br[i] * tw * g * (1 - 0.6 * fade) * 0.22;
      if (amp <= 0.003) continue;
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

      if (k === AK.LARVA) {
        const rot = this.rt[i] + t * this.rs[i];
        batch.push(x, y, s * this.el[i], s * 0.5, rot, cr, cg, cb, 1, S.FILAMENT);
        continue;
      }
      if (k === AK.FAT) {
        const sw = s * 2.4;
        batch.push(x, y, sw * this.el[i], sw, this.rt[i] + t * this.rs[i],
          cr, cg, cb, 1, S.VEIL);
        continue;
      }
      if (k === AK.ORG) {
        const rot = this.rt[i] + t * this.rs[i];
        batch.push(x, y, s * 3.4, s * 3.4, 0, cr * 0.30, cg * 0.30, cb * 0.30, 1, S.VEIL);
        // BLOB, not VOLUME: same job - mass and an edge - but its radius is
        // wobbled by three angular harmonics and its falloff has no rim, so a
        // 20px organism is a small soft body instead of a small soft ring.
        batch.push(x, y, s * this.el[i], s, rot, cr, cg, cb, 1, S.BLOB);
        if (tw > 0.5) {
          const q = (tw - 0.5) * 2;
          batch.push(x, y, s * 0.34, s * 0.34, 0, cr * q * 1.7, cg * q * 1.7, cb * q * 1.7, 1, S.CORE);
        }
        continue;
      }
      batch.push(x, y, s, s, 0, cr, cg, cb, 1, S.GLOW);
      if (k === AK.SPARK && tw > 0.80) {
        // the hot pip on the peak of a flash only, and small - this is what
        // used to be a permanent hard white dot
        const q = (tw - 0.80) * 5;
        batch.push(x, y, s * 0.42, s * 0.42, 0, cr * q, cg * q, cb * q, 1, S.CORE);
      }
    }
  }
}

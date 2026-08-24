// Procedural trench, composed rather than sprinkled.
//
// The unit of design is a PHRASE: a few hundred to a couple of thousand world
// units with a single intent - a tight weave, a committed leap, a descent
// through a hazard field, a calm plankton garden. A small grammar sequences
// phrases so tension builds and releases, and rare SET PIECES give a deep run
// landmarks you remember.
//
// Two structural rules make that safe inside a rolling generator:
//
//  - Phrase i is a pure function of (seed, i) and phrase i-1, built append-only
//    in index order. Any call order therefore yields the same level, which is
//    what lets bandTop() - called from the render thread to build the rock strip
//    - extend the schedule without endangering determinism.
//  - A phrase's band profile smoothsteps from the previous phrase's exit values
//    to its own, and every interior feature is windowed to vanish at both
//    joints. Continuity is structural, not something to remember.
//
// Sizing: the camera shows 1080 world units vertically. The old profile was
// 1800-2500 tall, so no wall was ever on screen and the anchor line - pinned to
// the ceiling - sat out of reach of the entire lower half of the corridor. That
// is why the trench read as flat open water, and why the mote had nothing in
// reach for 80-90% of its airtime. Bands here are mostly 900-1600, so both walls
// frame the action and the anchor line covers the whole corridor.
import { makeRng, fbm1, noise1 } from '../engine/rng.js';
import { clamp, clamp01, lerp, smoothstep, TAU } from '../engine/math.js';

export const KIND = { ANCHOR: 0, URCHIN: 1, JELLY: 2, PLANKTON: 3, KELP: 4, SPIRE: 5, ANEMONE: 6 };

const GEN_AHEAD = 3200;        // world units of lookahead to keep populated
const START_SAFE = 1500;       // no hazards before this x - the opening teaches

// Mirrors of player.js. Generation must not import it (that would close an
// import cycle), so these are copies. Do not trust them on their own: the arc
// they feed is calibrated against the real Player class by tools/_reach.mjs,
// which sweeps release timings and asserts no anchor is a dead end. Re-run it
// whenever these change.
const REACH = 620;
const GRAVITY = 1850;
const DRAG_Q = 0.00028, DRAG_L = 0.17;
const RADIUS = 15, WALL_REST = 0.58;
const ROPE_MIN = 190, ROPE_MAX = 560;   // the annulus a tethered mote sweeps
// The vent is a current with a velocity target, and its strength scales with the
// trench - so the corridor profile below is what decides how good a rescue the
// floor is. Keep these in step with P.vent* or the arcs lie about the low line.
const VENT_SPAN = 0.18, VENT_FLOW_K = 2.10, VENT_FALL = 1.60, VENT_RATE = 4.4;
// The ideal launch heading, measured by the physics owner: distance-optimal
// release is a flat 0.40 rad above horizontal, and velocity is purely
// tangential, so the rope at that instant points (sin, cos) from the anchor.
const LA_C = Math.cos(0.40), LA_S = Math.sin(0.40);

// World envelope. surfaceY/floorY bound what the background shader expects.
const Y_TOP = -2760, Y_BOT = 1390;
const CHANNEL = 240;            // a hazard field must always leave a flyable slot
const HH_MIN = 215;            // absolute half-height floor: ~290 units of free water
const HOME_CY = -70;           // the trench's home line, so wandering never runs away
const PRE_TOP = -660, PRE_BOT = 430;

const PH = {
  OPEN: 'open', WEAVE: 'weave', LEAP: 'leap', DESCENT: 'descent', ASCENT: 'ascent',
  PINCH: 'pinch', CHAMBER: 'chamber', GARDEN: 'garden', GAUNTLET: 'gauntlet', SHAFT: 'shaft',
  CATHEDRAL: 'cathedral', KELPWOOD: 'kelpwood', VENTFIELD: 'ventfield', BLOOM: 'bloom',
  MONOLITH: 'monolith',
};
// Set pieces, and the distance at which each is allowed to appear. They arrive
// one at a time so a deep run keeps producing something it has not shown yet.
const SET_GATE = {
  [PH.CATHEDRAL]: 11000, [PH.KELPWOOD]: 6500, [PH.VENTFIELD]: 9000,
  [PH.BLOOM]: 13000, [PH.MONOLITH]: 12000,
};
const SET_LIST = [PH.KELPWOOD, PH.VENTFIELD, PH.CATHEDRAL, PH.BLOOM, PH.MONOLITH];

// Anchor lines. `r0..r1` is how far above the nominal arc the bulb hangs (so
// you always swing *up* into it); `f` is where in the corridor it would rather
// live. The bias toward `f` is capped so reachability survives it.
// Anchor lines. `f` is where in the corridor the line wants to live; `up`/`down`
// cap how far off the nominal flight a bulb may sit and still be grabbed, so
// every consecutive pair stays well inside reach.
const LINES = {
  mid: { f: 0.31, up: 330, down: 360 },
  high: { f: 0.21, up: 360, down: 275 },
  low: { f: 0.50, up: 210, down: 395 },
  zig: { f: 0.24, up: 350, down: 330 },
  follow: { f: 0.30, up: 320, down: 350 },
  throat: { f: 0.42, up: 300, down: 300 },
  bay: { f: 0.28, up: 340, down: 330 },
  monolith: { f: 0.30, up: 330, down: 350 },
};

const byX = (a, b) => a.x - b.x;

/**
 * Append a sorted block to a sorted list and keep the result sorted.
 *
 * Sorting each phrase block and concatenating is NOT enough: a block's objects
 * can spill past their phrase's nominal end, so the next block starts before
 * the previous one finished. Hot loops in player.js and render.js `break` on
 * ascending x, so a single inversion silently makes every later object in that
 * neighbourhood unreachable and invisible. It measured as 1-4 inversions per
 * seed and 18 uncollectable plankton on seed 7 before this existed.
 *
 * The overlap is small in practice, so this is O(block + overlap), not a resort.
 */
function pushAll(dst, src) {
  const n = src.length;
  if (!n) return;
  if (!dst.length || dst[dst.length - 1].x <= src[0].x) {
    for (let i = 0; i < n; i++) dst.push(src[i]);
    return;
  }
  let i = dst.length;
  const first = src[0].x;
  while (i > 0 && dst[i - 1].x > first) i--;
  const tail = dst.splice(i, dst.length - i);
  let a = 0, b = 0;
  while (a < tail.length || b < n) {
    if (b >= n || (a < tail.length && tail[a].x <= src[b].x)) dst.push(tail[a++]);
    else dst.push(src[b++]);
  }
}

export class World {
  constructor(seed = 7) {
    this.seed = seed;
    this.rng = makeRng(seed);
    this.noiseOff = (seed % 997) * 13.37;

    this.surfaceY = -3400;
    this.floorY = 1500;

    this.anchors = [];
    this.hazards = [];
    this.plankton = [];
    this.decor = [];

    this.genX = -700;
    this.hushX = -2600;
    this.difficulty = 0;

    // --- phrase schedule ---
    this.phrases = [];
    this._pi = 0;                 // lookup hint; queries are near-monotonic
    this._lastSet = -99;
    this._setSeen = {};
    // --- band profile memo: bandTop(x) and bandBot(x) always arrive in pairs ---
    this._mx = NaN; this._mt = 0; this._mb = 0;
    // --- generation cursor for the anchor line, carried across phrases ---
    this._ax = -60; this._ay = -430; this._opened = false;
    this._arcBuf = new Float32Array(96 * 2);
    this._arcN = 0;
    this._ivLo = new Float64Array(24); this._ivHi = new Float64Array(24);

    this.populate(1600);
  }

  // ---- trench profile ------------------------------------------------------
  /** Ceiling of the swimmable band. */
  bandTop(x) { if (x !== this._mx) this._prof(x); return this._mt; }
  /** Floor of the swimmable band. */
  bandBot(x) { if (x !== this._mx) this._prof(x); return this._mb; }

  /**
   * Both walls at once. Called every frame for every column of the rock strip,
   * so it stays inside ~6 noise taps and a handful of transcendentals.
   */
  _prof(x) {
    const p = this._phraseAt(x);
    const u = clamp01((x - p.x0) * p.inv);
    const s = u * u * (3 - 2 * u);
    let top = p.top0 + (p.top1 - p.top0) * s;
    let bot = p.bot0 + (p.bot1 - p.bot0) * s;

    // One windowed interior feature: a throat, a chamber, a shelf, a shaft.
    if (p.fw > 0) {
      const w = 1 - Math.abs((u - p.fc) * p.fwInv);
      if (w > 0) { const win = w * w * (3 - 2 * w); top += p.fTop * win; bot += p.fBot * win; }
    }
    // Envelope shared by the periodic features, zero at both joints.
    if (p.bayN > 0 || p.wavAmp !== 0) {
      const env = Math.sin(Math.PI * u);
      if (p.bayN > 0) {
        const arch = 0.5 - 0.5 * Math.cos(u * p.bayN * TAU);
        top += p.bayTop * env * arch; bot += p.bayBot * env * arch;
      }
      // A snaking centreline: the corridor bends without changing width.
      if (p.wavAmp !== 0) {
        const w = p.wavAmp * env * Math.sin(u * p.wavN * TAU + p.wavPh);
        top += w; bot += w;
      }
    }

    // Rock relief, global and continuous so the joints stay invisible. Scaled by
    // the local corridor so a throat keeps the shape it was designed with.
    const k = p.rough * Math.min(1, (bot - top) * 0.000714);
    const o = this.noiseOff;
    const sw = fbm1(x * 0.00072 + o, 2) - 0.5;
    top += (sw * 208 + (noise1(x * 0.0031 + o + 11.7) - 0.5) * 150
      + (noise1(x * 0.0053 + o + 5.1) - 0.5) * 44) * k;
    bot += (sw * 184 - (noise1(x * 0.0027 + o + 63.1) - 0.5) * 138
      - (noise1(x * 0.0049 + o + 88.3) - 0.5) * 40) * k;

    if (top < Y_TOP) top = Y_TOP;
    if (bot > Y_BOT) bot = Y_BOT;
    const half = (bot - top) * 0.5;
    if (half < HH_MIN) { const m = (top + bot) * 0.5; top = m - HH_MIN; bot = m + HH_MIN; }

    this._mx = x; this._mt = top; this._mb = bot;
  }

  /** The rising trend, pure in x. The sequencer uses this, never difficultyAt. */
  _trend(x) {
    const t = clamp01(x / 31000);
    return clamp01(0.35 * t + 0.65 * smoothstep(t)) * lerp(0.40, 1, smoothstep(clamp01(x / 6000)));
  }

  /**
   * Difficulty is the rising trend plus the current phrase's tension, so the
   * Hush actually breathes: it eases off through a garden and leans in through a
   * gauntlet. Continuous across joints by construction.
   */
  difficultyAt(x) {
    const i = this._phraseIdx(x);
    const p = this.phrases[i];
    const u = clamp01((x - p.x0) * p.inv);
    let ten;
    if (u < 0.5) { const s = smoothstep(u * 2); ten = p.tIn + (p.ten - p.tIn) * s; }
    else { const s = smoothstep((u - 0.5) * 2); ten = p.ten + (this._phrase(i + 1).tIn - p.ten) * s; }
    return clamp01(this._trend(x) + (ten - 0.42) * 0.26);
  }

  // ---- phrase schedule ----------------------------------------------------
  _seedFor(i, salt) {
    let h = Math.imul(this.seed ^ 0x9e3779b9, 2654435761);
    h = Math.imul(h ^ i, 1597334677);
    h = Math.imul(h ^ salt, 668265263);
    return (h ^ (h >>> 15)) | 0;
  }

  _phrase(i) { while (this.phrases.length <= i) this._push(); return this.phrases[i]; }

  _phraseIdx(x) {
    const ps = this.phrases;
    while (ps.length === 0 || x >= ps[ps.length - 1].x1) {
      if (ps.length > 3000) break;               // pathological query guard
      this._push();
    }
    let i = this._pi;
    if (i >= ps.length) i = ps.length - 1;
    if (x >= ps[i].x0 && x < ps[i].x1) return i;
    let lo = 0, hi = ps.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (x < ps[m].x1) hi = m; else lo = m + 1;
    }
    this._pi = lo;
    return lo;
  }

  _phraseAt(x) { return this.phrases[this._phraseIdx(x)]; }

  _push() {
    const ps = this.phrases;
    const i = ps.length;
    const prev = i ? ps[i - 1] : null;
    const x0 = prev ? prev.x1 : -3200;
    const r = makeRng(this._seedFor(i, 0x51ed));
    const d = this._trend(x0);
    const p = this._build(i, this._pickKind(i, prev, x0, d, r), x0, d, r, prev);
    ps.push(p);
    return p;
  }

  /**
   * The grammar. Hard phrases must be followed by a release, two calm phrases
   * in a row are not allowed to both be calm, and mechanics unlock one at a
   * time so the player is never shown two new ideas at once.
   */
  _pickKind(i, prev, x0, d, r) {
    if (i === 0) return PH.OPEN;        // prelude: the water behind the start
    if (i === 1) return PH.GARDEN;      // the establishing shot, and the first chain
    if (i === 2) return PH.WEAVE;       // first real pattern, still no hazards
    if (i === 3) return PH.OPEN;
    if (i === 4) return PH.LEAP;        // first commitment
    const prev2 = this.phrases[i - 2];
    const t = prev.ten;

    if (t >= 0.60) {                    // release after tension, always
      const pick = r();
      return pick < 0.46 ? PH.GARDEN : pick < 0.78 ? PH.CHAMBER : PH.OPEN;
    }

    if (i - this._lastSet >= 5 && r.chance(lerp(0.08, 0.36, d))) {
      let bestSeen = Infinity;
      for (const k of SET_LIST) {
        if (x0 < SET_GATE[k]) continue;
        const seen = this._setSeen[k] === undefined ? -99 : this._setSeen[k];
        if (seen < bestSeen) bestSeen = seen;
      }
      if (bestSeen < Infinity) {
        // Prefer the stalest, but choose randomly among equals: pure staleness
        // is a strict rotation, and every seed then shows its landmarks in the
        // same order.
        const pool = [];
        for (const k of SET_LIST) {
          if (x0 < SET_GATE[k]) continue;
          const seen = this._setSeen[k] === undefined ? -99 : this._setSeen[k];
          if (seen === bestSeen) pool.push(k);
        }
        const best = pool[Math.min(pool.length - 1, (r() * pool.length) | 0)];
        this._lastSet = i; this._setSeen[best] = i;
        return best;
      }
    }

    const calmPrev = t <= 0.24 && prev2 && prev2.ten <= 0.30;
    const W = [];
    const add = (k, w) => { if (w > 0 && k !== prev.kind) { W.push(k); W.push(w); } };
    add(PH.OPEN, calmPrev ? 0 : lerp(1.5, 0.34, d));
    add(PH.WEAVE, lerp(1.1, 1.8, d) * (t < 0.32 ? 1.6 : 0.8));
    add(PH.LEAP, x0 > 2400 ? lerp(0.7, 1.5, d) : 0);
    add(PH.DESCENT, x0 > 3400 ? 1.1 : 0);
    add(PH.ASCENT, x0 > 4600 ? 0.85 : 0);
    add(PH.PINCH, x0 > 2800 ? lerp(0.70, 1.60, d) : 0);
    add(PH.CHAMBER, calmPrev ? 0 : lerp(0.9, 0.65, d) * (t > 0.45 ? 1.6 : 0.7));
    add(PH.GARDEN, calmPrev ? 0 : lerp(1.2, 0.55, d) * (t > 0.45 ? 1.8 : 0.5));
    add(PH.GAUNTLET, x0 > 7000 ? lerp(0.2, 2.3, d) : 0);
    add(PH.SHAFT, x0 > 12000 ? lerp(0.15, 0.75, d) : 0);
    if (!W.length) return PH.OPEN;
    let sum = 0;
    for (let k = 1; k < W.length; k += 2) sum += W[k];
    let pick = r() * sum;
    for (let k = 0; k < W.length; k += 2) { pick -= W[k + 1]; if (pick <= 0) return W[k]; }
    return W[0];
  }

  /** Schedule entry only. Never calls _prof, so it cannot recurse into itself. */
  _build(i, kind, x0, d, r, prev) {
    const top0 = prev ? prev.top1 : PRE_TOP;
    const bot0 = prev ? prev.bot1 : PRE_BOT;

    let len = 1100, hh = 600, dCy = 0, rough = 0.85, ten = 0.30;
    let gapLo = 380, gapHi = 490, longAt = -1, longGap = 0;
    let fc = 0.5, fw = 0, fTop = 0, fBot = 0;
    let bayN = 0, bayTop = 0, bayBot = 0;
    let wavN = 0, wavAmp = 0;
    let line = 'mid', twin = false, hazard = 'sparse', pk = 'trail', decor = 'mixed';
    let vary = 0.05;             // vertical spread of the bulb line within a phrase

    switch (kind) {
      case PH.OPEN:
        len = r.range(900, 1500); hh = r.range(455, 575); dCy = r.range(-170, 170);
        rough = r.range(0.75, 1.05);
        wavN = r.range(0.8, 1.6); wavAmp = r.range(60, 150);
        gapLo = 380; gapHi = 480; ten = 0.22; vary = 0.11;
        break;

      case PH.WEAVE:
        len = r.range(760, 1250);
        hh = lerp(r.range(430, 510), r.range(350, 425), d);
        dCy = r.range(-130, 130); rough = r.range(0.34, 0.55);
        wavN = r.range(1.6, 2.9); wavAmp = r.range(155, 275);
        gapLo = lerp(340, 292, d); gapHi = lerp(430, 372, d); ten = 0.55;
        line = 'zig'; hazard = 'wall'; decor = 'teeth';
        break;

      case PH.LEAP:
        len = r.range(1000, 1550); hh = r.range(545, 690); dCy = r.range(-110, 230);
        rough = r.range(0.6, 0.9);
        gapLo = 360; gapHi = 470;
        longAt = r.int(0, 1); longGap = lerp(700, 980, d); ten = 0.62;
        hazard = 'gap'; pk = 'leap'; decor = 'sparse';
        break;

      case PH.DESCENT:
        len = r.range(1150, 1650); hh = r.range(450, 600); dCy = r.range(430, 720);
        rough = r.range(0.5, 0.8);
        gapLo = 360; gapHi = 470; ten = 0.58;
        line = 'follow'; hazard = 'floor'; decor = 'walls';
        break;

      case PH.ASCENT:
        len = r.range(1000, 1420); hh = r.range(465, 615); dCy = -r.range(340, 610);
        rough = r.range(0.5, 0.8);
        gapLo = 330; gapHi = 435; ten = 0.46;
        line = 'follow'; hazard = 'ceil'; decor = 'walls';
        break;

      case PH.PINCH: {
        len = r.range(430, 690); hh = r.range(490, 620); dCy = r.range(-90, 90);
        rough = r.range(0.22, 0.36);
        const throat = lerp(310, 205, d);
        fc = r.range(0.42, 0.58); fw = r.range(0.34, 0.46);
        fTop = (hh - throat) * r.range(0.46, 0.60);
        fBot = -(hh - throat) * r.range(0.40, 0.54);
        gapLo = 300; gapHi = 385; ten = 0.74;
        line = 'throat'; hazard = 'mouth'; pk = 'throat'; decor = 'teeth';
        break;
      }

      case PH.CHAMBER:
        len = r.range(1300, 2000); hh = r.range(740, 960); dCy = r.range(-270, 160);
        rough = r.range(0.9, 1.2);
        fw = 0.5; fTop = -r.range(140, 300); fBot = r.range(110, 240);
        gapLo = 510; gapHi = 700; ten = 0.18; vary = 0.13;
        line = 'high'; twin = true; pk = 'cloud'; decor = 'vista';
        break;

      case PH.GARDEN:
        len = r.range(950, 1450); hh = r.range(535, 665); dCy = r.range(-130, 210);
        rough = r.range(0.7, 1.0);
        wavN = r.range(0.9, 1.7); wavAmp = r.range(70, 165);
        gapLo = 415; gapHi = 540; ten = 0.10; vary = 0.15;
        hazard = 'none'; pk = 'garden'; decor = 'lush';
        break;

      case PH.GAUNTLET:
        len = r.range(1050, 1650); hh = r.range(645, 805); dCy = r.range(-150, 150);
        rough = r.range(0.6, 0.9);
        gapLo = 400; gapHi = 520; ten = 0.86;
        line = 'high'; twin = true; hazard = 'field'; pk = 'lowroute'; decor = 'walls';
        break;

      case PH.SHAFT: {
        len = r.range(820, 1180); hh = r.range(505, 640); dCy = -r.range(70, 220);
        rough = r.range(0.45, 0.72);
        fc = r.range(0.44, 0.58); fw = r.range(0.30, 0.42);
        fBot = r.range(520, 900);
        gapLo = 420; gapHi = 560; ten = 0.70;
        hazard = 'shaft'; pk = 'shaft'; decor = 'walls';
        break;
      }

      case PH.CATHEDRAL:
        len = r.range(1900, 2700); hh = r.range(900, 1120); dCy = -r.range(180, 430);
        rough = r.range(0.28, 0.44);
        bayN = r.int(4, 6); bayTop = -r.range(230, 390); bayBot = r.range(60, 145);
        ten = 0.42;
        line = 'bay'; hazard = 'pillar'; pk = 'vault'; decor = 'cathedral';
        break;

      case PH.KELPWOOD:
        len = r.range(1500, 2100); hh = r.range(560, 720); dCy = r.range(-80, 230);
        rough = r.range(0.55, 0.8);
        wavN = r.range(1.1, 2.0); wavAmp = r.range(95, 185);
        gapLo = 380; gapHi = 475; ten = 0.52;
        line = 'low'; hazard = 'wall'; pk = 'wood'; decor = 'kelpwood';
        break;

      case PH.VENTFIELD:
        len = r.range(1300, 1900); hh = r.range(505, 655); dCy = r.range(-60, 150);
        rough = r.range(0.55, 0.85);
        fw = 0.55; fBot = -r.range(155, 300);
        gapLo = lerp(630, 790, d); gapHi = lerp(810, 970, d); ten = 0.46;
        line = 'high'; hazard = 'vent'; pk = 'updraft'; decor = 'vents';
        break;

      case PH.BLOOM:
        len = r.range(1250, 1750); hh = r.range(700, 860); dCy = r.range(-170, 170);
        rough = r.range(0.6, 0.9);
        gapLo = 440; gapHi = 560; ten = 0.80;
        hazard = 'bloom'; pk = 'bloom'; decor = 'sparse';
        break;

      case PH.MONOLITH:
        len = r.range(1450, 1950); hh = r.range(860, 1050); dCy = -r.range(120, 330);
        rough = r.range(0.7, 1.0);
        fw = 0.52; fTop = -r.range(120, 265); fBot = r.range(90, 205);
        gapLo = 600; gapHi = 760; ten = 0.26;
        line = 'monolith'; hazard = 'none'; pk = 'orbit'; decor = 'vista';
        break;
    }

    // --- scripted opening. It is the first thing anyone sees, and the title
    // camera sits inside phrase 1, so that phrase is composed, not rolled. ---
    if (i === 0) { len = 3200; hh = 545; dCy = 0; rough = 0.55; wavAmp = 0; hazard = 'none'; pk = 'none'; decor = 'lush'; }
    if (i === 1) {
      len = r.range(1150, 1360); hh = r.range(520, 580); dCy = r.range(-40, 60);
      rough = r.range(0.5, 0.7); wavN = 1.1; wavAmp = r.range(50, 90);
      gapLo = 395; gapHi = 460;
    }
    if (i === 2) hazard = 'none';

    // Exit values. cy is pulled toward the home line so a run of descents cannot
    // walk the corridor out of the world, then clamped so cy +/- hh always fits.
    const cy0 = (top0 + bot0) * 0.5;
    hh = clamp(hh, HH_MIN + 45, 1440);
    let cy = cy0 + dCy;
    cy += (HOME_CY - cy) * 0.18;
    cy = clamp(cy, Y_TOP + hh + 30, Y_BOT - hh - 30);
    const top1 = cy - hh, bot1 = cy + hh;

    // A shaft may only drop as far as the envelope allows.
    if (kind === PH.SHAFT) fBot = Math.min(fBot, Y_BOT - Math.max(bot0, bot1) - 20);
    if (kind === PH.SHAFT && fBot < 240) { fw = 0; fBot = 0; ten = 0.5; }

    const prevTen = prev ? prev.ten : ten;
    return {
      i, kind, x0, len, x1: x0 + len, inv: 1 / len,
      top0, bot0, top1, bot1,
      fc, fw, fwInv: fw > 0 ? 1 / fw : 0, fTop, fBot,
      bayN, bayTop, bayBot,
      wavN, wavAmp, wavPh: r() * TAU,
      rough, ten, tIn: (prevTen + ten) * 0.5, vary,
      gapLo, gapHi, longAt, longGap,
      line, twin, hazard, pk, decor,
      objFrom: Math.max(x0, -700),
      done: false, seed: this._seedFor(i, 0x7f4a),
    };
  }

  // ---- the nominal arc ----------------------------------------------------
  /**
   * Where a competent release from (ax,ay) actually carries you. This is the
   * spine of the whole generator: anchors are placed against it (so every gap is
   * reachable by construction rather than by luck), plankton is strung along it
   * (so a chain has to be flown, not stumbled into), and hazards are offset from
   * it (so they change *when* you let go).
   */
  _arc(ax, ay, d, maxX) {
    const rope = lerp(360, 300, d);          // after reeling, above P.ropeMin
    // Measured, not assumed: a real loaded release leaves at ~750-960 (p10-p90
    // over a hold sweep). Guessing high here is what produced dead-end anchors.
    const spd = lerp(880, 1080, d);
    let x = ax + rope * LA_S, y = ay + rope * LA_C;
    let vx = spd * LA_C, vy = -spd * LA_S;
    const b = this._arcBuf;
    b[0] = x; b[1] = y;
    let n = 1;
    const h = 1 / 40;
    for (let s = 0; s < 94 && x < maxX + 260; s++) {
      vy += GRAVITY * h;
      const sp = Math.hypot(vx, vy);
      if (sp > 1e-3) {
        const k = Math.max(0, 1 - ((DRAG_Q * sp * sp + DRAG_L * sp) * h) / sp);
        vx *= k; vy *= k;
      }
      x += vx * h; y += vy * h;
      const top = this.bandTop(x), bot = this.bandBot(x);
      const bandH = Math.max(300, bot - top);
      const ventH = clamp(bandH * VENT_SPAN, 120, 620);
      const over = bot - y;
      // The floor current is part of the real arc; ignoring it would make every
      // long gap look impassable and shrink the level down to timid hops.
      if (over < ventH) {
        const kk = Math.pow(clamp01(1 - over / ventH), VENT_FALL);
        const flowY = clamp(bandH * VENT_FLOW_K, 1100, 3000);
        vy += (-flowY - vy) * (1 - Math.exp(-VENT_RATE * kk * h));
      }
      if (y > bot - RADIUS) { y = bot - RADIUS; if (vy > 0) vy = -vy * WALL_REST; }
      if (y < top + RADIUS) { y = top + RADIUS; if (vy < 0) vy = -vy * WALL_REST; }
      b[n * 2] = x; b[n * 2 + 1] = y; n++;
    }
    this._arcN = n;
  }

  _arcYAt(x) {
    const b = this._arcBuf, n = this._arcN;
    if (n < 2) return b[1];
    if (x <= b[0]) return b[1];
    for (let i = 1; i < n; i++) {
      if (b[i * 2] >= x) {
        const x0 = b[(i - 1) * 2], x1 = b[i * 2];
        const f = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
        return b[(i - 1) * 2 + 1] + (b[i * 2 + 1] - b[(i - 1) * 2 + 1]) * f;
      }
    }
    return b[(n - 1) * 2 + 1];
  }

  /** A point and tangent a fraction `f` along the flight from `a` toward `b`. */
  _arcBetween(a, b, d, f) {
    this._arc(a.x, a.y, d, b.x);
    const n = this._arcN, buf = this._arcBuf;
    if (n < 3) return null;
    const x0 = buf[0], x1 = Math.min(buf[(n - 1) * 2], b.x);
    if (x1 - x0 < 70) return null;
    const x = x0 + (x1 - x0) * f;
    const y = this._arcYAt(x);
    return { x, y, tx: 40, ty: this._arcYAt(x + 40) - y };
  }

  // ---- generation ---------------------------------------------------------
  populate(untilX) {
    let guard = 0;
    while (this.genX < untilX && guard++ < 24) {
      const p = this._phraseAt(this.genX);
      if (!p.done) { p.done = true; this._materialise(p); }
      this.genX = Math.max(p.x1, this.genX + 1);
    }
    if (this.difficulty === 0) this.difficulty = this.difficultyAt(Math.max(0, untilX - GEN_AHEAD));
  }

  _materialise(p) {
    const r = makeRng(p.seed);
    const d = this._trend(p.x0 + p.len * 0.5);
    const A = [], H = [], K = [], D = [];

    if (p.kind === PH.VENTFIELD) {
      const n = r.int(4, 7);
      p.vents = [];
      for (let i = 0; i < n; i++) p.vents.push(p.x0 + p.len * ((i + r.range(0.25, 0.75)) / n));
    }

    this._layAnchors(p, r, A, d);
    this._pruneTraps(A, d);
    this._layHazards(p, r, A, H, d);
    this._layPlankton(p, r, A, H, K, d);
    this._layDecor(p, r, D);

    // Hot loops break on ascending x. Sorting each block is necessary but not
    // sufficient - blocks overlap - so pushAll merges rather than concatenates.
    A.sort(byX); H.sort(byX); K.sort(byX); D.sort(byX);
    pushAll(this.anchors, A); pushAll(this.hazards, H);
    pushAll(this.plankton, K); pushAll(this.decor, D);
  }

  // ---- anchors ------------------------------------------------------------
  _gapFor(p, r, k, d) {
    if (k === p.longAt && p.longGap > 0) return p.longGap;
    return r.range(p.gapLo, p.gapHi);
  }

  /**
   * Place a bulb for a swing that starts at the previous anchor. `wantX` is a
   * wish: if the arc cannot carry that far, the bulb is pulled back to where the
   * flight actually ends, which is what makes an unfair gap impossible.
   */
  _anchorAt(p, r, wantX, k, d, radWant) {
    this._arc(this._ax, this._ay, d, wantX);
    // Never ask for more than a fraction of the modelled carry. The arc tracks
    // reality at the median but over-predicts by up to 1.5x in the tail, and the
    // tail is precisely where an unfair gap would live.
    const reachX = this._ax + (this._arcBuf[(this._arcN - 1) * 2] - this._ax) * 0.80;
    const x = reachX < wantX ? reachX : wantX;
    if (x <= this._ax + 120) return null;

    const top = this.bandTop(x), bot = this.bandBot(x);
    const hh = bot - top;
    const rad = radWant !== undefined ? radWant
      : (r.chance(lerp(0.13, 0.22, d)) ? r.range(30, 39) : r.range(19, 27));
    const lo = top + rad * 1.7 + 26, hi = bot - (rad * 5.2 + 40);
    if (hi - lo < 60) return null;                 // a throat: no room for a bulb

    const pol = LINES[p.line] || LINES.mid;
    const zig = p.line === 'zig' && (k & 1) === 1;
    // The corridor decides the line and the arc only vetoes it. Doing this the
    // other way round - y = arc - rise - ratchets: the nominal flight peaks just
    // under the previous bulb, so each new one lands above the last until the
    // whole line welds itself to the ceiling, which is the exact failure this
    // generator exists to fix.
    // One line also only covers about 2*reach of corridor, so in a tall chamber
    // it drifts toward the middle instead of hugging the roof.
    const drift = Math.max(0, hh - 950) * 0.00017;
    const frac = clamp((zig ? 0.55 : pol.f) + drift + r.range(-p.vary, p.vary), 0.07, 0.56);
    const yArc = this._arcYAt(x);
    let y = clamp(top + Math.min(hh, 1500) * frac, yArc - pol.up, yArc + pol.down);
    y = clamp(y, lo, hi);
    return this._mkAnchor(r, x, y, rad, top, bot);
  }

  _mkAnchor(r, x, y, rad, top, bot) {
    const fromTop = y - top, fromBot = bot - y;
    // A bulb dangling 900 units below the roof on a visible stem reads as
    // absurd, so anchors that live low grow up out of the floor instead. A
    // negative `stalk` is exactly what render.js needs to draw the stem
    // downward from the bulb.
    const stalk = (fromTop > 700 && fromBot < fromTop) ? -Math.min(fromBot, 760)
      : Math.min(fromTop, 950);
    return {
      kind: KIND.ANCHOR, x, y, r: rad, stalk,
      phase: r() * TAU, sway: r.range(0.5, 1.25), hue: r.range(-0.04, 0.05),
      pulse: r.range(0.7, 1.5), used: 0, alive: true, big: rad > 29,
    };
  }

  _layAnchors(p, r, A, d) {
    if (p.line === 'bay') return this._bayAnchors(p, r, A, d);
    if (p.line === 'monolith') return this._monolithAnchors(p, r, A, d);
    if (p.x1 <= p.objFrom) return;

    let k = 0, guard = 0;
    if (!this._opened && p.x1 > 0) {
      // The very first bulb is hand-placed: close enough to the spawn that the
      // opening swing is available immediately, not after a blind fall.
      this._opened = true;
      const x = 315, top = this.bandTop(x), bot = this.bandBot(x);
      const a = this._mkAnchor(r, x, clamp(-470, top + 70, bot - 200), r.range(24, 29), top, bot);
      A.push(a); this._ax = a.x; this._ay = a.y; k = 1;
    }
    let x = this._ax + this._gapFor(p, r, 0, d);
    const prim = [];
    while (x < p.x1 && guard++ < 40) {
      const a = this._anchorAt(p, r, x, k, d);
      if (!a) { x += 130; continue; }
      prim.push(a);
      this._ax = a.x; this._ay = a.y;
      x = a.x + this._gapFor(p, r, ++k, d);
    }
    for (let i = 0; i < prim.length; i++) A.push(prim[i]);

    // One high line covers a corridor only ~940 tall (2 * reach less the line's
    // own offset), so anything deeper leaves water above the floor that nothing
    // can be grabbed from. A low line closes that, and where the two lines are
    // more than a reach apart it also reads as a real second route: safe high,
    // fast low.
    // Only under a bulb that has a successor here: a low bulb past the last
    // primary cannot be checked for an exit, because its exit would live in a
    // phrase that does not exist yet - and an unverified low bulb is a trap.
    const lastX = prim.length ? prim[prim.length - 1].x : -Infinity;
    for (let i = 0; i + 1 < prim.length; i++) {
      const a = prim[i];
      if (this.bandBot(a.x) - a.y <= 700) continue;
      if (!r.chance(p.twin ? 0.72 : 0.34)) continue;
      const lo = this._lowAnchor(r, a, p.twin ? 680 : 470);
      if (lo && lo.x < lastX - 60) A.push(lo);
    }
  }

  /** A bulb on the low road. Offset well along x so it never stacks on `a`. */
  _lowAnchor(r, a, minSep) {
    const x = a.x + r.range(95, 300);
    const top = this.bandTop(x), bot = this.bandBot(x);
    if (bot - top < 1150) return null;
    const rad = r.range(19, 26);
    const y = clamp(bot - r.range(215, 430), top + rad * 1.7 + 26, bot - (rad * 5.2 + 40));
    if (y - a.y < minSep) return null;
    const lo = this._mkAnchor(r, x, y, rad, top, bot);
    lo.low = true;
    return lo;
  }

  /** Is there any bulb ahead that a release from `a` actually reaches? */
  _hasExit(A, a, d) {
    this._arc(a.x, a.y, d, a.x + 1700);
    const n = this._arcN, buf = this._arcBuf;
    // Tighter than the primary chain's 0.80: this bulb was inserted, not placed
    // against an arc, and near the floor the vent current makes the model most
    // optimistic of all. Err toward dropping it.
    const lim = a.x + (buf[(n - 1) * 2] - a.x) * 0.68;
    const R2 = REACH * REACH * 0.49;
    for (let j = 0; j < A.length; j++) {
      const b = A[j];
      if (b === a || b.x <= a.x + 60 || b.x > lim + 240) continue;
      for (let s = 0; s < n; s++) {
        const dx = buf[s * 2] - b.x, dy = buf[s * 2 + 1] - b.y;
        if (dx * dx + dy * dy < R2) return true;
      }
    }
    return false;
  }

  /**
   * The primary chain is reachable by construction - each bulb is placed against
   * the arc from the one before it. A low-road bulb is inserted opportunistically
   * and gets no such guarantee, so one with no exit strands the mote. Drop it and
   * let the vent current cover that water instead.
   */
  _pruneTraps(A, d) {
    let lastPrim = -Infinity;
    for (let i = 0; i < A.length; i++) if (!A[i].low && A[i].x > lastPrim) lastPrim = A[i].x;
    for (let i = A.length - 1; i >= 0; i--) {
      const a = A[i];
      if (!a.low || a.x >= lastPrim) continue;   // its exit may live in the next phrase
      if (!this._hasExit(A, a, d)) A.splice(i, 1);
    }
  }

  _bayAnchors(p, r, A, d) {
    const mid = p.bayN >> 1;
    for (let k = 0; k < p.bayN; k++) {
      const x = p.x0 + p.len * ((k + 0.5) / p.bayN);
      if (x <= this._ax + 180) continue;
      const a = this._anchorAt(p, r, x, k, d, k === mid ? r.range(40, 50) : undefined);
      if (!a) continue;
      A.push(a); this._ax = a.x; this._ay = a.y;
    }
  }

  _monolithAnchors(p, r, A, d) {
    const a0 = this._anchorAt(p, r, this._ax + r.range(420, 560), 0, d);
    if (a0) { A.push(a0); this._ax = a0.x; this._ay = a0.y; }
    const xm = Math.max(p.x0 + p.len * r.range(0.44, 0.56), this._ax + 430);
    const m = this._anchorAt(p, r, xm, 1, d, r.range(66, 86));
    if (m) {
      m.ancient = true;
      m.pulse = r.range(0.34, 0.55);          // an older, slower heartbeat
      A.push(m); this._ax = m.x; this._ay = m.y;
    }
    let x = this._ax + r.range(520, 690), k = 2, guard = 0;
    while (x < p.x1 && guard++ < 8) {
      const a = this._anchorAt(p, r, x, k++, d);
      if (!a) break;
      A.push(a); this._ax = a.x; this._ay = a.y;
      x = a.x + r.range(560, 720);
    }
  }

  // ---- hazards ------------------------------------------------------------
  /**
   * A hazard is only fair if there is still a corridor past it. Jellies are
   * checked at both ends of their travel, never just where they happen to sit.
   */
  _fits(x, y, hr, amp) {
    const top = this.bandTop(x), bot = this.bandBot(x);
    const kill = hr * 0.62 + RADIUS;
    const above = (y - amp - kill) - top;
    const below = bot - (y + amp + kill);
    return (above > below ? above : below) >= 300;
  }

  /**
   * Would a kill disc spanning [yLo,yHi] at column x still leave a channel a
   * mote can fly through? Every hazard here already passed _fits on its own,
   * but two of them can close the water between them - a jelly over a floor
   * urchin once left a 12-unit slot, which is a wall, not a choice.
   */
  _passable(H, x, yLo, yHi) {
    const top = this.bandTop(x) + RADIUS, bot = this.bandBot(x) - RADIUS;
    if (bot - top < CHANNEL) return false;
    const lo = this._ivLo, hi = this._ivHi;
    let n = 0;
    lo[n] = yLo; hi[n] = yHi; n++;
    for (let i = 0; i < H.length && n < 24; i++) {
      const h = H[i];
      const kill = h.r * 0.62 + RADIUS;
      if (Math.abs(h.x - x) > kill + 190) continue;
      const c = h.y0 === undefined ? h.y : h.y0;
      const a = h.amp || 0;
      lo[n] = c - a - kill; hi[n] = c + a + kill; n++;
    }
    let best = 0;
    for (let sIdx = -1; sIdx < n; sIdx++) {
      const y = sIdx < 0 ? top : Math.max(top, hi[sIdx]);
      if (y >= bot) continue;
      let inside = false;
      for (let j = 0; j < n; j++) if (y > lo[j] && y < hi[j]) { inside = true; break; }
      if (inside) continue;
      let end = bot;
      for (let j = 0; j < n; j++) if (lo[j] > y && lo[j] < end) end = lo[j];
      if (end - y > best) best = end - y;
    }
    return best >= CHANNEL;
  }

  /**
   * Hazards that lump together stop being a choice and become one lumpy wall:
   * two floor urchins 91 units apart read as a single obstacle and double the
   * hit area without adding a decision.
   */
  _spaced(H, x, y, kill) {
    for (let i = 0; i < H.length; i++) {
      const h = H[i];
      const need = kill + h.r * 0.62 + RADIUS + 170;
      const dx = h.x - x, dy = (h.y0 === undefined ? h.y : h.y0) - y;
      if (dx * dx + dy * dy < need * need) return false;
    }
    return true;
  }

  /**
   * A tethered mote cannot dodge the bottom of its own arc - it is on rails
   * until it lets go. So a hazard at swing radius almost directly beneath a bulb
   * is not a timing choice, it is a toll: grab that bulb and you are hit. Keep
   * the bottom of the swing annulus clear. To the side of it hazards are fair
   * game, because there you still have a line past them - and that is where a
   * hazard genuinely does change when you release.
   */
  _swingClear(A, x, y, kill) {
    for (let i = 0; i < A.length; i++) {
      const a = A[i];
      const dx = x - a.x, dy = y - a.y;
      const d = Math.hypot(dx, dy);
      if (d > ROPE_MAX + kill + 40 || d < ROPE_MIN - kill - 40) continue;
      if (Math.abs(Math.atan2(dx, dy)) < 0.80) return false;   // 0 = straight down
    }
    return true;
  }

  _urchin(r, H, p, x, y, radLo, radHi, A) {
    x = clamp(x, Math.max(p.x0 + 20, START_SAFE), p.x1 - 20);
    if (x <= START_SAFE) return;
    const rad = r.range(radLo, radHi);
    if (!this._fits(x, y, rad, 0)) return;
    const kill = rad * 0.62 + RADIUS;
    if (A && !this._swingClear(A, x, y, kill)) return;
    if (!this._spaced(H, x, y, kill)) return;
    if (!this._passable(H, x, y - kill, y + kill)) return;
    H.push({
      kind: KIND.URCHIN, x, y, r: rad, phase: r() * TAU, spin: r.range(-0.3, 0.3),
      floor: y > (this.bandTop(x) + this.bandBot(x)) * 0.5, alive: true,
    });
  }

  _jelly(r, H, p, x, y, ampWant, A) {
    x = clamp(x, Math.max(p.x0 + 20, START_SAFE), p.x1 - 20);
    if (x <= START_SAFE) return;
    const rad = r.range(34, 52);
    const top = this.bandTop(x), bot = this.bandBot(x);
    const kill = rad * 0.62 + RADIUS;
    const amp = Math.min(ampWant, y - top - kill - 80, bot - y - kill - 80);
    if (amp < 40 || !this._fits(x, y, rad, amp)) return;
    if (A && !this._swingClear(A, x, y, kill + amp)) return;
    if (!this._spaced(H, x, y, kill + amp)) return;
    if (!this._passable(H, x, y - amp - kill, y + amp + kill)) return;
    H.push({
      kind: KIND.JELLY, x, y, y0: y, r: rad,
      amp, freq: r.range(0.16, 0.42), phase: r() * TAU, bellPhase: r() * TAU, alive: true,
    });
  }

  _onFloor(r, p, x) { return this.bandBot(x) - r.range(8, 64); }
  _onCeil(r, p, x) { return this.bandTop(x) + r.range(10, 70); }

  _layHazards(p, r, A, H, d) {
    if (p.hazard === 'none' || p.x1 < START_SAFE) return;
    const at = (f) => p.x0 + p.len * f;

    switch (p.hazard) {
      case 'wall': {
        const n = r.int(1, 1 + Math.round(d * 2));
        for (let i = 0; i < n; i++) {
          const x = at(r.range(0.15, 0.85));
          const up = r.chance(0.5);
          this._urchin(r, H, p, x, up ? this._onCeil(r, p, x) : this._onFloor(r, p, x), 38, 62, A);
        }
        break;
      }
      case 'floor': {
        const n = r.int(1, 3 + Math.round(d * 3));
        for (let i = 0; i < n; i++) {
          const x = at((i + r.range(0.2, 0.8)) / n);
          this._urchin(r, H, p, x, this._onFloor(r, p, x), 42, 70, A);
        }
        break;
      }
      case 'ceil': {
        const n = r.int(1, 2 + Math.round(d * 2));
        for (let i = 0; i < n; i++) {
          const x = at((i + r.range(0.2, 0.8)) / n);
          this._urchin(r, H, p, x, this._onCeil(r, p, x), 40, 66, A);
        }
        break;
      }
      case 'gap': {
        // In the middle of a leap, offset from the line - a graze, not a wall.
        for (let i = 0; i < A.length - 1; i++) {
          if (A[i + 1].x - A[i].x < 600) continue;
          const s = this._arcBetween(A[i], A[i + 1], d, r.range(0.38, 0.66));
          if (!s) continue;
          const tl = Math.hypot(s.tx, s.ty) || 1;
          const off = r.range(215, 310) * (r.chance(0.5) ? 1 : -1);
          const hx = s.x - (s.ty / tl) * off, hy = s.y + (s.tx / tl) * off;
          if (r.chance(0.45)) this._jelly(r, H, p, hx, hy, r.range(80, 190), A);
          else this._urchin(r, H, p, hx, hy, 40, 62, A);
        }
        break;
      }
      case 'mouth': {
        // One wall of the throat's mouth is guarded, so you must enter on the
        // other side of it. The pinch chooses your line before you arrive.
        const side = r.chance(0.5);
        const x = at(clamp(p.fc + (r.chance(0.5) ? -1 : 1) * p.fw * r.range(0.85, 1.05), 0.08, 0.92));
        this._urchin(r, H, p, x, side ? this._onCeil(r, p, x) : this._onFloor(r, p, x), 34, 52, A);
        break;
      }
      case 'field': {
        const n = r.int(2, 4 + Math.round(d * 4));
        for (let i = 0; i < n; i++) {
          const x = at((i + r.range(0.15, 0.85)) / n);
          const floor = r.chance((i & 1) === 0 ? 0.76 : 0.28);
          this._urchin(r, H, p, x, floor ? this._onFloor(r, p, x) : this._onCeil(r, p, x), 42, 70, A);
        }
        // Plus a couple hanging in the middle of the swing line.
        for (let i = 0; i < A.length - 1; i++) {
          if (!r.chance(0.42)) continue;
          const s = this._arcBetween(A[i], A[i + 1], d, r.range(0.35, 0.7));
          if (s) this._jelly(r, H, p, s.x, s.y + r.range(180, 330), r.range(90, 200), A);
        }
        break;
      }
      case 'shaft': {
        const cx = at(p.fc);
        for (let i = 0; i < r.int(2, 4); i++) {
          const x = cx + r.range(-0.32, 0.32) * p.len * p.fw;
          this._urchin(r, H, p, x, this._onFloor(r, p, x), 44, 72, A);
        }
        if (r.chance(0.6)) { const x = cx + r.range(-120, 120); this._urchin(r, H, p, x, this._onCeil(r, p, x), 38, 58, A); }
        break;
      }
      case 'vent': {
        // On the chimney tips: you may ride the current, but not everywhere.
        const v = p.vents || [];
        for (let i = 0; i < v.length; i++) {
          if (!r.chance(0.5)) continue;
          this._urchin(r, H, p, v[i], this.bandBot(v[i]) - r.range(150, 330), 38, 58, A);
        }
        break;
      }
      case 'pillar': {
        for (let k = 0; k <= p.bayN; k++) {
          if (!r.chance(0.42)) continue;
          const x = p.x0 + p.len * (k / p.bayN);
          this._urchin(r, H, p, x, this._onFloor(r, p, x), 40, 64, A);
        }
        if (r.chance(0.7)) {
          const u = (r.int(0, p.bayN - 1) + 0.5) / p.bayN;
          const x = p.x0 + p.len * u;
          this._jelly(r, H, p, x, (this.bandTop(x) + this.bandBot(x)) * 0.5, r.range(120, 240), A);
        }
        break;
      }
      case 'bloom': {
        // A lattice. Every column shares one phase so the vertical gaps inside a
        // column never close - the timing problem is which channel to take as
        // the columns slide past each other, not whether one exists.
        const cols = r.int(3, 5);
        const rowGap = r.range(330, 400);
        for (let c = 0; c < cols; c++) {
          const x = at((c + r.range(0.3, 0.7)) / cols);
          const top = this.bandTop(x), bot = this.bandBot(x);
          const ph = r() * TAU;
          const amp = r.range(95, 165);
          const stagger = (c & 1) ? rowGap * 0.5 : 0;
          for (let y = top + 300 + stagger; y < bot - 300; y += rowGap) {
            const rad = r.range(34, 50);
            const a2 = Math.min(amp, y - top - rad - 110, bot - y - rad - 110);
            if (a2 < 40) continue;
            const kk = rad * 0.62 + RADIUS;
            if (!this._swingClear(A, x, y, kk + a2)) continue;
            if (!this._passable(H, x, y - a2 - kk, y + a2 + kk)) continue;
            H.push({
              kind: KIND.JELLY, x: x + r.range(-26, 26), y, y0: y, r: rad,
              amp: a2, freq: r.range(0.2, 0.3), phase: ph + ((c & 1) ? Math.PI : 0),
              bellPhase: r() * TAU, alive: true,
            });
          }
        }
        break;
      }
      default: {   // 'sparse'
        if (r.chance(0.45)) { const x = at(r()); this._urchin(r, H, p, x, this._onFloor(r, p, x), 40, 66, A); }
        break;
      }
    }

    // Never let a bulb sit inside a kill radius: grabbing must never be death.
    for (let i = H.length - 1; i >= 0; i--) {
      const h = H[i];
      for (let j = 0; j < A.length; j++) {
        const dx = h.x - A[j].x, dy = h.y - A[j].y;
        if (dx * dx + dy * dy < 300 * 300) { H.splice(i, 1); break; }
      }
    }
  }

  // ---- plankton -----------------------------------------------------------
  _pk(out, r, H, x, y) {
    const top = this.bandTop(x) + 74, bot = this.bandBot(x) - 74;
    if (bot <= top) return;
    // Drop what falls outside rather than smearing it flat along the rock.
    if (y < top - 70 || y > bot + 70) return;
    y = clamp(y, top, bot);
    for (let i = 0; i < H.length; i++) {
      const h = H[i];
      const dx = h.x - x, dy = h.y - y;
      const rr = h.r * 0.62 + RADIUS + 46;
      if (dx * dx + dy * dy < rr * rr) return;      // never bait into a kill radius
    }
    out.push({
      kind: KIND.PLANKTON, x, y,
      r: r.chance(0.14) ? r.range(15.5, 19.5) : r.range(11, 14.5),
      phase: r() * TAU, taken: false, bob: r.range(0.55, 1.5),
    });
  }

  /**
   * An organic swarm: lobes clustered around a rough centroid, a density
   * gradient inside each lobe, a drift tail of stragglers. Never an arc, never
   * even spacing. Elongated along `ang` - which callers set to the flight
   * tangent - so harvesting a whole shoal means holding one committed line.
   */
  _swarm(out, r, H, cx, cy, n, rx, ry, ang) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const lobes = r.int(2, 4);
    const put = (px, py) => this._pk(out, r, H, cx + px * ca - py * sa, cy + px * sa + py * ca);

    let left = n;
    for (let L = 0; L < lobes; L++) {
      const take = L === lobes - 1 ? left : Math.max(1, Math.round(left * r.range(0.34, 0.68)));
      const cnt = Math.min(left, take);
      left -= cnt;
      const lu = lobes === 1 ? 0 : (L / (lobes - 1) - 0.5) * 2;
      const lox = lu * rx * r.range(0.30, 0.74) + (r() - 0.5) * rx * 0.24;
      const loy = clamp(r.normal(), -2, 2) * ry * 0.30;
      const lr = r.range(0.34, 0.74);
      for (let i = 0; i < cnt; i++) {
        // pow < 1 on the radius packs points toward the lobe's heart
        const rad = Math.pow(r(), 0.55), th = r() * TAU;
        put(lox + Math.cos(th) * rad * rx * lr,
          loy + Math.sin(th) * rad * ry * lr * r.range(0.7, 1.3));
      }
      if (left <= 0) break;
    }
    for (let i = 0, t = r.int(1, 3); i < t; i++) {
      put(-rx * r.range(1.05, 1.95), (r() - 0.5) * ry * 0.8);
    }
  }

  _trails(p, r, A, H, K, d, prob, nLo, nHi) {
    for (let i = 0; i < A.length - 1; i++) {
      const a = A[i], b = A[i + 1];
      if (b.x - a.x < 210) continue;
      if (!r.chance(prob)) continue;
      for (let q = 0, m = r.int(1, 2); q < m; q++) {
        const s = this._arcBetween(a, b, d, r.range(0.28, 0.80));
        if (!s) continue;
        this._swarm(K, r, H, s.x, s.y, r.int(nLo, nHi),
          r.range(120, 245), r.range(42, 100), Math.atan2(s.ty, s.tx));
      }
    }
  }

  _layPlankton(p, r, A, H, K, d) {
    if (p.pk === 'none') return;
    const at = (f) => p.x0 + p.len * f;
    const midY = (x) => (this.bandTop(x) + this.bandBot(x)) * 0.5;

    switch (p.pk) {
      case 'garden': {
        this._trails(p, r, A, H, K, d, 0.6, 5, 10);
        for (let i = 0, n = r.int(1, 2); i < n; i++) {
          const x = at(r.range(0.15, 0.85));
          this._swarm(K, r, H, x, midY(x) + r.range(-220, 260), r.int(16, 30),
            r.range(230, 420), r.range(120, 230), r.range(-0.5, 0.5));
        }
        break;
      }
      case 'cloud': {
        const x = at(r.range(0.35, 0.65));
        this._swarm(K, r, H, x, midY(x) + r.range(-260, 200), r.int(22, 38),
          r.range(320, 520), r.range(190, 330), r.range(-0.4, 0.4));
        this._trails(p, r, A, H, K, d, 0.4, 4, 8);
        break;
      }
      case 'leap': {
        // The reward for committing sits at the apex of the long flight.
        for (let i = 0; i < A.length - 1; i++) {
          if (A[i + 1].x - A[i].x < 560) continue;
          const s = this._arcBetween(A[i], A[i + 1], d, r.range(0.30, 0.55));
          if (!s) continue;
          this._swarm(K, r, H, s.x, s.y, r.int(12, 22),
            r.range(210, 330), r.range(60, 110), Math.atan2(s.ty, s.tx));
        }
        this._trails(p, r, A, H, K, d, 0.35, 4, 8);
        break;
      }
      case 'lowroute': {
        // Bait on the fast, exposed line: the gauntlet's low road.
        for (let i = 0; i < A.length; i++) {
          const a = A[i];
          if (a.stalk >= 0) continue;
          this._swarm(K, r, H, a.x + r.range(60, 260), a.y + r.range(60, 220),
            r.int(8, 16), r.range(190, 320), r.range(55, 110), r.range(-0.35, 0.35));
        }
        this._trails(p, r, A, H, K, d, 0.3, 4, 8);
        break;
      }
      case 'throat': {
        const x = at(p.fc);
        this._swarm(K, r, H, x, midY(x), r.int(6, 12), r.range(90, 160), r.range(28, 55), 0);
        break;
      }
      case 'vault': {
        for (let k = 0; k < p.bayN; k++) {
          if (!r.chance(0.8)) continue;
          const x = at((k + 0.5) / p.bayN);
          this._swarm(K, r, H, x, this.bandTop(x) + r.range(240, 520), r.int(8, 16),
            r.range(130, 220), r.range(80, 150), r.range(-0.3, 0.3));
        }
        break;
      }
      case 'wood': {
        for (let i = 0, n = r.int(3, 5); i < n; i++) {
          const x = at((i + r.range(0.2, 0.8)) / n);
          this._swarm(K, r, H, x, this.bandBot(x) - r.range(150, 460), r.int(7, 14),
            r.range(140, 250), r.range(80, 160), r.range(-0.4, 0.4));
        }
        this._trails(p, r, A, H, K, d, 0.4, 4, 8);
        break;
      }
      case 'updraft': {
        // A column standing in the current: ride the vent and it strings itself.
        const v = p.vents || [];
        for (let i = 0; i < v.length; i++) {
          if (!r.chance(0.8)) continue;
          const x = v[i] + r.range(-40, 60);
          const bot = this.bandBot(x);
          this._swarm(K, r, H, x, bot - r.range(320, 560), r.int(7, 14),
            r.range(60, 110), r.range(200, 340), 0);
        }
        break;
      }
      case 'bloom': {
        // In the channels between columns, where the lattice is passable.
        for (let i = 0, n = r.int(2, 4); i < n; i++) {
          const x = at((i + r.range(0.35, 0.65)) / n);
          this._swarm(K, r, H, x, midY(x) + r.range(-200, 200), r.int(8, 16),
            r.range(150, 250), r.range(90, 170), r.range(-0.3, 0.3));
        }
        break;
      }
      case 'orbit': {
        let m = null;
        for (let i = 0; i < A.length; i++) if (A[i].ancient) m = A[i];
        if (m) {
          for (let q = 0, n = r.int(3, 4); q < n; q++) {
            const th = (q / n) * TAU + r.range(-0.4, 0.4);
            const rr = r.range(390, 640);
            this._swarm(K, r, H, m.x + Math.cos(th) * rr, m.y + Math.sin(th) * rr * 0.7,
              r.int(7, 13), r.range(130, 210), r.range(70, 130), th + Math.PI * 0.5);
          }
        }
        this._trails(p, r, A, H, K, d, 0.45, 5, 10);
        break;
      }
      case 'shaft': {
        const x = at(p.fc) + r.range(-60, 60);
        this._swarm(K, r, H, x, this.bandBot(x) - r.range(280, 520), r.int(10, 20),
          r.range(90, 150), r.range(220, 360), 0);
        this._trails(p, r, A, H, K, d, 0.35, 4, 8);
        break;
      }
      default:
        this._trails(p, r, A, H, K, d, 0.55, 5, 11);
        break;
    }
  }

  // ---- decor: ecosystems, not scatter -------------------------------------
  /** A stand of kelp: dense at the heart, one prevailing lean, one light level. */
  _kelpBed(D, r, p, cx, halfW, n, lum) {
    const lean = r.range(-0.30, 0.30);
    const tall = r.range(0.75, 1.30);
    for (let i = 0; i < n; i++) {
      const u = clamp(r.normal() * 0.42, -1, 1);
      const kx = clamp(cx + u * halfW, p.x0 + 8, p.x1 - 8);
      const h = r.range(190, 560) * tall * (1 - 0.5 * Math.abs(u)) + 95;
      const far = r.chance(0.26);
      D.push({
        kind: KIND.KELP, x: kx, y: this.bandBot(kx), h,
        w: clamp(4.2 + h * 0.0125 + r.range(-1.4, 1.9), 3.4, 15),
        phase: r() * TAU, sway: r.range(0.32, 0.86), lean: lean + r.range(-0.14, 0.14),
        segs: 9, glow: lum > 0 && r.chance(0.55) ? r.range(0.22, 0.95) * lum : 0,
        depth: far ? r.range(0.48, 0.80) : r.range(0.04, 0.38),
      });
    }
  }

  /** A ridge of rock: one crest, one depth stratum, fanning out from the peak. */
  _spireRidge(D, r, p, cx, halfW, n, up) {
    const stratum = r.chance(0.42) ? r.range(0.50, 0.78) : r.range(0.06, 0.34);
    const peak = r.range(280, 560);
    for (let i = 0; i < n; i++) {
      const u = clamp((n === 1 ? 0 : (i / (n - 1)) * 2 - 1) + r.range(-0.16, 0.16), -1.1, 1.1);
      const sx = clamp(cx + u * halfW, p.x0 + 8, p.x1 - 8);
      const h = peak * (0.34 + 0.66 * Math.cos(clamp(u, -1, 1) * 1.35)) * r.range(0.78, 1.22);
      D.push({
        kind: KIND.SPIRE, x: sx, y: up ? this.bandBot(sx) : this.bandTop(sx),
        h: Math.max(70, h), w: clamp(h * r.range(0.20, 0.34), 26, 190), up,
        depth: clamp(stratum + r.range(-0.06, 0.06), 0, 0.85),
        lean: clamp(u, -1, 1) * r.range(0.06, 0.20),
      });
    }
  }

  /** A colony: mostly one species, clumped, with a couple of odd ones out. */
  _anemoneColony(D, r, p, cx, halfW, n, up) {
    const hue = r.chance(0.62) ? 0 : 1;
    for (let i = 0; i < n; i++) {
      const u = clamp(r.normal() * 0.45, -1, 1);
      const ax = clamp(cx + u * halfW, p.x0 + 8, p.x1 - 8);
      D.push({
        kind: KIND.ANEMONE, x: ax, y: up ? this.bandBot(ax) - 8 : this.bandTop(ax) + 8,
        r: r.range(13, 38) * (1 - 0.3 * Math.abs(u)), phase: r() * TAU, up,
        hue: r.chance(0.82) ? hue : 1 - hue, depth: r.range(0, 0.34),
      });
    }
  }

  _layDecor(p, r, D) {
    const at = (f) => p.x0 + p.len * f;

    // A far, desaturated stratum in every phrase. Without it a wide chamber is
    // an empty frame, and there is nothing for the near silhouettes to read
    // against.
    for (let i = 0, n = r.int(2, 4) + Math.round(p.len / 900); i < n; i++) {
      const up = r.chance(0.5);
      const fx = clamp(at(r()), p.x0 + 10, p.x1 - 10);
      D.push({
        kind: KIND.SPIRE, x: fx, y: up ? this.bandBot(fx) : this.bandTop(fx),
        h: r.range(260, 620), w: r.range(70, 190), up,
        depth: r.range(0.56, 0.82), lean: r.range(-0.16, 0.16),
      });
    }
    switch (p.decor) {
      case 'lush':
        for (let i = 0, n = r.int(2, 3); i < n; i++) {
          this._kelpBed(D, r, p, at(r()), r.range(150, 300), r.int(7, 15), r.range(0.5, 1));
        }
        this._anemoneColony(D, r, p, at(r()), r.range(90, 180), r.int(4, 9), true);
        if (r.chance(0.6)) this._anemoneColony(D, r, p, at(r()), 120, r.int(3, 6), false);
        this._spireRidge(D, r, p, at(r()), r.range(160, 300), r.int(2, 4), r.chance(0.5));
        if (r.chance(0.7)) this._spireRidge(D, r, p, at(r()), r.range(150, 280), r.int(2, 4), false);
        break;

      case 'teeth':          // a slot canyon: opposing teeth, little else
        this._spireRidge(D, r, p, at(r.range(0.12, 0.45)), r.range(140, 265), r.int(3, 5), true);
        this._spireRidge(D, r, p, at(r.range(0.52, 0.88)), r.range(140, 265), r.int(3, 5), false);
        if (r.chance(0.55)) this._kelpBed(D, r, p, at(r()), 145, r.int(3, 6), r.chance(0.4) ? 0.6 : 0);
        break;

      case 'walls':
        this._spireRidge(D, r, p, at(r.range(0.1, 0.6)), r.range(180, 320), r.int(2, 5), r.chance(0.5));
        if (r.chance(0.8)) this._kelpBed(D, r, p, at(r()), r.range(130, 260), r.int(5, 11), r.chance(0.45) ? r.range(0.3, 0.8) : 0);
        if (r.chance(0.5)) this._anemoneColony(D, r, p, at(r()), 120, r.int(3, 6), true);
        if (r.chance(0.75)) this._spireRidge(D, r, p, at(r()), r.range(160, 300), r.int(2, 5), false);
        break;

      case 'vista':          // scale: big far formations, sparse near ones
        for (let i = 0, n = r.int(3, 5); i < n; i++) {
          this._spireRidge(D, r, p, at(r()), r.range(220, 420), r.int(3, 6), r.chance(0.5));
        }
        this._kelpBed(D, r, p, at(r()), 220, r.int(4, 9), r.range(0.3, 0.9));
        if (r.chance(0.7)) this._anemoneColony(D, r, p, at(r()), 150, r.int(3, 7), true);
        break;

      case 'kelpwood': {
        const beds = r.int(3, 5);
        for (let i = 0; i < beds; i++) {
          this._kelpBed(D, r, p, at((i + r.range(0.2, 0.8)) / beds), r.range(150, 280), r.int(6, 12), r.range(0.55, 1.0));
        }
        this._anemoneColony(D, r, p, at(r()), 160, r.int(4, 9), true);
        if (r.chance(0.6)) this._spireRidge(D, r, p, at(r()), 220, r.int(2, 4), false);
        break;
      }

      case 'cathedral': {
        // Paired pillars at the bay joints, where the vault's ceiling comes
        // down. Near and far strata interleave so the nave has real depth.
        for (let k = 0; k <= p.bayN; k++) {
          const px = clamp(at(k / p.bayN), p.x0 + 8, p.x1 - 8);
          const top = this.bandTop(px), bot = this.bandBot(px);
          const dep = (k & 1) ? r.range(0.52, 0.74) : r.range(0.07, 0.24);
          const reach = (bot - top) * (0.5 - r.range(0.16, 0.30) * 0.5);
          D.push({
            kind: KIND.SPIRE, x: px, y: bot, h: reach * r.range(0.90, 1.08),
            w: r.range(110, 205), up: true, depth: dep, lean: r.range(-0.07, 0.07),
          });
          const qx = clamp(px + r.range(-26, 26), p.x0 + 8, p.x1 - 8);
          D.push({
            kind: KIND.SPIRE, x: qx, y: this.bandTop(qx), h: reach * r.range(0.90, 1.08),
            w: r.range(100, 190), up: false,
            depth: clamp(dep + r.range(-0.05, 0.05), 0, 0.85), lean: r.range(-0.07, 0.07),
          });
          if (r.chance(0.6)) this._anemoneColony(D, r, p, px, 60, r.int(2, 5), true);
        }
        break;
      }

      case 'vents': {
        const v = p.vents || [];
        for (let i = 0; i < v.length; i++) {
          const vx = clamp(v[i], p.x0 + 8, p.x1 - 8);
          D.push({
            kind: KIND.SPIRE, x: vx, y: this.bandBot(vx), h: r.range(190, 520),
            w: r.range(30, 74), up: true, depth: r.range(0.05, 0.30), lean: r.range(-0.12, 0.12),
          });
          this._anemoneColony(D, r, p, vx, r.range(50, 110), r.int(2, 6), true);
        }
        if (r.chance(0.7)) this._kelpBed(D, r, p, at(r()), 180, r.int(3, 7), r.range(0.4, 0.9));
        this._spireRidge(D, r, p, at(r()), 260, r.int(2, 4), false);
        break;
      }

      case 'sparse':
        if (r.chance(0.75)) this._kelpBed(D, r, p, at(r()), 165, r.int(3, 7), r.chance(0.45) ? 0.5 : 0);
        if (r.chance(0.5)) this._spireRidge(D, r, p, at(r()), 200, r.int(1, 3), r.chance(0.5));
        break;

      default:               // 'mixed'
        this._kelpBed(D, r, p, at(r()), r.range(130, 280), r.int(5, 12), r.chance(0.55) ? r.range(0.3, 0.9) : 0);
        if (r.chance(0.7)) this._spireRidge(D, r, p, at(r()), r.range(160, 300), r.int(2, 4), r.chance(0.5));
        if (r.chance(0.55)) this._anemoneColony(D, r, p, at(r()), 130, r.int(3, 7), r.chance(0.65));
        if (r.chance(0.72)) this._spireRidge(D, r, p, at(r()), r.range(150, 290), r.int(2, 4), false);
        break;
    }
  }

  /** Drop everything the Hush has eaten. */
  cull() {
    const cut = this.hushX - 900;
    const keep = (a) => a.x > cut;
    if (this.anchors.length && this.anchors[0].x <= cut) this.anchors = this.anchors.filter(keep);
    if (this.hazards.length && this.hazards[0].x <= cut) this.hazards = this.hazards.filter(keep);
    if (this.plankton.length && this.plankton[0].x <= cut) this.plankton = this.plankton.filter(keep);
    if (this.decor.length && this.decor[0].x <= cut) this.decor = this.decor.filter(keep);
  }

  update(dt, t, playerX) {
    this.populate(playerX + GEN_AHEAD);
    this.difficulty = this.difficultyAt(playerX);
    for (const h of this.hazards) {
      if (h.kind === KIND.JELLY) {
        h.y = h.y0 + Math.sin(t * h.freq * TAU + h.phase) * h.amp;
      }
    }
    this.cull();
  }

  /**
   * Best anchor to grab from (px,py) travelling (vx,vy).
   * Prefers anchors that are ahead, above, and inside reach - the ones that
   * actually convert into a good swing.
   */
  pickAnchor(px, py, vx, vy, reach) {
    let best = null, bestScore = -Infinity;
    const reach2 = reach * reach;
    const speed = Math.hypot(vx, vy) || 1;
    const dirx = vx / speed, diry = vy / speed;
    for (let i = 0; i < this.anchors.length; i++) {
      const a = this.anchors[i];
      if (!a.alive) continue;
      const dx = a.x - px, dy = a.y - py;
      if (dx < -140) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 > reach2 || d2 < 900) continue;
      const d = Math.sqrt(d2);
      const above = clamp01((-dy) / 420);            // hanging above us is ideal
      const ahead = clamp01((dx + 90) / (reach * 0.8));
      const align = clamp01(0.5 + 0.5 * (dx * dirx + dy * diry) / d);
      const near = 1 - clamp01(d / reach);
      const score = above * 2.05 + ahead * 1.55 + align * 0.75 + near * 0.95 + (a.big ? 0.22 : 0);
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }
}

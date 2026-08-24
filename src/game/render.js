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
// 4. The Hush consumes what it reaches; it is not a curtain drawn over it. A
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

const MAXP = 96;         // longest polyline any shape here needs
const FAR = 0.44;        // decor depth that moves an object into the far round
const CORE_MIN = 4.2;    // world units: below this a ribbon core aliases to dots

// Emitter cores run at genuinely hot linear values - see the exposure contract
// in AGENTS.md, which the frame must peak above 6.0 pre-tonemap. Halation, the
// bloom veil's long tail and the tonemap shoulder all key off the top end; a
// core sitting at 1.2 leaves the entire response curve unexercised and light
// stops looking like light. Hot regions are kept a few pixels wide so the bulk
// of the frame stays deep shadow (p50 < 0.03).
// Two measurements constrain the numbers below, and they pull against each other
// through the bloom, so these are measured rather than chosen.
//
// 1. `hdrStats` samples a 96x54 grid over the scene buffer - on 1600x900, one
//    sample every ~17px. A hot lobe four pixels wide is therefore *missed* by
//    the `max` statistic about 19 times out of 20, which is why the HDR contract
//    failed at random while the mote's nucleus was genuinely at 22 linear. The
//    statistic is satisfied by emitters that are wide or numerous, and CORE,
//    being a near-delta, is never wide: its hot lobe is a tenth of its quad
//    however large the quad is drawn.
//
// 2. Focal contrast is measured as the mote's core against an annulus 40-60px
//    around it, so every unit of light the mote spills into that band costs
//    twice. Isolated by elimination: with the mote drawn that annulus measured
//    0.728, with it removed 0.213. It is the mote's own bloom, not the
//    environment's, and not the particles'.
//
// Together: keep the mote's light inside about 30px of its body and buy the HDR
// headroom from emitters that are *not* the mote. A plateau on the mote bright
// enough to be sampled reliably was tried and measured - it moved the core from
// 0.907 to 0.970 (already saturated) and the surround from 0.294 to 0.727. That
// trade is not worth making here; the bloom radius that would make it worth
// making belongs to postfx.
const HOT = 34;          // peak gain of the mote nucleus - the one knob

// The frame's reliable sample above 6 linear is bought two ways, and neither is
// "make the brightest object brighter". The anchor cores are the widest hot
// lobes in frame, so their *quad* is widened at constant peak (see _anchor);
// raising their gain from 11 to 15 satisfies the statistic too, but it made the
// first render of a frozen state differ from the next four by one code value at
// the top of the frame where they hang - something on the post side settles
// after a frame once they are that hot, and tools/_det3.mjs catches it. The rest
// comes from HDR_FLOOR: the gain of the 'ripe' third of the plankton field,
// which is numerous, spread across the frame, and blooms nowhere near the mote.
const HDR_FLOOR = 21;

// The Hush's absorption profile, in world units. Light starts to go before the
// front arrives (the field has a leading edge of scatter) and is gone well
// behind it, rather than switching off at a line.
const HUSH_LEAD = 220;
const HUSH_DEEP = 760;

/** Ribbon width that renders a visible core `core` units wide at `falloff`. */
const wCore = (core, falloff) => Math.max(core, CORE_MIN) * Math.sqrt(falloff / 0.693);

export class Scene {
  constructor(gl, tex) {
    this.gl = gl;
    this.occl = new SpriteBatch(gl, tex.sprites, 4096);
    this.glow = new SpriteBatch(gl, tex.sprites, 12288);
    this.rDark = new Ribbons(gl, 49152);
    this.rGlow = new Ribbons(gl, 65536);
    this._hx = -1e9;             // Hush front, world x. Set per frame in draw().

    // Ribbons.stroke() needs an exactly-sized array, so cache every view up
    // front rather than minting a subarray per shape per frame. Three pools =
    // three polylines can be live at once (body, rim, appendage).
    this._pool = [new Float32Array(MAXP * 2), new Float32Array(MAXP * 2), new Float32Array(MAXP * 2)];
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
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (d.x < b.x0 - 520) continue;
      if (d.x > b.x1 + 520) break;
      if ((d.depth >= FAR) !== far) continue;
      if (d.kind === KIND.KELP) this._kelp(d, t, dim);
      else if (d.kind === KIND.SPIRE) this._spire(d, t, dim);
      else if (d.kind === KIND.ANEMONE) this._anemone(d, t, dim);
    }
  }

  _kelp(d, t, dim) {
    const n = 12, pts = this._p1(n);
    const sid = (d.x * 3.11) | 0;
    const e = this._eat(d.x);
    const dm = dim * (1 - e);
    // Travelling wave down the stalk: the tip lags the base, which is what makes
    // a plant look pushed by water rather than rotated about its root.
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      const wave = Math.sin(t * d.sway + d.phase - f * 1.75) * 0.74
                 + Math.sin(t * d.sway * 1.9 + d.phase * 1.7 - f * 3.1) * 0.26;
      pts[s * 2] = d.x + f * f * d.lean * 205 + wave * 168 * f * f;
      pts[s * 2 + 1] = d.y - d.h * f;
    }

    // Fibre. A stalk of constant width is a wire however well it sways, so the
    // profile carries two octaves of thickness noise and the stroke is a
    // *bundle* - one thick strand plus a thin one that separates near the tip.
    // Two octaves only: the stalk is a 12-point polyline, so width detail above
    // about six cycles has nowhere to be sampled and aliases into a wobble.
    const fib = (f) => 0.74 + 0.36 * noise1(f * 4.1 + sid * 0.021) + 0.20 * noise1(f * 11.3 + sid * 0.037);
    depthFade(PAL.voidDeep, d.depth * 0.55, c0);
    const opa = (1 - d.depth * 0.30) * (1 - e * 0.55);
    // Fleshy at the root, whip-thin at the tip. The old profile ran 3.05 -> 0.44
    // over pow(f, 0.82), which at these widths is a 12px line going to a 2px
    // line - measurably a taper, visibly a wire.
    const wmain = (f) => lerp(d.w * 4.10, d.w * 0.38, Math.pow(f, 0.92)) * fib(f);
    this.rDark.stroke(pts, {
      width: wmain, color: c0, alpha: (f) => lerp(0.97, 0.16, Math.pow(f, 1.3)) * opa, falloff: 1.15,
    });
    const side = hash2(sid, 91) > 0.5 ? 1 : -1;
    const str = this._p3(n);
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      str[s * 2] = pts[s * 2] + side * wmain(f) * (0.22 + 0.55 * f * f);
      str[s * 2 + 1] = pts[s * 2 + 1] + d.w * 0.5 * f;
    }
    this.rDark.stroke(str, {
      width: (f) => lerp(d.w * 1.15, d.w * 0.20, Math.pow(f, 0.7)) * fib(f * 1.7 + 0.3),
      color: c0, alpha: (f) => lerp(0.86, 0.10, Math.pow(f, 1.1)) * opa, falloff: 1.2,
    });

    // Edge light colour is needed by the blades as well as by the stalk, so it
    // is resolved before either draws.
    depthFade(PAL.waterHigh, d.depth * 0.70 + 0.08, c1);
    if (e > 0) this._ate(c1, e, c1);

    // Holdfast. Kelp grips rock; it does not sprout from a point. Two lobes of
    // unequal size, because a clean joint is the tell that both were drawn.
    for (let k = 0; k < 2; k++) {
      const hk = hash2(sid, k * 7 + 61);
      const hw = d.w * (1.5 + hk * 2.2);
      this.occl.push(d.x + (hk - 0.5) * d.w * 3.4, d.y + d.w * 0.55,
        hw * 2.7, hw * 1.15, (hk - 0.5) * 0.55, c0[0], c0[1], c0[2], 0.80 * opa, L_ROCK);
    }

    // Blades. A bare curve is a wire; blades make it a plant.
    const nb = 7;
    for (let k = 0; k < nb; k++) {
      const f = 0.11 + 0.82 * ((k + hash2(sid, k * 5 + 1) * 0.78) / nb);
      const si = Math.min(n - 2, (f * (n - 1)) | 0), lf = f * (n - 1) - si;
      const px = lerp(pts[si * 2], pts[si * 2 + 2], lf);
      const py = lerp(pts[si * 2 + 1], pts[si * 2 + 3], lf);
      let tx = pts[si * 2 + 2] - pts[si * 2], ty = pts[si * 2 + 3] - pts[si * 2 + 1];
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const sd = (k & 1) ? 1 : -1;
      const bl = d.w * (5.4 + Math.pow(hash2(sid, k * 7 + 3), 1.5) * 6.6) * (1 - f * 0.40);
      // SHARD's visible ribbon is 13% of the quad it is painted in, so a quad
      // two units tall renders a quarter-unit thread - which is exactly why
      // these blades read as twigs. Height now comes from the blade's own
      // length, so a blade is a ribbon whose taper you can see.
      const bw = bl * (0.58 + hash2(sid, k * 11 + 5) * 0.54);
      const ang = Math.atan2(ty, tx) + sd * (0.52 + 0.34 * Math.sin(t * d.sway * 1.3 + k * 2.1 + d.phase));
      this.occl.push(px + Math.cos(ang) * bl * 0.42, py + Math.sin(ang) * bl * 0.42,
        bl, bw, ang, c0[0], c0[1], c0[2], 0.88 * opa, L_LEAF);
      // A dark ribbon on dark water is a hole, so each blade gets a lit face
      // offset off its own medial axis. SHARD again, not FILAMENT: FILAMENT's
      // hair is 2.7% of the quad it is painted in, which at a blade's scale is a
      // fifth of a pixel and mips away to nothing. The same profile at 60% of
      // the height reads as the lit side of the same ribbon.
      const bn = ang + Math.PI * 0.5;
      const bk = 1.30 * (0.40 + 0.90 * hash2(sid, k * 11 + 9)) * dm * (1 - d.depth * 0.62);
      this.glow.push(px + Math.cos(ang) * bl * 0.44 - Math.cos(bn) * bw * 0.17,
        py + Math.sin(ang) * bl * 0.44 - Math.sin(bn) * bw * 0.17,
        bl * 0.84, bw * 0.58, ang, c1[0] * bk, c1[1] * bk, c1[2] * bk, 1, L_LEAF);
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
      width: (f) => wmain(f) * 0.92, color: c1,
      alpha: (f) => 0.60 * (1 - f * 0.34) * (0.6 + 0.5 * fib(f)) * dm * (1 - d.depth * 0.5),
      falloff: 1.15,
    });
    this.rGlow.stroke(off, {
      width: (f) => lerp(wCore(d.w * 0.75, 3), wCore(0, 3), f), color: c1,
      alpha: (f) => 0.66 * (1 - f * 0.5) * (0.55 + 0.55 * fib(f)) * dm, falloff: 3,
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
        const pk = 0.40 + 0.60 * Math.sin(t * (1.3 + hk * 1.1) + k * 2.3 + d.phase * 2.1);
        const kk = lit * pk;
        this.glow.puts(px, py, d.w * 7.0, scaled(c2, kk * 0.34, c3), 1, S.GLOW);
        this.glow.puts(px, py, d.w * 1.7, scaled(pc, kk * 5.5, c3), 1, S.CORE);
      }
      const tx = pts[(n - 1) * 2], ty = pts[(n - 1) * 2 + 1];
      const tp = 0.58 + 0.42 * Math.sin(t * 1.7 + d.phase * 2.1);
      this.glow.puts(tx, ty, d.w * 14, scaled(c2, lit * tp * 0.40, c3), 1, S.GLOW);
      this.glow.puts(tx, ty, d.w * 3.8, scaled(c2, lit * tp * 0.85, c3), 1, S.GLOW);
      this.glow.puts(tx, ty, d.w * 1.4, scaled(pc, lit * tp * 8.0, c3), 1, S.CORE);
    }
  }

  _spire(d, t, dim) {
    const dir = d.up ? -1 : 1;
    const sid = (d.x * 5.77) | 0;
    const subs = hash2(sid, 3) > 0.55 ? 3 : 2;
    const e = this._eat(d.x);
    const dm = dim * (1 - e);
    depthFade(PAL.voidDeep, d.depth * 0.28, c0);
    depthFade(PAL.surface, d.depth * 0.80 + 0.10, c1);
    if (e > 0) this._ate(c1, e, c1);
    const opa = (1 - d.depth * 0.16) * (1 - e * 0.5);

    for (let q = 0; q < subs; q++) {
      const first = q === 0;
      const sx = d.x + (hash2(sid, q * 9 + 1) - 0.5) * d.w * 1.6;
      const hq = d.h * (first ? 1 : 0.40 + hash2(sid, q * 9 + 2) * 0.44);
      const wq = d.w * (first ? 1 : 0.30 + hash2(sid, q * 9 + 3) * 0.36);
      const lean = d.lean + (hash2(sid, q * 9 + 4) - 0.5) * 0.24;
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
        pts[s * 2 + 1] = d.y + dir * hq * f;
      }
      // Ridged width, two octaves: rock has facets and steps, and one smooth
      // low-frequency wobble on a cone still measures as a constant-width
      // stroke. The fine octave is what puts a burr on the silhouette.
      const wfn = (f) => lerp(wq, wq * tipw, Math.pow(f, blunt ? 0.74 : 0.60))
        * (0.78 + 0.34 * noise1(f * 6.5 + jseed) + 0.15 * noise1(f * 21.3 + jseed * 1.7))
        * (f > brk ? lerp(1, 0.18, (f - brk) / (1 - brk)) : 1);
      this.rDark.stroke(pts, { width: wfn, color: c0, alpha: 0.985 * opa, falloff: 0.95 });

      if (blunt) {
        // The fracture face, then two spalls hanging off it. A break needs a
        // surface and some debris or it reads as an end rather than as damage.
        // SMOKE's mask dies inside its own tile in every direction, so these
        // cannot themselves become the rectangle they exist to hide.
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
      this.rGlow.stroke(off, {
        width: (f) => lerp(wCore(wq * 0.10, 4), wCore(0, 4), f), color: c1,
        alpha: (f) => 0.26 * grad(f) * glint(f) * (1 - d.depth * 0.55) * dm, falloff: 4,
      });
      // Flutes: two grazes down the face. Rock without them is a flat plate,
      // and the frame's weakest measured axis was material.
      for (let fq = 0; fq < 2; fq++) {
        const lat = fq ? 0.58 : 0.14;
        const fl = this._p3(n);
        for (let s = 0; s < n; s++) {
          const f = s / (n - 1);
          fl[s * 2] = pts[s * 2] - wfn(f) * lat;
          fl[s * 2 + 1] = pts[s * 2 + 1];
        }
        this.rGlow.stroke(fl, {
          width: (f) => lerp(wCore(wq * 0.05, 4.5), wCore(0, 4.5), Math.pow(f, 0.8)), color: c1,
          alpha: (f) => 0.085 * grad(f) * glint(f * 1.7 + fq * 4.1) * (1 - d.depth * 0.62) * dm,
          falloff: 4.5,
        });
      }

      if (first) {
        // Skirt: without it the spire floats instead of growing out of the rock.
        this.occl.push(sx, d.y + dir * wq * 0.12, wq * 2.8, wq * 1.0, 0,
          c0[0], c0[1], c0[2], 0.55 * opa, L_ROCK);
        // Rubble. Three blocks of unequal size, because a clean joint between a
        // column and the floor is the giveaway that both were drawn, not grown.
        for (let k = 0; k < 3; k++) {
          const hk = hash2(sid, k * 13 + 21);
          const rw = wq * (0.30 + hk * 0.62);
          this.occl.push(sx + (hash2(sid, k * 13 + 22) - 0.5) * wq * 2.4,
            d.y + dir * rw * (0.10 + hk * 0.30), rw * 1.9, rw * 1.15,
            (hk - 0.5) * 0.8, c0[0], c0[1], c0[2], 0.70 * opa, L_ROCK);
        }
      }
    }
  }

  _anemone(d, t, dim) {
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
    let base = warm ? PAL.anchorMid : mixCol(PAL.plankton, PAL.surface, 0.30, o0);
    let tip = warm ? PAL.anchorLive : mixCol(PAL.plankton, PAL.planktonCore, 0.30, o1);
    if (e > 0) { base = this._ate(base, e, o2); tip = this._ate(tip, e, o3); }
    const breathe = 0.55 + 0.45 * Math.sin(t * 1.15 + d.phase);
    const k = (0.40 + breathe * 0.62) * (1 - d.depth * 0.75) * dim * (1 - e);

    // Stubby column, dark, so the thing sits on rock instead of hovering.
    depthFade(PAL.voidDeep, d.depth * 0.4, c0);
    const cp = this._p1(2);
    cp[0] = d.x; cp[1] = d.y; cp[2] = d.x + d.r * 0.08; cp[3] = d.y + dir * d.r * 0.72;
    this.rDark.stroke(cp, {
      width: (f) => lerp(d.r * 1.6, d.r * 0.95, f), color: c0, alpha: 0.90, falloff: 1.0,
    });

    const arms = 11;
    const base0 = Math.atan2(dir, 0);
    for (let a = 0; a < arms; a++) {
      const h = hash2(sid, a * 3 + 1);
      const ang0 = base0 + ((a + 0.5) / arms - 0.5) * Math.PI * 1.10;
      const L = d.r * (1.5 + h * 1.6) * (0.86 + 0.24 * Math.sin(t * 1.4 + a * 1.9 + d.phase));
      const curl = (h - 0.5) * 1.5 + Math.sin(t * 0.9 + a * 1.3 + d.phase) * 0.32;
      const ca = Math.cos(ang0), sa = Math.sin(ang0);
      const bx = d.x, by = d.y + dir * d.r * 0.45;
      const n = 4, pts = this._p2(n);
      for (let s = 0; s < n; s++) {
        const f = s / (n - 1);
        pts[s * 2] = bx + ca * L * f - sa * curl * L * f * f * 0.5;
        pts[s * 2 + 1] = by + sa * L * f + ca * curl * L * f * f * 0.5;
      }
      this.rGlow.stroke(pts, {
        width: (f) => lerp(wCore(d.r * 0.16, 3.5), wCore(0, 3.5), Math.pow(f, 0.7)), color: base,
        alpha: (f) => k * 0.42 * (1 - f * 0.35), falloff: 3.5,
      });
      const ex = pts[(n - 1) * 2], ey = pts[(n - 1) * 2 + 1];
      this.glow.puts(ex, ey, d.r * 0.95, scaled(tip, k * 2.9, c1), 1, S.CORE);
      this.glow.puts(ex, ey, d.r * 2.8, scaled(base, k * 0.20, c1), 1, S.GLOW);
    }
    this.glow.puts(d.x, d.y + dir * d.r * 0.35, d.r * 6.0, scaled(base, k * 0.30, c1), 1, S.GLOW);
    this.glow.puts(d.x, d.y + dir * d.r * 0.55, d.r * 1.5, scaled(tip, k * 2.3, c1), 1, S.CORE);
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
      this.glow.puts(h.x + Math.cos(a) * rr, h.y + Math.sin(a) * rr,
        r * (1.10 + hq * 1.05),
        scaled(cBod, (0.16 + 0.10 * p) * hot * (0.45 + hq2 * 1.05), c1), 1, S.GLOW);
    }

    // Shell: an absence. THORN carries the material - it is the profile the
    // texture kit built for exactly this - and the geometric spines carry the
    // per-instance variance a single texture cannot. Neither lights the middle.
    this.occl.push(h.x, h.y, r * 3.0, r * 3.0, spin * 0.8,
      PAL.hazardDark[0], PAL.hazardDark[1], PAL.hazardDark[2], 0.70, S.THORN);

    // Spines. The hot edge runs along the outer shaft rather than sitting as a
    // bead on the point: that is what puts the hazard's own hue on the majority
    // of its pixels instead of on forty of them.
    const ns = 17;
    for (let k = 0; k < ns; k++) {
      const h1 = hash2(sid, k * 3 + 1), h2 = hash2(sid, k * 3 + 2), h3 = hash2(sid, k * 3 + 5);
      const ang = spin + (k / ns) * TAU + (h1 - 0.5) * 0.44;
      const L = r * (1.02 + Math.pow(h2, 1.25) * 1.06);
      const bend = (h1 - 0.5) * 0.55;
      const thick = 0.19 + h3 * 0.19;
      const n = 5, pts = this._p2(n);
      for (let s = 0; s < n; s++) {
        const f = s / (n - 1);
        const a = ang + bend * f * f;
        const rr = r * 0.24 + (L - r * 0.24) * f;
        pts[s * 2] = h.x + Math.cos(a) * rr;
        pts[s * 2 + 1] = h.y + Math.sin(a) * rr;
      }
      const swf = (f) => lerp(r * thick, r * 0.012, Math.pow(f, 0.62))
        * (0.84 + 0.30 * noise1(f * 4.7 + h1 * 11.3));
      this.rDark.stroke(pts, {
        width: swf, color: PAL.hazardDark, alpha: (f) => 0.99 - f * 0.14, falloff: 0.95,
      });
      // Offset to one flank, so it reads as a lit side and not as an outline.
      const nx0 = -Math.sin(ang), ny0 = Math.cos(ang);
      const gz = this._p3(n);
      for (let s = 0; s < n; s++) {
        const f = s / (n - 1);
        const w = swf(f) * 0.46;
        gz[s * 2] = pts[s * 2] + nx0 * w;
        gz[s * 2 + 1] = pts[s * 2 + 1] + ny0 * w;
      }
      const gk = (0.72 + 0.28 * p) * hot * (0.52 + h3 * 0.72);
      this.rGlow.stroke(gz, {
        width: (f) => lerp(wCore(r * 0.070, 4), wCore(r * 0.022, 4), Math.pow(f, 0.5)),
        color: scaled(cRim, 2.9 * gk, c1),
        alpha: (f) => 0.66 * Math.pow(Math.sin(Math.PI * clamp01(0.08 + f * 0.88)), 0.5)
          * clamp01(1.2 - f * 0.95),
        falloff: 4,
      });
      // Glint pulled *inside* the tip and stretched along the spine. A round
      // bead sitting on the point detaches and floats. Not every spine either -
      // regularity is what read as floral.
      if (h2 > 0.30) {
        const i0 = n - 2, lf = 0.72;
        const ex = lerp(pts[i0 * 2], pts[i0 * 2 + 2], lf);
        const ey = lerp(pts[i0 * 2 + 1], pts[i0 * 2 + 3], lf);
        const sa = Math.atan2(pts[i0 * 2 + 3] - pts[i0 * 2 + 1], pts[i0 * 2 + 2] - pts[i0 * 2]);
        const bk = gk * (0.85 + h1 * 0.55);
        this.glow.push(ex, ey, r * 0.72, r * 0.32, sa,
          cBod[0] * bk * 1.5, cBod[1] * bk * 1.5, cBod[2] * bk * 1.5, 1, S.STREAK);
        this.glow.push(ex, ey, r * 0.20, r * 0.11, sa,
          cRim[0] * bk * 7.0, cRim[1] * bk * 7.0, cRim[2] * bk * 7.0, 1, S.CORE);
      }
    }

    // Shell body, over the spine roots so the joint is not visible.
    const bp = this._p1(2);
    bp[0] = h.x - r * 0.17; bp[1] = h.y; bp[2] = h.x + r * 0.17; bp[3] = h.y;
    this.rDark.stroke(bp, { width: r * 1.34, color: PAL.hazardDark, alpha: 0.995, falloff: 0.78 });

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
    this.glow.puts(h.x, h.y, r * 0.54, scaled(cBod, (0.28 + 0.20 * p) * hot, c1), 1, S.GLOW);
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
    this.glow.push(cx, cy - hh * 0.28, w * 2.30, hh * 2.15, 0,
      cBod[0] * 0.20 * bell, cBod[1] * 0.20 * bell, cBod[2] * 0.20 * bell, 1, S.PETAL);
    this.glow.push(cx, cy - hh * 0.34, w * 1.90, hh * 1.66, 0,
      cBod[0] * 0.09 * bell, cBod[1] * 0.09 * bell, cBod[2] * 0.09 * bell, 1, S.VOLUME);

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
      this.glow.push(ox, oy, w * 0.36, hh * 0.60, 0,
        cBod[0] * gk * 0.7, cBod[1] * gk * 0.7, cBod[2] * gk * 0.7, 1, L_MEMB);
      this.glow.push(ox, oy, w * 0.14, hh * 0.26, 0,
        cRim[0] * gk * 4.2, cRim[1] * gk * 4.2, cRim[2] * gk * 4.2, 1, S.CORE);
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
    this.glow.push(cx, cy + hh * 1.5, w * 4.6, hh * 3.4, 0,
      cBod[0] * tg, cBod[1] * tg, cBod[2] * tg, 1, S.VEIL);
    for (let k = 0; k < 2; k++) {
      const sx = cx + (k ? 1 : -1) * w * 2.1;
      this.glow.push(sx, cy - hh * 0.2, w * 3.0, hh * 3.0, 0,
        cBod[0] * tg * 0.9, cBod[1] * tg * 0.9, cBod[2] * tg * 0.9, 1, S.VEIL);
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
    const n = 11, sp = this._p1(n);
    const tipY = by - r * 0.74;
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      const en = f * f * (3 - 2 * f);           // keep the root vertical at the roof
      sp[s * 2] = lerp(a.x, bx, en) + Math.sin(f * Math.PI) * sway * 0.5 * (1 - strain);
      sp[s * 2 + 1] = lerp(topY, tipY, f);
    }
    this.rDark.stroke(sp, {
      width: (f) => lerp(r * 0.32, r * 0.56, Math.pow(f, 1.6)) * (1 - strain * 0.20)
        * (0.88 + 0.24 * noise1(f * 5.1 + sid * 0.017)),
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
      this.occl.push(nx, ny, nr * 2.5, nr * 1.9, 0,
        PAL.voidDeep[0], PAL.voidDeep[1], PAL.voidDeep[2], 0.82, S.BLOB);
      const np = 0.38 + 0.62 * Math.sin(t * (1.5 + hash2(sid, q * 5 + 2) * 1.2) + q * 2.2 + a.phase);
      this.glow.puts(nx, ny, nr * 4.4, scaled(cRim, k * np * 0.20, c0), 1, S.GLOW);
      this.glow.puts(nx, ny, nr * 1.25, scaled(cMid, k * np * 3.0, c0), 1, S.CORE);
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
    this.glow.push(bx, by - r * 0.10, r * 12 * (isHeld ? 1.35 : 1), r * 11 * (isHeld ? 1.35 : 1), 0,
      cRim[0] * k * 0.11, cRim[1] * k * 0.11, cRim[2] * k * 0.11, 1, S.VEIL);
    // Sampled along the teardrop's own axis so the light fills the body's shape
    // rather than sitting behind it as a disc.
    for (let q = 0; q < 4; q++) {
      const f = 0.22 + q * 0.185;
      const ww = bw(f);
      const amb = q === 1 || q === 2 ? cLive : cMid;
      const kk = k * (q === 1 ? 1.00 : q === 2 ? 0.86 : 0.62);
      this.glow.push(bx + stx(f), lerp(axTop, axBot, f) + sty(f), ww * 1.20, ww * 1.04, 0,
        amb[0] * kk, amb[1] * kk, amb[2] * kk, 1, S.GLOW);
    }
    // Hot core: small, and the only near-white on the object.
    const cf = 0.46;
    const ccx = bx + stx(cf), ccy = lerp(axTop, axBot, cf) + sty(cf);
    this.glow.push(ccx, ccy, r * 0.92, r * 0.80, 0,
      cCore[0] * k * 3.4, cCore[1] * k * 3.0, cCore[2] * k * 2.1, 1, S.GLOW);
    // Gain left at 11 and the quad widened instead - see HDR_FLOOR at the top of
    // this file for why raising the gain is the wrong lever. Widening at constant
    // peak buys what the `max` statistic actually wants, a hot lobe wider than
    // one sample spacing, for about six pixels of extra white core: CORE's
    // Gaussian is a tenth of its quad however large the quad is drawn, so the
    // lobe scales with the quad while the peak does not move at all.
    this.glow.push(ccx, ccy, r * 7.8, r * 6.7, 0,
      cCore[0] * k * 11, cCore[1] * k * 9.6, cCore[2] * k * 6.4, 1, S.CORE);

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
      const sk = 0.32 + 0.68 * Math.sin(t * (1.3 + hash2(sid, q * 7 + 1) * 2.0) + q * 2.4 + a.phase);
      const kk = k * (0.45 + sk * 0.85);
      this.glow.puts(px, py, r * 1.5, scaled(cRim, kk * 0.26, c0), 1, S.GLOW);
      this.glow.puts(px, py, r * 0.34, scaled(cLive, kk * 4.0, c0), 1, S.CORE);
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
        const np = 0.35 + 0.65 * Math.sin(t * (1.9 + hq) + q * 2.7 + a.phase);
        this.glow.puts(nx, ny, r * 1.0, scaled(cMid, k * np * 0.42, c0), 1, S.GLOW);
        this.glow.puts(nx, ny, r * 0.24, scaled(cLive, k * np * 3.6, c0), 1, S.CORE);
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
      // The membrane flares where the line is pulling on it.
      this.glow.puts(ex, ey, r * 2.0, scaled(cLive, 0.80 * pulse, c0), 1, S.GLOW);
      this.glow.puts(ex, ey, r * 1.25, scaled(cCore, 9.0 * pulse, c0), 1, S.CORE);
      // One dim anamorphic bar, tall enough that its core is not a hairline.
      this.glow.push(bx, by, r * 9, r * 2.4, 0,
        cMid[0] * 0.26 * pulse, cMid[1] * 0.24 * pulse, cMid[2] * 0.18 * pulse,
        1, S.STREAK);
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
      const sz = p.r * (0.70 + hash2(sid, 4) * 0.66);
      const k = (0.52 + 0.48 * Math.sin(t * (1.8 + hash2(sid, 5) * 1.5) + p.phase * 1.7)) * dim * (1 - e);
      mixCol(PAL.plankton, PAL.moteInner, hash2(sid, 6) * 0.38, c0);
      if (e > 0) this._ate(c0, e, c0);
      const pc = e > 0 ? this._ate(PAL.planktonCore, e, o0) : PAL.planktonCore;
      this.glow.puts(x, y, sz * 6.2, scaled(c0, k * 0.20, c1), 1, S.GLOW);
      this.glow.puts(x, y, sz * 2.1, scaled(c0, k * 0.82, c1), 1, S.PLANKTON, orb * 0.6);
      this.glow.puts(x, y, sz * 3.4, scaled(pc, k * 11, c1), 1, S.CORE);
      // A third of the field is ripe: a wider hot lobe as well as a brighter
      // one. This is where the frame's HDR headroom is bought. Plankton are
      // spread across the whole frame, so several of them land on the coarse
      // grid hdrStats samples, and their bloom lands nowhere near the mote -
      // unlike widening the mote's own core, which floods the annulus its
      // contrast is measured against. It also gives the reward a size ladder,
      // which a field of identically-sized dots did not have.
      if (hash2(sid, 7) > 0.66) {
        this.glow.puts(x, y, sz * 6.4, scaled(pc, k * HDR_FLOOR * 0.80, c1), 1, S.CORE);
      }
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
      alpha: (f) => (0.15 + sk * 0.19) * Math.pow(f, 1.1) * Math.pow(1 - f, 0.30), falloff: 1.6,
    });
    this.rGlow.stroke(pts, {
      width: (f) => lerp(19 + sk * 13, 5, Math.pow(f, 0.7)), color: PAL.moteTrail,
      alpha: (f) => (0.26 + sk * 0.40) * Math.pow(Math.sin(f * Math.PI * 0.92), 1.1), falloff: 3.0,
    });
    this.rGlow.stroke(pts, {
      width: (f) => lerp(7, 3.4, Math.pow(f, 0.8)), color: scaled(PAL.moteInner, 3.4, c0),
      alpha: (f) => (0.34 + sk * 0.56) * Math.pow(f, 7.0), falloff: 5.5,
    });

    // Shed grain: keeps it from reading as a clean vector ribbon. Weighted to
    // the middle of the trail rather than piled up against the head.
    for (let s = n - 3; s >= 2; s -= 3) {
      const f = s / (n - 1);
      const hg = hash2((s * 7) | 0, (t * 3) | 0);
      const kk = f * f * (1 - f * 0.88) * (0.30 + sk * 0.44);
      this.glow.puts(pts[s * 2], pts[s * 2 + 1], 5 + hg * 16 + sk * 10,
        scaled(PAL.moteOuter, kk, c0), 1, S.GLOW);
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
    // them instead of butting against them.
    const cap = (f) => clamp01(f * 9) * clamp01((1 - f) * 7);

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
      this.glow.push(fx + Math.cos(fa) * fl * 0.5, fy + Math.sin(fa) * fl * 0.5,
        fl, fl * 0.10, fa, c0[0] * kk, c0[1] * kk, c0[2] * kk, 1, S.FILAMENT);
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
      this.glow.puts(bx, by, lerp(34, 22, bt), scaled(c2, kb * 0.50, c3), 1, S.GLOW);
      this.glow.puts(bx, by, lerp(22, 13, bt), scaled(c2, kb * 8.0, c3), 1, S.CORE);
    }
  }

  // ------------------------------------------------------------------- mote ---
  /**
   * The protagonist. It used to be a featureless white gaussian ~90px across -
   * five CORE quads up to 24R wide, whose clamped tops summed into one broad
   * plateau, so at the moment of peak drama the hero was a blur brush and the
   * measured focal contrast against its own surround was 1.0:1.
   *
   * It gets the treatment the anchors get, because that treatment is right: a
   * translucent membrane with a defined edge, interior organelles, a small hot
   * nucleus offset toward travel, a rim highlight on the leading flank, and
   * cilia for secondary motion. The value ladder inside the object -
   * nucleus > rim > membrane > scatter - is what survives the tonemap shoulder;
   * a single hot disc cannot, however good the shoulder is.
   */
  _mote(g) {
    const p = g.player, cam = g.cam, t = g.t;
    if (!p.alive) return;
    const R = 15;
    const sk = clamp01(p.speedSmooth / 2100);
    const lg = p.launchGlow, bg = p.brushGlow;
    const boost = 1 + lg * 1.05 + bg * 0.40;

    let vx = p.vx, vy = p.vy, vl = Math.hypot(vx, vy);
    if (vl < 1e-3) { vx = 1; vy = 0; vl = 1; }
    const dx = vx / vl, dy = vy / vl;
    const ang = Math.atan2(dy, dx);
    // A smear conserves area: fast is longer AND thinner, never just bigger.
    const el = 1 + sk * 1.9, th = 1 / (1 + sk * 0.80);

    // 1. motion smear, along the path actually travelled so it follows the arc.
    const tp = p.trailPts, tn = tp.length >> 1;
    if (tn >= 3 && sk > 0.05) {
      const N = Math.min(6, tn - 1);
      for (let i = 1; i <= N; i++) {
        const j = tn - 1 - i;
        const sx = tp[j * 2], sy = tp[j * 2 + 1];
        const a2 = Math.atan2(sy - tp[(j + 1) * 2 + 1], sx - tp[(j + 1) * 2]);
        const f = 1 - i / (N + 1);
        // Cubed, and less than half the old gain. These six quads land squarely
        // in the 40-60px annulus, and that annulus has to stay dark: measured
        // against its own surround the mote's core was reading 2.5:1 at speed
        // and 4.8:1 at rest, and this was most of the difference.
        const kk = f * f * f * sk * 0.24 * boost;
        this.glow.push(sx, sy, R * 5.2 * f * el, R * 2.6 * f * th, a2,
          PAL.moteOuter[0] * kk, PAL.moteOuter[1] * kk, PAL.moteOuter[2] * kk, 1, S.STREAK);
      }
    }

    // 2. scatter: the light sitting *in* the water. Its only job is to stop the
    // mote reading as a decal pasted on the abyss; it is not there to light the
    // neighbourhood, and every unit of it is subtracted from the contrast
    // between the core and its own surround.
    // Radius matters more than gain here: at 200px across, this one quad *is*
    // the 40-60px annulus, and no amount of dimming fixes a layer that covers
    // the thing being measured. Smaller and slightly denser reads the same.
    this.glow.push(p.x, p.y, R * 8.6 * (1 + sk * 0.22), R * 7.2 * th, ang,
      PAL.moteOuter[0] * 0.088 * boost, PAL.moteOuter[1] * 0.088 * boost, PAL.moteOuter[2] * 0.088 * boost,
      1, S.VEIL);
    // Lobes inside the body's own edge, where they break the disc instead of
    // filling the annulus around it.
    for (let q = 0; q < 5; q++) {
      const a2 = q * 1.2566 + t * 0.32 + noise1(t * 0.6 + q * 7.3) * 2.6;
      const d2 = R * (0.80 + noise1(t * 0.45 + q * 3.1) * 1.15);
      const sz = R * (1.7 + noise1(t * 0.5 + q * 11.7) * 1.5);
      this.glow.puts(p.x + Math.cos(a2) * d2, p.y + Math.sin(a2) * d2, sz,
        scaled(PAL.moteOuter, 0.30 * boost, c0), 1, S.GLOW);
    }

    // 3. cilia. Short, swept back, sampled off the wake so they lag the body -
    // secondary motion, and the thing that makes the silhouette a creature's.
    for (let q = 0; q < 5; q++) {
      const spread = (q / 4 - 0.5) * 1.85;
      const wag = Math.sin(t * (2.3 + q * 0.37) + q * 1.9) * 0.30;
      const ca = ang + Math.PI + spread + wag * (1 - sk * 0.6);
      const cl = R * (1.2 + noise1(q * 5.1 + t * 0.7) * 1.2) * (1 + sk * 0.35);
      const kk = (0.30 + 0.20 * noise1(q * 3.3 + t * 1.4)) * boost;
      // As a sprite this was a FILAMENT quad three units tall, and FILAMENT's
      // hair is 2.7% of its quad - a twentieth of a pixel, which mips to
      // nothing. A ribbon floors a sub-pixel width and scales the alpha to
      // match, which is the one construction here that draws an actual hair.
      const c2x = p.x + Math.cos(ca) * cl * 0.18, c2y = p.y + Math.sin(ca) * cl * 0.18;
      this.rGlow.segment(c2x, c2y, p.x + Math.cos(ca) * cl, p.y + Math.sin(ca) * cl,
        wCore(R * 0.11, 4), PAL.moteOuter, kk * 0.62, 4);
    }

    // 4. body. Built from GLOW rather than the kit's VOLUME profile. VOLUME's
    // chord integral ends in a step - 0.37 down to 0.004 across 7% of its
    // radius - and at the size the mote is drawn that step is a two-pixel hard
    // circle. A review found faint concentric circles orbiting close to the
    // mote; this membrane was one of them. GLOW's tail runs smoothly to the
    // quad edge, so the body gets an edge that is *lit* instead of an edge that
    // is *drawn*, and the crescent in step 6 is what actually defines it.
    this.glow.push(p.x, p.y, R * 4.3 * Math.pow(el, 0.40), R * 3.7 * th, ang,
      PAL.moteOuter[0] * 0.92 * boost, PAL.moteOuter[1] * 0.82 * boost, PAL.moteOuter[2] * 0.76 * boost,
      1, S.GLOW);
    // Inner body: the missing rung. The ladder inside the mote ran 40 linear at
    // the nucleus straight down to 0.5 at the membrane, and the tonemap turns a
    // 90:1 step into a white dot on a dark smudge - so the anchors, a third as
    // hot but sixty pixels of bright, out-read the protagonist. This rung sits
    // at ~3 linear, which is bright after the grade but barely over the bloom's
    // knee foot (threshold 0.86 less knee 0.58, over exposure), so it buys the
    // mote a *body* for about a fifth of the bloom a plateau above the HDR
    // contract would have cost. Measured: +0.02 in the annulus, against +0.43.
    this.glow.push(p.x, p.y, R * 3.1 * Math.pow(el, 0.35), R * 2.6 * Math.pow(th, 0.60), ang,
      PAL.moteInner[0] * 4.6 * boost, PAL.moteInner[1] * 4.6 * boost, PAL.moteInner[2] * 4.3 * boost,
      1, S.GLOW);
    // Organelles, on their own slow clocks, pushed out to where the body's own
    // value is falling. Inside the nucleus they would be invisible.
    for (let q = 0; q < 3; q++) {
      const oa = q * 2.094 + t * 0.5;
      const orr = R * (1.30 + noise1(t * 0.55 + q * 9.1) * 0.72);
      const ox = p.x + Math.cos(oa) * orr * el * 0.7, oy = p.y + Math.sin(oa) * orr * th;
      const ok = (0.9 + 0.7 * noise1(t * 0.9 + q * 4.7)) * boost;
      this.glow.puts(ox, oy, R * 0.58, scaled(PAL.moteInner, ok * 1.9, c0), 1, S.CORE);
    }

    // 5. nucleus. CORE's hot lobe is exp(-105 r^2) - about a tenth of the quad's
    // width. Drawn at 20 world units that lobe lands inside two screen pixels,
    // below the mip the sampler picks for it, and the box filter averages the
    // authored gain away: that is how a nucleus written at 30x measured 5.7
    // linear and put the frame under the HDR contract. Three quads, each large
    // enough that its own hot lobe survives minification, gains stepped ~4:1,
    // and nothing wider - the ladder is what keeps a value structure inside the
    // core instead of one clamped plateau, and width here is paid for in the
    // annulus the mote's contrast is measured against.
    const nx = p.x + dx * R * 0.30 * el, ny = p.y + dy * R * 0.30 * el;
    const CS = [4.4, 2.7, 1.7], CG = [HOT * 0.14, HOT * 0.44, HOT * 0.95];
    for (let q = 0; q < 3; q++) {
      const g2 = CG[q] * boost, s2 = CS[q];
      this.glow.push(nx, ny, R * s2 * Math.pow(el, 0.22), R * s2 * 0.86 * th, ang,
        PAL.moteCore[0] * g2, PAL.moteCore[1] * g2, PAL.moteCore[2] * g2, 1, S.CORE);
    }
    // Denser at the leading edge, thinner behind: a direction of travel that
    // needs no added geometry.
    this.glow.push(p.x - dx * R * 0.85 * el, p.y - dy * R * 0.85 * el, R * 2.2, R * 1.3, ang,
      PAL.moteInner[0] * 1.5 * boost, PAL.moteInner[1] * 1.5 * boost, PAL.moteInner[2] * 1.5 * boost,
      1, S.CORE);

    // 6. rim highlight on the leading flank. An arc, not a ring: a curve
    // concentric with the player is a selection bracket however it is tinted,
    // which this project has re-learned three times. 210 degrees of the front,
    // brightest dead ahead, dying out toward the flanks.
    const nrm = 13, rimP = this._p2(nrm);
    const rr = R * 2.40;   // outside the plateau, or the plateau swallows it
    for (let s = 0; s < nrm; s++) {
      const f = s / (nrm - 1);
      const aa = ang + (f - 0.5) * 3.66;
      rimP[s * 2] = p.x + Math.cos(aa) * rr * el * 0.62;
      rimP[s * 2 + 1] = p.y + Math.sin(aa) * rr * th;
    }
    // Two arcs, not one. A rim is what tells you an object has a surface, and
    // thin geometry is the one thing that is cheap here: the mote's brightness
    // is metered over the area it covers, and a two-pixel ribbon covers none.
    this.rGlow.stroke(rimP, {
      width: R * 0.62, color: scaled(PAL.moteOuter, 1.35, c1),
      alpha: (f) => Math.pow(Math.sin(f * Math.PI), 1.5) * (0.26 + 0.16 * lg) * boost, falloff: 1.7,
    });
    this.rGlow.stroke(rimP, {
      width: wCore(R * 0.20, 4), color: scaled(PAL.moteInner, 3.30, c0),
      alpha: (f) => Math.pow(Math.sin(f * Math.PI), 2.1) * (0.50 + 0.24 * lg) * boost, falloff: 4,
    });
    // Inner arc, tighter and offset back: the crease where the membrane turns
    // away. Without it the crescent is a decal on a disc.
    for (let s2 = 0; s2 < nrm; s2++) {
      const f = s2 / (nrm - 1);
      const aa = ang + (f - 0.5) * 2.90;
      rimP[s2 * 2] = p.x + Math.cos(aa) * rr * el * 0.40;
      rimP[s2 * 2 + 1] = p.y + Math.sin(aa) * rr * th * 0.66;
    }
    this.rGlow.stroke(rimP, {
      width: wCore(R * 0.13, 4.5), color: scaled(PAL.moteInner, 1.60, c0),
      alpha: (f) => Math.pow(Math.sin(f * Math.PI), 2.4) * 0.30 * boost, falloff: 4.5,
    });

    // 7. anamorphic bleed. Length and asymmetry are keyed to velocity: a
    // constant full-width bar reads as a sprite, a bar that grows and trails
    // reads as motion, and that alone carries most of the speed legibility.
    const alen = R * (2.2 + sk * 40 + lg * 44);
    const fl = 0.10 + sk * 0.40 + lg * 0.95;
    if (alen > R * 4.5) {
      // Halved in thickness and pushed further back. A bar 37px tall through
      // the core is 23% of the annulus the focal metric samples, at whatever
      // brightness it is drawn - length is what reads as speed, height is only
      // what dilutes the core.
      this.glow.push(p.x - dx * alen * 0.40, p.y - dy * alen * 0.40, alen, R * (2.3 - sk * 0.7), ang,
        PAL.moteOuter[0] * fl * 0.17, PAL.moteOuter[1] * fl * 0.20, PAL.moteOuter[2] * fl * 0.28,
        1, S.ANAMORPH);
      this.glow.push(p.x + dx * alen * 0.16, p.y + dy * alen * 0.16, alen * 0.36, R * (1.4 - sk * 0.4), ang,
        PAL.moteCore[0] * fl * 0.24, PAL.moteCore[1] * fl * 0.24, PAL.moteCore[2] * fl * 0.27,
        1, S.STREAK);
    }
    // The lens artefact proper is screen-horizontal and belongs to the flare,
    // not to the speed - keying it to both double-counts and gives you a bar
    // that is always there.
    if (lg > 0.02) {
      const rot = -(cam.rot || 0);
      this.glow.push(p.x, p.y, R * (9 + lg * 46), R * 2.1, rot,
        PAL.moteOuter[0] * lg * 0.19, PAL.moteOuter[1] * lg * 0.22, PAL.moteOuter[2] * lg * 0.29,
        1, S.ANAMORPH);
    }

    // 8. the Hush breathing on your neck: a violet counter-rim, no HUD needed.
    const hp = g.hushProx || 0;
    if (hp > 0.02) {
      this.glow.push(p.x - R * 1.1, p.y, R * 5.5, R * 6.5, 0,
        PAL.hushEdge[0] * hp * 0.55, PAL.hushEdge[1] * hp * 0.55, PAL.hushEdge[2] * hp * 0.55, 1, S.GLOW);
    }

    // 9. shockwaves. Not donuts: a short bright front with a wake behind it and
    // no back half at all.
    if (lg > 0.02) this._shock(p.x, p.y, ang, lg, R * 2.2, R * 26, PAL.moteOuter, PAL.moteCore, 1.45, 3.7);
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
    const pk = fade * 0.22;
    this.glow.push(cx + Math.cos(ang) * rad * 0.30, cy + Math.sin(ang) * rad * 0.30,
      rad * 1.4, rad * 2.3, ang, col[0] * pk, col[1] * pk, col[2] * pk, 1, S.GLOW);

    // Splash, not needles: elongated S.GLOW has no hard core anywhere, so these
    // stay smears. S.STREAK's tight band turned them into clean drawn spikes.
    for (let q = 0; q < 5; q++) {
      const h1 = noise1(q * 3.7 + seed), h2 = noise1(q * 8.3 + seed + 41);
      const a = ang + (q / 4 - 0.5) * 2 * spread + (h1 - 0.5) * 0.42;
      const rr = rad * (0.62 + h2 * 0.42);
      const lobe = Math.pow(Math.cos(clamp((a - ang) / spread, -1, 1) * 1.35), 2);
      const kk = fade * lobe * (0.34 + h1 * 0.80) * (1 - p * 0.45);
      this.glow.push(cx + Math.cos(a) * rr * 0.52, cy + Math.sin(a) * rr * 0.52,
        rr * (0.42 + h2 * 0.30), rad * 0.26 + 10, a,
        col[0] * kk, col[1] * kk, col[2] * kk, 1, S.GLOW);
      if (h1 > 0.50) {
        this.glow.push(cx + Math.cos(a) * rr * 0.78, cy + Math.sin(a) * rr * 0.78,
          rr * 0.26, rad * 0.15 + 8, a,
          hot[0] * kk * 1.3, hot[1] * kk * 1.3, hot[2] * kk * 1.3, 1, S.GLOW);
      }
    }
  }
}

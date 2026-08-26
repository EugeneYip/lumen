// HUD: typography, instrumentation and the title sequence, on a 2D overlay
// canvas. The WebGL layer underneath keeps its own resolution independent of it.
//
// Two constraints shape everything in this file.
//
// 1. In headless capture `draw()` runs ONCE after thousands of `step()` calls,
//    so anything integrated per-draw reads as ~0 in every captured frame. Every
//    value that must be *correct* therefore comes from the frameCtx, which the
//    sim advances (`t`, `deadT`, `player.*`). Local integrators are used only
//    for impulses, and are snapped when the gap is bigger than one frame of
//    real motion could explain.
// 2. The same rule kills a conventional rising entrance: a player never sees it
//    either, because the boot splash is pulled at ~0.7s. So the resting
//    composition is what t=0 draws, and every entrance effect is an *additive*
//    rise-then-fall envelope layered on top of it - the light arrives, swells,
//    and settles.
//
// Letterforms are drawn as stroked centrelines rather than set in a system
// font: monoline geometric caps and figures, lit from above like everything
// else in the trench. Identical on every machine, and fixed-advance by
// construction, so a changing readout cannot jitter.
import { clamp, clamp01, lerp, smoothstep, easeOutCubic, easeOutQuint, easeOutBack, damp, TAU, PI } from '../engine/math.js';

const FONT = `-apple-system, "SF Pro Display", "Helvetica Neue", Inter, "Segoe UI", system-ui, sans-serif`;

/**
 * The white ceiling, and why the interface is not allowed to be the brightest
 * thing on screen.
 *
 * The hero is the mote. It is the only cold emitter in a warm-anchored frame
 * and the grade work that made it so put it at the top of the value ladder on
 * purpose; an interface sitting above it undoes that at the one place it
 * matters. Measured on the twelve gate frames (seeds 7 and 3 x the six gated
 * scenes) on the DELIVERED pixels — the GL canvas with this canvas composited
 * over it — before any of this existed:
 *
 *   mote   max channel 248-254   luma 0.944-0.978   (and the mote is the GL
 *                                                    layer's peak pixel in all
 *                                                    twelve, so "scene peak"
 *                                                    and "hero peak" coincide)
 *   HUD    max channel 255       luma 1.000         in all twelve, 678-20217
 *                                                    pixels per frame
 *
 * So the HUD out-valued the protagonist in every frame of the round, and the
 * only pixels clipping to 255 anywhere in the image were these. Two independent
 * reports landed on it the same day: a blind reviewer, and a peak-brightness
 * probe that read the score numerals and nearly filed a clipping bug against
 * the scene.
 *
 * NOTE, because it matters for anyone re-deriving this: `check.mjs` cannot see
 * any of it. The gate samples `document.getElementById('gl')` only, so its
 * `clipped 0.00%` was never a statement about the delivered image, and no
 * number this file moves appears in the gate at all. Measure the composite.
 *
 * 0.85 is measured against that floor rather than adopted from the review: the
 * dimmest the mote ever gets in a gate frame is 0.944, so the ceiling sits
 * 0.094 luma — about 24 code values at the top end — below the worst case.
 * Legibility is not the constraint it looks like. A neutral at 0.85 is sRGB
 * 219, and the readouts sit on their own scrims at sRGB 25-40, which is over
 * 11:1 — WCAG AAA is 7:1.
 *
 * The cap is applied AT THE SOURCES, not as a pass over the finished canvas,
 * for two reasons. It is free, where a full-canvas pass is not; and Canvas2D
 * has no min-blend that leaves transparent pixels alone — `darken` composites
 * with source-over alpha semantics, so it would paint the ceiling colour over
 * the whole frame. What makes source capping sufficient is that the overlay
 * composites source-over: a composited pixel is a lerp between this canvas and
 * the scene and can never exceed the brighter of the two. Hold every pixel on
 * THIS canvas under the ceiling and the frame's peak is necessarily the scene's
 * peak, which is the mote.
 *
 * Measured after, same twelve frames: HUD ink peaks at 0.834-0.845 luma / max
 * channel 218-226, the composite's brightest pixel is the mote's own pixel in
 * all twelve, and the count of pixels at 255 anywhere in the image went from
 * 678-20217 to zero. Two frames still carry one 255 pixel each and both are in
 * the GL layer, not here. Worst-case headroom is 0.099 luma, on seed 3 hushNear
 * where the mote is dimmest; typical is 0.12. The HUD's own peak has also moved
 * off the type: in ten of the twelve it is now the speed rail's handle, a 3px
 * mark, rather than a block of numerals.
 *
 * Two states are deliberately exempt and should stay that way. `_paused` and
 * `_death` both dim the whole frame under a scrim, which puts the mote below
 * the readouts by construction — in a modal state the interface IS the subject.
 * The ceiling still holds in both; nothing clips. It is only the ordering that
 * inverts, and that is the right ordering there.
 */
const CEIL = 0.85;
/**
 * Body ink under an additive core. The core is what actually clipped: a body at
 * 232 plus `lighter` white at alpha 0.36 is 324, and 324 clamps to 255 — which
 * is also why the old core was invisible as shape. Splitting the ceiling into
 * a body level and a reserved additive headroom means body + core lands ON the
 * ceiling instead of through it, and the core reads as a lift for the first
 * time (183 -> 219 is a visible 20%; 232 -> 255 was 10% and clipped).
 */
const BODY = 0.72;
const CORE_K = (CEIL - BODY) / 0.36;   // largest call site asks 0.36; keep the relative weighting

const LUMA = (c) => (c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722) / 255;
/** Scale an sRGB triple down to at most `l` luma. Hue and saturation ratio survive. */
const capL = (c, l) => { const y = LUMA(c); return y <= l ? c : c.map((v) => Math.round(v * l / y)); };
/**
 * A colour about to be used as body ink under an additive core. Accent colours
 * are allowed all the way to CEIL as graphic marks — a tier diamond, a bracket,
 * the speed handle — but the same accent inside a letterform has a core coming
 * on top of it and has to leave the headroom. Missing this is what kept the
 * score numerals at 0.884 after the first pass: `acc` is the gradient's MIDDLE
 * stop, so mid-glyph was CEIL plus the core rather than CEIL.
 */
const asBody = (c) => capL(c, BODY);

// --- sRGB UI palette. Three accents with one job each, plus the alarm. -------
// Every constant that could reach the ceiling is passed through `capL`, with
// its authored value left in view so the intent is still readable. The dim end
// of the palette is untouched — capping the ceiling must not flatten the ramp
// underneath it, which is how you lose the labels.
const PEAK     = capL([234, 247, 255], CEIL);   // hottest ink allowed: cores, the speed handle
const INK      = capL([234, 247, 255], BODY);   // primary readout body
const ICE      = capL([182, 232, 252], CEIL);
const CYAN     = [104, 206, 244];               // 0.733 — under the ceiling already
const STEEL    = [ 58, 138, 176];
const DIM      = [134, 166, 184];   // secondary labels
const FAINT    = [ 74, 104, 120];   // structure, rules, off states
const WARM     = [255, 188,  98];   // records only — 0.768, under
const WARM_HI  = capL([255, 236, 198], CEIL);
const MINT     = capL([128, 252, 194], CEIL);   // the chain
const MINT_HI  = capL([228, 255, 242], BODY);   // only ever a body top, under a core
const VIO      = [162, 108, 255];   // the Hush
const VIO_HI   = capL([238, 224, 255], BODY);   // ditto: the Hush figure's body top
const NIGHT    = [  2,   7,  12];   // scrims and contact shadows

/**
 * The bottom band the play HUD owns, in design units (multiply by `k`).
 * Everything the rail draws lives inside it and the scrim covers all of it.
 * Exported because only half of a safe area can live here: props are placed in
 * `world.js`, which cannot see this file, so this is the number to enforce
 * against. See `hudSafeBottom`.
 */
const SAFE = 118;

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a < 0 ? 0 : a > 1 ? 1 : a})`;

/** The UI scale the HUD lays out on. One definition, so callers agree with it. */
export const hudScale = (W, H) => clamp(Math.min(W / 1440, H / 810), 0.62, 1.34);

/**
 * Height in CSS pixels of the bottom safe area, measured up from the frame
 * edge. A blind review found foreground corals growing through the words SPEED
 * and M/S; the scrim added here fixes the contrast half of that, but a prop
 * that occupies the band is still a prop in the way of the readout. Nothing in
 * `hud.js` can move a prop, so this export exists for whoever does.
 *
 * 131px at 1600x900, 14.6% of the frame. Measured on the scene layer inside it,
 * all twelve gate frames: peak luma 0.336-0.838, so there is bright geometry in
 * the band in EVERY one of them, and behind the word SPEED specifically it runs
 * to mean 0.628 / peak 0.759 (seed 7 `launch`, a coral colony). The scrim and
 * the local plates below make that legible; they cannot make it uncluttered.
 */
export const hudSafeBottom = (W, H) => Math.round(SAFE * hudScale(W, H));

// --- glyph library ----------------------------------------------------------
// Centrelines on a 100-unit cap height, inset by half the stroke weight so a
// stroked glyph exactly fills its 62-unit box. `a` is the fixed advance used
// for figures. Commands: M/L line, Q quadratic, A arc continuing the current
// subpath, B arc *beginning* one, O ellipse (always its own subpath).
const G = {
  '0': { b: 62, a: 84, p: [['O', 31, 50, 23, 42]] },
  '1': { b: 62, a: 84, p: [['M', 8, 28], ['L', 31, 8], ['L', 31, 92]] },
  '2': { b: 62, a: 84, p: [['B', 31, 30, 22, PI, PI * 2], ['L', 9, 92], ['L', 53, 92]] },
  '3': { b: 62, a: 84, p: [['B', 31, 30, 22, PI * 1.13, PI * 2.5], ['A', 31, 70, 22, PI * 1.5, PI * 2.87]] },
  '4': { b: 62, a: 84, p: [['M', 43, 8], ['L', 8, 65], ['L', 54, 65], ['M', 43, 8], ['L', 43, 92]] },
  '5': { b: 62, a: 84, p: [['M', 53, 8], ['L', 12, 8], ['L', 12, 43], ['L', 30, 43], ['A', 31, 67, 24, -PI * 0.5, PI * 0.8]] },
  '6': { b: 62, a: 84, p: [['O', 31, 66, 23, 25], ['M', 8, 62], ['Q', 9, 13, 51, 12]] },
  '7': { b: 62, a: 84, p: [['M', 9, 8], ['L', 53, 8], ['L', 21, 92]] },
  '8': { b: 62, a: 84, p: [['O', 31, 28, 20, 20], ['O', 31, 69, 23, 23]] },
  '9': { b: 62, a: 84, p: [['O', 31, 34, 23, 25], ['M', 54, 38], ['Q', 53, 87, 11, 88]] },
  '.': { b: 20, a: 42, p: [['O', 10, 84, 0.4, 0.4]] },
  '-': { b: 44, a: 62, p: [['M', 6, 52], ['L', 38, 52]] },
  ':': { b: 20, a: 40, p: [['O', 10, 34, 0.4, 0.4], ['O', 10, 76, 0.4, 0.4]] },
  'x': { b: 56, a: 70, p: [['M', 9, 41], ['L', 47, 92], ['M', 47, 41], ['L', 9, 92]] },
  '/': { b: 46, a: 58, p: [['M', 38, 8], ['L', 8, 92]] },
  // Only ever used as the digit-group gap (see `group`). A figure's advance is
  // 84 over a 62 box, so consecutive digits already sit 22 apart; at the old
  // advance of 44 the group gap came to 66, three times that, and a five-figure
  // score read as two numbers side by side. 24 puts it at 46 - twice the normal
  // gap, which groups without separating.
  ' ': { b: 10, a: 24, p: [] },
  // wordmark + unit caps
  'L': { b: 64, a: 82, p: [['M', 8, 8], ['L', 8, 92], ['L', 56, 92]] },
  'U': { b: 70, a: 88, p: [['M', 8, 8], ['L', 8, 64], ['A', 35, 64, 27, PI, 0, true], ['L', 62, 8]] },
  'M': { b: 82, a: 102, p: [['M', 8, 92], ['L', 8, 8], ['L', 41, 58], ['L', 74, 8], ['L', 74, 92]] },
  'E': { b: 62, a: 82, p: [['M', 54, 8], ['L', 8, 8], ['L', 8, 92], ['L', 54, 92], ['M', 8, 50], ['L', 43, 50]] },
  'N': { b: 68, a: 86, p: [['M', 8, 92], ['L', 8, 8], ['L', 60, 92], ['L', 60, 8]] },
  'S': { b: 62, a: 84, p: [['B', 31, 29, 21, PI * 1.92, PI * 0.94, true], ['A', 31, 70, 22, PI * 1.94, PI * 0.92]] },
};
// Optical spacing for the wordmark: L and E leave open flanks and U's bowl
// recedes, so uniform tracking would read as holes at LU and EN.
const KERN = { LU: -8, UM: -3, ME: 0, EN: -4 };

/** Deterministic 0..1 hash - the Hush edge needs variance, not randomness. */
const hash = (i) => { const x = Math.sin(i * 12.9898 + 1.7) * 43758.5453; return x - Math.floor(x); };

/**
 * 12512 -> '12 512'. The score reaches five and six figures where the distance
 * it replaced reached four, and an ungrouped six-figure run has to be counted
 * rather than read. The gap is a vector space glyph, tuned in `G` to twice the
 * normal inter-figure gap. No locale separator: `toLocaleString` would put a
 * comma on one machine and a point on another, and captures must not differ
 * between machines.
 */
const group = (n) => {
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ' ';
    out += s[i];
  }
  return out;
};

export class Hud {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 1; this.h = 1; this.dpr = 1;

    this.deathT = 0;          // main.js zeroes this on newRun(); kept for that
    this.digits = '';
    // Long enough for a grouped eight-figure score ('12 345 678'); the score is
    // unbounded where the distance it replaced was four figures in practice.
    this.dfx = new Array(12).fill(0);
    this.liftBuf = new Array(12).fill(0);
    this.mile = 0;            // 100 m threshold tick
    this.mileN = -1;
    this.recordPop = 0;
    this.wasRecord = false;
    this.chainStep = -1;
    this.stepPop = 0;
  }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.c.width = Math.round(w * dpr);
    this.c.height = Math.round(h * dpr);
    this.c.style.width = w + 'px';
    this.c.style.height = h + 'px';
  }

  // ============================================================ primitives ===
  _font(size, weight = 500, track = 0) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px ${FONT}`;
    try { ctx.letterSpacing = `${track}px`; } catch { /* older engines */ }
  }

  /**
   * Micro-label in the system stack. Tracking is applied after the final glyph
   * too, so centred and right-aligned runs have to take it back off. Returns
   * the ink width.
   */
  _label(txt, x, y, size, weight, track, col, a = 1, align = 'left') {
    const ctx = this.ctx;
    this._font(size, weight, track);
    const w = ctx.measureText(txt).width - track;
    ctx.textAlign = align;
    ctx.fillStyle = rgba(col, a);
    ctx.fillText(txt, align === 'center' ? x + track / 2 : align === 'right' ? x + track : x, y);
    try { ctx.letterSpacing = '0px'; } catch { /* ignore */ }
    ctx.textAlign = 'left';
    return w;
  }

  /**
   * A centred line assembled from runs that each carry their own tracking.
   *
   * Micro-cap tracking is what makes a word read as an instrument label, and it
   * is exactly wrong on figures: at 5.0k tracking on a 9.5k face the gap
   * between two digits is more than half a glyph, so the number stops being a
   * number. A blind review read the score's `21 M` sub-label as "2 1  M" —
   * three tokens where there are two. Words keep the tracking; figures get
   * almost none. Each run's own tracking is taken back off its width because
   * `letterSpacing` applies after the final glyph too.
   */
  _runs(parts, cx, y, size, weight, col, a) {
    const ctx = this.ctx;
    ctx.textAlign = 'left';
    let total = 0;
    for (const p of parts) {
      this._font(size, weight, p.t);
      p.w = ctx.measureText(p.s).width - p.t;
      total += p.w;
    }
    let x = cx - total / 2;
    for (const p of parts) {
      this._font(size, weight, p.t);
      ctx.fillStyle = rgba(p.c || col, p.a == null ? a : p.a);
      ctx.fillText(p.s, x, y);
      x += p.w;
    }
    try { ctx.letterSpacing = '0px'; } catch { /* older engines */ }
    return total;
  }

  /** Fixed-advance system-font digits, for the few strings the vector set lacks. */
  _tabular(str, x, y, pitch, align = 'left') {
    const ctx = this.ctx;
    const total = str.length * pitch;
    let cx = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
    const prev = ctx.textAlign;
    ctx.textAlign = 'center';
    for (const ch of str) { ctx.fillText(ch, cx + pitch / 2, y); cx += pitch; }
    ctx.textAlign = prev;
    return total;
  }

  /**
   * Append one glyph's subpaths. Arcs and ellipses must open their own subpath
   * or canvas joins them to wherever the pen was left - which draws a diagonal
   * across the previous letter.
   */
  _sub(cmds, ox, oy, sc) {
    const ctx = this.ctx;
    for (let i = 0; i < cmds.length; i++) {
      const c = cmds[i];
      switch (c[0]) {
        case 'M': ctx.moveTo(ox + c[1] * sc, oy + c[2] * sc); break;
        case 'L': ctx.lineTo(ox + c[1] * sc, oy + c[2] * sc); break;
        case 'Q': ctx.quadraticCurveTo(ox + c[1] * sc, oy + c[2] * sc, ox + c[3] * sc, oy + c[4] * sc); break;
        case 'A': ctx.arc(ox + c[1] * sc, oy + c[2] * sc, c[3] * sc, c[4], c[5], !!c[6]); break;
        case 'B':
          ctx.moveTo(ox + (c[1] + Math.cos(c[4]) * c[3]) * sc, oy + (c[2] + Math.sin(c[4]) * c[3]) * sc);
          ctx.arc(ox + c[1] * sc, oy + c[2] * sc, c[3] * sc, c[4], c[5], !!c[6]);
          break;
        case 'O':
          ctx.moveTo(ox + (c[1] + c[3]) * sc, oy + c[2] * sc);
          ctx.ellipse(ox + c[1] * sc, oy + c[2] * sc, c[3] * sc, c[4] * sc, 0, 0, TAU);
          break;
      }
    }
  }

  _adv(g, track) { return track == null ? g.a : g.b + track; }

  _measure(str, cap, track = null, kern = null) {
    const sc = cap / 100;
    let u = 0, last = null;
    for (let i = 0; i < str.length; i++) {
      const g = G[str[i]]; if (!g) continue;
      u += this._adv(g, track);
      if (kern && i < str.length - 1) u += kern[str[i] + str[i + 1]] || 0;
      last = g;
    }
    if (last) u -= this._adv(last, track) - last.b;   // trim the trailing gap
    return u * sc;
  }

  /**
   * A run of vector glyphs. Passes back to front: soft contact shadow (seats
   * the type over a bright scene), additive halo, body, and a top-weighted hot
   * core - light falls from the roof here, so it falls on the type too.
   */
  _vtext(str, x, y, cap, o = {}) {
    const ctx = this.ctx;
    const sc = cap / 100;
    const wt = (o.weight == null ? 0.155 : o.weight) * cap;
    const track = o.track == null ? null : o.track;
    const kern = o.kern || null;
    const total = this._measure(str, cap, track, kern);
    const align = o.align || 'left';
    const ox = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
    const oy = y - 100 * sc;
    const a = o.alpha == null ? 1 : o.alpha;
    if (a <= 0.004) return total;

    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 2.0;

    // One path for the whole run keeps the stroke count flat.
    const build = (dy) => {
      ctx.beginPath();
      let cx = ox;
      for (let i = 0; i < str.length; i++) {
        const g = G[str[i]];
        if (!g) continue;
        const lift = o.dfx ? (o.dfx[i] || 0) : 0;
        if (g.p.length) this._sub(g.p, cx, oy + dy + lift, sc);
        cx += this._adv(g, track) * sc;
        if (kern && i < str.length - 1) cx += (kern[str[i] + str[i + 1]] || 0) * sc;
      }
    };

    if (o.shadow) {
      // butt caps: a round cap on a stroke this wide overhangs every terminal
      // and leaves a dark ghost hovering above the letterforms
      ctx.lineJoin = 'round';
      build(wt * 0.30);
      ctx.lineWidth = wt * 1.75;
      ctx.strokeStyle = rgba(NIGHT, o.shadow * 0.22 * a);
      ctx.stroke();
      ctx.lineJoin = 'miter';
      build(wt * 0.24);
      ctx.lineWidth = wt * 1.12;
      ctx.strokeStyle = rgba(NIGHT, o.shadow * a);
      ctx.stroke();
    }
    if (o.glow) {
      // A stack of wide strokes reads as concentric hard-edged rings against
      // near-black, so the soft falloff is a real blur and only the tight rim
      // is stroked. Butt caps throughout: a round cap this wide arches above
      // every terminal and looks like a second, ghostly wordmark.
      const col = o.glowCol || CYAN;
      const gl = clamp01(o.glow) * a;
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineJoin = 'round';
      build(0);
      ctx.lineWidth = wt * 0.85;
      ctx.shadowColor = rgba(col, clamp01(0.62 * o.glow) * a);
      ctx.shadowBlur = (o.glowR == null ? 0.52 : o.glowR) * cap;
      ctx.strokeStyle = rgba(col, 0.05 * gl);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'rgba(0,0,0,0)';
      for (const [m, ga] of (o.glowRamp || [[1.62, 0.055], [1.26, 0.09]])) {
        build(0);
        ctx.lineWidth = wt * m;
        ctx.strokeStyle = rgba(col, ga * gl);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineJoin = 'miter';
    }
    build(0);
    ctx.lineWidth = wt;
    ctx.globalAlpha = a;
    ctx.strokeStyle = o.body || rgba(INK, 1);
    ctx.stroke();
    if (o.core) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = wt * 0.46;
      ctx.strokeStyle = o.core;
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
    return total;
  }

  /** Vertical gradient down a cap height: light falls from the roof. */
  _grad(y, cap, top, mid, bot) {
    const g = this.ctx.createLinearGradient(0, y - cap, 0, y);
    g.addColorStop(0, top); g.addColorStop(0.50, mid); g.addColorStop(1, bot);
    return g;
  }

  /**
   * Top-weighted highlight, drawn additively inside the stroke — light falls
   * from the roof here, so it falls on the type too.
   *
   * The requested alpha is scaled by `CORE_K` so that the largest call site
   * (0.36) adds exactly the headroom reserved between `BODY` and `CEIL`, and
   * every other call site keeps its weighting relative to it. Unscaled, this
   * was the single source of every clipped pixel in the delivered frame: 255 x
   * 0.36 on top of a body already at 232.
   */
  _core(y, cap, a) {
    // Clamped to the reference weight as well as scaled by it, so the ceiling
    // is a property of this primitive and not of every call site remembering:
    // the chain figure asked for 0.30 + 0.22 * hot, which reaches 0.52 at x24
    // and would have put one readout back through the ceiling at exactly the
    // moment a player is looking at it.
    const w = Math.min(a, 0.36) * CORE_K;
    const g = this.ctx.createLinearGradient(0, y - cap, 0, y);
    g.addColorStop(0, `rgba(255,255,255,${w})`);
    g.addColorStop(0.42, `rgba(255,255,255,${w * 0.42})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    return g;
  }

  /** Soft elliptical scrim. Invisible as a shape; guarantees text contrast. */
  _plate(cx, cy, rx, ry, a) {
    if (a <= 0.002) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(cx, cy); ctx.scale(rx, ry);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, rgba(NIGHT, a));
    g.addColorStop(0.46, rgba(NIGHT, a * 0.74));
    g.addColorStop(0.76, rgba(NIGHT, a * 0.28));
    g.addColorStop(1, rgba(NIGHT, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
    ctx.restore();
  }

  /** Hairline that fades out at both ends - the structural motif. */
  _rule(x0, x1, y, h, col, a, feather = 1) {
    if (a <= 0.002) return;
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, rgba(col, 0));
    g.addColorStop(clamp(0.24 * feather, 0.02, 0.49), rgba(col, a));
    g.addColorStop(clamp(1 - 0.24 * feather, 0.51, 0.98), rgba(col, a));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x0, y, x1 - x0, h);
  }

  /** Anamorphic streak - the same lens language the mote and anchors use. */
  _streak(cx, cy, halfW, halfH, col, a) {
    if (a <= 0.002) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(cx, cy); ctx.scale(halfW, halfH);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, rgba(col, a));
    g.addColorStop(0.28, rgba(col, a * 0.32));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
    ctx.restore();
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** The one-button affordance, used on the title and the death card. */
  _pill(cx, cy, w, h, breathe, label, size, k) {
    const ctx = this.ctx;
    this._plate(cx, cy, w * 1.6, h * 2.0, 0.36);
    this._roundRect(cx - w / 2, cy - h / 2, w, h, h * 0.5);
    ctx.fillStyle = rgba(NIGHT, 0.38);
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.5 * k);
    ctx.strokeStyle = rgba(ICE, 0.30 + 0.44 * breathe);
    ctx.stroke();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = Math.max(2, 6 * k);
    ctx.strokeStyle = rgba(CYAN, 0.045 + 0.085 * breathe);
    ctx.stroke();
    ctx.restore();
    this._label(label, cx, cy + size * 0.35, size, 700, size * 0.36, INK, 0.82 + 0.18 * breathe, 'center');
  }

  // ================================================================= frame ===
  /** @param s frameCtx from main.js (see Game.frameCtx) */
  draw(s, dt) {
    const ctx = this.ctx;
    const W = this.w, H = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    const k = hudScale(W, H);
    const d = Math.min(dt, 1 / 20);

    if (s.mode === 'title') { this._title(s, W, H, k); return; }

    this._impulses(s, d);

    const dead = s.mode === 'dead';
    const fade = dead ? 1 - easeOutCubic(clamp01(s.deadT / 0.28)) : 1;
    // The alarm goes underneath: it eats the frame, never the readouts.
    this._hush(s, W, H, k);
    if (fade > 0.004) {
      ctx.save();
      ctx.globalAlpha = fade;
      this._floor(W, H, k);
      this._strip(s, W, H, k);
      this._score(s, W, H, k);
      this._chain(s, W, H, k);
      this._rail(s, W, H, k);
      ctx.restore();
    }
    if (dead) this._death(s, W, H, k);
    if (s.mode === 'paused') this._paused(s, W, H, k);
  }

  /**
   * Local impulse state. Each one is snapped when the frame-to-frame gap is
   * larger than real motion could produce, which is what a single-draw capture
   * (or a fresh run) looks like.
   */
  _impulses(s, dt) {
    // The headline is the banked score, and with a chain live it climbs by
    // roughly speed x mult: measured at ~1350/s on seed 11 under the autopilot.
    // So the last three digits change faster than a frame, and lifting every
    // changed digit - which is what this did when the headline was metres -
    // would be a permanent shimmer along the tail instead of an event. Each
    // digit is gated on its OWN change rate (place value against the score's
    // rate of climb), so only digits slow enough to be read get the impulse.
    const shown = Math.max(0, Math.floor(s.score || 0));
    const str = group(shown);
    const rate = Math.max(0, (s.speed || 0) * 0.1 * (s.mult || 1));
    if (str !== this.digits) {
      const same = str.length === this.digits.length && this.digits.length > 0;
      if (!same) { for (let i = 0; i < this.dfx.length; i++) this.dfx[i] = 0; }
      else {
        let place = 1;
        for (let i = str.length - 1; i >= 0; i--) {
          if (str[i] === ' ') continue;
          if (str[i] !== this.digits[i] && rate / place < 6) this.dfx[i] = 1;
          place *= 10;
        }
      }
      this.digits = str;
    }
    for (let i = 0; i < this.dfx.length; i++) this.dfx[i] = damp(this.dfx[i], 0, 11, dt);

    // Milestones stay on true distance travelled. A 100-unit tick on the score
    // would fire several times a second at any live multiplier; 100 m of trench
    // is still an event whatever the chain is doing.
    const mn = Math.floor(Math.max(0, s.depth) / 100);
    if (mn !== this.mileN) { if (this.mileN >= 0 && mn > this.mileN) this.mile = 1; this.mileN = mn; }
    this.mile = damp(this.mile, 0, 3.4, dt);

    const rec = s.best > 0 && (s.score || 0) > s.best + 0.001;
    if (rec && !this.wasRecord) this.recordPop = 1;
    this.wasRecord = rec;
    this.recordPop = damp(this.recordPop, 0, 1.6, dt);

    const step = Math.round((s.mult - 1) * 2);
    if (step !== this.chainStep) { if (step > this.chainStep && this.chainStep >= 0) this.stepPop = 1; this.chainStep = step; }
    this.stepPop = damp(this.stepPop, 0, 3.2, dt);
  }

  // ================================================================= title ===
  _title(s, W, H, k) {
    const ctx = this.ctx;
    const t = s.t || 0;
    // Rise-then-fall envelope: ~0 at t=0 (so the capture is the resting
    // composition), peaking where a player first sees the frame.
    const u = t / 1.15;
    const swell = u <= 0 ? 0 : u * u * Math.exp(2 - 2 * u);
    const sweep = clamp01((t - 0.30) / 1.5);
    const sweepA = t < 0.30 ? 0 : Math.sin(sweep * PI);

    const unit = this._measure('LUMEN', 100, 30, KERN) / 100;
    // On a portrait frame the same fractions of H leave the composition
    // stretched apart, so the wordmark grows and the block closes up.
    const tall = clamp01((H / W - 0.66) / 0.7);
    const mw = clamp(W * lerp(0.455, 0.615, tall), 240, 900);
    const cap = mw / unit;
    const cx = Math.round(W * 0.5);
    const base = Math.round(H * lerp(0.305, 0.375, tall) + cap * 0.5);
    const mid = base - cap * 0.5;
    const hair = Math.max(1, 1 / this.dpr);
    const ruleY = Math.round(base + cap * 0.30);

    // corner vignette: focuses the centre and seats the type
    const vg = ctx.createRadialGradient(cx, H * 0.46, Math.min(W, H) * 0.20, cx, H * 0.46, Math.hypot(W, H) * 0.60);
    vg.addColorStop(0, rgba(NIGHT, 0));
    vg.addColorStop(0.6, rgba(NIGHT, 0.16));
    vg.addColorStop(1, rgba(NIGHT, 0.46));
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    // --- structure: rules reaching for the frame edges ---
    const struct = 0.9 + 0.5 * swell;
    this._rule(cx - W * 0.47, cx + W * 0.47, ruleY, hair, STEEL, 0.26 * struct, 1.6);
    this._rule(cx - mw * 0.60, cx + mw * 0.60, Math.round(mid - cap * 0.62), hair, STEEL, 0.16 * struct, 1.6);
    ctx.fillStyle = rgba(STEEL, 0.34 * struct);
    for (let i = -6; i <= 6; i++) {
      if (i === 0) continue;
      const tx = Math.round(cx + i * mw * 0.112);
      ctx.fillRect(tx, ruleY, hair, (i % 3 === 0 ? 8 : 4.5) * k);
    }

    // --- the wordmark ---
    this._streak(cx, mid + cap * 0.04, mw * 0.96, cap * 0.40, CYAN, 0.20 + 0.26 * swell);

    // Authored values, run through the ceiling. The top two stops were 0.999
    // and 0.951 luma, and the wordmark was 20217 pixels of pure 255 — by a wide
    // margin the largest clipped region in any frame of the round. The mote is
    // on screen and drifting at 0.968 on the title too, so the same rule holds
    // here: the light is the subject, not the lettering that names it.
    const wg = ctx.createLinearGradient(0, base - cap, 0, base);
    wg.addColorStop(0, rgba(capL([253, 255, 255], BODY), 0.99));
    wg.addColorStop(0.20, rgba(capL([219, 248, 255], BODY), 0.99));
    wg.addColorStop(0.62, rgba(capL([122, 208, 242], BODY), 0.98));
    wg.addColorStop(1, 'rgba(34,120,164,0.97)');
    const wopt = { align: 'center', track: 30, kern: KERN, weight: 0.142 };
    this._vtext('LUMEN', cx, base, cap, {
      ...wopt,
      body: wg, core: this._core(base, cap, 0.30),
      shadow: 0.30, glow: 0.95 + 1.5 * swell, glowCol: CYAN,
      glowR: 0.62, glowRamp: [[1.9, 0.05], [1.32, 0.085]],
    });
    // caustics: light through moving water, always alive on the letterforms.
    // Source-over toward the ceiling colour rather than `lighter`: additive on
    // top of a body that is already near the ceiling has no headroom by
    // construction, and a lerp toward PEAK reads as the same travelling
    // highlight while being bounded by PEAK whatever it lands on.
    const cph = Math.sin(t * 0.21) * 0.5 + 0.5;
    ctx.save();
    for (let i = 0; i < 2; i++) {
      const px = lerp(cx - mw * 0.58, cx + mw * 0.58, i === 0 ? cph : 1 - cph * 0.7);
      const cg = ctx.createLinearGradient(px - cap * 0.46, base - cap, px + cap * 0.46, base);
      cg.addColorStop(0, rgba(PEAK, 0));
      cg.addColorStop(0.5, rgba(PEAK, i === 0 ? 0.40 : 0.24));
      cg.addColorStop(1, rgba(PEAK, 0));
      this._vtext('LUMEN', cx, base, cap, { ...wopt, body: cg });
    }
    ctx.restore();

    // a band of light travelling through the letterforms. Same reasoning as the
    // caustics: a lerp toward a mint at the ceiling, not 0.85 of MINT_HI added
    // on top of a body at 0.99 — which is 1.8x white and clipped a whole
    // letterform at a time.
    if (sweepA > 0.01) {
      const px = lerp(cx - mw * 0.70, cx + mw * 0.70, sweep);
      ctx.save();
      const g = ctx.createLinearGradient(px - cap * 0.58, 0, px + cap * 0.58, 0);
      g.addColorStop(0, rgba(MINT, 0));
      g.addColorStop(0.5, rgba(MINT, 0.88 * sweepA));
      g.addColorStop(1, rgba(MINT, 0));
      this._vtext('LUMEN', cx, base, cap, {
        align: 'center', track: 30, kern: KERN, weight: 0.142, body: g,
      });
      ctx.restore();
    }

    // --- subtitle, flanked ---
    const sy = Math.round(ruleY + 38 * k);
    this._plate(cx, sy - 5 * k, 200 * k, 30 * k, 0.34);
    const sw = this._label('DEEP DRIFT', cx, sy, 15 * k, 600, 14 * k, DIM, 0.96, 'center');
    this._rule(cx - sw * 0.5 - 58 * k, cx - sw * 0.5 - 16 * k, sy - 5 * k, hair, STEEL, 0.55, 1.8);
    this._rule(cx + sw * 0.5 + 16 * k, cx + sw * 0.5 + 58 * k, sy - 5 * k, hair, STEEL, 0.55, 1.8);

    // --- the one button ---
    const py = Math.round(H * lerp(0.72, 0.60, tall));
    const breathe = 0.60 + 0.40 * Math.sin(t * 1.9);
    const pw2 = 138 * k;
    this._rule(cx - W * 0.34, cx - pw2 * 0.5 - 26 * k, py - 1, hair, STEEL, 0.20 * struct, 1.5);
    this._rule(cx + pw2 * 0.5 + 26 * k, cx + W * 0.34, py - 1, hair, STEEL, 0.20 * struct, 1.5);
    this._pill(cx, py, pw2, 43 * k, breathe, 'HOLD', 15.5 * k, k);
    this._label('HOLD TO SWING   ·   RELEASE TO FLY', cx, py + 54 * k, 11.5 * k, 500, 6.6 * k, DIM, 0.74, 'center');

    // --- personal best, bottom left ---
    const mx = Math.round(48 * k), my = Math.round(H - 48 * k);
    if (s.best > 0.5) {
      this._plate(mx + 72 * k, my - 15 * k, 158 * k, 62 * k, 0.40);
      // Not 'BEST DEPTH' any more: the record is a banked score, and depth is
      // only its floor. Labelling it in metres was the same broken promise the
      // multiplier itself was making.
      this._label('BEST SCORE', mx, my - 31 * k, 9.5 * k, 600, 5.2 * k, FAINT, 1);
      this._vtext(group(Math.round(s.best)), mx, my, 31 * k, {
        body: rgba(WARM, 0.97), core: this._core(my, 31 * k, 0.30),
        shadow: 0.42, glow: 0.55, glowCol: WARM, weight: 0.15,
      });
    }
    this._plate(cx, my - 4 * k, 168 * k, 30 * k, 0.5);
    this._label('M  MUTE   ·   P  PAUSE', cx, my, 9.5 * k, 500, 4.6 * k, DIM, 0.72, 'center');

    // --- corner marks: this is an instrument ---
    const cm = 24 * k, ci = Math.round(30 * k);
    ctx.fillStyle = rgba(STEEL, 0.26);
    for (const [x, y, sx, sy2] of [[ci, ci, 1, 1], [W - ci, ci, -1, 1], [ci, H - ci, 1, -1], [W - ci, H - ci, -1, -1]]) {
      ctx.fillRect(sx > 0 ? x : x - cm, y, cm, hair);
      ctx.fillRect(x, sy2 > 0 ? y : y - cm, hair, cm);
    }
  }

  // ================================================== play: the top strip ====
  /** Scrim plus the personal-best rail, riding the very top edge of the frame. */
  _strip(s, W, H, k) {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, 150 * k);
    g.addColorStop(0, rgba(NIGHT, 0.52));
    g.addColorStop(0.34, rgba(NIGHT, 0.30));
    g.addColorStop(1, rgba(NIGHT, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, 150 * k);

    if (s.best <= 0.5) return;
    // ...and recedes as the Hush chews the frame edge it lives on
    const a = 1 - 0.85 * clamp01(s.hushProx || 0);
    if (a < 0.05) return;
    const h = Math.max(2, 3 * k);
    const rec = (s.score || 0) > s.best + 0.001;
    const f = rec ? 1 : clamp01((s.score || 0) / s.best);
    ctx.fillStyle = rgba(FAINT, 0.26 * a);
    ctx.fillRect(0, 0, W, h);
    const acc = rec ? WARM : CYAN;
    const bg = ctx.createLinearGradient(0, 0, W * Math.max(f, 0.02), 0);
    bg.addColorStop(0, rgba(acc, 0.30 * a));
    bg.addColorStop(1, rgba(rec ? WARM_HI : ICE, (rec ? 0.98 : 0.90) * a));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W * f, h);
    if (!rec) {
      ctx.fillStyle = rgba(ICE, 0.85 * a);
      ctx.fillRect(W * f - Math.max(1, 2 * k), 0, Math.max(1, 2 * k), h + 4 * k);
    }
  }

  // ================================================================= score ===
  /**
   * ONE headline number, and it is the one the chain multiplies. It used to be
   * the distance, which nothing multiplied - so half the HUD's real estate
   * reported a multiplier that could not affect the outcome. The score is banked
   * forward per metre claimed (see `_bank` in main.js), which means it *is* the
   * distance until a chain is live and then visibly outruns it. That is the
   * whole tutorial: same number, climbing faster.
   *
   * The distance survives as the small figure under it rather than as a second
   * headline. It is what "Deep Drift" names, it is what the Hush is measured in,
   * and side by side with the score it shows the multiplier's work without a
   * word of explanation. It is not competing for the eye: 9.5px against 54px.
   */
  _score(s, W, H, k) {
    const ctx = this.ctx;
    const shown = Math.max(0, Math.floor(s.score || 0));
    const str = group(shown);
    const cap = 54 * k;
    const cx = Math.round(W * 0.5);
    const labY = Math.round(32 * k);
    const base = Math.round(102 * k);
    const rec = s.best > 0.5 && ((s.score || 0) > s.best + 0.001 || s.newBest);
    const acc = rec ? WARM : ICE;
    const pop = easeOutCubic(this.recordPop) * 0.5 + this.mile * 0.4;

    const numW = this._measure(str, cap);
    // The scrim and the streak are sized from a FLOOR, not from the digits, and
    // that is the fixable half of a real complaint: a reviewer found the score
    // block's left margin moving between builds. It is not jitter — figures are
    // fixed-advance, so a changing readout cannot move within a build. It is
    // that the block is centre-aligned and every part of it is sized from the
    // FIGURE COUNT, and the figure count at a named scene is whatever that
    // build's run happened to have banked. Computed at cap 54k on a 1600x900
    // frame, where one figure is 50.4px: 3 figures -> 4 adds the group space
    // too, so the numerals' left edge steps 32.4px and the plate's steps
    // 51.8px; 4 -> 5 is 18.0px and 28.8px. The counts really do differ across
    // the frames a reviewer is handed — seed 7 is at 448 when `fast` resolves
    // and 1552 at the 400m depth mark, three figures against four, and which
    // side of that a named moment falls on is decided by the physics and the
    // routing, not by this file. Flooring the plate and the streak at a
    // four-figure block removes the larger of the two steps for every score
    // under 10 000. The numerals themselves
    // still move, and they cannot be made not to while the headline is centred
    // — the only real fix is to anchor the block, which is a composition change
    // and not one to make unilaterally.
    const blockW = Math.max(numW, this._measure('0 000', cap));
    this._plate(cx, base - cap * 0.42, blockW * 0.80 + 100 * k, cap * 1.5, 0.34);
    if (this.mile > 0.01) this._streak(cx, base - cap * 0.40, blockW * 0.9 + 120 * k, cap * 0.38, acc, 0.32 * this.mile);

    this._label(rec ? 'NEW BEST' : 'SCORE', cx, labY, 10 * k, 700, 5.8 * k,
      rec ? WARM : DIM, rec ? 0.98 : 0.82, 'center');

    const numCap = cap * (1 + pop * 0.045);
    for (let i = 0; i < this.dfx.length; i++) this.liftBuf[i] = -this.dfx[i] * numCap * 0.15;
    this._vtext(str, cx, base, numCap, {
      align: 'center', weight: 0.15, dfx: this.liftBuf,
      body: this._grad(base, cap, rgba(INK, 0.99), rgba(asBody(acc), 0.98), rgba(rec ? [186, 118, 44] : STEEL, 0.97)),
      core: this._core(base, cap, 0.36),
      shadow: 0.52, glow: 0.55 + pop * 0.9, glowCol: acc,
    });

    const parts = [{ s: String(Math.round(Math.max(0, s.depth || 0))), t: 1.4 * k }, { s: ' M', t: 3.4 * k }];
    if (s.best > 0.5) {
      parts.push({ s: '   ·   ', t: 3.0 * k },
        { s: rec ? 'PASSED ' : 'BEST ', t: 5.0 * k },
        { s: group(Math.round(s.best)), t: 1.4 * k });
    }
    this._runs(parts, cx, base + 20 * k, 9.5 * k, 600, rec ? WARM : FAINT, rec ? 0.85 : 1);
    ctx.textAlign = 'left';
  }

  // ================================================================= chain ===
  _chain(s, W, H, k) {
    const ctx = this.ctx;
    const p = s.player || {};
    const chain = s.chain || 0;
    if (s.mult <= 1 && chain < 0.05) return;
    const pop = easeOutCubic(clamp01((p.chainPop || 0) * 0.8 + this.stepPop * 0.55));
    const tier = clamp(Math.floor(s.mult / 5), 0, 6);
    const hot = clamp01((s.mult - 8) / 16);          // 0 below x8, 1 by x24
    const rx = Math.round(W - 36 * k);
    const labY = Math.round(34 * k);
    const cap = (33 + tier * 2.1) * k * (1 + pop * 0.09);
    const base = Math.round(100 * k);
    const txt = 'x' + (s.mult % 1 ? s.mult.toFixed(1) : String(s.mult));
    const acc = hot <= 0 ? MINT : [
      Math.round(lerp(MINT[0], WARM_HI[0], hot * 0.42)),
      Math.round(lerp(MINT[1], WARM_HI[1], hot * 0.20)),
      Math.round(lerp(MINT[2], WARM_HI[2], hot * 0.06))];

    const numW = this._measure(txt, cap);
    this._plate(rx - numW * 0.45, base - cap * 0.40, numW * 0.8 + 92 * k, cap * 1.5, 0.34);
    // The pop streak used to be drawn last, additively, ON TOP of the figure —
    // 0.32 of MINT added to a body already at the ceiling is the same clipping
    // mechanism as the core. Behind the number it is a lens artefact rather
    // than a wash, which is what the rest of the frame's streaks already are.
    if (pop > 0.02 && s.mult > 1) {
      this._streak(rx - numW * 0.5, base - cap * 0.36, numW * 0.9 + 70 * k, cap * 0.34, acc, 0.32 * pop);
    }

    // tier diamonds, left of the label
    for (let i = 0; i < tier; i++) {
      const dx = rx - 74 * k - i * 12 * k, dy = labY - 3.5 * k, r = 3.6 * k;
      ctx.beginPath();
      ctx.moveTo(dx, dy - r); ctx.lineTo(dx + r, dy); ctx.lineTo(dx, dy + r); ctx.lineTo(dx - r, dy);
      ctx.closePath();
      ctx.fillStyle = rgba(acc, 0.9);
      ctx.fill();
    }
    this._label('CHAIN', rx, labY, 10 * k, 700, 5.8 * k, hot > 0.4 ? acc : DIM, 0.86, 'right');

    // At x1 the number says nothing; the meter alone teaches that three
    // plankton make a step. The figure joins it once there is one to show.
    if (s.mult > 1) this._vtext(txt, rx, base, cap, {
      align: 'right', weight: 0.15,
      body: this._grad(base, cap, rgba(MINT_HI, 0.99), rgba(asBody(acc), 0.98),
        rgba([Math.round(acc[0] * 0.40), Math.round(acc[1] * 0.62), Math.round(acc[2] * 0.50)], 0.97)),
      core: this._core(base, cap, 0.30 + 0.06 * hot),
      shadow: 0.52, glow: 0.5 + pop * 1.3 + hot * 0.7, glowCol: acc,
    });

    // Corner brackets escalate with the tier - doubled, not boxed: a full frame
    // around a number reads as a debug selection marquee.
    if (s.mult >= 10) {
      const bw = numW + 26 * k, bh = cap * 1.26;
      const bx = rx - bw + 13 * k, by = base - cap * 1.06;
      const a = 0.38 + 0.32 * clamp01((s.mult - 10) / 14) + pop * 0.3;
      ctx.save();
      ctx.lineCap = 'butt';
      const brackets = (inset, seg, al, lw) => {
        ctx.strokeStyle = rgba(acc, al);
        ctx.lineWidth = Math.max(1, lw);
        for (const ix of [0, 1]) for (const iy of [0, 1]) {
          const X = bx + (ix ? bw + inset : -inset), Y = by + (iy ? bh + inset : -inset);
          ctx.beginPath();
          ctx.moveTo(X + (ix ? -seg : seg), Y);
          ctx.lineTo(X, Y);
          ctx.lineTo(X, Y + (iy ? -seg : seg));
          ctx.stroke();
        }
      };
      brackets(0, clamp(11 * k, 6, 26), a, 1.7 * k);
      if (s.mult >= 20) brackets(6 * k, clamp(20 * k, 10, 44), a * 0.42, 1.2 * k);
      ctx.restore();
    }

    // segments to the next multiplier step
    const frac = (chain % 3) / 3;
    const sy = Math.round(s.mult > 1 ? base + 17 * k : labY + 17 * k);
    const n = 7, segW = 12 * k, gap = 4.5 * k, sh = Math.max(2, 5 * k);
    const litF = frac * n;
    for (let i = 0; i < n; i++) {
      const x = rx - (n - i) * (segW + gap) + gap;
      const lit = i < Math.floor(litF);
      ctx.fillStyle = rgba(lit ? acc : FAINT, lit ? 0.94 : 0.14);
      ctx.fillRect(x, lit ? sy : sy + sh * 0.34, segW, lit ? sh : sh * 0.32);
      if (i === Math.floor(litF)) {
        const part = litF - Math.floor(litF);
        ctx.fillStyle = rgba(acc, 0.85 * part);
        ctx.fillRect(x, sy, segW * part, sh);
      }
    }
    ctx.textAlign = 'left';
  }

  // =========================================================== bottom scrim ==
  /**
   * `_strip`'s counterpart at the other edge, and the contrast half of a bottom
   * safe area.
   *
   * The seabed is where the level's geometry is: kelp, reeds, coral and the
   * trench floor all grow up into the band the speed rail lives in, and a blind
   * review found a coral arm passing straight through the word SPEED — already
   * the lowest-contrast text in the frame, because the only scrim under it was
   * an ellipse that had faded to nothing by the time it reached that label.
   *
   * Full width and constant in x on purpose. `tools/_hair.mjs` scores
   * column-to-column steps, and AI_HANDOFF §8 already records this file's
   * "THE HUSH" panel as the largest one in every hushNear frame. A band with no
   * horizontal variation adds exactly zero to that statistic, where a
   * partial-width or feathered-at-the-ends scrim would have added two more
   * vertical edges to a seam hunt that has been misdirected by this file
   * before.
   *
   * `SAFE` is the same constant `hudSafeBottom` exports, so the darkened band
   * and the band props are asked to stay out of are the same band by
   * construction rather than by two numbers agreeing for now.
   *
   * Cost, because a full-width fill every frame is not free. Interleaved
   * old/new/old/new with `tools/_perf.mjs` at 1600x900 on `fast`: the HUD pass
   * goes 0.188ms -> 0.200ms, +0.012ms, and ablating just this method is below
   * that instrument's own 0.0125ms quantum — four ablation pairs both bottomed
   * out at 0.200ms. Geometrically it is one fillRect of 1600x131 = 210k pixels,
   * 79% of the area of the `_strip` fill this file has always done at the top
   * edge, so at worst it doubles a cost that already fits.
   *
   * A negative result worth not repeating: forcing rasterisation with a
   * `getImageData` per iteration, to measure what `gl.finish()` does not flush,
   * reports `hud.draw` at 30ms. That is 150x the whole HUD pass and it is the
   * readback, not the draw — headless Chrome software-rasterises this canvas.
   * Only the ratio it gives is usable (+10.5%, stable over three pairs). There
   * is no instrument here that measures 2D rasterisation honestly; do not build
   * a budget on one.
   */
  _floor(W, H, k) {
    const ctx = this.ctx;
    const b = SAFE * k;
    const g = ctx.createLinearGradient(0, H - b, 0, H);
    g.addColorStop(0, rgba(NIGHT, 0));
    g.addColorStop(0.44, rgba(NIGHT, 0.30));
    g.addColorStop(1, rgba(NIGHT, 0.62));
    ctx.fillStyle = g;
    ctx.fillRect(0, H - b, W, b);
  }

  // ============================================================ speed rail ===
  _rail(s, W, H, k) {
    const ctx = this.ctx;
    const p = s.player || {};
    const rw = Math.round(clamp(380 * k, 190, W * 0.42));
    const rx = Math.round(W * 0.5 - rw / 2), ry = Math.round(H - 44 * k);
    const h = Math.max(3, 4.4 * k);
    const f = clamp01((s.speed || 0) / 2800);
    const tf = clamp01((s.topSpeed || 0) / 2800);
    const hair = Math.max(1, 1 / this.dpr);

    // The elliptical plate stays, but at two thirds of its old weight: `_floor`
    // now carries the contrast and two scrims stacked crush the seabed. It was
    // never enough on its own and the geometry says why — it is an ellipse
    // centred on the rail at 0.72 of the rail's half-width, so SPEED at the
    // left end and M/S at the right end sit at the horizontal extremes where it
    // has already fallen to zero. Those are exactly the two labels the review
    // named as lowest-contrast, and exactly the two a coral was growing through.
    this._plate(W * 0.5, ry - 6 * k, rw * 0.72, 56 * k, 0.22);
    // ...and the two ends get plates of their own, which is the other half of
    // why they were the worst text in the frame: every figure in this file is
    // drawn through `_vtext` with a contact shadow under it, and these two
    // labels go through `_label`, which has none. Measured on the scene layer
    // behind the word SPEED, seed 7 `launch`: mean luma 0.628, peak 0.759 — a
    // warm coral colony growing straight through it, so FAINT ink at 0.395 was
    // DARKER than its own background. Every one of the twelve gate frames has
    // geometry in this band peaking at 0.34-0.84, so this is not one bad seed.
    this._plate(rx + 30 * k, ry - 19 * k, 62 * k, 19 * k, 0.55);
    this._plate(rx + rw - 46 * k, ry - 21 * k, 76 * k, 22 * k, 0.50);

    // labels sit above, so the rail is the last thing before the frame edge
    this._label('SPEED', rx, ry - 14 * k, 9.5 * k, 700, 5 * k, DIM, 1);
    const ms = String(Math.round((s.speed || 0) / 10));
    const uw = this._label('M/S', rx + rw, ry - 14 * k, 9 * k, 700, 2.8 * k, DIM, 1, 'right');
    this._vtext(ms, rx + rw - uw - 7 * k, ry - 12 * k, 19 * k, {
      align: 'right', body: rgba(DIM, 0.96), core: this._core(ry - 12 * k, 19 * k, 0.2),
      shadow: 0.34, weight: 0.16,
    });

    // The unfilled track. It was 3.3px of FAINT at 0.34, which measured on the
    // `fast` frame at x=1000 as composite [39,53,59] against rock at [26,29,31]
    // — 13-28 code values of separation, so wherever the seabed is pale it is
    // simply not there. A blind review called it a 1px hairline; that is what a
    // 3px smear at that contrast looks like, and the height was never the
    // problem on its own. It is now 4.4k on a dark groove of its own, at close
    // to twice the ink, which is what makes an empty track read as a track
    // rather than as a scratch.
    ctx.fillStyle = rgba(NIGHT, 0.55);
    ctx.fillRect(rx - hair, ry - hair, rw + hair * 2, h + hair * 2);
    ctx.fillStyle = rgba(STEEL, 0.42);
    ctx.fillRect(rx, ry, rw, h);
    for (let i = 0; i <= 8; i++) {
      const x = Math.round(rx + (rw * i) / 8);
      const th = (i % 4 === 0 ? 6 : 3.5) * k;
      ctx.fillStyle = rgba(FAINT, i % 4 === 0 ? 0.7 : 0.42);
      ctx.fillRect(x, ry - th - 2 * k, hair, th);
    }
    // The handle's streak goes UNDER the fill, not over it. Additively on top
    // it was 0.34 of ICE landing on a bar whose hot end is at the ceiling;
    // underneath, the part that shows is the halo spilling past the bar's end,
    // which is the whole point of an anamorphic streak anyway.
    const hx = Math.round(rx + rw * f);
    this._streak(hx, ry + h * 0.5, 26 * k, 9 * k, ICE, 0.34);
    const g = ctx.createLinearGradient(rx, 0, rx + rw, 0);
    g.addColorStop(0, rgba(STEEL, 0.88));
    g.addColorStop(0.55, rgba(CYAN, 0.95));
    g.addColorStop(1, rgba(WARM_HI, 0.99));
    ctx.fillStyle = g;
    ctx.fillRect(rx, ry, rw * f, h);
    if (tf > 0.02) {   // this run's ceiling, marked above the rail only
      ctx.fillStyle = rgba(ICE, 0.38);
      ctx.fillRect(Math.round(rx + rw * tf), ry - 6 * k, Math.max(1, 1.4 * k), 6 * k);
    }
    ctx.fillStyle = rgba(PEAK, 0.97);
    ctx.fillRect(hx - Math.max(1, 1.4 * k), ry - 4 * k, Math.max(2, 2.8 * k), h + 8 * k);

    // --- release window: the wordless timing teacher ---
    const gw = 120 * k, gy = ry + 13 * k;
    const rwin = p.attached ? clamp01(p.releaseWindow || 0) : 0;
    const since = p.sinceRelease == null ? 99 : p.sinceRelease;
    const echo = clamp01(1 - since / 0.5) * clamp01(p.releaseQ || 0);
    if (rwin > 0.02 || echo > 0.02) {
      const wu = clamp01(p.windUp || 0);
      ctx.save();
      ctx.fillStyle = rgba(FAINT, 0.26 * clamp01(rwin * 3 + echo));
      ctx.fillRect(W * 0.5 - gw / 2, gy, gw, hair);
      if (rwin > 0.02) {
        const w = gw * rwin;
        const gg = ctx.createLinearGradient(W * 0.5 - w / 2, 0, W * 0.5 + w / 2, 0);
        gg.addColorStop(0, rgba(MINT, 0));
        gg.addColorStop(0.5, rgba(MINT, 0.34 + 0.46 * wu));
        gg.addColorStop(1, rgba(MINT, 0));
        ctx.fillStyle = gg;
        ctx.fillRect(W * 0.5 - w / 2, gy - 1 * k, w, Math.max(2, 3 * k));
        if (rwin > 0.7) {
          // Measured: this was the last thing in the file over the ceiling, at
          // [168,255,225] on seed 7 hazardNear — additive MINT_HI on top of a
          // mint bar that was already lit. Source-over toward a mint AT the
          // ceiling is the same white-hot tick and cannot stack.
          ctx.fillStyle = rgba(MINT, 0.92 * (rwin - 0.7) / 0.3);
          ctx.fillRect(W * 0.5 - 1 * k, gy - 6 * k, Math.max(2, 2.2 * k), 13 * k);
        }
      }
      if (echo > 0.02) {
        const w = gw * clamp01(p.releaseQ || 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = rgba(MINT_HI, 0.55 * echo);
        ctx.fillRect(W * 0.5 - w / 2, gy - 5 * k, w, Math.max(1, 1.8 * k));
      }
      ctx.restore();
    }
    ctx.textAlign = 'left';
  }

  // ============================================================ hush alarm ===
  /**
   * The scene itself floods violet late in a run, so a violet wash reads as
   * nothing, and a HUD copy of the wall reads as an artifact next to the real
   * one. So the alarm never draws the Hush - it draws what the Hush is doing to
   * the *frame*: an off-centre vignette closing in, a border chewed inward by
   * irregular teeth, the wall's light spilling onto the lens, and an
   * instrument that counts down the metres you have left.
   */
  _hush(s, W, H, k) {
    const p = clamp01(s.hushProx || 0);
    if (p < 0.015) return;
    const ctx = this.ctx;
    const t = s.t || 0;
    const puls = 0.5 + 0.5 * Math.sin(t * lerp(3.0, 9.5, p));
    const flick = 0.40 + 0.60 * Math.pow(0.5 + 0.5 * Math.sin(t * 12.5 + Math.sin(t * 4.1) * 2), 2);

    ctx.save();
    // 1. the frame closes in, deepest on the side it comes from
    const vg = ctx.createRadialGradient(W * 0.68, H * 0.5, Math.min(W, H) * 0.14,
      W * 0.68, H * 0.5, Math.hypot(W, H) * 0.60);
    vg.addColorStop(0, rgba([12, 2, 26], 0));
    vg.addColorStop(0.5, rgba([12, 2, 26], 0.16 * p));
    vg.addColorStop(1, rgba([7, 1, 16], 0.62 * p));
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    // 2. the wall's light on the lens
    ctx.globalCompositeOperation = 'lighter';
    const lg = ctx.createLinearGradient(0, 0, W * 0.30, 0);
    lg.addColorStop(0, rgba(VIO, (0.09 + 0.24 * p) * (0.62 + 0.38 * puls)));
    lg.addColorStop(0.32, rgba(VIO, 0.05 * p));
    lg.addColorStop(1, rgba(VIO, 0));
    ctx.fillStyle = lg;
    ctx.fillRect(0, 0, W * 0.30, H);
    ctx.globalCompositeOperation = 'source-over';

    // 3. the frame is being consumed: a torn boundary eating in from each edge,
    //    dark behind it and lit along it, so it reads at any background value
    const bite = (2 + 34 * p * p) * k;
    for (let e = 0; e < 4; e++) {
      const horiz = e < 2, span = horiz ? W : H;
      const n = Math.max(10, Math.round(span / (15 * k)));
      const at = (i) => {
        const hv = hash(i * 1.31 + e * 97), hv2 = hash(i * 2.17 + e * 51);
        // two octaves: groups of deep bites between calmer stretches
        const grp = 0.35 + 1.05 * hash(Math.floor(i / 7) * 5.3 + e * 13);
        const d = bite * grp * (0.16 + 1.45 * hv * hv) * (0.62 + 0.46 * Math.sin(t * (1.4 + hv2 * 2.8) + i * 1.1 + e));
        const u = i / n;
        return e === 0 ? [u * span, d] : e === 1 ? [u * span, H - d]
          : e === 2 ? [d, u * span] : [W - d, u * span];
      };
      ctx.beginPath();
      for (let i = 0; i <= n; i++) { const q = at(i); if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]); }
      const outer = e === 0 ? [[W + 2, -2], [-2, -2]] : e === 1 ? [[W + 2, H + 2], [-2, H + 2]]
        : e === 2 ? [[-2, H + 2], [-2, -2]] : [[W + 2, H + 2], [W + 2, -2]];
      ctx.lineTo(outer[0][0], outer[0][1]);
      ctx.lineTo(outer[1][0], outer[1][1]);
      ctx.closePath();
      const gr = horiz
        ? ctx.createLinearGradient(0, e === 0 ? 0 : H, 0, e === 0 ? bite * 1.5 : H - bite * 1.5)
        : ctx.createLinearGradient(e === 2 ? 0 : W, 0, e === 2 ? bite * 1.5 : W - bite * 1.5, 0);
      gr.addColorStop(0, rgba([3, 0, 8], 0.55 + 0.40 * p));
      gr.addColorStop(1, rgba([3, 0, 8], 0.04));
      ctx.fillStyle = gr;
      ctx.fill();
      // the torn edge glows
      ctx.beginPath();
      for (let i = 0; i <= n; i++) { const q = at(i); if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]); }
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = Math.max(4, 11 * k);
      ctx.strokeStyle = rgba(VIO, (0.035 + 0.10 * p) * flick);
      ctx.stroke();
      ctx.lineWidth = Math.max(1, 1.7 * k);
      ctx.strokeStyle = rgba(VIO_HI, (0.16 + 0.46 * p) * (0.55 + 0.45 * flick));
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }

    // 4. the instrument: how many metres are left
    const gap = s.world && s.player ? Math.max(0, (s.player.x - s.world.hushX) * 0.1) : (1 - p) * 150;
    const lx = Math.round(46 * k), ly = Math.round(H * 0.5);
    const a0 = clamp01(p / 0.22);
    this._plate(lx + 92 * k, ly + 2 * k, 210 * k, 82 * k, 0.62 * a0);
    ctx.fillStyle = rgba(VIO_HI, 0.85 * a0 * (0.55 + 0.45 * puls));
    ctx.fillRect(lx, ly - 32 * k, Math.max(2, 3 * k), 62 * k);
    this._label('THE HUSH', lx + 15 * k, ly - 20 * k, 13 * k, 700, 8.6 * k, VIO_HI, a0 * (0.72 + 0.28 * puls));
    const gw = this._vtext(String(Math.round(gap)), lx + 15 * k, ly + 15 * k, 30 * k, {
      body: rgba(VIO_HI, 0.97 * a0), core: this._core(ly + 15 * k, 30 * k, 0.34 * a0),
      shadow: 0.5, glow: 0.7 * a0, glowCol: VIO, weight: 0.15,
    });
    this._vtext('M', lx + 15 * k + gw + 10 * k, ly + 15 * k, 15 * k,
      { body: rgba(VIO_HI, 0.6 * a0), shadow: 0.34, weight: 0.16 });
    const bw = 168 * k;
    ctx.fillStyle = rgba(VIO, 0.26 * a0);
    ctx.fillRect(lx + 15 * k, ly + 26 * k, bw, Math.max(2, 2.6 * k));
    ctx.fillStyle = rgba(VIO_HI, 0.92 * a0);
    ctx.fillRect(lx + 15 * k, ly + 26 * k, bw * p, Math.max(2, 2.6 * k));

    // flee chevrons, leading away from the wall
    if (p > 0.10) {
      const a1 = clamp01((p - 0.10) / 0.30);
      ctx.lineWidth = Math.max(2, 3 * k);
      ctx.lineCap = 'butt';
      for (let i = 0; i < 3; i++) {
        const ph = 0.5 + 0.5 * Math.sin(t * 5.4 - i * 0.9);
        const x = lx + 200 * k + i * 17 * k;
        ctx.strokeStyle = rgba(VIO_HI, a1 * (0.12 + 0.6 * ph));
        ctx.beginPath();
        ctx.moveTo(x, ly - 13 * k); ctx.lineTo(x + 11 * k, ly); ctx.lineTo(x, ly + 13 * k);
        ctx.stroke();
      }
    }
    // a heartbeat over the whole frame once it is really close
    if (p > 0.66) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = rgba(VIO, 0.05 * ((p - 0.66) / 0.34) * flick);
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }

  // ================================================================= death ===
  _death(s, W, H, k) {
    const ctx = this.ctx;
    const t = s.deadT || 0;
    const p = s.player || {};
    const st = (d, dur) => easeOutQuint(clamp01((t - d) / dur));
    const scrim = st(0, 0.34);
    if (scrim <= 0.002) return;

    // main.js sets this when the run actually took the record. Inferring it by
    // comparing `best` to the run's number no longer works and was always a
    // trick: `best` is rounded on the way into localStorage now, so the two are
    // up to half a unit apart at the moment the record is taken.
    const isRec = !!s.newBest;
    const acc = isRec ? WARM : ICE;
    const cap = 104 * k;
    const cx = Math.round(W * 0.5);
    const cy = Math.round(clamp(H * 0.40, cap + 120 * k, H - 250 * k));
    const hair = Math.max(1, 1 / this.dpr);

    ctx.save();
    // the frame closes in on you
    const vg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(W, H) * 0.6);
    vg.addColorStop(0, rgba(NIGHT, 0.40 * scrim));
    vg.addColorStop(0.5, rgba(NIGHT, 0.62 * scrim));
    vg.addColorStop(1, rgba(NIGHT, 0.93 * scrim));
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    // cause
    const causeY = Math.round(cy - cap - 26 * k);
    ctx.globalAlpha = st(0.04, 0.32);
    const cause = p.deathCause === 'hush' ? 'THE HUSH TOOK YOU'
      : p.deathSrc && p.deathSrc.kind === 2 ? 'STUNG IN THE DARK'
      : p.deathCause === 'hazard' ? 'RAN ONTO THE SPINES' : 'THE DRIFT ENDED';
    const cw = this._label(cause, cx, causeY, 12 * k, 600, 9.5 * k, DIM, 0.92, 'center');
    this._rule(cx - cw * 0.5 - 54 * k, cx - cw * 0.5 - 16 * k, causeY - 5 * k, hair, FAINT, 0.6, 1.8);
    this._rule(cx + cw * 0.5 + 16 * k, cx + cw * 0.5 + 54 * k, causeY - 5 * k, hair, FAINT, 0.6, 1.8);
    ctx.globalAlpha = 1;

    // the number lands
    const land = st(0.10, 0.44);
    const str = group(Math.round(s.score || 0));
    if (land > 0.004) {
      const numCap = cap * lerp(1.26, 1.0, land);
      const numW = this._measure(str, numCap);
      // two bars fly in and collide behind it
      const coll = clamp01((t - 0.10) / 0.30);
      const barA = Math.sin(coll * PI);
      if (barA > 0.01) {
        const half = lerp(W * 0.5, numW * 0.60 + 40 * k, easeOutQuint(coll));
        this._streak(cx - half * 0.5, cy - cap * 0.30, half * 0.5, cap * 0.09, acc, 0.6 * barA);
        this._streak(cx + half * 0.5, cy - cap * 0.30, half * 0.5, cap * 0.09, acc, 0.6 * barA);
      }
      this._plate(cx, cy - cap * 0.34, numW * 0.78 + 140 * k, cap * 1.1, 0.44 * scrim);
      this._streak(cx, cy - cap * 0.34, numW * 0.85 + 160 * k, cap * 0.32, acc, 0.12 + 0.20 * (1 - land));
      ctx.save();
      ctx.globalAlpha = land;
      this._vtext(str, cx, cy, numCap, {
        align: 'center', weight: 0.148,
        body: this._grad(cy, numCap, rgba(INK, 0.99), rgba(asBody(acc), 0.99), rgba(isRec ? [184, 116, 40] : STEEL, 0.98)),
        core: this._core(cy, numCap, 0.34),
        shadow: 0.55, glow: 0.7 + (1 - land) * 1.5, glowCol: acc,
      });
      ctx.restore();
    }

    // record banner
    let sy = cy + 58 * k;
    if (isRec) {
      const a2 = st(0.42, 0.32);
      if (a2 > 0.004) {
        ctx.save();
        ctx.globalAlpha = a2;
        const bw = 250 * k * (0.6 + 0.4 * a2);
        this._rule(cx - bw / 2, cx + bw / 2, cy + 26 * k, Math.max(1, 1.5 * k), WARM, 0.8, 1.4);
        // Not 'DEEPEST': a record is now the best banked score, and a shorter
        // dive with a hotter chain can take it.
        this._label('BEST DIVE YET', cx, cy + 50 * k, 11.5 * k, 700, 8.5 * k, WARM, 0.98, 'center');
        ctx.restore();
      }
      sy = cy + 84 * k;
    }

    // stats, staggered
    sy = Math.round(sy);
    const colW = clamp(176 * k, 96, W * 0.29);
    this._rule(cx - colW * 1.45, cx + colW * 1.45, sy, hair, FAINT, 0.45 * st(0.28, 0.3), 1.5);
    // These three read as the factorisation of the hero number: the metres you
    // travelled, the multiplier you travelled them at, and how fast. The best is
    // not a column any more - on a record the banner says so, and off one the
    // shortfall line below does, so the slot goes to something the run earned.
    const stats = [
      ['DEPTH', group(Math.round(Math.max(0, s.depth || 0))), 'M', false],
      ['BEST CHAIN', 'x' + ((s.bestMult || 1) % 1 ? (s.bestMult).toFixed(1) : String(s.bestMult || 1)), '', false],
      ['TOP SPEED', String(Math.round((s.topSpeed || 0) / 10)), 'M/S', false]];
    for (let i = 0; i < stats.length; i++) {
      const [lab, val, unit, warm] = stats[i];
      const a3 = st(0.32 + i * 0.09, 0.36);
      if (a3 <= 0.004) continue;
      const x = Math.round(cx + (i - 1) * colW);
      ctx.save();
      ctx.globalAlpha = a3;
      const rise = (1 - a3) * 14 * k;
      if (i > 0) {
        ctx.fillStyle = rgba(FAINT, 0.3);
        ctx.fillRect(x - colW * 0.5, sy + 12 * k + rise, hair, 46 * k);
      }
      this._label(lab, x, sy + 26 * k + rise, 9.5 * k, 700, 5.2 * k, FAINT, 1, 'center');
      const vy = sy + 60 * k + rise;
      const off = unit ? 8 * k : 0;
      const vw = this._vtext(val, x - off, vy, 26 * k, {
        align: 'center', weight: 0.155,
        body: rgba(asBody(warm ? WARM : INK), 0.95), core: this._core(vy, 26 * k, 0.22),
        shadow: 0.42, glow: 0.32, glowCol: warm ? WARM : CYAN,
      });
      if (unit) this._label(unit, x - off + vw / 2 + 7 * k, vy, 9 * k, 700, 2.4 * k, FAINT, 1);
      ctx.restore();
    }
    if (!isRec && s.best > 0.5) {
      ctx.save();
      ctx.globalAlpha = st(0.5, 0.3) * 0.85;
      this._runs([{ s: 'BEST ', t: 5.6 * k }, { s: group(Math.round(s.best)), t: 1.5 * k },
        { s: '   ·   ', t: 3.2 * k },
        { s: group(Math.max(0, Math.round(s.best - (s.score || 0)))), t: 1.5 * k },
        { s: ' SHORT', t: 5.6 * k }], cx, sy + 92 * k, 10 * k, 600, DIM, 0.85);
      ctx.restore();
    }

    // prompt: arrives before you have finished reading
    const a5 = st(0.60, 0.30);
    if (a5 > 0.004) {
      const py = Math.round(clamp(sy + 172 * k, sy + 130 * k, H - 62 * k));
      const breathe = 0.55 + 0.45 * Math.sin(t * 3.1);
      ctx.save();
      ctx.globalAlpha = a5;
      this._pill(cx, py, 122 * k, 38 * k, breathe, 'HOLD', 14 * k, k);
      this._label('TO DIVE AGAIN', cx, py + 46 * k, 10.5 * k, 600, 6.2 * k, DIM, 0.74, 'center');
      ctx.restore();
    }
    ctx.restore();
    ctx.textAlign = 'left';
  }

  _paused(s, W, H, k) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = rgba(NIGHT, 0.64);
    ctx.fillRect(0, 0, W, H);
    const cy = Math.round(H * 0.5);
    this._rule(W * 0.5 - 160 * k, W * 0.5 + 160 * k, cy - 36 * k, Math.max(1, 1 / this.dpr), STEEL, 0.5, 1.6);
    this._label('PAUSED', W * 0.5, cy + 6 * k, 26 * k, 300, 18 * k, INK, 0.95, 'center');
    this._label('P TO RESUME', W * 0.5, cy + 40 * k, 10 * k, 600, 6 * k, FAINT, 1, 'center');
    ctx.restore();
    ctx.textAlign = 'left';
  }
}

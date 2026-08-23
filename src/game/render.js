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
// This renderer only knows quads and polylines, so solid dark bodies are built
// by stroking a shape's *medial axis* with a low-falloff ribbon: falloff near 1
// turns the gaussian cross-section into a filled body instead of a filament,
// and a width function gives the body its profile. That is where the
// silhouettes come from.
import { Blend } from '../engine/gl.js';
import { SpriteBatch } from '../engine/sprites.js';
import { Ribbons } from '../engine/ribbons.js';
import { S } from '../engine/textures.js';
import { PAL, depthFade, scaled } from '../art/palette.js';
import { KIND } from './world.js';
import { clamp, clamp01, lerp, smoothstep, mixCol, TAU } from '../engine/math.js';
import { noise1, hash2 } from '../engine/rng.js';

// Colour registers. Nothing in this file may allocate per frame.
const c0 = [0, 0, 0], c1 = [0, 0, 0], c2 = [0, 0, 0], c3 = [0, 0, 0];

// A texture agent may add layers; resolve optional ones against a fallback so
// this file renders correctly against either version of the kit.
const LY = (name, fb) => (S[name] !== undefined ? S[name] : fb);
const L_LEAF = LY('LEAF', S.SHARD);
const L_ROCK = LY('ROCK', S.SMOKE);
const L_MEMB = LY('MEMBRANE', S.BLOB);

const MAXP = 96;         // longest polyline any shape here needs
const FAR = 0.44;        // decor depth that moves an object into the far round

export class Scene {
  constructor(gl, tex) {
    this.gl = gl;
    this.occl = new SpriteBatch(gl, tex.sprites, 4096);
    this.glow = new SpriteBatch(gl, tex.sprites, 12288);
    this.rDark = new Ribbons(gl, 49152);
    this.rGlow = new Ribbons(gl, 65536);

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

  /** @param g the frameCtx from main.js - see Game.frameCtx() */
  draw(g) {
    const gl = this.gl;
    const { world, player, cam, t } = g;
    const b = cam.bounds(460);
    const dim = g.envDim === undefined ? 1 : g.envDim;

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
    // Travelling wave down the stalk: the tip lags the base, which is what makes
    // a plant look pushed by water rather than rotated about its root.
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      const wave = Math.sin(t * d.sway + d.phase - f * 1.75) * 0.74
                 + Math.sin(t * d.sway * 1.9 + d.phase * 1.7 - f * 3.1) * 0.26;
      pts[s * 2] = d.x + f * f * d.lean * 205 + wave * 168 * f * f;
      pts[s * 2 + 1] = d.y - d.h * f;
    }

    // Thick and opaque at the root, thin and translucent at the tip.
    depthFade(PAL.voidDeep, d.depth * 0.55, c0);
    const opa = 1 - d.depth * 0.30;
    this.rDark.stroke(pts, {
      width: (f) => lerp(d.w * 2.7, d.w * 0.42, Math.pow(f, 0.82)),
      color: c0, alpha: (f) => lerp(0.97, 0.16, Math.pow(f, 1.3)) * opa, falloff: 1.15,
    });

    // Blades. A bare curve is a wire; blades make it a plant.
    const nb = 6;
    for (let k = 0; k < nb; k++) {
      const f = 0.13 + 0.80 * ((k + hash2(sid, k * 5 + 1) * 0.75) / nb);
      const si = Math.min(n - 2, (f * (n - 1)) | 0), lf = f * (n - 1) - si;
      const px = lerp(pts[si * 2], pts[si * 2 + 2], lf);
      const py = lerp(pts[si * 2 + 1], pts[si * 2 + 3], lf);
      let tx = pts[si * 2 + 2] - pts[si * 2], ty = pts[si * 2 + 3] - pts[si * 2 + 1];
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const side = (k & 1) ? 1 : -1;
      const bl = d.w * (5.6 + hash2(sid, k * 7 + 3) * 3.4) * (1 - f * 0.42);
      const bw = d.w * (1.5 + hash2(sid, k * 11 + 5) * 1.2);
      const ang = Math.atan2(ty, tx) + side * (0.52 + 0.34 * Math.sin(t * d.sway * 1.3 + k * 2.1 + d.phase));
      this.occl.push(px + Math.cos(ang) * bl * 0.42, py + Math.sin(ang) * bl * 0.42,
        bl, bw, ang, c0[0], c0[1], c0[2], 0.88 * opa, L_LEAF);
    }

    // Edge light. The single thing that lets a dark plant read against dark water.
    depthFade(PAL.waterHigh, d.depth * 0.70 + 0.08, c1);
    const off = this._p2(n);
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      off[s * 2] = pts[s * 2] - lerp(d.w * 1.20, d.w * 0.20, f);
      off[s * 2 + 1] = pts[s * 2 + 1];
    }
    this.rGlow.stroke(off, {
      width: (f) => lerp(d.w * 0.62, d.w * 0.14, f), color: c1,
      alpha: (f) => 0.62 * (1 - f * 0.5) * dim, falloff: 6.5,
    });

    if (d.glow > 0) {
      depthFade(PAL.plankton, d.depth * 0.85, c2);
      const lit = d.glow * (1 - d.depth * 0.7) * dim;
      // Nodes up the stalk, not just a lamp on the tip.
      for (let k = 0; k < 3; k++) {
        const hk = hash2(sid, k + 31);
        const f = 0.40 + 0.56 * (k / 3) + hk * 0.13;
        const si = Math.min(n - 2, (f * (n - 1)) | 0), lf = f * (n - 1) - si;
        const px = lerp(pts[si * 2], pts[si * 2 + 2], lf);
        const py = lerp(pts[si * 2 + 1], pts[si * 2 + 3], lf);
        const pk = 0.40 + 0.60 * Math.sin(t * (1.3 + hk * 1.1) + k * 2.3 + d.phase * 2.1);
        const kk = lit * pk;
        this.glow.puts(px, py, d.w * 6.4, scaled(c2, kk * 0.34, c3), 1, S.GLOW);
        this.glow.puts(px, py, d.w * 1.4, scaled(PAL.planktonCore, kk * 1.05, c3), 1, S.CORE);
      }
      const tx = pts[(n - 1) * 2], ty = pts[(n - 1) * 2 + 1];
      const tp = 0.58 + 0.42 * Math.sin(t * 1.7 + d.phase * 2.1);
      this.glow.puts(tx, ty, d.w * 13, scaled(c2, lit * tp * 0.40, c3), 1, S.GLOW);
      this.glow.puts(tx, ty, d.w * 3.4, scaled(c2, lit * tp * 0.85, c3), 1, S.GLOW);
      this.glow.puts(tx, ty, d.w * 1.1, scaled(PAL.planktonCore, lit * tp * 1.8, c3), 1, S.CORE);
    }
  }

  _spire(d, t, dim) {
    const dir = d.up ? -1 : 1;
    const sid = (d.x * 5.77) | 0;
    const subs = hash2(sid, 3) > 0.55 ? 3 : 2;
    depthFade(PAL.voidDeep, d.depth * 0.28, c0);
    depthFade(PAL.surface, d.depth * 0.80 + 0.10, c1);
    const opa = 1 - d.depth * 0.16;

    for (let q = 0; q < subs; q++) {
      const first = q === 0;
      const sx = d.x + (hash2(sid, q * 9 + 1) - 0.5) * d.w * 1.6;
      const hq = d.h * (first ? 1 : 0.40 + hash2(sid, q * 9 + 2) * 0.44);
      const wq = d.w * (first ? 1 : 0.30 + hash2(sid, q * 9 + 3) * 0.36);
      const lean = d.lean + (hash2(sid, q * 9 + 4) - 0.5) * 0.24;
      const jseed = sid * 0.37 + q * 31.7;
      const n = 11, pts = this._p1(n);
      for (let s = 0; s < n; s++) {
        const f = s / (n - 1);
        pts[s * 2] = sx + f * f * lean * 175;
        pts[s * 2 + 1] = d.y + dir * hq * f;
      }
      // Ridged width, not a smooth cone: rock has facets and steps.
      const wfn = (f) => lerp(wq, wq * 0.05, Math.pow(f, 0.60))
        * (0.80 + 0.44 * noise1(f * 6.5 + jseed));
      this.rDark.stroke(pts, { width: wfn, color: c0, alpha: 0.985 * opa, falloff: 0.95 });

      // Rim light on the lit edge. Stalactites catch it high, stalagmites low.
      const off = this._p2(n);
      for (let s = 0; s < n; s++) {
        const f = s / (n - 1);
        off[s * 2] = pts[s * 2] - wfn(f) * 0.44;
        off[s * 2 + 1] = pts[s * 2 + 1];
      }
      const grad = d.up ? (f) => 0.50 + 0.60 * f : (f) => 1.05 - 0.45 * f;
      this.rGlow.stroke(off, {
        width: (f) => lerp(wq * 0.11, wq * 0.02, f) + 1.6, color: c1,
        alpha: (f) => 0.30 * grad(f) * (1 - d.depth * 0.55) * dim, falloff: 8,
      });

      if (first) {
        // Skirt: without it the spire floats instead of growing out of the rock.
        this.occl.push(sx, d.y + dir * wq * 0.12, wq * 2.8, wq * 1.0, 0,
          c0[0], c0[1], c0[2], 0.55 * opa, L_ROCK);
      }
    }
  }

  _anemone(d, t, dim) {
    const warm = d.hue === 0;
    const base = warm ? PAL.anchorMid : PAL.plankton;
    const tip = warm ? PAL.anchorCore : PAL.planktonCore;
    const sid = (d.x * 9.13) | 0;
    const dir = d.up ? -1 : 1;
    const breathe = 0.55 + 0.45 * Math.sin(t * 1.15 + d.phase);
    const k = (0.40 + breathe * 0.62) * (1 - d.depth * 0.75) * dim;

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
        width: (f) => lerp(d.r * 0.22, d.r * 0.03, Math.pow(f, 0.7)), color: base,
        alpha: (f) => k * 0.52 * (1 - f * 0.35), falloff: 5.5,
      });
      const ex = pts[(n - 1) * 2], ey = pts[(n - 1) * 2 + 1];
      this.glow.puts(ex, ey, d.r * 0.90, scaled(tip, k * 0.95, c1), 1, S.CORE);
      this.glow.puts(ex, ey, d.r * 2.6, scaled(base, k * 0.20, c1), 1, S.GLOW);
    }
    this.glow.puts(d.x, d.y + dir * d.r * 0.35, d.r * 6.0, scaled(base, k * 0.30, c1), 1, S.GLOW);
    this.glow.puts(d.x, d.y + dir * d.r * 0.55, d.r * 1.5, scaled(tip, k * 0.85, c1), 1, S.CORE);
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
    const spin = t * h.spin + h.phase;
    const p = 0.56 + 0.44 * Math.sin(t * 1.35 + h.phase);
    const hot = h.brushed ? 1.30 : 1;

    // Shell: a solid black disc, from a fat low-falloff stroke over a stub axis.
    const bp = this._p1(2);
    bp[0] = h.x - r * 0.16; bp[1] = h.y; bp[2] = h.x + r * 0.16; bp[3] = h.y;
    this.rDark.stroke(bp, { width: r * 1.34, color: PAL.hazardDark, alpha: 0.995, falloff: 0.80 });

    // Spines as geometry, not a texture. This is the whole silhouette, and it
    // is the difference between "menace" and "starfish".
    const ns = 15;
    for (let k = 0; k < ns; k++) {
      const h1 = hash2(sid, k * 3 + 1), h2 = hash2(sid, k * 3 + 2);
      const ang = spin + (k / ns) * TAU + (h1 - 0.5) * 0.18;
      const L = r * (1.06 + h2 * 0.66);
      const bend = (h1 - 0.5) * 0.44;
      const n = 4, pts = this._p2(n);
      for (let s = 0; s < n; s++) {
        const f = s / (n - 1);
        const a = ang + bend * f * f;
        const rr = r * 0.30 + (L - r * 0.30) * f;
        pts[s * 2] = h.x + Math.cos(a) * rr;
        pts[s * 2 + 1] = h.y + Math.sin(a) * rr;
      }
      this.rDark.stroke(pts, {
        width: (f) => lerp(r * 0.21, r * 0.010, Math.pow(f, 0.70)),
        color: PAL.hazardDark, alpha: (f) => 0.99 - f * 0.16, falloff: 0.95,
      });
      // Hot only on the outer third: tips catching light, not glowing sticks.
      this.rGlow.stroke(pts, {
        width: (f) => lerp(r * 0.070, r * 0.008, f), color: PAL.hazardRim,
        alpha: (f) => Math.pow(clamp01((f - 0.44) / 0.56), 1.9) * (0.48 + 0.42 * p) * hot,
        falloff: 12,
      });
    }

    // Ember: a deep coal inside a dark body, never a lamp.
    this.glow.puts(h.x, h.y, r * 7.2, scaled(PAL.hazard, (0.050 + 0.028 * p) * hot, c0), 1, S.GLOW);
    this.glow.puts(h.x, h.y, r * 2.3, scaled(PAL.hazard, (0.10 + 0.09 * p) * hot, c0), 1, S.GLOW);
    this.glow.puts(h.x, h.y, r * 0.92, scaled(PAL.hazard, (0.38 + 0.40 * p) * hot, c0), 1, S.GLOW);
    this.glow.puts(h.x, h.y, r * 0.26, scaled(PAL.hazardRim, (0.95 + 0.85 * p) * hot, c0), 1, S.CORE);

    // Crescent on the shell: light wrapping the top-left of a hard body.
    const n2 = 14, rp = this._p1(n2);
    for (let s = 0; s < n2; s++) {
      const a = -Math.PI * 1.16 + (s / (n2 - 1)) * Math.PI * 0.98;
      rp[s * 2] = h.x + Math.cos(a) * r * 0.58;
      rp[s * 2 + 1] = h.y + Math.sin(a) * r * 0.58;
    }
    this.rGlow.stroke(rp, {
      width: r * 0.11, color: PAL.hazardRim,
      alpha: (f) => Math.pow(Math.sin(f * Math.PI), 1.2) * 0.30 * hot, falloff: 9,
    });
  }

  _jelly(h, t) {
    const r = h.r, sid = (h.x * 6.29) | 0;
    const bell = 0.86 + 0.14 * Math.sin(t * 1.6 + h.bellPhase);
    const w = r * 1.18 * bell;          // half-width of the bell
    const hh = r * 1.06 / bell;         // half-height of the dome
    const cx = h.x, cy = h.y;
    const rim = w * (1.08 + 0.055 * Math.sin(h.bellPhase));
    const hotb = h.brushed ? 1.25 : 1;

    // --- dark fill along the dome's medial axis: the silhouette ---
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
      color: PAL.hazardDark, alpha: 0.74, falloff: 1.0,
    });

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
    this.rDark.stroke(out, { width: w * 0.20, color: PAL.hazardDark, alpha: 0.55, falloff: 1.2 });

    // --- interior: gonads in a ring, radial canals, a manubrium ---
    this.glow.push(cx, cy - hh * 0.40, w * 2.4, hh * 2.0, 0,
      PAL.hazard[0] * 0.15 * bell, PAL.hazard[1] * 0.15 * bell, PAL.hazard[2] * 0.15 * bell, 1, S.GLOW);
    for (let k = 0; k < 4; k++) {
      const u = (k / 3 - 0.5) * 1.32;
      const ox = cx + u * w * 0.74;
      const oy = cy - hh * 0.34 - Math.abs(u) * hh * 0.12;
      const gk = (0.42 + 0.28 * Math.sin(t * 1.9 + k * 1.7 + h.bellPhase)) * bell * hotb;
      this.glow.push(ox, oy, w * 0.34, hh * 0.58, 0,
        PAL.hazard[0] * gk, PAL.hazard[1] * gk, PAL.hazard[2] * gk, 1, L_MEMB);
      this.glow.push(ox, oy, w * 0.13, hh * 0.26, 0,
        PAL.hazardRim[0] * gk * 1.5, PAL.hazardRim[1] * gk * 1.5, PAL.hazardRim[2] * gk * 1.5, 1, S.CORE);
      // canal from the apex down to the rim
      this.rGlow.segment(cx + u * w * 0.14, cy - hh * 0.82, cx + u * rim * 0.94, cy - hh * 0.03,
        w * 0.030, PAL.hazardRim, 0.26 * bell, 16);
    }
    // manubrium: the stomach hanging under the bell
    const mp = this._p3(4);
    for (let s = 0; s < 4; s++) {
      const f = s / 3;
      mp[s * 2] = cx + Math.sin(t * 1.3 + h.bellPhase) * w * 0.10 * f;
      mp[s * 2 + 1] = cy - hh * 0.20 + f * hh * 1.05;
    }
    this.rGlow.stroke(mp, {
      width: (f) => lerp(w * 0.30, w * 0.10, f), color: PAL.hazardRim,
      alpha: (f) => 0.30 * bell * (1 - f * 0.6), falloff: 4,
    });

    // Membrane rim: crisp, brightest over the shoulders where light grazes.
    this.rGlow.stroke(out, { width: w * 0.44, color: PAL.hazard, alpha: 0.18 * bell, falloff: 2.2 });
    this.rGlow.stroke(out, {
      width: (f) => lerp(w * 0.105, w * 0.055, Math.abs(f * 2 - 1)), color: PAL.hazardRim,
      alpha: (f) => (0.26 + 0.58 * Math.pow(Math.sin(f * Math.PI), 0.7)) * bell * hotb, falloff: 10,
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
        width: (f) => lerp(r * 0.30, r * 0.05, Math.pow(f, 0.7)), color: PAL.hazardDark,
        alpha: (f) => 0.52 * (1 - f * 0.8), falloff: 1.3,
      });
      this.rGlow.stroke(tp, {
        width: (f) => lerp(r * 0.26, r * 0.04, Math.pow(f, 0.7)), color: PAL.hazard,
        alpha: (f) => 0.24 * (1 - f * 0.65) * bell, falloff: 2.6,
      });
      this.rGlow.stroke(tp, {
        width: (f) => lerp(r * 0.055, r * 0.012, f), color: PAL.hazardRim,
        alpha: (f) => 0.44 * Math.pow(1 - f, 1.3) * bell * hotb, falloff: 15,
      });
    }

    const nT = 9;
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
        width: (f) => lerp(r * 0.105, r * 0.006, Math.pow(f, 0.55)), color: PAL.hazard,
        alpha: (f) => 0.46 * Math.pow(1 - f, 0.85) * bell, falloff: 7,
      });
      this.rGlow.stroke(tp, {
        width: (f) => lerp(r * 0.048, 0.6, f), color: PAL.hazardRim,
        alpha: (f) => 0.60 * Math.pow(clamp01(1 - f * 2.3), 1.4) * bell * hotb, falloff: 17,
      });
    }

    // Danger telegraph: very low, very wide. Reads at distance without glowing.
    this.glow.push(cx, cy, w * 8.5, hh * 7.0, 0,
      PAL.hazard[0] * 0.045, PAL.hazard[1] * 0.045, PAL.hazard[2] * 0.045, 1, S.GLOW);
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
    const live = isHeld ? 1 : (0.24 + 0.54 * smoothstep(near)) * (1 - spent * 0.34);
    const pulse = 0.74 + 0.26 * Math.sin(t * a.pulse * (isHeld ? 3.6 : 1.5) + a.phase);
    const k = pulse * (0.42 + live * 1.06) * lerp(1, dim, 0.45);

    // Strain: a loaded bulb is dragged toward the mote and its stalk goes taut.
    const strain = isHeld ? clamp01(0.40 + player.tetherGlow * 0.60) : 0;
    const pull = r * (0.28 + 0.26 * clamp01(player.speedSmooth / 2000)) * strain;
    const sway = Math.sin(t * a.sway * 0.9 + a.phase) * (a.stalk * 0.055) * (1 - strain * 0.85);
    const bx = a.x + sway + pdx * pull, by = a.y + pdy * pull;
    a.visX = bx; a.visY = by;
    const topY = a.y - a.stalk;

    // ---- stalk ----
    const n = 11, sp = this._p1(n);
    const tipY = by - r * 0.78;
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      const e = f * f * (3 - 2 * f);            // keep the root vertical at the roof
      sp[s * 2] = lerp(a.x, bx, e) + Math.sin(f * Math.PI) * sway * 0.5 * (1 - strain);
      sp[s * 2 + 1] = lerp(topY, tipY, f);
    }
    this.rDark.stroke(sp, {
      width: (f) => lerp(r * 0.30, r * 0.54, Math.pow(f, 1.6)) * (1 - strain * 0.20),
      color: PAL.voidDeep, alpha: 0.94, falloff: 1.05,
    });
    // The stalk conducts: a warm filament inside it, loaded when tethered.
    this.rGlow.stroke(sp, {
      width: (f) => lerp(r * 0.05, r * 0.17, f), color: isHeld ? PAL.anchorCore : PAL.anchorMid,
      alpha: (f) => (isHeld ? 0.80 : 0.16 + 0.34 * live) * Math.pow(f, 1.5) * pulse, falloff: 13,
    });
    const so = this._p2(n);
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      so[s * 2] = sp[s * 2] - lerp(r * 0.13, r * 0.24, f);
      so[s * 2 + 1] = sp[s * 2 + 1];
    }
    this.rGlow.stroke(so, {
      width: r * 0.075, color: PAL.anchorRim,
      alpha: (f) => (0.07 + 0.26 * live) * (0.4 + 0.6 * f), falloff: 12,
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
      this.glow.puts(nx, ny, nr * 5.0, scaled(PAL.anchorRim, k * np * 0.14, c0), 1, S.GLOW);
      this.glow.puts(nx, ny, nr * 1.3, scaled(PAL.anchorMid, k * np * 0.55, c0), 1, S.CORE);
    }

    // ---- bulb: a teardrop, from a profiled stroke over its vertical axis ----
    const axTop = by - r * 1.14, axBot = by + r * 1.30;
    const prof = (f) => Math.pow(Math.sin(Math.PI * (0.17 + 0.79 * f)), 0.60);
    const bw = (f) => r * 2.16 * prof(f);
    const stx = (f) => pdx * (f - 0.35) * 0.50 * strain * r;
    const sty = (f) => pdy * (f - 0.35) * 0.30 * strain * r;
    const nb = 13, bp = this._p3(nb);
    for (let s = 0; s < nb; s++) {
      const f = s / (nb - 1);
      bp[s * 2] = bx + stx(f);
      bp[s * 2 + 1] = lerp(axTop, axBot, f) + sty(f);
    }
    // alpha < 1 on purpose: the membrane is thick, not opaque.
    this.rDark.stroke(bp, { width: bw, color: PAL.voidDeep, alpha: 0.90, falloff: 0.95 });

    // Sub-surface scatter: warm light escaping a thick translucent body.
    this.glow.push(bx, by, r * (isHeld ? 16 : 11), r * (isHeld ? 14 : 9.6), 0,
      PAL.anchorRim[0] * k * (isHeld ? 0.30 : 0.16), PAL.anchorRim[1] * k * (isHeld ? 0.30 : 0.16),
      PAL.anchorRim[2] * k * (isHeld ? 0.30 : 0.16), 1, S.GLOW);
    this.glow.push(bx, by + r * 0.16, r * 4.8, r * 5.1, 0,
      PAL.anchorMid[0] * k * 0.44, PAL.anchorMid[1] * k * 0.44, PAL.anchorMid[2] * k * 0.44, 1, S.GLOW);
    this.glow.push(bx, by + r * 0.26, r * 2.05, r * 2.35, 0,
      PAL.anchorLive[0] * k * 0.72, PAL.anchorLive[1] * k * 0.72, PAL.anchorLive[2] * k * 0.72, 1, S.GLOW);

    // Rim that catches the bulb's own light, on the left edge only.
    const nr2 = 15, rimL = this._p1(nr2);
    for (let s = 0; s < nr2; s++) {
      const f = s / (nr2 - 1);
      rimL[s * 2] = bx + stx(f) - bw(f) * 0.47;
      rimL[s * 2 + 1] = lerp(axTop, axBot, f) + sty(f);
    }
    this.rGlow.stroke(rimL, {
      width: r * 0.10, color: PAL.anchorCore,
      alpha: (f) => Math.pow(Math.sin(f * Math.PI), 0.85) * (0.26 + 0.58 * live) * pulse, falloff: 15,
    });
    for (let s = 0; s < nr2; s++) rimL[s * 2] += bw(s / (nr2 - 1)) * 0.94;
    this.rGlow.stroke(rimL, {
      width: r * 0.085, color: PAL.anchorRim,
      alpha: (f) => Math.pow(Math.sin(f * Math.PI), 1.1) * (0.10 + 0.24 * live) * pulse, falloff: 13,
    });

    // Filament: the one detail that makes the bulb an organism, not a lamp.
    const fp = this._p2(11);
    const fw = isHeld ? 6.6 : 1.45;
    for (let s = 0; s < 11; s++) {
      const f = s / 10;
      const amp = bw(lerp(0.12, 0.90, f)) * 0.29 * Math.sin(Math.PI * f);
      fp[s * 2] = bx + stx(f) + Math.sin(f * 5.6 + t * fw + a.phase * 1.7) * amp
        + Math.sin(f * 11.3 + t * fw * 1.6 + a.phase) * amp * 0.30;
      fp[s * 2 + 1] = lerp(axTop + r * 0.22, axBot - r * 0.24, f) + sty(f);
    }
    this.rGlow.stroke(fp, { width: r * 0.34, color: PAL.anchorMid, alpha: 0.18 * live * pulse, falloff: 2.0 });
    this.rGlow.stroke(fp, {
      width: (f) => lerp(r * 0.105, r * 0.042, f), color: isHeld ? PAL.anchorCore : PAL.anchorLive,
      alpha: (f) => (0.40 + 0.56 * live) * pulse * Math.pow(Math.sin(f * Math.PI), 0.32) * (1 - spent * 0.28),
      falloff: 20,
    });

    // Seeds suspended in the jelly, each on its own clock.
    const nseed = a.big ? 8 : 5;
    for (let q = 0; q < nseed; q++) {
      const u = hash2(sid, q * 13 + 7) * 2 - 1;
      const ff = 0.16 + hash2(sid, q * 17 + 3) * 0.72;
      const px = bx + stx(ff) + u * bw(ff) * 0.33;
      const py = lerp(axTop, axBot, ff) + sty(ff);
      const sk = 0.32 + 0.68 * Math.sin(t * (1.3 + hash2(sid, q * 7 + 1) * 2.0) + q * 2.4 + a.phase);
      const kk = k * (0.45 + sk * 0.85);
      this.glow.puts(px, py, r * 1.9, scaled(PAL.anchorMid, kk * 0.20, c0), 1, S.GLOW);
      this.glow.puts(px, py, r * 0.52, scaled(PAL.anchorCore, kk * 0.80, c0), 1, S.CORE);
    }

    // Tendrils: secondary motion, and the reason it reads as alive.
    const nt = a.big ? 9 : 6;
    for (let q = 0; q < nt; q++) {
      const hq = hash2(sid, q * 11 + 5);
      const u = nt === 1 ? 0 : (q / (nt - 1)) * 2 - 1;
      const ox = bx + u * r * 0.78 + stx(1);
      const oy = by + r * 1.04 + sty(1);
      const L = r * (1.7 + hq * 2.4) * (isHeld ? 1.22 : 1);
      const nq = 7, tp = this._p3(nq);
      for (let s = 0; s < nq; s++) {
        const f = s / (nq - 1);
        const drift = Math.sin(t * (0.7 + hq * 0.8) - f * 2.3 + q * 1.9 + a.phase) * r * (0.34 + hq * 0.30) * f;
        tp[s * 2] = ox + drift + u * r * 0.5 * f * f + pdx * strain * r * 0.7 * f * f;
        tp[s * 2 + 1] = oy + f * L + pdy * strain * r * 0.7 * f * f;
      }
      this.rDark.stroke(tp, {
        width: (f) => lerp(r * 0.15, 0, Math.pow(f, 0.4)), color: PAL.voidDeep,
        alpha: (f) => 0.70 * (1 - f), falloff: 1.2,
      });
      this.rGlow.stroke(tp, {
        width: (f) => lerp(r * 0.10, r * 0.010, Math.pow(f, 0.6)), color: PAL.anchorMid,
        alpha: (f) => (0.26 + 0.44 * live) * pulse * Math.pow(1 - f, 0.75), falloff: 9,
      });
      if (hq > 0.42) {
        const fj = 0.62;
        const si = Math.min(nq - 2, (fj * (nq - 1)) | 0), lf = fj * (nq - 1) - si;
        const nx = lerp(tp[si * 2], tp[si * 2 + 2], lf);
        const ny = lerp(tp[si * 2 + 1], tp[si * 2 + 3], lf);
        const np = 0.35 + 0.65 * Math.sin(t * (1.9 + hq) + q * 2.7 + a.phase);
        this.glow.puts(nx, ny, r * 1.1, scaled(PAL.anchorLive, k * np * 0.45, c0), 1, S.GLOW);
        this.glow.puts(nx, ny, r * 0.30, scaled(PAL.anchorCore, k * np * 0.9, c0), 1, S.CORE);
      }
    }

    if (isHeld) {
      // Strain veins from the core out to where the tether leaves the membrane.
      const pa = Math.atan2(pdy, pdx);
      const ex = bx + pdx * r * 1.02, ey = by + pdy * r * 1.02;
      for (let q = 0; q < 3; q++) {
        const av = pa + (q - 1) * 0.36;
        this.rGlow.segment(bx + stx(0.5), by, bx + Math.cos(av) * r * 0.95, by + Math.sin(av) * r * 0.95,
          r * 0.085, PAL.anchorCore, 0.50 * pulse, 17);
      }
      // The membrane flares where the line is pulling on it.
      this.glow.puts(ex, ey, r * 2.6, scaled(PAL.anchorCore, 0.95 * pulse, c0), 1, S.GLOW);
      this.glow.puts(ex, ey, r * 0.62, scaled(PAL.moteCore, 1.35 * pulse, c0), 1, S.CORE);
      // One dim anamorphic bar. Not a star: a star is a lens artefact, and this
      // is an object.
      this.glow.push(bx, by, r * 13, r * 0.80, 0,
        PAL.anchorMid[0] * 0.42 * pulse, PAL.anchorMid[1] * 0.42 * pulse, PAL.anchorMid[2] * 0.42 * pulse,
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
      // World gen lays these on an even arc. Break the string up at draw time -
      // well inside the magnet radius, so it costs nothing in feel.
      const sid = (p.phase * 4096) | 0;
      const orb = t * (0.35 + hash2(sid, 3) * 0.55) + p.phase;
      const x = p.x + (hash2(sid, 1) - 0.5) * 30 + Math.cos(orb) * 9;
      const y = p.y + (hash2(sid, 2) - 0.5) * 26 + Math.sin(t * p.bob + p.phase) * 11
        + Math.sin(orb * 0.7) * 6;
      const sz = p.r * (0.70 + hash2(sid, 4) * 0.66);
      const k = (0.52 + 0.48 * Math.sin(t * (1.8 + hash2(sid, 5) * 1.5) + p.phase * 1.7)) * dim;
      mixCol(PAL.plankton, PAL.moteInner, hash2(sid, 6) * 0.38, c0);
      this.glow.puts(x, y, sz * 6.2, scaled(c0, k * 0.20, c1), 1, S.GLOW);
      this.glow.puts(x, y, sz * 2.1, scaled(c0, k * 0.82, c1), 1, S.PLANKTON, orb * 0.6);
      this.glow.puts(x, y, sz * 0.52, scaled(PAL.planktonCore, k * 1.7, c1), 1, S.CORE);
      if (hash2(sid, 7) > 0.80) this.glow.puts(x, y, sz * 1.35, scaled(c0, k * 0.26, c1), 1, S.BOKEH, orb);
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
    // Body behind the front, then a hard bright leading filament.
    this.rGlow.stroke(pts, { width: 120, color: PAL.hushGlow, alpha: 0.42, falloff: 1.1 });
    this.rGlow.stroke(pts, { width: 34, color: PAL.hushEdge, alpha: 0.52, falloff: 3.4 });
    this.rGlow.stroke(pts, {
      width: 4.5, color: [1, 0.94, 1],
      alpha: (f) => 0.42 + 0.38 * noise1(f * 21 + t * 3.3), falloff: 24,
    });
    // Tearing: short filaments dragged off the front into the dark.
    for (let s = 1; s < n - 1; s += 2) {
      const yy = pts[s * 2 + 1];
      const flick = noise1(yy * 0.02 + t * 4.1);
      const len = 24 + flick * 130;
      this.rGlow.segment(pts[s * 2], yy, pts[s * 2] - len, yy + (flick - 0.5) * 60,
        6 + flick * 8, PAL.hushEdge, 0.20 + 0.24 * flick, 5);
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
    for (let s = 0; s < n; s++) {
      const i = off + s * 2;
      const age = 1 - s / (n - 1);
      let dx, dy;
      if (s === 0) { dx = src[i + 2] - src[i]; dy = src[i + 3] - src[i + 1]; }
      else { dx = src[i] - src[i - 2]; dy = src[i + 1] - src[i - 1]; }
      const dl = Math.hypot(dx, dy) || 1;
      const w = (noise1(s * 0.62 + t * 1.6) - 0.5) * age * age * (24 + sk * 36);
      pts[s * 2] = src[i] - (dy / dl) * w;
      pts[s * 2 + 1] = src[i + 1] + (dx / dl) * w;
    }

    // Three passes whose alpha ramps localise a colour to a stretch of the
    // trail: cold and diffuse at the tail, hot and tight at the head.
    this.rGlow.stroke(pts, {
      width: (f) => lerp(2, 32 + sk * 30, Math.pow(f, 1.5)), color: PAL.waterHigh,
      alpha: (f) => (0.30 + sk * 0.34) * Math.pow(f, 0.9) * Math.pow(1 - f, 0.35), falloff: 1.6,
    });
    this.rGlow.stroke(pts, {
      width: (f) => lerp(1.6, 15 + sk * 16, Math.pow(f, 1.7)), color: PAL.moteTrail,
      alpha: (f) => (0.28 + sk * 0.44) * Math.pow(Math.sin(f * Math.PI * 0.92), 1.1), falloff: 4.5,
    });
    this.rGlow.stroke(pts, {
      width: (f) => lerp(0.9, 6.5 + sk * 6, Math.pow(f, 2.2)), color: PAL.moteInner,
      alpha: (f) => (0.34 + sk * 0.56) * Math.pow(f, 3.6), falloff: 15,
    });

    // Shed grain: keeps it from reading as a clean vector ribbon.
    for (let s = n - 3; s >= 2; s -= 3) {
      const f = s / (n - 1);
      const hg = hash2((s * 7) | 0, (t * 3) | 0);
      const kk = f * f * (0.22 + sk * 0.34);
      this.glow.puts(pts[s * 2], pts[s * 2 + 1], 5 + hg * 16 + sk * 10,
        scaled(PAL.moteOuter, kk, c0), 1, S.GLOW);
    }
  }

  // ----------------------------------------------------------------- tether ---
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
    const slack = clamp(1 - player.spin * player.spin * 0.35, 0.25, 1);
    const n = 18, pts = this._p1(n);
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      const env = Math.sin(f * Math.PI);
      const wob = (Math.sin(f * 11 - t * 21) * 4.2 + Math.sin(f * 23 - t * 34) * 1.5) * env * slack;
      pts[s * 2] = ax + dx * f + px * wob;
      pts[s * 2 + 1] = ay + dy * f + py * wob;
    }
    // Warm at the bulb, cool at the mote: light is being drawn out and changed.
    this.rGlow.stroke(pts, { width: (f) => lerp(24, 9, f), color: PAL.anchorMid, alpha: (f) => 0.22 * g * (1 - f * 0.7), falloff: 1.9 });
    this.rGlow.stroke(pts, { width: (f) => lerp(7.5, 4.2, f), color: PAL.anchorCore, alpha: (f) => 0.72 * g * (1 - f * 0.55), falloff: 7 });
    this.rGlow.stroke(pts, { width: (f) => lerp(4.4, 8.5, f), color: PAL.moteInner, alpha: (f) => 0.50 * g * Math.pow(f, 1.9), falloff: 6 });
    this.rGlow.stroke(pts, {
      width: 1.7, color: PAL.moteCore,
      alpha: (f) => 0.80 * g * (0.5 + 0.5 * noise1(f * 8 + t * 9)), falloff: 26,
    });
    // Energy running down the line, unevenly spaced so it is not a metronome.
    for (let q = 0; q < 3; q++) {
      const bt = (t * (1.35 + q * 0.44) + q * 0.37) % 1;
      const e = Math.sin(bt * Math.PI);
      const wob = Math.sin(bt * 11 - t * 21) * 4.2 * e * slack;
      const bx = ax + dx * bt + px * wob, by = ay + dy * bt + py * wob;
      const kb = g * e * (0.72 - q * 0.17);
      this.glow.puts(bx, by, 36, scaled(PAL.anchorCore, kb * 0.50, c0), 1, S.GLOW);
      this.glow.puts(bx, by, 7.5, scaled(PAL.moteCore, kb * 1.5, c0), 1, S.CORE);
    }
  }

  // ------------------------------------------------------------------- mote ---
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
    const ca = Math.cos(ang), sa = Math.sin(ang);
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
        const kk = f * f * sk * 0.60 * boost;
        this.glow.push(sx, sy, R * 7.0 * f * el, R * 2.3 * f * th, a2,
          PAL.moteOuter[0] * kk, PAL.moteOuter[1] * kk, PAL.moteOuter[2] * kk, 1, S.STREAK);
      }
    }

    // 2. corona: a wide veil broken out of a perfect disc by drifting lobes.
    this.glow.push(p.x, p.y, R * 21 * (1 + sk * 0.55), R * 18 * th, ang,
      PAL.moteOuter[0] * 0.16 * boost, PAL.moteOuter[1] * 0.16 * boost, PAL.moteOuter[2] * 0.16 * boost,
      1, S.GLOW);
    for (let q = 0; q < 4; q++) {
      const a2 = q * 1.5708 + t * 0.32 + noise1(t * 0.6 + q * 7.3) * 2.4;
      const d2 = R * (2.0 + noise1(t * 0.45 + q * 3.1) * 2.6);
      const sz = R * (4.6 + noise1(t * 0.5 + q * 11.7) * 3.8);
      this.glow.puts(p.x + Math.cos(a2) * d2, p.y + Math.sin(a2) * d2, sz,
        scaled(PAL.moteOuter, 0.15 * boost, c0), 1, S.GLOW);
    }
    this.glow.push(p.x, p.y, R * 8.2 * Math.pow(el, 0.6), R * 7.4 * th, ang,
      PAL.moteOuter[0] * 0.52 * boost, PAL.moteOuter[1] * 0.52 * boost, PAL.moteOuter[2] * 0.52 * boost,
      1, S.GLOW);
    this.glow.push(p.x, p.y, R * 3.5 * Math.pow(el, 0.5), R * 2.9 * th, ang,
      PAL.moteInner[0] * 1.05 * boost, PAL.moteInner[1] * 1.05 * boost, PAL.moteInner[2] * 1.05 * boost,
      1, S.GLOW);

    // 3. caustic ring: the mote's light bent back through the water it displaces.
    // Two radii in two tints reads as dispersion; brightest dead ahead.
    const cr = R * (3.2 + Math.sin(t * 2.3) * 0.14) * (1 + sk * 0.42);
    for (let pass = 0; pass < 3; pass++) {
      const rk = pass === 0 ? 0.90 : pass === 1 ? 1.0 : 1.12;
      const col = pass === 0 ? PAL.anchorCore : pass === 1 ? PAL.moteCore : PAL.moteOuter;
      const amp = pass === 1 ? 0.68 : 0.26;
      const nc = 22, cp = this._p1(nc);
      for (let s = 0; s < nc; s++) {
        const f = s / (nc - 1);
        const a2 = (f * 2 - 1) * 2.65;
        const rr = cr * rk * (1 + 0.06 * Math.sin(f * 7.3 + t * 1.9));
        const lx = Math.cos(a2) * rr * (1 + sk * 0.55), ly = Math.sin(a2) * rr * (1 - sk * 0.28);
        cp[s * 2] = p.x + lx * ca - ly * sa;
        cp[s * 2 + 1] = p.y + lx * sa + ly * ca;
      }
      this.rGlow.stroke(cp, {
        width: pass === 1 ? 2.4 : 3.6, color: col,
        alpha: (f) => Math.pow(Math.sin(f * Math.PI), 1.25) * amp * (0.55 + 0.45 * boost), falloff: pass === 1 ? 22 : 9,
      });
    }

    // 4. core: an anisotropic body with the dense point pushed forward, which is
    // what makes the direction of travel readable at a glance.
    this.glow.push(p.x, p.y, R * 1.75 * Math.pow(el, 0.35), R * 1.45 * th, ang,
      PAL.moteInner[0] * 1.9 * boost, PAL.moteInner[1] * 1.9 * boost, PAL.moteInner[2] * 1.9 * boost,
      1, S.CORE);
    const nx = p.x + dx * R * 0.34 * el, ny = p.y + dy * R * 0.34 * el;
    this.glow.push(nx, ny, R * 0.80, R * 0.66, ang,
      PAL.moteCore[0] * 3.2 * boost, PAL.moteCore[1] * 3.2 * boost, PAL.moteCore[2] * 3.2 * boost,
      1, S.CORE);
    this.glow.push(p.x - dx * R * 0.7 * el, p.y - dy * R * 0.7 * el, R * 0.9, R * 0.55, ang,
      PAL.moteInner[0] * 0.9 * boost, PAL.moteInner[1] * 0.9 * boost, PAL.moteInner[2] * 0.9 * boost,
      1, S.CORE);

    // 5. anamorphic bleed, screen-horizontal. A real lens smears one axis; the
    // old symmetric star was the giveaway that this was a sprite.
    const fl = 0.16 + lg * 1.05 + sk * 0.26;
    const rot = -(cam.rot || 0);
    this.glow.push(p.x, p.y, R * (22 + lg * 62 + sk * 16), R * 1.05, rot,
      PAL.moteOuter[0] * fl * 0.40, PAL.moteOuter[1] * fl * 0.46, PAL.moteOuter[2] * fl * 0.62, 1, S.STREAK);
    this.glow.push(p.x, p.y, R * (9 + lg * 26), R * 0.34, rot,
      PAL.moteCore[0] * fl * 0.85, PAL.moteCore[1] * fl * 0.85, PAL.moteCore[2] * fl * 0.85, 1, S.STREAK);

    // 6. the Hush breathing on your neck: a violet counter-rim, no HUD needed.
    const hp = g.hushProx || 0;
    if (hp > 0.02) {
      this.glow.push(p.x - R * 1.1, p.y, R * 5.5, R * 6.5, 0,
        PAL.hushEdge[0] * hp * 0.55, PAL.hushEdge[1] * hp * 0.55, PAL.hushEdge[2] * hp * 0.55, 1, S.GLOW);
    }

    // 7. shockwaves. Not donuts: a thin front with a hot leading edge, a wake
    // behind it, and no back half at all.
    if (lg > 0.02) this._shock(p.x, p.y, ang, lg, R * 2.2, R * 26, PAL.moteOuter, PAL.moteCore, 2.35, 3.7);
    if (bg > 0.02) this._shock(p.x, p.y, ang + 2.6, bg, R * 3.0, R * 17, PAL.hazard, PAL.hazardRim, 1.95, 11.3);
  }

  /**
   * Expanding shock front. `k` runs 1 (born) -> 0 (spent); `ang` points along
   * travel, `spread` is the arc half-angle.
   */
  _shock(cx, cy, ang, k, r0, r1, col, hot, spread, seed) {
    const p = 1 - clamp01(k);
    const rad = r0 + (r1 - r0) * Math.pow(p, 0.55);
    const fade = Math.pow(clamp01(k), 0.70);
    const n = 26;
    const front = this._p2(n), wake = this._p3(n);
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      const a = ang + (f * 2 - 1) * spread;
      // A real front is not a circle.
      const wob = 1 + 0.11 * (noise1(f * 5.5 + seed) - 0.5) * 2 + 0.045 * Math.sin(f * 9 + seed);
      const cs = Math.cos(a), sn = Math.sin(a);
      front[s * 2] = cx + cs * rad * wob;
      front[s * 2 + 1] = cy + sn * rad * wob;
      wake[s * 2] = cx + cs * rad * wob * 0.84;
      wake[s * 2 + 1] = cy + sn * rad * wob * 0.84;
    }
    const lead = (f) => Math.pow(Math.sin(clamp01(f) * Math.PI), 1.35);
    this.rGlow.stroke(wake, {
      width: rad * 0.30 * (0.35 + p), color: col,
      alpha: (f) => lead(f) * 0.085 * fade, falloff: 1.2,
    });
    this.rGlow.stroke(front, {
      width: lerp(rad * 0.060, rad * 0.014, p) + 1.5, color: col,
      alpha: (f) => lead(f) * 0.58 * fade, falloff: 5,
    });
    this.rGlow.stroke(front, {
      width: lerp(4.5, 1.7, p), color: hot,
      alpha: (f) => lead(f) * 0.85 * fade, falloff: 22,
    });
    // Radial filaments streaming out behind the front.
    for (let q = 0; q < 3; q++) {
      const a = ang + (q - 1) * spread * 0.55;
      const cs = Math.cos(a), sn = Math.sin(a);
      this.rGlow.segment(cx + cs * rad * 0.55, cy + sn * rad * 0.55, cx + cs * rad, cy + sn * rad,
        3.2, hot, 0.26 * fade * (1 - p * 0.55), 16);
    }
  }
}

// Scene assembly. Draw order *is* the art direction, so it is explicit here
// rather than hidden behind a generic sorting layer.
//
// Passes, back to front:
//   background shader -> far occluders -> kelp -> anemones -> hazards
//   -> anchors -> plankton -> trail -> tether -> mote -> particles -> ambient
import { Blend } from '../engine/gl.js';
import { SpriteBatch } from '../engine/sprites.js';
import { Ribbons } from '../engine/ribbons.js';
import { S } from '../engine/textures.js';
import { PAL, depthFade, scaled } from '../art/palette.js';
import { KIND } from './world.js';
import { clamp, clamp01, lerp, smoothstep, TAU } from '../engine/math.js';
import { noise1 } from '../engine/rng.js';

const tmp = [0, 0, 0], tmp2 = [0, 0, 0];

export class Scene {
  constructor(gl, tex) {
    this.gl = gl;
    this.occl = new SpriteBatch(gl, tex.sprites, 2048);
    this.glow = new SpriteBatch(gl, tex.sprites, 8192);
    this.rDark = new Ribbons(gl, 32768);
    this.rGlow = new Ribbons(gl, 32768);
    this._pts = new Float32Array(64);
  }

  /** @param g the frameCtx from main.js - see Game.frameCtx() */
  draw(g) {
    const gl = this.gl;
    const { world, player, cam, t } = g;
    const b = cam.bounds(420);

    this._decor(world, cam, b, t);
    this._hazards(world, b, t);
    this._anchors(world, player, b, t);
    this._plankton(world, b, t);

    // --- flush: dark silhouettes first (they occlude), then all the light ---
    Blend.premul(gl);
    this.rDark.flush(cam);
    this.occl.flush(cam);

    Blend.add(gl);
    this.rGlow.flush(cam);

    // light-emitting gameplay layer goes into the additive batch
    this._hushEdge(world, cam, b, t);
    this._trail(player, cam, t);
    this._tether(player, t);
    this._mote(player, t, g.slow);
    g.particles.draw(this.glow);
    g.ambient.draw(this.glow, cam, t);
    this.glow.flush(cam);

    // second ribbon flush for trail/tether which were queued after rGlow
    this.rGlow.flush(cam);
    Blend.none(gl);
  }

  // ------------------------------------------------------------------ decor ---
  _decor(world, cam, b, t) {
    const list = world.decor;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (d.x < b.x0 - 400) continue;
      if (d.x > b.x1 + 400) break;

      if (d.kind === KIND.KELP) {
        const segs = d.segs, n = segs + 1;
        if (this._pts.length < n * 2) this._pts = new Float32Array(n * 2);
        const pts = this._pts.subarray(0, n * 2);
        const sway = Math.sin(t * d.sway + d.phase);
        for (let s = 0; s < n; s++) {
          const f = s / segs;
          const bend = (f * f) * (d.lean * 220 + sway * 150 * f);
          pts[s * 2] = d.x + bend;
          pts[s * 2 + 1] = d.y - d.h * f;
        }
        depthFade(PAL.voidDeep, d.depth * 0.6, tmp);
        this.rDark.stroke(pts, {
          width: (f) => lerp(d.w * 1.5, d.w * 0.35, f),
          color: tmp, alpha: (f) => lerp(0.92, 0.44, f), falloff: 2.2,
        });
        if (d.glow > 0) {
          depthFade(PAL.plankton, d.depth, tmp2);
          this.rGlow.stroke(pts, {
            width: (f) => lerp(d.w * 0.5, d.w * 2.4, f * f),
            color: tmp2, alpha: (f) => d.glow * 0.5 * Math.pow(f, 2.2), falloff: 3.0,
          });
          const tipX = pts[(n - 1) * 2], tipY = pts[(n - 1) * 2 + 1];
          const pulse = 0.6 + 0.4 * Math.sin(t * 1.7 + d.phase * 2.1);
          const k = d.glow * pulse * 1.5 * (1 - d.depth * 0.7);
          this.glow.puts(tipX, tipY, d.w * 9, scaled(PAL.plankton, k, tmp2), 1, S.GLOW);
          this.glow.puts(tipX, tipY, d.w * 2.6, scaled(PAL.planktonCore, k * 1.4, tmp2), 1, S.CORE);
        }
      } else if (d.kind === KIND.SPIRE) {
        const n = 7;
        if (this._pts.length < n * 2) this._pts = new Float32Array(n * 2);
        const pts = this._pts.subarray(0, n * 2);
        const dir = d.up ? -1 : 1;
        for (let s = 0; s < n; s++) {
          const f = s / (n - 1);
          pts[s * 2] = d.x + f * f * d.lean * 180;
          pts[s * 2 + 1] = d.y + dir * d.h * f;
        }
        depthFade(PAL.voidDeep, d.depth * 0.35, tmp);
        this.rDark.stroke(pts, {
          width: (f) => lerp(d.w, d.w * 0.08, Math.pow(f, 0.72)),
          color: tmp, alpha: 0.97, falloff: 1.35,
        });
        // rim: the surface glow catching one edge
        depthFade(PAL.waterHigh, d.depth * 0.8 + 0.15, tmp2);
        for (let s = 0; s < n; s++) pts[s * 2] -= lerp(d.w * 0.36, d.w * 0.03, s / (n - 1));
        this.rGlow.stroke(pts, {
          width: (f) => lerp(d.w * 0.16, d.w * 0.03, f), color: tmp2,
          alpha: (f) => 0.5 * (1 - f * 0.6), falloff: 7,
        });
      } else if (d.kind === KIND.ANEMONE) {
        const warm = d.hue === 0;
        const base = warm ? PAL.anchorMid : PAL.plankton;
        const pulse = 0.55 + 0.45 * Math.sin(t * 1.15 + d.phase);
        const k = (0.5 + pulse * 0.7) * (1 - d.depth * 0.75);
        const arms = 9;
        for (let a = 0; a < arms; a++) {
          const ang = (a / arms) * Math.PI + (d.up ? Math.PI : 0) + Math.sin(t * 0.7 + a) * 0.08;
          const L = d.r * (1.6 + 0.5 * Math.sin(t * 1.3 + a * 1.7 + d.phase));
          const ex = d.x + Math.cos(ang) * L, ey = d.y + Math.sin(ang) * L;
          this.rGlow.segment(d.x, d.y, ex, ey, d.r * 0.16, scaled(base, k * 0.55, tmp2), 1, 5);
        }
        this.glow.puts(d.x, d.y, d.r * 7, scaled(base, k * 0.42, tmp), 1, S.GLOW);
        this.glow.puts(d.x, d.y, d.r * 1.5, scaled(base, k * 1.1, tmp), 1, S.CORE);
      }
    }
  }

  // ---------------------------------------------------------------- hazards ---
  _hazards(world, b, t) {
    const list = world.hazards;
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      if (!h.alive) continue;
      if (h.x < b.x0 - 300) continue;
      if (h.x > b.x1 + 300) break;

      if (h.kind === KIND.URCHIN) {
        const spin = t * h.spin + h.phase;
        const d = h.r * 2;
        // dense body: an occluder, so it eats the background instead of glowing
        this.occl.push(h.x, h.y, d * 1.02, d * 1.02, spin,
          PAL.hazardDark[0] * 0.5, PAL.hazardDark[1] * 0.5, PAL.hazardDark[2] * 0.5, 0.97, S.THORN);
        // hot rim + slow menace pulse
        const p = 0.62 + 0.38 * Math.sin(t * 1.35 + h.phase);
        this.glow.push(h.x, h.y, d, d, spin,
          PAL.hazard[0] * p * 0.95, PAL.hazard[1] * p * 0.95, PAL.hazard[2] * p * 0.95, 1, S.THORN);
        this.glow.puts(h.x, h.y, h.r * 3.1, scaled(PAL.hazard, 0.20 * p, tmp), 1, S.GLOW);
        this.glow.puts(h.x, h.y, h.r * 0.5, scaled(PAL.hazardRim, 1.5 * p, tmp), 1, S.CORE);
      } else if (h.kind === KIND.JELLY) {
        const bell = 0.85 + 0.15 * Math.sin(t * 1.6 + h.bellPhase);
        const w = h.r * 2.2 * bell, hh = h.r * 1.9 / bell;
        // tentacles trail the bell's motion
        const drift = Math.cos(t * h.freq * TAU + h.phase) * h.amp * h.freq * TAU;
        const nT = 7;
        for (let k = 0; k < nT; k++) {
          const off = (k / (nT - 1) - 0.5) * h.r * 1.5;
          const n = 6;
          if (this._pts.length < n * 2) this._pts = new Float32Array(n * 2);
          const pts = this._pts.subarray(0, n * 2);
          for (let s = 0; s < n; s++) {
            const f = s / (n - 1);
            const wob = Math.sin(t * 2.1 + k * 1.3 + f * 3.4) * h.r * 0.30 * f;
            pts[s * 2] = h.x + off * (1 - f * 0.5) + wob - drift * 0.10 * f * f;
            pts[s * 2 + 1] = h.y + hh * 0.4 + f * h.r * 3.0;
          }
          this.rGlow.stroke(pts, {
            width: (f) => lerp(h.r * 0.13, h.r * 0.03, f), color: PAL.hazard,
            alpha: (f) => 0.55 * (1 - f) * bell, falloff: 6,
          });
        }
        this.occl.push(h.x, h.y, w * 1.06, hh * 1.06, 0,
          PAL.hazardDark[0], PAL.hazardDark[1], PAL.hazardDark[2], 0.80, S.BLOB);
        this.glow.push(h.x, h.y, w * 1.5, hh * 1.5, 0,
          PAL.hazard[0] * 0.35 * bell, PAL.hazard[1] * 0.35 * bell, PAL.hazard[2] * 0.35 * bell, 1, S.GLOW);
        this.glow.push(h.x, h.y, w, hh, 0,
          PAL.hazard[0] * 0.8 * bell, PAL.hazard[1] * 0.8 * bell, PAL.hazard[2] * 0.8 * bell, 1, S.PETAL);
        this.glow.puts(h.x, h.y - hh * 0.15, h.r * 0.55, scaled(PAL.hazardRim, 1.2 * bell, tmp), 1, S.CORE);
      }
    }
  }

  // ---------------------------------------------------------------- anchors ---
  _anchors(world, player, b, t) {
    const list = world.anchors;
    const held = player.anchor;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive) continue;
      if (a.x < b.x0 - 300) continue;
      if (a.x > b.x1 + 300) break;

      const isHeld = a === held;
      const sway = Math.sin(t * a.sway * 0.9 + a.phase) * (a.stalk * 0.06);
      const bx = a.x + sway, by = a.y;
      const topY = a.y - a.stalk;

      // --- stalk from the roof ---
      const n = 8;
      if (this._pts.length < n * 2) this._pts = new Float32Array(n * 2);
      const pts = this._pts.subarray(0, n * 2);
      for (let s = 0; s < n; s++) {
        const f = s / (n - 1);
        pts[s * 2] = a.x + sway * f * f;
        pts[s * 2 + 1] = topY + a.stalk * f;
      }
      this.rDark.stroke(pts, {
        width: (f) => lerp(a.r * 0.55, a.r * 0.22, f), color: PAL.anchorCold,
        alpha: (f) => lerp(0.86, 0.55, f), falloff: 2.6,
      });
      this.rGlow.stroke(pts, {
        width: (f) => lerp(a.r * 0.10, a.r * 0.34, f * f), color: PAL.anchorMid,
        alpha: (f) => (isHeld ? 0.85 : 0.30) * Math.pow(f, 1.6), falloff: 5,
      });

      // --- bulb ---
      const pulse = 0.72 + 0.28 * Math.sin(t * a.pulse * 1.6 + a.phase);
      const near = 1 - clamp01(Math.hypot(player.x - bx, player.y - by) / 620);
      const live = isHeld ? 1 : 0.30 + 0.55 * near;
      const k = pulse * (0.55 + live * 0.9);

      // petals: gives the bulb an actual silhouette instead of a blur ball
      const petalRot = t * 0.18 + a.phase;
      this.occl.push(bx, by, a.r * 2.7, a.r * 2.7, petalRot,
        PAL.voidDeep[0], PAL.voidDeep[1], PAL.voidDeep[2], 0.55, S.PETAL);
      this.glow.push(bx, by, a.r * 2.9, a.r * 2.9, petalRot,
        PAL.anchorRim[0] * k * 0.42, PAL.anchorRim[1] * k * 0.42, PAL.anchorRim[2] * k * 0.42, 1, S.PETAL);

      this.glow.puts(bx, by, a.r * (isHeld ? 12 : 8.5), scaled(PAL.anchorMid, k * (isHeld ? 0.55 : 0.30), tmp), 1, S.GLOW);
      this.glow.puts(bx, by, a.r * 2.0, scaled(PAL.anchorLive, k * 1.25, tmp), 1, S.GLOW);
      this.glow.puts(bx, by, a.r * 0.78, scaled(PAL.anchorCore, k * 2.1, tmp), 1, S.CORE);
      this.glow.puts(bx, by, a.r * 3.4, scaled(PAL.anchorMid, k * 0.5, tmp), 1, S.HALO);

      if (isHeld) {
        const spin = t * 2.2;
        this.glow.push(bx, by, a.r * 9, a.r * 1.1, spin * 0.12,
          PAL.anchorCore[0] * 0.9, PAL.anchorCore[1] * 0.8, PAL.anchorCore[2] * 0.6, 1, S.STREAK);
        this.glow.puts(bx, by, a.r * 5.2, scaled(PAL.anchorCore, 0.8, tmp), 1, S.STAR, spin);
      }
      a.visX = bx; a.visY = by;
    }
  }

  // -------------------------------------------------------------- plankton ---
  _plankton(world, b, t) {
    const list = world.plankton;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.taken) continue;
      if (p.x < b.x0 - 200) continue;
      if (p.x > b.x1 + 200) break;
      const bob = Math.sin(t * p.bob + p.phase);
      const y = p.y + bob * 9;
      const k = 0.66 + 0.34 * Math.sin(t * 2.3 + p.phase * 1.7);
      this.glow.puts(p.x, y, p.r * 6.4, scaled(PAL.plankton, k * 0.30, tmp), 1, S.GLOW);
      this.glow.puts(p.x, y, p.r * 2.3, scaled(PAL.plankton, k * 0.95, tmp), 1, S.PLANKTON, t * 0.5 + p.phase);
      this.glow.puts(p.x, y, p.r * 0.62, scaled(PAL.planktonCore, k * 2.0, tmp), 1, S.CORE);
    }
  }

  // ------------------------------------------------------------- hush edge ---
  _hushEdge(world, cam, b, t) {
    const x = world.hushX;
    if (x < b.x0 - 300 || x > b.x1 + 300) return;
    const y0 = cam.y - cam.viewH * 0.6, y1 = cam.y + cam.viewH * 0.6;
    const n = 26;
    if (this._pts.length < n * 2) this._pts = new Float32Array(n * 2);
    const pts = this._pts.subarray(0, n * 2);
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      const y = lerp(y0, y1, f);
      pts[s * 2] = x + (noise1(y * 0.004 + t * 0.7) - 0.5) * 90 + Math.sin(y * 0.006 + t * 1.3) * 26;
      pts[s * 2 + 1] = y;
    }
    this.rGlow.stroke(pts, { width: 46, color: PAL.hushEdge, alpha: 0.55, falloff: 3.2 });
    this.rGlow.stroke(pts, { width: 8, color: [1, 0.92, 1], alpha: 0.55, falloff: 9 });
    for (let s = 0; s < n; s += 3) {
      const yy = pts[s * 2 + 1];
      const flick = 0.4 + 0.6 * noise1(yy * 0.02 + t * 4.1);
      this.glow.puts(pts[s * 2], yy, 150, scaled(PAL.hushEdge, 0.28 * flick, tmp), 1, S.GLOW);
    }
  }

  // ------------------------------------------------------------------ mote ---
  _trail(player, cam, t) {
    const pts = player.trailPts;
    if (pts.length < 6) return;
    const speedK = clamp01(player.speedSmooth / 1900);
    this.rGlow.stroke(pts, {
      width: (f) => lerp(3, 20 + speedK * 22, f * f),
      color: PAL.moteTrail,
      alpha: (f) => Math.pow(f, 2.6) * (0.34 + speedK * 0.55),
      falloff: 4.5,
    });
    this.rGlow.stroke(pts, {
      width: (f) => lerp(1.5, 6 + speedK * 6, f * f),
      color: PAL.moteInner,
      alpha: (f) => Math.pow(f, 4.0) * (0.4 + speedK * 0.6),
      falloff: 11,
    });
  }

  _tether(player, t) {
    if (!player.attached && player.tetherGlow < 0.01) return;
    const a = player.anchor;
    if (!a) return;
    const ax = a.visX ?? a.x, ay = a.visY ?? a.y;
    const dx = player.x - ax, dy = player.y - ay;
    const L = Math.hypot(dx, dy) || 1;
    const n = 12;
    if (this._pts.length < n * 2) this._pts = new Float32Array(n * 2);
    const pts = this._pts.subarray(0, n * 2);
    // taut, with a travelling shimmer - not a sagging rope: this is light
    const perpX = -dy / L, perpY = dx / L;
    const slack = clamp(1 - player.spin * player.spin * 0.4, 0.2, 1);
    for (let s = 0; s < n; s++) {
      const f = s / (n - 1);
      const wob = Math.sin(f * 9 - t * 22) * (1 - Math.abs(f * 2 - 1)) * 5 * slack;
      pts[s * 2] = ax + dx * f + perpX * wob;
      pts[s * 2 + 1] = ay + dy * f + perpY * wob;
    }
    const g = player.tetherGlow;
    this.rGlow.stroke(pts, { width: 16, color: PAL.anchorMid, alpha: 0.34 * g, falloff: 2.4 });
    this.rGlow.stroke(pts, { width: 5.5, color: PAL.anchorCore, alpha: 0.85 * g, falloff: 7 });
    this.rGlow.stroke(pts, { width: 1.8, color: [1, 1, 1], alpha: 0.9 * g, falloff: 22 });
    // travelling energy bead
    const bt = (t * 1.7) % 1;
    const bx = ax + dx * bt, by = ay + dy * bt;
    this.glow.puts(bx, by, 42, scaled(PAL.anchorCore, 0.7 * g, tmp), 1, S.GLOW);
    this.glow.puts(bx, by, 10, scaled([1, 1, 1], 1.4 * g, tmp), 1, S.CORE);
  }

  _mote(player, t, slow = 0) {
    if (!player.alive) return;
    const s = player.speedSmooth;
    const speedK = clamp01(s / 2100);
    const boost = 1 + player.launchGlow * 0.9 + player.brushGlow * 0.5;
    const R = 15;

    // outer volumetric halo - the mote's own light in the water
    this.glow.puts(player.x, player.y, R * (18 + speedK * 8), scaled(PAL.moteOuter, 0.30 * boost, tmp), 1, S.GLOW);
    this.glow.puts(player.x, player.y, R * 7.5, scaled(PAL.moteOuter, 0.62 * boost, tmp), 1, S.GLOW);
    this.glow.puts(player.x, player.y, R * 3.0, scaled(PAL.moteInner, 1.35 * boost, tmp), 1, S.GLOW);
    this.glow.puts(player.x, player.y, R * 1.15, scaled(PAL.moteCore, 2.9 * boost, tmp), 1, S.CORE);

    // motion-stretched streak, aligned to velocity
    const ang = Math.atan2(player.vy, player.vx);
    const stretch = 1 + speedK * 2.6;
    this.glow.push(player.x, player.y, R * 9 * stretch, R * 2.4, ang,
      PAL.moteInner[0] * 0.55 * boost, PAL.moteInner[1] * 0.6 * boost, PAL.moteInner[2] * 0.7 * boost, 1, S.STREAK);

    // lens star, brightest right after a launch
    const starK = 0.35 + player.launchGlow * 1.4 + speedK * 0.4;
    this.glow.puts(player.x, player.y, R * 11, scaled(PAL.moteCore, starK * 0.55, tmp), 1, S.STAR, t * 0.35);

    // ring pop on launch
    if (player.launchGlow > 0.02) {
      const k = player.launchGlow;
      this.glow.puts(player.x, player.y, R * (6 + (1 - k) * 46), scaled(PAL.moteInner, k * 1.2, tmp), 1, S.RING);
    }
    if (player.brushGlow > 0.02) {
      const k = player.brushGlow;
      this.glow.puts(player.x, player.y, R * (8 + (1 - k) * 40), scaled(PAL.hazardRim, k * 0.9, tmp), 1, S.RING);
    }
  }
}

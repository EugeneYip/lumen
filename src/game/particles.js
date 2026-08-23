// Pooled particle systems. Struct-of-arrays, no per-frame allocation.
// All randomness comes from a seeded stream so a replayed run looks identical.
import { makeRng } from '../engine/rng.js';
import { clamp, clamp01, lerp, TAU, smoothstep } from '../engine/math.js';
import { S } from '../engine/textures.js';
import { PAL, heat } from '../art/palette.js';

const CAP = 4096;
const RING_CAP = 96;

export class Particles {
  constructor(seed = 1) {
    this.rng = makeRng(seed * 7919 + 13);
    const f = (n) => new Float32Array(n);
    this.x = f(CAP); this.y = f(CAP); this.vx = f(CAP); this.vy = f(CAP);
    this.life = f(CAP); this.max = f(CAP); this.size = f(CAP); this.size1 = f(CAP);
    this.r = f(CAP); this.g = f(CAP); this.b = f(CAP);
    this.rot = f(CAP); this.spin = f(CAP);
    this.drag = f(CAP); this.grav = f(CAP); this.bright = f(CAP);
    this.layer = new Uint8Array(CAP);
    this.n = 0;

    this.rings = [];
    for (let i = 0; i < RING_CAP; i++) {
      this.rings.push({ live: false, x: 0, y: 0, t: 0, dur: 1, r0: 0, r1: 1, w: 1, col: PAL.moteOuter, bright: 1 });
    }
  }

  clear() { this.n = 0; for (const r of this.rings) r.live = false; }

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
    return i;
  }

  // ------------------------------------------------------------- emitters ---
  sparks(x, y, count, biasX = 0, biasY = 0, flavour = 'attach') {
    const r = this.rng;
    const cfg = {
      attach:  { spd: [90, 420],  life: [0.22, 0.5], size: [7, 26],  col: PAL.anchorMid,  bright: 2.6, grav: 120 },
      release: { spd: [180, 760], life: [0.25, 0.62], size: [8, 34], col: PAL.moteInner,  bright: 3.2, grav: 200 },
      wall:    { spd: [120, 560], life: [0.20, 0.55], size: [6, 22], col: PAL.waterHigh,  bright: 2.0, grav: 420 },
      brush:   { spd: [140, 520], life: [0.22, 0.48], size: [7, 24], col: PAL.hazardRim,  bright: 2.8, grav: 160 },
      chain:   { spd: [60, 260],  life: [0.30, 0.70], size: [6, 20], col: PAL.plankton,   bright: 2.4, grav: 60 },
    }[flavour] || { spd: [90, 400], life: [0.2, 0.5], size: [6, 24], col: PAL.moteInner, bright: 2.4, grav: 200 };

    for (let i = 0; i < count; i++) {
      const a = r() * TAU;
      const sp = lerp(cfg.spd[0], cfg.spd[1], Math.pow(r(), 1.7));
      const s0 = lerp(cfg.size[0], cfg.size[1], Math.pow(r(), 2));
      this._spawn(
        x + Math.cos(a) * 5, y + Math.sin(a) * 5,
        Math.cos(a) * sp + biasX, Math.sin(a) * sp + biasY,
        lerp(cfg.life[0], cfg.life[1], r()),
        s0, s0 * 0.15, cfg.col, cfg.bright * lerp(0.6, 1.4, r()),
        r() < 0.22 ? S.STAR : S.SPARK, lerp(1.6, 4.2, r()), cfg.grav, (r() - 0.5) * 6
      );
    }
  }

  /** Big shaped emission for pickups and death. */
  burst(x, y, flavour, mult = 1) {
    const r = this.rng;
    if (flavour === 'plankton') {
      const n = 12 + Math.min(18, (mult * 5) | 0);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + r() * 0.4;
        const sp = lerp(120, 460, Math.pow(r(), 1.4));
        const s0 = lerp(6, 22, r());
        this._spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp, lerp(0.28, 0.66, r()),
          s0, s0 * 0.1, PAL.plankton, 3.0, r() < 0.3 ? S.PLANKTON : S.SPARK,
          2.6, -40, (r() - 0.5) * 8);
      }
      this.ring(x, y, 0.55, PAL.plankton, 1.5);
      for (let i = 0; i < 4; i++) {
        this._spawn(x + (r() - 0.5) * 20, y + (r() - 0.5) * 20, (r() - 0.5) * 60, (r() - 0.5) * 60 - 40,
          lerp(0.5, 1.1, r()), lerp(40, 90, r()), 130, PAL.planktonDim, 0.5, S.SMOKE, 1.4, -20, (r() - 0.5) * 1.2);
      }
    } else if (flavour === 'death') {
      for (let i = 0; i < 90; i++) {
        const a = r() * TAU;
        const sp = lerp(150, 1500, Math.pow(r(), 1.6));
        const s0 = lerp(8, 40, Math.pow(r(), 1.5));
        const col = r() < 0.5 ? PAL.moteInner : PAL.moteOuter;
        this._spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp, lerp(0.4, 1.5, r()),
          s0, s0 * 0.08, col, 3.4 * lerp(0.5, 1.6, r()),
          r() < 0.25 ? S.STAR : S.SPARK, lerp(1.1, 3.0, r()), 260, (r() - 0.5) * 9);
      }
      for (let i = 0; i < 16; i++) {
        const a = r() * TAU, sp = lerp(40, 340, r());
        this._spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp, lerp(0.8, 2.0, r()),
          lerp(60, 150, r()), lerp(200, 420, r()), PAL.waterMid, 0.65, S.SMOKE, 1.2, -30, (r() - 0.5) * 1.0);
      }
      this.ring(x, y, 1.6, PAL.moteInner, 3.0);
      this.ring(x, y, 2.4, PAL.moteOuter, 1.6);
    }
  }

  ring(x, y, scale = 1, col = PAL.moteInner, bright = 2) {
    for (const rg of this.rings) {
      if (rg.live) continue;
      rg.live = true; rg.x = x; rg.y = y; rg.t = 0;
      rg.dur = lerp(0.34, 0.62, clamp01(scale * 0.5));
      rg.r0 = 12 * scale; rg.r1 = 210 * scale; rg.w = 26 * scale;
      rg.col = col; rg.bright = bright;
      return rg;
    }
    return null;
  }

  /** Rising bubble, used sparingly - a couple per impact reads as "water". */
  bubbles(x, y, count) {
    const r = this.rng;
    for (let i = 0; i < count; i++) {
      const s = lerp(4, 13, Math.pow(r(), 2));
      this._spawn(x + (r() - 0.5) * 24, y + (r() - 0.5) * 24,
        (r() - 0.5) * 40, -lerp(60, 190, r()), lerp(1.1, 2.6, r()),
        s, s * 1.1, PAL.waterHigh, 0.9, S.HALO, 0.6, -90, (r() - 0.5) * 0.6);
    }
  }

  // ---------------------------------------------------------------- update ---
  update(dt) {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const last = --this.n;
        if (i !== last) this._copy(last, i);
        continue;
      }
      const k = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= k; this.vy[i] *= k;
      this.vy[i] += this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.rot[i] += this.spin[i] * dt;
      i++;
    }
    for (const r of this.rings) {
      if (!r.live) continue;
      r.t += dt;
      if (r.t >= r.dur) r.live = false;
    }
  }

  _copy(a, b) {
    this.x[b] = this.x[a]; this.y[b] = this.y[a]; this.vx[b] = this.vx[a]; this.vy[b] = this.vy[a];
    this.life[b] = this.life[a]; this.max[b] = this.max[a];
    this.size[b] = this.size[a]; this.size1[b] = this.size1[a];
    this.r[b] = this.r[a]; this.g[b] = this.g[a]; this.b[b] = this.b[a];
    this.rot[b] = this.rot[a]; this.spin[b] = this.spin[a];
    this.drag[b] = this.drag[a]; this.grav[b] = this.grav[a];
    this.bright[b] = this.bright[a]; this.layer[b] = this.layer[a];
  }

  // ------------------------------------------------------------------ draw ---
  draw(batch) {
    for (let i = 0; i < this.n; i++) {
      const t = 1 - this.life[i] / this.max[i];
      // fast bloom-in, long tail out - reads as an ember rather than a fade
      const a = (1 - t) * (1 - t) * (0.25 + 0.75 * smoothstep(clamp01(t * 7)));
      const s = lerp(this.size[i], this.size1[i], t * t);
      const bb = this.bright[i] * a;
      batch.push(this.x[i], this.y[i], s, s, this.rot[i],
        this.r[i] * bb, this.g[i] * bb, this.b[i] * bb, 1, this.layer[i]);
    }
    for (const r of this.rings) {
      if (!r.live) continue;
      const t = r.t / r.dur;
      const rad = lerp(r.r0, r.r1, 1 - Math.pow(1 - t, 2.6));
      const a = Math.pow(1 - t, 2.0) * r.bright;
      const d = rad * 2;
      batch.push(r.x, r.y, d, d, 0, r.col[0] * a, r.col[1] * a, r.col[2] * a, 1, S.RING);
    }
  }
}

/**
 * Ambient drifting motes that live in screen space, at three parallax depths.
 * Cheap, and it is what stops the foreground feeling like a flat plate.
 */
export class Ambient {
  constructor(seed = 1, count = 190) {
    const r = makeRng(seed * 104729 + 7);
    this.n = count;
    this.px = new Float32Array(count); this.py = new Float32Array(count);
    this.pz = new Float32Array(count); this.ps = new Float32Array(count);
    this.pp = new Float32Array(count); this.pw = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this.px[i] = r() * 4000; this.py[i] = r() * 3000 - 1500;
      this.pz[i] = lerp(0.25, 1.55, Math.pow(r(), 1.3));
      this.ps[i] = lerp(2.5, 11, Math.pow(r(), 2.2));
      this.pp[i] = r() * TAU; this.pw[i] = lerp(0.25, 1.1, r());
    }
  }

  draw(batch, cam, t) {
    const b = cam.bounds(240);
    const W = b.x1 - b.x0, H = b.y1 - b.y0;
    for (let i = 0; i < this.n; i++) {
      const z = this.pz[i];
      // wrap in a frame that scrolls with parallax depth
      let x = this.px[i] + cam.x * (1 - 1 / z) * 0.0;
      let y = this.py[i];
      x = b.x0 + (((x - cam.x / z) % W) + W) % W;
      y = b.y0 + (((y - cam.y / z + t * 9 * this.pw[i]) % H) + H) % H;
      const tw = 0.45 + 0.55 * Math.sin(t * this.pw[i] * 2.1 + this.pp[i]);
      const s = this.ps[i] * (0.6 + 0.8 / z);
      const a = (0.16 + 0.30 * tw) / (z * z) * 0.9;
      batch.push(x, y, s, s, 0, PAL.waterHigh[0] * a * 3.2, PAL.waterHigh[1] * a * 3.4,
        PAL.waterHigh[2] * a * 3.6, 1, S.GLOW);
    }
  }
}

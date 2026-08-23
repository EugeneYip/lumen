// Camera with velocity lookahead, speed zoom, trauma shake and a touch of roll.
// All smoothing is exp-based so it is identical at any framerate.
import { damp, clamp, clamp01, lerp, smoothstep, TAU } from '../engine/math.js';
import { noise1 } from '../engine/rng.js';

const DESIGN_H = 1080;   // world units visible vertically at zoom 1

export class Camera {
  constructor() {
    this.x = 0; this.y = 0;
    this.zoom = 1; this.rot = 0;
    this.pixelW = 1; this.pixelH = 1;
    this.viewW = DESIGN_H; this.viewH = DESIGN_H;
    this.sx = 2 / DESIGN_H; this.sy = -2 / DESIGN_H;
    this.trauma = 0;
    this.shakeX = 0; this.shakeY = 0; this.shakeRot = 0;
    this.zoomTarget = 1;
    this.baseX = 0; this.baseY = 0;
    this.t = 0;
    this.kick = 0;
  }

  resize(pw, ph) { this.pixelW = pw; this.pixelH = ph; this._recalc(); }

  _recalc() {
    const aspect = this.pixelW / Math.max(1, this.pixelH);
    // Vertical-first framing, but never let an ultra-wide window see too much.
    this.viewH = DESIGN_H / this.zoom;
    this.viewW = this.viewH * aspect;
    if (aspect < 1.2) { // tall/square windows: widen instead of cropping
      this.viewW = (DESIGN_H * 1.2) / this.zoom;
      this.viewH = this.viewW / aspect;
    }
    this.sx = 2 / this.viewW;
    this.sy = -2 / this.viewH;
  }

  snapTo(x, y) { this.baseX = x; this.baseY = y; this.x = x; this.y = y; }

  addTrauma(a) { this.trauma = clamp01(this.trauma + a); }

  /** @param p {x,y,vx,vy} focus  @param opts {leadScale, bias} */
  update(dt, p, opts = {}) {
    this.t += dt;
    const speed = Math.hypot(p.vx, p.vy);

    // --- lookahead: mostly forward, a little into the fall ---
    const lead = opts.leadScale ?? 1;
    const lx = clamp(p.vx * 0.34, -220, 560) * lead + this.viewW * 0.10;
    const ly = clamp(p.vy * 0.20, -260, 300) * lead;

    const tx = p.x + lx;
    const ty = p.y + ly + (opts.bias || 0);

    // Asymmetric rates: snappy horizontally (reads as speed), calm vertically.
    this.baseX = damp(this.baseX, tx, 5.2, dt);
    this.baseY = damp(this.baseY, ty, 3.4, dt);

    // --- speed zoom: pull back so fast play still shows the next anchor ---
    const zt = 1 / (1 + smoothstep(clamp01((speed - 620) / 1500)) * 0.30 + (opts.zoomOut || 0));
    this.zoomTarget = zt;
    this.zoom = damp(this.zoom, this.zoomTarget, 2.6, dt);

    // --- trauma shake: noise-driven, quadratic falloff, no per-frame jitter ---
    this.trauma = Math.max(0, this.trauma - dt * 1.55);
    const tr = this.trauma * this.trauma;
    const f = this.t * 34;
    this.shakeX = (noise1(f) * 2 - 1) * tr * 46;
    this.shakeY = (noise1(f + 77.3) * 2 - 1) * tr * 46;
    this.shakeRot = (noise1(f + 191.7) * 2 - 1) * tr * 0.030;

    // --- roll: a hair of bank into the direction of travel ---
    const bank = clamp(p.vx * 0.000018 + p.vy * 0.000030, -0.045, 0.045);
    this.rot = damp(this.rot, bank, 3.0, dt) + this.shakeRot;

    this.kick = damp(this.kick, 0, 7, dt);

    this.x = this.baseX + this.shakeX;
    this.y = this.baseY + this.shakeY;
    this._recalc();
  }

  /** Visible world rect, padded for culling. */
  bounds(pad = 0) {
    const hw = this.viewW * 0.5 + pad, hh = this.viewH * 0.5 + pad;
    return { x0: this.x - hw, x1: this.x + hw, y0: this.y - hh, y1: this.y + hh };
  }

  worldToUv(wx, wy) {
    const c = Math.cos(this.rot), s = Math.sin(this.rot);
    const dx = wx - this.x, dy = wy - this.y;
    const rx = dx * c - dy * s, ry = dx * s + dy * c;
    return [rx / this.viewW + 0.5, 0.5 - ry / this.viewH];
  }
}

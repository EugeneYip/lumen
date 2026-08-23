// Camera as storyteller. It anticipates the launch, punches on it, settles with
// a little overshoot instead of a pure exponential, banks into the arc it is
// actually flying, and treats an impact as a directional blow rather than a
// vibration.
//
// Two rules constrain all of it:
//  - Frame-rate independence. Every smoother is spring() or damp(); nothing is
//    a per-step multiply.
//  - Never make anyone ill. Roll is hard-clamped well under 7 degrees and moves
//    slowly, the vertical axis is critically damped so it cannot bob, and every
//    offset is clamped. The horizon never spins.
//
// It reads optional fields off the focus object (windUp, launchSeq, impactSeq,
// ...) and works without any of them, because main.js also drives it with a
// bare {x, y, vx, vy} on the title screen.
import { damp, clamp, clamp01, lerp, smoothstep, spring, TAU } from '../engine/math.js';
import { noise1 } from '../engine/rng.js';

const DESIGN_H = 1080;   // world units visible vertically at zoom 1
const MAX_BANK = 0.105;  // rad. 6 degrees is plenty to feel and safe to watch.
const MAX_SHAKE = 150;   // world units of impact offset, hard cap
const NIMP = 3;          // impulse slots; fixed pool, no per-frame allocation

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

    // follow springs
    this.baseVX = 0; this.baseVY = 0;
    // launch punch: a positional impulse that springs back
    this.punchX = 0; this.punchY = 0; this.punchVX = 0; this.punchVY = 0;
    // zoom: spring, plus a separate kick channel so a launch can widen fast
    this.zoomVel = 0; this.zk = 0; this.zkVel = 0;
    this.zoomRef = 0;          // hysteresis reference speed
    // roll from the curvature of the path actually being flown
    this.bank = 0; this.bankVel = 0; this.turnSmooth = 0;
    this._pvx = 0; this._pvy = 0; this._pvl = 0;
    // impact impulses
    this.imp = [];
    for (let i = 0; i < NIMP; i++) this.imp.push({ ax: 0, ay: 0, mag: 0, t: 0, live: false });
    this._pending = 0;
    this._axisX = 0; this._axisY = -1;
    this._launchSeq = -1; this._impactSeq = -1;
    this.antic = 0;
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

  snapTo(x, y) {
    this.baseX = x; this.baseY = y; this.x = x; this.y = y;
    this.baseVX = 0; this.baseVY = 0;
    this.punchX = 0; this.punchY = 0; this.punchVX = 0; this.punchVY = 0;
    this.zk = 0; this.zkVel = 0; this.zoomVel = 0;
    this.bank = 0; this.bankVel = 0; this.turnSmooth = 0; this.rot = 0;
    this.zoomRef = 0; this._pvl = 0; this.antic = 0;
    for (const im of this.imp) im.live = false;
    this._pending = 0;
  }

  /**
   * Magnitude only. The *axis* is chosen in update(), where we know whether this
   * frame was a wall hit (use its normal), a launch (use its direction) or just
   * a knock (across the direction of travel). That is the whole difference
   * between an impact and a rumble.
   */
  addTrauma(a) {
    this.trauma = clamp01(this.trauma + a);
    this._pending += a;
  }

  /** Explicit axis, for callers that know the direction of the blow. */
  addImpact(a, dx, dy) {
    const l = Math.hypot(dx, dy) || 1;
    this._axisX = dx / l; this._axisY = dy / l;
    this.addTrauma(a);
  }

  _fire(mag, ax, ay) {
    let slot = null;
    for (const im of this.imp) { if (!im.live) { slot = im; break; } }
    if (!slot) {                       // steal the most decayed one
      slot = this.imp[0];
      for (const im of this.imp) if (im.t > slot.t) slot = im;
    }
    slot.live = true; slot.t = 0; slot.mag = mag; slot.ax = ax; slot.ay = ay;
  }

  /** @param p {x,y,vx,vy} focus  @param opts {leadScale, bias, zoomOut} */
  update(dt, p, opts = {}) {
    this.t += dt;
    const vx = p.vx || 0, vy = p.vy || 0;
    const speed = Math.hypot(vx, vy);
    const vl = speed || 1;

    // ---- anticipation: load up while the swing is being wound -------------
    // Ease the frame back along the line we are about to be thrown down, and
    // tighten a little. Both unwind into the punch, which is what makes the
    // launch read as a release of something that was being held.
    const wind = (p.attached ? (p.windUp || 0) : 0);
    this.antic = damp(this.antic, wind, 4.5, dt);

    // ---- launch: punch the frame, widen the lens --------------------------
    const lseq = p.launchSeq;
    if (lseq !== undefined && this._launchSeq !== lseq) {
      if (this._launchSeq >= 0) {
        const pow = clamp01(p.launchPow || 0), q = clamp01(p.releaseQ || 0);
        const k = 0.35 + 0.65 * pow * (0.4 + 0.6 * q);
        // Kick *against* the launch so the mote surges toward the leading edge
        // and the camera has to haul itself back in. Chasing reads as speed;
        // leading reads as nothing.
        const dx = p.launchDirX === undefined ? vx / vl : p.launchDirX;
        const dy = p.launchDirY === undefined ? vy / vl : p.launchDirY;
        this.punchVX -= dx * 620 * k;
        this.punchVY -= dy * 380 * k;
        this.zkVel += 1.9 * k;                   // widen, then settle back
        this._axisX = dx; this._axisY = dy;
      }
      this._launchSeq = lseq;
    }

    // ---- impacts: axis from the blow itself -------------------------------
    const iseq = p.impactSeq;
    if (iseq !== undefined && this._impactSeq !== iseq) {
      if (this._impactSeq >= 0 && (p.impactNx || p.impactNy)) {
        this._axisX = p.impactNx; this._axisY = p.impactNy;
      }
      this._impactSeq = iseq;
    }
    if (this._pending > 0.015) {
      // Default axis is across the direction of travel: a jolt you feel without
      // it fighting the sense of forward motion.
      let ax = this._axisX, ay = this._axisY;
      if (!ax && !ay) { ax = -vy / vl; ay = vx / vl; }
      this._fire(clamp01(this._pending), ax, ay);
      this._pending = 0;
      this._axisX = 0; this._axisY = 0;
    }

    // ---- lookahead -------------------------------------------------------
    const lead = opts.leadScale ?? 1;
    const lx = clamp(vx * 0.34, -220, 560) * lead + this.viewW * 0.10;
    const ly = clamp(vy * 0.20, -260, 300) * lead;
    // pull back along the launch line while winding up
    const ax = this.antic * 96, ay = this.antic * 46;
    const tx = p.x + lx - (vx / vl) * ax;
    const ty = p.y + ly + (opts.bias || 0) - (vy / vl) * ay;

    // Springs, not exponentials: horizontally underdamped so arriving has a
    // little overshoot and the frame settles with character. Vertically
    // critically damped - vertical bob is what makes people ill.
    const s1 = spring(this.baseX, this.baseVX, tx, 0.95, 0.80, dt);
    this.baseX = s1[0]; this.baseVX = s1[1];
    const s2 = spring(this.baseY, this.baseVY, ty, 0.62, 1.00, dt);
    this.baseY = s2[0]; this.baseVY = s2[1];

    const s3 = spring(this.punchX, this.punchVX, 0, 1.35, 0.62, dt);
    this.punchX = s3[0]; this.punchVX = s3[1];
    const s4 = spring(this.punchY, this.punchVY, 0, 1.35, 0.62, dt);
    this.punchY = s4[0]; this.punchVY = s4[1];

    // ---- speed zoom, with hysteresis so a swing cannot pump the lens ------
    // The reference only follows speed once speed leaves a dead band around it,
    // so oscillating across a threshold - which every pendulum does, twice per
    // arc - does not breathe the zoom in and out.
    const sp = p.speedSmooth === undefined ? speed : p.speedSmooth;
    const BAND = 190;
    if (this.zoomRef === 0) this.zoomRef = sp;
    else if (sp > this.zoomRef + BAND) this.zoomRef = sp - BAND;
    else if (sp < this.zoomRef - BAND) this.zoomRef = sp + BAND;

    const s5 = spring(this.zk, this.zkVel, 0, 1.15, 0.85, dt);
    this.zk = s5[0]; this.zkVel = s5[1];

    const wide = smoothstep(clamp01((this.zoomRef - 620) / 1500)) * 0.32;
    const denom = 1 + wide + (opts.zoomOut || 0) + this.zk * 0.055 - this.antic * 0.045;
    this.zoomTarget = 1 / Math.max(0.55, denom);
    const s6 = spring(this.zoom, this.zoomVel, this.zoomTarget, 0.55, 1.00, dt);
    this.zoom = s6[0]; this.zoomVel = s6[1];

    // ---- impact impulses: a decaying blow along one axis ------------------
    let ox = 0, oy = 0, orot = 0, amp = 0;
    for (const im of this.imp) {
      if (!im.live) continue;
      im.t += dt;
      const e = Math.exp(-11 * im.t);
      if (e < 0.02) { im.live = false; continue; }
      const s = Math.sin(TAU * 7.5 * im.t) * e * im.mag;
      ox += im.ax * s * 165;
      oy += im.ay * s * 165;
      orot += s * 0.020;
      amp += Math.abs(s);
    }
    // A touch of noise on top so a big hit does not read as a clean sine.
    if (amp > 0.001) {
      const f = this.t * 41;
      ox += (noise1(f) * 2 - 1) * amp * 42;
      oy += (noise1(f + 77.3) * 2 - 1) * amp * 42;
    }
    this.trauma = Math.max(0, this.trauma - dt * 1.55);
    this.shakeX = clamp(ox, -MAX_SHAKE, MAX_SHAKE);
    this.shakeY = clamp(oy, -MAX_SHAKE, MAX_SHAKE);
    this.shakeRot = clamp(orot, -0.03, 0.03);

    // ---- roll: bank into the arc actually being flown ---------------------
    // Driven by the curvature of the path, not by raw velocity, so it works the
    // same tethered and free and always leans the way the mote is really
    // turning. Clamped hard, and slow: the horizon must never spin.
    if (this._pvl > 1 && vl > 1) {
      const cr = (this._pvx * vy - this._pvy * vx) / (vl * this._pvl);
      const turn = Math.asin(clamp(cr, -1, 1)) / Math.max(dt, 1e-5);
      this.turnSmooth = damp(this.turnSmooth, turn, 5.5, dt);
    } else {
      this.turnSmooth = damp(this.turnSmooth, 0, 5.5, dt);
    }
    this._pvx = vx; this._pvy = vy; this._pvl = vl;
    const bankT = clamp(this.turnSmooth * 0.026, -MAX_BANK, MAX_BANK);
    const s7 = spring(this.bank, this.bankVel, bankT, 0.50, 1.00, dt);
    this.bank = clamp(s7[0], -MAX_BANK * 1.2, MAX_BANK * 1.2); this.bankVel = s7[1];
    this.rot = this.bank + this.shakeRot;

    this.kick = damp(this.kick, 0, 7, dt);

    this.x = this.baseX + this.shakeX + this.punchX;
    this.y = this.baseY + this.shakeY + this.punchY;
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

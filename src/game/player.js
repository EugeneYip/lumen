// The mote, and the tether.
//
// Feel notes (these numbers are the game):
//  - Gravity is high and drag is quadratic, so speed has a hard ceiling and
//    every swing has to be earned. Terminal velocity ~2600 u/s.
//  - Reeling in while attached is the only way to add energy. That makes the
//    skill "how long do I hold", which is the whole game on one button.
//  - Release adds a small tangential impulse. Physically a cheat; it is what
//    makes letting go feel like a decision rather than an absence.
import { clamp, clamp01, lerp, smoothstep, TAU, damp } from '../engine/math.js';
import { KIND } from './world.js';

export const P = {
  gravity: 1560,
  dragQuad: 0.000225,        // a = -k v|v|
  dragLin: 0.16,
  radius: 15,

  reach: 620,
  ropeMax: 540,
  ropeMin: 118,
  reelBase: 210,
  reelMax: 380,
  reelRamp: 1.7,             // seconds to reach reelMax
  stiffness: 1.0,
  releaseBoost: 78,
  retetherDelay: 0.07,
  swimAssist: 820,           // tangential authority while tethered
  swimCeiling: 2250,         // assist tapers to nothing by this speed

  wallRestitution: 0.46,
  wallFrictionRate: 2.4,     // per-second, not per-step
  updraftHeight: 190,        // vent current lifting you off the trench floor
  updraftForce: 1750,

  brushDist: 1.55,           // multiple of hazard radius that counts as a graze
  planktonMagnet: 46,
};

export class Player {
  constructor() { this.reset(); }

  reset() {
    this.x = 0; this.y = -120;
    this.vx = 430; this.vy = -40;
    this.alive = true;
    this.anchor = null;
    this.rope = 0;
    this.holdTime = 0;
    this.sinceRelease = 99;
    this.spin = 0;
    this.angVis = 0;
    this.energy = 1;
    this.chain = 0;
    this.mult = 1;
    this.brushGlow = 0;
    this.inDraft = 0;
    this.tetherGlow = 0;
    this.launchGlow = 0;
    this.deathT = 0;
    this.maxX = 0;
    this.trailPts = [];
    this.lastAnchorId = null;
    this.speedSmooth = 430;
  }

  get speed() { return Math.hypot(this.vx, this.vy); }
  get attached() { return this.anchor != null; }

  /**
   * @param fx sink for juice: {sparks, burst, ring, shake, flash, wave, sound, slowmo}
   */
  update(dt, world, input, fx, t) {
    if (!this.alive) { this.deathT += dt; return; }

    this.sinceRelease += dt;
    this.tetherGlow = damp(this.tetherGlow, this.attached ? 1 : 0, 14, dt);
    this.launchGlow = damp(this.launchGlow, 0, 5.5, dt);
    this.brushGlow = damp(this.brushGlow, 0, 4.0, dt);

    // ---------------- tether acquire / release ----------------
    if (input.held && !this.attached && this.sinceRelease > P.retetherDelay) {
      const a = world.pickAnchor(this.x, this.y, this.vx, this.vy, P.reach);
      if (a) {
        this.anchor = a;
        this.rope = Math.min(P.ropeMax, Math.hypot(a.x - this.x, a.y - this.y));
        this.holdTime = 0;
        a.used++;
        fx.sound('attach', { pan: 0, speed: this.speed });
        fx.ring(a.x, a.y, 1);
        fx.sparks(this.x, this.y, 9, this.vx * 0.15, this.vy * 0.15, 'attach');
      }
    }
    if (!input.held && this.attached) this.release(fx);

    // ---------------- integrate ----------------
    if (this.attached) {
      const a = this.anchor;
      this.holdTime += dt;

      // reel in: the energy pump
      const reel = lerp(P.reelBase, P.reelMax, clamp01(this.holdTime / P.reelRamp));
      this.rope = Math.max(P.ropeMin, this.rope - reel * dt);

      // gravity + drag
      this.vy += P.gravity * dt;
      this._drag(dt);

      // "swim": a small tangential push along the arc. Without it a mote that
      // ends up hanging dead-centre under an anchor has no way out - gravity is
      // purely radial there, so the constraint eats all of it. With it, every
      // swing has authority and the pendulum always recovers.
      {
        const rx = this.x - a.x, ry = this.y - a.y;
        const rl = Math.hypot(rx, ry) || 1e-4;
        let tx = -ry / rl, ty = rx / rl;
        let dir = this.vx * tx + this.vy * ty;
        if (Math.abs(dir) < 24) dir = tx;          // nearly still: pick forward
        const sgn = dir >= 0 ? 1 : -1;
        const k = P.swimAssist * clamp01(1 - this.speed / P.swimCeiling);
        this.vx += tx * sgn * k * dt;
        this.vy += ty * sgn * k * dt;
      }

      this.x += this.vx * dt;
      this.y += this.vy * dt;

      // constraint: project onto the circle, then kill radial velocity
      let dx = this.x - a.x, dy = this.y - a.y;
      let d = Math.hypot(dx, dy) || 1e-4;
      const nx = dx / d, ny = dy / d;
      const err = d - this.rope;
      this.x -= nx * err * P.stiffness;
      this.y -= ny * err * P.stiffness;
      const radial = this.vx * nx + this.vy * ny;
      this.vx -= nx * radial;
      this.vy -= ny * radial;

      // Reeling shortens the radius; conserve angular momentum so pumping
      // actually speeds you up the way a real shortening pendulum does.
      if (err < 0) {
        const gain = clamp(1 + (-err / Math.max(this.rope, 1)) * 0.9, 1, 1.06);
        this.vx *= gain; this.vy *= gain;
      }

      this.spin = (this.vx * -ny + this.vy * nx) / Math.max(this.rope, 1);
    } else {
      this.vy += P.gravity * dt;
      this._drag(dt);
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.spin = damp(this.spin, 0, 2.5, dt);
    }

    this.speedSmooth = damp(this.speedSmooth, this.speed, 6, dt);
    this.angVis += this.spin * dt * 0.5;
    this.maxX = Math.max(this.maxX, this.x);

    // ---------------- walls ----------------
    this._walls(dt, world, fx);

    // ---------------- pickups + hazards ----------------
    this._plankton(dt, world, fx, t);
    this._hazards(dt, world, fx);

    // ---------------- the Hush ----------------
    if (this.x < world.hushX + 26) this.die(fx, 'hush');

    // ---------------- trail ----------------
    const pts = this.trailPts;
    pts.push(this.x, this.y);
    const MAX = 44 * 2;
    if (pts.length > MAX) pts.splice(0, pts.length - MAX);

    // chain decays if you stop collecting
    this.chain = Math.max(0, this.chain - dt * 0.34);
    this.mult = 1 + Math.floor(this.chain / 3) * 0.5;
  }

  _drag(dt) {
    const s = Math.hypot(this.vx, this.vy);
    if (s > 1e-3) {
      const dec = (P.dragQuad * s * s + P.dragLin * s) * dt;
      const k = Math.max(0, 1 - dec / s);
      this.vx *= k; this.vy *= k;
    }
  }

  release(fx) {
    if (!this.attached) return;
    const a = this.anchor;
    const dx = this.x - a.x, dy = this.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const tx = -dy / d, ty = dx / d;
    const along = Math.sign(this.vx * tx + this.vy * ty) || 1;
    this.vx += tx * along * P.releaseBoost;
    this.vy += ty * along * P.releaseBoost;
    this.anchor = null;
    this.sinceRelease = 0;
    this.launchGlow = 1;
    const s = this.speed;
    fx.sound('release', { speed: s });
    fx.sparks(this.x, this.y, 14, this.vx * 0.22, this.vy * 0.22, 'release');
    fx.ring(this.x, this.y, 0.7);
    fx.shake(clamp01(s / 2600) * 0.16);
    a.used++;
  }

  _walls(dt, world, fx) {
    const top = world.bandTop(this.x) + P.radius;
    const bot = world.bandBot(this.x) - P.radius;

    // Vent updraft along the trench floor. Keeps the abyss from becoming a
    // parking space, and gives the low line a reason to exist.
    const overFloor = bot - this.y;
    if (overFloor < P.updraftHeight) {
      const k = clamp01(1 - overFloor / P.updraftHeight);
      this.vy -= P.updraftForce * k * k * dt;
      this.inDraft = k;
    } else this.inDraft = 0;

    let hit = 0, hy = 0;
    // Friction is exponential in dt, so grazing a wall costs a little speed
    // instead of everything - the previous per-step multiply was fatal at 120Hz.
    const rub = Math.exp(-P.wallFrictionRate * dt);
    if (this.y < top) {
      this.y = top; if (this.vy < 0) { this.vy = -this.vy * P.wallRestitution; hit = 1; hy = 1; }
      this.vx *= rub;
    } else if (this.y > bot) {
      this.y = bot; if (this.vy > 0) { this.vy = -this.vy * P.wallRestitution; hit = 1; hy = -1; }
      this.vx *= rub;
    }
    if (hit) {
      const s = Math.abs(this.vy) + Math.abs(this.vx) * 0.3;
      if (s > 140) {
        fx.sparks(this.x, this.y, 10 + (s / 180) | 0, this.vx * 0.2, hy * 160, 'wall');
        fx.shake(clamp01(s / 2200) * 0.30);
        fx.sound('wall', { speed: s });
      }
    }
  }

  _plankton(dt, world, fx, t) {
    const list = world.plankton;
    const R = P.radius + P.planktonMagnet;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.taken) continue;
      if (p.x < this.x - 200) continue;
      if (p.x > this.x + 400) break;
      const dx = p.x - this.x, dy = p.y - this.y;
      if (dx * dx + dy * dy < (R + p.r) * (R + p.r)) {
        p.taken = true; p.takenAt = t;
        this.chain += 1;
        this.energy = clamp01(this.energy + 0.06);
        fx.burst(p.x, p.y, 'plankton', this.mult);
        fx.sound('pickup', { pitch: clamp(this.chain, 0, 24) });
        // a whisper of forward assist keeps chains flowing
        const s = this.speed || 1;
        this.vx += (this.vx / s) * 16; this.vy += (this.vy / s) * 16;
      }
    }
  }

  _hazards(dt, world, fx) {
    const list = world.hazards;
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      if (!h.alive) continue;
      if (h.x < this.x - 400) continue;
      if (h.x > this.x + 700) break;
      const dx = h.x - this.x, dy = h.y - this.y;
      const d = Math.hypot(dx, dy);
      const kill = h.r * 0.62 + P.radius;
      if (d < kill) { this.die(fx, 'hazard', h); return; }
      const graze = h.r * P.brushDist + P.radius;
      if (d < graze && !h.brushed) {
        h.brushed = true;
        this.brushGlow = 1;
        this.chain += 0.6;
        fx.slowmo(0.16, 0.34);
        fx.flash(0.10, [0.9, 0.35, 0.55]);
        fx.sound('brush', {});
        fx.sparks(this.x, this.y, 8, -dx * 0.4, -dy * 0.4, 'brush');
      }
    }
  }

  die(fx, cause, src) {
    if (!this.alive) return;
    this.alive = false;
    this.anchor = null;
    this.deathT = 0;
    this.deathCause = cause;
    fx.burst(this.x, this.y, 'death', 1);
    fx.shake(0.85);
    fx.flash(0.55, cause === 'hush' ? [0.45, 0.2, 0.95] : [1, 0.35, 0.5]);
    fx.wave(this.x, this.y, 1);
    fx.sound('death', { cause });
    fx.slowmo(0.34, 1.1);
  }
}

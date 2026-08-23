// The mote, and the tether.
//
// Feel notes (these numbers are the game):
//  - Gravity is high and drag is quadratic, so speed has a hard ceiling and
//    every swing has to be earned. Terminal velocity ~2600 u/s.
//  - The reel is pumped, not constant: it hauls in on the fast part of the arc
//    and pays back out on the slow part, gated on tangential speed against the
//    swing's own running mean. Hanging at an extreme therefore *costs* speed, so
//    there is a best moment to let go rather than a monotonic reward for holding.
//  - Angular momentum is conserved exactly across a length change (v scales as
//    1/r, both directions), so the pump is physics rather than a bonus. Three
//    things cap it: the rope floor rises with speed, spin drag punishes tight
//    fast circles, and paying out at the extremes bleeds what reeling gained.
//  - Release adds a tangential impulse scaled by wind-up and by how close the
//    heading was to the ideal launch line. Physically a cheat; it is what makes
//    letting go a decision rather than an absence. Direction stays purely
//    tangential: the arc chooses where you go, the timing chooses how hard.
import { clamp, clamp01, lerp, smoothstep, damp } from '../engine/math.js';
import { KIND } from './world.js';

export const P = {
  gravity: 1850,
  dragQuad: 0.00028,         // a = -k v|v|; terminal ~2570
  dragLin: 0.17,
  dragSpin: 0.048,           // extra drag proportional to angular rate
  radius: 15,

  reach: 620,
  ropeMax: 560,
  ropeMin: 190,              // floor at a standstill
  ropeMinFast: 330,          // ...and at ropeFloorV. A fast line will not reel tight.
  ropeFloorV: 2000,
  reelBase: 260,
  reelMax: 520,
  reelRamp: 1.6,             // seconds of holding to reach reelMax
  payOut: 200,               // rope pays back out on the slow part of the arc
  stiffness: 1.0,
  catchKeep: 0.22,           // fraction of doomed radial speed handed to the tangent

  releaseBoost: 420,
  releaseFloor: 0.30,        // share of the boost a badly timed release still gets
  loadTime: 0.30,            // a launch has to be loaded; a tap earns nothing
  launchAngle: 0.40,         // rad above horizontal: the ideal launch heading.
                             // Measured, not guessed: distance-optimal release
                             // is 10-25deg ahead of the anchor, not 35.
  launchWindow: 0.95,        // rad: half-width of the quality window
  retetherDelay: 0.12,
  swimAssist: 900,           // tangential authority while tethered
  swimCeiling: 2400,         // assist tapers to nothing by this speed

  wallRestitution: 0.58,
  wallFrictionRate: 1.8,     // per-second, not per-step

  // Vent field along the trench floor. A current with a velocity target, not a
  // force that cancels gravity: a force balances into a hover, a current cannot.
  // Strength scales with the trench, because the climb back into tether range
  // does too. Keeps the rescue honest on a deep band without turning a shallow
  // one into a trampoline.
  ventSpan: 0.18,            // column height as a fraction of band height
  ventFlowK: 2.10,           // upward flow speed per unit of band height
  ventFalloff: 1.60,         // >1 concentrates the lift near the floor
  ventFlowX: 340,            // downstream drift inside the column
  ventRate: 4.4,             // how hard the current grips you (1/s)

  brushDist: 1.55,           // multiple of hazard radius that counts as a graze
  planktonMagnet: 46,
  windUpRate: 1.05,          // wind-up charge per second at a perfect phase
  windUpBleed: 0.14,         // ...and what it loses hanging at a useless one
  dilateGap: 0.85,           // min seconds between time-dilation pinches
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
    this.sinceDilate = 99;
    this.spin = 0;
    this.angVis = 0;
    this.energy = 1;
    this.chain = 0;
    this.chainStep = 0;
    this.chainPop = 0;
    this.mult = 1;
    this.brushGlow = 0;
    this.inDraft = 0;
    this.tetherGlow = 0;
    this.launchGlow = 0;
    this.deathT = 0;
    this.deathCause = null;
    this.deathSrc = null;
    this.maxX = 0;
    this.trailPts = [];
    this.lastAnchorId = null;
    this.speedSmooth = 430;

    // ---- feedback state other systems read (render, postfx, audio, camera) ----
    this.windUp = 0;           // 0..1 stored swing energy; the anticipation
    this.windUpRate = 0;       // >0 charging, <0 bleeding
    this.releaseWindow = 0;    // 0..1 how good a release *right now* would be
    this.releaseValue = 0;     // ...weighted by wind-up. The teaching signal.
    this.releaseQ = 0;         // quality of the last release
    this.launchPow = 0;        // magnitude of the last launch impulse, 0..1
    this.launchSeq = 0;        // increments on release (event edge for the camera)
    this.launchDirX = 1; this.launchDirY = 0;
    this.catchQ = 0;           // 1 = caught perfectly across the anchor
    this.catchJolt = 0;        // decaying jolt from a bad catch
    this.catchSeq = 0;
    this.arcPhase = 0;         // 1 = directly below the anchor, -1 = above it
    this.pumpK = 0;            // instantaneous reel efficacy
    this.swingRef = 0;         // running mean tangential speed, the pump's datum
    this.ropeStrain = 0;       // 0..1 line tension
    this.impactSeq = 0;        // wall hits
    this.impactNx = 0; this.impactNy = 0; this.impactPow = 0;
    this.ventEmit = 0;
  }

  get speed() { return Math.hypot(this.vx, this.vy); }
  get attached() { return this.anchor != null; }

  /** How tight the line can be reeled at the current speed. */
  _ropeFloor() {
    return lerp(P.ropeMin, P.ropeMinFast, clamp01(this.speed / P.ropeFloorV));
  }

  /**
   * How close the current heading is to the ideal launch line. 1 = perfect.
   * y is down, so -vy is "up": the ideal is forward and rising.
   */
  _launchQ() {
    if (this.speed < 1e-3) return 0;
    const ang = Math.atan2(-this.vy, this.vx);
    return smoothstep(clamp01(1 - Math.abs(ang - P.launchAngle) / P.launchWindow));
  }

  /** Time dilation, rate-limited so it stays an event instead of a strobe. */
  _pinch(fx, amount, dur) {
    if (this.sinceDilate < P.dilateGap) return false;
    this.sinceDilate = 0;
    fx.slowmo(amount, dur);
    return true;
  }

  /**
   * @param fx sink for juice: {sparks, burst, ring, bubbles, shake, flash, slowmo, wave, sound}
   */
  update(dt, world, input, fx, t) {
    if (!this.alive) { this.deathT += dt; return; }

    this.sinceRelease += dt;
    this.sinceDilate += dt;
    this.tetherGlow = damp(this.tetherGlow, this.attached ? 1 : 0, 14, dt);
    this.launchGlow = damp(this.launchGlow, 0, 5.5, dt);
    this.brushGlow = damp(this.brushGlow, 0, 4.0, dt);
    this.catchJolt = damp(this.catchJolt, 0, 6.5, dt);
    this.chainPop = damp(this.chainPop, 0, 5.0, dt);

    // ---------------- tether acquire / release ----------------
    if (input.held && !this.attached && this.sinceRelease > P.retetherDelay) {
      const a = world.pickAnchor(this.x, this.y, this.vx, this.vy, P.reach);
      if (a) this._attach(a, fx);
    }
    if (!input.held && this.attached) this.release(fx);

    // ---------------- integrate ----------------
    if (this.attached) {
      const a = this.anchor;
      this.holdTime += dt;

      // Radial basis, taken before integrating: everything about the pump is a
      // question of *where in the arc* we are right now.
      let rx = this.x - a.x, ry = this.y - a.y;
      let rl = Math.hypot(rx, ry) || 1e-4;
      const phase = ry / rl;                       // 1 = hanging straight down
      this.arcPhase = phase;

      // A swing is pumped by hauling in on the fast part of the arc and paying
      // out on the slow part. The gate is the tangential speed measured against
      // this swing's own running mean, which is orientation-independent - and
      // that matters, because an anchor is not always above you. Gating on "am I
      // below the anchor" instead silently stopped pumping on a floor-level
      // anchor: the rope pinned at maximum and the mote swung in one place
      // forever, which is exactly the stall this was found by.
      const tang = this.speed;
      this.swingRef = this.swingRef > 1 ? damp(this.swingRef, tang, 1.1, dt) : Math.max(tang, 1);
      const rel = (tang - this.swingRef) / Math.max(120, this.swingRef * 0.75);
      // A little extra when hanging under the anchor, so it still *reads* as
      // hauling in at the bottom of the arc in the common overhead case.
      const pumpK = smoothstep(clamp01(0.5 + rel)) * (0.70 + 0.30 * clamp01(phase));
      this.pumpK = pumpK;

      const ramp = clamp01(this.holdTime / P.reelRamp);
      const peak = lerp(P.reelBase, P.reelMax, ramp);
      const floor = this._ropeFloor();
      let rate = peak * pumpK - P.payOut * (1 - pumpK);
      if (this.rope < floor) {
        // Overloaded: the line lets out until it can carry this speed. Costs
        // energy through the same 1/r law that reeling in gains it.
        rate = -Math.max(P.payOut * 0.6, (floor - this.rope) * 2.2);
      } else if (rate > 0 && this.rope - rate * dt < floor) {
        rate = (this.rope - floor) / dt;
      }
      const ropePrev = this.rope;
      this.rope = clamp(this.rope - rate * dt, 60, P.ropeMax);

      // Wind-up: stored energy, and the readable tell that a launch is loaded.
      this.windUpRate = pumpK * P.windUpRate - P.windUpBleed;
      this.windUp = clamp01(this.windUp + this.windUpRate * dt);

      // gravity + drag
      this.vy += P.gravity * dt;
      this._drag(dt, Math.abs(this.spin));

      // "swim": a small tangential push along the arc. Without it a mote that
      // ends up hanging dead-centre under an anchor has no way out - gravity is
      // purely radial there, so the constraint eats all of it. With it, every
      // swing has authority and the pendulum always recovers.
      {
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
      const dx = this.x - a.x, dy = this.y - a.y;
      const d = Math.hypot(dx, dy) || 1e-4;
      const nx = dx / d, ny = dy / d;
      const err = d - this.rope;
      this.x -= nx * err * P.stiffness;
      this.y -= ny * err * P.stiffness;
      const radial = this.vx * nx + this.vy * ny;
      this.vx -= nx * radial;
      this.vy -= ny * radial;

      // Exact angular-momentum conservation across the length change. Same
      // equation both ways, so the pump cannot be gamed by holding.
      if (ropePrev !== this.rope && this.rope > 1) {
        const gain = clamp(ropePrev / this.rope, 0.94, 1.06);
        this.vx *= gain; this.vy *= gain;
      }

      this.spin = (this.vx * -ny + this.vy * nx) / Math.max(this.rope, 1);
      // Tension: centripetal plus the component of gravity along the line.
      this.ropeStrain = clamp01((this.spin * this.spin * this.rope + P.gravity * ny) / (P.gravity * 2.6));
      this.releaseWindow = this._launchQ();
      this.releaseValue = this.releaseWindow * (0.35 + 0.65 * this.windUp);
    } else {
      this.vy += P.gravity * dt;
      this._drag(dt, 0);
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.spin = damp(this.spin, 0, 2.5, dt);
      this.windUp = damp(this.windUp, 0, 3.0, dt);
      this.windUpRate = 0;
      this.pumpK = 0;
      this.ropeStrain = 0;
      this.releaseWindow = 0;
      this.releaseValue = 0;
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

  _drag(dt, spinAbs) {
    const s = Math.hypot(this.vx, this.vy);
    if (s > 1e-3) {
      // Spin drag makes a tight fast circle cost more than a wide arc at the
      // same speed, which is what stops "reel to the stop and whirl" being free.
      const dec = (P.dragQuad * s * s + P.dragLin * s + P.dragSpin * spinAbs * s) * dt;
      const k = Math.max(0, 1 - dec / s);
      this.vx *= k; this.vy *= k;
    }
  }

  /**
   * Catching a line is lossy: a rope can only pull, so whatever velocity points
   * along it is gone. Grabbing while already travelling across the anchor keeps
   * everything; grabbing while flying straight at it costs most of your speed.
   * That makes *which* anchor and *when* a real choice, and the jolt sells it.
   */
  _attach(a, fx) {
    const dx = this.x - a.x, dy = this.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-4;
    const nx = dx / d, ny = dy / d;
    const s = this.speed || 1;
    const radial = this.vx * nx + this.vy * ny;
    const tx = -ny, ty = nx;
    const tang = this.vx * tx + this.vy * ty;
    const sgn = Math.abs(tang) < 24 ? (tx >= 0 ? 1 : -1) : (tang >= 0 ? 1 : -1);

    this.catchQ = clamp01(Math.abs(tang) / s);
    this.catchJolt = clamp01(Math.abs(radial) / 1400);
    // Hand a little of the doomed radial speed to the tangent, so a mediocre
    // catch is a glancing blow rather than a dead stop.
    const newTang = tang + Math.abs(radial) * P.catchKeep * sgn;
    this.vx = tx * newTang;
    this.vy = ty * newTang;

    this.anchor = a;
    this.rope = Math.min(P.ropeMax, d);
    this.holdTime = 0;
    this.swingRef = this.speed;         // the pump's datum starts at this swing
    this.catchSeq++;
    a.used++;
    fx.sound('attach', { pan: 0, speed: s, q: this.catchQ });
    fx.ring(a.x, a.y, 0.8 + this.catchJolt * 0.7);
    fx.sparks(this.x, this.y, 7 + Math.round(this.catchJolt * 12),
      this.vx * 0.15, this.vy * 0.15, 'attach');
    if (this.catchJolt > 0.30) fx.shake(this.catchJolt * 0.22);
    if (this.catchJolt > 0.55) this._pinch(fx, 0.40, 0.07);
  }

  release(fx) {
    if (!this.attached) return;
    const a = this.anchor;
    const dx = this.x - a.x, dy = this.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const tx = -dy / d, ty = dx / d;
    const along = Math.sign(this.vx * tx + this.vy * ty) || 1;

    const q = this._launchQ();
    const wu = this.windUp;
    const s0 = this.speed;
    // Commitment. A well-timed, fully wound release is worth >20x the impulse of
    // a panicked one, which is the entire skill expression on one button. The
    // load gate is what stops tap-tap-tap reading as a jet engine: an impulse
    // you did not charge is not an impulse.
    const mag = P.releaseBoost
      * (P.releaseFloor + (1 - P.releaseFloor) * q)
      * (0.15 + 0.85 * wu)
      * clamp01(this.holdTime / P.loadTime)
      * (0.72 + 0.28 * clamp01(s0 / 1600));
    this.vx += tx * along * mag;
    this.vy += ty * along * mag;

    this.anchor = null;
    this.sinceRelease = 0;
    this.releaseQ = q;
    this.launchPow = clamp01(mag / P.releaseBoost);
    this.launchGlow = 0.42 + 0.58 * q;
    this.windUp = 0;                    // spent
    this.launchSeq++;
    const s = this.speed || 1;
    this.launchDirX = this.vx / s; this.launchDirY = this.vy / s;

    fx.sound('release', { speed: s, q });
    fx.sparks(this.x, this.y, 10 + Math.round(q * 16), this.vx * 0.22, this.vy * 0.22, 'release');
    fx.ring(this.x, this.y, 0.55 + q * 0.55);
    fx.shake(clamp01(s / 2600) * 0.08 + q * this.launchPow * 0.16);
    // The one moment in the game: a great release earns a held breath.
    if (q > 0.70 && wu > 0.45 && s > 700) this._pinch(fx, 0.52, 0.085);
    a.used++;
  }

  _walls(dt, world, fx) {
    const top = world.bandTop(this.x) + P.radius;
    const bot = world.bandBot(this.x) - P.radius;

    // The vent field. Modelled as a current with a velocity target rather than
    // a force fighting gravity: a force finds an equilibrium and parks you on
    // the floor forever, a current cannot. Down here the water is going up, and
    // it takes you with it. The sharp falloff keeps the low line a gamble
    // rather than free lift - it throws you, it does not hold you.
    // Scaled to the band with only a token clamp: an absolute floor here is a
    // trap, because in a narrow corridor it makes the column tall enough to pin
    // the mote against the *ceiling*, where wall friction eats all its speed.
    const bandH = Math.max(300, bot - top);
    const ventH = clamp(bandH * P.ventSpan, 120, 620);
    const overFloor = bot - this.y;
    if (overFloor < ventH) {
      const k = Math.pow(clamp01(1 - overFloor / ventH), P.ventFalloff);
      this.inDraft = k;
      const flowY = clamp(bandH * P.ventFlowK, 1100, 3000);
      const pull = 1 - Math.exp(-P.ventRate * k * dt);
      this.vy += (-flowY - this.vy) * pull;
      if (this.vx < P.ventFlowX) this.vx += (P.ventFlowX - this.vx) * pull * 0.55;
      this.ventEmit += dt * k * 11;
      while (this.ventEmit >= 1) { this.ventEmit -= 1; fx.bubbles(this.x, this.y + 20, 2); }
    } else { this.inDraft = 0; this.ventEmit = 0; }

    let hit = 0, hy = 0;
    // Friction is exponential in dt, so a bounce costs a little speed instead of
    // everything - the old per-step multiply was fatal at 120Hz. It is also only
    // charged on frames that are actually driving *into* the wall: charging it
    // while merely resting against one turns any pin into a dead stop, which is
    // how a mote held on the ceiling by a current lost all forward speed.
    const rub = Math.exp(-P.wallFrictionRate * (1 - this.inDraft * 0.8) * dt);
    if (this.y < top) {
      this.y = top;
      if (this.vy < 0) { hy = 1; hit = -this.vy; this.vy = -this.vy * P.wallRestitution; this.vx *= rub; }
    } else if (this.y > bot) {
      this.y = bot;
      if (this.vy > 0) { hy = -1; hit = this.vy; this.vy = -this.vy * P.wallRestitution; this.vx *= rub; }
    }
    if (hit > 140) {
      const s = hit + Math.abs(this.vx) * 0.3;
      this.impactSeq++;
      this.impactNx = 0; this.impactNy = hy;      // wall normal, pointing inward
      this.impactPow = clamp01(s / 2000);
      fx.sparks(this.x, this.y, 10 + ((s / 180) | 0), this.vx * 0.2, hy * 190, 'wall');
      fx.shake(0.10 + this.impactPow * 0.30);
      fx.sound('wall', { speed: s });
      if (this.impactPow > 0.42) this._pinch(fx, 0.46, 0.075);
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
        this.chainPop = 1;
        this.energy = clamp01(this.energy + 0.06);
        fx.burst(p.x, p.y, 'plankton', this.mult);
        fx.sound('pickup', { pitch: clamp(this.chain, 0, 24) });
        // Crossing a multiplier step is worth feeling.
        const step = Math.floor(this.chain / 3);
        if (step > this.chainStep) {
          this.chainStep = step;
          fx.shake(0.09);
          fx.ring(this.x, this.y, 0.9);
        }
        // a whisper of forward assist keeps chains flowing
        const s = this.speed || 1;
        this.vx += (this.vx / s) * 16; this.vy += (this.vy / s) * 16;
      }
    }
  }

  /**
   * Normalised distance to a hazard's lethal shape; < 1 is a hit. Urchins are a
   * disc because their shell is one. A jellyfish bell is drawn wider than it is
   * tall with its mass *above* the entity origin, so a plain circle both killed
   * in the clear water under the margin and ate the shoulders you should be
   * able to shave. Matching the art is a fairness fix, not a tuning one.
   */
  _killU(h) {
    if (h.kind === KIND.JELLY) {
      const ax = h.r * 0.74 + P.radius, ay = h.r * 0.62 + P.radius;
      const dx = (this.x - h.x) / ax, dy = (this.y - (h.y - h.r * 0.20)) / ay;
      return Math.hypot(dx, dy);
    }
    return Math.hypot(this.x - h.x, this.y - h.y) / (h.r * 0.62 + P.radius);
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
      if (d > h.r * P.brushDist + P.radius + 8) continue;

      if (this._killU(h) < 1) { this.die(fx, 'hazard', h); return; }

      const kill = h.r * 0.62 + P.radius;
      const graze = h.r * P.brushDist + P.radius;
      if (d < graze && !h.brushed) {
        h.brushed = true;
        // How nearly it killed you is how good it should feel.
        const close = clamp01(1 - (d - kill) / Math.max(1, graze - kill));
        this.brushGlow = 0.55 + 0.45 * close;
        this.chain += 0.4 + 0.8 * close;
        this._pinch(fx, 0.30 + 0.42 * close, 0.10 + 0.06 * close);
        fx.flash(0.06 + 0.08 * close, [0.9, 0.35, 0.55]);
        fx.shake(0.10 + 0.22 * close);
        fx.sound('brush', { close });
        fx.sparks(this.x, this.y, 6 + Math.round(close * 10), -dx * 0.4, -dy * 0.4, 'brush');
      }
    }
  }

  die(fx, cause, src) {
    if (!this.alive) return;
    this.alive = false;
    this.anchor = null;
    this.deathT = 0;
    this.deathCause = cause;
    this.deathSrc = src || null;
    this.windUp = 0;
    this.impactSeq++;
    const s = this.speed || 1;
    this.impactNx = -this.vx / s; this.impactNy = -this.vy / s;
    this.impactPow = 1;
    fx.burst(this.x, this.y, 'death', 1);
    fx.shake(0.85);
    fx.flash(0.55, cause === 'hush' ? [0.45, 0.2, 0.95] : [1, 0.35, 0.5]);
    fx.wave(this.x, this.y, 1);
    fx.sound('death', { cause });
    fx.slowmo(0.34, 1.1);
  }
}

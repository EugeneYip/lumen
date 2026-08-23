// Procedural trench. Rolling generation off a single seeded stream, so a given
// seed always produces the same run - which is what makes screenshots
// comparable between iterations.
import { makeRng, fbm1, noise1 } from '../engine/rng.js';
import { clamp, clamp01, lerp, smoothstep, TAU } from '../engine/math.js';

export const KIND = { ANCHOR: 0, URCHIN: 1, JELLY: 2, PLANKTON: 3, KELP: 4, SPIRE: 5, ANEMONE: 6 };

const GEN_AHEAD = 3200;        // world units of lookahead to keep populated
const START_SAFE = 900;        // no hazards before this x

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

    this.genX = -600;
    this.hushX = -2600;
    this.difficulty = 0;

    this.populate(1600);
  }

  // ---- trench profile ------------------------------------------------------
  /** Ceiling of the swimmable band. */
  bandTop(x) {
    const n = fbm1(x * 0.00042 + this.noiseOff, 4);
    const n2 = noise1(x * 0.00011 + this.noiseOff * 0.7);
    return -880 - n * 420 - n2 * 260;
  }
  /** Floor of the swimmable band. */
  bandBot(x) {
    const n = fbm1(x * 0.00051 + this.noiseOff + 51.3, 4);
    const n2 = noise1(x * 0.00013 + this.noiseOff * 1.9);
    return 640 + n * 300 + n2 * 220;
  }

  difficultyAt(x) { return clamp01(x / 42000); }

  // ---- generation ---------------------------------------------------------
  populate(untilX) {
    const r = this.rng;
    while (this.genX < untilX) {
      const x = this.genX;
      const d = this.difficultyAt(x);
      this.difficulty = d;
      const top = this.bandTop(x), bot = this.bandBot(x);
      const h = bot - top;

      // --- anchor: the load-bearing object. Spacing grows with difficulty. ---
      const spacing = lerp(360, 620, d) * r.range(0.82, 1.18);
      const ay = top + h * r.range(0.06, 0.34);
      const big = r.chance(0.16);
      this.anchors.push({
        kind: KIND.ANCHOR, x, y: ay,
        r: big ? r.range(30, 38) : r.range(19, 26),
        stalk: ay - top,                       // how far it hangs from the roof
        phase: r() * TAU,
        sway: r.range(0.5, 1.25),
        hue: r.range(-0.04, 0.05),
        pulse: r.range(0.7, 1.5),
        used: 0, alive: true, big,
      });

      // --- plankton drifts: reward for taking the tight line ---
      if (r.chance(0.72)) {
        const cx = x + r.range(80, 300);
        const cy = top + h * r.range(0.22, 0.86);
        const n = r.int(3, 7);
        const spread = r.range(60, 170);
        const arc = r.range(-1, 1);
        for (let i = 0; i < n; i++) {
          const t = n === 1 ? 0.5 : i / (n - 1);
          this.plankton.push({
            kind: KIND.PLANKTON,
            x: cx + (t - 0.5) * spread * 2,
            y: cy + Math.sin(t * Math.PI) * arc * spread * 0.7,
            r: 13, phase: r() * TAU, taken: false, bob: r.range(0.6, 1.4),
          });
        }
      }

      // --- hazards ---
      if (x > START_SAFE) {
        const urchinP = lerp(0.16, 0.52, d);
        if (r.chance(urchinP)) {
          const onFloor = r.chance(0.55);
          this.hazards.push({
            kind: KIND.URCHIN,
            x: x + r.range(40, 320),
            y: onFloor ? bot - r.range(10, 70) : top + r.range(20, 90),
            r: r.range(40, 68), phase: r() * TAU, spin: r.range(-0.3, 0.3),
            floor: onFloor, alive: true,
          });
        }
        const jellyP = lerp(0.05, 0.40, d);
        if (r.chance(jellyP)) {
          const cy = top + h * r.range(0.3, 0.7);
          this.hazards.push({
            kind: KIND.JELLY,
            x: x + r.range(60, 300), y: cy, y0: cy,
            r: r.range(34, 52),
            amp: r.range(70, 210), freq: r.range(0.16, 0.42), phase: r() * TAU,
            bellPhase: r() * TAU, alive: true,
          });
        }
      }

      // --- decor: kelp on the floor, spires, anemones ---
      const kelpN = r.int(1, 3);
      for (let i = 0; i < kelpN; i++) {
        const kx = x + r() * spacing;
        this.decor.push({
          kind: KIND.KELP, x: kx, y: this.bandBot(kx),
          h: r.range(180, 620), w: r.range(5, 13),
          phase: r() * TAU, sway: r.range(0.35, 0.9), lean: r.range(-0.35, 0.35),
          segs: 9, glow: r.chance(0.34) ? r.range(0.25, 0.8) : 0,
          depth: r.range(0.05, 0.55),
        });
      }
      if (r.chance(0.45)) {
        const sx = x + r() * spacing;
        const up = r.chance(0.5);
        this.decor.push({
          kind: KIND.SPIRE, x: sx, y: up ? this.bandBot(sx) : this.bandTop(sx),
          h: r.range(140, 460), w: r.range(50, 150), up,
          depth: r.range(0.1, 0.7), lean: r.range(-0.2, 0.2),
        });
      }
      if (r.chance(0.30)) {
        const ax = x + r() * spacing;
        const up = r.chance(0.6);
        this.decor.push({
          kind: KIND.ANEMONE, x: ax, y: up ? this.bandBot(ax) - 8 : this.bandTop(ax) + 8,
          r: r.range(16, 40), phase: r() * TAU, up,
          hue: r.range(0, 1) < 0.6 ? 0 : 1, depth: r.range(0.0, 0.4),
        });
      }

      this.genX += spacing;
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

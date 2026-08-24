// LUMEN — boot, game loop, state machine, and the deterministic capture API.
import { createContext, Blend } from './engine/gl.js';
import { buildAll } from './engine/textures.js';
import { Post } from './engine/postfx.js';
import { Input } from './engine/input.js';
import { Audio } from './engine/audio.js';
import { clamp, clamp01, lerp, damp, smoothstep } from './engine/math.js';
import { PAL } from './art/palette.js';
import { World } from './game/world.js';
import { Player, P as PP } from './game/player.js';
import { Particles, Ambient } from './game/particles.js';
import { Camera } from './game/camera.js';
import { Scene } from './game/render.js';
import { Background } from './game/background.js';
import { Hud } from './game/hud.js';
import { SpriteDebug } from './engine/sprites.js';
import { RibbonDebug } from './engine/ribbons.js';

const FIXED = 1 / 120;
const MAX_STEPS = 8;
const METRES = 1 / 10;          // world units -> metres

class Game {
  constructor(opts) {
    this.headless = opts.headless;
    this.seed = opts.seed;

    this.glCanvas = document.getElementById('gl');
    this.hudCanvas = document.getElementById('hud');
    const { gl, caps } = createContext(this.glCanvas);
    this.gl = gl; this.caps = caps;

    this.tex = buildAll(gl);
    this.post = new Post(gl, this.tex);
    this.scene = new Scene(gl, this.tex);
    this.bg = new Background(gl, this.tex);
    this.cam = new Camera();
    this.hud = new Hud(this.hudCanvas);
    this.input = new Input(window);
    this.audio = new Audio();
    this.audio.silent = !!opts.headless;   // captures must not touch WebAudio

    // Headless capture must depend on the seed and nothing else. `best` is a
    // frameCtx field the HUD renders, so reading a machine-persistent record
    // here would make captured pixels differ between machines and between runs
    // that happen to beat it.
    this.best = opts.headless ? 0 : (Number(localStorage.getItem('lumen.best') || 0) || 0);
    this.muted = localStorage.getItem('lumen.muted') === '1';

    this.mode = 'title';        // title | play | dead | paused
    this.t = 0;                 // monotonic sim clock, never reset (seek bookkeeping)
    this.runT = 0;              // per-run animation clock; everything visual uses this
    this.acc = 0;
    this.slow = 0;              // 0..1 time dilation
    this.hitstop = 0;
    this.flash = 0; this.flashCol = [1, 1, 1];
    this.fade = 1;
    this.waves = [{ x: 0, y: 0, t: 0, dur: 1, live: false }, { x: 0, y: 0, t: 0, dur: 1, live: false }];
    this.topSpeed = 0;
    this.bestMult = 1;
    this.envDim = 1;

    this.newRun(true);
    this.fx = this._makeFx();
    this._bindKeys();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  // ---------------------------------------------------------------- lifecycle ---
  newRun(initial = false) {
    this.world = new World(this.seed);
    this.player = new Player();
    this.particles = new Particles(this.seed);
    this.ambient = new Ambient(this.seed, 210);
    this.cam.snapTo(this.player.x + 300, this.player.y);
    this.cam.trauma = 0;
    this.runT = 0;
    this.acc = 0;
    this.topSpeed = 0;
    this.bestMult = 1;
    this.envDim = 1;
    this.flash = 0;
    this.fade = 1;
    this.slow = 0;
    this.deadT = 0;
    this.startGrace = 1.4;
    this._apPeak = 0;
    this._seekEntryDepth = 0;
    if (!initial) this.hud.deathT = 0;
  }

  startPlay() {
    this.newRun();
    this.mode = 'play';
    this.audio.init();
    this.audio.play('start');
    this.flash = 0.22; this.flashCol = [0.55, 0.85, 1];
  }

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM') { this.muted = !this.muted; this.audio.setMuted(this.muted); localStorage.setItem('lumen.muted', this.muted ? '1' : '0'); }
      if (e.code === 'KeyP' && (this.mode === 'play' || this.mode === 'paused')) {
        this.mode = this.mode === 'paused' ? 'play' : 'paused';
      }
      if (e.code === 'KeyR' && this.mode !== 'title') this.startPlay();
    });
  }

  _resize() {
    const w = window.innerWidth || 1280, h = window.innerHeight || 720;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.max(2, Math.round(w * dpr)), ph = Math.max(2, Math.round(h * dpr));
    this.glCanvas.width = pw; this.glCanvas.height = ph;
    this.glCanvas.style.width = w + 'px'; this.glCanvas.style.height = h + 'px';
    this.post.resize(pw, ph);
    this.cam.resize(pw, ph);
    this.hud.resize(w, h, dpr);
    this.cssW = w; this.cssH = h;
  }

  // ----------------------------------------------------------------------- fx ---
  _makeFx() {
    const g = this;
    return {
      sparks: (x, y, n, bx, by, flavour) => g.particles.sparks(x, y, n, bx, by, flavour),
      burst: (x, y, flavour, mult) => g.particles.burst(x, y, flavour, mult),
      ring: (x, y, s, col, b) => g.particles.ring(x, y, s, col, b),
      bubbles: (x, y, n) => g.particles.bubbles(x, y, n),
      shake: (a) => g.cam.addTrauma(a),
      flash: (a, col) => { g.flash = Math.max(g.flash, a); if (col) g.flashCol = col; },
      slowmo: (amount, dur) => { g.slow = Math.max(g.slow, amount); g.slowDur = dur; },
      wave: (x, y) => {
        const w = g.waves.find(w => !w.live) || g.waves[0];
        w.live = true; w.x = x; w.y = y; w.t = 0; w.dur = 0.85;
      },
      sound: (name, opts) => g.audio.play(name, opts),
    };
  }

  // -------------------------------------------------------------------- step ---
  step(dt) {
    const p = this.player, w = this.world;
    this.t += dt;

    if (this.mode === 'title') {
      // slow drift so the title screen is alive, not a screenshot
      this.runT += dt;
      w.update(dt, this.runT, 600);
      this.particles.update(dt);
      const cx = 520 + Math.sin(this.runT * 0.09) * 240;
      const cy = -180 + Math.sin(this.runT * 0.07 + 1.3) * 130;
      this.cam.update(dt, { x: cx, y: cy, vx: 120, vy: 0 }, { leadScale: 0.2, zoomOut: 0.12 });
      w.hushX = -3200;
      this._decay(dt);
      return;
    }
    if (this.mode === 'paused') return;

    this.runT += dt;

    if (this.mode === 'play') {
      p.update(dt, w, this.input, this.fx, this.runT);
      this.topSpeed = Math.max(this.topSpeed, p.speed);
      this.bestMult = Math.max(this.bestMult, p.mult);
      if (!p.alive) {
        this.mode = 'dead';
        this.deadT = 0;
        const d = p.maxX * METRES;
        if (d > this.best) {
          this.best = d;
          if (!this.headless) localStorage.setItem('lumen.best', String(d));
          this.audio.play('best');
        }
        this.envDim = 1;
      }
    } else if (this.mode === 'dead') {
      this.deadT += dt;
      p.update(dt, w, this.input, this.fx, this.runT); // no-op while dead, keeps timers moving
      this.envDim = damp(this.envDim, 0.42, 1.4, dt);
    }

    // --- the Hush ---
    this.startGrace = Math.max(0, this.startGrace - dt);
    if (this.startGrace <= 0 && this.mode === 'play') {
      const d = w.difficultyAt(p.x);
      const speed = lerp(196, 470, d);
      w.hushX += speed * dt;
      const maxLag = lerp(2900, 1750, d);
      if (p.x - w.hushX > maxLag) w.hushX = p.x - maxLag;
    }

    w.update(dt, this.runT, Math.max(p.x, w.hushX));
    this.particles.update(dt);

    // --- camera ---
    const hushProx = clamp01(1 - (p.x - w.hushX) / 1500);
    this.cam.update(dt, p, { zoomOut: hushProx * 0.10 });
    this.hushProx = hushProx;

    this._decay(dt);
  }

  _decay(dt) {
    this.flash = damp(this.flash, 0, 7.5, dt);
    this.slow = damp(this.slow, 0, this.slowDur ? 1 / Math.max(0.05, this.slowDur) * 2.2 : 4, dt);
    for (const w of this.waves) {
      if (!w.live) continue;
      w.t += dt;
      if (w.t >= w.dur) w.live = false;
    }
  }

  // ------------------------------------------------------------------ render ---
  /**
   * One object describing everything a renderer could want about this frame.
   * Every visual module receives this, so each one can be rewritten in place
   * without touching the others or this file.
   */
  frameCtx(frameDt) {
    const p = this.player, cam = this.cam;
    const speedK = clamp01((p.speedSmooth - 700) / 2000);
    return {
      // core handles
      gl: this.gl, cam, world: this.world, player: p,
      particles: this.particles, ambient: this.ambient, tex: this.tex, caps: this.caps,
      // clocks: `t` is run-relative so a replayed seed animates identically;
      // `simT` is the monotonic clock the capture harness seeks against.
      t: this.runT, simT: this.t, dt: frameDt, runT: this.runT, deadT: this.deadT,
      // state
      mode: this.mode, alive: p.alive,
      depth: Math.max(0, p.maxX * METRES), best: this.best,
      mult: p.mult, chain: p.chain, speed: p.speedSmooth, rawSpeed: p.speed,
      topSpeed: this.topSpeed, bestMult: this.bestMult,
      // derived signals every visual system wants
      speedK,
      hushProx: this.mode === 'play' ? (this.hushProx || 0) : 0,
      launchGlow: p.launchGlow, brushGlow: p.brushGlow, tetherGlow: p.tetherGlow,
      attached: p.attached, inDraft: p.inDraft || 0,
      difficulty: this.world.difficulty,
      // transient fx
      slow: this.slow, flash: this.flash, flashCol: this.flashCol,
      fade: this.fade, envDim: this.envDim, waves: this.waves,
      // viewport
      pixelW: cam.pixelW, pixelH: cam.pixelH, cssW: this.cssW, cssH: this.cssH,
    };
  }

  render(frameDt) {
    const gl = this.gl;
    const ctx = this.frameCtx(frameDt);

    this.post.beginScene();
    Blend.none(gl);
    this.bg.draw(ctx);
    this.scene.draw(ctx);
    this.post.render(ctx);
    this.hud.draw(ctx, frameDt);
  }

  // ----------------------------------------------------------------- autopilot ---
  /**
   * Deterministic policy used for headless capture and the attract mode.
   * Not trying to be optimal - trying to be a *competent* player, so captured
   * frames show the game as a decent human would leave it looking.
   */
  autopilot() {
    const p = this.player, w = this.world;
    if (!p.alive) return false;

    const top = w.bandTop(p.x), bot = w.bandBot(p.x);
    const mid = (top + bot) * 0.5;
    const lowInBand = p.y > lerp(mid, bot, 0.25);
    const danger = this._pathDanger(p, 0.42);

    if (p.attached) {
      // Release on the falling edge of releaseValue. The physics exposes that
      // signal precisely because the distance-optimal release is a narrow
      // interior optimum (10-25 degrees ahead of the anchor), so "ahead and
      // rising" - what this used to do - systematically let go too late.
      const v = p.releaseValue || 0;
      const falling = v < this._apPeak - 1e-4;
      this._apPeak = Math.max(this._apPeak * 0.995, v);
      const loaded = p.holdTime > PP.loadTime;
      if (loaded && v > 0.42 && falling) return false;
      if (p.holdTime > 2.2) return false;              // never hang indefinitely
      // Riding out a hazard beats launching into it, but only while the swing
      // is still carrying us forward.
      if (danger && p.holdTime < 1.4 && p.vx > 0) return true;
      return true;
    }

    this._apPeak = 0;
    const a = w.pickAnchor(p.x, p.y, p.vx, p.vy, PP.reach);
    if (!a) return false;
    const d = Math.hypot(a.x - p.x, a.y - p.y);
    // Grab early when sinking or threatened; otherwise wait for a tight radius.
    const gate = (lowInBand || danger || p.vy > 320) ? 0.99 : 0.88;
    return d < PP.reach * gate;
  }

  /** Would a straight ballistic guess in the next `horizon` seconds hit something? */
  _pathDanger(p, horizon) {
    const list = this.world.hazards;
    const steps = 5;
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      if (!h.alive) continue;
      if (h.x < p.x - 200) continue;
      if (h.x > p.x + 1400) break;
      for (let s = 1; s <= steps; s++) {
        const dt = (horizon * s) / steps;
        const px = p.x + p.vx * dt;
        const py = p.y + p.vy * dt + 0.5 * PP.gravity * dt * dt;
        const rr = h.r * 0.62 + PP.radius + 40;
        if ((px - h.x) ** 2 + (py - h.y) ** 2 < rr * rr) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- main loop ---
  frame(now) {
    const dtRaw = this._last == null ? FIXED : Math.min(0.25, (now - this._last) / 1000);
    this._last = now;

    // input edges: title/dead screens advance on press
    if (this.input.pressedEdge) {
      this.audio.init();
      if (this.mode === 'title') this.startPlay();
      else if (this.mode === 'dead' && this.deadT > 0.7) this.startPlay();
    }

    // Audio is driven by the wall clock, never by the fixed sim step: a single
    // frame can run many steps, and WebAudio automation does not enjoy that.
    this.audio.update(dtRaw, {
      intensity: clamp01(this.player.speedSmooth / 2000) * (this.mode === 'play' ? 1 : 0.2),
      danger: this.hushProx || 0,
    });

    const scale = (1 - this.slow * 0.82) * (this.hitstop > 0 ? 0 : 1);
    this.hitstop = Math.max(0, this.hitstop - dtRaw);
    this.acc += dtRaw * scale;
    let steps = 0;
    while (this.acc >= FIXED && steps < MAX_STEPS) { this.step(FIXED); this.acc -= FIXED; steps++; }
    if (steps === MAX_STEPS) this.acc = 0;

    this.input.endFrame();
    this.render(dtRaw);
  }

  /** Advance the sim to absolute time `target` with the autopilot driving. */
  async seekTo(target) {
    if (this.mode === 'title' && target > 0.4) { this.startPlay(); }
    let guard = 0;
    while (this.t < target && guard++ < 300000) {
      if (this.mode === 'dead' && this.deadT > 1.0) { this.startPlay(); }
      this.input.setSynthetic(this.autopilot());
      this.step(FIXED);
      this.input.endFrame();
    }
    await new Promise((res) => requestAnimationFrame(() => { this.render(FIXED); requestAnimationFrame(() => res()); }));
    return this.stats();
  }

  /**
   * Advance until `cond` holds (or maxT elapses). Lets the harness capture the
   * same *kind* of moment across iterations instead of the same clock time.
   */
  async seekUntil(cond, maxT = 90) {
    const tests = {
      tethered: () => this.player.attached && this.player.holdTime > 0.25,
      launch: () => this.player.launchGlow > 0.55,
      // `fast` used to be satisfied by the same frame as `launch` (a launch is
      // when you are fastest), so on some seeds two of the named moments were
      // byte-identical and A/B coverage was quietly one frame short.
      fast: () => this.player.alive && this.player.speed > 1500 && this.player.launchGlow < 0.15,
      hazardNear: () => this.player.alive && this._nearestHazard() < 260,
      hushNear: () => this.player.alive && (this.player.x - this.world.hushX) < 1100,
      // `deep` must describe a moment, not a threshold already crossed. maxX is
      // a run maximum that only resets in newRun(), so testing it alone made
      // this a latch: seeked after another scene had already carried the run
      // past 600m, it resolved on the very next step and produced a duplicate
      // of the previous frame on 7 of 11 seeds. Requiring progress *during this
      // seek* makes it a moment regardless of what ran before it.
      deep: () => this.player.maxX * METRES > Math.max(600, this._seekEntryDepth + 150),
      dead: () => this.mode === 'dead' && this.deadT > 0.9,
    };
    const test = tests[cond] || (() => true);
    if (this.mode === 'title') this.startPlay();
    this._seekEntryDepth = this.player.maxX * METRES;
    const limit = this.t + maxT;
    let guard = 0;
    while (this.t < limit && guard++ < 400000) {
      if (this.mode === 'dead' && this.deadT > 1.2 && cond !== 'dead') this.startPlay();
      this.input.setSynthetic(this.autopilot());
      this.step(FIXED);
      this.input.endFrame();
      if (test()) break;
    }
    await new Promise((res) => requestAnimationFrame(() => { this.render(FIXED); requestAnimationFrame(() => res()); }));
    return this.stats();
  }

  /**
   * Advance until the run has reached `metres`, restarting on death.
   *
   * Named scenes ("fast", "hazardNear") land wherever the physics happens to
   * put them, so as movement changes the same scene name captures a different
   * part of the level - which makes an A/B comparison between builds compare
   * content rather than rendering. Anchoring on distance fixes that.
   */
  async seekToDepth(metres, maxT = 240) {
    if (this.mode === 'title') this.startPlay();
    const limit = this.t + maxT;
    let guard = 0;
    while (this.t < limit && guard++ < 900000) {
      if (this.player.maxX * METRES >= metres && this.player.alive) break;
      if (this.mode === 'dead' && this.deadT > 1.2) this.startPlay();
      this.input.setSynthetic(this.autopilot());
      this.step(FIXED);
      this.input.endFrame();
    }
    await new Promise((res) => requestAnimationFrame(() => { this.render(FIXED); requestAnimationFrame(() => res()); }));
    return this.stats();
  }

  _nearestHazard() {
    const p = this.player;
    let best = 1e9;
    for (const h of this.world.hazards) {
      if (!h.alive) continue;
      if (h.x < p.x - 300) continue;
      if (h.x > p.x + 900) break;
      best = Math.min(best, Math.hypot(h.x - p.x, h.y - p.y) - h.r);
    }
    return best;
  }

  /**
   * Ground truth on the HDR scene *before* tonemapping. The environment and the
   * grade are authored by different people; without a shared measurement they
   * fight each other and the image runs away. Values are linear, unbounded.
   */
  hdrStats() {
    const gl = this.gl;
    const rt = this.post.scene;
    this.render(FIXED);
    const W = 96, H = 54;
    // Sample a coarse grid rather than the full buffer: enough for statistics,
    // cheap enough to call from a tuning loop.
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    const buf = new Float32Array(rt.w * 4);
    const rows = [];
    // Percentiles come from a coarse grid, which is plenty for distribution.
    // `max` must NOT: a hot emitter core is a handful of pixels, so a grid with
    // ~17px spacing misses it about 19 times in 20 and the >6 linear contract
    // fails at random. Scan every pixel of every row for the peak instead.
    let peak = 0;
    for (let y = 0; y < rt.h; y++) {
      gl.readPixels(0, y, rt.w, 1, gl.RGBA, gl.FLOAT, buf);
      for (let x = 0; x < rt.w * 4; x += 4) {
        const l = buf[x] * 0.2126 + buf[x + 1] * 0.7152 + buf[x + 2] * 0.0722;
        if (l > peak) peak = l;
      }
      // Keep the sparse sample for the distribution.
      if (((y * H) % rt.h) < H) {
        for (let j = 0; j < W; j++) {
          const x = Math.floor((j + 0.5) * rt.w / W) * 4;
          rows.push(buf[x] * 0.2126 + buf[x + 1] * 0.7152 + buf[x + 2] * 0.0722);
        }
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    rows.sort((a, b) => a - b);
    const q = (t) => rows[Math.min(rows.length - 1, Math.floor(t * rows.length))];
    const mean = rows.reduce((a, b) => a + b, 0) / rows.length;
    return {
      mean: +mean.toFixed(4), p10: +q(0.1).toFixed(4), p50: +q(0.5).toFixed(4),
      p90: +q(0.9).toFixed(4), p99: +q(0.99).toFixed(4), max: +peak.toFixed(3),
      note: 'linear HDR scene luminance, pre-tonemap; percentiles sampled, max exact',
    };
  }

  stats() {
    const p = this.player;
    return {
      mode: this.mode,
      x: Math.round(p.x), y: Math.round(p.y),
      depth: Math.round(p.maxX * METRES),
      speed: Math.round(p.speed),
      attached: p.attached,
      anchors: this.world.anchors.length,
      hazards: this.world.hazards.length,
      particles: this.particles.n,
      summary: `${this.mode} d=${Math.round(p.maxX * METRES)}m v=${Math.round(p.speed)} ${p.attached ? 'tethered' : 'free'}`,
    };
  }
}

export function boot() {
  const q = new URLSearchParams(location.search);
  const headless = q.get('headless') === '1';
  const seed = Number(q.get('seed') || 7) || 7;

  SpriteDebug.layers = q.get('debugLayers') === '1';
  SpriteDebug.off = q.get('noSprites') === '1';
  RibbonDebug.off = q.get('noRibbons') === '1';
  const game = new Game({ headless, seed });
  window.game = game;

  const bootEl = document.getElementById('boot');
  if (bootEl) bootEl.classList.add('gone');   // index.html owns removal

  if (headless) {
    // No rAF pump: the harness drives time explicitly for reproducible frames.
    game.render(FIXED);
    window.LUMEN = {
      ready: true,
      seekTo: (t) => game.seekTo(t),
      seekUntil: (c, m) => game.seekUntil(c, m),
      seekToDepth: (d, m) => game.seekToDepth(d, m),
      stats: () => game.stats(),
      hdrStats: () => game.hdrStats(),
      game,
    };
    return;
  }

  const loop = (now) => { game.frame(now); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.LUMEN = {
    ready: true, seekTo: (t) => game.seekTo(t), seekUntil: (c, m) => game.seekUntil(c, m),
    seekToDepth: (d, m) => game.seekToDepth(d, m),
    stats: () => game.stats(), hdrStats: () => game.hdrStats(), game,
  };
}

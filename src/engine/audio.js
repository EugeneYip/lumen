// Procedural audio. No files: every sound is synthesised, and the reverb tail
// is a generated impulse response, so the whole soundtrack costs zero bytes.
import { clamp, clamp01, lerp } from './math.js';
import { makeRng } from './rng.js';

const SCALE = [0, 2, 3, 7, 10, 12, 14, 15, 19, 22, 24]; // minor pentatonic-ish, two octaves
const ROOT = 55; // A1

export class Audio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.rng = makeRng(4242);
    this.silent = false;          // headless capture: never touch WebAudio
    this._autoT = 0;              // automation throttle
    this._intensity = 0;
    this._nextArp = 0;
    this._nextSwell = 4;
    this._t = 0;
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  init() {
    if (this.silent) return;
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { this.ctx = new AC({ latencyHint: 'interactive' }); } catch { return; }
    const c = this.ctx;

    this.master = c.createGain();
    this.master.gain.value = 0.0;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 24; comp.ratio.value = 5;
    comp.attack.value = 0.004; comp.release.value = 0.22;
    this.master.connect(comp).connect(c.destination);

    // --- generated reverb: exponentially decaying noise, slightly dark ---
    const dur = 3.2, sr = c.sampleRate;
    const ir = c.createBuffer(2, (sr * dur) | 0, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const env = Math.pow(1 - t / dur, 2.7) * Math.exp(-t * 0.9);
        const n = this.rng() * 2 - 1;
        lp += (n - lp) * 0.22;            // one-pole LP: underwater, not bright
        d[i] = lp * env * (i < sr * 0.012 ? i / (sr * 0.012) : 1);
      }
    }
    this.verb = c.createConvolver();
    this.verb.buffer = ir;
    this.verbGain = c.createGain(); this.verbGain.gain.value = 0.55;
    this.verb.connect(this.verbGain).connect(this.master);

    this.dry = c.createGain(); this.dry.gain.value = 0.9;
    this.dry.connect(this.master);

    // --- ambient bed ---
    this.bedGain = c.createGain(); this.bedGain.gain.value = 0.0;
    this.bedGain.connect(this.dry); this.bedGain.connect(this.verb);

    // pink-ish noise for water
    const nlen = (sr * 2.5) | 0;
    const nb = c.createBuffer(1, nlen, sr);
    const nd = nb.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < nlen; i++) {
      const w = this.rng() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      nd[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16;
    }
    const noise = c.createBufferSource();
    noise.buffer = nb; noise.loop = true;
    const nf = c.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 420; nf.Q.value = 0.7;
    const nf2 = c.createBiquadFilter(); nf2.type = 'highpass'; nf2.frequency.value = 60;
    const ng = c.createGain(); ng.gain.value = 0.55;
    noise.connect(nf).connect(nf2).connect(ng).connect(this.bedGain);
    noise.start();
    this.noiseFilter = nf;

    // two slow detuned drones
    this.drones = [];
    for (let i = 0; i < 3; i++) {
      const o = c.createOscillator();
      o.type = i === 2 ? 'triangle' : 'sine';
      o.frequency.value = ROOT * (i === 0 ? 1 : i === 1 ? 1.5 : 2.005) * (1 + (i - 1) * 0.002);
      const g = c.createGain(); g.gain.value = i === 2 ? 0.06 : 0.13;
      const lfo = c.createOscillator(); lfo.frequency.value = 0.03 + i * 0.017;
      const lg = c.createGain(); lg.gain.value = 0.05;
      lfo.connect(lg).connect(g.gain); lfo.start();
      o.connect(g).connect(this.bedGain);
      o.start();
      this.drones.push({ o, g });
    }

    this.ready = true;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, c.currentTime, 0.4);
    this.bedGain.gain.setTargetAtTime(0.5, c.currentTime, 2.0);
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.08);
  }

  _voice(type, freq, dur, gain, { attack = 0.004, filter = 0, q = 1, wet = 0.4, detune = 0, glide = 0 } = {}) {
    const c = this.ctx; if (!c) return;
    const now = c.currentTime;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, now);
    if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * glide), now + dur);
    if (detune) o.detune.value = detune;
    let node = o;
    if (filter) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.setValueAtTime(filter, now);
      f.frequency.exponentialRampToValueAtTime(Math.max(80, filter * 0.25), now + dur);
      f.Q.value = q;
      o.connect(f); node = f;
    }
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    node.connect(g);
    const dg = c.createGain(); dg.gain.value = 1 - wet;
    const wg = c.createGain(); wg.gain.value = wet;
    g.connect(dg).connect(this.dry);
    g.connect(wg).connect(this.verb);
    o.start(now); o.stop(now + dur + 0.05);
  }

  _noiseHit(dur, gain, freq, { hp = 0, wet = 0.4 } = {}) {
    const c = this.ctx; if (!c) return;
    const now = c.currentTime, sr = c.sampleRate;
    const n = Math.max(1, (sr * dur) | 0);
    const buf = c.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (this.rng() * 2 - 1) * Math.pow(1 - i / n, 2.2);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = hp ? 'highpass' : 'lowpass';
    f.frequency.setValueAtTime(freq, now);
    f.frequency.exponentialRampToValueAtTime(Math.max(90, freq * (hp ? 2.2 : 0.3)), now + dur);
    const g = c.createGain(); g.gain.value = gain;
    src.connect(f).connect(g);
    const dg = c.createGain(); dg.gain.value = 1 - wet;
    const wg = c.createGain(); wg.gain.value = wet;
    g.connect(dg).connect(this.dry);
    g.connect(wg).connect(this.verb);
    src.start(now);
  }

  play(name, opts = {}) {
    if (this.silent || !this.ready || this.muted) return;
    const n = (i) => ROOT * 4 * Math.pow(2, SCALE[i % SCALE.length] / 12);
    switch (name) {
      case 'attach':
        this._voice('triangle', n(3), 0.42, 0.16, { filter: 2600, wet: 0.45, attack: 0.003 });
        this._voice('sine', n(6), 0.30, 0.09, { wet: 0.6, attack: 0.002 });
        this._noiseHit(0.10, 0.06, 1800, { hp: 1, wet: 0.5 });
        break;
      case 'release': {
        const k = clamp01((opts.speed || 400) / 2200);
        this._voice('sawtooth', lerp(120, 300, k), 0.34, 0.10,
          { filter: lerp(900, 3400, k), q: 3, wet: 0.35, glide: 2.2 });
        this._noiseHit(0.26, 0.10 + k * 0.12, 900 + k * 2600, { hp: 1, wet: 0.35 });
        break;
      }
      case 'pickup': {
        const step = 4 + ((opts.pitch || 0) % 7);
        this._voice('sine', n(step) * 2, 0.30, 0.13, { wet: 0.55, attack: 0.002 });
        this._voice('sine', n(step) * 4, 0.16, 0.05, { wet: 0.6, attack: 0.001 });
        break;
      }
      case 'wall': {
        const k = clamp01((opts.speed || 300) / 1600);
        this._voice('sine', lerp(70, 130, k), 0.22, 0.14 + k * 0.1, { wet: 0.3, glide: 0.5 });
        this._noiseHit(0.16, 0.06 + k * 0.09, 700, { wet: 0.35 });
        break;
      }
      case 'brush':
        this._noiseHit(0.20, 0.10, 2600, { hp: 1, wet: 0.5 });
        this._voice('sine', n(9) * 2, 0.24, 0.06, { wet: 0.6 });
        break;
      case 'death':
        this._voice('sine', 62, 1.5, 0.30, { wet: 0.55, glide: 0.35 });
        this._voice('triangle', 41, 2.0, 0.18, { wet: 0.7, glide: 0.4 });
        this._noiseHit(1.2, 0.14, 1400, { wet: 0.7 });
        if (this.ctx) this.bedGain.gain.setTargetAtTime(0.18, this.ctx.currentTime, 0.5);
        break;
      case 'start':
        this._voice('sine', n(0) * 2, 0.9, 0.14, { wet: 0.6, attack: 0.02 });
        this._voice('sine', n(4) * 2, 1.1, 0.10, { wet: 0.65, attack: 0.06 });
        if (this.ctx) this.bedGain.gain.setTargetAtTime(0.5, this.ctx.currentTime, 1.2);
        break;
      case 'best':
        for (let i = 0; i < 3; i++) {
          setTimeout(() => this._voice('sine', n(4 + i * 2) * 2, 0.5, 0.10, { wet: 0.6 }), i * 90);
        }
        break;
    }
  }

  /** Ambient intensity follows speed; drives an occasional sparse arpeggio. */
  update(dt, { intensity = 0, danger = 0 } = {}) {
    if (this.silent || !this.ready) return;
    this._t += dt;
    this._autoT += dt;
    const writeAutomation = this._autoT >= 0.05;
    if (writeAutomation) this._autoT = 0;
    this._intensity = lerp(this._intensity, intensity, 1 - Math.exp(-dt * 1.5));
    const c = this.ctx;
    if (writeAutomation) {
      if (this.noiseFilter) {
        this.noiseFilter.frequency.setTargetAtTime(lerp(320, 1500, this._intensity), c.currentTime, 0.2);
      }
      for (let i = 0; i < this.drones.length; i++) {
        const base = i === 2 ? 0.06 : 0.13;
        this.drones[i].g.gain.setTargetAtTime(base * (1 + danger * 0.9), c.currentTime, 0.3);
      }
    }
    if (this._t > this._nextArp && this._intensity > 0.22) {
      this._nextArp = this._t + lerp(1.5, 0.42, this._intensity) * (0.7 + this.rng() * 0.6);
      const oct = this.rng() < 0.3 ? 4 : 2;
      const i = (this.rng() * SCALE.length) | 0;
      this._voice('sine', ROOT * 4 * Math.pow(2, SCALE[i] / 12) * oct * 0.5,
        lerp(0.8, 0.35, this._intensity), 0.035 + this._intensity * 0.035,
        { wet: 0.75, attack: 0.03 });
    }
    if (this._t > this._nextSwell) {
      this._nextSwell = this._t + 9 + this.rng() * 12;
      this._voice('sine', ROOT * (this.rng() < 0.5 ? 1 : 1.5), 5.5, 0.05,
        { wet: 0.85, attack: 1.6, glide: 0.86 });
    }
  }
}

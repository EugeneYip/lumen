// Procedural audio. No files: every sound, including both reverb impulse
// responses, is synthesised at boot, so the whole soundtrack costs zero bytes.
//
// Signal flow
//   voices -> _out(pan, dist) -> { dry | early send | tail send } -> mix
//   mix -> compressor -> tanh ceiling -> master(mute) -> destination
// Two reverbs, not one: a 0.3s early-reflection bus (with a cross-feed
// widener) puts events in a place, a 4.6s dark tail says how big that place is.
// `dist` on any voice trades dry+bright for wet+dull, which is the only honest
// way to get near/far out of a mono synth.
import { clamp, clamp01, lerp, damp } from './math.js';
import { makeRng } from './rng.js';

const SCALE = [0, 2, 3, 7, 10, 12, 14, 15, 19, 22, 24]; // kept: old callers index it
const ROOT = 55;                       // A1
const PENT = [0, 3, 5, 7, 10];         // A minor pentatonic: the pickup ladder

// Harmonic motion. One chord per bar of 32 steps, and the step shortens with
// speed, so the progression takes ~20s a chord when drifting and ~12s when the
// run is screaming. Nothing announces a change; the abyss just moves under you.
const PROG = [
  { r: 0, q: 0 },   // Am    home
  { r: 0, q: 0 },   // Am    stay: motion has to be earned
  { r: -4, q: 1 },  // F
  { r: 3, q: 1 },   // C
  { r: 5, q: 0 },   // Dm
  { r: -2, q: 1 },  // G
  { r: -4, q: 1 },  // F
  { r: 7, q: 2 },   // E     dominant, pulls back to Am
];
const PAD_MUL = [2, 2, 4, 4];          // pad sits 110-280Hz: the pressurised middle
// Lead rhythm over one 32-step bar. Weight, not a note: density is what
// intensity buys you, so the same figure reads as sparse or urgent.
const M_LEAD = [3, 0, 0, 1, 0, 0, 2, 0, 0, 1, 0, 0, 2, 0, 0, 1,
                0, 0, 3, 0, 0, 0, 1, 0, 2, 0, 1, 0, 0, 1, 0, 2];
const CONTOUR = [0, 2, 1, 3, 2, 4, 3, 5, 4, 2, 1, 0, 2, 3, 5, 4];

export class Audio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.silent = false;          // headless capture: never touch WebAudio
    this.rng = makeRng(4242);
    this._autoT = 0;              // automation throttle
    this._intensity = 0;
    this._danger = 0;
    this._t = 0;
    this._live = 0;               // run presence: 1 playing, ~0.13 dead
    this._liveT = 1;
    this._liveRate = 0.9;
    this._chainK = 0;             // decaying memory of the last plankton chain
    this._chord = 0;
    this._step = 0;
    this._nextStep = 0;           // ctx-time of the next sequencer step
    this._side = 1;
    this.drones = [];             // kept: field existed before
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  init() {
    if (this.silent) return;
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { this.ctx = new AC({ latencyHint: 'interactive' }); } catch { return; }
    const c = this.ctx, sr = c.sampleRate;
    const boot = this.rng.fork();  // keep megasample buffer fills off the runtime stream

    // ---------------------------------------------------------- master chain ---
    this.master = c.createGain();
    this.master.gain.value = 0;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -15; comp.knee.value = 20; comp.ratio.value = 4;
    comp.attack.value = 0.006; comp.release.value = 0.26;
    // tanh ceiling. A WaveShaper clamps to its curve endpoints outside [-1,1],
    // so this is a hard guarantee that nothing ever leaves above 0.94.
    const shaper = c.createWaveShaper();
    const NC = 2049, curve = new Float32Array(NC), drive = 1.8;
    const norm = 0.94 / Math.tanh(drive);
    for (let i = 0; i < NC; i++) curve[i] = Math.tanh(drive * ((i / (NC - 1)) * 2 - 1)) * norm;
    shaper.curve = curve; shaper.oversample = '4x';
    this.mix = c.createGain();
    this.mix.connect(comp).connect(shaper).connect(this.master).connect(c.destination);

    this.dry = c.createGain(); this.dry.gain.value = 0.9;
    this.dry.connect(this.mix);

    // ------------------------------------------------------------- two verbs ---
    this.earlyIn = c.createGain();
    const early = c.createConvolver();
    early.buffer = this._ir(c, boot, { dur: 0.30, pre: 0.004, decay: 11, lp: 0.55, shape: 1.6, taps: 9 });
    this.earlyGain = c.createGain(); this.earlyGain.gain.value = 0.58;
    this.earlyIn.connect(early).connect(this.earlyGain);
    // Haas cross-feed on the early bus only. Width lives in early reflections;
    // doing this to the dry bus would smear every transient in the game.
    const sp = c.createChannelSplitter(2), mg = c.createChannelMerger(2);
    this.earlyGain.connect(sp);
    sp.connect(mg, 0, 0); sp.connect(mg, 1, 1);
    const xL = c.createDelay(0.05), xR = c.createDelay(0.05);
    xL.delayTime.value = 0.0131; xR.delayTime.value = 0.0207;
    const xLg = c.createGain(), xRg = c.createGain();
    xLg.gain.value = 0.36; xRg.gain.value = -0.31;   // opposed polarity: decorrelated
    sp.connect(xL, 0).connect(xLg).connect(mg, 0, 1);
    sp.connect(xR, 1).connect(xRg).connect(mg, 0, 0);
    mg.connect(this.mix);

    this.tailIn = c.createGain();
    const tail = c.createConvolver();
    tail.buffer = this._ir(c, boot, { dur: 4.6, pre: 0.031, decay: 0.95, lp: 0.17, shape: 2.4, absorb: 0.8 });
    const thp = c.createBiquadFilter(); thp.type = 'highpass'; thp.frequency.value = 95;
    const tlp = c.createBiquadFilter(); tlp.type = 'lowpass'; tlp.frequency.value = 1900;
    this.tailGain = c.createGain(); this.tailGain.gain.value = 0.95;
    this.tailIn.connect(tail).connect(thp).connect(tlp).connect(this.tailGain).connect(this.mix);

    // ---------------------------------------------------------- shared noise ---
    // One buffer per colour, played from random offsets: a fresh buffer per
    // one-shot was an O(n) fill on the audio thread for no audible gain.
    this.nzP = this._noiseBuf(c, boot, 5.0, true);
    this.nzW = this._noiseBuf(c, boot, 3.0, false);

    // ----------------------------------------------------------- ambient bed ---
    this.bed = c.createGain(); this.bed.gain.value = 0;
    this.duck = c.createGain(); this.duck.gain.value = 1;
    this.bed.connect(this.duck);
    this.duck.connect(this.dry);
    const bedTail = c.createGain(); bedTail.gain.value = 0.42;
    this.duck.connect(bedTail).connect(this.tailIn);
    const bedEarly = c.createGain(); bedEarly.gain.value = 0.16;
    this.duck.connect(bedEarly).connect(this.earlyIn);

    // slow LFO bank, fanned out. Shared because 12 more oscillators for
    // 12 more wobbles is not a trade worth making.
    const lfo = [];
    for (let i = 0; i < 4; i++) {
      const o = c.createOscillator();
      o.frequency.value = [0.031, 0.047, 0.073, 0.113][i];
      o.type = i === 3 ? 'triangle' : 'sine';
      o.start(); lfo.push(o);
    }
    const mod = (i, depth, param) => { const g = c.createGain(); g.gain.value = depth; lfo[i].connect(g).connect(param); };

    // water: two independent noise streams hard-ish panned. Same buffer at
    // different offsets is genuinely decorrelated, which is the whole stereo
    // image right here - one mono noise source can never be wide.
    this.bedLp = [];
    for (let i = 0; i < 2; i++) {
      const s = c.createBufferSource(); s.buffer = this.nzP; s.loop = true;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.value = 380 * (i ? 1.18 : 0.86); lp.Q.value = 0.7;
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 45;
      const p = c.createStereoPanner(); p.pan.value = i ? 0.82 : -0.82;
      const g = c.createGain(); g.gain.value = 0.5;
      mod(i, 0.1, g.gain);
      s.connect(lp).connect(hp).connect(g).connect(p).connect(this.bed);
      s.start(0, i * 2.3);
      this.bedLp.push(lp);
    }
    this.noiseFilter = this.bedLp[0];   // kept: field existed before

    // pressure surge: a slow low swell that never quite settles
    {
      const s = c.createBufferSource(); s.buffer = this.nzP; s.loop = true;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 165; bp.Q.value = 1.1;
      const g = c.createGain(); g.gain.value = 0.34;
      mod(2, 0.3, g.gain); mod(1, 40, bp.frequency);
      const p = c.createStereoPanner(); p.pan.value = 0.2;
      s.connect(bp).connect(g).connect(p).connect(this.bed);
      s.start(0, 1.1);
    }

    // flow: the rush of water past you. Two bands, both bought with speed.
    this.flow = [];
    for (let i = 0; i < 2; i++) {
      const s = c.createBufferSource(); s.buffer = this.nzP; s.loop = true;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = i ? 2400 : 760; bp.Q.value = i ? 0.8 : 1.4;
      const g = c.createGain(); g.gain.value = 0;
      const p = c.createStereoPanner(); p.pan.value = i ? -0.35 : 0.3;
      mod(3, i ? 90 : 30, bp.frequency);
      s.connect(bp).connect(g).connect(p).connect(this.bed);
      s.start(0, 3.4 + i);
      this.flow.push({ g: g.gain, bp: bp.frequency });
    }

    // sub: 55Hz and its octave down. Felt, not heard.
    this.sub = [];
    this.subGain = c.createGain(); this.subGain.gain.value = 0.5;
    const subHp = c.createBiquadFilter(); subHp.type = 'highpass'; subHp.frequency.value = 26;
    this.subGain.connect(subHp).connect(this.bed);
    for (let i = 0; i < 2; i++) {
      const o = c.createOscillator(); o.type = i ? 'sine' : 'triangle';
      o.frequency.value = ROOT * (i ? 0.5 : 1);
      const g = c.createGain(); g.gain.value = i ? 0.1 : 0.22;
      mod(i, i ? 0.03 : 0.05, g.gain);
      o.connect(g).connect(this.subGain); o.start();
      this.sub.push(o);
      this.drones.push({ o, g });
    }

    // pad: the chord itself, four voices each in its own place
    this.padBus = c.createGain();
    this.padFilter = c.createBiquadFilter();
    this.padFilter.type = 'lowpass'; this.padFilter.frequency.value = 700; this.padFilter.Q.value = 0.9;
    this.padGain = c.createGain(); this.padGain.gain.value = 0;
    this.padBus.connect(this.padFilter).connect(this.padGain).connect(this.bed);
    this.pad = [];
    for (let i = 0; i < 4; i++) {
      const o = c.createOscillator();
      o.type = i === 1 ? 'triangle' : i === 3 ? 'sawtooth' : 'sine';
      o.detune.value = (i - 1.5) * 4.5;          // static spread, never a chorus
      const g = c.createGain(); g.gain.value = [0.3, 0.22, 0.16, 0.09][i];
      const p = c.createStereoPanner(); p.pan.value = [-0.5, 0.55, 0.25, -0.7][i];
      mod(i % 4, 0.05, g.gain);
      mod((i + 1) % 4, 3.5, o.detune);
      o.connect(g).connect(p).connect(this.padBus); o.start();
      this.pad.push(o);
      this.drones.push({ o, g });
    }

    // shimmer: high chord tones, almost all reverb. Distant sparkle in the dark.
    this.shimBus = c.createGain();
    this.shimGain = c.createGain(); this.shimGain.gain.value = 0;
    this.shimBus.connect(this.shimGain);
    const shDry = c.createGain(); shDry.gain.value = 0.35;
    this.shimGain.connect(shDry).connect(this.bed);
    const shTail = c.createGain(); shTail.gain.value = 1.0;
    this.shimGain.connect(shTail).connect(this.tailIn);
    this.shim = [];
    for (let i = 0; i < 3; i++) {
      const o = c.createOscillator(); o.type = 'sine';
      const g = c.createGain(); g.gain.value = [0.09, 0.06, 0.045][i];
      const p = c.createStereoPanner(); p.pan.value = [-0.85, 0.9, 0.1][i];
      mod(i, 0.06, g.gain);
      o.connect(g).connect(p).connect(this.shimBus); o.start();
      this.shim.push(o);
    }

    // the Hush itself. It eats the world from the left, so it lives on the left.
    this.dangerBus = c.createGain(); this.dangerBus.gain.value = 0;
    const dgTail = c.createGain(); dgTail.gain.value = 0.7;
    this.dangerBus.connect(this.dry); this.dangerBus.connect(dgTail).connect(this.tailIn);
    {
      const s = c.createBufferSource(); s.buffer = this.nzP; s.loop = true;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 1.0;
      const g = c.createGain(); g.gain.value = 0.55;
      const p = c.createStereoPanner(); p.pan.value = -0.86;
      s.connect(bp).connect(g).connect(p).connect(this.dangerBus);
      s.start(0, 0.7);
      this.hushBp = bp.frequency;
    }
    this.dread = [];
    for (let i = 0; i < 2; i++) {   // minor second, beating: unease with no melody
      const o = c.createOscillator(); o.type = 'sine';
      const g = c.createGain(); g.gain.value = 0.07;
      const p = c.createStereoPanner(); p.pan.value = i ? -0.6 : -0.95;
      mod(3, 0.02, g.gain);
      o.connect(g).connect(p).connect(this.dangerBus); o.start();
      this.dread.push(o);
    }

    // chain pad: swells while plankton are being strung together
    this.chainBus = c.createGain(); this.chainBus.gain.value = 0;
    const cbTail = c.createGain(); cbTail.gain.value = 0.9;
    this.chainBus.connect(this.bed); this.chainBus.connect(cbTail).connect(this.tailIn);
    this.chainOsc = [];
    for (let i = 0; i < 2; i++) {
      const o = c.createOscillator(); o.type = 'triangle';
      const g = c.createGain(); g.gain.value = i ? 0.05 : 0.08;
      const p = c.createStereoPanner(); p.pan.value = i ? 0.45 : -0.4;
      o.connect(g).connect(p).connect(this.chainBus); o.start();
      this.chainOsc.push(o);
    }

    this.ready = true;
    this._nextStep = c.currentTime + 0.7;
    this._applyChord(c.currentTime, 0.05);
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.92, c.currentTime, 0.35);
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.92, this.ctx.currentTime, 0.015);
  }

  // ------------------------------------------------------------- buffer gen ---

  /** Decaying-noise impulse response. Channels are filled independently, so the
   *  tail is genuinely stereo instead of a doubled mono. `absorb` darkens the
   *  filter as the tail ages, which is what water actually does to a reverb. */
  _ir(c, rng, { dur, pre = 0, decay = 3, lp = 0.2, shape = 2.2, taps = 0, absorb = 0 }) {
    const sr = c.sampleRate, n = Math.max(2, (sr * dur) | 0), p = (sr * pre) | 0;
    const buf = c.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let z = 0;
      for (let i = p; i < n; i++) {
        const t = (i - p) / sr, u = t / dur;
        const env = Math.pow(1 - u, shape) * Math.exp(-t * decay);
        z += ((rng() * 2 - 1) - z) * lp * (1 - absorb * u);
        d[i] = z * env;
      }
      for (let k = 0; k < taps; k++) {          // discrete bounces: a place with walls
        const at = p + ((sr * (0.003 + rng() * dur * 0.55)) | 0);
        if (at < n) d[at] += (rng() * 2 - 1) * 0.5 * Math.exp(-k * 0.3);
      }
      const f = Math.min(n - p, (sr * 0.003) | 0);
      for (let i = 0; i < f; i++) d[p + i] *= i / f;   // no click on the pre-delay edge
    }
    return buf;
  }

  _noiseBuf(c, rng, dur, pink) {
    const sr = c.sampleRate, n = (sr * dur) | 0;
    const buf = c.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng() * 2 - 1;
      if (!pink) { d[i] = w * 0.6; continue; }
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16;
    }
    return buf;
  }

  // ----------------------------------------------------------------- voicing ---

  /** Place an event. `dist` 0..1 pushes it away: quieter, duller, far wetter.
   *  Returns the panner so callers can automate movement across the image. */
  _out(pan = 0, { dry = 1, early = 0.3, tail = 0.3, dist = 0 } = {}) {
    const c = this.ctx, d = clamp01(dist);
    const p = c.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
    let n = p;
    if (d > 0.02) {
      const f = c.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.value = lerp(7000, 330, d * d); f.Q.value = 0.5;
      p.connect(f); n = f;
    }
    const send = (v, dest) => {
      if (v <= 0.0008) return;
      const g = c.createGain(); g.gain.value = v; n.connect(g).connect(dest);
    };
    send(dry * (1 - d * 0.82), this.dry);
    send(early * (1 - d * 0.5), this.earlyIn);
    send(tail * (1 + d * 2.4), this.tailIn);
    return p;
  }

  /** attack/decay gain node. The final hard zero matters: an exponential ramp
   *  only ever approaches its floor, and 200 lingering tails is a mud machine. */
  _env(t0, a, d, peak, hold = 0) {
    const g = this.ctx.createGain(), p = Math.max(0.0004, peak);
    a = Math.max(0.0004, a); d = Math.max(0.004, d);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(p, t0 + a);
    if (hold > 0) g.gain.setValueAtTime(p, t0 + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0004, t0 + a + hold + d);
    g.gain.setValueAtTime(0, t0 + a + hold + d + 0.002);
    return g;
  }

  _nz(t0, dur, pink = true) {
    const c = this.ctx, b = pink ? this.nzP : this.nzW;
    const s = c.createBufferSource(); s.buffer = b; s.loop = true;
    s.start(t0, this.rng() * (b.duration - 0.05));
    s.stop(t0 + dur + 0.03);
    return s;
  }

  /** Band-swept noise. Every water sound in the game is one of these. */
  _swish(t0, out, { dur = 0.2, f0 = 800, f1 = 2000, f2 = 0, q = 1, gain = 0.1, a = 0.004, hold = 0, pink = true, type = 'bandpass' }) {
    const c = this.ctx;
    const s = this._nz(t0, dur + a + hold, pink);
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(Math.max(20, f0), t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + (f2 ? (dur + hold) * 0.4 : dur + hold));
    if (f2) f.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t0 + dur + hold + a);
    s.connect(f).connect(this._env(t0, a, dur, gain, hold)).connect(out);
  }

  /** Two-operator FM. The cheapest way to stop everything sounding like the
   *  same sine: the index envelope gives a bright attack that darkens. */
  _fm(t0, freq, out, { ratio = 2, index = 300, dur = 0.4, a = 0.003, gain = 0.1, decay = 0.12, glide = 0, hold = 0 }) {
    const c = this.ctx;
    const car = c.createOscillator(), m = c.createOscillator();
    car.frequency.setValueAtTime(freq, t0);
    m.frequency.setValueAtTime(freq * ratio, t0);
    if (glide) {
      car.frequency.exponentialRampToValueAtTime(Math.max(18, freq * glide), t0 + dur + hold);
      m.frequency.exponentialRampToValueAtTime(Math.max(18, freq * ratio * glide), t0 + dur + hold);
    }
    const mgn = c.createGain();
    mgn.gain.setValueAtTime(index, t0);
    mgn.gain.exponentialRampToValueAtTime(Math.max(0.5, index * 0.03), t0 + Math.max(0.01, decay));
    m.connect(mgn).connect(car.frequency);
    car.connect(this._env(t0, a, dur, gain, hold)).connect(out);
    car.start(t0); car.stop(t0 + dur + hold + a + 0.06);
    m.start(t0); m.stop(t0 + dur + hold + a + 0.06);
  }

  /** Additive bell: partials with their own decays, short ones on top. */
  _bell(t0, freq, out, { gain = 0.1, dur = 0.6, a = 0.002, parts = null, bright = 0 }) {
    const c = this.ctx;
    const P = parts || [[1, 1, 1], [2, 0.3, 0.5], [3.01, 0.13, 0.3], [4.76, 0.05 + bright * 0.1, 0.14]];
    for (let i = 0; i < P.length; i++) {
      const f = freq * P[i][0];
      if (f > 15000) continue;
      const o = c.createOscillator(); o.frequency.value = f;
      const d = dur * P[i][2];
      o.connect(this._env(t0, a, d, gain * P[i][1])).connect(out);
      o.start(t0); o.stop(t0 + d + a + 0.05);
    }
  }

  /** Glide tone. Mass, drops, thumps: anything with weight starts here. */
  _tone(t0, f0, f1, out, { dur = 0.3, gain = 0.2, a = 0.003, type = 'sine', hold = 0, curve = 0 }) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) {
      if (curve) o.frequency.setValueAtTime(f0, t0 + dur * curve);
      o.frequency.exponentialRampToValueAtTime(Math.max(16, f1), t0 + dur + hold);
    }
    o.connect(this._env(t0, a, dur, gain, hold)).connect(out);
    o.start(t0); o.stop(t0 + dur + hold + a + 0.06);
  }

  /** Filtered saw. Reads as plucked/attacked rather than blown. */
  _pluck(t0, freq, out, { dur = 0.35, gain = 0.1, f0 = 2400, f1 = 400, q = 5, type = 'sawtooth', a = 0.002, glide = 0 }) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(18, freq * glide), t0 + dur);
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(60, f1), t0 + dur);
    o.connect(f).connect(this._env(t0, a, dur, gain)).connect(out);
    o.start(t0); o.stop(t0 + dur + 0.06);
  }

  /** Duck the whole bed under a one-shot: fast down, slow back. */
  _duck(amt, hold = 0.12) {
    const g = this.duck.gain, now = this.ctx.currentTime;
    g.setTargetAtTime(1 - clamp01(amt), now, 0.012);
    g.setTargetAtTime(1, now + hold, 0.14);
  }

  // ---------------------------------------------------------------- one-shots ---

  play(name, opts = {}) {
    if (this.silent || !this.ready) return;
    const c = this.ctx, t = c.currentTime;

    // Run state has to track the game even while muted, or unmuting mid-run lies.
    if (name === 'start') {
      this._liveT = 1; this._liveRate = 1.1; this._chainK = 0;
      this._chord = 0; this._step = 0; this._nextStep = t + 0.9;
      this._applyChord(t, 3.0);
    } else if (name === 'death') {
      this._liveT = 0.12; this._liveRate = 0.5; this._chainK = 0;
    }
    if (this.muted) return;

    const ch = PROG[this._chord % PROG.length];
    const cf = (semi, mul) => ROOT * mul * Math.pow(2, (ch.r + semi) / 12);
    // a ramp with no preceding event has an ill-defined start; anchor it first
    const sweep = (p, from, to, at) => { p.pan.setValueAtTime(from, t); p.pan.linearRampToValueAtTime(to, at); };

    switch (name) {
      // A light latching onto something alive: contact, then a small breath in.
      case 'attach': {
        const k = clamp01((opts.speed || 400) / 1600);
        const pan = clamp(-0.28 + this.rng() * 0.56 + (opts.pan || 0), -1, 1);
        const near = this._out(pan, { dry: 1, early: 0.5, tail: 0.24 });
        this._swish(t, near, { dur: 0.03, f0: 2300, f1: 900, q: 6, gain: 0.1, a: 0.0007, pink: false });
        this._fm(t, 330 + k * 70, near, { ratio: 3.4, index: 260, dur: 0.15, gain: 0.075, decay: 0.035, a: 0.001 });
        // the breath: cutoff and level both rise, then it stops - an intake
        this._swish(t + 0.012, this._out(pan * 0.6, { dry: 0.8, early: 0.4, tail: 0.5 }),
          { dur: 0.1, f0: 250, f1: 1500, q: 1.5, gain: 0.05, a: 0.085 });
        this._bell(t + 0.02, cf(7, 8), this._out(-pan * 0.5, { dry: 0.5, early: 0.3, tail: 0.9, dist: 0.25 }),
          { gain: 0.045, dur: 0.55 });
        this._duck(0.13, 0.1);
        break;
      }

      // Commitment. Sub thump for mass, a rising-then-falling zip for accel, and
      // a whoosh that crosses the stereo field so the launch physically goes past.
      case 'release': {
        const k = clamp01((opts.speed || 400) / 2200);
        const side = (this._side = -this._side);
        const near = this._out(side * 0.12, { dry: 1, early: 0.45, tail: 0.3 });
        this._swish(t, near, { dur: 0.014, f0: 1400, f1: 5200, q: 0.7, gain: 0.075, a: 0.0005, pink: false, type: 'highpass' });
        this._tone(t, lerp(96, 150, k), 42, near, { dur: 0.3, gain: 0.27, a: 0.004, type: 'sine' });
        this._tone(t + 0.002, lerp(150, 220, k), 34, near, { dur: 0.09, gain: 0.1, type: 'triangle' });
        // the zip: up hard, then away. Two ramps on one param, no glide macro.
        {
          const o = c.createOscillator(); o.type = 'sawtooth';
          const f0 = lerp(105, 190, k);
          o.frequency.setValueAtTime(f0, t);
          o.frequency.exponentialRampToValueAtTime(f0 * lerp(3.2, 5.6, k), t + 0.15);
          o.frequency.exponentialRampToValueAtTime(f0 * 0.9, t + 0.38);
          const f = c.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 6;
          f.frequency.setValueAtTime(700, t);
          f.frequency.exponentialRampToValueAtTime(lerp(1900, 5400, k), t + 0.14);
          f.frequency.exponentialRampToValueAtTime(520, t + 0.4);
          o.connect(f).connect(this._env(t, 0.006, 0.36, 0.085 + k * 0.045)).connect(near);
          o.start(t); o.stop(t + 0.48);
        }
        // displaced water, swept across the image
        const wide = this._out(-side * 0.5, { dry: 0.85, early: 0.55, tail: 0.6 });
        sweep(wide, -side * 0.5, side * 0.55, t + 0.42);
        this._swish(t, wide, { dur: 0.34, f0: 320, f1: lerp(2100, 4700, k), f2: 460, q: 0.9, gain: 0.085 + k * 0.09, a: 0.05 });
        this._bell(t + 0.05, cf(0, 8), this._out(side * 0.35, { dry: 0.4, early: 0.25, tail: 1.0, dist: 0.2 }),
          { gain: 0.04 + k * 0.03, dur: 0.7, bright: k });
        this._duck(0.26 + k * 0.1, 0.28);
        break;
      }

      // A chain, so it has to climb forever. Shepard tone: octave-spaced partials
      // under a fixed spectral window, so the ladder wraps without getting shrill.
      case 'pickup': {
        const i = Math.max(0, Math.round(opts.pitch || 0));
        const semi = PENT[i % 5] + 12 * ((i / 5) | 0);
        const oct = ((semi / 12) % 2 + 2) % 2;
        const kk = clamp01(i / 14);
        const base = ROOT * 8;                      // A4
        const out = this._out(clamp(-0.22 + this.rng() * 0.44, -1, 1),
          { dry: 1, early: 0.42, tail: 0.5 - kk * 0.18 });
        let sum = 0; const w = [];
        for (let j = -1; j <= 2; j++) {
          const f = base * Math.pow(2, oct + j);
          const lg = Math.log2(f / 1150);
          const a = f > 60 && f < 12000 ? Math.exp(-(lg * lg) / (2 * 0.95 * 0.95)) : 0;
          w.push(a); sum += a;
        }
        const gain = (0.15 + kk * 0.07) / Math.max(0.2, sum);
        for (let j = -1; j <= 2; j++) {
          const a = w[j + 1]; if (a < 0.02) continue;
          const f = base * Math.pow(2, oct + j);
          this._bell(t, f, out, {
            gain: gain * a, dur: 0.42 + 0.2 * (1 - kk), a: 0.0018, bright: kk,
            parts: [[1, 1, 1], [2, 0.22 + kk * 0.2, 0.4], [2.76, 0.06 + kk * 0.08, 0.12]],
          });
        }
        if (i >= 3) {   // one in-tempo echo tap: the chain starts to groove
          const d = this._stepDur() * 0.5;
          this._bell(t + d, base * Math.pow(2, oct), this._out(0.4, { dry: 0.3, early: 0.2, tail: 1.1, dist: 0.4 }),
            { gain: gain * 0.3, dur: 0.4, parts: [[1, 1, 1], [2, 0.2, 0.4]] });
        }
        if (i >= 8) this._tone(t, 78, 52, this._out(0, { dry: 0.9, early: 0.1, tail: 0.1 }), { dur: 0.11, gain: 0.09 });
        this._chainK = Math.max(this._chainK, clamp01(i / 12));
        this._duck(0.16 + kk * 0.08, 0.07);
        break;
      }

      // Mass and water. The thud is over in 150ms; the displaced water is not.
      case 'wall': {
        const k = clamp01((opts.speed || 300) / 1600);
        const near = this._out(clamp(-0.2 + this.rng() * 0.4, -1, 1), { dry: 1, early: 0.5, tail: 0.35 });
        this._tone(t, lerp(120, 165, k), 44, near, { dur: 0.16, gain: 0.24 + k * 0.1, a: 0.003 });
        this._tone(t, lerp(230, 320, k), 90, near, { dur: 0.06, gain: 0.09, type: 'triangle' });
        this._swish(t, near, { dur: 0.12, f0: 320, f1: 110, q: 0.6, gain: 0.1 + k * 0.09, a: 0.002, type: 'lowpass' });
        const far = this._out(this.rng() * 0.6 - 0.3, { dry: 0.6, early: 0.4, tail: 1.1, dist: 0.35 });
        this._swish(t + 0.01, far, { dur: 0.42 + k * 0.35, f0: 950, f1: 240, q: 0.8, gain: 0.06 + k * 0.08, a: 0.03 });
        for (let b = 0; b < 2; b++) {  // bubbles: displaced water has to have grain
          this._swish(t + 0.03 + this.rng() * 0.16, far,
            { dur: 0.05, f0: 500 + this.rng() * 900, f1: 300, q: 7, gain: 0.03, a: 0.002 });
        }
        if (k > 0.45) this._fm(t + 0.01, 92, far, { ratio: 1.41, index: 400, dur: 0.42, gain: 0.045, decay: 0.2 });
        this._duck(0.22 + k * 0.12, 0.18);
        break;
      }

      // A near miss. It has to be over before you can think about it.
      case 'brush': {
        const side = (this._side = -this._side);
        const out = this._out(side * 0.85, { dry: 1, early: 0.4, tail: 0.35 });
        sweep(out, side * 0.85, -side * 0.5, t + 0.14);
        this._swish(t, out, { dur: 0.075, f0: 1700, f1: 4400, f2: 1200, q: 2.6, gain: 0.1, a: 0.003, pink: false });
        this._swish(t, out, { dur: 0.008, f0: 3000, f1: 6000, q: 0.7, gain: 0.045, a: 0.0005, pink: false, type: 'highpass' });
        const fear = this._out(-side * 0.7, { dry: 0.35, early: 0.2, tail: 1.0, dist: 0.5 });
        this._tone(t + 0.01, cf(12, 8), 0, fear, { dur: 0.16, gain: 0.028 });
        this._tone(t + 0.01, cf(13, 8), 0, fear, { dur: 0.16, gain: 0.024 });
        break;
      }

      // The light goes out: filament snap, collapse, implosion, then space.
      case 'death': {
        const near = this._out(0, { dry: 1, early: 0.35, tail: 0.6 });
        this._swish(t, near, { dur: 0.05, f0: 3600, f1: 420, q: 1.2, gain: 0.12, a: 0.0006, pink: false });
        this._tone(t, 226, 27, near, { dur: 2.1, gain: 0.19, a: 0.006, curve: 0.06 });
        this._tone(t + 0.01, 113, 25, this._out(-0.3, { dry: 0.8, early: 0.2, tail: 0.9 }),
          { dur: 2.9, gain: 0.12, a: 0.02, type: 'triangle' });
        this._tone(t + 0.02, 55, 30, this._out(0, { dry: 1, early: 0, tail: 0.2 }), { dur: 3.4, gain: 0.2, a: 0.03 });
        this._swish(t + 0.02, this._out(0.25, { dry: 0.7, early: 0.3, tail: 1.3 }),
          { dur: 1.5, f0: 3000, f1: 80, q: 0.7, gain: 0.14, a: 0.05, type: 'lowpass' });
        // ...and then, once the room has finished ringing, one far full stop.
        this._bell(t + 4.4, ROOT * 4, this._out(0.5, { dry: 0.2, early: 0.1, tail: 1.4, dist: 0.85 }),
          { gain: 0.09, dur: 3.2, a: 0.01, parts: [[1, 1, 1], [2, 0.25, 0.5], [3.01, 0.08, 0.25]] });
        this.earlyGain.gain.setTargetAtTime(0.22, t, 0.8);
        break;
      }

      case 'start': {
        const out = this._out(0, { dry: 1, early: 0.4, tail: 0.7 });
        this._tone(t, 84, 52, out, { dur: 0.5, gain: 0.16, a: 0.004 });
        this._tone(t + 0.02, ROOT * 2, 0, this._out(-0.35, { dry: 0.8, early: 0.3, tail: 0.9 }),
          { dur: 1.7, gain: 0.15, a: 0.32 });
        this._tone(t + 0.02, ROOT * 3, 0, this._out(0.4, { dry: 0.6, early: 0.3, tail: 1.0 }),
          { dur: 1.9, gain: 0.09, a: 0.5, type: 'triangle' });
        this._swish(t, this._out(0.1, { dry: 0.7, early: 0.4, tail: 0.8 }),
          { dur: 0.5, f0: 140, f1: 1300, q: 1.2, gain: 0.07, a: 0.55 });
        this._bell(t + 0.5, ROOT * 8, this._out(0.2, { dry: 0.5, early: 0.3, tail: 1.1, dist: 0.3 }), { gain: 0.05, dur: 1.4 });
        this.earlyGain.gain.setTargetAtTime(0.58, t, 0.5);
        break;
      }

      case 'best': {
        const T = [0, 0.13, 0.27, 0.46], PANS = [-0.4, 0.15, 0.5, -0.1];
        for (let i = 0; i < 4; i++) {
          const o = this._out(PANS[i], { dry: 0.9, early: 0.4, tail: 0.85 });
          this._bell(t + T[i], cf([0, 7, 12, 19][i], 8), o, { gain: 0.085, dur: 1.1 - i * 0.1, bright: 0.4 });
        }
        this._swish(t, this._out(0, { dry: 0.4, early: 0.3, tail: 1.0, dist: 0.4 }),
          { dur: 0.7, f0: 900, f1: 3200, q: 1.0, gain: 0.035, a: 0.25 });
        this._duck(0.2, 0.4);
        break;
      }
    }
  }

  // ---------------------------------------------------------------- the score ---

  _stepDur() { return lerp(0.63, 0.38, this._intensity); }

  /** Retune every sustaining voice to the current chord. Exponential glides,
   *  because a hard chord change would announce itself and break the spell. */
  _applyChord(t, glide) {
    const ch = PROG[this._chord % PROG.length];
    const third = ch.q === 0 ? 3 : 4;
    const seventh = ch.q === 2 ? 10 : ch.q === 1 ? 11 : 10;
    const f = (semi, mul) => ROOT * mul * Math.pow(2, (ch.r + semi) / 12);
    const V = [0, 7, 0, third];
    const set = (p, v, g) => {
      p.setValueAtTime(p.value, t);
      p.exponentialRampToValueAtTime(Math.max(16, v), t + Math.max(0.02, g));
    };
    for (let i = 0; i < this.pad.length; i++) set(this.pad[i].frequency, f(V[i], PAD_MUL[i]), glide * (0.7 + i * 0.2));
    set(this.sub[0].frequency, f(0, 1), glide * 1.2);
    set(this.sub[1].frequency, f(0, 0.5), glide * 1.3);
    const SH = [0, 7, third + 12];
    for (let i = 0; i < this.shim.length; i++) set(this.shim[i].frequency, f(SH[i], 16), glide * (1.1 + i * 0.3));
    set(this.dread[0].frequency, f(1, 4), glide);
    set(this.dread[1].frequency, f(6, 4), glide);
    for (let i = 0; i < this.chainOsc.length; i++) set(this.chainOsc[i].frequency, f(i ? 7 : 12, 8), glide * 0.6);
    // melody pool: chord tones over two octaves, always consonant with the pad
    this._notes = [0, 7, 12, 12 + third, 19, 24, seventh].map(s => f(s, 8));
  }

  /** Look-ahead sequencer on the audio clock. Musical timing that does not care
   *  how often update() is called, and a hard cap on events per call. */
  _seq(now) {
    const look = 0.3;
    if (this._nextStep < now - 1) this._nextStep = now + 0.05;   // recover from a stall
    let guard = 0;
    while (this._nextStep < now + look && guard++ < 6) {
      const t = Math.max(now, this._nextStep);
      this._stepAt(t, this._step++);
      this._nextStep = t + this._stepDur();
    }
  }

  _stepAt(t, s) {
    const rng = this.rng, k = this._intensity, dg = this._danger, live = this._live;
    const bar = s & 31;
    if (bar === 0) {                       // one chord per bar
      this._chord = ((s / 32) | 0) % PROG.length;
      this._applyChord(t, this._stepDur() * 7);
      if (live > 0.5 && k > 0.12) {        // mark the move, quietly
        this._pluck(t, this._notes[0] * 0.5, this._out(rng() * 0.5 - 0.25, { dry: 0.55, early: 0.35, tail: 0.9 }),
          { dur: 0.9, gain: 0.05 + k * 0.03, f0: 1100, f1: 220, q: 3, glide: 1.0 });
      }
    }
    if (live < 0.35) return;               // dead: leave the room ringing
    const n = this._notes || [440];

    // lead: a glass bell. Density and register are what intensity buys.
    const w = M_LEAD[bar] / 3;
    if (w > 0 && rng() < w * (0.2 + 0.78 * k)) {
      let deg = CONTOUR[(s >> 1) % CONTOUR.length];
      if (rng() < 0.25) deg = (deg + 1) % 6;
      const up = k > 0.55 && rng() < 0.4 ? 2 : 1;
      const f = n[deg % n.length] * up;
      this._bell(t, f, this._out(clamp(-0.55 + rng() * 1.1, -1, 1),
        { dry: 0.75 - k * 0.1, early: 0.4, tail: 0.85 + (1 - k) * 0.4, dist: 0.15 * (1 - k) }),
        { gain: (0.05 + k * 0.05) * (up > 1 ? 0.6 : 1), dur: lerp(1.5, 0.7, k), bright: k * 0.5 });
    }
    // counter: an FM voice offbeat, only once the run is really moving
    if (k > 0.42 && (bar & 3) === 2 && rng() < 0.45) {
      this._fm(t, n[(4 + ((s >> 2) % 3)) % n.length], this._out(clamp(0.7 - rng() * 1.4, -1, 1),
        { dry: 0.5, early: 0.3, tail: 1.0, dist: 0.25 }),
        { ratio: 3.01, index: 90 + k * 160, dur: 0.5, gain: 0.032 + k * 0.022, decay: 0.16 });
    }
    // the Hush has a pulse, and it gets closer
    if (dg > 0.18) {
      const every = dg > 0.62 ? 2 : dg > 0.38 ? 4 : 8;
      if (s % every === 0) {
        const out = this._out(-0.7, { dry: 0.9, early: 0.25, tail: 0.7 });
        this._tone(t, 62, 38, out, { dur: 0.24, gain: 0.06 + dg * 0.14, a: 0.006 });
        this._swish(t, out, { dur: 0.3, f0: 260, f1: 90, q: 0.7, gain: 0.03 + dg * 0.06, a: 0.02, type: 'lowpass' });
      }
    }
    // something enormous, a long way off. Rare on purpose.
    if (s % 64 === 40 && rng() < 0.55) {
      const f0 = n[0] * (rng() < 0.5 ? 0.25 : 0.5);
      this._fm(t, f0, this._out(rng() < 0.5 ? -0.92 : 0.92, { dry: 0.28, early: 0.15, tail: 1.5, dist: 0.85 }),
        { ratio: 1.5, index: 60, dur: 2.6, gain: 0.075, decay: 1.4, a: 0.5, glide: 1.19 });
    }
    // rock under pressure
    if (s % 48 === 19 && rng() < 0.4) {
      this._swish(t, this._out(rng() * 1.6 - 0.8, { dry: 0.3, early: 0.2, tail: 1.3, dist: 0.7 }),
        { dur: 2.2, f0: 150, f1: 480, f2: 130, q: 4, gain: 0.055, a: 0.7 });
    }
  }

  /** Continuous mix state. Smoothing happens in JS; WebAudio sees at most 20
   *  writes a second per param, and only when a target has actually moved. */
  update(dt, { intensity = 0, danger = 0 } = {}) {
    if (this.silent || !this.ready) return;
    const c = this.ctx;
    dt = Math.min(0.1, Math.max(0, dt || 0));
    this._t += dt;
    this._intensity = damp(this._intensity, clamp01(intensity), 1.6, dt);
    this._danger = damp(this._danger, clamp01(danger), 1.1, dt);
    this._live = damp(this._live, this._liveT, this._liveRate, dt);
    this._chainK = damp(this._chainK, 0, 0.5, dt);

    this._seq(c.currentTime);

    this._autoT += dt;
    if (this._autoT < 0.05) return;
    this._autoT = 0;
    const k = this._intensity, dg = this._danger, live = this._live;
    const now = c.currentTime;
    const set = (p, v, tc, eps) => {
      if (p._lv !== undefined && Math.abs(p._lv - v) < eps) return;
      p._lv = v; p.setTargetAtTime(v, now, tc);
    };

    set(this.bed.gain, 0.9 * lerp(0.55, 1, live), 0.4, 0.004);
    // water opens up with speed; the two sides differ so the image stays wide
    set(this.bedLp[0].frequency, lerp(300, 1250, k), 0.25, 6);
    set(this.bedLp[1].frequency, lerp(360, 1650, k), 0.25, 6);
    for (let i = 0; i < 2; i++) {
      set(this.flow[i].g, (i ? 0.1 : 0.26) * Math.pow(k, 1.35) * live, 0.18, 0.003);
      set(this.flow[i].bp, i ? lerp(1900, 3400, k) : lerp(620, 1150, k), 0.3, 12);
    }
    // pad enters with the run, opens with speed, and is where danger tightens
    set(this.padGain.gain, lerp(0.22, 0.5, k) * live, 0.5, 0.004);
    set(this.padFilter.frequency, lerp(430, 1500, k) * (1 - dg * 0.25), 0.4, 8);
    set(this.subGain.gain, lerp(0.42, 0.62, k) * lerp(1, 0.75, dg) * live, 0.5, 0.004);
    // shimmer is the top layer: it only arrives when you have earned some speed
    set(this.shimGain.gain, clamp01((k - 0.28) / 0.55) * 0.6 * live, 0.8, 0.004);
    set(this.dangerBus.gain, Math.pow(dg, 1.7) * 0.85 * live, 0.35, 0.004);
    set(this.hushBp, lerp(330, 900, dg), 0.4, 6);
    set(this.chainBus.gain, this._chainK * 0.5 * live, 0.3, 0.004);
    set(this.tailGain.gain, lerp(0.95, 0.68, k), 0.6, 0.005);
  }

  // ------------------------------------------------------- back-compat shims ---

  _voice(type, freq, dur, gain, { attack = 0.004, filter = 0, q = 1, wet = 0.4, glide = 0, pan = 0 } = {}) {
    if (this.silent || !this.ctx) return;
    const t = this.ctx.currentTime;
    const out = this._out(pan, { dry: 1 - wet * 0.5, early: wet * 0.5, tail: wet });
    if (filter) this._pluck(t, freq, out, { dur, gain, f0: filter, f1: filter * 0.25, q, type, a: attack, glide });
    else this._tone(t, freq, glide ? freq * glide : 0, out, { dur, gain, a: attack, type });
  }

  _noiseHit(dur, gain, freq, { hp = 0, wet = 0.4, pan = 0 } = {}) {
    if (this.silent || !this.ctx) return;
    this._swish(this.ctx.currentTime, this._out(pan, { dry: 1 - wet * 0.5, early: wet * 0.5, tail: wet }),
      { dur, gain, f0: freq, f1: freq * (hp ? 2.2 : 0.3), type: hp ? 'highpass' : 'lowpass', q: 0.8 });
  }
}

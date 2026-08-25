#!/usr/bin/env node
/**
 * Scratch audio measurement rig (audio owner only; delete when done).
 *
 *   node tools/_audio.mjs session      45s simulated run -> waveform+spectrogram
 *   node tools/_audio.mjs oneshots     each one-shot alone -> spectrogram grid
 *   node tools/_audio.mjs mono         per-bus mono-fold loss: which bus cancels
 *   node tools/_audio.mjs chain        24-pickup chain against the loudest bed
 *   node tools/_audio.mjs stress       node-creation counts + tail-silence check
 *   node tools/_audio.mjs all
 *
 * Renders through OfflineAudioContext, driving Audio.update() via
 * suspend()/resume() so the audio clock really advances between calls.
 */
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = join(ROOT, 'shots/_audio');
const modes = process.argv.slice(2).filter(a => !a.startsWith('-'));
const MODES = modes.length && modes[0] !== 'all' ? modes : ['session', 'oneshots', 'chain', 'stress'];

const PAGE = /* html */ `<!doctype html><meta charset="utf-8"><title>rig</title>
<body style="margin:0;background:#111"><script type="module">
import { Audio } from '/src/engine/audio.js';
const SR = 44100;
const db = (x) => 20 * Math.log10(Math.max(1e-9, x));

// ---------------------------------------------------------------- fft ---
const TBL = {};
function tables(N) {
  if (TBL[N]) return TBL[N];
  const cos = new Float32Array(N / 2), sin = new Float32Array(N / 2), rev = new Uint32Array(N);
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / N); sin[i] = Math.sin(-2 * Math.PI * i / N); }
  let bits = Math.log2(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const han = new Float32Array(N);
  for (let i = 0; i < N; i++) han[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  return (TBL[N] = { cos, sin, rev, han });
}
function spectrum(src, off, N, out) {
  const { cos, sin, rev, han } = tables(N);
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) { const j = off + i; re[rev[i]] = (j < src.length ? src[j] : 0) * han[i]; }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, tstep = N / size;
    for (let i = 0; i < N; i += size) {
      for (let j = i, k = 0; j < i + half; j++, k += tstep) {
        const c = cos[k], s = sin[k];
        const tr = re[j + half] * c - im[j + half] * s, ti = re[j + half] * s + im[j + half] * c;
        re[j + half] = re[j] - tr; im[j + half] = im[j] - ti;
        re[j] += tr; im[j] += ti;
      }
    }
  }
  for (let i = 0; i < N / 2; i++) out[i] = Math.hypot(re[i], im[i]) * (2 / N);
  return out;
}

// ------------------------------------------------------------- measure ---
function stats(buf) {
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const n = L.length;
  let pk = 0, e = 0, clip = 0, mid = 0, side = 0, x = 0, l2 = 0, r2 = 0;
  for (let i = 0; i < n; i++) {
    const l = L[i], r = R[i], al = Math.abs(l), ar = Math.abs(r);
    if (al > pk) pk = al; if (ar > pk) pk = ar;
    if (al > 0.995 || ar > 0.995) clip++;
    e += l * l + r * r;
    const m = (l + r) * 0.5, s = (l - r) * 0.5;
    mid += m * m; side += s * s; x += l * r; l2 += l * l; r2 += r * r;
  }
  const rms = Math.sqrt(e / (2 * n));
  return { peak: pk, peakDb: +db(pk).toFixed(2), rms: +rms.toFixed(5), rmsDb: +db(rms).toFixed(2),
    clipSamples: clip, corr: +(x / Math.sqrt(l2 * r2 || 1)).toFixed(3),
    sidePct: +(100 * side / (mid + side || 1)).toFixed(1), dur: +(n / buf.sampleRate).toFixed(2) };
}

const EDGE = [0, 60, 120, 250, 500, 1000, 2000, 4000, 8000, 22050];

/** What a mono speaker actually loses.
 *  corr and side% are proxies; this is the thing itself. Reference is the
 *  energy the pair carries when played in stereo, (|L|^2+|R|^2)/2; the fold is
 *  |(L+R)/2|^2. A correlated signal folds at 0 dB, two decorrelated sources at
 *  -3, anti-phase at minus infinity. Per band, because a fold loss that lives
 *  entirely under 250 Hz is a different defect from one spread across the
 *  spectrum, and only the first one is fixable without narrowing the image. */
function monoFold(buf, N = 2048) {
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const n = L.length, sr = buf.sampleRate;
  const mid = new Float32Array(n);
  for (let i = 0; i < n; i++) mid[i] = (L[i] + R[i]) * 0.5;
  const mM = new Float32Array(N / 2), mL = new Float32Array(N / 2), mR = new Float32Array(N / 2);
  const eM = new Float64Array(EDGE.length - 1), eRef = new Float64Array(EDGE.length - 1);
  const hop = Math.max(N / 2, Math.floor(n / 300));
  for (let off = 0; off + N < n; off += hop) {
    spectrum(mid, off, N, mM); spectrum(L, off, N, mL); spectrum(R, off, N, mR);
    for (let i = 1; i < N / 2; i++) {
      const f = i * sr / N;
      let b = 0; while (b < eM.length - 1 && f >= EDGE[b + 1]) b++;
      eM[b] += mM[i] * mM[i];
      eRef[b] += (mL[i] * mL[i] + mR[i] * mR[i]) * 0.5;
    }
  }
  let tM = 0, tR = 0;
  for (let b = 0; b < eM.length; b++) { tM += eM[b]; tR += eRef[b]; }
  const per = Array.from(eM, (v, b) => eRef[b] / (tR || 1) < 0.002 ? null : +(10 * Math.log10(v / (eRef[b] || 1e-30))).toFixed(1));
  return { foldDb: +(10 * Math.log10(tM / (tR || 1e-30))).toFixed(2), bandFoldDb: per };
}

/** Does the press have an attack at all? attackMs is time to PEAK, so a pad
 *  that swells for 300ms and a click with a long reverb bloom read the same.
 *  These are the level actually present 6/20/50 ms in, relative to the peak:
 *  -3 dB at 20 ms is a transient, -25 dB is a fade-in wearing one. */
function onset(buf, env, win, sr) {
  let pk = 0; for (const v of env) if (v > pk) pk = v;
  // The master chain has its own latency -- Chrome's DynamicsCompressor carries a
  // lookahead and the 4x-oversampled WaveShaper a resampling delay -- so the
  // render starts with several ms of true zero on EVERY sound. Measuring from
  // sample 0 reported -180 dB at 6ms for all eleven, which is the harness, not
  // the art. Everything below is measured from first signal.
  let lead = 0;
  while (lead < env.length && env[lead] < pk * 1e-4) lead++;
  const at = (ms) => {
    const k = lead + Math.max(1, Math.round(ms / 1000 * sr / win));
    let m = 0; for (let i = lead; i < Math.min(k, env.length); i++) m = Math.max(m, env[i]);
    return +db(m / (pk || 1e-9)).toFixed(1);
  };
  return { leadMs: +(lead * win / sr * 1000).toFixed(1), on6: at(6), on20: at(20), on50: at(50) };
}

/** Absolute band level at the onset, not a percentage of it.
 *  A per-band % over the first 50 ms says brush is 47% air and release is 0% --
 *  but release's onset is dominated by a 0.27-gain sub thump, so a perfectly
 *  audible click reads as 0%. Peak dB per band group answers the question the
 *  percentage cannot: is there anything up there at all, and how loud. */
function onsetLevels(buf, win = 0.06, N = 512) {
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const sr = buf.sampleRate, hi = Math.min(L.length - N, (win * sr) | 0);
  const mono = new Float32Array(Math.min(L.length, hi + N));
  for (let i = 0; i < mono.length; i++) mono[i] = (L[i] + R[i]) * 0.5;
  const mag = new Float32Array(N / 2);
  const G = [[0, 250], [250, 2000], [2000, 8000], [8000, 22050]];
  const best = new Float64Array(4);
  for (let off = 0; off < hi; off += N / 4) {
    spectrum(mono, off, N, mag);
    const e = new Float64Array(4);
    for (let i = 1; i < N / 2; i++) {
      const f = i * sr / N;
      for (let g = 0; g < 4; g++) if (f >= G[g][0] && f < G[g][1]) { e[g] += mag[i] * mag[i]; break; }
    }
    for (let g = 0; g < 4; g++) if (e[g] > best[g]) best[g] = e[g];
  }
  return Array.from(best, v => +(10 * Math.log10(Math.max(1e-12, v))).toFixed(1));
}

/** octave-band energy split, plus centroid + correlation over time */
function bands(buf, N = 2048, from = 0, to = 0) {
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const sr = buf.sampleRate;
  const lo = Math.max(0, (from * sr) | 0), hi = to ? Math.min(L.length, (to * sr) | 0) : L.length;
  const n = hi, mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;
  const EDGES = EDGE;
  const be = new Float64Array(EDGES.length - 1);
  const mag = new Float32Array(N / 2);
  const cent = [], corrT = [];
  const hop = Math.max(to ? N / 4 : N, Math.floor((n - lo) / 400));
  let frames = 0;
  for (let off = lo; off + N < n; off += hop) {
    spectrum(mono, off, N, mag);
    let num = 0, den = 0;
    for (let i = 1; i < N / 2; i++) {
      const f = i * sr / N, p = mag[i] * mag[i];
      num += f * p; den += p;
      for (let b = 0; b < be.length; b++) if (f >= EDGES[b] && f < EDGES[b + 1]) { be[b] += p; break; }
    }
    cent.push(den > 1e-12 ? num / den : 0);
    let xs = 0, ls = 0, rs = 0;
    for (let i = off; i < off + N; i++) { xs += L[i] * R[i]; ls += L[i] * L[i]; rs += R[i] * R[i]; }
    corrT.push(ls * rs > 1e-14 ? xs / Math.sqrt(ls * rs) : 0);
    frames++;
  }
  let tot = 0; for (const v of be) tot += v;
  const pct = Array.from(be, v => +(100 * v / (tot || 1)).toFixed(1));
  const nz = cent.filter(c => c > 1);
  return { bandPct: pct, bandEdges: EDGES,
    centroidMean: Math.round(nz.reduce((a, b) => a + b, 0) / (nz.length || 1)),
    centroidMin: Math.round(Math.min(...(nz.length ? nz : [0]))),
    centroidMax: Math.round(Math.max(...(nz.length ? nz : [0]))),
    cent, corrT, frames };
}

/** one-shot shape: attack to peak, decay to -30dB, and how the tone darkens */
function shape(buf) {
  const L = buf.getChannelData(0), R = buf.getChannelData(1), sr = buf.sampleRate;
  const n = L.length, win = Math.max(1, (sr * 0.002) | 0);
  const env = [];
  for (let i = 0; i + win < n; i += win) {
    let m = 0; for (let j = i; j < i + win; j++) m = Math.max(m, Math.abs(L[j]), Math.abs(R[j]));
    env.push(m);
  }
  let pk = 0, pi = 0;
  env.forEach((v, i) => { if (v > pk) { pk = v; pi = i; } });
  const thr = pk * 0.0316;                 // -30 dB
  let di = env.length - 1;
  for (let i = pi; i < env.length; i++) if (env[i] < thr) { di = i; break; }
  const mag = new Float32Array(512);
  const cAt = (t) => {
    const off = Math.min(n - 1025, Math.max(0, (t * sr) | 0));
    spectrum(L, off, 1024, mag);
    let a = 0, b = 0;
    for (let i = 1; i < 512; i++) { const f = i * sr / 1024, p = mag[i] * mag[i]; a += f * p; b += p; }
    return b > 1e-13 ? Math.round(a / b) : 0;
  };
  return { attackMs: +(pi * win / sr * 1000).toFixed(1), decayMs: +((di - pi) * win / sr * 1000).toFixed(0),
    centOnset: cAt(0.004), centMid: cAt(0.12), centTail: cAt(Math.max(0.3, (di * win / sr) * 0.7)),
    ...onset(buf, env, win, sr), env };
}

// ---------------------------------------------------------------- draw ---
function heat(v) {   // 0..1 -> magma-ish
  const s = [[0,0,4],[40,11,84],[101,21,110],[159,42,99],[212,72,66],[245,125,21],[252,193,60],[252,253,191]];
  const x = Math.max(0, Math.min(0.999, v)) * (s.length - 1), i = x | 0, f = x - i;
  const a = s[i], b = s[i + 1] || a;
  return 'rgb(' + Math.round(a[0]+(b[0]-a[0])*f) + ',' + Math.round(a[1]+(b[1]-a[1])*f) + ',' + Math.round(a[2]+(b[2]-a[2])*f) + ')';
}
function panel(buf, opt = {}) {
  const W = opt.w || 1360, HW = opt.hw || 110, HS = opt.hs || 300, HC = opt.hc || 44;
  const label = opt.label || '';
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = HW + HS + HC + 26;
  const g = cv.getContext('2d');
  g.fillStyle = '#0b0d12'; g.fillRect(0, 0, cv.width, cv.height);
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const n = L.length, sr = buf.sampleRate;
  // waveform: L up, R down
  const per = Math.max(1, Math.floor(n / W));
  for (let x = 0; x < W; x++) {
    let lm = 0, rm = 0;
    for (let i = x * per; i < Math.min(n, (x + 1) * per); i++) { lm = Math.max(lm, Math.abs(L[i])); rm = Math.max(rm, Math.abs(R[i])); }
    const mid = HW / 2;
    g.fillStyle = '#5ad1e6'; g.fillRect(x, mid - lm * mid, 1, Math.max(0.5, lm * mid));
    g.fillStyle = '#e6a35a'; g.fillRect(x, mid, 1, Math.max(0.5, rm * mid));
  }
  g.strokeStyle = '#334'; g.beginPath(); g.moveTo(0, HW / 2); g.lineTo(W, HW / 2); g.stroke();
  g.strokeStyle = '#933'; [0.995].forEach(v => {
    g.beginPath(); g.moveTo(0, HW / 2 - v * HW / 2); g.lineTo(W, HW / 2 - v * HW / 2); g.stroke();
  });
  // spectrogram, log frequency
  const N = opt.fft || 2048, mag = new Float32Array(N / 2);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;
  const hop = Math.max(N / 4, Math.floor((n - N) / W));
  const F0 = 35, F1 = Math.min(16000, sr / 2);
  const rows = new Float32Array(HS);
  for (let x = 0; x < W; x++) {
    const off = Math.floor(x * hop);
    if (off + N >= n) break;
    spectrum(mono, off, N, mag);
    rows.fill(0);
    for (let i = 1; i < N / 2; i++) {
      const f = i * sr / N;
      if (f < F0 || f > F1) continue;
      const y = HS - 1 - Math.floor(Math.log2(f / F0) / Math.log2(F1 / F0) * (HS - 1));
      if (y >= 0 && y < HS) rows[y] = Math.max(rows[y], mag[i]);
    }
    let last = 0;
    for (let y = HS - 1; y >= 0; y--) { if (rows[y] === 0) rows[y] = last * 0.86; else last = rows[y]; }
    for (let y = 0; y < HS; y++) {
      const d = db(rows[y]);
      g.fillStyle = heat((d + 88) / 78);
      g.fillRect(x, HW + y, 1, 1);
    }
  }
  // grid lines at octaves
  g.font = '10px ui-monospace,monospace';
  [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800].forEach(f => {
    const y = HW + HS - 1 - Math.floor(Math.log2(f / F0) / Math.log2(F1 / F0) * (HS - 1));
    g.fillStyle = 'rgba(255,255,255,0.13)'; g.fillRect(0, y, W, 1);
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillText(f + '', 3, y - 2);
  });
  // correlation track
  const b = bands(buf);
  const y0 = HW + HS;
  g.fillStyle = '#151922'; g.fillRect(0, y0, W, HC);
  g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(0, y0 + HC / 2, W, 1);
  for (let x = 0; x < W; x++) {
    const c = b.corrT[Math.floor(x / W * b.corrT.length)] || 0;
    const h = -c * (HC / 2);
    g.fillStyle = c > 0.9 ? '#c94' : '#4c9';
    g.fillRect(x, y0 + HC / 2, 1, h);
  }
  g.fillStyle = '#9ab'; g.font = '11px ui-monospace,monospace';
  g.fillText('corr +1 (mono) / -1  |  ' + label, 4, y0 + 12);
  const s = stats(buf);
  g.fillStyle = '#cde';
  g.fillText('peak ' + s.peakDb + 'dB  rms ' + s.rmsDb + 'dB  clip ' + s.clipSamples +
    '  corr ' + s.corr + '  side ' + s.sidePct + '%  cent ' + b.centroidMean + 'Hz  ' + s.dur + 's',
    4, cv.height - 8);
  return cv.toDataURL('image/png');
}

// ------------------------------------------------------------- offline ---
async function runOffline({ dur, sr = SR, step = 1 / 30, drive, setup, sched = null }) {
  const off = new OfflineAudioContext(2, Math.round(dur * sr), sr);
  const prev = window.AudioContext;
  window.AudioContext = function () { return off; };
  const a = new Audio();
  a.init();
  window.AudioContext = prev;
  if (setup) setup(a, off);
  const q = 128 / sr, align = (t) => Math.max(q, Math.round(t / q) * q);
  const times = [];
  const push = (t) => {
    if (t >= dur - 0.06) return;
    const at = align(t);
    if (!times.length || at > times[times.length - 1] + q / 2) times.push(at);
  };
  if (sched) for (const t of sched) push(t);
  else for (let t = step; t < dur - 0.06; t += step) push(t);
  let i = 0;
  const tick = () => {
    const now = times[i], prevT = i === 0 ? 0 : times[i - 1];
    try { if (drive) drive(a, now, now - prevT); } catch (e) { window.__RIGERR = String(e && e.stack || e); }
    i++;
    if (i < times.length) off.suspend(times[i]).then(tick).catch(() => off.resume());
    off.resume();
  };
  if (times.length) off.suspend(times[0]).then(tick).catch(() => {});
  const buf = await off.startRendering();
  return { buf, a, steps: i, err: window.__RIGERR || null };
}

// a plausible run: accelerate, chain plankton, brush hazards, hush closes in
function sessionScript(a, t, dt) {
  const k = Math.min(1, t / 26);
  const intensity = Math.max(0, Math.min(1, 0.12 + k * 0.85 + 0.12 * Math.sin(t * 0.9)));
  const danger = t < 18 ? 0.05 : Math.min(0.95, (t - 18) / 22);
  a.update(dt, { intensity, danger });
  const S = a.__s || (a.__s = { next: 1.4, chain: 0, nextP: 2.0, nextB: 6 });
  if (t > S.next) {                       // tether cycle
    a.play('attach', { speed: 300 + intensity * 900 });
    a.play('release', { speed: 400 + intensity * 1700 });
    S.next = t + 1.5 - intensity * 0.75;
    if (Math.random() < 0.25) a.play('wall', { speed: 300 + intensity * 1100 });
  }
  if (t > S.nextP) {                      // plankton chain
    a.play('pickup', { pitch: S.chain });
    S.chain = S.chain < 22 ? S.chain + 1 : 0;
    S.nextP = t + (S.chain ? 0.22 + Math.random() * 0.2 : 2.2 + Math.random() * 2);
  }
  if (t > S.nextB) { a.play('brush', {}); S.nextB = t + 3 + Math.random() * 4; }
}


// THE MASTER STARTS AT ZERO AND init() RAMPS IT OPEN, so cancelling that ramp
// without also setting a value leaves the gain at 0 and renders digital silence.
// Three of the four modes did exactly that, and reported peak 0.000 / -180 dB
// over 44- and 70-second renders while happily counting 273 sound events and
// 5000 created nodes. Nobody caught it because a spectrogram of silence still
// looks like a picture, and AI_HANDOFF recorded the soundscape as "verified
// structurally via offline render" on the strength of it.
//
// oneshots had it right all along -- cancel, THEN set -- which is what made
// the diagnosis quick once the graph was probed directly instead of read.
const openMaster = (a) => {
  a.master.gain.cancelScheduledValues(0);
  a.master.gain.value = 0.92;   // the same value init() ramps to when unmuted
};

window.RIG = {
  async session(dur = 44, step = 1 / 30) {
    const r = await runOffline({ dur, step,
      setup: (a) => { openMaster(a); a.play('start'); },
      drive: sessionScript });
    return { png: panel(r.buf, { label: 'session ' + dur + 's  step ' + step.toFixed(4) }),
      stats: stats(r.buf), mono: monoFold(r.buf),
      bands: (({ cent, corrT, ...x }) => x)(bands(r.buf)), steps: r.steps, err: r.err };
  },

  async oneshots() {
    const LIST = [
      ['attach', { speed: 1200 }, 2.2], ['release', { speed: 2000 }, 2.6], ['release', { speed: 260 }, 2.2],
      ['pickup', { pitch: 0 }, 2.0], ['pickup', { pitch: 9 }, 2.0], ['pickup', { pitch: 22 }, 2.0],
      ['wall', { speed: 1500 }, 3.0], ['brush', {}, 1.8], ['death', { cause: 'hush' }, 9.5],
      ['start', {}, 4.0], ['best', {}, 4.0],
    ];
    const out = [];
    for (const [name, opts, dur] of LIST) {
      const r = await runOffline({ dur, step: 0.25,
        setup: (a) => {
          a.master.gain.cancelScheduledValues(0); a.master.gain.value = 0.92;
          a.bed.gain.cancelScheduledValues(0); a.bed.gain.value = 0;   // isolate the event
          a.play(name, opts);
        },
        drive: null });
      const b = bands(r.buf);
      out.push({ name: name + (opts.speed ? '@' + opts.speed : opts.pitch !== undefined ? '#' + opts.pitch : ''),
        png: panel(r.buf, { w: 660, hw: 70, hs: 190, hc: 30, fft: 1024, label: name }),
        stats: stats(r.buf), shape: (({ env, ...x }) => x)(shape(r.buf)),
        mono: monoFold(r.buf), onsetBands: bands(r.buf, 512, 0, 0.05).bandPct, onsetDb: onsetLevels(r.buf),
        bandPct: b.bandPct, cent: b.centroidMean, err: r.err });
    }
    return out;
  },

  /** Which bus is cancelling. Isolation by elimination, per AI_HANDOFF SS7:
   *  render the same event with each wet bus muted and watch the fold loss. */
  async mono() {
    const LIST = [['start', {}, 4.0], ['death', { cause: 'hush' }, 6.0], ['brush', {}, 1.8],
      ['release', { speed: 2000 }, 2.6], ['attach', { speed: 1200 }, 2.2], ['wall', { speed: 1500 }, 3.0]];
    const VAR = { full: 0, noTail: 1, noEarly: 2, dryOnly: 3 };
    const out = [];
    for (const [name, opts, dur] of LIST) {
      const row = { name };
      for (const [vn, v] of Object.entries(VAR)) {
        const r = await runOffline({ dur, step: 0.25,
          setup: (a) => {
            a.master.gain.cancelScheduledValues(0); a.master.gain.value = 0.92;
            a.bed.gain.cancelScheduledValues(0); a.bed.gain.value = 0;
            if (v === 1 || v === 3) a.tailGain.gain.value = 0;
            if (v === 2 || v === 3) a.earlyGain.gain.value = 0;
            a.play(name, opts);
          } });
        const s = stats(r.buf), m = monoFold(r.buf);
        row[vn] = { corr: s.corr, side: s.sidePct, fold: m.foldDb, band: m.bandFoldDb };
      }
      out.push(row);
    }
    return out;
  },

  // the chain has to stay audible at the loudest moment in the game
  async chain() {
    const r = await runOffline({ dur: 16, step: 1 / 30,
      setup: (a) => { openMaster(a); a.play('start'); },
      drive: (a, t, dt) => {
        a.update(dt, { intensity: 1, danger: 0.9 });
        const S = a.__s || (a.__s = { n: 0, next: 3, r: 3.2 });
        if (t > S.r) { a.play('release', { speed: 2200 }); a.play('attach', { speed: 1400 }); S.r = t + 1.1; }
        if (t > S.next && S.n < 24) { a.play('pickup', { pitch: S.n++ }); S.next = t + 0.34; }
      } });
    return { png: panel(r.buf, { label: 'chain of 24 at intensity 1 / danger 0.9' }), stats: stats(r.buf),
      mono: monoFold(r.buf), bands: (({ cent, corrT, ...x }) => x)(bands(r.buf)), err: r.err };
  },

  /** What a stalled frame clock does to the score. main.js clamps its dt to
   *  0.25s while the AudioContext keeps real time, so the two clocks decouple
   *  under load. Same deterministic script, once at a steady 60Hz and once with
   *  periodic 0.4/1.2/3.0s freezes, and we count what the sequencer did. */
  async stall() {
    const mk = (spikes) => {
      const s = []; let t = 0;
      for (let i = 0; t < 40; i++) {
        t += spikes && i % 97 === 96 ? [0.4, 1.2, 3.0][((i / 97) | 0) % 3] : 1 / 60;
        s.push(t);
      }
      return s;
    };
    const run = async (spikes) => {
      const marks = [];
      const r = await runOffline({ dur: 42, sched: mk(spikes),
        setup: (a) => {
          openMaster(a);
          const o = a._stepAt.bind(a);
          a._stepAt = (t, s) => { marks.push(t); o(t, s); };
          a.play('start');
        },
        drive: (a, t, dt) => {          // deterministic: no rng, so A/B is honest
          a.update(Math.min(0.25, dt), { intensity: Math.min(1, t / 20), danger: Math.max(0, (t - 14) / 20) });
          if (Math.floor(t / 1.5) !== Math.floor((t - dt) / 1.5)) { a.play('attach', { speed: 900 }); a.play('release', { speed: 1600 }); }
        } });
      let minGap = 1e9, coincident = 0;
      for (let i = 1; i < marks.length; i++) {
        const g = marks[i] - marks[i - 1];
        if (g < minGap) minGap = g;
        if (g < 1e-4) coincident++;
      }
      return { frames: r.steps, seqSteps: marks.length, minGapMs: +(minGap * 1000).toFixed(1),
        coincident, intensityEnd: +r.a._intensity.toFixed(4), stats: stats(r.buf) };
    };
    return { smooth: await run(false), stalled: await run(true) };
  },

  // node accounting + proof that nothing keeps running after the run
  async stress() {
    const KEYS = ['createGain', 'createOscillator', 'createBiquadFilter', 'createBufferSource',
      'createStereoPanner', 'createDelay', 'createConvolver', 'createWaveShaper',
      'createDynamicsCompressor', 'createChannelSplitter', 'createChannelMerger', 'createBuffer'];
    const count = {}; let total = 0;
    const proto = Object.getPrototypeOf(OfflineAudioContext.prototype);
    const orig = {};
    for (const k of KEYS) { orig[k] = proto[k]; count[k] = 0; proto[k] = function (...a) { count[k]++; total++; return orig[k].apply(this, a); }; }
    const marks = {};
    let plays = 0;
    const t0 = performance.now();
    const r = await runOffline({ dur: 70, step: 1 / 30,
      setup: (a) => { openMaster(a); marks.init = total; a.play('start'); },
      drive: (a, t, dt) => {
        a.update(dt, { intensity: t < 55 ? 0.9 : 0, danger: t < 55 ? 0.5 : 0 });
        if (t > 55) { if (!marks.at55) marks.at55 = total; return; }
        const S = a.__s || (a.__s = { next: 0.5, c: 0 });
        if (t > S.next) {
          const pick = ['attach', 'release', 'pickup', 'wall', 'brush'][(S.c++) % 5];
          a.play(pick, { speed: 1500, pitch: S.c % 24 }); plays++;
          S.next = t + 0.17;
        }
        if (t > 20 && !marks.at20) marks.at20 = total;
        if (t > 40 && !marks.at40) marks.at40 = total;
      } });
    for (const k of KEYS) proto[k] = orig[k];
    const wall = performance.now() - t0;
    // tail: the last 4s should be bed-only. Anything stuck shows up here.
    const sr = r.buf.sampleRate, n = r.buf.length;
    const seg = (a, b) => {
      const L = r.buf.getChannelData(0), R = r.buf.getChannelData(1);
      let e = 0, c = 0; for (let i = (a * sr) | 0; i < Math.min(n, (b * sr) | 0); i++) { e += L[i] * L[i] + R[i] * R[i]; c += 2; }
      return +db(Math.sqrt(e / (c || 1))).toFixed(2);
    };
    return { total, plays, nodesPerPlay: +((marks.at40 - marks.at20) / (plays * 20 / 55)).toFixed(1),
      initNodes: marks.init, marks, count, wallMs: Math.round(wall),
      creationRate: { s20_40: marks.at40 - marks.at20, s40_55: (marks.at55 - marks.at40) },
      rmsActive: seg(30, 40), rmsAfter: seg(60, 64), rmsLast: seg(66, 69),
      png: panel(r.buf, { label: '70s stress: 300+ plays, silence after 55s' }), err: r.err };
  },
};
window.__RIGREADY = true;
</script></body>`;

// ---------------------------------------------------------------- server ---
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/_rig.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(PAGE);
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if ((await stat(file)).isDirectory()) throw 0;
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('404'); }
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', e => errs.push('pageerror: ' + (e && e.message || e)));
await page.goto(`http://127.0.0.1:${PORT}/_rig.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__RIGREADY === true', { timeout: 20000 });

const save = async (name, dataUrl) => {
  const b = Buffer.from(dataUrl.split(',')[1], 'base64');
  await writeFile(join(OUT, name), b);
  return `${(b.length / 1024) | 0}KB`;
};

for (const m of MODES) {
  const t0 = Date.now();
  console.log(`\n=== ${m} =========================================================`);
  if (m === 'oneshots') {
    const list = await page.evaluate('window.RIG.oneshots()');
    const mix = [], sh = [];
    for (const o of list) {
      await save(`shot-${o.name.replace(/[^a-z0-9]/gi, '_')}.png`, o.png);
      mix.push({ name: o.name, peakDb: o.stats.peakDb, rmsDb: o.stats.rmsDb, corr: o.stats.corr,
        side: o.stats.sidePct + '%', foldDb: o.mono.foldDb, bandFold: o.mono.bandFoldDb.map(v => v === null ? '.' : v).join('/') });
      sh.push({ name: o.name, atkMs: o.shape.attackMs, lead: o.shape.leadMs,
        on6: o.shape.on6, on20: o.shape.on20, on50: o.shape.on50,
        decayMs: o.shape.decayMs, cOn: o.shape.centOnset,
        onLF: o.onsetDb[0], onMID: o.onsetDb[1], onHF: o.onsetDb[2], onAIR: o.onsetDb[3],
        onsetBands: o.onsetBands.join('/'), bands: o.bandPct.join('/') });
      if (o.err) console.log('  ERR', o.name, o.err);
    }
    console.table(mix);
    console.log('foldDb = level change summing to mono (0 correlated, -3 decorrelated, big negative = cancelling)');
    console.log('bandFold = the same per band, "." where the band carries <0.2% of the energy');
    console.table(sh);
    console.log('onN = dB below peak reached within N ms (a real transient is > -6 by 20ms)');
    console.log('bands = <60/120/250/500/1k/2k/4k/8k/22k Hz, % energy; onsetBands = same over the first 50ms');
  } else if (m === 'mono') {
    const list = await page.evaluate('window.RIG.mono()');
    for (const row of list) {
      console.log(' ' + row.name);
      const t = {};
      for (const k of ['full', 'noTail', 'noEarly', 'dryOnly'])
        t[k] = { corr: row[k].corr, side: row[k].side + '%', foldDb: row[k].fold,
          bandFold: row[k].band.map(v => v === null ? '.' : v).join('/') };
      console.table(t);
    }
  } else {
    const r = await page.evaluate(`window.RIG.${m}()`);
    const { png, ...rest } = r;
    console.log(JSON.stringify(rest, null, 1));
    if (png) console.log('  png ->', await save(`${m}.png`, png));
  }
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

if (errs.length) console.error('\nPAGE ERRORS:\n' + errs.slice(0, 12).map(e => '  - ' + e).join('\n'));
await browser.close();
server.close();
console.log('\nout ->', OUT);
if (errs.length) process.exit(1);

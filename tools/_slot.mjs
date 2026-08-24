#!/usr/bin/env node
/**
 * Scratch tuner (owned by the environment agent; delete when done).
 * JS mirror of the candidate god-ray slot field. The shaft budget is a measured
 * quantity - coverage feeds straight into the HDR p90 - so the threshold pair
 * and the octave weights are searched here rather than guessed in GLSL.
 */
const fr = (x) => x - Math.floor(x);
function hash11(p) { p = fr(p * 0.1031); p *= p + 33.33; p *= p + p; return fr(p); }
function vn1(x) {
  const i = Math.floor(x); let f = x - i;
  f = f * f * f * (f * (f * 6 - 15) + 10);
  return hash11(i) * (1 - f) + hash11(i + 1) * f;
}
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const N = 300000, X0 = -N / 2;
function mkField(ws, ps) {
  const v = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const x = X0 + i;
    let s = 0;
    for (let k = 0; k < ws.length; k++) s += ws[k] * vn1(x / ps[k] + k * 13.7 + 3.1);
    v[i] = s;
  }
  return v;
}
function stats(v) {
  const s = [...v].sort((a, b) => a - b);
  const m = v.reduce((a, b) => a + b, 0) / N;
  let sd = 0; for (const x of v) sd += (x - m) ** 2;
  return { m, sd: Math.sqrt(sd / N), q: (t) => s[Math.floor(t * (N - 1))] };
}
/** Per-shaft geometry: width, peak, and the world-space width of the rising flank. */
function shape(v, t0, t1, pw) {
  const s = new Float64Array(N);
  for (let i = 0; i < N; i++) s[i] = Math.pow(smoothstep(t0, t1, v[i]), pw);
  const mean = s.reduce((a, b) => a + b, 0) / N;
  let cov = 0; for (const x of s) if (x > 0.06) cov++;
  const widths = [], edges = [], peaks = [];
  let i = 1;
  while (i < N) {
    if (s[i] > 0.06 && s[i - 1] <= 0.06) {
      let j = i; while (j < N && s[j] > 0.06) j++;
      if (j >= N) break;
      let pk = 0; for (let k = i; k < j; k++) pk = Math.max(pk, s[k]);
      widths.push(j - i); peaks.push(pk);
      let e = i; while (e < j && s[e] < pk * 0.5) e++;
      edges.push(e - i);
      i = j;
    } else i++;
  }
  widths.sort((a, b) => a - b); edges.sort((a, b) => a - b); peaks.sort((a, b) => a - b);
  const md = (a) => a.length ? a[a.length >> 1] : NaN;
  return { mean, cov: cov / N, n: widths.length, w: md(widths), e: md(edges), pk: md(peaks),
    spacing: N / Math.max(widths.length, 1) };
}

{ let v = new Float64Array(200000), m = 0;
  for (let i = 0; i < v.length; i++) { v[i] = vn1(i * 0.37 + 0.11); m += v[i]; }
  m /= v.length; let sd = 0; for (const x of v) sd += (x - m) ** 2;
  console.log(`single vn1 octave: mean=${m.toFixed(4)} sd=${Math.sqrt(sd / v.length).toFixed(4)}`); }

const cands = [
  { ws: [0.52, 0.32, 0.16], ps: [333, 167, 83], name: 'A 52/32/16 @333/167/83' },
];
for (const c of cands) {
  const v = mkField(c.ws, c.ps), st = stats(v);
  console.log(`${c.name}: mean=${st.m.toFixed(3)} sd=${st.sd.toFixed(3)} p90=${st.q(.9).toFixed(3)} p97=${st.q(.97).toFixed(3)}`);
  for (const [t0, t1, pw] of [[0.50,0.66,2.2],[0.52,0.68,2.1],[0.52,0.72,2.1],[0.54,0.72,2.0],[0.54,0.74,2.0],[0.56,0.74,1.9],[0.56,0.78,1.9]]) {
    const r = shape(v, t0, t1, pw);
    console.log(`   t=[${t0},${t1}] pow=${pw}  mean=${r.mean.toFixed(4)} cover=${(r.cov*100).toFixed(1)}%`
      + ` shafts/1000u=${(1000/r.spacing).toFixed(2)} medWidth=${r.w}u medPeak=${r.pk.toFixed(2)} risingEdge=${r.e}u`);
  }
}

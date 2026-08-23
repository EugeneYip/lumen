// HUD on a 2D overlay canvas. Text stays crisp at any DPR, and the WebGL layer
// underneath keeps its own resolution independent of it.
import { clamp, clamp01, lerp, smoothstep, easeOutCubic, easeOutQuint, damp } from '../engine/math.js';

const FONT = `-apple-system, "SF Pro Display", "Helvetica Neue", Inter, "Segoe UI", system-ui, sans-serif`;

const css = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const INK = [232, 246, 255];
const DIM = [128, 160, 176];
const FAINT = [70, 94, 108];
const WARM = [255, 190, 110];
const MINT = [140, 255, 200];
const RED = [255, 92, 122];
const VIOLET = [170, 120, 255];

export class Hud {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 1; this.h = 1; this.dpr = 1;
    this.titleT = 0;
    this.deathT = 0;
    this.shownDepth = 0;
    this.multPop = 0;
    this.lastMult = 1;
    this.bestFlash = 0;
    this.hushWarn = 0;
  }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.c.width = Math.round(w * dpr);
    this.c.height = Math.round(h * dpr);
    this.c.style.width = w + 'px';
    this.c.style.height = h + 'px';
  }

  _setFont(size, weight = 400, tracking = 0) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px ${FONT}`;
    try { ctx.letterSpacing = `${tracking}px`; } catch { /* older engines */ }
  }

  /** Fixed-advance digits so the depth meter never jitters. */
  _tabular(str, x, y, size, pitch, align = 'left') {
    const ctx = this.ctx;
    const total = str.length * pitch;
    let cx = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
    ctx.textAlign = 'center';
    for (const ch of str) {
      ctx.fillText(ch, cx + pitch / 2, y);
      cx += pitch;
    }
    return total;
  }

  _glowText(txt, x, y, size, weight, tracking, col, glow, alpha = 1) {
    const ctx = this.ctx;
    this._setFont(size, weight, tracking);
    ctx.textBaseline = 'alphabetic';
    if (glow > 0) {
      ctx.save();
      ctx.shadowColor = css(col, 0.85 * alpha);
      ctx.shadowBlur = glow;
      ctx.fillStyle = css(col, alpha * 0.9);
      ctx.fillText(txt, x, y);
      ctx.restore();
    }
    ctx.fillStyle = css(col, alpha);
    ctx.fillText(txt, x, y);
  }

  /** @param s frameCtx from main.js (see Game.frameCtx) */
  draw(s, dt) {
    const ctx = this.ctx;
    const W = this.w, H = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';

    const uiScale = clamp(Math.min(W / 1280, H / 720), 0.62, 1.5);

    // depth counter eases toward the true value so it always feels alive
    this.shownDepth = damp(this.shownDepth, s.depth, 14, dt);
    if (s.mult > this.lastMult) this.multPop = 1;
    this.lastMult = s.mult;
    this.multPop = damp(this.multPop, 0, 5.5, dt);
    this.bestFlash = damp(this.bestFlash, 0, 3, dt);
    this.hushWarn = damp(this.hushWarn, s.hushProx, 6, dt);

    if (s.mode === 'title') { this.titleT += dt; this._title(s, W, H, uiScale); return; }
    if (s.mode === 'dead') { this.deathT += dt; } else { this.deathT = 0; }

    this._hushWarning(W, H, uiScale, s.time || 0);
    this._depth(s, W, H, uiScale);
    this._chain(s, W, H, uiScale);
    this._speedBar(s, W, H, uiScale);
    if (s.mode === 'dead') this._death(s, W, H, uiScale);
    if (s.mode === 'paused') this._paused(W, H, uiScale);
  }

  // ------------------------------------------------------------------ title ---
  _title(s, W, H, k) {
    const ctx = this.ctx;
    const t = this.titleT;
    const inA = easeOutQuint(clamp01(t / 1.1));
    const inB = easeOutQuint(clamp01((t - 0.35) / 1.2));
    const inC = easeOutQuint(clamp01((t - 0.8) / 1.2));

    const cx = W * 0.5;
    const cy = H * 0.42;

    // wordmark
    const size = 108 * k;
    const tracking = 26 * k;
    this._setFont(size, 200, tracking);
    const txt = 'LUMEN';
    const wide = ctx.measureText(txt).width;
    const x = cx - wide / 2 + tracking / 2;
    const y = cy + size * 0.34;

    const rise = (1 - inA) * 26 * k;
    ctx.save();
    ctx.globalAlpha = inA;
    const grad = ctx.createLinearGradient(x, y - size, x, y + size * 0.2);
    grad.addColorStop(0, 'rgba(255,255,255,0.98)');
    grad.addColorStop(0.55, 'rgba(190,244,255,0.95)');
    grad.addColorStop(1, 'rgba(70,190,225,0.85)');
    ctx.shadowColor = 'rgba(120,225,255,0.55)';
    ctx.shadowBlur = 54 * k;
    ctx.fillStyle = grad;
    ctx.fillText(txt, x, y + rise);
    ctx.shadowBlur = 0;
    ctx.fillStyle = grad;
    ctx.fillText(txt, x, y + rise);
    ctx.restore();

    // hairline
    ctx.save();
    ctx.globalAlpha = inB * 0.7;
    const lw = wide * 0.92;
    const lg = ctx.createLinearGradient(cx - lw / 2, 0, cx + lw / 2, 0);
    lg.addColorStop(0, 'rgba(140,220,245,0)');
    lg.addColorStop(0.5, 'rgba(180,240,255,0.85)');
    lg.addColorStop(1, 'rgba(140,220,245,0)');
    ctx.fillStyle = lg;
    ctx.fillRect(cx - lw / 2, y + 28 * k, lw, Math.max(1, 1 * this.dpr) / this.dpr);
    ctx.restore();

    // subtitle
    ctx.save();
    ctx.globalAlpha = inB;
    ctx.textAlign = 'center';
    this._glowText('DEEP DRIFT', cx, y + 62 * k, 15 * k, 400, 7 * k, DIM, 12 * k, 0.85);
    ctx.restore();

    // prompt
    const pulse = 0.55 + 0.45 * Math.sin(t * 2.1);
    ctx.save();
    ctx.globalAlpha = inC;
    ctx.textAlign = 'center';
    this._glowText('HOLD TO TETHER', cx, H * 0.72, 19 * k, 300, 9 * k, INK, 22 * k, 0.5 + pulse * 0.5);
    this._glowText('RELEASE TO FLY', cx, H * 0.72 + 30 * k, 12.5 * k, 400, 5 * k, FAINT, 0, 0.9);
    ctx.restore();

    if (s.best > 0) {
      ctx.save();
      ctx.globalAlpha = inC * 0.9;
      ctx.textAlign = 'center';
      this._glowText('BEST', cx, H * 0.885, 10.5 * k, 500, 6 * k, FAINT, 0, 1);
      this._setFont(30 * k, 200, 2 * k);
      ctx.fillStyle = css(WARM, 0.92);
      this._tabular(String(Math.round(s.best)), cx - 14 * k, H * 0.885 + 34 * k, 30 * k, 19 * k, 'center');
      this._setFont(13 * k, 400, 2 * k);
      ctx.fillStyle = css(FAINT, 0.9);
      ctx.textAlign = 'left';
      ctx.fillText('m', cx + 22 * k, H * 0.885 + 34 * k);
      ctx.restore();
    }
    ctx.textAlign = 'left';
  }

  // ------------------------------------------------------------------ depth ---
  _depth(s, W, H, k) {
    const ctx = this.ctx;
    const shown = Math.max(0, Math.round(this.shownDepth));
    const str = String(shown);
    const size = 46 * k;
    const pitch = 29 * k;
    const x = W * 0.5, y = 58 * k;

    ctx.save();
    ctx.globalAlpha = s.mode === 'dead' ? 0.35 : 1;
    this._setFont(10.5 * k, 500, 6 * k);
    ctx.textAlign = 'center';
    ctx.fillStyle = css(FAINT, 0.95);
    ctx.fillText('DISTANCE', x, y - size * 0.78);

    this._setFont(size, 200, 0);
    ctx.save();
    ctx.shadowColor = 'rgba(150,230,255,0.5)';
    ctx.shadowBlur = 26 * k;
    ctx.fillStyle = css(INK, 0.97);
    this._tabular(str, x, y, size, pitch, 'center');
    ctx.restore();
    ctx.fillStyle = css(INK, 0.97);
    this._tabular(str, x, y, size, pitch, 'center');

    this._setFont(14 * k, 400, 2 * k);
    ctx.textAlign = 'left';
    ctx.fillStyle = css(DIM, 0.75);
    ctx.fillText('m', x + (str.length * pitch) / 2 + 7 * k, y);

    // best marker
    if (s.best > 0) {
      this._setFont(10.5 * k, 500, 4 * k);
      ctx.textAlign = 'center';
      ctx.fillStyle = css(shown > s.best ? WARM : FAINT, 0.9);
      ctx.fillText(shown > s.best ? 'NEW BEST' : `BEST ${Math.round(s.best)}`, x, y + 22 * k);
    }
    ctx.restore();
    ctx.textAlign = 'left';
  }

  // ------------------------------------------------------------------ chain ---
  _chain(s, W, H, k) {
    const ctx = this.ctx;
    if (s.mult <= 1 && s.chain < 0.05) return;
    const pop = easeOutCubic(this.multPop);
    const x = W - 40 * k, y = 58 * k;
    ctx.save();
    ctx.textAlign = 'right';
    const sz = (34 + pop * 12) * k;
    this._glowText(`x${s.mult.toFixed(1)}`, x, y, sz, 250, 1, MINT, (14 + pop * 30) * k, 0.95);
    this._setFont(10 * k, 500, 5 * k);
    ctx.fillStyle = css(FAINT, 0.9);
    ctx.fillText('CHAIN', x, y - sz * 0.85);

    // pips
    const pips = Math.min(12, Math.floor(s.chain));
    const frac = s.chain - Math.floor(s.chain);
    for (let i = 0; i < 12; i++) {
      const px = x - i * 9 * k, py = y + 14 * k;
      const on = i < pips;
      ctx.fillStyle = css(on ? MINT : FAINT, on ? 0.9 : 0.28);
      const hgt = on ? 6 * k : 3 * k;
      ctx.fillRect(px - 3 * k, py, 3.5 * k, hgt);
      if (i === pips) {
        ctx.fillStyle = css(MINT, 0.5 * frac);
        ctx.fillRect(px - 3 * k, py, 3.5 * k, 3 * k + 3 * k * frac);
      }
    }
    ctx.restore();
    ctx.textAlign = 'left';
  }

  // -------------------------------------------------------------- speed bar ---
  _speedBar(s, W, H, k) {
    const ctx = this.ctx;
    const x = 34 * k, y0 = H * 0.34, y1 = H * 0.66;
    const t = clamp01(s.speed / 2600);
    ctx.save();
    // track
    ctx.fillStyle = css(FAINT, 0.22);
    ctx.fillRect(x, y0, 2 * k, y1 - y0);
    // fill
    const h = (y1 - y0) * t;
    const g = ctx.createLinearGradient(0, y1, 0, y0);
    g.addColorStop(0, 'rgba(110,220,255,0.55)');
    g.addColorStop(0.6, 'rgba(180,245,255,0.9)');
    g.addColorStop(1, 'rgba(255,220,150,1)');
    ctx.fillStyle = g;
    ctx.shadowColor = 'rgba(150,230,255,0.7)';
    ctx.shadowBlur = 12 * k;
    ctx.fillRect(x, y1 - h, 2 * k, h);
    ctx.shadowBlur = 0;
    // head
    ctx.fillStyle = css(INK, 0.95);
    ctx.fillRect(x - 3 * k, y1 - h - 1 * k, 8 * k, 2 * k);
    // label
    ctx.textAlign = 'left';
    this._setFont(9 * k, 500, 4 * k);
    ctx.fillStyle = css(FAINT, 0.8);
    ctx.save();
    ctx.translate(x - 8 * k, y1 + 4 * k);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('SPEED', 0, 0);
    ctx.restore();
    ctx.restore();
  }

  // ---------------------------------------------------------- hush warning ---
  _hushWarning(W, H, k, time) {
    const w = this.hushWarn;
    if (w < 0.02) return;
    const ctx = this.ctx;
    ctx.save();
    const g = ctx.createLinearGradient(0, 0, W * 0.42, 0);
    g.addColorStop(0, `rgba(150,90,255,${0.30 * w})`);
    g.addColorStop(0.45, `rgba(110,60,220,${0.10 * w})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W * 0.42, H);
    if (w > 0.45) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 6.0);
      ctx.textAlign = 'left';
      this._glowText('THE HUSH', 40 * k, H * 0.5, 16 * k, 500, 8 * k, VIOLET,
        20 * k, (w - 0.45) / 0.55 * (0.55 + pulse * 0.45));
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ death ---
  _death(s, W, H, k) {
    const ctx = this.ctx;
    const t = this.deathT;
    const a = easeOutQuint(clamp01((t - 0.45) / 0.9));
    if (a <= 0.001) return;
    const cx = W * 0.5, cy = H * 0.44;

    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = `rgba(2,6,10,${0.45 * a})`;
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';
    const isBest = s.depth >= s.best - 0.5 && s.depth > 0;
    this._glowText(isBest ? 'DEEPEST YET' : 'THE HUSH TOOK YOU', cx, cy - 62 * k,
      13 * k, 500, 8 * k, isBest ? WARM : DIM, 14 * k, 0.95);

    const str = String(Math.round(s.depth));
    const size = 88 * k, pitch = 55 * k;
    this._setFont(size, 150, 0);
    ctx.save();
    ctx.shadowColor = isBest ? 'rgba(255,200,120,0.6)' : 'rgba(160,230,255,0.45)';
    ctx.shadowBlur = 46 * k;
    ctx.fillStyle = css(INK, 0.98);
    this._tabular(str, cx, cy + 22 * k, size, pitch, 'center');
    ctx.restore();
    ctx.fillStyle = css(INK, 0.98);
    this._tabular(str, cx, cy + 22 * k, size, pitch, 'center');
    this._setFont(20 * k, 300, 2 * k);
    ctx.textAlign = 'left';
    ctx.fillStyle = css(DIM, 0.8);
    ctx.fillText('m', cx + (str.length * pitch) / 2 + 10 * k, cy + 22 * k);

    // stat row
    ctx.textAlign = 'center';
    const stats = [
      ['BEST', Math.round(s.best) + 'm'],
      ['CHAIN', 'x' + s.bestMult.toFixed(1)],
      ['TOP SPEED', Math.round(s.topSpeed / 10) + ''],
    ];
    const colW = 132 * k;
    stats.forEach(([label, val], i) => {
      const x = cx + (i - 1) * colW;
      this._setFont(9.5 * k, 500, 5 * k);
      ctx.fillStyle = css(FAINT, 0.9);
      ctx.fillText(label, x, cy + 64 * k);
      this._setFont(22 * k, 250, 1 * k);
      ctx.fillStyle = css(INK, 0.9);
      ctx.fillText(val, x, cy + 92 * k);
    });

    // rules
    ctx.fillStyle = css(FAINT, 0.25);
    ctx.fillRect(cx - colW * 1.5, cy + 44 * k, colW * 3, 1);

    const p = easeOutCubic(clamp01((t - 1.3) / 0.7));
    if (p > 0) {
      const pulse = 0.55 + 0.45 * Math.sin(t * 2.4);
      ctx.globalAlpha = a * p;
      this._glowText('CLICK TO DIVE AGAIN', cx, H * 0.80, 15 * k, 300, 8 * k, INK, 18 * k, 0.45 + pulse * 0.5);
    }
    ctx.restore();
    ctx.textAlign = 'left';
  }

  _paused(W, H, k) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(2,6,10,0.55)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    this._glowText('PAUSED', W / 2, H / 2, 30 * k, 200, 14 * k, INK, 24 * k, 0.95);
    this._glowText('P TO RESUME', W / 2, H / 2 + 34 * k, 11 * k, 500, 6 * k, FAINT, 0, 1);
    ctx.restore();
    ctx.textAlign = 'left';
  }
}

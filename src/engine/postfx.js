// HDR post-processing chain + the grade. This file owns the final image.
//
//   scene(RGBA16F)
//     -> brightpass   Karis average, soft knee, + a floor so ALL light scatters
//     -> 6-mip downsample
//     -> halation     3 cascaded gaussians of mip1  (tight, hugs sources)
//     -> veil         progressive upsample 5..2     (wide, low amplitude)
//     -> ridge+smear  2 passes along each source's OWN axis (short, oriented)
//     -> field        local floor + local range in stops, 3 separable passes
//     -> composite    spectral CA / astigmatic edge / edge-weighted speed smear
//                     + chromatic stretch, water medium,
//                     cos^4 vignette, hue-preserving filmic, split tone,
//                     per-layer black point, tracking midtone ramp, grain, TPDF
//
// Two bloom characters with independent weights is the whole point: a single
// blur radius for everything reads as a filter, not as light in a room. And the
// tonemap runs on the peak channel, not per-channel, so a hot cyan core lands
// on cyan-white and a hot amber core on amber-white instead of both on grey.
//
// Seven things in here were wrong for a long time and are worth naming so they
// do not come back:
//   1. Dispersion and the speed smear shared one radial excursion, so the
//      spectral weights rode the smear. A 2px fringe is a lens; a 20px one is
//      confetti. They are now separate displacements - see the composite.
//   2. The peak curve was normalised by hable(white), which makes the white
//      point a hard CLIP. Everything above it landed on the same pixel, so hot
//      cores read as featureless white discs. It is normalised by the curve's
//      asymptote now - see tonemapHue.
//   3. The shadow colour was ADDED. uLiftCol's green channel alone left ~0.004
//      under every pixel of the frame, and 0.004 through the sRGB curve is
//      code 14 - so the abyss bottomed out at L14, 0.0% of any frame on any
//      seed ever reached L8, and the whole image lived in a 32-value band on
//      top of a teal pedestal. Ablating that one term took the shadow fraction
//      from 0.0% to 29%. The blacks are subtracted now, and the trench colour
//      survives as chroma rather than as level - see the black point.
//   4. The speed smear was anchored on the frame centre. The camera is locked
//      to the mote, so the mote is the still point of the motion field: the
//      world streaks past it, it does not streak. Anchoring on the centre
//      smeared the protagonist at exactly the speeds where the frame most
//      needs a focal point, and it saturated 'soft', which throws away the
//      sharp full-res tap. Measured 1.3:1 core-over-surround at speed against
//      5.6:1 while tethered. The smear has its own origin now.
//   5. The third bloom layer was a pair of long HORIZONTAL blurs, so every
//      bright object threw a level bar across the whole frame width - and
//      those bars passed in FRONT of silhouettes that should have occluded
//      them. Nothing in an abyss is a horizontal light source and nothing here
//      is a lens with anamorphic glass, so the bar was the one moment the
//      image admitted it was a filter rather than light. The layer is now
//      oriented per pixel to the ridge axis of whatever cast it, and gated so
//      an isotropic source contributes nothing at all - see ORIENT_FS.
//   6. The black point gave the frame a floor and no ramp. Measured on the
//      build before that one: 71% of a mid-run frame below L16 and 5.0%
//      between L48 and L159, so the rock's strata, joints and sediment crust
//      existed in the scene at linear 0.01-0.04 and arrived compressed into
//      about 20 code values. The midtone shelf is a gain windowed on level -
//      zero at black so the blacks survive, zero at white so the cores and
//      the clipping fraction do not move, peaked on the low mids.
//   7. That shelf was windowed on a CONSTANT level, and one constant cannot be
//      right at every distance. Measured on the four capture depths of seed 7:
//      3.9% of the frame below L8 at 25m against 45.0% at 1000m, with three
//      distinct parallax layers landing inside 1.4 code values of each other at
//      1000m (12.1 / 11.6 / 10.7) and a near kelp frond landing inside 0.6 of a
//      far wall plane at 25m (41.9 / 41.3). The same curve milked one frame and
//      crushed the other. The window now follows the level of whatever layer it
//      is sitting on, and the veil and the toe are driven by the same field -
//      see FIELD_PRE_FS for what that field is and, importantly, what it is not.
//   8. A defect that is not this file's got measured, twice, with a statistic
//      that could not see it. Both times the conclusion was right and the
//      evidence was noise, which is worse than being wrong quickly: it reads as
//      settled and it is not. The tell is in the numbers themselves - if an
//      ablation at 0x and the same ablation at 4x report the SAME value, the
//      instrument is saturated by something else and neither number means
//      anything. See ORIENT_FS for what it was measuring instead, and for the
//      detector that does resolve a 2px line.
import { compile, RenderTarget, drawFullscreen, FS_VS, GLSL_COMMON, Blend, texture2D } from './gl.js';

const clampN = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clampR = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerpN = (a, b, t) => a + (b - a) * t;
const sstep = (x) => { const t = clampN(x); return t * t * (3 - 2 * t); };
const mix3 = (a, b, t) => [lerpN(a[0], b[0], t), lerpN(a[1], b[1], t), lerpN(a[2], b[2], t)];
const scale3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

const BRIGHT_FS = `
${GLSL_COMMON}
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold, uKnee, uExposure, uFloor;
in vec2 vUv; out vec4 outColor;

void main(){
  // 4-tap Karis average kills fireflies before they can flicker. Reads the
  // half-res copy: a firefly is a firefly at either resolution, and the
  // full-res HDR target is the most expensive texture in the frame.
  vec3 a = texture(uSrc, vUv + uTexel * vec2(-1,-1)).rgb;
  vec3 b = texture(uSrc, vUv + uTexel * vec2( 1,-1)).rgb;
  vec3 c = texture(uSrc, vUv + uTexel * vec2(-1, 1)).rgb;
  vec3 d = texture(uSrc, vUv + uTexel * vec2( 1, 1)).rgb;
  float wa = 1.0/(1.0+max(max(a.r,a.g),a.b));
  float wb = 1.0/(1.0+max(max(b.r,b.g),b.b));
  float wc = 1.0/(1.0+max(max(c.r,c.g),c.b));
  float wd = 1.0/(1.0+max(max(d.r,d.g),d.b));
  vec3 col = (a*wa + b*wb + c*wc + d*wd) / max(1e-4, wa+wb+wc+wd);
  col *= uExposure;

  float br = max(max(col.r, col.g), col.b);
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0*uKnee);
  soft = soft * soft / (4.0*uKnee + 1e-5);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);

  // uFloor is veiling glare: a real lens scatters a slice of *all* incident
  // light, not only what clears a threshold. It is also what keeps the bloom
  // meaningful if the scene is exposed darker or brighter than expected.
  outColor = vec4(col * (contrib + uFloor), 1.0);
}`;

const DOWN_FS = `
${GLSL_COMMON}
uniform sampler2D uSrc;
uniform vec2 uTexel;
in vec2 vUv; out vec4 outColor;

void main(){
  vec2 t = uTexel;
  vec3 A = texture(uSrc, vUv + t*vec2(-2,-2)).rgb;
  vec3 B = texture(uSrc, vUv + t*vec2( 0,-2)).rgb;
  vec3 C = texture(uSrc, vUv + t*vec2( 2,-2)).rgb;
  vec3 D = texture(uSrc, vUv + t*vec2(-1,-1)).rgb;
  vec3 E = texture(uSrc, vUv + t*vec2( 1,-1)).rgb;
  vec3 F = texture(uSrc, vUv + t*vec2(-2, 0)).rgb;
  vec3 G = texture(uSrc, vUv).rgb;
  vec3 H = texture(uSrc, vUv + t*vec2( 2, 0)).rgb;
  vec3 I = texture(uSrc, vUv + t*vec2(-1, 1)).rgb;
  vec3 J = texture(uSrc, vUv + t*vec2( 1, 1)).rgb;
  vec3 K = texture(uSrc, vUv + t*vec2(-2, 2)).rgb;
  vec3 L = texture(uSrc, vUv + t*vec2( 0, 2)).rgb;
  vec3 M = texture(uSrc, vUv + t*vec2( 2, 2)).rgb;
  vec3 c = (D+E+I+J) * 0.125;
  c += (A+B+G+F) * 0.03125;
  c += (B+C+H+G) * 0.03125;
  c += (F+G+L+K) * 0.03125;
  c += (G+H+M+L) * 0.03125;
  outColor = vec4(c, 1.0);
}`;

// 3x3 tent, radius 1. Anything wider here rings; wide spread comes from the
// mip cascade instead. uWeight lets the top (widest) levels carry more energy,
// which is what turns the cascade into a long low tail rather than one halo.
const UP_FS = `
${GLSL_COMMON}
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius, uWeight;
in vec2 vUv; out vec4 outColor;

void main(){
  vec2 t = uTexel * uRadius;
  vec3 c = texture(uSrc, vUv + t*vec2(-1,-1)).rgb * 1.0;
  c += texture(uSrc, vUv + t*vec2( 0,-1)).rgb * 2.0;
  c += texture(uSrc, vUv + t*vec2( 1,-1)).rgb * 1.0;
  c += texture(uSrc, vUv + t*vec2(-1, 0)).rgb * 2.0;
  c += texture(uSrc, vUv).rgb                 * 4.0;
  c += texture(uSrc, vUv + t*vec2( 1, 0)).rgb * 2.0;
  c += texture(uSrc, vUv + t*vec2(-1, 1)).rgb * 1.0;
  c += texture(uSrc, vUv + t*vec2( 0, 1)).rgb * 2.0;
  c += texture(uSrc, vUv + t*vec2( 1, 1)).rgb * 1.0;
  outColor = vec4(c * (uWeight / 16.0), 1.0);
}`;

// One 13-tap directional gaussian, used for the tight halation cascade
// (H then V, twice).
const BLUR_FS = `
${GLSL_COMMON}
uniform sampler2D uSrc;
uniform vec2 uTexel, uDir;
uniform float uStride;
in vec2 vUv; out vec4 outColor;

void main(){
  vec2 stp = uTexel * uDir * uStride;
  vec3 c = texture(uSrc, vUv).rgb;
  float wsum = 1.0;
  for(int i=1;i<=6;i++){
    float fi = float(i);
    float w = exp(-fi*fi*0.09);
    c += texture(uSrc, vUv + stp*fi).rgb * w;
    c += texture(uSrc, vUv - stp*fi).rgb * w;
    wsum += 2.0*w;
  }
  outColor = vec4(c / wsum, 1.0);
}`;

// Per-pixel axis of the light that is there, so the directional bloom layer can
// be a property of the SOURCE instead of a property of the glass. A horizontal
// bar across the frame is the one thing a bioluminescent organism cannot cast.
//
// This layer has now been blamed three times for the dead-straight ruled
// diagonals in the 450m and 1000m frames, on the reasoning that a gaussian
// along a line's own axis brightens the line without blurring across it, so a
// faint straight feature would feed on itself. The reasoning is sound. It is
// still not what draws them, and the case is now closed with an instrument
// that can actually see the thing being argued about.
//
// Read the earlier ablation here as a warning, because it was right by luck.
// It scored the artefact as the p99.9 of a vertical high-pass over the violet
// field and got 43.60 / 43.53 / 43.68 at 1x / 0x / 4x streak. Those numbers are
// not evidence. That statistic is reporting the GRAIN: ablate the grain alone
// and the same number falls 32%, while a 4x change in this layer moves it by
// 0.0%. A per-pixel percentile cannot resolve a 2px line - it returns whichever
// of line and noise is larger, and here that is always the noise.
//
// What does resolve it: shear-average the window ALONG a candidate slope first,
// which suppresses per-pixel grain by sqrt(N) while a coherent line keeps its
// full amplitude, then high-pass across, and take the best response over slopes.
// On seed 7 at 450m over x 2-130, y 140-340 that locks onto the line at slope
// -0.25, y 194, and reports (code values, each against the window's own level,
// so dimming the frame cannot flatter it):
//
//   linear HDR scene, before this file   1.263e-2 over 3.69e-2  rel 0.342
//   final frame                          4.603    over 19.93    rel 0.231
//   uStreakAmt = 0                       4.603       bit-identical
//   uStreakAmt = 4x                      4.603       bit-identical
//   ?noSprites=1                         gone - the best remaining response in
//                                        the window is a different feature at a
//                                        different slope, 1.77
//
// The levels drift as the scene is edited by its own owner; the bit-identical
// pair does not, and that is the part to trust. Re-derive rather than trust the
// third decimal, and if a re-run ever shows 0x and 4x differing, the instrument
// changed, not the conclusion.
//
// So the line is in the scene at 34% local contrast and this file delivers it
// at 23%: postfx ATTENUATES it by a third, and by 59% at 1000m. Nothing in here
// amplifies it. The largest single-ablation move is +19% from switching the
// lens softening off, and every operator that moves it at all moves it UP when
// removed, so each is currently hiding it a little. ?noRibbons=1 leaves it
// untouched; under ?debugLayers=1 the raw scene ratio on it back-solves to
// atlas layer 12, S.SHARD. It is a velocity-stretched shard quad, and it draws
// over silhouettes because a sprite has no depth to test. Fix it where it is
// drawn; there is no honest way to remove it from here, and dimming it until
// something else hides it has already been tried twice and caught twice.
//
// The 'degenerate orientation in a flat field' half of that hypothesis is real,
// and is already answered by the design. Over the violet wash the doubled-angle
// vector does come back unit length - an arbitrary axis, locally coherent,
// exactly as predicted. It is never used, because the reach is driven by the
// GATE and not by the axis: k there has max 0.0033 and mean 3.1e-5, and this
// layer's own output over those texels peaks at 3.9e-6 against the veil's
// 5.3e-3 at the same pixels. The smear's tail does not escape its gate. In a
// field with no ridge there is no tail.
//
// The operator is the Hessian of compressed luminance, not a structure tensor,
// and that distinction is the whole design. A structure tensor measures edges,
// and the flank of a perfectly round core is a perfect edge - so a tensor
// would have found high coherence all around a mote and smeared it into an
// arc, which is the exact artefact this file has been burned by before. Second
// derivatives measure ridges instead: a thin bright line has one strongly
// negative curvature across it and near zero along it, a round core has two
// equal ones, and a silhouette boundary is a saddle. Only the first survives.
const ORIENT_FS = `
${GLSL_COMMON}
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uSpan, uComp, uSig, uRidgePow;
in vec2 vUv; out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Log luminance. The Hessian of raw luminance scales with intensity, so every
// threshold below would have to be written relative to the local level; in log
// space a ridge has the same curvature whether it is a plankton speck or an
// anchor core, and one constant covers both.
float lm(vec2 uv){ return log2(1.0 + dot(texture(uSrc, uv).rgb, LUMA) * uComp); }

void main(){
  vec2 t = uTexel * uSpan;
  float a00 = lm(vUv + t*vec2(-1,-1)), a10 = lm(vUv + t*vec2(0,-1)), a20 = lm(vUv + t*vec2(1,-1));
  float a01 = lm(vUv + t*vec2(-1, 0)), a11 = lm(vUv),                a21 = lm(vUv + t*vec2(1, 0));
  float a02 = lm(vUv + t*vec2(-1, 1)), a12 = lm(vUv + t*vec2(0, 1)), a22 = lm(vUv + t*vec2(1, 1));

  // 1-2-1 across the stencil. A raw second difference on a field this small is
  // mostly noise, and a direction field that flickers would shimmer the glow.
  float Lxx = ((a00 - 2.0*a10 + a20) + 2.0*(a01 - 2.0*a11 + a21) + (a02 - 2.0*a12 + a22)) * 0.25;
  float Lyy = ((a00 - 2.0*a01 + a02) + 2.0*(a10 - 2.0*a11 + a12) + (a20 - 2.0*a21 + a22)) * 0.25;
  float Lxy = (a22 - a02 - a20 + a00) * 0.25;

  float tr = Lxx + Lyy, d = Lxx - Lyy;
  float m  = sqrt(d*d + 4.0*Lxy*Lxy);
  float e1 = 0.5*(tr - m);          // most negative: across a bright ridge
  float e2 = 0.5*(tr + m);          // along it, and near zero there

  // 1 for a line, 0 for a round core, 0 for a saddle. The saddle case is what
  // makes this layer unable to draw along a silhouette boundary.
  float ridge = max(0.0, -e1 - abs(e2)) / (-e1 + abs(e2) + 1e-4);
  float k = pow(ridge, uRidgePow) * smoothstep(0.0, uSig, -e1);

  // Eigenvector of the near-zero curvature. Two algebraically equal forms;
  // taking the better-conditioned one by the sign of d avoids the 0/0 that
  // sits on the vertical axis, and vertical ridges here are kelp trunks and
  // anchor stalks - the common case, not the corner case.
  vec2 v = mix(vec2(2.0*Lxy, m - d), vec2(m + d, 2.0*Lxy), step(0.0, d));
  vec2 ax = v / max(length(v), 1e-9);

  // Stored angle-doubled, because an axis has no sign and bilinear averaging
  // of a signed direction cancels itself wherever the field flips. Doubling
  // makes the interpolation the circular mean of the axis, and the length that
  // comes back is a free confidence: it collapses only where neighbouring
  // pixels disagree, which is exactly where the smear should shorten.
  outColor = vec4(ax.x*ax.x - ax.y*ax.y, 2.0*ax.x*ax.y, k, 1.0);
}`;

// The oriented smear itself. Same 13-tap gaussian as the halation, but the
// direction and the reach come out of the orientation field per pixel, so two
// cascaded passes follow curvature instead of running straight - a kelp frond
// glows along the frond.
const STREAK_FS = `
${GLSL_COMMON}
uniform sampler2D uSrc, uOrient;
uniform vec2 uTexel;
uniform float uStride, uGate;
in vec2 vUv; out vec4 outColor;

void main(){
  vec3 o = texture(uOrient, vUv).rgb;
  float r = length(o.xy);
  // Half-angle back out of the doubled encoding, again taking whichever branch
  // is conditioned away from zero.
  vec2 h = mix(vec2(o.y, r - o.x), vec2(r + o.x, o.y), step(0.0, o.x));
  vec2 ax = h / max(length(h), 1e-9);
  float k = clamp(o.z, 0.0, 1.0);

  // Reach is the gate, with no floor under it, and that is load-bearing. A
  // floor looks harmless and is not: inside a dark occluder the field is a
  // VALLEY, so the near-zero curvature runs along the valley and the axis this
  // shader gets back is the one ACROSS it - a residual 30% reach there was
  // gathering the bright water on both sides of a stalactite and depositing it
  // inside the stalactite. Measured: the body went from L22 to L47 while the
  // water beside it moved 3%, which took the silhouette from 4.1:1 to 2.0:1.
  // With the reach gated the layer can only exist where a ridge exists, so it
  // cannot cross a silhouette - a silhouette is not a ridge. That is the
  // occlusion test this file has no depth buffer to run.
  vec2 stp = uTexel * ax * (uStride * r * k);
  vec3 c = texture(uSrc, vUv).rgb;
  float wsum = 1.0;
  for(int i=1;i<=6;i++){
    float fi = float(i);
    float w = exp(-fi*fi*0.09);
    c += texture(uSrc, vUv + stp*fi).rgb * w;
    c += texture(uSrc, vUv - stp*fi).rgb * w;
    wsum += 2.0*w;
  }
  // Gated on the way in only. Gating twice would square it and the layer would
  // survive on nothing but perfect lines.
  outColor = vec4(c * (mix(1.0, k, uGate) / wsum), 1.0);
}`;

// ---------------------------------------------------------------------------
// The depth-ordering field. Three separable passes producing two numbers per
// pixel: the LOCAL FLOOR of a ~80px neighbourhood, and the LOCAL RANGE in
// stops between that floor and the neighbourhood's mean level.
//
// What this is not: a depth buffer, and not a depth estimate either. Three
// candidate absolute depth cues were measured on real frames and all three
// fail on this scene, which is worth writing down so nobody spends the day
// again:
//
//   * Low-frequency luminance pedestal - the classical dark-channel / airlight
//     prior, which is the right tool for a participating medium. It fails here
//     because the far planes are OCCLUDERS, not haze: measured on seed 7 at
//     450m, the far dark wall sits at code 5.8 while the open water in front
//     of it sits at 31.2, so the airlight estimate ranks the far wall as the
//     NEAREST thing in frame. The environment's four far-wall planes span only
//     1.10x in level across the whole stack, and non-monotonically, while the
//     per-pixel albedo gate inside ONE layer spans 4.6x.
//   * Chroma. The decor's depth fade mixes toward the deep-water colour, which
//     is nearly the same hue as everything it fades, so saturation moves 0.5%
//     for a 20x drop in level. Measured blue-minus-red per layer tracks level,
//     not depth.
//   * Spatial frequency. This one is actively inverted: the far wall planes
//     are the SAME world geometry drawn at 0.135-0.580 scale, so they carry up
//     to 7.4x HIGHER on-screen frequency than the near rock, while the decor
//     is low-passed with depth. A frequency detector labels the farthest wall
//     as the nearest object in the frame.
//
// What survives is local CONTRAST AMPLITUDE, and it survives for both families
// at once and in the same direction: the far walls carry a (1 - fog) factor of
// 0.825 / 0.700 / 0.560 / 0.440 from near to far, and decor carries an alpha of
// (1 - 0.48*depth) with its high octave scaled 1.00 -> 0.18. So contrast is the
// one cue that is monotone in depth for every family of geometry here.
//
// And that is enough, because the acceptance test is not an absolute-depth
// test. It asks that layers be DISTINGUISHABLE, which is a local, pairwise
// property - and local ORDERING is recoverable even where absolute depth is
// not. Inside one neighbourhood the element sitting at the luminance floor is
// the occluder nearest the camera along that ray, and everything above it is
// medium or geometry behind. The composite drives the veil off that ordering,
// the toe and the ramp off the range, and neither ever claims to know a metre.
//
// The failure mode is stated plainly: a smooth near surface - open water, a
// light shaft, the mote's own halo - has no local range and is classified with
// the far medium. That miss is benign by construction, because every operator
// driven from this field is one that should do nothing to a smooth field.
//
// Precision matters here and dictated the algebra. These targets are half
// float, so a variance computed as E[x^2] - E[x]^2 loses most of its
// significant figures in the bright regions where the two terms nearly cancel.
// Both accumulators below are instead well conditioned everywhere: a mean of
// reciprocals inverts to a soft minimum with no cancellation, and the range
// falls out as a sum of logs rather than a difference of squares.
const FIELD_PRE_FS = `
${GLSL_COMMON}
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uC;
in vec2 vUv; out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main(){
  // Four bilinear taps at three quarter-texel diagonals. Each lands between
  // half-res texels, so each returns a 4x4 full-res box and the four together
  // cover the whole quarter-res footprint with no gap. Complete coverage is
  // the point: the later passes step several pixels at a time, and a soft
  // minimum that steps over a thin dark stalactite does not see it at all.
  vec2 t = uTexel * 0.75;
  float a = 0.0, b = 0.0;
  for(int i=0;i<4;i++){
    vec2 o = vec2(i == 0 || i == 3 ? -1.0 : 1.0, i < 2 ? -1.0 : 1.0);
    float l = max(dot(texture(uSrc, vUv + t*o).rgb, LUMA), 0.0) + uC;
    a += 1.0 / l;
    b += log2(l);
  }
  outColor = vec4(a * 0.25, b * 0.25, 0.0, 1.0);
}`;

// Separable gaussian over both accumulators. uDir picks the axis; the vertical
// pass resolves, because the resolve is only valid on the finished 2D mean.
const FIELD_BLUR_FS = `
${GLSL_COMMON}
uniform sampler2D uSrc;
uniform vec2 uTexel, uDir;
uniform float uStride;
in vec2 vUv; out vec4 outColor;

void main(){
  vec2 stp = uTexel * uDir * uStride;
  vec2 c = texture(uSrc, vUv).rg;
  float wsum = 1.0;
  for(int i=1;i<=6;i++){
    float fi = float(i);
    float w = exp(-fi*fi*0.055);
    c += texture(uSrc, vUv + stp*fi).rg * w;
    c += texture(uSrc, vUv - stp*fi).rg * w;
    wsum += 2.0*w;
  }
  outColor = vec4(c / wsum, 0.0, 1.0);
}`;

const FIELD_RESOLVE_FS = `
${GLSL_COMMON}
uniform sampler2D uSrc;
uniform vec2 uTexel, uDir;
uniform float uStride, uC;
in vec2 vUv; out vec4 outColor;

void main(){
  vec2 stp = uTexel * uDir * uStride;
  vec2 c = texture(uSrc, vUv).rg;
  float wsum = 1.0;
  for(int i=1;i<=6;i++){
    float fi = float(i);
    float w = exp(-fi*fi*0.055);
    c += texture(uSrc, vUv + stp*fi).rg * w;
    c += texture(uSrc, vUv - stp*fi).rg * w;
    wsum += 2.0*w;
  }
  c /= wsum;

  // r: the harmonic-style mean of (luminance + uC) inverts to a soft minimum -
  //    the neighbourhood's floor. uC bounds how far one black pixel can drag
  //    it, which is what keeps this from cutting a dark halo around every
  //    silhouette, and it also sets the level below which everything reads as
  //    the same void.
  float floorL = max(1.0 / max(c.r, 1e-6) - uC, 0.0);
  // g: mean log level minus log floor = the local range in STOPS. Scale free,
  //    so one pair of thresholds covers a lit wall and a black trench alike.
  float range = max(c.g + log2(max(c.r, 1e-6)), 0.0);
  outColor = vec4(floorL, range, 0.0, 1.0);
}`;

// A half-res copy of the scene. One bilinear tap lands exactly on a 2x2 box.
// The wide-offset taps in the composite read this instead of the full-res
// target: a 15px dispersion across 7 full-res HDR taps is pure bandwidth, and
// anything being displaced that far is by definition not sharp anyway.
const COPY_FS = `
${GLSL_COMMON}
uniform sampler2D uSrc;
in vec2 vUv; out vec4 outColor;
void main(){ outColor = vec4(texture(uSrc, vUv).rgb, 1.0); }`;

const COMPOSITE_FS = `
${GLSL_COMMON}
uniform sampler2D uScene, uHalf, uVeil, uHaloB, uHaloC, uStreak, uDirt, uSpectrum, uField;
uniform vec2  uRes;
uniform float uTime, uExposure;
uniform float uVeilAmt, uVeilWiden, uVeilCap, uHaloAmt, uHalation, uStreakAmt, uDirtAmt;
uniform vec3  uStreakTint, uHalationTint;
uniform float uChroma, uDefocus, uSmear, uBarrel;
uniform vec2  uSmearOrg;
uniform float uSmearCore, uSmearFeather, uSmearEdge, uSmearChroma;
uniform float uVignette, uVigFocal, uVigCorner;
uniform float uWhite, uHueKeep, uSat, uContrast, uLift, uBlack;
uniform float uShelf, uShelfCentre, uShelfWidth;
uniform float uFieldC, uRangeLo, uRangeHi, uOcclSpan, uOcclCut;
uniform float uToeRange, uOcclToe, uShelfTrack, uShelfBias, uShelfLo, uShelfHi, uShelfGate, uShelfClean;
uniform vec3  uShadowTint, uHighTint, uLiftCol;
uniform vec3  uAbsorb, uScatterCol;
uniform float uScatter, uScatterEdge, uScatterBase;
uniform float uGrain, uGrainChroma, uGrainCoarse, uGrainNear, uGrainFar;
uniform float uFlash;  uniform vec3 uFlashCol;
uniform float uFade, uDesat, uHush;  uniform vec3 uHushTint;
uniform vec4  uWave0, uWave1;
in vec2 vUv; out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Interleaved gradient noise - free, tight, temporally stable.
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// Emulsion grain: one clumped octave plus per-pixel salt. Pure per-pixel noise
// reads as a digital sensor; the clumping is what makes it read as film. uSc
// scales the clump only - the salt stays per-pixel, because a salt octave
// sampled off the pixel grid stops being white noise and starts being texture.
float grain(vec2 p, float s, float sc){
  float clump = vnoise(p * (0.55 * sc) + s);
  float fine  = hash12(p + s * 7.31);
  float cw = 0.70 + 0.13 * (1.0 - sc);
  return (clump * cw + fine * (1.0 - cw)) - 0.5;
}

// Hable filmic. Applied to a scalar only - see tonemapHue. The coefficients are
// named because the shoulder's asymptote is a function of them and tonemapHue
// needs it: as x grows the ratio tends to 1, so hable tends to 1 - E/F.
const float HB_A = 0.22, HB_B = 0.30, HB_C = 0.10, HB_D = 0.20, HB_E = 0.01, HB_F = 0.30;
const float HB_INF = 1.0 - HB_E / HB_F;
float hable(float x){
  return ((x*(HB_A*x + HB_C*HB_B) + HB_D*HB_E) / (x*(HB_A*x + HB_B) + HB_D*HB_F)) - HB_E/HB_F;
}

// hable approaches HB_INF like 1/x, so dividing by hable(white) - the textbook
// normalisation - reaches 1.0 exactly AT white and is clamped flat above it.
// That made the white point a clip: linear 11 and linear 30 came out as the
// same pixel, which is why every hot core was a solid white disc with no shape
// inside it. Dividing by the asymptote instead means the curve approaches
// display white and never arrives, so the ladder above the knee survives, and
// uWhite goes back to meaning where the shoulder sits rather than where the
// image dies. WHITE_REF is picked so that at the default white of 11 the toe
// and the mid-tones land within a level of the old curve: only highlights move.
const float WHITE_REF = 12.3;

// Curve the peak channel, then re-attach the chroma direction and let it walk
// toward white only as the shoulder runs out. Per-channel curves send every
// bright thing to the same grey-white; this sends amber to amber-white and
// cyan to cyan-white, and never clips a channel on the way.
vec3 tonemapHue(vec3 c, float white, float keep){
  float pk = max(max(c.r, c.g), max(c.b, 1e-5));
  vec3 ratio = c / pk;
  float y = min(hable(pk * (WHITE_REF / max(white, 1.0))) / HB_INF, 1.0);
  return mix(ratio, vec3(1.0), pow(y, keep)) * y;
}

// L*L/(L+k) is asymptotically L-k but goes into zero quadratically, so the
// near-black water rolls off rather than clipping to a flat plate.
float toe(float L, float k){
  return (1.0 + k) * L * L / (L + k + 1e-6);
}

vec2 shockwave(vec2 uv, vec4 w){
  if(w.w <= 0.0001) return uv;
  vec2 d = uv - w.xy;
  d.x *= uRes.x / uRes.y;
  float r = length(d);
  float band = exp(-pow((r - w.z) / 0.045, 2.0));
  return uv + normalize(d + 1e-6) * band * w.w;
}

void main(){
  vec2 fc = gl_FragCoord.xy;
  float aspect = uRes.x / uRes.y;

  // --- lens geometry. cc/rn are in LENS space (undistorted): the glass, the
  //     dirt and the vignette do not move when the image warps. ---
  vec2 cc = vUv - 0.5;
  float r2 = dot(cc, cc);
  vec2 ccA = cc * vec2(aspect, 1.0);
  float rlen = length(ccA);
  float rn = rlen / (0.5 * length(vec2(aspect, 1.0)));
  float rn2 = rn * rn;
  vec2 dirR = ccA / max(rlen, 1e-5);
  dirR.x /= aspect;                        // back to uv units
  vec2 perp = vec2(-dirR.y, dirR.x);

  // The motion field has a different centre from the lens, and that difference
  // is load-bearing. The camera is locked to the mote, so the mote is the
  // still point: the world streaks past it and it does not streak. Anchoring
  // the smear on the lens axis instead blurred the protagonist at exactly the
  // speeds where the frame most needs a focal point, and it drove 'soft' to 1
  // there, which throws away the sharp full-res tap in favour of a smeared
  // half-res one. Glass stays on the lens axis; only the motion moves.
  vec2 ccS = (vUv - uSmearOrg) * vec2(aspect, 1.0);
  float rlenS = length(ccS);
  vec2 dirS = ccS / max(rlenS, 1e-5);
  dirS.x /= aspect;

  // Barrel pulls inward only, so no pass ever samples outside the frame.
  vec2 uv = 0.5 + cc * (1.0 - uBarrel * r2);
  uv = shockwave(uv, uWave0);
  uv = shockwave(uv, uWave1);

  // --- the glass. Three jobs, and they used to share one radial excursion:
  //     the spectrum was looked up on the same parameter that drove the smear,
  //     so at speed a 20px motion blur was painting the dispersion that a 2px
  //     fringe is supposed to. Every small highlight became a rainbow dash.
  //     Now dispersion only ever spans caK, and the smear displacement is
  //     achromatic - all three spectral bins ride it the same distance - so a
  //     mote fringes instead of splitting into separated colour copies. ---
  float caK  = uChroma * (0.14 + rn2 * 1.25);
  float defK = uDefocus * rn2 * rn;

  // Speed, as a property of the frame's EDGES. The old profile was
  // min(rlenS, 0.62) - a ramp that saturated about 60% of the way to the
  // corner, so three quarters of the frame carried one identical excursion.
  // There is no edge cue in a constant: it read as the whole image going
  // slightly soft rather than as rush, which is why a review could rank 'the
  // trench doesn't move' third while this term was already running.
  //
  // Three factors, each answering a different half of the note. mCore is an
  // exactly-zero disc over the hero, feathered outward - a hard zero and not
  // merely a small number, because an earlier build smeared everything and got
  // measured as a flat desaturated ribbon that 'picks up no colour from either
  // light and never attenuates'. min(rlenS, 1.0) keeps ramping past where the
  // old curve gave up, and bounds the excursion if the mote is off-frame. The
  // rn2 term weights the lens radius on top, so the corners get the most.
  //
  // Normalised so uSmear IS the corner excursion in uv. That is the only form
  // of this number that can be reasoned about against the tap spacing below,
  // and the old one could not be. Net against it at 1600 wide and full speed:
  // the hero's 144px disc goes from nearly-zero to zero, the middle band loses
  // about a third, and the extreme corner gains about 60%.
  float mCore = smoothstep(uSmearCore, uSmearCore + uSmearFeather, rlenS);
  float edgeW = (1.0 + uSmearEdge * rn2) / (1.0 + uSmearEdge);
  float smK  = uSmear * mCore * min(rlenS, 1.0) * edgeW;
  float jit  = ign(fc + 13.0) - 0.5;

  // Three spectral bins, normalised so the trio sums to unity in every channel.
  // The LUT ends are not pure R and B, which is what makes the fringe read as
  // glass rather than as a comic-book red/blue split. Orientation matches the
  // veil below: the red end is sampled outward, so red lands inward.
  vec3 swI = texture(uSpectrum, vec2(0.05, 0.5)).rgb + 0.02;
  vec3 swM = texture(uSpectrum, vec2(0.52, 0.5)).rgb + 0.02;
  vec3 swO = texture(uSpectrum, vec2(0.95, 0.5)).rgb + 0.02;
  vec3 swN = 1.0 / max(swI + swM + swO, vec3(1e-4));
  swI *= swN; swM *= swN; swO *= swN;

  // Gaussian-weighted along the smear, so the outermost taps sit at a tenth of
  // the centre's weight and stop reading as discrete ghosts. Position is
  // jittered per pixel so what is left grains out instead of banding.
  // Chromatic STRETCH, and its distinction from chromatic displacement is the
  // whole reason it is safe to have at all. Pitfall 1 at the top of this file
  // was the spectrum riding the smear's radial excursion: at speed a 20px
  // displacement painted the fringe that a 2px one is for, and every small
  // highlight came apart into separated colour copies. Here all three bins
  // travel along the same dirS and differ only in HOW FAR, so the trail's tail
  // runs cool while its head stays neutral - dispersion ALONG the trail, which
  // is a thing a fast trail does - and no bin is ever displaced sideways from
  // another. Gated to the top of the speed range, so at cruise it is
  // identically zero rather than merely small.
  float smO = smK * (1.0 - uSmearChroma);
  float smI = smK * (1.0 + uSmearChroma);

  // Eight taps, not six. The corner span grew and the binding constraint is
  // SPACING, not length: past roughly 2.5px of screen spacing six taps stop
  // reading as a smear and start reading as six ghosts. This samples uHalf, so
  // one tap already covers about 2px of screen, and the per-pixel jitter
  // carries what is left across the gaps instead of banding.
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for(int i=0;i<8;i++){
    float d = ((float(i) + 0.5 + jit) / 4.0) - 1.0;      // -1 .. 1
    float w = exp(-d * d * 2.4);
    vec2 off = perp * (d * defK);
    acc += (texture(uHalf, uv + dirS * (d * smO) + off + dirR * caK).rgb * swO
          + texture(uHalf, uv + dirS * (d * smK) + off).rgb              * swM
          + texture(uHalf, uv + dirS * (d * smI) + off - dirR * caK).rgb * swI) * w;
    wsum += w;
  }
  acc /= max(wsum, 1e-4);

  // On axis nothing is displaced, so keep the full-res tap; the dispersed
  // version fades in exactly where the lens stops being sharp. That is also
  // where the edge softness comes from - it is one effect, not two. With the
  // smear anchored on the mote this now stays near zero AT the mote at any
  // speed, which is the whole point: the protagonist keeps its full-res peak.
  vec3 sceneTap = texture(uScene, uv).rgb;
  float soft = clamp((caK + smK + defK) * uRes.x / 2.2 - 0.35, 0.0, 1.0);
  vec3 col = mix(sceneTap, acc, soft) * uExposure;

  // --- the depth-ordering field. See FIELD_PRE_FS for what it is, what it is
  //     not, and the three absolute depth cues that were measured and failed.
  //     rangeK: 0 in a structureless fill, 1 in geology. This is the near/far
  //     proxy, and the only one in this scene that is monotone in depth for
  //     both the wall planes and the decor.
  //     occlK: 1 where this pixel sits at the floor of a neighbourhood that
  //     HAS a floor to sit at - the element nearest the camera along the ray.
  //     Gating on rangeK is what stops flat open water, where every pixel is
  //     trivially at its own floor, from claiming to be an occluder. ---
  vec2 fld = texture(uField, uv).rg;
  float fBase = max(fld.r, 0.0);
  float rangeK = smoothstep(uRangeLo, uRangeHi, fld.g);
  // 'At the floor' has to be measured as a FRACTION of the neighbourhood's own
  // range, not as an absolute number of stops. An absolute threshold calls the
  // lit half of a low-contrast far plane an occluder and the shaded half of a
  // high-contrast near one open water.
  float above = log2((dot(sceneTap, LUMA) + uFieldC) / (fBase + uFieldC));
  float occlK = rangeK * (1.0 - smoothstep(0.0, uOcclSpan * max(fld.g, 0.06), above));
  // The one number the toe and the ramp are both allowed to act on: there is
  // structure here AND this pixel is part of it rather than the hole it is
  // seen against. Without the second half both operators protect the
  // silhouette too - measured, that alone cost 3-5 points of shadow fraction
  // and put three scenes under the 8% floor, because a black stalactite
  // sitting inside a modelled wall inherits the wall's protection.
  float surfK = rangeK * (1.0 - occlK);

  // --- bloom, two characters. Wide veil first: low amplitude, long tail. ---
  // The veil is broad and smooth, so it can carry a much wider per-channel
  // offset than the sharp layer without any risk of reading as a colour copy.
  float ca2 = caK * 4.5;
  vec3 veil = vec3(texture(uVeil, uv + dirR * ca2).r,
                   texture(uVeil, uv).g,
                   texture(uVeil, uv - dirR * ca2).b);
  // 'Spread further, not harder', done the right way round. The old form was
  // a gain on the BRIGHT end - up to 2.5x under the launch and speed boosts -
  // which is a halo burying the core that cast it, and it is what the focal
  // contrast metric was reporting. Lifting the faint TAIL is what actually
  // moves a halo's visible edge outward; the bright near-halo saturates at
  // uVeilCap instead, so a hotter source spreads wider without also stacking
  // veil on top of itself. Done on luminance, so hue is untouched.
  float vk = max(uVeilCap, 1e-3);
  float vl = dot(veil, LUMA);
  veil *= (1.0 + uVeilWiden * vk / (vk + vl)) / (1.0 + vl / vk);
  // Dirt lives in the veil only - it is grime catching stray light, so it can
  // only show where there is stray light to catch.
  float dirt = texture(uDirt, vUv * vec2(aspect, 1.0) * 0.82 + vec2(0.11, 0.07)).r;
  veil *= 1.0 + dirt * uDirtAmt * 2.8;

  // Tight halation hugging the source, plus a difference-of-gaussians ring.
  // Red penetrates deepest into an emulsion, so the ring is red-shifted.
  vec3 halB = texture(uHaloB, uv).rgb;
  vec3 halC = texture(uHaloC, uv).rgb;
  vec3 ring = max(halC - halB * 0.86, 0.0);

  float Lclean = dot(col, LUMA);        // scene before any bloom is stacked on
  col += halB * uHaloAmt;
  col += veil * uVeilAmt;
  col += ring * uHalationTint * uHalation;
  // The oriented layer. Near-neutral tint on purpose: it used to be cooled,
  // which is right for anamorphic glass and wrong for an organism's own light.
  col += texture(uStreak, uv).rgb * uStreakTint * uStreakAmt;
  col += uFlashCol * uFlash;      // pre-tonemap, so a flash rolls off filmically
  // How much of this pixel is the scene rather than a halo cast onto it. The
  // midtone ramp models geology; a halo is not geology, and lifting one is how
  // a hero loses its surround contrast.
  float cleanK = clamp(Lclean / max(dot(col, LUMA), 1e-5), 0.0, 1.0);

  // --- the water you are inside. Absorption eats red first; inscatter lifts
  //     the frame toward its edges, where the sightline through water is
  //     longest. Both belong before the curve so the curve sees real light.
  //     The edge term used to sit on a constant of 1.0, which is a haze floor
  //     on the middle of the frame - precisely where the deepest water is
  //     supposed to be, and where the eye is. It is nearly all path length
  //     now, so the centre can go dark and the corners still breathe.
  //
  //     The inscatter is also the one place a real path length is available
  //     without a depth buffer. Airlight is proportional to how much water is
  //     in front of the thing you are looking at, and the element at the floor
  //     of its own neighbourhood is the one with the least. So the nearest
  //     occluder along each ray keeps a true black floor while the medium and
  //     the geometry behind it keep their veil - which is the near/far half of
  //     the per-layer fog, driven by an ordering that is actually measurable
  //     rather than by a depth this file does not have. ---
  float path = 1.0 + 1.45 * rn2;
  vec3 kA = uAbsorb * path;
  vec3 absF = 1.0 - kA + 0.5 * kA * kA;     // exp(-kA) to 2 terms; kA stays small
  col *= absF;
  float scaK = uScatter * (uScatterBase + uScatterEdge * rn2) * (1.0 - uOcclCut * occlK);
  col += uScatterCol * scaK;

  // --- vignette as light loss, not as a dark disc pasted on the result.
  //     cos^4 of the field angle, plus a little mechanical corner cut. ---
  float cosT = uVigFocal * inversesqrt(uVigFocal * uVigFocal + rlen * rlen);
  float c2 = cosT * cosT;
  float vig = c2 * c2 * (1.0 - uVigCorner * smoothstep(0.58, 1.0, rn));
  float vigM = mix(1.0, vig, uVignette);
  col *= vigM;

  // --- filmic ---
  col = tonemapHue(max(col, 0.0), uWhite, uHueKeep);

  // --- split tone: the palette is cold water against warm anchors, so the
  //     grade takes a side in the shadows and the other in the highlights. ---
  float L = dot(col, LUMA);
  col *= mix(uShadowTint, uHighTint, smoothstep(0.0, 0.72, L));

  // --- the black point, and the reason this file used to have no blacks.
  //     The shadow colour was ADDED here: uLiftCol's green channel alone left
  //     ~0.004 under every pixel, and 0.004 through the sRGB curve is code 14.
  //     So the darkest water in the game measured L12-15, 0.0% of any frame on
  //     any seed reached L8, and 84% of the image lived in a 32-value band
  //     sitting on that pedestal - murk and bloom with no midtone between.
  //     Ablating this one term moved the shadow fraction from 0.0% to 29%.
  //     A colourist subtracts here instead of adding, and doing it on
  //     luminance while rescaling the chroma means the deep water keeps its
  //     own colour all the way down instead of turning grey on the way to
  //     black.
  //
  //     The depth is now per pixel, and this is the 'non-clipping toe' half of
  //     the per-layer prescription. A structureless fill gets the full toe and
  //     is free to reach black - that is the near plane's true black floor, and
  //     it is also empty water, which should not be carrying detail it does not
  //     have. Anything sitting at the floor of its own neighbourhood gets the
  //     full toe and then some, which is what keeps a silhouette black instead
  //     of letting it inherit the protection of the modelled plane it is seen
  //     against - and, since that pixel is also the nearest thing along its
  //     ray, running its toe deeper than what is behind it is the same
  //     near-goes-black, far-stays-veiled statement the inscatter makes above.
  //     Only surface that is above its own floor keeps a non-clipping toe under
  //     it, so a wall plane's striation and a stalactite field survive as slope
  //     rather than being subtracted into one flat plate. ---
  L = dot(col, LUMA);
  float kb = uBlack * (1.0 - uToeRange * surfK) * (1.0 + uOcclToe * occlK);
  float Lb = toe(L, kb);
  col *= Lb / max(L, 1e-5);

  // What is left of the lift: chroma, not level. A few thousandths of the
  // trench's own blue-green so the floor reads as deep water rather than as a
  // dead sensor, weighted into blue where the luma coefficient is 0.07 instead
  // of green where it is 0.72. That is the whole difference between a colour
  // cast and a pedestal.
  col += uLiftCol * uLift * (1.0 - smoothstep(0.0, 0.16, Lb));

  // --- the midtone ramp. The black point fixed the floor and left no ramp:
  //     the geology arrived as silhouette rather than as modelled surface,
  //     with 71% of a frame under L16 and 5% between L48 and L159. A gain, not
  //     an add - an add here is a pedestal and this file has already paid for
  //     that lesson once. And a gain on luminance with the chroma riding along,
  //     so the newly-opened rock keeps the water's colour.
  //
  //     The window is gaussian in log2 luminance, and it has to be: the two
  //     things it must not touch are only a factor of 11 apart. Below sits the
  //     floor, and lifting it dissolves every silhouette. Above sits the mote's
  //     own halo at code 58, and every point of gain there is a point off the
  //     hero's read. A window in L/(L+k) cannot be tight on both sides at once;
  //     one in log L can.
  //
  //     What is new is where the window SITS. It used to sit on a constant, and
  //     one constant cannot be right at every distance: measured on seed 7, the
  //     ramp landed on the rock at 450m and on nothing at all at 1000m, where
  //     three parallax layers had collapsed into 1.4 code values. The centre now
  //     tracks the local floor through the same exposure, absorption, vignette,
  //     curve and toe the pixel itself took, so the ramp opens each layer at the
  //     level that layer actually occupies. Three things keep that from becoming
  //     a local operator that draws edges the scene does not contain: the floor
  //     comes from a soft MINIMUM, which cannot overshoot the way an unsharp
  //     mask's low-pass does; the field is a ~80px window, so anything it does
  //     vary is a shading gradient rather than an edge; and the gain is gated to
  //     retreat where there is no structure to open, which is exactly where an
  //     invented edge would be visible. ---
  float bl = fBase * uExposure * dot(absF, LUMA) * vigM + dot(uScatterCol, LUMA) * scaK;
  float bd = min(hable(bl * (WHITE_REF / max(uWhite, 1.0))) / HB_INF, 1.0);
  bd = toe(bd, kb);
  float ctr = mix(uShelfCentre, clamp(bd * uShelfBias, uShelfLo, uShelfHi), uShelfTrack);
  L = dot(col, LUMA);
  float sd = log2(max(L, 1e-6) / ctr) / uShelfWidth;
  float shelfK = uShelf * mix(uShelfGate, 1.0, surfK) * mix(1.0, cleanK, uShelfClean);
  col *= 1.0 + shelfK * exp2(-sd * sd);

  L = dot(col, LUMA);
  col = mix(vec3(L), col, uSat * (1.0 - uDesat));
  col = filmContrast(clamp(col, 0.0, 1.0), uContrast);

  // --- the Hush: the image loses its colour and its blacks close up, from the
  //     left, where the wall is. ---
  float hm = uHush * (1.0 - smoothstep(0.0, 0.60, vUv.x));
  col = mix(col, vec3(dot(col, LUMA)), hm * 0.85);
  col *= 1.0 - hm * 0.48;
  col += uHushTint * hm * hm * 0.028;

  // Glass loses contrast off-axis. Cheaper than modelling it, reads the same.
  col = mix(col, vec3(dot(col, LUMA)), 0.16 * uVignette * rn2 * rn);
  col *= uFade;

  col = linearToSrgb(max(col, 0.0));

  // --- grain, quantised to 24Hz so it does not crawl at 60, and pulled out of
  //     the deep blacks so the abyss stays clean. The lower knee matters more
  //     than it used to: it sat above the old L14 floor and so never did
  //     anything, but a fifth of the frame now lives below L8, and at those
  //     levels the grain IS the dither that keeps a smooth gradient from
  //     crawling under a moving camera. At L8 it is under half a code value.
  //
  //     The clump size is no longer constant across the frame. One grain size
  //     on every plane is a depth cue thrown away, and it is also what let the
  //     grain pass quietly become the thing disguising flat fills. It rides the
  //     same near/far proxy as everything else here: coarse where the proxy
  //     says near geology, fine where it says far or medium. That is the honest
  //     version of 'grain coarsens toward the viewer' - the proxy is contrast
  //     amplitude, not distance, so it gets the wall planes and the decor right
  //     and calls a smooth near surface far.
  //
  //     AMPLITUDE rides it too now, and that is the free half of atmospheric
  //     perspective: a far plane is seen through more water, so its texture is
  //     scattered out of it along with its contrast. This used to run the other
  //     way round - near geology was DIMMED 18% to pay for its coarser clump,
  //     which left the FAR planes carrying the loudest grain in the frame and
  //     inverted the depth cue it was supposed to support. Measured on the field
  //     itself, the range channel puts rangeK at about 0.03 on an unmodelled far
  //     wall and 0.79-1.00 on near striation, so the two ends land on the two
  //     families almost cleanly and the smooth-near-surface miss documented in
  //     FIELD_PRE_FS costs only grain, which a smooth surface should not have
  //     much of anyway.
  //
  //     Two things this deliberately does not do. It does not go to zero far
  //     away - the TPDF below is the anti-banding guard, but a far gradient with
  //     no emulsion left on it reads as vinyl rather than as distance. And it is
  //     not the reason a lit surface can look flat: that was asked, so it is
  //     measured rather than argued. Differencing the finished frame against
  //     grain=0 over near rock gives 1.26 code values RMS and 6.1 peak on a mean
  //     of 28.8, so a +15 code-value lift from the mote sits about 12:1 over the
  //     grain. The grain does composite on top of the surface lighting - it is
  //     added after the sRGB encode, so it is literally the last thing in the
  //     frame - and at that amplitude it cannot be what swallows a lift. ---
  float gs = hash11(floor(uTime * 24.0) + 0.5) * 311.0;
  float gsc = mix(1.0, uGrainCoarse, rangeK);
  float gn = grain(fc, gs, gsc);
  float gc = hash12(fc + gs * 1.7 + 3.71) - 0.5;
  float gl = dot(col, LUMA);
  float gw = smoothstep(0.014, 0.12, gl) * (1.0 - 0.62 * smoothstep(0.52, 1.0, gl));
  gw *= mix(uGrainFar, uGrainNear, rangeK);
  col += (vec3(gn) + vec3(gc, 0.0, -gc) * uGrainChroma) * uGrain * gw;

  // Two uniforms make a triangular PDF, which unlike a single one does not
  // modulate with signal level. Kills banding in the near-black abyss.
  col += (ign(fc) + ign(fc + 71.3) - 1.0) / 255.0;
  outColor = vec4(col, 1.0);
}`;

const BLOOM_LEVELS = 6;
// Widest mips carry a little more than their share, which is what turns the
// cascade into a long low tail instead of one fat halo.
const UP_WEIGHT = [1, 1, 1.06, 1.10, 1.02, 0.88];

/**
 * The look, in one place. main.js hands over raw frame state; everything from
 * here down is a post-processing decision.
 */
export const GRADE = {
  exposure: 1.15,
  threshold: 0.86,
  knee: 0.58,
  veilFloor: 0.018,       // veiling glare - see BRIGHT_FS
  veil: 0.24,             // wide, low amplitude, long tail
  veilWiden: 0.80,        // lifts the veil's faint TAIL, not its peak
  veilCap: 0.30,          // the near-halo saturates here, so it cannot bury a core
  halo: 0.40,             // tight halation hugging sources
  halation: 0.55,         // red-shifted DoG ring
  haloStride: 1.05,       // tight gaussian, quarter-res texels
  haloStride2: 2.25,      // the wider half of the DoG
  // The third bloom character. Same slot in the chain as the old anamorphic
  // streak - the bench's ?g=streak=0 still ablates exactly this layer - but it
  // is no longer horizontal and no longer long. Combined sigma is ~34px at
  // 1600 wide against the bar's ~107px, and it only exists where a source has
  // an axis of its own. See ORIENT_FS for why that is a Hessian and not a
  // structure tensor.
  streak: 0.46,
  streakStride: [1.7, 3.4],
  streakSpan: 1.60,       // Hessian stencil spacing, quarter-res texels
  streakComp: 6.0,        // luminance compression before differentiating
  streakSig: 0.10,        // curvature below this is noise, not a ridge
  streakRidge: 1.35,      // how hard 'nearly round' is pushed toward zero
  dirt: 0.55,
  // Dispersion is a property of glass, not of how fast you are going. At 1600
  // wide this is sub-pixel on axis and ~3px in the extreme corner: a fringe.
  chroma: 0.0013,
  defocus: 0.0034,
  barrel: 0.030,
  // The speed cue at the frame edges - see the smear profile in the composite.
  // smearCore is a radius around the mote in half-frame-height units, so 0.16
  // is ~144px at 900 tall: comfortably outside the hero's halo, which is what
  // makes 'edge-weighted only, centre untouched' true by construction rather
  // than by tuning.
  smearCore: 0.16,
  smearFeather: 0.24,
  smearEdge: 1.00,        // extra weight on the lens radius; 0 = no edge ramp
  smearChroma: 0.30,      // per-bin trail-length spread at the top of the range
  smearChromaKnee: 0.62,  // ...below this fraction of top speed, exactly zero
  vignette: 0.68,
  vigFocal: 0.95,
  vigCorner: 0.28,
  // Went to 10.6 to buy midtone, and back up now that the ramp buys it more
  // cheaply. The toe gain is WHITE_REF/white, so dropping the white point
  // lifts the whole low end - including the mote's own surround, at about 0.2
  // of measured focal contrast per 1.0.
  white: 11.0,            // linear value the shoulder is built around
  hueKeep: 7.0,           // higher = hue survives further up the shoulder
  saturation: 1.06,
  contrast: 0.145,
  // The blacks: subtract, do not add. uBlack is the soft black point in display
  // space and it is what makes the abyss reach black at all; uLift is now only
  // the colour of the floor, at a luminance too low to be a pedestal.
  black: 0.0020,
  lift: 0.0045,
  // The ramp. Gaussian in log2 luminance, 0.72 octaves wide. shelfCentre is
  // now only the fallback the tracking blends away from - see the composite.
  shelf: 0.72,
  shelfCentre: 0.0145,
  shelfWidth: 0.72,

  // --- the depth-ordering field. See FIELD_PRE_FS. ---
  // Measured on the field itself, seed 7, all four capture depths: the range
  // channel runs 0.02 stops in flat open water, 0.04-0.06 on an unmodelled far
  // wall, 0.18-0.27 on striation and a stalactite field, 0.35 on near kelp.
  // Frame-wide p25 is 0.034 and p90 is 0.30-0.48. The pair below sits under
  // the flat fills and over the geology.
  fieldC: 0.0018,         // resolution floor of the local minimum, scene linear
  fieldStride: 1.55,      // quarter-res texels between taps; ~80px window
  rangeLo: 0.030,         // local range below this is a structureless fill
  rangeHi: 0.240,         // ...and above this is geology
  occlSpan: 0.50,         // fraction of the local range that still counts as its floor
  occlCut: 0.55,          // airlight the nearest element along a ray does not receive
  occlToe: 0.55,          // ...and how much deeper its toe runs than what is behind it
  toeRange: 0.62,         // how far the toe backs off where there is structure
  shelfTrack: 0.85,       // how far the ramp's centre follows the local floor
  shelfBias: 1.35,        // structure sits above the floor it stands on
  shelfLo: 0.0026,        // ...but never below this, or the ramp lifts the void
  shelfHi: 0.0170,        // ...nor above this, or it reaches the mote's halo
  shelfGate: 0.13,        // ramp remaining in a structureless fill
  shelfClean: 0.75,       // ...and how hard a pixel made of halo is excluded
  grainCoarse: 0.66,      // clump scale on near geology (1 = same as far)

  grain: 0.048,
  grainChroma: 0.32,
  // Grain amplitude across the near/far proxy. Near keeps roughly what it had
  // (it was 0.82 there, paying for the coarser clump); far is what the depth
  // cue buys, and it is a floor rather than zero - see the grain block.
  grainNear: 0.86,
  grainFar: 0.34,
  absorb: [0.070, 0.026, 0.016],
  scatter: 0.0022,
  scatterBase: 0.30,      // on-axis inscatter; the rest is path length
  scatterEdge: 2.40,
  shadowTint: [0.860, 1.000, 0.985],
  highTint: [1.000, 0.950, 0.868],
  liftCol: [0.030, 0.190, 0.520],
  scatterCol: [0.075, 0.420, 0.440],
  streakTint: [0.980, 1.000, 1.020],
  halationTint: [1.000, 0.320, 0.145],
  hushTint: [0.420, 0.200, 0.850],
};

export class Post {
  constructor(gl, tex) {
    this.gl = gl;
    this.tex = tex;
    const rt = (w, h) => new RenderTarget(gl, w, h, { float: true });
    this.scene = rt(2, 2);
    this.mips = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) this.mips.push(rt(2, 2));
    this.half = rt(2, 2);
    this.halA = rt(2, 2); this.halB = rt(2, 2); this.halC = rt(2, 2);
    this.veil = rt(2, 2);
    this.orient = rt(2, 2);
    this.streakA = rt(2, 2); this.streakB = rt(2, 2);
    // Two targets ping-pong the three field passes; the pre-pass output is
    // dead by the time the second blur needs somewhere to write.
    this.fieldA = rt(2, 2); this.field = rt(2, 2);

    this.pBright = compile(gl, FS_VS, BRIGHT_FS, 'bright');
    this.pDown = compile(gl, FS_VS, DOWN_FS, 'down');
    this.pUp = compile(gl, FS_VS, UP_FS, 'up');
    this.pBlur = compile(gl, FS_VS, BLUR_FS, 'blur');
    this.pOrient = compile(gl, FS_VS, ORIENT_FS, 'orient');
    this.pStreak = compile(gl, FS_VS, STREAK_FS, 'streak');
    this.pFieldPre = compile(gl, FS_VS, FIELD_PRE_FS, 'fieldPre');
    this.pFieldBlur = compile(gl, FS_VS, FIELD_BLUR_FS, 'fieldBlur');
    this.pFieldRes = compile(gl, FS_VS, FIELD_RESOLVE_FS, 'fieldResolve');
    this.pCopy = compile(gl, FS_VS, COPY_FS, 'copy');
    this.pComp = compile(gl, FS_VS, COMPOSITE_FS, 'composite');
    this.w = 0; this.h = 0;
    this._fallbackSpec = null;
  }

  resize(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.scene.resize(w, h);
    this.half.resize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    let mw = Math.max(1, w >> 1), mh = Math.max(1, h >> 1);
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.mips[i].resize(mw, mh);
      mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1);
    }
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    for (const t of [this.halA, this.halB, this.halC, this.veil,
      this.orient, this.streakA, this.streakB, this.fieldA, this.field]) t.resize(qw, qh);
  }

  beginScene() { this.scene.bind(true); return this.scene; }

  /** Spectrum LUT is owned by textures.js; synthesise one if it is not there. */
  _spectrum() {
    if (this.tex && this.tex.spectrum) return this.tex.spectrum;
    if (!this._fallbackSpec) {
      const gl = this.gl, N = 64, px = new Uint8Array(N * 4);
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        const g = (c, w) => Math.exp(-(((t - c) / w) ** 2));
        px[i * 4] = Math.round(clampN(g(0.86, 0.30) * 1.1 + g(0.02, 0.14) * 0.5) * 255);
        px[i * 4 + 1] = Math.round(clampN(g(0.50, 0.30) * 1.1) * 255);
        px[i * 4 + 2] = Math.round(clampN(g(0.18, 0.26) * 1.15) * 255);
        px[i * 4 + 3] = 255;
      }
      this._fallbackSpec = texture2D(gl, { width: N, height: 1, data: px });
    }
    return this._fallbackSpec;
  }

  _pass(prog, target, srcTex, uniforms, additive = false, aux = null) {
    const gl = this.gl;
    target.bind(!additive);
    gl.useProgram(prog.program);
    if (additive) Blend.add(gl); else Blend.none(gl);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    if (prog.u.uSrc) gl.uniform1i(prog.u.uSrc, 0);
    if (aux) {
      let unit = 1;
      for (const k in aux) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, aux[k]);
        if (prog.u[k]) gl.uniform1i(prog.u[k], unit);
        unit++;
      }
    }
    for (const k in uniforms) {
      const loc = prog.u[k]; if (!loc) continue;
      const v = uniforms[k];
      if (typeof v === 'number') gl.uniform1f(loc, v);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
      else gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
    }
    drawFullscreen(gl);
    Blend.none(gl);
  }

  /**
   * Where the motion field is centred. The camera is locked to the mote, so
   * the mote is the still point of that field and must not be smeared - see
   * the composite. Falls back to the lens axis when there is no player, which
   * is the title screen and the synthetic grade bench.
   */
  _smearOrigin(ctx) {
    const cam = ctx.cam, p = ctx.player;
    if (!cam || !p || typeof cam.worldToUv !== 'function') return [0.5, 0.5];
    const u = cam.worldToUv(p.x, p.y);
    if (!u || !Number.isFinite(u[0]) || !Number.isFinite(u[1])) return [0.5, 0.5];
    // Slack outside the frame so an off-screen mote does not snap the pivot to
    // an edge, which would put a hard discontinuity in the motion field.
    return [clampR(u[0], -0.35, 1.35), clampR(u[1], -0.35, 1.35)];
  }

  /**
   * Map frame state -> post parameters. This is the dynamic half of the look:
   * how the lens behaves under speed, danger, impact and death. Restraint is
   * the point - each signal moves two or three things, never everything.
   */
  grade(ctx) {
    const G = GRADE;
    const dead = ctx.mode === 'dead';
    const deadK = dead ? clampN((ctx.deadT || 0) * 0.85) : 0;
    const sk = clampN(ctx.speedK || 0);
    const hp = clampN(ctx.hushProx || 0);
    const lg = clampN(ctx.launchGlow || 0);
    const bg = clampN(ctx.brushGlow || 0);
    const slow = clampN(ctx.slow || 0);
    const att = ctx.attached ? 1 : 0;
    const diff = clampN(ctx.difficulty || 0);
    const depthK = clampN((ctx.depth || 0) / 1400);
    // The Hush leans in early but only closes its fist at the end.
    const hush = clampN(hp * (0.62 + 0.38 * hp));

    const waves = (ctx.waves || []).map((w) => {
      if (!w.live) return [0, 0, 0, 0];
      const t = w.t / w.dur;
      const uv = ctx.cam.worldToUv(w.x, w.y);
      return [uv[0], uv[1], 0.02 + t * 0.55, (1 - t) * (1 - t) * 0.045];
    });
    while (waves.length < 2) waves.push([0, 0, 0, 0]);

    // Speed lengthens the oriented smear a little, but most of the motion read
    // now arrives for free: the scene draws its sprites velocity-stretched, so
    // at speed the ridge field itself lies along the direction of travel.
    const stretch = 1 + sk * 0.30 + lg * 0.15;

    return {
      time: ctx.t || 0,
      exposure: G.exposure * (1 + lg * 0.13 + bg * 0.04) * (1 - deadK * 0.30) * (1 - hush * 0.06),
      threshold: G.threshold * (1 - lg * 0.10),
      knee: G.knee,
      veilFloor: G.veilFloor,
      bloomRadius: 1.0,

      // Speed and launch used to push every bloom layer at once - veil x1.5,
      // halo x1.8, halation x2.1, streak x2.7 - which is how the frame ended
      // up with a mote that measured 1.2:1 against its own surround. Speed
      // lives in the streak and the smear, which are directional and read as
      // motion; launch lives in the halo, which hugs the source. The wide veil
      // is the one layer that fills the surround isotropically, so it barely
      // moves.
      veil: G.veil * (1 + sk * 0.10 + lg * 0.26 + slow * 0.15),
      veilWiden: G.veilWiden + lg * 0.70 + sk * 0.25,
      veilCap: G.veilCap,
      halo: G.halo * (1 + lg * 0.85 + bg * 0.35 + att * 0.10),
      halation: G.halation * (1 + lg * 0.70 + sk * 0.15),
      haloStride: G.haloStride,
      haloStride2: G.haloStride2,
      // The old multipliers here were x2.7 at speed, which is affordable for a
      // wide dim bar and is not affordable for something this close to the
      // source. It also needs less: the smear grows with the source's own
      // aspect, not only with this number.
      streak: G.streak * (1 + sk * 0.85 + lg * 1.10 + slow * 0.25),
      streakStride: [G.streakStride[0] * stretch, G.streakStride[1] * stretch],
      streakSpan: G.streakSpan,
      streakComp: G.streakComp,
      streakSig: G.streakSig,
      streakRidge: G.streakRidge,
      dirt: G.dirt,

      // These three used to be pushed hard by speed, which is what turned the
      // dispersion into confetti. Speed belongs in the smear and the streak;
      // chroma stays at lens scale so a mote keeps a fringe, not a rainbow.
      chroma: G.chroma + sk * 0.0006 + hush * 0.0007 + slow * 0.0009 + lg * 0.0005,
      defocus: G.defocus + sk * 0.0026 + slow * 0.0018,
      // uSmear is now the CORNER excursion in uv, so at 1600 wide with eight
      // taps the spacing is 400*uSmear px. The cap keeps the worst case -
      // speed, a launch and dilation all landing together - inside about 3px of
      // spacing; past that the taps stop being a smear and read as ghosts.
      smear: Math.min(0.0075, sk * 0.0060 + lg * 0.0042 + slow * 0.0020),
      smearOrg: this._smearOrigin(ctx),
      smearCore: G.smearCore,
      smearFeather: G.smearFeather,
      smearEdge: G.smearEdge,
      // The chromatic stretch is the top of the range only, and it is a knee
      // rather than a ramp out of zero on purpose: dispersion that grows
      // smoothly from nothing is a colour cast over the whole speed range,
      // where this has to read as an event that arrives.
      smearChroma: G.smearChroma * sstep((sk - G.smearChromaKnee) / (1 - G.smearChromaKnee)),
      barrel: G.barrel + sk * 0.014,

      vignette: Math.min(0.86, G.vignette + hush * 0.16 + slow * 0.10 + deadK * 0.22 + sk * 0.05),
      vigFocal: G.vigFocal,
      vigCorner: G.vigCorner,

      // A launch drops the white point: the frame punches into the shoulder
      // instead of just getting brighter.
      white: G.white * (1 - lg * 0.14 - bg * 0.04),
      hueKeep: G.hueKeep,
      saturation: G.saturation * (1 - slow * 0.20) * (1 - deadK * 0.35),
      contrast: G.contrast + sk * 0.05 + deadK * 0.06 + diff * 0.03,
      // Deep water has less to bounce around in it, so the floor closes a
      // little with depth. Death closes it further - the frame is going out.
      // This used to be the ONLY thing that moved with distance, and one
      // global knob over four distances is what this round was about: at 25m
      // it milked and at 1000m it crushed, and the same number did both. The
      // depth term is smaller now because the per-pixel toe does the work.
      black: G.black * (1 + depthK * 0.16 + deadK * 0.45),
      lift: G.lift,
      // The Hush already floods the frame and death is closing it; neither
      // moment wants the ramp opened as well.
      shelf: G.shelf * (1 - hush * 0.35) * (1 - deadK * 0.55),
      shelfCentre: G.shelfCentre,
      shelfWidth: G.shelfWidth,

      fieldC: G.fieldC,
      fieldStride: G.fieldStride,
      rangeLo: G.rangeLo,
      rangeHi: G.rangeHi,
      occlSpan: G.occlSpan,
      // The airlight cut buys back the blacks a modelled shadow costs, and the
      // near frames are the ones that need it: measured across the four
      // capture depths, the shadow fraction runs 3.5% at 25m and 45% at
      // 1000m, so one setting is at the floor on one frame and at the ceiling
      // on another. It eases off with depth for the same reason the ceiling
      // exists - past a point, darkening stops being contrast and starts
      // being deletion.
      occlCut: G.occlCut * (1 - depthK * 0.35),
      toeRange: G.toeRange,
      occlToe: G.occlToe,
      // The Hush flattens the image on purpose, so it also flattens the thing
      // that models depth. Tracking a floor the Hush has already raised would
      // fight it.
      shelfTrack: G.shelfTrack * (1 - hush * 0.45),
      shelfBias: G.shelfBias,
      shelfLo: G.shelfLo,
      shelfHi: G.shelfHi,
      shelfGate: G.shelfGate,
      shelfClean: G.shelfClean,
      grainCoarse: G.grainCoarse,

      shadowTint: G.shadowTint,
      // Tethered, you are sitting in an anchor's light: highlights go warmer.
      highTint: mix3(G.highTint, [1.0, 0.905, 0.760], att * 0.35 + lg * 0.40),
      liftCol: G.liftCol,
      streakTint: G.streakTint,
      halationTint: G.halationTint,

      absorb: scale3(G.absorb, (0.72 + depthK * 0.80) * (1 + diff * 0.15)),
      scatter: G.scatter * (1 + depthK * 0.35),
      scatterBase: G.scatterBase,
      scatterEdge: G.scatterEdge,
      scatterCol: G.scatterCol,

      grain: G.grain * (1 + deadK * 0.60 + slow * 0.35),
      grainChroma: G.grainChroma,
      grainNear: G.grainNear,
      grainFar: G.grainFar,

      // Pre-tonemap, so it rolls off instead of clipping. Modest: this is
      // added flat to every pixel before the curve.
      flash: (ctx.flash || 0) * 0.85,
      flashCol: ctx.flashCol || [1, 1, 1],
      fade: ctx.fade ?? 1,
      desat: deadK * 0.45,
      hush,
      hushTint: G.hushTint,
      wave0: waves[0], wave1: waves[1],
    };
  }

  /**
   * Turn raw frame state into the final image.
   * @param ctx frameCtx from main.js (see Game.frameCtx)
   */
  render(ctx) {
    const gl = this.gl;
    const g = this.grade(ctx);
    Blend.none(gl);

    this._pass(this.pCopy, this.half, this.scene.tex, {});

    // brightpass -> mip0
    this._pass(this.pBright, this.mips[0], this.half.tex, {
      uTexel: [1 / this.half.w, 1 / this.half.h],
      uThreshold: g.threshold, uKnee: g.knee, uExposure: g.exposure, uFloor: g.veilFloor,
    });
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      this._pass(this.pDown, this.mips[i], this.mips[i - 1].tex,
        { uTexel: [1 / this.mips[i - 1].w, 1 / this.mips[i - 1].h] });
    }

    // --- tight halation: two cascaded 2D gaussians off mip1. halC is a
    //     further blur of halB, so halC - halB is a clean ring. ---
    const qt = [1 / this.halA.w, 1 / this.halA.h];
    const H = [1, 0], V = [0, 1];
    this._pass(this.pBlur, this.halA, this.mips[1].tex, { uTexel: qt, uDir: H, uStride: g.haloStride });
    this._pass(this.pBlur, this.halB, this.halA.tex, { uTexel: qt, uDir: V, uStride: g.haloStride });
    this._pass(this.pBlur, this.halA, this.halB.tex, { uTexel: qt, uDir: H, uStride: g.haloStride2 });
    this._pass(this.pBlur, this.halC, this.halA.tex, { uTexel: qt, uDir: V, uStride: g.haloStride2 });

    // --- the oriented layer. Ridge axis first, then two cascaded smears along
    //     it. The second pass re-reads the field, so the smear follows a bend
    //     instead of running off the end of a curved source. ---
    this._pass(this.pOrient, this.orient, this.mips[1].tex, {
      uTexel: qt, uSpan: g.streakSpan, uComp: g.streakComp,
      uSig: g.streakSig, uRidgePow: g.streakRidge,
    });
    this._pass(this.pStreak, this.streakA, this.mips[1].tex,
      { uTexel: qt, uStride: g.streakStride[0], uGate: 1 }, false, { uOrient: this.orient.tex });
    this._pass(this.pStreak, this.streakB, this.streakA.tex,
      { uTexel: qt, uStride: g.streakStride[1], uGate: 0 }, false, { uOrient: this.orient.tex });

    // --- the depth-ordering field. Reads the scene copy, not the brightpass:
    //     the brightpass has already discarded everything below threshold,
    //     which is the entire domain this field is about. ---
    this._pass(this.pFieldPre, this.field, this.half.tex, { uTexel: qt, uC: g.fieldC });
    this._pass(this.pFieldBlur, this.fieldA, this.field.tex,
      { uTexel: qt, uDir: H, uStride: g.fieldStride });
    this._pass(this.pFieldRes, this.field, this.fieldA.tex,
      { uTexel: qt, uDir: V, uStride: g.fieldStride, uC: g.fieldC });

    // --- wide veil: progressive upsample, stopping at mip2 so the tight
    //     scales stay out of it. The halation owns those. ---
    for (let i = BLOOM_LEVELS - 1; i > 2; i--) {
      this._pass(this.pUp, this.mips[i - 1], this.mips[i].tex,
        { uTexel: [1 / this.mips[i].w, 1 / this.mips[i].h], uRadius: g.bloomRadius, uWeight: UP_WEIGHT[i] },
        true);
    }
    // One tent up to quarter res, so the composite's bilinear read is smooth.
    this._pass(this.pUp, this.veil, this.mips[2].tex,
      { uTexel: [1 / this.mips[2].w, 1 / this.mips[2].h], uRadius: g.bloomRadius, uWeight: 1 });

    // --- composite ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    const p = this.pComp;
    gl.useProgram(p.program);
    const bind = (unit, tex, name) => {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
      if (p.u[name]) gl.uniform1i(p.u[name], unit);
    };
    bind(0, this.scene.tex, 'uScene');
    bind(1, this.veil.tex, 'uVeil');
    bind(2, this.halB.tex, 'uHaloB');
    bind(3, this.halC.tex, 'uHaloC');
    bind(4, this.streakB.tex, 'uStreak');
    bind(5, this.tex.dirt, 'uDirt');
    bind(6, this._spectrum(), 'uSpectrum');
    bind(7, this.half.tex, 'uHalf');
    bind(8, this.field.tex, 'uField');

    const U = p.u, f = (n, v) => { if (U[n]) gl.uniform1f(U[n], v); };
    const v3 = (n, v) => { if (U[n]) gl.uniform3f(U[n], v[0], v[1], v[2]); };
    gl.uniform2f(U.uRes, this.w, this.h);
    f('uTime', g.time); f('uExposure', g.exposure);
    f('uVeilAmt', g.veil); f('uVeilWiden', g.veilWiden); f('uVeilCap', g.veilCap);
    f('uHaloAmt', g.halo); f('uHalation', g.halation);
    f('uStreakAmt', g.streak); f('uDirtAmt', g.dirt);
    v3('uStreakTint', g.streakTint); v3('uHalationTint', g.halationTint);
    f('uChroma', g.chroma); f('uDefocus', g.defocus); f('uSmear', g.smear); f('uBarrel', g.barrel);
    if (U.uSmearOrg) gl.uniform2f(U.uSmearOrg, g.smearOrg[0], g.smearOrg[1]);
    f('uSmearCore', g.smearCore); f('uSmearFeather', g.smearFeather);
    f('uSmearEdge', g.smearEdge); f('uSmearChroma', g.smearChroma);
    f('uVignette', g.vignette); f('uVigFocal', g.vigFocal); f('uVigCorner', g.vigCorner);
    f('uWhite', g.white); f('uHueKeep', g.hueKeep);
    f('uSat', g.saturation); f('uContrast', g.contrast);
    f('uLift', g.lift); f('uBlack', g.black);
    f('uShelf', g.shelf); f('uShelfCentre', g.shelfCentre); f('uShelfWidth', g.shelfWidth);
    f('uFieldC', g.fieldC); f('uRangeLo', g.rangeLo); f('uRangeHi', g.rangeHi);
    f('uOcclSpan', g.occlSpan); f('uOcclCut', g.occlCut); f('uToeRange', g.toeRange);
    f('uOcclToe', g.occlToe);
    f('uShelfTrack', g.shelfTrack); f('uShelfBias', g.shelfBias);
    f('uShelfLo', g.shelfLo); f('uShelfHi', g.shelfHi);
    f('uShelfGate', g.shelfGate); f('uShelfClean', g.shelfClean);
    f('uGrainCoarse', g.grainCoarse);
    v3('uShadowTint', g.shadowTint); v3('uHighTint', g.highTint); v3('uLiftCol', g.liftCol);
    v3('uAbsorb', g.absorb); v3('uScatterCol', g.scatterCol);
    f('uScatter', g.scatter); f('uScatterBase', g.scatterBase); f('uScatterEdge', g.scatterEdge);
    f('uGrain', g.grain); f('uGrainChroma', g.grainChroma);
    f('uGrainNear', g.grainNear); f('uGrainFar', g.grainFar);
    f('uFlash', g.flash); v3('uFlashCol', g.flashCol);
    f('uFade', g.fade); f('uDesat', g.desat); f('uHush', g.hush);
    v3('uHushTint', g.hushTint);
    if (U.uWave0) gl.uniform4f(U.uWave0, ...g.wave0);
    if (U.uWave1) gl.uniform4f(U.uWave1, ...g.wave1);
    drawFullscreen(gl);
  }
}

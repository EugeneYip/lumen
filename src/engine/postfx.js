// HDR post-processing chain + the grade. This file owns the final image.
//
//   scene(RGBA16F)
//     -> brightpass   Karis average, soft knee, + a floor so ALL light scatters
//     -> 6-mip downsample
//     -> halation     3 cascaded gaussians of mip1  (tight, hugs sources)
//     -> veil         progressive upsample 5..2     (wide, low amplitude)
//     -> ridge+smear  2 passes along each source's OWN axis (short, oriented)
//     -> composite    spectral CA / astigmatic edge / speed smear, water medium,
//                     cos^4 vignette, hue-preserving filmic, split tone,
//                     black point, midtone shelf, clumped grain, TPDF dither
//
// Two bloom characters with independent weights is the whole point: a single
// blur radius for everything reads as a filter, not as light in a room. And the
// tonemap runs on the peak channel, not per-channel, so a hot cyan core lands
// on cyan-white and a hot amber core on amber-white instead of both on grey.
//
// Six things in here were wrong for a long time and are worth naming so they
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
//      an isotropic source contributes nothing at all - see ORIENT_FS. There
//      is no depth buffer to test against, but occlusion stops being the
//      question once the smear is a property of the source instead of a bar
//      across the frame; and at speed the scene's own velocity-stretched
//      sprites orient it, so the motion cue is one the world motivates
//      instead of one the glass asserts.
//   6. The black point gave the frame a floor and no ramp. Measured on the
//      build before this one: 71% of a mid-run frame below L16 and 5.0%
//      between L48 and L159, so the rock's strata, joints and sediment crust
//      existed in the scene at linear 0.01-0.04 and arrived compressed into
//      about 20 code values. The midtone shelf is a gain windowed on level -
//      zero at black so the blacks survive, zero at white so the cores and
//      the clipping fraction do not move, peaked on the low mids. It is still
//      one monotone function of one variable, which is what a response curve
//      is. A local operator would model the geology harder and would also be
//      the same lie the streak was: an unsharp mask draws an edge the scene
//      does not contain, and that is the complaint this round is answering.
import { compile, RenderTarget, drawFullscreen, FS_VS, GLSL_COMMON, Blend, texture2D } from './gl.js';

const clampN = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clampR = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerpN = (a, b, t) => a + (b - a) * t;
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
uniform sampler2D uScene, uHalf, uVeil, uHaloB, uHaloC, uStreak, uDirt, uSpectrum;
uniform vec2  uRes;
uniform float uTime, uExposure;
uniform float uVeilAmt, uVeilWiden, uVeilCap, uHaloAmt, uHalation, uStreakAmt, uDirtAmt;
uniform vec3  uStreakTint, uHalationTint;
uniform float uChroma, uDefocus, uSmear, uBarrel;
uniform vec2  uSmearOrg;
uniform float uVignette, uVigFocal, uVigCorner;
uniform float uWhite, uHueKeep, uSat, uContrast, uLift, uBlack;
uniform float uShelf, uShelfCentre, uShelfWidth;
uniform vec3  uShadowTint, uHighTint, uLiftCol;
uniform vec3  uAbsorb, uScatterCol;
uniform float uScatter, uScatterEdge, uScatterBase;
uniform float uGrain, uGrainChroma;
uniform float uFlash;  uniform vec3 uFlashCol;
uniform float uFade, uDesat, uHush;  uniform vec3 uHushTint;
uniform vec4  uWave0, uWave1;
in vec2 vUv; out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Interleaved gradient noise - free, tight, temporally stable.
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// Emulsion grain: one clumped octave plus per-pixel salt. Pure per-pixel noise
// reads as a digital sensor; the clumping is what makes it read as film.
float grain(vec2 p, float s){
  float clump = vnoise(p * 0.55 + s);
  float fine  = hash12(p + s * 7.31);
  return (clump * 0.70 + fine * 0.30) - 0.5;
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
  float smK  = uSmear * min(rlenS, 0.62);
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
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for(int i=0;i<6;i++){
    float d = ((float(i) + 0.5 + jit) / 3.0) - 1.0;      // -1 .. 1
    float w = exp(-d * d * 2.4);
    vec2 base = uv + dirS * (d * smK) + perp * (d * defK);
    acc += (texture(uHalf, base + dirR * caK).rgb * swO
          + texture(uHalf, base).rgb              * swM
          + texture(uHalf, base - dirR * caK).rgb * swI) * w;
    wsum += w;
  }
  acc /= max(wsum, 1e-4);

  // On axis nothing is displaced, so keep the full-res tap; the dispersed
  // version fades in exactly where the lens stops being sharp. That is also
  // where the edge softness comes from - it is one effect, not two. With the
  // smear anchored on the mote this now stays near zero AT the mote at any
  // speed, which is the whole point: the protagonist keeps its full-res peak.
  float soft = clamp((caK + smK + defK) * uRes.x / 2.2 - 0.35, 0.0, 1.0);
  vec3 col = mix(texture(uScene, uv).rgb, acc, soft) * uExposure;

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

  col += halB * uHaloAmt;
  col += veil * uVeilAmt;
  col += ring * uHalationTint * uHalation;
  // The oriented layer. Near-neutral tint on purpose: it used to be cooled,
  // which is right for anamorphic glass and wrong for an organism's own light.
  col += texture(uStreak, uv).rgb * uStreakTint * uStreakAmt;
  col += uFlashCol * uFlash;      // pre-tonemap, so a flash rolls off filmically

  // --- the water you are inside. Absorption eats red first; inscatter lifts
  //     the frame toward its edges, where the sightline through water is
  //     longest. Both belong before the curve so the curve sees real light.
  //     The edge term used to sit on a constant of 1.0, which is a haze floor
  //     on the middle of the frame - precisely where the deepest water is
  //     supposed to be, and where the eye is. It is nearly all path length
  //     now, so the centre can go dark and the corners still breathe. ---
  float path = 1.0 + 1.45 * rn2;
  vec3 kA = uAbsorb * path;
  col *= 1.0 - kA + 0.5 * kA * kA;          // exp(-kA) to 2 terms; kA stays small
  col += uScatterCol * (uScatter * (uScatterBase + uScatterEdge * rn2));

  // --- vignette as light loss, not as a dark disc pasted on the result.
  //     cos^4 of the field angle, plus a little mechanical corner cut. ---
  float cosT = uVigFocal * inversesqrt(uVigFocal * uVigFocal + rlen * rlen);
  float c2 = cosT * cosT;
  float vig = c2 * c2 * (1.0 - uVigCorner * smoothstep(0.58, 1.0, rn));
  col *= mix(1.0, vig, uVignette);

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
  //     A colourist subtracts here instead of adding. L*L/(L+k) is
  //     asymptotically L-k but goes into zero quadratically, so the near-black
  //     water rolls off rather than clipping to a flat plate; and doing it on
  //     luminance and rescaling the chroma means the deep water keeps its own
  //     colour all the way down instead of turning grey on the way to black. ---
  L = dot(col, LUMA);
  float Lb = (1.0 + uBlack) * L * L / (L + uBlack + 1e-6);
  col *= Lb / max(L, 1e-5);

  // What is left of the lift: chroma, not level. A few thousandths of the
  // trench's own blue-green so the floor reads as deep water rather than as a
  // dead sensor, weighted into blue where the luma coefficient is 0.07 instead
  // of green where it is 0.72. That is the whole difference between a colour
  // cast and a pedestal.
  col += uLiftCol * uLift * (1.0 - smoothstep(0.0, 0.16, Lb));

  // --- the midtone shelf. The black point fixed the floor and left no ramp:
  //     the geology arrived as silhouette rather than as modelled surface,
  //     with 71% of a frame under L16 and 5% between L48 and L159. A gain, not
  //     an add - an add here is a pedestal and this file has already paid for
  //     that lesson once. And a gain on luminance with the chroma riding along,
  //     so the newly-opened rock keeps the water's colour.
  //
  //     The window is gaussian in log2 luminance, and it has to be, because the
  //     two things it must not touch are only a factor of 11 apart. Below sits
  //     the floor: code 12 is 4x under the centre and lifting it dissolves
  //     every silhouette - measured, the 450m stalactites lost their width and
  //     the frame went milky when an earlier rational window carried 42% of
  //     its gain down there. Above sits the mote's own halo: the focal metric
  //     averages an annulus 42-58px out, which lands at code 58, only 3x over
  //     the centre, and every point of gain there is a point off the hero's
  //     read. A window in L/(L+k) cannot be tight on both sides at once; one
  //     in log L can. This one is 0.01% at L8, 5% at L16, full at L32, 28% at
  //     L48 and 4% by L58 - so it expands code 16-40 by about 1.6x, which is
  //     the falloff from a lit rock face into shadow, and leaves both ends
  //     alone. Measured on the same scene at four depths: the 16-31 band drains
  //     by 4-11 points into 32-47, and the fraction below L8 goes UP by 1.2-3.1
  //     points rather than down.
  //
  //     It also pays for the white point. The toe gain is WHITE_REF/white, so
  //     the white point was doing midtone work at 0.2 of measured focal
  //     contrast per 1.0 - the shelf buys the same midtone without touching
  //     the top of the curve, so the white point went back up.
  L = dot(col, LUMA);
  float sd = log2(max(L, 1e-6) / uShelfCentre) / uShelfWidth;
  col *= 1.0 + uShelf * exp2(-sd * sd);

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
  //     crawling under a moving camera. At L8 it is under half a code value. ---
  float gs = hash11(floor(uTime * 24.0) + 0.5) * 311.0;
  float gn = grain(fc, gs);
  float gc = hash12(fc + gs * 1.7 + 3.71) - 0.5;
  float gl = dot(col, LUMA);
  float gw = smoothstep(0.014, 0.12, gl) * (1.0 - 0.62 * smoothstep(0.52, 1.0, gl));
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
  vignette: 0.68,
  vigFocal: 0.95,
  vigCorner: 0.28,
  // Went to 10.6 to buy midtone, and back up now that the shelf buys it more
  // cheaply. The toe gain is WHITE_REF/white, so dropping the white point
  // lifts the whole low end - including the mote's own surround, at about 0.2
  // of measured focal contrast per 1.0. The shelf does the same job with a
  // window that dies before the surround, so this can go back to sitting where
  // the shoulder belongs, which is also where the hot cores keep their ladder.
  white: 11.0,            // linear value the shoulder is built around
  hueKeep: 7.0,           // higher = hue survives further up the shoulder
  saturation: 1.06,
  contrast: 0.145,
  // The blacks: subtract, do not add. uBlack is the soft black point in display
  // space and it is what makes the abyss reach black at all; uLift is now only
  // the colour of the floor, at a luminance too low to be a pedestal.
  black: 0.0020,
  lift: 0.0045,
  // The ramp. Gaussian in log2 luminance, centred on display-linear 0.0145 -
  // code 32, the band the rock was compressed into - and 0.85 octaves wide,
  // which is the widest that still dies before the mote's halo at code 58.
  shelf: 0.72,
  shelfCentre: 0.0145,
  shelfWidth: 0.72,
  grain: 0.048,
  grainChroma: 0.32,
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

    this.pBright = compile(gl, FS_VS, BRIGHT_FS, 'bright');
    this.pDown = compile(gl, FS_VS, DOWN_FS, 'down');
    this.pUp = compile(gl, FS_VS, UP_FS, 'up');
    this.pBlur = compile(gl, FS_VS, BLUR_FS, 'blur');
    this.pOrient = compile(gl, FS_VS, ORIENT_FS, 'orient');
    this.pStreak = compile(gl, FS_VS, STREAK_FS, 'streak');
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
      this.orient, this.streakA, this.streakB]) t.resize(qw, qh);
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
      // Capped so the widest excursion stays inside ~2px of tap spacing at
      // 1600 wide. Longer than that and six taps read as discrete ghosts.
      smear: sk * 0.0060 + lg * 0.0050 + slow * 0.0020,
      smearOrg: this._smearOrigin(ctx),
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
      black: G.black * (1 + depthK * 0.30 + deadK * 0.45),
      lift: G.lift,
      // The Hush already floods the frame and death is closing it; neither
      // moment wants the ramp opened as well.
      shelf: G.shelf * (1 - hush * 0.35) * (1 - deadK * 0.55),
      shelfCentre: G.shelfCentre,
      shelfWidth: G.shelfWidth,
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
    f('uVignette', g.vignette); f('uVigFocal', g.vigFocal); f('uVigCorner', g.vigCorner);
    f('uWhite', g.white); f('uHueKeep', g.hueKeep);
    f('uSat', g.saturation); f('uContrast', g.contrast);
    f('uLift', g.lift); f('uBlack', g.black);
    f('uShelf', g.shelf); f('uShelfCentre', g.shelfCentre); f('uShelfWidth', g.shelfWidth);
    v3('uShadowTint', g.shadowTint); v3('uHighTint', g.highTint); v3('uLiftCol', g.liftCol);
    v3('uAbsorb', g.absorb); v3('uScatterCol', g.scatterCol);
    f('uScatter', g.scatter); f('uScatterBase', g.scatterBase); f('uScatterEdge', g.scatterEdge);
    f('uGrain', g.grain); f('uGrainChroma', g.grainChroma);
    f('uFlash', g.flash); v3('uFlashCol', g.flashCol);
    f('uFade', g.fade); f('uDesat', g.desat); f('uHush', g.hush);
    v3('uHushTint', g.hushTint);
    if (U.uWave0) gl.uniform4f(U.uWave0, ...g.wave0);
    if (U.uWave1) gl.uniform4f(U.uWave1, ...g.wave1);
    drawFullscreen(gl);
  }
}

# AI_HANDOFF

Orientation for a contributor — human or AI — arriving with **only this
repository**. No prior conversation is needed. Tool-neutral: nothing here
assumes a particular agent or vendor.

Read in this order: `README.md` (what and how to run) → this file (why and what
to watch out for) → `AGENTS.md` (the working contract if you are going to
delegate to sub-agents).

## 0. First three commands

```bash
node tools/state.mjs                    # repo state: HEAD, dirty files, branches, worktrees
node tools/check.mjs --seeds 7,3        # authoritative quality gate
node tools/playtest.mjs                 # the REAL rAF loop, real input events, real audio
node tools/serve.js                     # play it at http://localhost:5173/
```

`check.mjs` drives the simulation directly, which is what makes captures
reproducible but also means it never exercises the production path.
`playtest.mjs` covers that gap: no `?headless=1`, so the real loop, the
accumulator under variable frame time, real mouse events and audio all run.

Never transcribe repository state into prose; it goes stale immediately. Derive
it with `tools/state.mjs`.

## 1. What the game is, and the creative direction

LUMEN — Deep Drift. One button, one verb, one decision: **when to let go.**

Three pillars, in priority order. When they conflict, the earlier one wins.

1. **FEEL.** The swing must read in your wrists. If a change makes the frame
   prettier and the swing worse, it is a bad change.
2. **LIGHT.** Everything visible either emits light or occludes it. Bloom is the
   art direction, not a filter applied afterwards.
3. **ONE BUTTON.** No tutorial, no menus, no second verb. Depth comes from
   timing alone. Resist every temptation to add a mechanic; the game is a
   difficulty curve over a single input.

Aesthetic: a cold, vast, pressurised abyss lit by bioluminescence. Deep teal
water, warm amber anchors as the counter-note, mint plankton, magenta reserved
for danger, violet for the Hush. Three accent colours with distinct jobs beats
ten. Restraint reads as expensive.

**Hard constraint, and it is load-bearing:** zero asset files, zero runtime
dependencies, no build step. Textures, audio and geometry are all synthesised at
boot. Do not introduce an asset pipeline, a bundler, or a package the game
imports at runtime. This is why it loads instantly, and several design decisions
(procedural sprite atlas, synthesised reverb impulse) only make sense in that
light.

## 2. Architecture

```
index.html          shell, boot error trap, splash removal
src/main.js         fixed-step loop, state machine, frameCtx, capture API
src/engine/
  gl.js             WebGL2 helpers, RenderTarget, shared GLSL
  math.js           easing, damping, springs, colour
  rng.js            seeded RNG + value noise / fbm  (ALL randomness comes from here)
  sprites.js        instanced quad batch, one draw call per flush
  ribbons.js        glowing polylines with a gaussian cross-section
  textures.js       procedural sprite atlas + support textures
  postfx.js         HDR chain and the grade
  audio.js          synthesised soundscape
  input.js          one-button input, unified across mouse/touch/key
src/game/
  background.js     the abyss (one fullscreen shader)
  render.js         scene assembly and creature art
  world.js          procedural generation and layout
  player.js         physics and the tether
  camera.js         camera feel
  particles.js      particle + ambient VFX
  hud.js            UI on a 2D overlay canvas
src/art/palette.js  colour system
```

### The seam that makes parallel work possible

`main.js` builds **one `frameCtx` object per frame** and hands it to
`background.draw`, `scene.draw`, `post.render` and `hud.draw`. It carries
everything: `cam, world, player, particles, ambient, tex, t, dt, mode, depth,
best, mult, chain, speed, speedK, hushProx, launchGlow, brushGlow, tetherGlow,
attached, inDraft, difficulty, slow, flash, flashCol, fade, envDim, waves,
pixelW/H, cssW/H`.

Consequence: any one visual module can be rewritten in place without touching
the others or `main.js`. If you need a signal that is not in `frameCtx`, derive
it from `player`/`world`/`cam`, which are all present. This seam is deliberate —
it is what let nine agents work concurrently without merge conflicts.

### Coordinates and units

World units, **Y down**. The camera shows 1080 world units vertically at zoom 1.
**10 world units = 1 metre** of score. The swimmable band is
`world.bandTop(x) .. world.bandBot(x)`; outside it is rock. Those two functions
are load-bearing for both physics *and* the visible rock — `background.js`
samples them into a strip texture so the drawn wall matches the collision wall.

### Rendering model

Scene renders into an **RGBA16F HDR target**; `postfx.js` tonemaps it. Values
above 1.0 are correct and expected — that is what drives bloom. Dark occluders
use premultiplied blending, light uses additive; `render.js` documents the pass
order, and that order *is* the art direction.

## 3. Invariants — break these and something subtle breaks

1. **Determinism.** No `Math.random()`, no `Date.now()`, no `performance.now()`
   anywhere that affects simulation or rendering. Use the seeded RNG in
   `src/engine/rng.js` or the clock passed in. Replaying a seed must reproduce
   both the simulation state and the rendered image, because that is the only
   reason screenshots from two builds can be compared at all. `check.mjs`
   asserts both: a rounded state fingerprint after 1200 steps, and a hash of the
   rendered pixels. Note it compares two runs *within one page load*, so it
   catches state leaking between runs but not cross-machine reproducibility.
   Machine-persistent state must not reach the renderer — the personal best is
   forced to 0 in headless for exactly this reason.
   The gate also re-renders a **frozen** state five times and fails if the
   images differ. That is strictly stronger than comparing two runs, and it is
   what caught a shader that varied per draw call while every input was
   identical. If you touch a shader, run `node tools/_det3.mjs`.
2. **Frame-rate independence.** The sim is a fixed 120Hz step. Never use a raw
   per-step multiplier for damping or friction — use `damp`/`spring` from
   `math.js`. At 120Hz `v *= 0.86` annihilates all velocity in under a second.
   This shipped once as an inescapable bug.
3. **`t` is run-relative.** `frameCtx.t` resets each run so a replayed seed
   animates from the same phase; `frameCtx.simT` is the monotonic clock the
   capture harness seeks against. Using the wrong one silently destroys
   reproducibility.
4. **Audio is driven by the wall clock, never by the sim step.** A single frame
   can run many steps, and scheduling WebAudio automation per step is quadratic
   in Chrome — it once made the capture harness unusable. `audio.silent` must be
   honoured everywhere; headless capture sets it.
5. **Arrays in `world.js` stay sorted by ascending `x`.** Several hot loops
   `break` on `x` and will silently miss objects otherwise. Sorting each
   generated phrase block is *not* sufficient — blocks overlap, so `pushAll`
   merges rather than concatenates. This shipped broken once: 1-4 inversions per
   seed made 18 plankton silently uncollectable and invisible on seed 7, which
   corrupted the scoring mechanic with no visible error. `check.mjs` now asserts
   global ordering on every list.
6. **Additive-only module APIs.** Modules are owned by different contributors
   and cannot edit each other. Add exports and fields; do not remove or rename.
7. **In headless capture, `render()` runs once** at the end of thousands of
   `step()` calls. Anything depending on per-frame render state does not exist
   during the simulated run. Drive simulation from `step`-reachable state only.

## 4. Quality contracts — executable, not aspirational

`node tools/check.mjs --seeds 7,3` is **authoritative**. It must pass before any
commit. The thresholds live in `BUDGET` and `HDR` at the top of that file; the
file is the source of truth and this section only explains it.

### The exposure contract

The scene and the grade are authored separately. Without a shared reference they
run away from each other, and did: the water bulk sat at linear 0.13, nothing in
frame exceeded 1.0, and the result was a milky mid-grey wall with no shadows, no
highlights and no shoulder for the tonemap. Measured on the **linear HDR scene
before tonemapping**:

| statistic | target | why |
|---|---|---|
| `p50` (water and rock bulk) | **< 0.03** | most of an abyss is deep shadow |
| `p90` | < 0.15 | only a small part of the frame is lit |
| `p99` | **> 0.25** | there must be real highlights |
| `max` (emitter cores) | **> 6** | bloom and the tonemap shoulder need something genuinely hot |

Final tonemapped frames land at mean sRGB luminance **0.08-0.20** in practice;
the gate enforces the wider **[0.045, 0.240]** so that a deliberate dark or
bright moment is not blocked. `hushNear` has a documented per-scene allowance in
`HDR_SCENE` because the Hush is meant to flood the frame — the allowance sits
just above the measured value so it cannot quietly widen.

Measure, do not guess:

```js
await page.evaluate(() => window.LUMEN.hdrStats())   // { mean, p10, p50, p90, p99, max }
```

Division of responsibility: the **environment** authors the dark bulk, the
**scene renderer** supplies hot emitter cores, **postfx** owns the response
curve. That split was established after all three drifted at once.

### Other contracts checked

Zero console errors; per-scene mean luminance, contrast spread (a flat image
fails) and clipping fraction; render and step budgets; that every object list in
`world.js` is globally sorted by `x`; and that the deterministic autopilot can
still play (a level it cannot traverse is broken).

**Failures block; warnings do not.** Boot time and the HDR `p90` guideline are
warnings on purpose — boot time is noisy under machine contention, and `p90` is
a composition guideline rather than a defect. Everything else fails the run.
`check.mjs` exits non-zero only on failures.

## 5. Capture and review workflow

The capture harness (`tools/shoot.mjs`) seeks to **named moments** — `title,
tethered, launch, fast, hazardNear, hushNear, deep, dead` — via
`window.LUMEN.seekUntil`, rather than to wall-clock times. That is what makes
"the same kind of moment" comparable across builds even as the physics changes.

`window.LUMEN` exposes: `ready`, `seekTo(t)`, `seekUntil(cond, maxT)`, `stats()`,
`hdrStats()`, `game`. Query params: `?headless=1`, `?seed=N`, and debug switches
`?debugLayers=1` (false-colour sprites by atlas layer), `?noSprites=1`,
`?noRibbons=1`. Those switches exist because they are how the worst artefact in
the project's history was attributed to the right file — see §7.

### The critic loop

`tools/CRITIC.md` is the protocol. In short: capture two builds, produce blind
pairs with `montage.mjs pair` (LEFT/RIGHT randomised per pair, mapping written to
a separate `key.json`), and give a reviewer **only the pair images** — never the
key, never the directory listing. It commits to a winner, a margin, and absolute
1-10 scores per axis. A "slight" win is a failed iteration.

Grade inflation is the failure mode to guard against, because the score decides
whether to keep iterating.

## 6. Decisions whose rationale is not obvious from the code

- **Named-scene seeking instead of fixed timestamps.** Physics changes move the
  player, so `t=6s` is a different situation in every build. Naming the moment
  keeps comparisons honest.
- **Sprite masks are gamma-encoded** (`SPRITE_GAMMA`) to buy precision in the
  faint glow tails at 8-bit. Consequence: the mip chain **must** be built by
  hand in linear space. `generateMipmap` box-filters storage values, and
  averaging gamma-encoded data is not averaging — one bright texel beside three
  dark ones decodes to 0.047 instead of 0.25.
- **Ribbons floor sub-pixel widths and compensate alpha.** A sub-pixel glowing
  line shimmers under a moving camera; widening it and dimming it by the same
  factor conserves energy and stops the flicker. Miter compensation keeps stroke
  width constant through bends.
- **The vent along the trench floor is a current with a velocity target, not an
  upward force.** A force that opposes gravity finds an equilibrium and parks
  the player there forever, out of tether range. That was an unavoidable death.
  A current cannot have that equilibrium.
- **Release is worth ~23x between best and worst timing**, gated by a load timer
  — without the gate, spamming taps acted as continuous thrust and beat every
  real strategy.
- **`world.js` used to mirror physics constants by hand** and a +19% gravity
  change silently invalidated its reachability model. It now verifies against
  the real `Player` class (`tools/_reach.mjs`). Prefer measuring the real system
  over duplicating its constants.
- **Hazards are excluded from the swing annulus** (near straight-down, between
  `ropeMin` and `ropeMax` of their anchor). A tethered mote is on rails through
  the bottom of its arc and cannot dodge. To the *side* a hazard is fair and
  interesting, because it changes when you release.
- **No auto-exposure**, deliberately. It would mask exactly the contract
  violations `check.mjs` exists to catch.

### Three shape traps that have each bitten more than once

**A ribbon cannot draw a soft edge at any tuning.** Its cross-section is
`exp(-x^2 * falloff)`, so at the low falloff that reads as "solid" the value at
the ribbon's own edge is still ~0.2-0.37 of peak, and its ends are butt caps.
A short low-falloff stroke is therefore a filled quadrilateral with hard steps,
not a body. This produced the mote's rim reading as a selection bracket, the
spire's "machined rectangle", and the trapezoids under every anemone colony.
For anything that must fade to nothing, use a sprite — it reaches zero inside
its own quad. `S.VOLUME` is the profile that is opaque through the middle *and*
reaches exactly zero, which is what a ribbon cannot do.

**A stretched quad is a straight line.** Its medial axis *is* a segment, and
whatever the profile does across the width is compressed by the aspect, so no
choice of sprite saves a high-aspect quad. The four-review "ruled diagonal" was
one `S.SHARD` quad at 13.5:1 — and `S.SHARD` was chosen precisely because it
tapers at both ends and "cannot have a straight side however far it is
stretched". True, and beside the point: it has no straight side because it is
nothing but a straight line. If a thing must not read as ruled, build it from
several offset pieces, so no straight line passes through more than one.

**A branch on a world coordinate has a locus, and that locus is a line.**
Any `if` in a shader that tests a world position, and any level set of a
world-space field, draws its own boundary wherever the value it separates is
discontinuous across it — and if that boundary happens to be straight, it reads
as a ruled seam through the frame. Two instances landed in a single round:

- The fault-block partition sat at integer values of
  `(x + y*LEAN)/FAULTW + faultShear(y)`, so the plane's world slope is
  `-(LEAN + FAULTW * faultShear'(y))`. The shear term alone swings ±0.253, so
  against a lean of `0.19` the slope **passes through zero** and the fault draws
  a dead vertical line down the whole frame. The lean is now `0.58`, which
  bounds the slope away from zero by more than the camera roll can cancel.
- The Hush block was gated `if (dxh < 3000.0)` while every term inside keys off
  a drain front whose reach runs 1905–3215 — so the bound sat *inside* the range
  the front can occupy, and cut the front's rim in half along a vertical line.
  It is now gated on distance to the front itself, provably outside every term.

This is the same defect that produced the grey rectangles in §7 — a hard
threshold on a cell-hashed god-ray mask, so a cell boundary became a visible
axis-aligned edge. Three instances in this repository, each found by a different
route, each initially attributed to something else. It is the single most
productive thing to check when a reviewer reports a straight line nobody drew.

The rule that falls out: **gate on the field, not on a coordinate.** If a branch
must exist, place its bound where everything inside it is already zero, or
window the longest-tailed term to zero at the bound so the branch cannot draw
its own boundary. And if you own a level set, check what its slope does across
the whole range of its parameters, not at the value you happened to test.

A corollary worth having: when a kill switch fails to remove an artefact, that
is information, not a dead end. `bgNoDip` left the seam exactly where it was,
which is what proved the dip was never the only thing stepping — the bed
thickness and the warp phase were hashed per block too, and neither was under
that switch. Three unrelated jumps at one x is not a displaced layer.

### There is no depth buffer, so you cannot hide anything behind geometry

The scene paints over whatever the background shader already drew. Burying a
cap below `world.bandBot` does **not** conceal it — a technique several places
relied on, and the reason a buried butt cap was as visible as an exposed one.
Fade across the band instead.

### Determinism has a specific GPU trap

Implicit-derivative mip LOD selection in non-uniform control flow will make the
renderer vary *per draw call* while every input is identical. If a shader
samples a mipmapped texture from inside a branch or after an early return, use
`textureLod` with an analytic level. `node tools/_det3.mjs` renders one frozen
state five times and is the fastest way to see it.

## 7. How artefacts have actually been diagnosed here

Worth reading before you guess at a rendering bug. Grey rectangles littered
every frame for a long time. Three different contributors attributed them to the
particle system, the sprite atlas, and mipmap damage. All three were wrong.

What settled it: `?noSprites=1` and `?noRibbons=1` kill-switches. With **both**
passes disabled the rectangles persisted and still translated with the world,
which eliminated screen-space post and named the background shader. The cause
was a hard threshold on a cell-hashed god-ray mask, so a cell boundary became a
visible axis-aligned edge, which the grade's dispersion then fringed.

Two lessons, both cheap: **isolate by elimination rather than by reasoning**, and
**look at 1:1 crops**. Downscaled contact sheets hid this artefact, a dashed
"debug ellipse" around the player, and a rainbow-confetti bug, for multiple
review passes each.

The kill-switches exist for this: `?noSprites=1`, `?noRibbons=1` and
`?debugLayers=1` (false-colour every sprite by its atlas layer, so an artefact's
colour names its source). Between them, four separate ring artefacts on the
player were each attributed to the right file, twice overturning a confident
wrong guess — including one of mine.

**Distrust your own harness before you distrust the art.** A blind reviewer once
diffed the panels it had been handed and found that four of five "comparisons"
showed the same frame twice, because a filename-tagging regex collapsed five
distinct frames to one key. It cost an entire review round, and the symptom was
visible in the output filenames the whole time. `montage.mjs` now hard-fails on
duplicate tags, partial coverage, and byte-identical frames within one build.

**One straight edge in the frame is not a defect and you should not chase it.**
The largest column-to-column step in every `hushNear` frame, on every seed, is at
x=51 and x=2 — that is `hud.js`'s "THE HUSH" panel and its rule. HUD is composited
into the captured frame, so it appears in any statistic taken over the image, it
is identical across builds, and it does not move under `bgNoHush`. Verify a
candidate seam is not HUD before you go looking for it in a shader.

## 8. Known weaknesses and active investigation

Verify each against the current code before acting; some may be fixed. The
authoritative snapshot of quality is whatever `node tools/check.mjs --seeds 7,3`
says today, plus a blind review per `tools/CRITIC.md`.

**Most recent blind review** (five pairs, simulation byte-identical between the
two builds so every difference was purely rendering): the current build won all
five pairs, scored **6.1 mean** across nine axes, and the verdict was **No** to
shipping. Highest axis was light behaviour (7); lowest was motion legibility (5).
Its three ranked problems, all open at the time of writing:

1. **The hero is the weakest-crafted object in its own frame.** The anchor bell
   membranes, the barbed kelp and the seabed anemones all carry more internal
   structure than the player does. The prescription: give the mote a body — a
   translucent sac with a visible nucleus and trailing cilia that lag behind the
   velocity vector — and make its halo an anisotropic ellipse stretched along
   travel rather than a circle, so its shape alone reads direction. Constraint:
   focal contrast must stay above 4:1, so new structure has to sit inside the
   core radius or be genuinely dark.
2. **The anamorphic streaks read as a filter, not light.** Every bright object
   throws a level bar across the full frame that passes *in front of*
   silhouettes it should be behind. There is no depth buffer to test against, so
   either approximate occlusion or replace the streak with a short
   emitter-oriented anisotropic bloom.
3. **Speed is invisible in a still.** In a distance game the HUD is doing work
   the image should do. Cues belong on the world (plankton streaked along
   travel, near-ground directional smear, a wake whose length is the speedometer)
   and explicitly **not** on the hero — smearing the player is what made an
   earlier build's tether read as a flat desaturated ribbon.

Runners-up from the same review: geometry floats (kelp and reeds terminate on a
flat horizontal baseline instead of intersecting the seabed — `world.bandBot(x)`
is cheap and pure, so strands can be planted at the real floor); the lower ~40%
of some frames is dead space; and there is no depth-absorption gradient, so far
and near read at the same contrast despite `palette.js` providing `depthFade`
and `absorb` and every decor item carrying a `depth` field.

**A negative result worth not repeating: frame-wide statistics cannot gate
craft.** Two rounds regressed by over-optimising a one-sided target — chasing
the shadow floor deleted a wall plane, and chasing hero salience by capping peak
values flattened hand-placed coral and anemone props into airbrush. The obvious
response is a counterweight metric, and it was tried: mean absolute Laplacian,
then the 90th percentile at native resolution. **It does not work.** Measured
across the exact pair of builds where a reviewer could plainly see one prop go
from beaded filaments to a gas cloud, the number moved about 1% — consistent in
direction across all five scenes, far too small to gate on. The defect occupies
a fraction of a percent of the frame and any frame-wide statistic is swamped by
grain and rock.

The `detail` column is kept as a reported trend line, not a threshold. **The
instrument that actually catches this class of defect is the blind review** —
it caught both regressions, and neither was visible in any number. That is the
argument for keeping `tools/CRITIC.md` in the loop rather than treating the gate
as sufficient. A metric can prove a specific claim; only a reviewer notices what
nobody thought to measure.

Longer-standing items:

- **Named scenes are seeked in sequence, so a later scene can land on the frame
  after an earlier one.** `check.mjs` and `shoot.mjs` walk the scene list
  without restarting between entries, so a predicate that is *already true*
  when the previous scene resolved is satisfied one step later and the two
  "different" moments are the same frame: A/B coverage is quietly one pair
  short, and every warning from that frame is reported twice, which overstates
  how broadly the defect was sampled. `launch`/`fast` had this and it is fixed
  (12ac90a) — the two are now mutually exclusive on `launchGlow`, `> 0.55`
  against `< 0.15` decaying at 5.5/s, so at least 0.24s of sim must pass
  between them; measured 24-113m apart on 20 seeds, so that pair cannot
  collide again. **`deep` still collides**, and is the worse case because it
  tests `maxX` — a run maximum that only resets in `newRun()` — so it is a
  latch, not a moment. Whether it duplicates depends on where the *previous*
  seeks left the run, which is exactly why it hides. Seek the canonical
  `shoot.mjs` list (`node tools/_collide.mjs 2,3,4,5,6,7,8,9,10,11,42
  title,tethered,launch,fast,hazardNear,hushNear,deep`) and `deep` lands one
  step after `hushNear` at identical depth on 7 of 11 seeds (3, 4, 5, 8, 9, 10,
  11), distinct only where the run was still shy of 600m (2, 6, 7, 42). Seek
  `hushNear,deep` alone and seeds 3 and 5 stop colliding, because `hazardNear`
  is no longer ahead of them to carry the run past the threshold first. Fix is
  either a restart before each seek — the HDR block in `check.mjs` already does
  this and says why — or a predicate describing a moment rather than a
  threshold already crossed. Both live in lead-owned files.
- ~~Two `tethered` frames cannot reach black.~~ **Resolved, and instructive.**
  Two owners investigated this in good faith and both concluded, correctly, that
  it was not theirs: postfx measured that a 0.020 black point (10x what shipped)
  only reached 8% while costing 27% of the mean, and the environment proved by
  painting its own output pure black that the frame *still* rendered a uniform
  0.057 field with 0% below L8. It was neither. `startPlay()` sets a 0.22
  full-screen flash that decays at 7.5/s, and the `tethered` predicate resolved
  at t=0.26s with that flash still lit, adding a flat +0.025 linear to every
  pixel. **The scene was sampling the opening flash rather than ordinary play.**
  Waiting for the flash to clear moved shadow from 0.0% to 12-22% and spread
  from 0.138 to 0.179-0.209 with no art change at all.
  The general lesson, which has now cost several rounds: when two owners each
  prove a defect is not theirs, suspect the measurement before suspecting a
  third owner. Scene predicates decide *when* a frame is sampled, and a
  predicate that resolves during a transient measures the transient.
- **Difficulty tuning drifts as movement improves.** Every time the swing gets
  better the curve gets easier. Re-run `tools/_probe.mjs` and `tools/_reach.mjs`
  after any physics change. `_reach.mjs` reports roughly one dead-end anchor per
  seed, which has never been triaged as tolerance-or-defect.
- **Audio has never been verified by ear** — only structurally, via offline
  render and spectrogram inspection. `tools/playtest.mjs` does confirm the
  autoplay path works: audio initialises from a real gesture in a real loop.
- **Never run a performance investigation alongside a capture-heavy agent.**
  Every agent here drives its own headless Chrome, and GPU contention has now
  produced false readings three times: a render budget measuring 7.9ms and
  22.8ms for the same build, a boot time varying 5x, and an HDR percentile
  swinging past its own margin. `check.mjs` and `tools/_perf.mjs` both take a
  best-of-N minimum, which is the right estimator because contention can only
  slow things down — but a minimum over a contended window is still not the
  same as an idle measurement. Sequence perf work alone.
- **Frame pacing cannot be measured authoritatively without a display.**
  `playtest.mjs` drives the real rAF loop with real mouse events, but headless
  Chrome has no display and its compositor halves the rate on its own. It used
  to *fail the run* on that, three lines after printing a note saying the number
  could not be trusted. Interleaved runs of HEAD against a control commit from
  before a whole round of rendering work — old, new, old, new, same minute —
  failed both builds by the same margin and in both directions, so the statistic
  has no power to separate them. Pacing is now **reported as a trend, not
  gated**; what `playtest.mjs` still fails on is what a display cannot fake —
  the sim keeping up, real mouse events reaching the tether, and audio starting
  from a real gesture. Those are its actual job, since it is the only thing that
  runs the production path at all.
  The budgets underneath are comfortable and measured, and `check.mjs` owns
  them because it measures work done rather than the gap between rAF callbacks:
  CPU ~5.6ms per frame of which the 2D HUD is ~0.5ms, and the GL chain ~2-3.4ms
  at 1280x720 with `gl.finish()`.
  Someone should still confirm real pacing on a machine with a screen; nothing
  here can. **Do not re-gate it without evidence that the number discriminates.**
- **`tools/_*` are scratch instruments**, deliberately kept because they are how
  most real bugs here were found. Not tests, no pass/fail contract, may rot:
  `_hair.mjs` (ruled-hairline notch energy over a region — the instrument the
  "straight line nobody drew" defects needed and did not have),
  `_probe.mjs` (level coverage, phrase mix), `_reach.mjs` (fairness against the
  real `Player`), `_feel.mjs` (movement, many modes), `_spot.mjs` (dumps the
  level around a death), `_grade.html`/`_grade.mjs` (synthetic HDR bench),
  `_atlas.*` (sprite atlas viewer), `_audio.mjs` (offline audio + spectrogram),
  `_det3.mjs` (frozen-state render stability), `_shaft.mjs`/`_slot.mjs` (god-ray
  fields), `_collide.mjs` (per-scene time/depth/frame-hash table, for catching
  two named scenes that resolve to one frame), `_sortcheck.mjs` (x-ordering,
  now also in `check.mjs`). Note
  `_atlas.mjs` and `_grade.mjs` hardcode an absolute repo path.
- **`shots/` is gitignored**, so "compare against the previous build" has no
  baseline on a fresh clone. Capture one first. To compare against an *older
  commit*, add a detached worktree at that commit, symlink `node_modules` into
  it, and capture from there — the primary tree is never disturbed.
- **Nothing mechanically enforces the gate before a commit** — no CI, no hooks.
  `npm test` runs it.

## 8b. Branches left by autonomous sessions

`node tools/state.mjs` lists these live, with how many commits each carries that
are not on `main`. This section records only *intent*, which a command cannot
tell you. Delete an entry once its branch has been fully harvested.

**All of the branches present at the time of writing have been harvested for
whatever was worth taking, and none should be merged wholesale.** They were each
cut from an older `main`, so a full merge would revert large amounts of later
work — one of them would have undone the entire post-processing streak pass and
743 lines of particle work. This is the concrete reason for the rule in §9.

The pattern that works: find the merge base, check whether the file you want has
changed on `main` since, and if it has not, take that single path.

```bash
BASE=$(git merge-base main <branch>)
git diff $BASE..<branch> --stat -- <path>     # what the branch actually did
git log --oneline $BASE..main -- <path>       # empty means it applies cleanly
git checkout <branch> -- <path>
```

Harvested so far: a god-ray diagnosis and two shaft instruments; a scene-collision
finding plus `tools/_collide.mjs`; and a mote-rim and wake-fold fix taken as a
single clean `render.js` path. In every case the commit message carried the
reasoning and was worth reading even where the code was not taken.

## 9. Recovering abandoned work

`node tools/state.mjs` lists every branch and worktree with how many commits are
not on `main`. Autonomous agents create worktrees and then cease to exist; the
worktree still holds real work.

**Never delete, prune, reset or force-remove an unfamiliar worktree just because
nobody owns it.** Inspect first:

```bash
git -C <path> status
git -C <path> log --oneline main..HEAD
git -C <path> diff main...HEAD --stat
git -C <path> stash list
```

If there are unmerged commits worth keeping, cherry-pick or merge them. Only
after confirming there is nothing to salvage:

```bash
git worktree remove <path>      # refuses if dirty; --force only knowingly
git worktree prune              # only clears already-deleted paths
```

Uncommitted changes in the primary tree may belong to an agent that is *still
editing right now*. Check `tools/state.mjs` and `AGENTS.md` file ownership
before touching them. A half-written file blocks everyone's captures, so if you
must write, write the whole file in one operation.

## 10. Making a correct next commit

1. `node tools/state.mjs` — confirm no merge/rebase/cherry-pick is in progress
   and see which files others may be holding.
2. Pick **one** file or one tightly-scoped concern. The file-ownership model in
   `AGENTS.md` exists because concurrent edits to one file lose work.
3. Change it. Then **capture and look at pixels** — including a 1:1 crop. Do not
   report success because the code compiles.
4. `node tools/check.mjs --seeds 7,3` must pass.
5. Commit with a message that explains *why*, and states what was measured. The
   history here is deliberately a record of diagnoses, not of edits.

Good next steps, roughly in order of value: finish the UI axis; verify audio;
re-tune difficulty against current movement; run a blind critic pass per
`tools/CRITIC.md` and act on the top-ranked finding.

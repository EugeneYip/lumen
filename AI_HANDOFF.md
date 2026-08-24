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
node tools/serve.js                     # play it at http://localhost:5173/
```

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
   `src/engine/rng.js` or the clock passed in. A given seed must replay
   bit-identically, because that is the only reason screenshots from two
   different builds can be compared at all. `check.mjs` asserts this.
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
   `break` on `x` and will silently miss objects otherwise.
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

Final tonemapped frames should land at mean sRGB luminance **0.08-0.20**.
Measure, do not guess:

```js
await page.evaluate(() => window.LUMEN.hdrStats())   // { mean, p10, p50, p90, p99, max }
```

Division of responsibility: the **environment** authors the dark bulk, the
**scene renderer** supplies hot emitter cores, **postfx** owns the response
curve. That split was established after all three drifted at once.

### Other contracts checked

Boot time, zero console errors, per-scene mean luminance and contrast spread (a
flat image fails), clipping fraction, render and step budgets, and that the
deterministic autopilot can still play (a level it cannot traverse is broken).

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

## 8. Known weaknesses and active investigation

Verify each against the current code before acting; some may be fixed.

- **UI is the least developed axis.** `src/game/hud.js` may still be close to
  the original placeholder: thin type that disappears over a bright scene, an
  invisible speed bar, a forgettable death card, and a title wordmark with no
  identity. The wordmark should be drawn as vector paths, not set in a system
  font, so it is identical everywhere.
- **The mote can read as a featureless white disc** if the tonemap shoulder
  flattens everything above the knee. Measured symptom: linear 11x and 18x
  mapping to the same output level. Both halves matter — the grade must not
  flatten, and the scene must not hand it a broad uniform plateau.
- **Small highlights can turn into rainbow dashes.** Root cause found: the
  spectral weighting shared a loop index with the speed-smear displacement, so a
  ~20px motion blur was painting the dispersion instead of the ~1px aberration.
  Keep spectral offsets at CA scale regardless of speed.
- **Difficulty tuning drifts as movement improves.** Every time the swing gets
  better the curve gets easier. Re-run `tools/_probe.mjs` and `tools/_reach.mjs`
  after any physics change.
- **`tools/_*.mjs` are scratch instruments** left deliberately: `_probe.mjs`
  (level coverage and phrase mix), `_reach.mjs` (real-physics fairness),
  `_feel.mjs` (movement measurement), `_grade.html`/`_grade.mjs` (synthetic HDR
  bench), `_atlas.*` (sprite atlas viewer), `_audio.mjs` (offline audio
  analysis). They are not tests and may rot; they are also how most real bugs
  here were found. Re-run them rather than trusting prose.
- **Audio has never been verified by ear** — only structurally, via offline
  render and spectrogram inspection.

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

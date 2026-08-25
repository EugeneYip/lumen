# LUMEN — agent brief

You are one of several specialists polishing a browser game to a genuinely
AAA visual and tactile standard. Read this whole file before touching anything.

> **Arriving with no context?** Read `README.md` first (what the game is, how to
> run and verify it), then `AI_HANDOFF.md` (invariants, quality contracts,
> decisions and their rationale, open problems, how to recover abandoned work).
> Run `node tools/state.mjs` to see current repository state — never trust
> documentation for that. This file is the *working contract* for delegated
> parallel work; it assumes you already know what the project is.

## The game
`LUMEN — Deep Drift`. A one-button momentum game. You are a bioluminescent mote
in an abyssal trench. **Hold** to cast a light-tether at the nearest good anchor
and swing; **release** to launch. "The Hush" — an advancing wall of dark — erases
the world from the left, so stopping is death. Score is metres of NEW ground,
banked at the chain multiplier live when you claim them — not total distance
times a final multiplier, which would let a player farm plankton at the end and
inflate everything behind them.

Pillars, in priority order:
1. **FEEL** — the swing must read in your wrists. Hitstop, screenshake, dilation.
2. **LIGHT** — everything visible either emits light or occludes it. Bloom is the
   art direction, not a filter bolted on top.
3. **ONE BUTTON** — no tutorial, no menus. Depth comes from *when* you release.

## Absolute rules
1. **Only edit the files you are assigned.** Others are being rewritten in
   parallel right now. Editing a file you do not own will lose someone's work.
   You may *read* anything.
2. **Never break the harness.** After every meaningful change run your capture
   command. Zero console errors. `window.LUMEN.ready` must become `true`.
3. **No new runtime dependencies. No asset files.** Everything is procedural:
   textures are synthesised at boot, audio is synthesised, geometry is generated.
   That is a hard design constraint, not a preference — it is why the whole game
   has no assets and loads instantly. Do NOT write its size here: this line
   used to, it went stale by 76%, and `tools/state.mjs` names that exact number
   as its cautionary tale. Run `node tools/state.mjs` for the measured payload.
4. **Keep your module's exports backward compatible.** Add, don't remove or
   rename. Other files call into yours and you cannot edit them.
5. **Determinism.** Never call `Math.random()` or `Date.now()`/`performance.now()`
   in anything that affects simulation or rendering. Use the seeded RNG
   (`src/engine/rng.js`) or the sim clock passed in. Captures must be
   reproducible frame-for-frame, or nobody can compare your work.
6. **Performance budget.** 60fps at 1600x900 on integrated graphics. No
   per-frame allocation in hot loops. Cull anything off-screen.
7. Match the existing code's voice: terse comments that explain *why*, not what.
   No comment narrating an obvious line. No emoji anywhere in code or UI.

## Bootstrap (isolated worktrees)
If you are working in an isolated git worktree, `node_modules/` is not there
(it is gitignored). Link it from the main checkout before running any tool:
```bash
ln -sfn /Users/eugene/Desktop/light/node_modules node_modules
```
Then commit your work in the worktree when you are done, and report the branch
name so the lead can merge it.

## Running it
```bash
node tools/state.mjs           # repository state: HEAD, dirty files, worktrees
node tools/serve.js            # http://localhost:5173  (for a human to play)
node tools/check.mjs --seeds 7,3   # AUTHORITATIVE quality gate; must pass
```

### Capture (this is how you check your own work)
Also available: `node tools/crop.mjs <src> x,y,w,h <out> <zoom>` for 1:1 or
zoomed inspection. Use it. Downscaled contact sheets have hidden every
hard-edge artefact this project has had, sometimes for several review passes.

```bash
node tools/shoot.mjs --out shots/mine --scenes title,tethered,launch,fast,hushNear --w 1600 --h 900 --seed 7
node tools/montage.mjs sheet --dir shots/mine        # contact sheet of the above
```
Then **actually look at the PNGs** with the Read tool. Non-negotiable: you are
being judged on pixels, so you must look at pixels. Do not report success on the
basis that the code compiles.

Named scenes (`--scenes`): `title, tethered, launch, fast, hazardNear, hushNear,
deep, dead`. Or use `--at 0,3,9,20` for raw simulated seconds. `--seed N` picks a
different world. Use several seeds — art that only works on seed 7 is not done.

`shoot.mjs` boots its own server on a random port, so it is safe to run
concurrently with other agents.

## Architecture and file ownership

This table IS the ownership table. `tools/state.mjs` and `DESIGN.md` both point
here; the `[OWNER: ...]` tag on each line is the whole of it.

```
index.html                 shell + boot error trap
src/main.js                loop, state machine, frameCtx, capture API   [OWNER: lead]
src/engine/gl.js           WebGL2 helpers, RenderTarget, shared GLSL     [OWNER: lead]
src/engine/math.js         math + easing + colour helpers                [OWNER: lead]
src/engine/rng.js          seeded RNG + value noise / fbm                [OWNER: lead]
src/engine/sprites.js      instanced quad batch (one draw call)          [OWNER: lead]
src/engine/ribbons.js      glowing polyline/ribbon renderer              [OWNER: lead]
src/engine/textures.js     procedural texture kit                        [OWNER: textures]
src/engine/postfx.js       HDR chain + the grade                         [OWNER: postfx]
src/engine/audio.js        procedural synthesis                          [OWNER: audio]
src/engine/input.js        one-button input                              [OWNER: lead]
src/art/palette.js         colour system                                 [OWNER: lead]
src/game/background.js     the abyss (fullscreen shader)                 [OWNER: environment]
src/game/render.js         scene assembly + creature art                 [OWNER: scene]
src/game/world.js          procedural generation + layout                [OWNER: world]
src/game/player.js         physics + tether                              [OWNER: physics]
src/game/camera.js         camera feel                                   [OWNER: physics]
src/game/particles.js      particle + ambient VFX                        [OWNER: vfx]
src/game/hud.js            UI + typography (2D overlay canvas)           [OWNER: ui]
```

### `frameCtx` — your input
`main.js` builds one object per frame and hands it to `background.draw`,
`scene.draw`, `post.render` and `hud.draw`. It carries everything: `cam, world,
player, particles, ambient, tex, t, dt, mode, depth, best, mult, chain, speed,
speedK, hushProx, launchGlow, brushGlow, tetherGlow, attached, inDraft,
difficulty, slow, flash, flashCol, fade, envDim, waves, pixelW/H, cssW/H`.
If you need a signal that is not there, derive it from `player`/`world`/`cam`,
which are all present. Do not edit `main.js`.

### Coordinates
World units, Y **down**. The camera shows 1080 world units vertically at zoom 1.
`10 world units = 1 metre` of score. The swimmable band is
`world.bandTop(x) .. world.bandBot(x)`; outside it is rock.

### Rendering model
The scene renders into an **RGBA16F HDR target**. Colour values above 1.0 are
correct and expected — that is what drives bloom. Draw dark occluders with
premultiplied blending and light with additive blending; `render.js` shows the
pass order. Sprite masks are stored gamma-encoded (`SPRITE_GAMMA`) so faint glow
tails survive 8-bit quantisation.

## The exposure contract (read this if you touch the image)

The scene renders into an RGBA16F HDR target and `postfx.js` tonemaps it. Two
different people author those halves, so without a shared reference they run
away from each other. That already happened once: the water bulk sat at linear
0.13, nothing in the frame exceeded 1.0, and the result was a milky mid-grey
wall with no shadows, no highlights, and no shoulder for the tonemap to work on.

**This is an abyss.** Targets, measured on the linear HDR scene *before*
tonemapping, during gameplay:

| statistic | target | why |
|---|---|---|
| `p50` (the bulk: water and rock) | **< 0.03** | most of the frame is deep shadow |
| `p90` | < 0.15 | only a small part of the frame is lit |
| `p99` | **> 0.25** | there must be real highlights |
| `max` (emitter cores) | **> 6** | bloom and the tonemap shoulder need something genuinely hot |

So: the environment authors a very dark, low bulk. Emitters — the mote core,
anchor cores, plankton — are *bright*, well above 1.0. That contrast is what
makes light look like light instead of like a blur filter.

Measure it, do not guess:
```js
await page.evaluate(() => window.LUMEN.hdrStats())
// -> { mean, p10, p50, p90, p99, max }  linear, pre-tonemap
```
And the final tonemapped frame should land at a mean sRGB luminance of roughly
**0.08-0.20**. `node tools/check.mjs` asserts all of the above per scene, plus
boot time, console errors, clipping, flatness, perf and determinism. **Run it
before you declare done.**

## Pitfalls that have already bitten someone here
- **Never put a backtick inside a GLSL template literal**, including in comments.
  It closes the string and breaks the whole file. Use single quotes in shader
  comments. This cost an agent its entire session's work.
- **Never do per-step multiplies for damping/friction.** At 120Hz `v *= 0.86`
  annihilates all velocity in under a second. Use `damp()` from `math.js`.
- **Never schedule WebAudio automation per sim step.** Thousands of events on one
  param at the same timestamp is quadratic in Chrome and made the capture
  harness unusable.
- In headless capture `render()` runs **once** at the end of thousands of
  `step()` calls. Anything that depends on per-frame render state will not exist
  during the simulated run. Drive simulation from `step`-reachable state only.
- Write your file in **one atomic write**. A half-written file blocks every
  other agent's captures.
- **Never sample a mipmapped texture with plain `texture()` from inside a
  branch, a loop with a conditional, or after an early return.** GLSL implicit
  derivatives are undefined in non-uniform control flow, so the mip level comes
  from a neighbouring lane's registers rather than from any shader input, and
  the render stops being deterministic. Use `textureLod` with an analytic level
  (`log2(scale * worldUnitsPerPixel * textureSize)`). This is also the *correct*
  filter width; the implicit path is only correct by accident. It cost a day
  here, and it hid for weeks because the LOD clamps at 0 and no fetch in that
  shader was minified until one was.
- `-x ** 2` is a JavaScript **SyntaxError**. Write `-(x ** 2)`. This broke the
  whole build once and blocked every other agent from capturing.
- State that `newRun()` does not reset leaks between runs. Input is one such
  thing: a probe that leaves the synthetic button held desyncs the next run.

### Three shapes that cannot be tuned into behaving

Full derivations are in AI_HANDOFF §6. These are properties of the primitives,
not tuning mistakes, and each has bitten more than once.

- **A ribbon cannot draw a soft edge at any falloff.** Its cross-section is
  `exp(-x^2 * falloff)`, so even at falloff 1.0 the value at the ribbon's own
  edge is 0.37 of peak, and its ends are butt caps. A short low-falloff stroke is
  a filled quadrilateral with hard steps, not a body. Use a sprite for anything
  that must fade to nothing. This produced the mote's rim reading as a selection
  bracket, a spire's "machined rectangle", and the trapezoids under every anemone.
- **A stretched quad is a straight line**, because its medial axis *is* a segment
  and the profile across the width is compressed by the aspect. No sprite choice
  saves a high-aspect quad. If a thing must not read as ruled, build it from
  several offset pieces so no straight line passes through more than one.
- **A branch on a world coordinate has a locus, and that locus is a line.** Any
  `if` testing a world position, and any level set of a world-space field, draws
  its own boundary wherever the value it separates is discontinuous across it —
  and a straight boundary reads as a ruled seam. **Gate on the field, not on a
  coordinate**: put the bound where everything inside is already zero, or window
  the longest-tailed term to zero at it. If you own a level set, check what its
  slope does across the whole range of its parameters, not at the value you
  happened to test. Found four separate times here, each first blamed on
  something else. It is the first thing to check when a reviewer reports a
  straight line nobody drew.

### There is no depth buffer

The scene paints over whatever the background shader already drew. Burying
geometry below `world.bandBot` conceals **nothing** — several call sites relied on
that false premise, and a buried butt cap was exactly as visible as an exposed
one. Fade across the band instead.

### Distrust the measurement before the art

The single most expensive habit here is believing a number. Defects blamed on the
art have turned out to be defects in the instrument **six times**, and each cost
at least one round: a focal metric sampling the mote's vertical mirror; percentile
stats that grid-sampled and under-reported peaks 5x; an ablation statistic
reporting grain rather than the ablated term; a filename regex collapsing five
frames to one; a salience gate measuring lattice phase and area rather than
highlights; and an audio rig rendering digital silence for 44 seconds while
counting 273 sound events.

So: before you change the art to satisfy a number, establish that the number
measures what its name says. If a measurement contradicts your brief, **believe
the measurement and say so** — that has been the right call every time it has
happened here.

## The quality bar
A harsh critic will compare your output **blind, side by side** against the
previous build and say which is better. It does not know or care which is yours.
It is instructed to be brutal. "Slightly cleaner" loses. Aim for the frame a
studio would put on a store page.

Things that read as amateur, and will be called out:
- Flat, evenly-lit space with no depth cues or value hierarchy.
- Objects that float in a void instead of sitting in a world.
- Perfectly regular spacing/rotation. Nature has variance; procgen must too.
- Uniform-width glows: one blur radius for everything reads as a filter.
- Blown-out white cores with no shape or structure inside them.
- Rings and circles that read as debug primitives.
- Colour with no hierarchy — everything competing for attention at once.
- Bands in gradients, aliased edges, shimmering pixels under motion.
- Text that is thin, small and lost, with no clear reading order.

Things that read as AAA:
- A clear focal point, and a value structure that leads the eye to it.
- Layered parallax where the far layers are *desaturated and low contrast*.
- Light that behaves optically: falls off, gets absorbed by water, scatters,
  spills onto nearby surfaces, and gets caught by lens imperfections.
- Silhouettes you could recognise as a black shape.
- Restraint. Three accent colours with clear jobs beats ten.
- Motion that has weight: anticipation, follow-through, secondary motion.

## Your task
Given separately. Work in a loop: change → capture → **look** → judge honestly →
change again. Stop when you would be happy to see your frame on a storefront,
and not before. When you finish, report: what you changed, what you verified by
looking, and what you would do next with more time.

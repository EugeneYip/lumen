# LUMEN — Deep Drift

A one-button browser game. You are a bioluminescent mote in an abyssal trench.
**Hold** to cast a light-tether at the nearest good anchor and swing; **release**
to launch. "The Hush" — an advancing wall of dark — erases the world from the
left, so stopping is death. Score is distance in metres; collecting plankton
builds a chain multiplier.

No build step. No runtime dependencies. No asset files: every texture, sound and
piece of geometry is generated procedurally at boot, which is why it loads
instantly. Because there is no build step, the payload is simply the modules
under `src/` plus `index.html` — `node tools/state.mjs` prints its measured size
under **Payload**. It is derived rather than written down here for a reason:
this paragraph once claimed a size that had gone stale by 78%.

## Run it

```bash
node tools/serve.js          # then open http://localhost:5173/
```

Requires Node 18+ (for the dev server and tooling) and a browser with WebGL2.
`npm install` is only needed for the *tooling* (Puppeteer, used for automated
capture and verification) — the game itself has zero dependencies and will run
from any static file server.

### Controls
| | |
|---|---|
| Hold LMB / Space / touch | cast tether, then reel in |
| Release | launch |
| `R` | restart |
| `M` | mute |
| `P` | pause |

The whole game is *when* you let go. Reeling in while attached is the only way to
add energy, and the distance-optimal release is a narrow window 10-25 degrees
ahead of the anchor — so holding longer is not automatically better.

## Verify it

```bash
node tools/check.mjs --seeds 7,3        # AUTHORITATIVE. Must pass before any commit.
node tools/playtest.mjs                 # the real rAF loop, real input, real audio
```

`check.mjs` is the source of truth for quality, not prose. It asserts zero
console errors, per-scene exposure and contrast, HDR scene structure, render and
simulation performance budgets, that the world's object lists are correctly
ordered, that the autopilot can actually play, and that replaying a seed
reproduces both the simulation state and the rendered pixels.

Some checks are warnings rather than failures (boot time, the HDR `p90`
guideline) — the file distinguishes them explicitly. Read `BUDGET`, `HDR` and
`HDR_SCENE` at the top of `tools/check.mjs` for the actual thresholds;
`AI_HANDOFF.md` explains what each one means and why it exists.

## Look at it

Screenshots are deterministic: a given seed always produces the same run, so
frames are comparable between builds. That is what makes automated visual review
possible.

```bash
# capture named moments rather than wall-clock times
node tools/shoot.mjs --out shots/a --scenes title,tethered,launch,fast,hazardNear,hushNear,dead --w 1600 --h 900 --seed 7

# contact sheet
node tools/montage.mjs sheet --dir shots/a

# 1:1 or zoomed crop -- contact sheets hide hard-edge artefacts, repeatedly
node tools/crop.mjs shots/a/frame-03-fast.png 150,330,560,315 shots/a/z.png 2

# blind A/B: randomised LEFT|RIGHT, key written separately
node tools/montage.mjs pair --a shots/a --b shots/b --out shots/cmp
```

Scenes: `title, tethered, launch, fast, hazardNear, hushNear, deep, dead`.
Or `--at 0,6,14,25` for raw simulated seconds. Use several `--seed` values; art
that only works on one seed is not finished.

## Inspect the repository

```bash
node tools/state.mjs        # HEAD, dirty files, branches, worktrees, what to read next
```

Dynamic state is *derived*, never written into documentation. Run this first.

## Layout

```
index.html                shell + boot error trap
src/main.js               loop, state machine, frameCtx, capture API
src/engine/               gl, math, rng, sprites, ribbons, textures, postfx, audio, input
src/game/                 background, render, world, player, camera, particles, hud
src/art/palette.js        colour system
tools/                    serve, check, shoot, montage, crop, state
```

## Documentation

- **`AI_HANDOFF.md`** — orientation for a new contributor or AI agent: invariants,
  quality contracts, decisions and their rationale, open problems, recovery.
- **`AGENTS.md`** — the working contract for autonomous agents: file ownership,
  the exposure contract, pitfalls that have already cost real work.
- **`DESIGN.md`** — the original design intent.
- **`tools/CRITIC.md`** — the blind side-by-side review protocol.

# LUMEN — agent brief

You are one of several specialists polishing a browser game to a genuinely
AAA visual and tactile standard. Read this whole file before touching anything.

## The game
`LUMEN — Deep Drift`. A one-button momentum game. You are a bioluminescent mote
in an abyssal trench. **Hold** to cast a light-tether at the nearest good anchor
and swing; **release** to launch. "The Hush" — an advancing wall of dark — erases
the world from the left, so stopping is death. Score is distance in metres,
multiplied by plankton chains.

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
   That is a hard design constraint, not a preference — it is why this game is
   ~100KB and loads instantly.
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

## Running it
```bash
node tools/serve.js            # http://localhost:5173  (for a human to play)
```

### Capture (this is how you check your own work)
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

## Architecture
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

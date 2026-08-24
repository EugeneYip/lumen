# LUMEN — Deep Drift  (original design intent)

> **Historical document.** This is the design brief the project started from,
> kept because the intent is still accurate and worth reading. It is NOT a
> current map of the code: the authoritative file list is in `README.md`, the
> live ownership table is in `AGENTS.md`, and current architecture and
> invariants are in `AI_HANDOFF.md`.

One-button momentum game. You are a bioluminescent mote in an abyssal trench.
Hold to cast a light-tether to the nearest anchor; swing; release to launch.
Keep moving right — "the Hush" (advancing dark) erases everything behind you.

## Pillars
1. FEEL — rope physics you can read in your wrists. Hitstop, screenshake, time-dilation on release.
2. LIGHT — every visible thing emits or occludes light. Bloom is the art direction, not a filter.
3. ONE BUTTON — zero tutorial. Depth comes from *when* you release.

## Controls
- Hold LMB / Space / Touch : cast + reel tether
- Release                  : launch
- R : restart   M : mute   P : pause

## Scoring
score = depth(m) + planktonChain * multiplier + airtime bonus
Grazing a hazard without touching it = "brush" bonus + slowmo flash.

## Tech
- Pure ES modules, no build step. WebGL2 renderer, procedural textures, WebAudio synthesis.
- Fixed 120Hz physics tick, decoupled render, accumulator with clamping.
- Post chain: brightpass -> dual-Kawase bloom -> ACES -> chromatic aberration -> vignette -> grain -> dither.

## File ownership
Superseded — see the table in `AGENTS.md`. (For the record, what was called
`engine/lines.js` here shipped as `src/engine/ribbons.js`, `src/game/render.js`
was added later as the scene assembler, and `camera.js` is owned by physics
rather than being its own role.)

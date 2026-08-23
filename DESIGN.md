# LUMEN — Deep Drift

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

## File ownership (parallel agents, disjoint files)
- engine/gl.js         core GL helpers          [core]
- engine/postfx.js     post-processing chain    [AGENT: postfx]
- engine/sprites.js    instanced glow quads     [core]
- engine/lines.js      glowing ribbons          [core]
- engine/textures.js   procedural textures      [AGENT: textures]
- engine/audio.js      procedural audio         [AGENT: audio]
- game/background.js   environment shader       [AGENT: environment]
- game/world.js        procgen + hazards        [AGENT: world]
- game/player.js       physics + tether feel    [AGENT: physics]
- game/particles.js    VFX systems              [AGENT: vfx]
- game/camera.js       camera feel              [AGENT: camera]
- game/hud.js          UI + typography          [AGENT: ui]
- art/palette.js       color + lighting system  [AGENT: color]

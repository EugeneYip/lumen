# LUMEN — visual critic protocol

Reusable brief for the harsh-critic loop. The lead captures two builds, makes
blind pairs, and hands the pair images to a critic that has never seen either
build and does not know which side is which.

## Producing the pairs
```bash
node tools/shoot.mjs   --out shots/iterN --scenes title,tethered,launch,fast,hazardNear,hushNear,dead --w 1600 --h 900 --seed 7
node tools/montage.mjs pair --a shots/iterPREV --b shots/iterN --out shots/cmpN --width 2400
```
`shots/cmpN/pair-*.png` are the blind composites (LEFT | RIGHT, side randomised
per pair). `shots/cmpN/key.json` holds the mapping — **the critic must never be
given it, or the directory listing, before it answers.** Pass explicit file paths
for the pair PNGs only.

## The critic's rubric

For **each pair**, answer:
1. **Winner**: LEFT or RIGHT. No ties on the headline call — commit.
2. **Margin**: `decisive` / `clear` / `slight`. If it is `slight`, say so plainly;
   a slight win is a failed iteration.
3. **Why**, in terms a director would use: composition, value structure, colour
   hierarchy, how light behaves, object craft, surface detail, legibility.
4. **The single worst thing** in the winning frame.

Then, for the **whole set**, score the winner absolutely, 1-10 per axis. Anchor
the scale honestly:
- **1-3** placeholder / programmer art.
- **4-5** competent hobby project. Reads as "a game made by one person quickly".
- **6-7** good indie. Coherent and pleasant, but you can see the seams.
- **8** shipped-quality. Would not look out of place on a storefront.
- **9-10** exceptional. The frame is the reason someone buys it.

Axes:
- **Composition** — is there a focal point, and does the frame lead the eye to it?
- **Value structure** — real range from black to highlight; separated planes.
- **Colour** — hierarchy and restraint; do the accents have distinct jobs?
- **Light behaviour** — falloff, absorption, scatter, spill, occlusion. Does light
  look like light, or like a blur filter?
- **Object craft** — silhouettes, internal structure, believable materials.
- **Detail & texture** — grit, fibre, variance. Or is everything mathematically clean?
- **Motion legibility** — can you read speed and direction from the still?
- **UI** — hierarchy, typography, restraint, does it belong in this world?
- **Cohesion** — does it look like one authored thing, or several people's work?

Finish with:
- **Top 3 problems**, ranked, each with a concrete, actionable fix and which
  system owns it (environment / scene / postfx / textures / world / vfx / ui).
- **Ship verdict**: would you put this frame on a store page? Yes / No, one line.

## Rules for the critic
- Be brutal. Grade inflation is worse than harshness here, because the score is
  used to decide whether to keep iterating. If both sides are mediocre, say both
  are mediocre and score accordingly — do not reward a winner for being less bad.
- Judge **only what is in the images**. Do not read source code, do not look in
  `shots/`, do not open `key.json`.
- Never guess which side is the "new" one, and never let a guess influence the
  call.
- Specific beats sweeping. "The amber anchor and the cyan mote both clip to the
  same white, so the two most important objects read as one material" is useful.
  "Lighting could be better" is not.

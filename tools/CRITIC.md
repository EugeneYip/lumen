# LUMEN — visual critic protocol

Reusable brief for the harsh-critic loop. The lead captures two builds, makes
blind pairs, and hands the pair images to a critic that has never seen either
build and does not know which side is which.

## Producing the pairs

**Capture by DEPTH, not by named scene.** `shoot.mjs`'s own header says why and
AI_HANDOFF §5 repeats it: named scenes are sought by predicate, so as the physics
changes they land at different distances in each build, and the pair then
compares *content* rather than *rendering*. Depths pin both builds to the same
place in the world. Named scenes are still the right tool for `check.mjs`, which
is asking a different question.

```bash
# one capture per seed, same depths and the same --tag in BOTH builds
for s in 7 3; do
  node tools/shoot.mjs --out shots/iterN --depths 20,120,400,900 --seed $s --tag s$s --w 1600 --h 900
done
node tools/montage.mjs pair --a shots/iterPREV --b shots/iterN --out shots/cmpN --width 2400
```

**A change to `world.js` invalidates a depth-matched A/B, and this is not
obvious.** Depths pin both builds to the same *place*, which is why they beat
named scenes — but they cannot pin them to the same *content*. If generation
changes, the same depth shows a different world, and the reviewer will report
content differences ("an entire amber organism goes missing", "10-17% less
detail energy") as though they were rendering regressions. Measured on one such
round: reverting only the `world.js` change accounted for the whole
large-amplitude divergence at every depth (max delta 184 of 184), while every
rendering change in the same round together accounted for max delta 61.

So: **do not fold a generation change into an A/B round if you can avoid it.** If
you cannot, say so in the brief, and treat the reviewer's judgements about *how
things are drawn* (clipping, ruled edges, silhouette quality, wake construction)
as valid while treating judgements about *what is present* as uninformative.
`tools/_dif.mjs` against a build with only the generation change reverted is the
cheap way to separate the two.

Capture the "before" build from a **detached worktree at the baseline commit**
(`git worktree add --detach <tmp> <sha>`, symlink `node_modules`), not from the
working tree. Agents edit the tree while a round is being prepared, and a
baseline captured from under them is not a baseline.

`montage.mjs` pairs by tag and hard-fails on duplicate tags, partial coverage,
and byte-identical frames within one build. Those checks exist because a
filename-tagging regex once collapsed five distinct frames to one key and an
entire review round was spent reviewing the same image four times — see
AI_HANDOFF §7. If it refuses to pair, believe it.

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

## Which instruments a blind reviewer may use

Some of this project's instruments read the game's own source or shader maths.
**Those are off-limits to a blind reviewer** — using one breaks the protocol just
as surely as opening `key.json`. A reviewer working this out for itself is a good
sign, and one did: it declined `_lean.mjs` on exactly these grounds.

- **Allowed** (image-space only, they see nothing but the PNG): `crop.mjs`,
  `_hair.mjs`, `_hairdir.mjs`, `_comb.mjs`, `_dif.mjs`.
- **Not allowed**: `_lean.mjs` (traces level-set maths out of the shader),
  `_iso.mjs` (renders the game), `_ring.mjs` (needs an isolated render), anything
  that boots the game or reads `src/`.

And a caution learned twice: **a global ruled-line count is swamped by the
legitimate verticals and horizontals** — kelp stems, strata, HUD rules. It is the
*diagonal* bands that carry the defect. `_hairdir.mjs` sweeps orientation so those
can be read off directly; do not spend the review's budget rebuilding it.

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

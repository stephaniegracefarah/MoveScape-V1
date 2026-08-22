# MoveScape — Botanical Visual Target Spec

*Draft 1 — the "anatomy of the look," derived from the Holger Lippmann / Recursive Tree X reference image. This is the concrete rendering spec builders implement against. It replaces vibes with measurable properties. Companion to the main doc; supersedes the current Botanical rendering approach where they conflict.*

## Why this document exists

The current implementation renders the wrong *kind* of marks, so no tuning-panel values can reach the reference. This spec defines the mark vocabulary the reference is actually made of. Every section states the target property, the current gap, and the required primitive.

## 1. Branches: tapered strokes, never dot-trails

**Target.** A branch is one continuous, smooth, tapered stroke: widest at its origin (roughly 8–14 px at final display scale for a dominant branch), narrowing continuously to a hairline (≤1 px) at the tip. Taper is non-linear — width falls off slowly near the base and quickly near the tip (roughly `width = base × (1 − t)^1.4` along the normalized length `t`). Curvature is graceful and low-frequency: long swooping arcs with gentle S-curves, never jittery wander. Color is near-black with warmth — very dark maroon/brown (#2e1518 territory), not pure black, fully opaque.

**Gap.** Branches render as chains of fixed-radius circles (r = 0.003, one per tick) — dot-trails with visible beading, uniform thickness, high-frequency wander.

**Primitive required.** A `taperedStroke` scene element: an ordered polyline of points plus a width profile, rendered as a filled polygon strip (or `ctx` path with per-segment lineWidth). The SceneElement vocabulary must grow beyond circles — this is the single highest-impact change.

**Curvature character.** Replace per-tick noise wander with low-frequency curvature: each branch carries a slowly-varying curvature value (noise sampled at ~10× lower frequency than now, amplitude small), plus a per-branch constant sweep bias so a branch commits to an overall arc direction rather than meandering.

## 2. Ramification: repeated forking into fine twigs

**Target.** A dominant branch forks repeatedly along its length — a child every ~15–30% of parent length, 2–5 children total per major branch, recursively to generation 4–5. Each generation: length ~0.35–0.55× parent, base width ~0.5–0.65× parent's width *at the attachment point*, and inherits a coherent direction (parent direction ± 0.3–0.8 rad, biased to the composition's sweep). The finest generations are hairline twigs, often carrying the blossom clusters.

**Gap.** One child maximum per branch, rolled once at maturity. Structures are unbranched wandering lines.

**Primitive required.** Spawn logic change only (no new renderer support): fork points scheduled along the growth path, children spawning while the parent still grows.

## 3. Blossoms: dense masses with internal color mixing

**Target.** A cluster is 25–80 overlapping translucent circles packed around an anchor (2D gaussian, σ ≈ 2–4% of canvas), with a size mixture: mostly small (r ≈ 3–10 px), a few large (r ≈ 12–22 px). Alpha per circle 25–60%. The mass reads as one blossom clump with visible color *mixing inside it* — cream against crimson against near-black maroon in the same cluster. Some circles carry a faint 1 px ring outline slightly lighter than their fill (a signature Lippmann detail). Clusters sit at branch tips and along fine twigs, and several clusters merge into larger masses where twigs are close.

**Gap.** 6–18 small circles, uniform size range, thin jitter, single-hue-±-spread coloring — confetti.

**Primitive required.** Circles suffice, but the cluster generator needs the count/size-mixture/packing above, and the palette model below.

## 4. Palette: curated multi-tone families, not hue-spread

**Target.** A palette is a small curated list of specific colors spanning value extremes within a family — for the reference: deep crimson `#a31621`, dark red `#7c0f1c`, maroon `#4a1218`, near-black `#2a0d10`, dusty rose `#c4707d`, blush `#e8b4b8`, cream `#f2e3d5`, pale pink `#f0d7d7`. Each cluster picks a base tone, then draws individual circles ~60% from near its base and ~40% from anywhere in the list — that cross-draw is what creates the cream-next-to-crimson richness.

**Background (decided): warm cream watercolor paper.** The canvas ground is warm cream (≈ `#f7f0e3`), never white, with a *subtle* paper texture: low-frequency mottling (soft blurred noise, amplitude a few RGB points) plus a barely-there fine grain — visible as material at full size, invisible as noise at thumbnail size. The texture is part of the deterministic render (seeded), so exports reproduce it exactly.

**Gap.** `hueBase ± hueSpread` with saturation/lightness driven only by depth — mathematically tidy, visually monotone. It cannot produce near-blacks and creams in one cluster.

**Primitive required.** World palettes become curated color lists (seed picks the list and per-cluster biases); the hue-spread knobs retire. Seeded selection from a list is just as deterministic as hue math.

## 5. Depth: pale echo layers

**Target.** Behind the foreground system, 1–3 complete echo systems render pale (opacity 10–20%), slightly desaturated and lightened, and marginally thinner — reading as the same species of growth further away in atmosphere. They are their own seeded structures, not copies.

**Gap.** The linear z-fade exists and is the right idea; but with dot-trail branches it fades dots, not structure. Once strokes exist, the current compositor depth model (sort by z, fade and thin by distance) carries over nearly unchanged.

## 6. Composition: dominance, sweep, and negative space

**Target.** One or two *dominant* structures organize the frame; everything else is subordinate. The frame keeps 40–60% negative space (paper). Growth has a coherent overall direction (the reference sweeps horizontally). Roots/origins are few and intentional — not a row of starts along the bottom edge.

**Gap.** 3–6 equal-weight roots in the bottom band all growing upward: a lawn, not a composition.

**Decided (2026-08-22, from the metaphor sketches): the Scroll.** The canvas is a fixed-height, rightward-expanding scroll. One or two dominant branches sweep left to right across it, forking into subordinate structure and fine twigs; the Grove's rising-stem vocabulary (the founder's second favorite) may appear as secondary elements anchored along the way. Radial/burst compositions (the Bloom sketch) are rejected — growth never fans symmetrically from a single point. The growth front lives at the right edge, where current movement acts; the engine continuously composes a fixed-aspect **portrait crop** that must look complete at every moment (this is the default save/share), while the whole scroll is exportable as **the journey**.

## 7. Movement mapping (unchanged in role, remapped in effect)

The parameter contract is untouched. What changes is what the parameters *do*: speed still drives growth rate (immediacy budget intact); expansion maps to spread/reach of new growth and cluster size; symmetry maps to curvature calm vs. wildness. The lifecycle question (churn vs. accumulation vs. expanding canvas) is a live product decision being resolved with the founder — this spec is compatible with any outcome, because it defines marks, not persistence policy.

## Acceptance test for this spec

A static, seeded, movement-free render using these primitives should be mistakable at arm's length for a piece in the reference's family: tapered near-black branches, dense mixed-tone blossom masses, pale depth echoes, warm paper, real negative space. Until that still image passes the founder's eye, no motion work proceeds (the "static before motion" gate).

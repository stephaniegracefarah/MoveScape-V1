# MoveScape

**Concept · v1 Product Definition · Technical Architecture**

*Stephanie Farah — August 2026 — Draft 6*

This document has four parts with different lifespans. Part 1 (the concept) is permanent — it states the purpose of the project and keeps future decisions aligned with it. Part 2 (the v1 PRD) covers only the first shippable version and will be rewritten for each version after. Part 3 (the architecture) evolves slowly; its core decision — the parameter vector as a stable contract — is the foundation everything else builds on. Part 4 (the build guide) turns the plan into invariants and milestones an AI coding agent can execute one at a time, and is updated in the same commit as any spec change it forces.

---

## Part 1 — Concept

### The thesis

**MoveScape lets you make art with your body.**

MoveScape watches how you move (starting with a webcam, eventually any sensor) and translates the *qualities* of your movement — openness, speed, symmetry — into a living generative artwork that grows on screen while you move. The live canvas is the experience: watching your body draw. When you finish, the piece is yours: something unique to you, made from a performance only you could give.

Over time, those pieces accumulate into a personal universe of art you created with your body. In its fullest form — the best-case dream — that universe becomes an explorable space, where each new workout fills in a new region, and someone could one day wander through months of their own movement in VR.

MoveScape is positioned as an art-making instrument first. Fitness is one use case — the founding one — alongside dance, yoga, somatic practice, flow states, creative play, physical-therapy-style movement, performance, and accessibility. This framing matters: it removes the psychological burden of "I should exercise" from the product's front door, and it opens MoveScape to everyone who is interested in movement or art, whether or not they think of themselves as exercisers.

### The origin: the motivation gap

The idea began as a fitness-motivation problem, and that origin remains the product's first honest test. For people who lack a natural affinity for fitness, the hardest part of working out is the reason to do it. Exercise is hard, it feels unpleasant at first, and the payoff (health, strength, appearance) arrives on a timescale of months. Every mainstream answer to this gap uses extrinsic rewards: points, streaks, badges, leaderboards. These rewards share three weaknesses. They are generic — your badge is identical to everyone else's. They are judgmental — streaks penalize you for missing a day, and leaderboards rank you against people who already love fitness. And they are disposable — old points and badges lose all meaning once earned.

MoveScape answers the gap differently. Gamification says "exercise so you can earn this." MoveScape says "move, and something beautiful happens because you moved." The art is made of the movement itself, the way a shadow is made of a shape — which places it close to intrinsic motivation (expression, curiosity, creation) rather than bribery. And because the art has personal value rather than exchange value, it keeps its worth over time — a durability that token-based move-to-earn schemes lacked. In the art-first framing, the relationship completes its inversion: you are moving *because you are making art*, and the exercise happens along the way.

### Why this is different from what exists

The individual ingredients all exist; the synthesis is new. Gallery installation art (Chris Milk's *The Treachery of Sanctuary*, Camille Utterback's painterly interactives, teamLab's rooms) proved that body-driven generative visuals are magical — but installations are site-specific, expensive, and typically mirror-like, echoing your silhouette's *position* rather than interpreting your movement's *qualities*. Browser pose experiments (Google's Move Mirror, Pose Animator) proved webcam pose tracking works for everyone — but they map poses to images or puppets rather than generating art. Long-form generative art platforms (Art Blocks, fxhash) proved that one algorithm plus a seed can produce endless, collectible, deterministic variety — but their only input is the seed; the body, the performance, and time are absent. Strava's GPS-art ecosystem proved people want their exercise to make pictures — but GPS art reverses the idea (you plan the picture first, then run it as an assignment) and works only for outdoor route sports. And fitness gamification proved rewards drive movement — using generic, judgmental, disposable rewards.

MoveScape sits at the unclaimed intersection: **seeded, explorable generative worlds × live embodied input interpreted as movement qualities × accessible anywhere with a webcam.**

### Product principles

**Any movement counts, and effort shapes character, never quality.** Every kind and amount of movement produces real art. A hard workout creates frantic, dense, explosive work; a gentle session creates spacious, delicate, slow work — different, with equal worth, and the system encodes zero judgment between them. Duration naturally yields more canvas, simply because the person generated movement for longer; but there is no equation anywhere in which greater exertion earns prettier, rarer, or higher-value art. Such an equation would rebuild exactly the fitness reward system MoveScape exists to escape. This is a decided, permanent principle.

**The camera stays in the room.** All video processing happens on-device. Video stays entirely on the user's machine — only abstract movement numbers (a handful of values per frame) are computed from it, and even those stay local unless the user chooses to save a piece. For an app that asks people to move freely in their own homes, this is a core product principle stated prominently in the product itself.

**Worlds are math.** Everything generative is deterministic from a seed. A finished piece is fully described by a tiny recipe — (style + user choices + seed + movement recording) — and can be perfectly reconstructed from it forever. Permanence comes from recomputability.

**The body is one input among many.** The architecture treats "movement" as an abstract parameter vector. The webcam is the first adapter; an Apple Watch workout (heart rate curve, cadence, duration), an Oura ring (readiness, activity), or any future sensor can drive the same art engine through a new adapter, leaving the engine itself unchanged.

**Serendipity by default, control by choice.** The day's world asserts its own personality — palette, growth character, mood — and the user can override any part of it (choosing a style now, choosing colors later). The more the user overrides, the more predictable the world becomes and the more it reflects their taste. Beginners get full serendipity; people who develop taste get control. Both experiences are intended.

**Movement has immediate, legible effect.** The POC's single most important validated finding: the experience clicks the moment your movement visibly changes the art. Throwing your arms wide opens the forms *now*; a burst of speed produces a burst of growth *now*; the connection between what you did and what happened is always intuitive. Every style must honor this as a responsiveness budget — movement effects visible within a frame or two — and speed in particular stays a direct, honest readout of real movement (smoothed only for sensor stability, never blended with noise).

**Sharing art protects privacy.** Sharing fitness data exposes pace, weight, and ability level. A MoveScape piece reveals only that you moved. Someone who feels shy about posting a workout can proudly post a drawing their body made.

### The long vision (beyond v1)

The universe grows in stages. First a growing gallery — every session's piece saved, browsable, dated, structured by the calendar the seeds create ("Wednesday was the indigo one"). Then richer accumulation models — possibly an expanding canvas, where sessions fill in regions of one ever-growing composition. Then wearable inputs, so a run or a swim (where a camera is impractical) still makes art from its heart-rate curve and rhythm. Then sharing and coordinates — worlds as visitable addresses, where a friend can move in *your* Tuesday world and leave different art in the same terrain. And at the horizon, the dream: the universe as an explorable 3D/VR space, each workout having filled in a new part of it, months of movement walkable as a place.

All of this comes after v1. It is listed here so that v1's architecture keeps every stage possible.

---

## Part 2 — v1 Product Definition (PRD)

### Who v1 is for

Stephanie. This is stated plainly and on purpose: v1 exists to prove the experience is real for one honest user who matches the target psychology exactly — someone who wants to move more and finds fitness culture unmotivating. The long-term ambition is an indie product, and this document and the architecture are written to keep that path open and cheap; v1's success, however, is measured on one person.

### The v1 experience

You open MoveScape in a browser. The camera starts (with a clear on-device privacy note), pose tracking locks on, and today's world greets you: today's palette, today's growth personality, derived from *you + today's date*. You pick an art style — or keep the default — and you move. However you want: stretch, dance, follow a workout video, improvise. The canvas grows in real time as a direct, legible response to how you're moving — expansive movement opens the forms, bursts of speed produce bursts of growth, symmetric movement calms the composition, stillness lets it rest. The live canvas is the experience: watching your body draw.

When you're done, you end the session and the piece is finished. You save it — an image at minimum, plus its tiny recipe (style, choices, seed, movement recording) so it can be reconstructed at full fidelity later. Come back this evening and you're in the same world — same terrain, different performance, a sibling piece. Come back tomorrow and a new world is waiting, which is itself a reason to come back tomorrow.

### v1 scope

In scope, and each of these is load-bearing:

1. **Live canvas driven by webcam pose tracking** — the expansion/speed/symmetry parameter mapping, proven by the POC, rebuilt on the current MediaPipe stack, plus a first set of session-level parameters derived from the recording (duration, stillnessRatio, averageEnergy, movementVariance — see Part 3).
2. **The seed system, working end-to-end** — *you + the moment* seeding, deterministic worlds, even where the user never sees it. This is the No Man's Sky foundation and the single most important thing for v1 to get right, because retrofitting determinism later would require a rewrite.
3. **Two art styles** — Botanical (style #1, inspired by Holger Lippmann's *Recursive Tree X*) plus a second style from a different aesthetic family (for example, cosmic), selectable by the user. Two styles is the minimum that proves the style-plugin architecture works in practice.
4. **Save/export of finished pieces** — a session ends with a keepable artifact: a high-resolution image download plus the reconstruction recipe. The image is for instant viewing and sharing; the recipe is the permanent record. A recipe is 10–100× smaller than a high-resolution image (seed and choices are bytes; the movement recording compresses to tens of kilobytes) and reconstructs the piece at any resolution, at the cost of replay compute when it is opened.
5. **Manual parameter sliders, development builds only** — a slider input adapter for testing and demos. The adapter lives permanently in the codebase (it is simply another input adapter, and the natural seed of a future accessibility input), but its UI is gated behind a build-time development flag, so production builds shipped to strangers contain no slider code at all.

Deferred to later versions, explicitly and deliberately: accounts and cloud storage (pieces live locally), the gallery (folders of saved images suffice until the accumulation model is chosen), sharing features, wearable inputs, mobile apps, sound, multiplayer/coordinates, VR, and monetization. Each of these remains on the roadmap.

### Design decisions made

**Seeding: you + the moment.** The day's world derives from the user's identity plus the date; each session within the day adds a session index that varies its fine stochastic details (see Part 3). Each day has its own world (per style); multiple sessions in a day share its terrain and personality and produce sibling pieces that are each their own performance. This builds ritual — "what does today look like?" — and gives the eventual universe a calendar structure, which fits the fills-in-over-time dream far better than one-off random worlds. A "reroll" affordance can be added later within the same model.

**Style choice stacks with seeding.** The user's explicit choices (style now, palettes later) always win; the seed fills in every knob the user left alone. A piece's identity is (style + user choices + seed + movement), so deterministic reconstruction survives any amount of user control.

**Effort shapes character, never quality.** Decided (see the product principle in Part 1): intensity changes what the art is like — frantic and dense versus spacious and delicate — and duration naturally yields more canvas, but no exertion-based quality, rarity, or value equation exists anywhere in the system. Style renderers implement this as a mapping constraint: movement parameters may drive any visual character, and may never drive worth.

**Privacy as a pillar.** On-device only, stated visibly in the UI itself.

### The v1 research question

v1 is really two MVPs wearing one codebase. The **experience MVP** is the loop: camera → move → beautiful responsive art → finish → save. The **architecture MVP** is the plumbing that keeps the future cheap: seeds, recipes, the plugin interface. The sequencing rule between them is strict: build Botanical until it produces pieces worth saving *before* starting style #2 — the first style proves the product, the second style proves the software.

Within the experience MVP, two things matter above all. **Latency and legibility**: throwing your arms wide should visibly and immediately open the artwork; moving fast should visibly change it; the connection between what you did and what happened must be intuitive. And **expressive range**: the first session will feel magical if the rendering is good — the real test is session 8, and session 25. The product works when users start forming preferences ("I like the pieces I make when I do yoga"; "I love Tuesdays lately"), which requires the art system to have enough range to have opinions about. The central research question of v1 is therefore: **how expressive can Botanical become from only three movement signals?** If the answer is "very," MoveScape stops being a prototype and starts being a product.

### Open questions — decisions deliberately deferred

**Which accumulation model for the universe?** A growing gallery of discrete pieces, an expanding canvas that each session extends, or a model between the two. Deferred past v1; the seed system's calendar structure serves all of them.

**Build-time decisions** (rather than doc decisions): how the movement parameters are named in the UI, whether sessions have explicit start/end or run ambiently, and the identity of the second style.

### What success looks like

For v1 (personal), three bars, all repeatable rather than one-time: **it moved me** — sessions happen that otherwise would have been skipped; **I made something I value** — at least one piece is good enough to print and hang, or show someone unprompted; and **I came back from curiosity** — MoveScape gets opened because she wanted to discover another world, and the pull survives session 8 and session 25, when novelty alone has worn off. Hitting all three repeatedly is the whole test.

For year one (if v1 passes): strangers use it — people she has never met have made their own universes with it. Revenue is deferred as a success criterion for year one; the indie-product path stays open through clean architecture rather than early monetization.

An honest risk to watch: reward novelty decays. The hundredth artwork must still feel worth earning. The mitigations are structural — real generative depth (the seed math), the style library as a retention engine, and an accumulation model that makes the *collection* meaningful in addition to the pieces.

---

## Part 3 — Technical Architecture

### The shape: three layers, one contract

MoveScape is three cleanly separated layers. Everything flows one direction, and the boundary between layers is small and stable.

```
┌─────────────────────────────────────────────────────────┐
│ 1. INPUT ADAPTERS                                        │
│    webcam+pose (v1) · manual sliders (v1) ·              │
│    watch/HealthKit (later) · ring (later)                │
│    → each emits the same MovementParams vector           │
├─────────────────────────────────────────────────────────┤
│ 2. WORLD / SEED LAYER                                    │
│    seed = hash(userId, date)                             │
│    seeded PRNG → World: palette, growth personality,     │
│    density, wind… with user overrides applied on top     │
├─────────────────────────────────────────────────────────┤
│ 3. STYLE RENDERERS (plugins)                             │
│    Botanical · style #2 · …                              │
│    render(params, world, time) → the living canvas       │
└─────────────────────────────────────────────────────────┘
```

### The contract: MovementParams

The single most important interface in the system. Every input adapter — camera, sliders, someday a watch — produces this and only this; every style renderer consumes this and only this. Adding an input leaves the art engine untouched; adding a style leaves the sensors untouched.

The parameters come in two kinds, and the distinction is architectural.

**Instantaneous parameters** describe this moment, are produced per-frame by adapters, and are what gets recorded. v1 ships the three proven ones, normalized 0–1: **expansion** (how far the extremities spread from body center, torso-normalized so camera distance stays irrelevant), **speed** (frame-to-frame movement rate, EMA-smoothed, kept as a raw honest readout so growth is a direct reflection of real movement), and **symmetry** (how closely mirrored limb pairs match across the body's vertical axis). The vector is versioned from day one (`v: 1`) so it can grow — candidates for later versions include verticality, hand height, lean, and jerkiness — while old recordings stay valid.

**Session-level parameters** describe the performance as a whole, and they are *derived from the movement recording* rather than recorded themselves — everything on this list is computable from the instantaneous stream, which keeps recipes minimal and means every already-saved piece gains new session-level features retroactively whenever one is added. They give styles a second layer to work with: instantaneous speed can create sparks in the moment, while a session-level quality gradually shapes the structure of the whole world, giving finished pieces a stronger overall identity. **v1 ships a first set**: **duration** (total session length — this is also the mechanism by which longer sessions naturally yield more canvas), **stillnessRatio** (fraction of the session spent below the speed dead-zone), **averageEnergy** (mean speed across the session), and **movementVariance** (how much the movement's character varied). Richer derived qualities — **rhythmicity** (periodicity in the speed signal) and **rangeUsed** (how much of the expansion range was explored) — are deferred to v1.x, where they arrive retroactively for every existing piece.

Wearable adapters map their own signals into the same instantaneous vector (heart-rate intensity → speed-like energy, effort variability → expansion-like range), which is what makes "any input can make art" an adapter problem rather than a rewrite — and session-level derivation works identically on their recordings.

**The POC's role: knowledge carries forward, code does not.** The POC was built to answer one question — does move-equals-art work? — and it answered yes. v1 is a fresh build, done right, with zero obligation to reuse POC code or mechanics. What the POC contributes is recorded findings, to be treated as starting points and retuned freely: torso-scale normalization makes camera distance irrelevant; a speed dead-zone (~0.05) with a power-curve ramp above it makes stillness restful and bursts dramatic; a practical speed ceiling (~0.85 reads as full burst) beats requiring an unreachable 1.0; and above all, immediacy of response is what makes the experience work (now a Part 1 principle).

### The seed system

Seeding splits into two levels. The **world seed** is `hash(userId, localDate)` and determines the world's identity: palette, environmental personality, terrain, growth rules. The **session seed** is `hash(worldSeed, sessionIndex)` — the first session of the day is index 0, the second index 1 — and determines the small stochastic details of a run: initial spawn placement, blossom micro-variation, particle jitter. This split preserves the model's core promise (Tuesday is Tuesday; two Tuesday sessions share terrain, palette, and personality) while making sibling sessions feel like two performances inside the same universe rather than identical simulations receiving different movement. The piece recipe records the session index alongside the seed, so reconstruction stays exact. Both seeds are stable strings hashed (for example, xxhash or cyrb53) into PRNG seeds. v1 works without accounts, so `userId` is a locally stored random identity created on first run; when accounts arrive, it migrates. The PRNG must be an explicit seeded generator (for example, mulberry32 or sfc32) passed into everything generative — **layers 2 and 3 use the seeded generator exclusively; `Math.random()` is banned there**, enforced by code review habit and ideally a lint rule. Perlin/simplex noise likewise comes from the project's own implementation driven by a labeled stream — p5.js's global `noise()` is a page-wide singleton and cannot provide independent per-style labeled streams, so it is not used.

From the seed, the world layer derives a `World` object: palette, background, branch/growth personality constants, wind direction, density tendencies, per-style knob values. Derivation order matters for stability: each style draws its knob values from an independent, labeled stream (seed + knob name), so adding a new knob later leaves every existing world unchanged.

User overrides sit on top: the `World` is generated in full, then any user-chosen values (style-level choices now, palettes later) replace the seed's values. The seed decides everything the user left alone. Because overrides are recorded in the piece recipe, determinism survives any amount of user control.

**The piece recipe** is the unit of permanence: `{ version, styleId, userChoices, worldSeed, sessionIndex, movementRecording }`, where the movement recording is the timestamped MovementParams stream (three floats at ~15–30 Hz — a 30-minute session is well under a megabyte, and compresses heavily since the values are smooth). Replaying a recipe reproduces the piece exactly, at any resolution — which is also the path to high-res export, poster printing, and the far-future VR re-projection of old pieces.

**Fixed-timestep simulation — a hard requirement for exact replay.** The art simulation advances on a fixed tick (for example, 60 updates per simulated second) driven by the recording's own clock, with the instantaneous parameters sampled from the recording at each tick by **sample-and-hold**: each tick uses the most recent recorded sample at or before its timestamp, with no interpolation. This sampling policy is part of the recipe format and pinned by its version — live sessions and replays must apply the identical policy, or the two diverge. Rendering is decoupled and runs at whatever frame rate the device manages. Wall-clock time and display frame rate must have zero influence on the simulation, because a simulation stepped by real elapsed time produces different art on a fast machine than a slow one — which would break replay, high-res re-export, and cross-device reconstruction all at once. (The POC stepped by wall clock; this is one of the things the fresh build does right from the start.) A useful side effect: replay can run much faster than real time, so opening a saved piece from its recipe is quick.

**Determinism has two tiers, and guarantees are stated at the right one.** The generated *geometry* — the scene a style produces at every tick — is bit-identical everywhere, because JavaScript floating-point math is deterministic across engines. Rasterized *pixels* are identical only within one browser/GPU environment, because Canvas anti-aliasing and curve tessellation vary across platforms. Reconstruction promises ("replaying a recipe reproduces the piece exactly") therefore hold at the geometry level everywhere and at the pixel level within a given environment; automated tests hash geometry for cross-environment identity and hash pixels only within a single environment.

### Style renderers as plugins

A style is a module implementing a small interface:

```
interface StyleRenderer {
  id, name, aestheticFamily
  worldKnobs()                    // declares knobs the seed will fill
  init(world)
  step(params, time, dt)          // advance the living system
  scene() → depth-tagged geometry // branches, blossoms… each with z
  finish() → final scene          // called at session end
}

// A separate Compositor turns the scene into pixels:
// v1 ships a 2D layer compositor; a 3D/VR compositor comes later.
```

Each style declares its own knobs (`worldKnobs()`), which is how the same day's seed renders as *the same underlying world interpreted in different media* — Tuesday as blossoms, Tuesday as stars. The style library's planned aesthetic families are organic/botanical, cosmic/astronomical, and ink/hand-made media as a cross-cutting texture value — with the user always choosing.

**Style #1 is Botanical**, inspired by Holger Lippmann's *Recursive Tree X* (by way of Duane Millar Barlow's tree-study): branching structures carrying clusters of overlapping translucent circles as blossoms, with depth expressed through layering — pale, faded sprays in the background and dark, saturated branches in the foreground. It is built fresh; the POC contributes design findings worth re-implementing on their merits: a branch lifecycle (growing → mature → shrinking → resprout) lets a piece live indefinitely; wander scaled by distance-grown keeps curvature constant regardless of pace; and blending expansion/symmetry with slow-drifting noise adds unpredictability while speed stays direct. One known design tension to resolve deliberately in the build: the blossom texture (layered translucency, accumulated overlapping marks) wants an *accumulating* canvas, while shrinking branches want clear-and-redraw. The depth-layer architecture below resolves this — permanent marks accumulate on their depth layer while live geometry redraws on its own.

### Depth-layered rendering (the bridge to VR)

The tree-study look is built from depth: several planes of the same kind of growth, from faded background sprays to bold foreground branches. MoveScape adopts this as an architectural requirement, in two levels.

First, **styles generate geometry, and rendering is a separate projection step.** A style's living system produces structure — branch paths, blossom positions, sizes, colors — with a **z (depth) coordinate from day one**, and a compositor renders that geometry rather than styles painting pixels directly. In v1, the compositor projects to 2D as an ordered stack of layer canvases: distant layers render paler, softer, and thinner (atmospheric depth, exactly the tree-study effect), near layers render dark and saturated, and each layer independently chooses accumulate or clear-and-redraw.

Second, this is precisely what makes the VR horizon reachable. Because every piece's geometry carries real depth and every piece is reconstructable from its recipe, a future 3D renderer can replay the same recipes and place the same branches and blossoms in explorable space — the flat piece and the walkable world are two projections of one dataset. Flat layers alone would only ever allow parallax tricks; geometry with depth allows true exploration.

The scope cap on this, stated as a rule: **preserve the information, delay the infrastructure.** The z field on generated elements costs almost nothing and is required in v1 anyway, because Botanical's own 2D look (pale distant sprays behind dark foreground branches) is depth layering. The v1 compositor is therefore the simplest thing that draws it: sort by depth, fade and soften by distance, composite in order. A generalized scene graph, a VR-ready geometry framework, or any renderer abstraction built around hypothetical future spatial requirements is explicitly out of scope until the 2D art has proven people love it.

### Technology choices

**Pose tracking:** MediaPipe Tasks `PoseLandmarker`, the maintained successor to the POC's legacy `@mediapipe/pose`. Same 33 landmarks, better performance, GPU delegate where available. Keep the POC's hard-won coordinate lesson: handle mirroring through CSS transform only (a single flip, applied once).

**Capture pipeline (replaces the POC's layout patch):** the POC worked around a real bug — browsers throttle frame delivery for a `<video>` element that scrolls out of view, which starved pose tracking — by pinning the video and canvas side by side in the viewport. That patch constrains layout and rules out mobile, where the art should own the screen. v1 replaces it with a capture pipeline that is independent of DOM visibility: read frames directly from the camera's `MediaStream` via `MediaStreamTrackProcessor` where supported, falling back to `requestVideoFrameCallback` on a detached or hidden video element, and run pose inference in a Web Worker with `OffscreenCanvas` so detection continues at full rate regardless of what is on screen. With capture decoupled from layout, the camera preview becomes a pure design choice — full-size on desktop, a small optional thumbnail on mobile, or hidden entirely — while tracking quality stays constant.

**Rendering:** plain Canvas 2D or p5.js per depth layer, behind the compositor abstraction described above; the plugin interface hides the choice. (If p5 is used, it is a drawing library only — its `random()` and `noise()` are never used; all randomness and noise come from the labeled seeded streams.) Styles needing particle density may adopt WebGL later while other styles stay as they are, and the geometry-plus-compositor split is what lets a future 3D/VR renderer replace the 2D compositor without touching any style.

**Platform:** browser-first. v1 targets desktop (webcam plus room to move fits a laptop), but the phone browser is a firm near-term target — so v1 makes zero desktop-only assumptions: responsive layout, touch-friendly controls, and the visibility-independent capture pipeline above, which is what makes a mobile layout possible at all. v1 should also move from a single HTML file to a small modular project (Vite with vanilla TypeScript or similar), because the plugin architecture needs modules; the tooling choice itself is flexible.

**Storage:** local only for v1 — IndexedDB for piece recipes, direct download for exported images. The movement recording is stored as part of the recipe, so saving a piece saves its session; sessions the user chooses to discard are deleted, with nothing retained. Because IndexedDB lives in one browser profile and is lost if the user clears browser data, recipe export/import is also the backup path: exporting recipes as files is how a user backs up their universe. Cloud sync is a v2 question.

**Privacy enforcement:** the video element and pose model run entirely client-side (MediaPipe Tasks is on-device by design); v1 makes this *architecturally* true by having no backend at all.

**Deployment:** the production build is a static site, deployed on Vercel (the founder's existing deployment platform) from a private repository. Sharing v1 with strangers is sharing a URL; visitors' cameras and saved pieces stay on their own devices, so distribution adds no data custody. Only the minified bundle is public — the source, spec, and handoff history stay private. This is a deliberate tradeoff: on-device privacy means the shipped code is readable by a determined visitor, and the project accepts that, treating the spec, the tuning, and iteration speed as the real IP rather than code secrecy.

### Build roadmap

**v1 (the doc above):** fresh build — PoseLandmarker with the visibility-independent capture pipeline → seed system + world layer → Botanical on the geometry-plus-compositor interface → second style → session start/end + save/export + recipe storage. Sequenced so the seed system lands *before* the second style — the second style is the test that the architecture works. Part 4 breaks this into agent-sized milestones with acceptance criteria.

**v1.x:** the gallery in its first form; richer derived session-level qualities (rhythmicity, rangeUsed) — arriving retroactively for every saved piece; instantaneous parameter vector v2 (verticality, lean, jerkiness).

**v2:** optional accounts, sharing pieces (image + recipe), possibly world coordinates and visiting; more styles.

**v3:** wearable input adapters (Apple Watch / HealthKit first) — art from runs, swims, and gym sessions where a camera is impractical.

**Horizon:** the explorable universe — the accumulation model matured into a navigable space, VR as the far endpoint. v1 keeps this fully possible by design: every piece ever made remains reconstructable from its recipe, and every piece's geometry carries depth, so a 3D compositor can replay old recipes into explorable space.

---

## Part 4 — Build Guide for AI-Assisted Development

This document's intended consumer for the build phase is an AI coding agent (Claude Code), working milestone by milestone in a repo. This part turns the architecture into agent-executable instructions: invariants the agent must never violate, and a milestone sequence where each milestone is one focused session with a testable acceptance criterion.

**The two-document system.** The project runs on exactly two documents. This document is the stable spec — vision, requirements, architecture, milestones — living at `docs/SPEC.md`. The second is the **handoff/changelog doc** (`docs/HANDOFF.md`), updated at the end of every session with what was finished, any implementation choices that deviated from or refined this spec (with reasoning), known issues, and what comes next. Every new session starts by reading both: this doc for what the system should be, the handoff doc for where the build actually stands. When accumulated deviations in the handoff doc amount to a real spec change, they get folded back into this document and the handoff entry notes that the fold happened.

**The orchestration pattern.** Each session is run by a **coordinator agent** whose job is management, verification, and the handoff — it writes little or no feature code itself. The coordinator reads both documents, takes the current milestone, and decomposes it into build tasks; spins up builder agents to implement each part; then **QAs each part against the milestone's acceptance criteria and the invariants below** — the invariants are the QA checklist — and sends work back to builders with specific feedback until it passes. Where a milestone contains independent parts (for example, M1's capture pipeline and slider adapter), builders can run in parallel; where parts share a contract, the coordinator pins the interface first and builders implement against it. The session ends with the coordinator updating the handoff doc.

### Repository layout

The folder structure is the architecture made visible: one directory per layer, the contracts as named files, and the shared seeded-noise/math utilities kept dependency-free. M0 creates this skeleton (folders, configs, contract files); each later milestone fills in only its own modules — no stub files are pre-created for future milestones.

```
movescape/
├── README.md                  # what this is, screenshot, how to run/test
├── docs/
│   ├── SPEC.md                # this document
│   └── HANDOFF.md             # the handoff/changelog doc
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── eslint.config.js           # incl. the Math.random/noise() ban scoped to world/ + styles/
├── .gitignore
├── .gitattributes             # LF line endings everywhere (Windows dev, Linux CI)
├── .vscode/                   # extensions.json, settings.json (shared editor setup)
├── .github/
│   └── workflows/ci.yml       # lint + typecheck + tests on every push
└── src/
    ├── main.ts                # entry point: wires the layers together
    ├── app/                   # UI shell: session start/end, style picker, readout
    ├── adapters/              # LAYER 1 — inputs
    │   ├── movement-params.ts # THE contract (versioned MovementParams)
    │   ├── webcam/            # capture pipeline, pose worker, param computation
    │   └── sliders/           # dev-only manual adapter (UI behind build flag)
    ├── world/                 # LAYER 2 — seeds, labeled PRNG streams, World, overrides
    ├── styles/                # LAYER 3 — plugins
    │   ├── style-renderer.ts  # the plugin interface
    │   └── botanical/         # style #1 (style #2 lands in M6 as a sibling folder)
    ├── engine/                # fixed-timestep loop, recording writer, replay, recipe
    ├── compositor/            # 2D depth compositor
    ├── storage/               # IndexedDB recipes, export/import, image export
    └── shared/                # seeded noise, math utils — imports from no other layer
```

Unit tests are colocated (`foo.test.ts` beside `foo.ts`); the cross-cutting determinism tests live in `src/engine/`. CI is part of the QA story: the same lint + typecheck + test commands the coordinator runs locally run on every push, so an invariant violation cannot land silently.

### Invariants (never violate, regardless of milestone)

1. **The MovementParams contract is the only coupling** between input adapters and everything downstream. No adapter-specific code in the world layer or styles; no style-specific code in adapters.
2. **Seeded randomness only in the world layer and styles.** `Math.random()` is banned in those modules — enforce with an ESLint rule. Noise likewise comes from the project's own labeled-stream implementation; p5's global `noise()` singleton is banned in those modules too. Every random draw comes from a labeled stream (seed + knob name) so adding knobs never shifts existing worlds.
3. **Determinism is tested, not assumed — at two tiers.** Same recipe → identical geometry hash is a permanent automated test and must hold across environments; same recipe → identical pixel hash (render to canvas at fixed size, hash pixels, compare) is also a permanent automated test but is asserted only within a single browser/GPU environment, because rasterization differs across platforms.
4. **Fixed-timestep simulation.** The simulation ticks on the recording clock; wall time and frame rate never influence art. Live sessions and replays run the identical code path — a live session is just a replay of a recording being written in real time.
5. **No backend, no network for video.** All processing on-device; the only network use is fetching static assets and the pose model.
6. **Immediacy budget.** Movement effects visible within a frame or two of detection; speed is never noise-blended. (EMA smoothing for sensor stability is fine and is not noise-blending — but the EMA window must itself stay within the immediacy budget. What is banned is blending decorative noise into the speed signal.)
7. **Effort maps to character, never to worth.** No code path may scale quality, rarity, or value by exertion.
8. **Preserve depth, delay infrastructure.** Every generated element carries z; the compositor stays a depth-sort-fade-composite loop. No scene graphs, no VR abstractions.

### Milestones

**M0 — Scaffold.** The repository layout above: Vite + vanilla TypeScript, ESLint (including the `Math.random`/`noise()` ban scoped to `src/world` and `src/styles`), Vitest, CI workflow, README, docs moved into `docs/`, and empty module boundaries matching the three layers. *Accept: build, lint, and a trivial test pass locally and in CI.*

**M1 — Capture and parameters.** The visibility-independent capture pipeline (MediaStreamTrackProcessor, `requestVideoFrameCallback` fallback), PoseLandmarker in a Web Worker, the webcam adapter computing expansion/speed/symmetry, the manual-slider adapter with its UI gated behind the dev build flag, and an on-screen readout. *Accept: readout responds to real movement with the video element hidden; sliders drive the same readout in a dev build; a production build contains no slider UI.*

**M2 — Seeds and worlds.** worldSeed/sessionSeed derivation, labeled PRNG streams, the `World` object with user-override layering. *Accept: unit tests prove same-seed identity, session-index variation, override precedence, and knob-stream independence (adding a knob leaves other knobs' values unchanged).*

**M3 — Engine and compositor.** Fixed-timestep simulation loop, recording writer, the StyleRenderer interface, the 2D depth compositor, and a placeholder style (e.g., drifting circles) to exercise it. *Accept: the determinism tests pass — same recipe yields an identical geometry hash and an identical pixel hash across two runs at different render frame rates (same environment).*

**M4 — Botanical.** The real style: branching growth with blossom clusters, depth layering (pale far, dark near), lifecycle, movement mapping honoring the immediacy budget. This milestone is where most of the project's total effort belongs, iterated until the art is save-worthy — the experience MVP. *Accept: subjective (the founder wants to save a piece), plus the determinism test still passing.*

**M5 — Sessions and saving.** Session start/end flow, recipe persistence to IndexedDB, image export, recipe export/import, session-level parameter derivation (duration, stillnessRatio, averageEnergy, movementVariance) feeding Botanical. *Accept: a saved recipe re-imported on a fresh profile reproduces the piece exactly.*

**M6 — Second style.** A cosmic-family style implementing the same interface. *Accept: zero changes required in any engine, adapter, world, or compositor module — verified by diff.*

**M7 — Mobile pass.** Responsive layout, camera thumbnail option, touch controls, performance on a mid-range phone browser. *Accept: a full session works on a phone.*

Each milestone lands on a green determinism test before the next begins. When build reality forces a change to this spec, the coordinator records the change and its reasoning in the handoff doc at session end; the founder folds accepted changes back into this document, so the spec and the repo can never drift apart silently.

---

*Document status: Draft 6, written from the founder Q&A of August 2026, with an external product review incorporated the same day (art-first positioning, character-only effort, world/session seed split, derived session-level parameters, experience-vs-architecture MVP sequencing, compositor scope cap), followed by the fresh-build reframing, the immediacy principle, the fixed-timestep requirement, and the AI build guide (Part 4). A pre-build technical review (2026-08-19) added: two-tier determinism (geometry everywhere, pixels per-environment), the sample-and-hold recording policy pinned by recipe version, project-owned labeled-stream noise in place of p5's global `noise()`, and the EMA-vs-noise-blending clarification of the immediacy invariant. Part 2's remaining open question (the accumulation model) is scheduled to be revisited after several weeks of real v1 use.*

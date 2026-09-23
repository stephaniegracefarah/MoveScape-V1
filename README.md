# MoveScape

**Make art with your body.**

MoveScape watches how you move through your webcam and turns three qualities of that movement (openness, speed and symmetry) into a generative artwork that grows on screen while you move. When you finish, you keep the piece.

**Status:** v1 in active development. Milestones M0–M5 are built and merged: capture, the seed system, the engine, the first art style (Botanical), and sessions and saving. It isn't deployed publicly yet.

![MoveScape high-fidelity mockups](docs/UX/deliver-style-guide/movescape%20-%20high%20fidelity%20mockups.png)
*High-fidelity mockups from the UX Deliver phase.*

> TODO (Stephanie): add a screenshot or short GIF of a real session, and a live link once v1 is deployed.

---

## Why it exists

Most fitness motivation relies on extrinsic rewards: points, streaks, badges, leaderboards. Those rewards are generic (your badge looks like everyone else's), judgmental (streaks punish missed days), and disposable (old badges mean nothing).

MoveScape reverses that. The art is made from the movement itself, so the reward is personal and keeps its value. It's positioned as an art-making instrument first. Fitness was the founding use case, but dance, yoga, stretching and play all count.

The ingredients each exist separately. Installation art proved body-driven visuals feel magical, browser pose-tracking experiments proved webcams are good enough, and seeded generative art proved one algorithm can produce endless unique pieces. MoveScape combines them: **seeded generative worlds × live movement interpreted as qualities, not positions × anywhere with a webcam.**

## Product principles

- **Any movement counts.** Effort changes the art's character, never its quality. A hard session makes dense, explosive work; a gentle one makes spacious, delicate work. No code path lets exertion earn prettier or rarer art.
- **The camera stays in the room.** All video processing happens in the browser. There is no backend at all.
- **Worlds are math.** Everything generative is deterministic from a seed, so a finished piece is fully described by a tiny recipe and can be rebuilt exactly.
- **Movement has immediate, legible effect.** Throw your arms wide and the forms open within a frame or two.
- **The body is one input among many.** The webcam is the first input adapter; a watch or ring could drive the same engine later.

---

## How it works

MoveScape is three layers with one contract between them. Data flows in one direction.

```
┌──────────────────────────────────────────────────────────┐
│ 1. INPUT ADAPTERS            src/adapters/               │
│    webcam + pose tracking · dev-only manual sliders      │
│    → every adapter emits the same MovementParams vector  │
├──────────────────────────────────────────────────────────┤
│ 2. WORLD / SEED LAYER        src/world/                  │
│    worldSeed = hash(userId, date)                        │
│    sessionSeed = hash(worldSeed, sessionIndex)           │
│    labeled PRNG streams → World (palette, growth, …)     │
├──────────────────────────────────────────────────────────┤
│ 3. STYLE RENDERERS           src/styles/                 │
│    Botanical (style #1) → depth-tagged geometry          │
└──────────────────────────────────────────────────────────┘
        │
        ▼
  ENGINE (src/engine/)       fixed-timestep simulation, recording, replay
  COMPOSITOR (src/compositor/)  depth sort → fade by distance → 2D canvas layers
  STORAGE (src/storage/)     IndexedDB recipes, recipe export/import, image export
```

**The contract: `MovementParams`.** Every input adapter produces it, and every style consumes it. There are three instantaneous values, each from 0 to 1:

- **expansion:** how far the limbs spread from the body's center, scaled to torso size so distance from the camera doesn't matter.
- **speed:** frame-to-frame movement, smoothed for sensor stability but never blended with noise.
- **symmetry:** how closely left and right limbs mirror each other.

Session-level qualities (duration, stillness ratio, average energy, movement variance) are derived from the recording afterwards, not stored separately.

**The seed system.** Each day has its own world, derived from the user plus the date. Sessions on the same day share terrain and palette and produce sibling pieces; tomorrow brings a new world. User choices override seeded values, and the seed fills in everything else.

**The recipe.** A saved piece is `{ version, styleId, userChoices, worldSeed, sessionIndex, movementRecording }`. That's far smaller than a high-resolution image, and replaying it rebuilds the piece at any resolution.

### Capture pipeline

Pose tracking uses MediaPipe Tasks `PoseLandmarker`, running in a Web Worker. Frames are read straight from the camera's `MediaStream` via `MediaStreamTrackProcessor`, with a `requestVideoFrameCallback` fallback. Because of that, tracking keeps running at full rate even when the video preview is hidden or off screen. An earlier proof of concept had to pin the video element on screen to stop browsers throttling it; this design removes that constraint.

---

## Key engineering decisions

**Determinism is tested, not assumed, at two levels.** JavaScript floating-point math behaves the same across browsers, but canvas anti-aliasing doesn't. So the geometry a style produces is hashed and must match everywhere, while rendered pixels are hashed and compared only within one browser and GPU. Both are permanent automated tests.

**Fixed-timestep simulation.** The art advances on a fixed tick driven by the recording's own clock, sampling movement by sample-and-hold (no interpolation). Wall-clock time and frame rate have no influence, so a fast laptop and a slow one produce the same piece, and replay can run faster than real time. A live session is simply a replay of a recording being written in real time.

**`Math.random()` is banned where art is generated.** An ESLint rule enforces this in the world and style layers. Every random draw comes from a labeled stream (seed plus knob name), so adding a new knob later leaves every existing world unchanged. Noise comes from the project's own implementation rather than a global library singleton.

**Styles output geometry, not pixels.** Styles emit depth-tagged geometry, and a separate compositor turns it into pixels: pale, soft layers in the distance, dark and saturated ones up close. This is what produces Botanical's look. Keeping depth in the data also leaves a future 3D or VR renderer possible without building any of that infrastructure now.

**Rendering stays fast as pieces grow.** Redrawing an entire accumulated piece every frame made the frame rate collapse in long sessions. The live compositor now bakes finished geometry onto persistent per-depth canvases once, and redraws only the branches that are still growing.

---

## What didn't work the first time

**The fading-marks bug took three sessions to find, and the retro changed how I debug.** Marks on the canvas would fade out and sometimes come back after a burst of movement. I spent several sessions chasing paint-order bugs in the compositor. They were real bugs, and fixing each one felt like progress, which kept me searching in the wrong place.

The actual cause was a Canvas 2D `globalAlpha` state leak: a pale, low-opacity element drawn last left the context's opacity set, so a whole layer could composite at about 4%. The clue was there from day one: marks *coming back* can't be explained by pixels being permanently overwritten. The bug was found within 40 minutes once I built a detector for the literal symptom (content vanishing between frames), after about 5 hours of comparing renders against a reference.

What changed afterwards:

- The first tool for a visible bug is now an automated detector of that symptom.
- Every hypothesis must explain every observed symptom before a fix is approved.
- Any rendering pass that changes shared canvas state must restore it, backed by a regression test.

The full write-up is in [`docs/retros/2026-08-23-fading-bug-retro.md`](docs/retros/2026-08-23-fading-bug-retro.md).

---

## Design process

The art and the page were designed separately and deliberately:

- **Art:** each style has its own measurable visual spec. [`docs/styles/botanical.md`](docs/styles/botanical.md) covers marks, branching, blossoms, palette, depth, composition, movement mapping and an acceptance test. Botanical is inspired by Holger Lippmann's *Recursive Tree X*.
- **Page UX:** follows the Double Diamond (Discover → Define → Develop → Deliver). That produced competitive and analog research, a single problem statement, wireframe directions for each key screen, and the "Typewriter Utility" visual style. See [`docs/UX/UX_PLAN.md`](docs/UX/UX_PLAN.md).

## How it was built

I built MoveScape with AI coding agents (Claude Code), using a deliberate process:

- **Two documents run the project.** [`docs/SPEC.md`](docs/SPEC.md) says what the system should be (concept, product definition, architecture, invariants, milestones). [`docs/HANDOFF.md`](docs/HANDOFF.md) says where the build actually stands and records every deviation with its reasoning.
- **A coordinator agent manages each session.** It breaks the milestone into tasks, assigns them to builder agents, checks their work against the acceptance criteria and a fixed list of invariants, and updates the handoff.
- **Each milestone** gets its own branch and PR and is merged only after I've tested it live.
- **CI** runs lint, type-checking, tests and a production build on every push.

---

## Roadmap

| Milestone | Status |
|-----------|--------|
| M0 Scaffold: Vite, TypeScript, ESLint, Vitest, CI | Done |
| M1 Capture and movement parameters | Done |
| M2 Seeds and worlds | Done |
| M3 Engine and compositor, determinism tests | Done |
| M4 Botanical style | Done |
| M5 Sessions and saving: recipes, export/import, expanding canvas | Done |
| Frameable composition (portrait crop that looks complete at every moment) | In progress |
| Rethinking randomness and the seed world model | Planned |
| Production deployment on Vercel | Planned |
| M6 Second style (cosmic family) | Planned, after the items above |
| M7 Mobile pass | Planned |

Later: a gallery of saved pieces, more movement signals, sharing, wearable inputs (art from runs and swims), and eventually an explorable universe of your past pieces.

> TODO (Stephanie): confirm this status is current. It reflects `docs/HANDOFF.md` as of its last update.

---

## Run it locally

**Prerequisites:** Node.js 22 (the version CI uses), a webcam, and a Chromium-based browser for the best capture support.

```bash
git clone https://github.com/stephaniegracefarah/MoveScape-V1.git
cd MoveScape-V1
npm install
npm run dev        # start the dev server
```

Other commands:

```bash
npm test           # run the test suite (Vitest)
npm run lint       # ESLint, including the seeded-randomness rule
npm run typecheck  # TypeScript, no emit
npm run build      # production build
```

Development builds include manual movement sliders and a live tuning panel. Production builds contain neither.

## Project structure

```
src/
├── adapters/      # Layer 1: webcam + pose worker, dev-only sliders, the MovementParams contract
├── world/         # Layer 2: seeds, labeled PRNG and noise streams, World
├── styles/        # Layer 3: style renderer interface, Botanical
├── engine/        # fixed-timestep loop, recording, replay, sample-and-hold
├── compositor/    # depth compositor, live compositor, export rendering
├── storage/       # IndexedDB recipes, recipe export/import, image export
├── app/           # UI shell: session flow, readout, "Show the magic" panel
└── shared/        # hashing, math, seeded noise, PRNG (no dependencies on other layers)
docs/
├── SPEC.md        # concept, product definition, architecture, build guide
├── HANDOFF.md     # build state and session changelog
├── styles/        # per-style visual specs
├── UX/            # Double Diamond UX process and style guide
└── retros/        # bug retrospectives
```

## Stack

TypeScript · Vite · MediaPipe Tasks (PoseLandmarker) · Web Workers · Canvas 2D · IndexedDB · Vitest · ESLint · GitHub Actions

---

© 2026 Stephanie Farah. All rights reserved.

> TODO (Stephanie): decide whether to keep "all rights reserved" (public to read, not licensed for reuse) or add an open-source license such as MIT.

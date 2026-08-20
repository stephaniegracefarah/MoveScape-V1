# MoveScape — Handoff / Changelog

This is the second document of the two-document system (see the main doc, Part 4). The main doc says what the system should be; this doc says where the build actually stands. The coordinator agent updates it at the end of every session; every new session starts by reading both documents.

Rules for the coordinator writing entries: newest session on top; be specific enough that a session with zero prior context can resume from the entry alone; every deviation from the main doc gets its reasoning written down; keep the running sections (state summary, open deviations, known issues) current rather than only appending.

---

## Current state summary

*(Keep this section updated — it is the fast path for a new session. What milestone is active, what works end-to-end right now, how to run the project and its tests.)*

- **Active milestone:** M2 (seeds and worlds) built on branch `m2-seeds-worlds`, PR #2 open, awaiting founder acceptance and merge; M3 (engine and compositor) is next pending founder approval
- **Works right now:** M0 scaffold, all of M1 (webcam adapter, dev-gated slider adapter, live parameter readout, app shell with privacy note), plus M2's seed/world layer — `createLabeledStream(seed, label)` (hand-written cyrb53 + mulberry32, `src/shared/`) as the sole randomness source for world/style code, `deriveWorldSeed`/`deriveSessionSeed`/`formatLocalDate` (`src/world/seed.ts`), and `createWorld(worldSeed, sessionIndex, overrides?)` producing a `World` with a generic `knob(name)` accessor and per-name override precedence. Nothing in the app wires this in yet — layer 2 has no UI consumer until a real style exists (M4). 59 unit tests passing (22 from M1 + 37 new); production bundle still verified to contain zero slider code (unaffected by this milestone)
- **Run:** `npm install`, then `npm run dev` (webcam needs a browser + camera; "Use sliders" appears in dev builds only)
- **Test:** `npm test` (also `npm run lint`, `npm run typecheck`, `npm run build`)
- **Dev machine quirk:** shells may have a stale PATH (Node/gh installed 2026-08-19). Refresh in PowerShell before npm/gh: `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`. The plain Bash tool's default PATH also misses both — `export PATH="$PATH:/c/Program Files/GitHub CLI:/c/Program Files/nodejs"` fixes it there.

## Open deviations from the main doc

*(Implementation choices that differ from or refine the spec, not yet folded back into the main doc. Each entry: what changed, why, and which part/section of the main doc it affects. When the founder folds one into the main doc, move it to the session log entry where the fold happened.)*

- **`World` ships generic in M2, with no concrete fields yet.** Part 3 describes the world layer deriving "palette, background, branch/growth personality constants, wind direction, density tendencies, per-style knob values" — M2 implements only the general mechanism (`knob(name: string): number`, seed-derived via a labeled stream, overridable per-name) and adds no concrete field names, because no style exists yet to consume them (Botanical isn't built until M4) and inventing placeholder knob names now would be unused speculative code. The generic accessor already satisfies the spec's actual requirement ("adding a new knob later leaves every existing world unchanged") for any knob name a future style declares via `worldKnobs()`. Affects Part 3, "The seed system" (World object paragraph). Expect this to resolve itself naturally once M4 gives Botanical real knob names — no fold needed unless the founder wants `World` to carry a fixed named vocabulary instead of a generic accessor.

## Founder backlog (requested 2026-08-20, do not start without founder approval)

- **More instantaneous inputs in v1:** founder wants at least 4 (spec currently ships 3: expansion/speed/symmetry, with verticality/hand height/lean/jerkiness listed as v1.x candidates). Needs a spec fold: pick the 4th (or more), bump MovementParams `v`, implement in the webcam adapter + sliders + readout. Candidate slot: alongside M4 tuning, when it's clear what Botanical needs.
- **Speed reads ~0.30 while sitting still** (dim-light landmark jitter integrating into speed; screenshot on record). Should idle ≈0.05–0.10 so stillness genuinely reads as still. Tuning task in `POSE_PARAM_TUNING` (jitter floor / per-landmark visibility weighting / EMA + scale retune) — fits naturally with M4's movement-mapping tuning, or a small M1.x pass.

## Known issues / debt

*(Bugs, shortcuts taken knowingly, and anything a QA pass flagged but deferred. Each entry says what would make it done.)*

- None yet.

---

## Session log

*(Newest first. One entry per session.)*

### Session 003 — 2026-08-20 — M2 Seeds and Worlds

**Goal this session:** M2 in full, on branch `m2-seeds-worlds`.

**Completed:**
- Coordinator explored the current scaffold (`src/world/world.ts` was still M0/M1's placeholder; `src/shared/` had only `clamp01`) and drafted a full implementation plan (hash/PRNG choice, labeled-stream mechanism, World shape, override semantics, test list mapped to each acceptance criterion) via a Plan agent, reviewed it, and got founder approval before building.
- Single Sonnet builder implemented the milestone sequentially (small enough that a two-way split would have cost more coordination than it saved): `src/shared/hash.ts` (hand-written cyrb53), `src/shared/prng.ts` (hand-written mulberry32, factory not singleton), `src/world/labeled-stream.ts` (`createLabeledStream(seed, label)` — the sole randomness entry point for world/style code; builds a fresh hash→PRNG chain per call so knob independence holds by construction), `src/world/seed.ts` (`formatLocalDate`, `deriveWorldSeed`, `deriveSessionSeed`), and an expanded `src/world/world.ts` (`World` with `worldSeed`/`sessionSeed`/`sessionIndex`/`knob(name)`, `createWorld` with per-name override precedence).
- 37 new unit tests (59 total with M1's 22), covering the milestone's four acceptance criteria directly plus the underlying primitives (hash/PRNG determinism and distribution sanity, labeled-stream label/seed independence).

**Deviations / decisions made, with reasoning:**
- Hand-wrote cyrb53 + mulberry32 rather than adding a dependency — each is ~10 lines of public-domain pure-integer math, consistent with M0/M1's minimal-dependency stance (only runtime dep remains `@mediapipe/tasks-vision`).
- `World` kept generic (`knob(name)`) with zero concrete fields (no palette/wind/density) — see "Open deviations" above; no style exists yet to consume named knobs, and the project's own anti-stub-file principle rules out inventing unused vocabulary now.
- `formatLocalDate` uses the `Date`'s local Y/M/D components, not `toISOString()` (UTC) — a UTC day boundary would flip "today's world" near midnight in negative-UTC-offset timezones, breaking the "Tuesday is Tuesday" promise. Kept as a pure function taking a `Date` parameter so tests stay timezone-agnostic.
- `userId` persistence (the "locally stored random identity created on first run" from Part 3) is explicitly deferred — `deriveWorldSeed(userId, localDate)` stays a pure function taking `userId` as a plain string parameter; the actual get-or-create-in-localStorage wiring waits until a milestone first constructs a real `World` in the running app (M4), since M2's acceptance criteria are all pure/unit-testable with no app wiring required.
- World-level knobs derive from `worldSeed` (not `sessionSeed`), so they stay stable across sibling sessions on the same day; `sessionSeed` is exposed as a plain public field (not override-aware) for a style's own session-level jitter streams, since session-level stochastic detail is never one of the user's overridable choices per spec.

**QA notes:**
- Coordinator independently reread the crux files (`labeled-stream.ts`, `world.ts`, `hash.ts`, `prng.ts`, `seed.ts`) rather than trusting the builder's summary, and confirmed the labeled-stream construction genuinely builds a fresh chain per call (no shared/cached generator state) — the property the whole independence guarantee rests on.
- Independently reran `lint`/`typecheck`/`test`/`build` (all green, 59/59 tests) rather than accepting the builder's report at face value.
- Read through `world.test.ts` in full and confirmed the four acceptance-criteria tests (same-seed identity, session-index variation, override precedence, knob-stream independence) actually exercise the claimed property rather than passing trivially — in particular the independence test varies read order across four separate `World` instances.

**Known issues added/resolved:**
- None.

**Next session should:**
- After founder reviews/merges PR #2, start M3 (engine and compositor): fixed-timestep simulation loop, recording writer, the StyleRenderer interface is already pinned (`src/styles/style-renderer.ts`), the 2D depth compositor, and a placeholder style (e.g. drifting circles) to exercise it. M3's acceptance criterion is the first determinism test (same recipe → identical geometry hash and identical pixel hash across two runs at different render frame rates, same environment) — this is the milestone that first makes real use of M2's `World`/`createLabeledStream`. Check the founder backlog (4th+ instantaneous input; stillness-speed jitter tuning) before proposing scope — both remain unapproved and don't block M3.

### Session 002 — 2026-08-19 — M1 Capture and Parameters

**Goal this session:** M1 in full, on branch `m1-capture-params`.

**Completed:**
- Coordinator pinned the `InputAdapter` contract (`src/adapters/input-adapter.ts`) and factory stubs before spawning builders, so the two parts could build in parallel against a fixed interface.
- Builder A (webcam, Sonnet): visibility-independent capture (`MediaStreamTrackProcessor` primary, `requestVideoFrameCallback` on a detached video element as fallback), MediaPipe Tasks `PoseLandmarker` in a module Web Worker (GPU delegate, CPU fallback), pure landmark→params module with all tunables in one documented block (`POSE_PARAM_TUNING`), 10 unit tests on synthetic landmarks. New dependency: `@mediapipe/tasks-vision` (model + wasm fetched from CDN at startup, permitted by invariant 5).
- Builder B (sliders/readout/shell, Sonnet): dev-gated slider adapter (~30 Hz), live parameter readout coupled only through `ParamsListener` (invariant 1), app shell with adapter switching, error surfacing, and the visible privacy note.

**Deviations / decisions made, with reasoning:**
- Speed/symmetry use 2D landmark coordinates only — MediaPipe's z is noisier and differently scaled; documented in code.
- Frames are dropped, not queued, when the pose worker is busy, so params stay a live readout (immediacy over completeness).
- `createSliderAdapter` accepts an optional injected minimal document for testability (no jsdom dependency); zero-arg call sites unaffected.
- Coordinator committed builders' work after QA rather than builders pushing directly — keeps every push QA'd.

**QA notes:**
- Coordinator QA found a pipeline deadlock: the pose worker posted nothing on a no-pose frame while the main thread waited on a reply before sending the next frame — one undetected frame killed the session. Sent back to Builder A; fixed with a `noPose` message plus speed-state reset after 15 consecutive no-pose frames (stale-state speed spike on re-entry). 3 regression tests added.
- Verified independently by coordinator: lint/typecheck/22 tests/build all green; production dist grep contains zero slider strings (M1 acceptance); dev-mode build does contain the slider chunk (gate is genuinely conditional).

**Known issues added/resolved:**
- Resolved: "ModuleFactory not set" on camera start, and its successor (silent hang in dev). Final fix: module worker + `preloadWasmModuleFactory()` in pose-worker.ts (fetch the fileset-resolved wasm loader, execute via indirect eval so `ModuleFactory` is set before MediaPipe's `importScripts()` attempt, which module workers throw on but MediaPipe swallows). Works in dev AND build, verified headless with a fake camera in both. start() now rejects on native worker error/messageerror + 20s timeout — never hangs silently. A classic worker does NOT work (Vite dev serves worker imports un-bundled); a bare module worker does NOT work (no importScripts). The preload is load-bearing.
- Resolved: Stop leaked a live camera stream when Start was clicked again during slow startup — pendingAdapter tracked before awaiting start(), activation tokens discard superseded adapters, start buttons disabled while "Starting…".
- Resolved: white-on-white shell text (no page background was set).

**Founder live-test results (M1 acceptance):** sliders drive the readout ✓; camera drives the readout with no video element on screen ✓. Founder-requested additions built the same session: camera preview show/hide toggle (CSS-only mirroring, hidden by default, via optional `previewStream?()` on InputAdapter) and a wiring-layer Pause/Resume gate (adapter stays warm; precursor to session pause).

**Next session should:**
- Merge `m1-capture-params` (PR #1) to main after founder confirms the preview/pause additions, then start M2 (seeds and worlds) after founder approval.

### Session 001 — 2026-08-19 — M0 Scaffold

**Goal this session:** M0 in full (spec Part 4, Repository layout + M0 milestone).

**Completed:**
- Repository layout per spec: docs moved to `docs/SPEC.md` / `docs/HANDOFF.md`; layer directories (`src/adapters`, `src/world`, `src/styles`, `src/engine`, `src/compositor`, `src/storage`, `src/app`, `src/shared`) with `.gitkeep` in the empty ones.
- Toolchain: Vite 8 + TypeScript 6 (strict), Vitest 4, ESLint 10 flat config with the invariant-2 `Math.random` ban scoped to `src/world` and `src/styles`, Prettier, `.vscode/` shared setup, GitHub Actions CI (lint + typecheck + test + build on every push).
- Contract files: `src/adapters/movement-params.ts` (versioned MovementParams + MovementSample) and `src/styles/style-renderer.ts` (StyleRenderer, Scene, SceneElement with required `z`), plus a placeholder `World` type in `src/world/world.ts` (real derivation is M2).
- `src/shared/math.ts` (`clamp01`) with the first passing test.

**Deviations / decisions made, with reasoning:**
- Node.js was not installed on the dev machine; installed Node 24 LTS via winget. CI pins Node 22 (also LTS); no compatibility issues expected at this dependency surface.
- The p5 `noise()` ban (invariant 2) has no lint rule yet because p5 is not a dependency; add the rule if/when p5 is introduced.
- Coordinator built M0 inline rather than spawning builder agents — M0 is configuration and contracts with no parallelizable feature parts. Builder agents start at M1.

**QA notes:**
- M0 acceptance: build, lint, typecheck, and test all pass locally. CI run pending on push (acceptance includes CI green).
- Invariant 2 lint rule verified by test-firing: a temporary `Math.random()` in `src/world` produced the expected lint error and was removed.

**Known issues added/resolved:**
- None.

**Next session should:**
- Start M1: the visibility-independent capture pipeline (`MediaStreamTrackProcessor` + `requestVideoFrameCallback` fallback), PoseLandmarker in a Web Worker, the webcam adapter computing expansion/speed/symmetry, the dev-gated slider adapter, and the on-screen readout. The capture pipeline and slider adapter are independent parts — builders can run in parallel against the MovementParams contract.

### Session 000 — YYYY-MM-DD — Template

**Goal this session:** *(which milestone / which parts)*

**Completed:**
- *(what was built, by which builder tasks, and what QA verified — reference the milestone acceptance criteria and invariant numbers checked)*

**Deviations / decisions made, with reasoning:**
- *(anything done differently than the main doc specifies, or decided where the doc was silent — and why)*

**QA notes:**
- *(what was checked, what failed and was sent back, what passed on retry; determinism test status)*

**Known issues added/resolved:**
- *(cross-reference the section above)*

**Next session should:**
- *(the concrete starting point: milestone, first tasks, anything blocking)*

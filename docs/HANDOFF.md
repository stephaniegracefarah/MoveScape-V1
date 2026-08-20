# MoveScape — Handoff / Changelog

This is the second document of the two-document system (see the main doc, Part 4). The main doc says what the system should be; this doc says where the build actually stands. The coordinator agent updates it at the end of every session; every new session starts by reading both documents.

Rules for the coordinator writing entries: newest session on top; be specific enough that a session with zero prior context can resume from the entry alone; every deviation from the main doc gets its reasoning written down; keep the running sections (state summary, open deviations, known issues) current rather than only appending.

---

## Current state summary

*(Keep this section updated — it is the fast path for a new session. What milestone is active, what works end-to-end right now, how to run the project and its tests.)*

- **Active milestone:** M2 accepted and merged to main (PR #2). M3 (engine and compositor) built on branch `m3-engine-compositor`, PR open, awaiting founder acceptance and merge; M4 (Botanical) is next pending founder approval
- **Works right now:** M0 scaffold, all of M1 (webcam adapter, dev-gated slider adapter, live parameter readout, app shell with privacy note), M2's seed/world layer (`createLabeledStream`, `deriveWorldSeed`/`deriveSessionSeed`/`formatLocalDate`, `createWorld` with per-name override precedence), plus M3's engine and compositor — `advanceTicks`/`replay` (`src/engine/replay.ts`, fixed 60Hz tick, sample-and-hold via `sample-and-hold.ts`, no wall clock anywhere), `recordSample` (`src/engine/recording.ts`), `renderScene` (`src/compositor/render-scene.ts`, a single depth-sort-fade-composite loop against a hand-written `CanvasLike` interface), and a throwaway `createDriftingCirclesStyle` placeholder (`src/styles/placeholder/`) that exercises both. Two permanent determinism tests (`src/engine/geometry-determinism.test.ts`, `pixel-determinism.test.ts`) prove the same recipe replayed at different tick-batch granularities produces bit-identical geometry and pixel hashes — invariants 3 and 4 made real for the first time. Nothing in the running app wires any of layers 2/3 in yet — still no UI consumer until Botanical (M4). 98 unit tests passing (59 from M0-M2 + 39 new); production bundle still verified to contain zero slider code and no trace of the new test-only `@napi-rs/canvas` dependency
- **Run:** `npm install`, then `npm run dev` (webcam needs a browser + camera; "Use sliders" appears in dev builds only)
- **Test:** `npm test` (also `npm run lint`, `npm run typecheck`, `npm run build`)
- **Dev machine quirk:** shells may have a stale PATH (Node/gh installed 2026-08-19). Refresh in PowerShell before npm/gh: `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`. The plain Bash tool's default PATH also misses both — `export PATH="$PATH:/c/Program Files/GitHub CLI:/c/Program Files/nodejs"` fixes it there.

## Open deviations from the main doc

*(Implementation choices that differ from or refine the spec, not yet folded back into the main doc. Each entry: what changed, why, and which part/section of the main doc it affects. When the founder folds one into the main doc, move it to the session log entry where the fold happened.)*

- **`World` ships generic in M2, with no concrete fields yet.** Part 3 describes the world layer deriving "palette, background, branch/growth personality constants, wind direction, density tendencies, per-style knob values" — M2 implements only the general mechanism (`knob(name: string): number`, seed-derived via a labeled stream, overridable per-name) and adds no concrete field names, because no style exists yet to consume them (Botanical isn't built until M4) and inventing placeholder knob names now would be unused speculative code. The generic accessor already satisfies the spec's actual requirement ("adding a new knob later leaves every existing world unchanged") for any knob name a future style declares via `worldKnobs()`. Affects Part 3, "The seed system" (World object paragraph). Expect this to resolve itself naturally once M4 gives Botanical real knob names — no fold needed unless the founder wants `World` to carry a fixed named vocabulary instead of a generic accessor.
- **Compositor stays a single depth-sorted draw loop in M3, no per-layer accumulate/clear-and-redraw canvases yet.** Part 3 describes the v1 compositor as "an ordered stack of layer canvases... each layer independently chooses accumulate or clear-and-redraw," and names this specifically as the mechanism Botanical needs to resolve its blossom-accumulation-vs-branch-redraw tension. M3's placeholder circle style has nothing to accumulate, so building that architecture now would be speculative. Affects Part 3, "Depth-layered rendering." Expect M4 to extend `renderScene` when Botanical's real tension appears — flag to the founder if Botanical's design instead wants the layered architecture decided before M4 starts, rather than discovered during it.
- **Live-session/replay code-path unification is only half-built in M3.** Invariant 4 says "a live session is just a replay of a recording being written in real time." M3 builds and tests the one primitive (`advanceTicks`) that already supports both calling patterns — one big call for a full replay, many small calls as real-time samples arrive for a live session — but the actual rAF-driven live loop, and wiring it to a running session, is deferred to M5 (which owns session start/end). Affects Part 3's fixed-timestep paragraph and Part 4's M5 milestone description implicitly. No fold needed; this is expected to complete naturally when M5 is built, not a permanent gap.

## Founder backlog (requested 2026-08-20, do not start without founder approval)

- **More instantaneous inputs in v1:** founder wants at least 4 (spec currently ships 3: expansion/speed/symmetry, with verticality/hand height/lean/jerkiness listed as v1.x candidates). Needs a spec fold: pick the 4th (or more), bump MovementParams `v`, implement in the webcam adapter + sliders + readout. Candidate slot: alongside M4 tuning, when it's clear what Botanical needs.
- **Speed reads ~0.30 while sitting still** (dim-light landmark jitter integrating into speed; screenshot on record). Should idle ≈0.05–0.10 so stillness genuinely reads as still. Tuning task in `POSE_PARAM_TUNING` (jitter floor / per-landmark visibility weighting / EMA + scale retune) — fits naturally with M4's movement-mapping tuning, or a small M1.x pass.

## Known issues / debt

*(Bugs, shortcuts taken knowingly, and anything a QA pass flagged but deferred. Each entry says what would make it done.)*

- None yet.

---

## Session log

*(Newest first. One entry per session.)*

### Session 004 — 2026-08-20 — M3 Engine and Compositor

**Goal this session:** M3 in full, on branch `m3-engine-compositor`.

**Completed:**
- Founder approved PR #2 (M2) and it merged to main first; coordinator explored the M3 scaffold (`src/engine/`, `src/compositor/`, `src/styles/` all empty except `style-renderer.ts`), surfaced one real tooling question to the founder in plain language — the Vitest test environment is plain Node with no Canvas/DOM API, but M3's acceptance criterion needs an automated pixel-hash test — and the founder chose adding `@napi-rs/canvas` (prebuilt, no-compiler-needed, devDependency-only) over a Playwright-browser test setup or deferring the pixel test. Drafted a full plan via a Plan agent, reviewed it, got founder approval.
- Coordinator pinned the shared contract first (extended `SceneElement` in `src/styles/style-renderer.ts` with `x`/`y`/`radius`/`color`/`opacity`, all normalized 0-1), then two Sonnet builders ran in parallel: Builder A built the engine (`sample-and-hold.ts`'s forward-cursor sample-and-hold lookup, `recording.ts`'s ascending-timestamp-enforcing `recordSample`, `replay.ts`'s `advanceTicks`/`replay` — a fixed 60Hz tick, `dt` always exactly `tickMs`, zero wall-clock calls anywhere). Builder B built the compositor (`render-scene.ts`'s `renderScene`, a hand-written `CanvasLike` structural interface mirroring the existing `WorkerScope` pattern in `pose-worker.ts`, single depth-sorted draw loop with a linear opacity/radius fade by `z`) and the placeholder style (`drifting-circles.ts`, all randomness confined to `init()` via a session-seeded labeled stream, `step()` a pure function of stored state plus `params`/`time`).
- Once both landed, Builder A's agent was continued for the integration step: `cyrb53Bytes` added to `src/shared/hash.ts` (byte-indexed hashing, refactored to share a core mixing function with the existing string-based `cyrb53`, so pixel bytes never route through `Buffer`), the `@napi-rs/canvas` install, and the two determinism tests — `geometry-determinism.test.ts` and `pixel-determinism.test.ts` — which replay a fixed hand-written recording through the placeholder style twice: once via `replay()` in one call, once via `advanceTicks` pumped across uneven tick-batch boundaries (operationalizing "different render frame rates" as different tick-batching, since the simulation itself is wall-clock-independent), then assert bit-identical geometry hashes and, via `@napi-rs/canvas`, bit-identical pixel hashes — each with a sensitivity guard (a different world seed must produce a different hash) so the tests can't pass vacuously.
- Coordinator added one more ESLint rule (`src/engine/**`, banning `Date.now`/`performance.now`) mirroring invariant 2's existing `Math.random` ban mechanism, to enforce invariant 4 the same way invariant 2 is already enforced.
- 39 new unit tests (98 total).

**Deviations / decisions made, with reasoning:**
- See "Open deviations" above: single-pass compositor (no per-layer accumulate/redraw yet), and live-session/replay unification only half-built (the shared `advanceTicks` primitive exists and is tested; the rAF-driven live loop is M5's job).
- `@napi-rs/canvas` added as the one new dependency this milestone, founder-approved after a plain-language explanation of the alternatives (native canvas requiring a compiler, a full Playwright browser setup, or deferring the pixel test). Confirmed by grep to be imported only from `pixel-determinism.test.ts`, never from production `src/compositor` or `src/styles` code, and confirmed absent from the built `dist/` bundle.
- Tick rate fixed at 60Hz (the spec's own example value); `step(params, time, dt)`'s `time`/`dt` units are milliseconds (not specified in the spec, chosen to match `MovementSample.t`'s documented unit).
- Sample-and-hold before the first recorded sample clamps to the first sample (holds it) rather than inventing a fictitious zero-params state or throwing; an empty recording throws (treated as an invalid recipe, not a valid "no movement yet" state).
- `MovementRecording`/`recordSample` (`src/engine/recording.ts`) are deliberately not the full piece recipe (`{version, styleId, userChoices, worldSeed, sessionIndex, movementRecording}`) — that wrapper, and its IndexedDB persistence, stay M5's job.

**QA notes:**
- Coordinator independently reread every crux file (`replay.ts`, `sample-and-hold.ts`, `render-scene.ts`, `drifting-circles.ts`, both determinism test files, `hash.ts`) rather than trusting builder summaries, confirming in particular that `advanceTicks` never touches a wall clock and that the two determinism tests' "different frame rate" framing is genuinely exercised via different tick-batch boundaries, not just calling the same function twice.
- Independently reran `lint`/`typecheck`/`test`/`build` (all green, 98/98 tests) after the coordinator's own ESLint addition, rather than accepting the builders' reports at face value.
- Independently grepped for `@napi-rs/canvas` (found only in the one test file) and `Date.now`/`performance.now` (found nowhere in `src/engine/`).

**Known issues added/resolved:**
- None.

**Next session should:**
- After founder reviews/merges this PR, start M4 (Botanical) — the real style, and where most of the project's effort belongs per the spec ("the experience MVP"). This is also where the two open deviations above (compositor layering, `World`'s generic-vs-concrete knobs, live/replay wiring) will likely get resolved by necessity rather than by further deferral, since Botanical is the first real consumer of all three. Check the founder backlog (4th+ instantaneous input; stillness-speed jitter tuning) before proposing scope — the backlog itself suggests both could slot in "alongside M4 tuning."

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

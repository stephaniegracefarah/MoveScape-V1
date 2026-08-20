# MoveScape — Handoff / Changelog

This is the second document of the two-document system (see the main doc, Part 4). The main doc says what the system should be; this doc says where the build actually stands. The coordinator agent updates it at the end of every session; every new session starts by reading both documents.

Rules for the coordinator writing entries: newest session on top; be specific enough that a session with zero prior context can resume from the entry alone; every deviation from the main doc gets its reasoning written down; keep the running sections (state summary, open deviations, known issues) current rather than only appending.

---

## Current state summary

*(Keep this section updated — it is the fast path for a new session. What milestone is active, what works end-to-end right now, how to run the project and its tests.)*

- **Active milestone:** M1 built on branch `m1-capture-params`; awaiting the founder's live-camera acceptance test before merge to main
- **Works right now:** M0 scaffold plus all of M1's code — webcam adapter (visibility-independent capture, pose worker, expansion/speed/symmetry), dev-gated slider adapter, live parameter readout, app shell with privacy note. 22 unit tests passing; production bundle verified to contain zero slider code
- **Run:** `npm install`, then `npm run dev` (webcam needs a browser + camera; "Use sliders" appears in dev builds only)
- **Test:** `npm test` (also `npm run lint`, `npm run typecheck`, `npm run build`)

## Open deviations from the main doc

*(Implementation choices that differ from or refine the spec, not yet folded back into the main doc. Each entry: what changed, why, and which part/section of the main doc it affects. When the founder folds one into the main doc, move it to the session log entry where the fold happened.)*

- None yet.

## Known issues / debt

*(Bugs, shortcuts taken knowingly, and anything a QA pass flagged but deferred. Each entry says what would make it done.)*

- None yet.

---

## Session log

*(Newest first. One entry per session.)*

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

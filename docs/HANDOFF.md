# MoveScape — Handoff / Changelog

This is the second document of the two-document system (see the main doc, Part 4). The main doc says what the system should be; this doc says where the build actually stands. The coordinator agent updates it at the end of every session; every new session starts by reading both documents.

Rules for the coordinator writing entries: newest session on top; be specific enough that a session with zero prior context can resume from the entry alone; every deviation from the main doc gets its reasoning written down; keep the running sections (state summary, open deviations, known issues) current rather than only appending.

---

## Current state summary

*(Keep this section updated — it is the fast path for a new session. What milestone is active, what works end-to-end right now, how to run the project and its tests.)*

- **Active milestone:** M0 complete → M1 (capture and parameters) is next
- **Works right now:** full scaffold — Vite + vanilla TypeScript builds, ESLint (with the invariant-2 `Math.random` ban, verified to fire), Vitest with a passing test, CI workflow on every push, contract files in place (`src/adapters/movement-params.ts`, `src/styles/style-renderer.ts`), docs moved to `docs/SPEC.md` + `docs/HANDOFF.md`
- **Run:** `npm install`, then `npm run dev`
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

# MoveScape — Handoff / Changelog

This is the second document of the two-document system (see the main doc, Part 4). The main doc says what the system should be; this doc says where the build actually stands. The coordinator agent updates it at the end of every session; every new session starts by reading both documents.

Rules for the coordinator writing entries: newest session on top; be specific enough that a session with zero prior context can resume from the entry alone; every deviation from the main doc gets its reasoning written down; keep the running sections (state summary, open deviations, known issues) current rather than only appending.

---

## Current state summary

*(Keep this section updated — it is the fast path for a new session. What milestone is active, what works end-to-end right now, how to run the project and its tests.)*

- **FOUNDER UPDATE 2026-08-22 — READ FIRST:** the founder has issued a **visual target spec** at `docs/styles/botanical.md` that supersedes Botanical's current look and the pending tuning-pass plan. See the "Founder update — 2026-08-22" entry at the top of the session log for the full record and milestone impact before acting on anything below this line. The next coordinator session's job is the rebuild described there, not the previously-queued tuning pass.
- **Active milestone:** M4 is merged to main. Now mid-tuning-pass: the backend-knobs tuning panel (PR #5, branch `m4x-tuning-panel`) is built and QA'd, **awaiting founder review/merge**. Once merged, next step is using the panel live to work through the four visual-tuning notes in Session 005's "Founder live-review feedback" below, then locking in the founder's exported values as new defaults — before M5 (sessions and saving) starts.
- **Works right now:** M0-M4 (webcam adapter, seed/world layer, fixed-timestep engine, compositor, Botanical) as before — see prior entries for the full description. **New in Session 006 (PR #5, not yet merged):** all of Botanical's ~27 previously-hardcoded internal tuning constants (`MAX_GENERATION`, `SHRINK_RATE`, blossom/color/root formula constants, etc.) now live in one `BotanicalTuningConfig` object (`src/styles/botanical/tuning-config.ts`), threaded through `branch.ts`/`blossom.ts`'s pure functions and `botanical.ts`'s state instead of read as module constants — `createBotanicalStyle()` with no args is unchanged (defaults are byte-identical to the old hardcoded values). A dev-only "backend knobs" panel in `main.ts` (behind `import.meta.env.DEV`, tree-shaken from production like the existing slider adapter) exposes a slider per World knob (raw 0-1, seeded from today's actual values) and per tuning-config field (ranged around its default), live-restarting the piece ~120ms after the last drag, plus an Export button that serializes the current `WorldOverrides` + `BotanicalTuningConfig` to a JSON blob in a read-only textarea for the founder to paste back. 160 unit tests passing (158 + 2 new); production bundle re-verified to contain zero panel code, zero slider code.
- **Run:** `npm install`, then `npm run dev` (webcam needs a browser + camera; "Use sliders" and "Show tuning panel" appear in dev builds only)
- **Test:** `npm test` (also `npm run lint`, `npm run typecheck`, `npm run build`)
- **Dev machine quirk:** shells may have a stale PATH (Node/gh installed 2026-08-19). Refresh in PowerShell before npm/gh: `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`. The plain Bash tool's default PATH also misses both — `export PATH="$PATH:/c/Program Files/GitHub CLI:/c/Program Files/nodejs"` fixes it there.

## Open deviations from the main doc

*(Implementation choices that differ from or refine the spec, not yet folded back into the main doc. Each entry: what changed, why, and which part/section of the main doc it affects. When the founder folds one into the main doc, move it to the session log entry where the fold happened.)*

- **`World` still has no fixed named vocabulary — resolved differently than Part 3's wording implies.** M2's generic `knob(name)` mechanism is now genuinely exercised: Botanical declares 11 real knob names via `worldKnobs()` (`hueBase`, `hueSpread`, `branchDensity`, `baseGrowthRate`, `matureDurationMs`, `windAngle`, `rootCount`, `branchSpreadBase`, `wanderAmplitudeBase`, `blossomsPerCluster`, `subBranchSpawnChance`). `World` itself still carries no fixed field list — each style privately owns the meaning of its own knob names. This satisfies the spec's actual requirement ("adding a new knob later leaves every existing world unchanged") without `World` ever needing a shared vocabulary; a second style (M6) will declare its own, unrelated knob names against the same mechanism. Affects Part 3, "The seed system." No fold expected unless the founder wants a shared cross-style knob vocabulary (e.g. every style must have *some* palette knob) rather than each style defining its own.
- **Compositor stays a single depth-sorted draw loop — Botanical's accumulate-vs-redraw tension was resolved inside the style, not by building real per-layer canvas buffering.** Part 3 names "an ordered stack of layer canvases... each layer independently chooses accumulate or clear-and-redraw" as Botanical's resolution mechanism. M4 instead resolves it entirely in `src/styles/botanical/botanical.ts`'s own state: permanent elements (mature branch segments, blossoms) simply persist unchanged in the style's internal list and get re-emitted identically every tick until their own shrink lifecycle removes them; the compositor still does one clear-and-full-redraw pass per tick (unchanged since M3). This is deliberately simpler than real persistent-canvas buffering — a few hundred to low-thousands of `fillCircle` calls per frame is trivial for Canvas 2D at interactive rates, so it's not a real performance risk at v1 session lengths — and matches the project's own "preserve the information, delay the infrastructure" scope cap (same reasoning as M2's generic `World`). Affects Part 3, "Depth-layered rendering." Revisit if a real long-session performance problem shows up in practice; not expected to be needed for v1.
- **Palette selection is a founder-facing UI choice, not just a seed-random draw.** Part 2 says "style-level choices now, palettes later" without specifying *when* "later" is. Mid-M4, the founder asked for palette choice now (a default plus 2 curated presets, switchable via the UI, full custom color-wheel picking deferred as explicitly-acceptable-for-v1). Implemented as `hueBase`/`hueSpread` knobs (replacing an earlier single-hue design) plus 3 named preset override bundles (`src/styles/botanical/palettes.ts`) applied via `World`'s existing per-knob override mechanism — no new World machinery needed — and 3 buttons in `main.ts` that restart the live loop with the chosen preset. Affects Part 2's "Design decisions made" section. Fold candidate: promote "palette choice now" from an open question to a stated v1 decision.
- **Live-session/replay code-path unification is now built** (`src/app/live-render-loop.ts`), ahead of M5, because M4's subjective acceptance criterion required an actual on-screen live demo. `advanceTicks` (M3) is driven by a `requestAnimationFrame` loop whose own elapsed-time counter only advances while unpaused — pausing freezes tick advancement, not just sample recording, so a paused session doesn't keep quietly growing from stale held params. M5 still owns proper session start/end UI polish, save/export, recipe persistence, style picker, and session-level parameter derivation — this module deliberately does none of that. Affects Part 3's fixed-timestep paragraph and Part 4's M5 milestone description. Fold candidate: M5 should build directly on `live-render-loop.ts` rather than re-deriving the live-tick-pump logic.
- **Botanical's internal tuning constants are now a mutable-at-runtime config object (`BotanicalTuningConfig`), not fixed module constants.** Not anticipated by Part 3/4's original text, which treated these as ordinary implementation constants. Built in Session 006 specifically so the dev-only tuning panel could override them live without a rebuild — see `src/styles/botanical/tuning-config.ts`. `createBotanicalStyle(tuning?: Partial<BotanicalTuningConfig>)` merges any partial over `DEFAULT_BOTANICAL_TUNING_CONFIG`; the zero-arg call (all existing production and test call sites) is unaffected. No spec fold expected — this is a dev-tooling concern, not a product/architecture one — unless a future style also wants a founder-tunable config, in which case the pattern (not the specific fields) is worth documenting as a convention.

## Founder backlog (requested 2026-08-20, do not start without founder approval)

- **More instantaneous inputs in v1:** founder wants at least 4 (spec currently ships 3: expansion/speed/symmetry, with verticality/hand height/lean/jerkiness listed as v1.x candidates). Needs a spec fold: pick the 4th (or more), bump MovementParams `v`, implement in the webcam adapter + sliders + readout. Candidate slot: alongside M4 tuning, when it's clear what Botanical needs.
- **Speed reads ~0.30 while sitting still** (dim-light landmark jitter integrating into speed; screenshot on record). Should idle ≈0.05–0.10 so stillness genuinely reads as still. Tuning task in `POSE_PARAM_TUNING` (jitter floor / per-landmark visibility weighting / EMA + scale retune) — fits naturally with M4's movement-mapping tuning, or a small M1.x pass.

## Known issues / debt

*(Bugs, shortcuts taken knowingly, and anything a QA pass flagged but deferred. Each entry says what would make it done.)*

- None yet.

---

## Session log

*(Newest first. One entry per session.)*

### Founder update — 2026-08-22 — Visual target spec issued (recorded on the founder's behalf by the founder's Cowork session; not a coordinator build session)

**What happened:** the founder reviewed Botanical's live output against the actual reference (Holger Lippmann's *Recursive Tree X*) and concluded the mismatch is **structural, not parametric** — no values reachable through the tuning panel produce the target look, because the mark vocabulary itself is wrong (circle-chain "branches," sparse single-child ramification, confetti-scale blossom clusters, hue-spread palette math, bottom-band lawn composition). Working with Cowork, the founder produced a **visual target spec** — now at **`docs/styles/botanical.md`** — plus rendered metaphor sketches the founder ranked. That file is now the authority on Botanical's look; where it conflicts with prior descriptions (including Session 005's "dense string of small circles" and "white canvas" notes), it wins.

**Decisions made by the founder (all recorded in the visual spec and/or the founder's main-doc copy):**
- **Composition/canvas: the Scroll.** Fixed-height canvas expanding rightward as the piece accumulates; one or two dominant branches sweeping left→right; the Grove (rising stems) vocabulary allowed as secondary elements; radial/burst compositions rejected. The engine continuously composes a fixed-aspect **portrait crop** that must always look complete — that crop is the default save/share; the full scroll (**the journey**) is exportable on request. Duration never appears as numbers on the artwork.
- **Marks:** branches become smooth **tapered strokes** (a new compositor primitive — the SceneElement vocabulary grows beyond circles); repeated forking to fine hairline twigs; blossom clusters become dense (25–80 circles, size mixture, gaussian packing) with within-cluster color mixing.
- **Palette:** curated multi-tone color lists (deep crimson → near-black → dusty rose → cream) replace the `hueBase`/`hueSpread` model. The preset mechanism in `palettes.ts` survives; its contents change from hue math to color lists.
- **Background:** warm cream (≈ `#f7f0e3`) with subtle seeded watercolor-paper texture — replaces white.

**What this supersedes:** the queued plan in Session 006's "Next session should" (use the tuning panel to work Session 005's four tuning notes, then lock exported values as defaults). Those four notes are symptoms of the structural gaps and are all addressed by the rebuild. The tuning panel itself (PR #5) remains valuable — it is the right tool for calibrating the *rebuilt* Botanical — so merging PR #5 first is still sensible.

**Milestone impact:**
- **M3 reopened (scoped extension):** compositor gains the `taperedStroke` element and the cream textured paper ground; the depth model (sort/fade/thin by z) carries over.
- **M4 reopened (rebuild to spec):** Botanical's topology, cluster generation, palette model, and composition rebuilt against `docs/styles/botanical.md`; its acceptance test is now that file's acceptance test (a static seeded render mistakable for the reference's family), replacing the prior subjective wording. The branch lifecycle state machine, pure-math file structure, labeled-stream determinism discipline, and `BotanicalTuningConfig` pattern all survive.
- **M5 updated:** the expanding-scroll canvas, portrait-crop composition, and portrait/journey exports join its scope (already folded in the founder's main-doc copy).
- All determinism tests stay green throughout — they are the safety net that makes this a rework, not a gamble.

**Doc-structure decision (fold into the repo's SPEC.md):** per-style visual specs are now a standing tier — every style gets `docs/styles/<style>.md` as the authority on its look, with the Botanical file's eight-section structure as the template. SPEC.md's style section should point to them, and M4/M6-style acceptance criteria should read "passes its visual spec's acceptance test." The founder deliberately did **not** edit the repo's SPEC.md from outside — the coordinator folds these changes into it next session, respecting its current structure.

**Next session should:**
1. Read `docs/styles/botanical.md` in full before anything else.
2. Merge PR #5 if the founder approves it (the panel aids the rebuild).
3. Fold the doc-structure + canvas decisions into the repo's SPEC.md (see above).
4. Plan and run the rebuild: M3 extension first (stroke primitive + paper ground), then M4 rebuild to the visual spec's acceptance test, keeping all determinism tests green; QA against the visual spec section by section.
5. The founder backlog (4th instantaneous input; stillness-speed jitter) is unchanged and still awaits founder approval before starting.

### Session 006 — 2026-08-20 — Backend-knobs tuning panel

**Goal this session:** build the dev-only tuning panel the founder pre-authorized at the end of Session 005 ("build it first, before using it for the four tuning notes") — see that session's "Founder's follow-up idea" for the original plan this executes.

**Completed:**
- Housekeeping first: local `main` was stale (PR #4 had merged on GitHub but not been pulled locally), and two handoff-only commits had been pushed to `m4-botanical` *after* PR #4 merged (recording the founder's live-review feedback and the tuning-panel plan) — these weren't on `main` yet. Fast-forwarded local `main` to `origin/main`, cherry-picked the two trailing commits onto `main`, pushed directly (docs-only, no code) rather than opening a PR for something this small.
- New branch `m4x-tuning-panel` off the now-synced `main`. Coordinator reread `branch.ts`/`blossom.ts`/`botanical.ts`/`palettes.ts`/`main.ts`/the geometry-determinism test to pin the exact refactor contract (which constants move where, which functions gain a `tuning` parameter, how the panel must interact with the existing palette-button mechanism) before spawning a builder — same "pin the contract first" pattern as M3/M4.
- One Sonnet builder implemented the full plan: `src/styles/botanical/tuning-config.ts` (new — `BotanicalTuningConfig` interface, `DEFAULT_BOTANICAL_TUNING_CONFIG`); threaded `tuning` through `branch.ts`'s `growthStepFor`/`wanderDeltaFor`/`computeTargetLength`/`computeShrinkDurationMs`/`computeColor`/`tickGrowing` and `blossom.ts`'s `spawnBlossomCluster`; `botanical.ts`'s `BotanicalState` gained a `tuning` field resolved once at renderer creation, replacing every remaining local-constant reference; `createBotanicalStyle`/`createBotanicalInternal` gained an optional `Partial<BotanicalTuningConfig>` parameter, zero-arg calls unaffected. Updated `branch.test.ts`/`blossom.test.ts`/`botanical.test.ts` call sites to pass `DEFAULT_BOTANICAL_TUNING_CONFIG` explicitly without changing any expected value.
- Same builder also built the panel in `main.ts`: a second `import.meta.env.DEV`-gated block (kept separate from the existing "Use sliders" block), collapsed by default behind a "Show tuning panel" toggle, 11 world-knob sliders (raw 0-1, seeded from the live/fresh `World`'s actual current `knob()` values) + 27 tuning-config sliders (ranged around each default), ~120ms debounced live-restart on drag, and an Export button serializing both objects to a read-only textarea. Added a documented override-precedence rule: touching any world-knob slider latches `manualOverridesActive`, after which the panel's own `WorldOverrides` fully replaces the palette-preset lookup in `startLiveLoop`; palette buttons from then on only pre-fill the panel's `hueBase`/`hueSpread` sliders rather than supplying a second, competing override.
- 2 new tests (160 total): zero-arg vs. explicit-default-arg equivalence, and one tuning-field override actually changing output (blossom radius).

**Deviations / decisions made, with reasoning:**
- See "Open deviations" above: `BotanicalTuningConfig` is a new, spec-unanticipated but dev-tooling-only concern — no fold expected.
- Debounced restart (120ms after last `input` event) rather than restarting on every drag tick or only on `change` (mouse-up) — chosen to keep dragging feeling live without spamming full-piece restarts on every pixel of motion; not founder-specified, a reasonable default given the panel's exploratory purpose.
- World-knob sliders always operate on a *fully-populated* `WorldOverrides` (all 11 keys) once the panel exists, rather than only overriding the specific knob touched — matches the existing palette-preset mechanism's own all-or-nothing override shape and avoids partial-override ambiguity.

**QA notes:**
- Coordinator independently reread every changed file (`tuning-config.ts`, `branch.ts`, `blossom.ts`, `botanical.ts`, `main.ts`) rather than trusting the builder's summary — confirmed `DEFAULT_BOTANICAL_TUNING_CONFIG`'s values are copied verbatim from the removed constants (checked each of the 27 fields against the pre-refactor file), confirmed every remaining constant reference in `botanical.ts` now reads `state.tuning.*`, and confirmed the panel's override-precedence rule is implemented as described (not just documented).
- Independently reran `lint`/`typecheck`/`test`/`build` (all green, 160/160 tests, including both Botanical determinism tests unmodified) rather than accepting the builder's reported output at face value.
- Independently grepped the built `dist/` bundle for panel-only strings (`Show tuning panel`, `ms-tuning-panel`, `manualOverridesActive`, `TUNING_RANGES`, `makeSliderRow`, etc.) — zero matches, confirming the dev gate is genuinely conditional, not coincidentally absent.
- Did not personally load the panel in a browser this session (no live-render verification, unlike Session 005's Playwright pass) — the panel's actual usability (slider layout, whether the debounce feels right, whether the export blob is easy to work with) is left for the founder's own live review, since that's the actual point of building it.

**Known issues added/resolved:**
- None.

**Next session should:**
1. Founder reviews/merges PR #5 (`m4x-tuning-panel` → `main`).
2. Use the panel live to work through the four tuning points from Session 005's "Founder live-review feedback" (too sparse, shrink too abrupt/not fading, only lower-half of canvas used, wander too spirally) — tune together since some points interact (e.g. slower wander + longer target length both affect how much canvas gets used), not one at a time.
3. Once the founder is happy, take their exported `{ worldOverrides, tuningConfig }` JSON blob and hardcode those values as the new defaults (`DEFAULT_BOTANICAL_TUNING_CONFIG` in `tuning-config.ts`, and the relevant palette/world-knob-range defaults) — then confirm the two Botanical determinism tests still pass (they use `FAST_LIFECYCLE_OVERRIDES`, which sets its own explicit overrides, so new defaults elsewhere shouldn't break them, but verify rather than assume).
4. After the founder confirms the tuning pass reads right, start M5 (sessions and saving) — building directly on `live-render-loop.ts`. Check the founder backlog (4th+ instantaneous input; stillness-speed jitter tuning) before proposing scope.

### Session 005 — 2026-08-20 — M4 Botanical

**Goal this session:** M4 in full, on branch `m4-botanical`. The first milestone with a genuinely creative, subjective scope — the spec calls it "where most of the project's total effort belongs... the experience MVP."

**Completed:**
- Founder approved PR #3 (M3) and it merged to main first. Coordinator explored the reusable engine/compositor/world API surface and the (empty) app-wiring state, then designed the noise module and Botanical's data model/lifecycle/movement-mapping/knob list via a Plan agent, reviewed it, and paused mid-plan when the founder said not to start until they sent a reference image.
- **Founder sent the actual reference image** (Holger Lippmann's *Recursive Tree X*), which sharpened the palette design (a single warm hue family, not free hue rotation — matches the reference's maroon-to-blush range) and confirmed branches should read as thin lines (rendered as a dense string of small circles along the growth path, not blobs) against a white canvas background.
- Mid-plan, founder asked for palette choice as a UI-facing feature (default + 2 curated presets, switchable, full custom color-wheel deferred) rather than a single seed-random hue — folded into the design before building (see "Open deviations" above).
- Coordinator pinned the full Botanical contract (data model, lifecycle state machine, exact movement-mapping formulas, the 11-knob list, the palette system) before spawning builders — the single highest-leverage risk reduction for a milestone this size, per the Plan agent's own recommendation.
- Two Sonnet builders in parallel: Builder A built the noise module (`src/shared/noise.ts`'s `createValueNoise1D` — lattice-hashed via the existing `cyrb53`, smoothstep-interpolated for continuity; `src/world/labeled-noise.ts`'s `createLabeledNoise`, mirroring `createLabeledStream`; extracted `combineSeedLabel` out of `labeled-stream.ts` so both share identical separator logic). Builder B built the entire Botanical style (`src/styles/botanical/`) — `branch.ts`/`blossom.ts` hold pure, independently-tested growth/wander/lifecycle/spawn math; `botanical.ts` wires it into the `StyleRenderer` interface, owning the mutable active-branch/blossom lists; `palettes.ts` holds the 3 preset override bundles.
- Coordinator then built the integration layer inline (kept cost down rather than spawning a third builder, per the session's cost-consciousness guidance): `src/app/user-identity.ts` (locally-stored persisted userId, spec Part 3), `src/app/live-render-loop.ts` (the invariant-4 live-session unification — see "Open deviations"), `main.ts` wiring (a `<canvas>`, real `World` construction from the persisted userId + today's date, 3 palette-switcher buttons), and two new engine-level determinism tests (`botanical-geometry-determinism.test.ts`, `botanical-pixel-determinism.test.ts`) mirroring M3's placeholder-style versions with the real style, using `World` overrides to force a full growing→mature→shrinking→resprout cycle within a reasonable test duration.
- 39 new unit tests (158 total).

**Deviations / decisions made, with reasoning:**
- See "Open deviations" above: `World`'s knob vocabulary stays per-style rather than shared; the accumulate-vs-redraw tension resolved via style-internal state rather than real per-layer canvas buffering; palette choice promoted to a founder-facing UI feature; live-session/replay unification built now instead of in M5.
- Sub-branch spawn produces exactly 1 child per successful roll (spec's design allowed "1-2, your choice, document it") — kept simple for a first pass.
- `MAX_GENERATION=4`, `SPEED_FLOOR=0.06`, and all other internal tuning constants (growth scale, shrink rate, wander/blossom ranges, color saturation/lightness formula constants) are explicit first-pass values, individually documented at their definition in `branch.ts`/`blossom.ts`/`botanical.ts` — expected to change during the live-tuning pass below, not locked.
- Palette knobs (`hueBase`/`hueSpread`) replaced an earlier single-continuous-hue design specifically so presets could compose with `World`'s existing per-knob override mechanism with zero new World code — a preset is just a named `WorldOverrides` bundle.

**QA notes:**
- Coordinator independently reread every crux file (`branch.ts`, `botanical.ts`, `blossom.ts`, `palettes.ts`) rather than trusting builder summaries — confirmed the growth formula is genuinely noise-free (invariant 6), the compositor's own z-based fade is never double-applied by the style, and no `Math.random`/`Date.now`/`performance.now` appears anywhere in `src/styles/botanical/` (one grep hit was a comment, not real usage).
- Independently reran `lint`/`typecheck`/`test`/`build` after writing the integration layer (all green, 158/158 tests) — hit one real structural-typing issue (`CanvasRenderingContext2D.fillStyle` is a union type, not a bare `string`, same quirk M3's pixel-determinism test already worked around) and fixed it with the same cast pattern at the `main.ts` call site.
- **Ran the app live** via a Playwright-driven headless Chromium session (no project run-skill existed yet for this app — installed Playwright to the scratchpad, not the project, for a one-off verification): started the slider adapter, maxed expansion/speed, watched real branch growth and blossom clusters render over ~20 real seconds, confirmed all 3 palette buttons genuinely recolor a fresh piece, zero console errors throughout.
- Visual assessment: the architecture works end-to-end, but branch density reads sparser and blossom clusters read denser/more opaque than the reference — expected given every numeric constant is a first-pass guess, not a finding that anything is broken.

**Known issues added/resolved:**
- None (the visual tuning gap above is expected, not a bug — tracked via the live-tuning pass below, not as a defect).

**Founder live-review feedback (2026-08-20, PR #4 approved for merge, tuning requested before next session):** founder watched it run and gave four concrete, specific notes — capturing verbatim/close-to-verbatim since these are the actual tuning targets, not the coordinator's own guesses:
1. **"Way too sparse."** Confirms the handoff's own prediction — bump `rootCount`'s mapped range and/or `MAX_GENERATION` (`src/styles/botanical/branch.ts`) and/or `subBranchSpawnChance`'s mapped range so more concurrent branches are visible. Check `branchDensity`'s mapped range (`maxConcurrentBranches`, currently 8-40) isn't the actual bottleneck before just raising root count.
2. **"Not disappearing is way too obvious."** The shrink/retraction (`visibleSegmentCount` in `branch.ts`, driven by `shrinkProgress`) reads as an abrupt vanish rather than a graceful fade. Consider: slowing `SHRINK_RATE` further, adding an opacity fade to branch segments during shrink (currently only blossoms fade — branch segments stay at constant `BRANCH_BASE_OPACITY` the whole time per `botanical.ts`'s `buildScene`, only their *count* shrinks), or shrinking from both ends rather than tip-only.
3. **"Only the lower half of the canvas is being used."** Root points spawn at `y` in `[0.7, 1.0)` (`ROOT_Y_MIN`/`ROOT_Y_SPAN` in `botanical.ts`) growing toward `-π/2` (up), but branches aren't reaching the upper half in practice — likely `TARGET_LENGTH_BASE` (0.35, `branch.ts`) is too short relative to the 0.7-1.0 starting band to reach the top, or growth pace is too slow to get there within a typical viewing window. Check both.
4. **"Too spirally — looks like a child's doodle."** Wander is over-amplified relative to how it should read (spec wants "long graceful sweeping curves," not tight spirals). Check `WANDER_AMPLITUDE_MIN`/`SPAN` (`botanical.ts`) and the noise-sampling scale in the wander formula (`wanderDeltaFor` in `branch.ts` — noise is sampled by `branch.grownLength`; if the noise function's effective "wavelength" in grown-length units is too short, direction changes too fast per unit grown, producing spirals instead of sweeps — may need to scale `grownLength` down before passing it to `createLabeledNoise(...)(...)` so noise varies more slowly per unit of actual growth).

Founder is merging PR #4 as-is (the architecture works, tuning is expected next) and heading offline — **do not wait for further approval to start this tuning pass**, it's already requested.

**Founder's follow-up idea (same session, before signing off): build a dev-only "backend knobs" tuning panel, so tuning happens by dragging sliders and looking, not by guessing numbers and rebuilding.** Explicitly pre-approved as the first task next session (planning it now, building it next session — no new plan-and-approve cycle needed for this either). Two distinct dev tools, not to be conflated in the UI or in explaining them to the founder:

1. **Existing, unchanged: the input-simulation sliders** (`src/adapters/sliders/`, "Use sliders" button in `main.ts`, dev-gated via `import.meta.env.DEV`). These fake `MovementParams` (expansion/speed/symmetry) as if they came from the webcam — they simulate the *input*, and the founder explicitly wants them left exactly as they are.
2. **New: a "backend knobs" panel** — a second, separate dev-gated panel controlling how Botanical turns that input into art (the generative "physics"/character), not the input itself. Two categories of knobs to expose:
   - **Already-overridable world knobs** (all 11 in `worldKnobs()` — `hueBase`, `hueSpread`, `branchDensity`, `baseGrowthRate`, `matureDurationMs`, `windAngle`, `rootCount`, `branchSpreadBase`, `wanderAmplitudeBase`, `blossomsPerCluster`, `subBranchSpawnChance`): wire a slider per knob to a live `WorldOverrides` object, restarting the live loop with the new overrides on change — exactly the mechanism the palette buttons in `main.ts` already use, just generalized to per-knob sliders instead of 3 fixed presets.
   - **Currently-hardcoded internal constants** (not wired through `World` at all — `MAX_GENERATION`, `SPEED_FLOOR`, `SYMMETRY_DAMPING`, `WIND_STRENGTH`, `SHRINK_RATE`, `BASE_GROWTH_SCALE`, `TARGET_LENGTH_BASE`, `TARGET_LENGTH_JITTER_SPAN`, `GENERATION_LENGTH_DECAY`, `BRANCH_SEGMENT_RADIUS`, `BRANCH_BASE_OPACITY`, the `MAX_SAT`/`SAT_FALLOFF`/`MIN_LIGHT`/`LIGHT_RISE` color constants, `ROOT_Y_MIN`/`ROOT_Y_SPAN`, `ROOT_BASE_DIRECTION_SPREAD`, `CHILD_Z_JITTER`, `CHILD_HUE_JITTER_DEGREES` in `branch.ts`/`botanical.ts`, plus `BLOSSOM_RADIUS_MIN`/`SPAN`, `BLOSSOM_OPACITY_MIN`/`SPAN`, `BLOSSOM_JITTER_MAX`, `BLOSSOM_HUE_JITTER_DEGREES`, `BLOSSOM_Z_JITTER` in `blossom.ts`). These need a small refactor: introduce a `BotanicalTuningConfig` type (defaults = current hardcoded values) that `createBotanicalStyle(tuning?: Partial<BotanicalTuningConfig>)` accepts and threads through to `branch.ts`/`blossom.ts`'s functions instead of reading module-level constants directly. This keeps `World`/knob semantics clean (knobs stay "the day's seeded personality + style choices"; tuning config is "engineering calibration," a style-internal concern) and gives the dev panel one clean object to expose sliders for.
   - **Design note for whoever implements this**: some of these only take effect for branches spawned *after* the change (e.g. `TARGET_LENGTH_BASE`, `ROOT_Y_MIN` — spawn-time values baked into already-growing branches), while others apply to every tick going forward (e.g. `SHRINK_RATE`, wander amplitude). Decide whether every slider change restarts the whole piece (simple, matches how palette switching already works, but loses in-progress growth) or only some do — worth deciding once actually building it, not blocking the plan here.
3. **"The blob to paste back" — an Export mechanism in the new panel**: a button that serializes the currently-applied `WorldOverrides` values plus the current `BotanicalTuningConfig` values into one JSON object, shown in a read-only textarea (or copied to clipboard) for the founder to copy and paste back into chat. The coordinator then hardcodes those exact values as the new defaults in `palettes.ts`-adjacent world-knob ranges and the `BotanicalTuningConfig` defaults, replacing the current first-pass guesses — this is the actual mechanism for locking in a tuning session's results.

**Next session should:**
1. **Build the backend-knobs tuning panel first** (the plan above) — this is the tool the tuning pass will actually be done with, not a nice-to-have alongside it.
2. **Then use it to work through the four tuning points already recorded above** (too sparse, shrink too abrupt, only using the lower half of the canvas, too spirally) — iterate live via the new panel rather than guessing fixes blind. Some points interact (e.g. slower wander + longer target length both increase how much of the canvas gets used), so tune together, not independently, before treating any one point as "done."
3. Once the founder is happy and sends back an exported knob-config blob, lock those values in as the new code defaults, then confirm the two Botanical determinism tests (`src/engine/botanical-*-determinism.test.ts`) still pass unmodified (they don't hardcode these constants directly, but their `FAST_LIFECYCLE_OVERRIDES` fixture assumes certain knob ranges — verify, don't assume).
- After the founder confirms the tuning pass reads right, start M5 (sessions and saving): proper session start/end UI, recipe persistence to IndexedDB, image export, recipe export/import, session-level parameter derivation — building directly on `live-render-loop.ts` rather than re-deriving live-tick-pump logic. Check the founder backlog (4th+ instantaneous input; stillness-speed jitter tuning) before proposing scope.

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

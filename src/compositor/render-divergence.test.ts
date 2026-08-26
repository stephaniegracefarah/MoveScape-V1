/**
 * Committed pixel-divergence regression test (docs/HANDOFF.md, session 019's
 * investigation): asserts the live incremental compositor produces pixels
 * IDENTICAL to the per-bucket reference renderer at every checkpoint, across
 * several seeds, under realistic movement pacing plus a
 * FAST_CYCLE_OVERRIDES-style stress scenario -- see render-divergence-
 * harness.ts's own doc comment for the full method (session 018's proven
 * technique, now a committed, reusable tool instead of an ad hoc script
 * rebuilt from scratch every time this bug class is suspected).
 *
 * STATUS AS OF THE 2026-08-23 FOUNDER-DECISION SESSION: the harness's
 * reference renderer was realigned to paint in the SAME fixed bucket order
 * (echo1 -> echo0 -> foreground) the live compositor uses, per the founder's
 * decision that this ordering is the intended look, not a bug (see
 * render-divergence-harness.ts's own top doc comment and live-compositor.ts's
 * BUCKET_PAINT_ORDER comment). That realignment eliminated the ~4-6k px
 * "cross-bucket z-overlap" divergence this test used to report structurally
 * (confirmed: the divergence documented below has a DIFFERENT signature --
 * small onset, growing over tens of seconds, localized to blossom-dense
 * regions -- not the broad, near-immediate divergence the old global-z-sort
 * reference produced).
 *
 * STILL RED, for a real, DIFFERENT, and already partly self-documented
 * reason: re-running all 4 scenarios after the realignment (all 3 realistic
 * seeds plus the stress scenario) still shows non-zero, GROWING divergence
 * -- e.g. seed div-regress-1: 308px at 15.0s growing to ~22.6k px by 60s;
 * div-regress-2: 359px at 27.0s growing to ~5.6k px by 60s; div-regress-3:
 * 8px at 21.0s growing to ~4.1k px by 60s; the stress scenario: 26px at 7.0s
 * growing to ~5.7k px by 25s. Traced (render-divergence-harness.ts's
 * traceElementsNear + runPermanenceOracleScenario) to a SEPARATE, PRE-
 * EXISTING gap already called out in botanical.ts's own doc comment
 * (resolveBucketBakeThreats, "BLOSSOMS TOO" section, session 021): a
 * revealed blossom's bake safety is checked against other content's
 * threats, but a blossom, once resolved and baked, is never itself ADDED to
 * the threat list other unresolved content (branches or later blossoms)
 * checks against -- so a farther-z branch/blossom can still bake AFTER an
 * already-baked nearer blossom and get drawn on top of it in the wrong
 * order. The permanence oracle found zero whole-segment "vanish" events in
 * the same window (content replaced by bare paper) -- consistent with this
 * being a content-OVER-content overwrite (a mispainted stacking order, both
 * layers still dark/content-colored), which that oracle is not designed to
 * catch, not a contradiction of the finding. NOT fixed here -- out of this
 * session's scope (Task 1 was harness alignment only, not new compositor
 * fixes) -- reported per the investigation brief instead of being papered
 * over with a tolerance/threshold.
 *
 * Still gated behind the RENDER_DIVERGENCE=1 env var (not a permanent
 * .skip) so the default `npm test` run stays green while this remains
 * unresolved:
 *
 *   RENDER_DIVERGENCE=1 npx vitest run src/compositor/render-divergence.test.ts
 *
 * Un-gate this (drop the RUN indirection below, always use `describe`) in
 * the SAME PR that lands a fix for the blossom-threat gap above -- this
 * test passing is meant to be that fix's own acceptance criterion.
 */
import { describe, expect, it } from 'vitest';
import type { WorldOverrides } from '../world/world';
import { createRealisticMovementScript, runDivergenceScenario } from './render-divergence-harness';

/**
 * This project has no @types/node dependency (src/ is otherwise browser-
 * only code) -- `process.env` is declared locally, narrowly, just for this
 * one env-var gate, the same reasoning render-divergence-harness.ts's own
 * local `require` declaration uses.
 */
declare const process: { env: Record<string, string | undefined> };

// Copied verbatim from src/styles/botanical/botanical.test.ts:109-112 -- raw
// WORLD-KNOB overrides (not BotanicalTuningConfig fields; baseGrowthRate/
// matureDurationMs here are the 0-1 knob inputs botanical.ts's initState
// maps through GROWTH_RATE_MIN/SPAN and MATURE_DURATION_MIN/SPAN), the same
// "instant"-ish maturity / fast-growth tuning session 018 used to find its
// own residual, not-yet-fully-traced divergence.
const FAST_CYCLE_OVERRIDES: WorldOverrides = {
  baseGrowthRate: 0.99,
  matureDurationMs: 0,
};

// Kept modest (a handful of seeds, tens of simulated seconds) so opting in
// via RENDER_DIVERGENCE=1 stays a reasonable local/CI cost once this is
// unskipped as a standing regression guard -- the full multi-minute,
// 6+-seed diagnostic sweep this test's harness was built for lives in this
// branch's own session log (docs/HANDOFF.md), not here.
const REALISTIC_SEEDS = ['div-regress-1', 'div-regress-2', 'div-regress-3'];

const RUN = process.env.RENDER_DIVERGENCE === '1' ? describe : describe.skip;

RUN('live compositor vs renderScene() -- pixel divergence (docs/HANDOFF.md)', () => {
  it.each(REALISTIC_SEEDS)(
    'produces zero divergent pixels at every checkpoint under realistic movement pacing (seed=%s)',
    (seed) => {
      const result = runDivergenceScenario({
        seed,
        worldOverrides: { rootCount: 0.5 }, // -> state.rootCount = 2, the known cross-root/cross-branch trigger
        totalTicks: 3600, // 60 simulated seconds
        checkpointIntervalTicks: 60, // once per simulated second
        fixedHeightPx: 240,
        movementScript: createRealisticMovementScript(),
      });

      const divergent = result.checkpoints.filter((c) => c.diffPixelCount > 0);
      const first = divergent[0];
      expect(
        divergent,
        first
          ? `first divergence at tick ${first.tick} (${(first.tick / 60).toFixed(1)}s): ` +
            `${first.diffPixelCount} px, bbox(world)=${JSON.stringify(first.bboxWorld)}`
          : undefined,
      ).toEqual([]);
    },
    60000,
  );

  it(
    'produces zero divergent pixels under FAST_CYCLE_OVERRIDES-style stress tuning',
    () => {
      const result = runDivergenceScenario({
        seed: 'div-regress-stress',
        worldOverrides: FAST_CYCLE_OVERRIDES,
        totalTicks: 1500, // 25 simulated seconds -- fast-cycle tuning matures branches far quicker than realistic tuning
        checkpointIntervalTicks: 30,
        fixedHeightPx: 240,
        movementScript: createRealisticMovementScript(),
      });

      const divergent = result.checkpoints.filter((c) => c.diffPixelCount > 0);
      expect(divergent).toEqual([]);
    },
    60000,
  );
});

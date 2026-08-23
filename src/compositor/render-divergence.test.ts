/**
 * Committed pixel-divergence regression test (docs/HANDOFF.md, session 019's
 * investigation): asserts the live incremental compositor produces pixels
 * IDENTICAL to the old, correct-by-construction renderScene() at every
 * checkpoint, across several seeds, under realistic movement pacing plus a
 * FAST_CYCLE_OVERRIDES-style stress scenario -- see render-divergence-
 * harness.ts's own doc comment for the full method (session 018's proven
 * technique, now a committed, reusable tool instead of an ad hoc script
 * rebuilt from scratch every time this bug class is suspected).
 *
 * RED ON PURPOSE, right now: at this branch's current tip
 * (fix-cross-root-bake-order), this test FAILS. Session 019's diagnostic
 * sweep (docs/HANDOFF.md) found real, growing, non-self-healing divergence
 * starting a few simulated seconds into a realistic session (default
 * tuning, rootCount forced to 2) -- confirming the founder's still-open
 * "still happening" report is a real, currently-unfixed bug, not a
 * synthetic-stress-only artifact. Gated behind the RENDER_DIVERGENCE=1 env
 * var (not a permanent .skip) so the default `npm test` run stays green
 * while this remains unresolved:
 *
 *   RENDER_DIVERGENCE=1 npx vitest run src/compositor/render-divergence.test.ts
 *
 * Un-gate this (drop the RUN indirection below, always use `describe`) in
 * the SAME PR that lands the actual fix -- this test passing is meant to be
 * the fix's own acceptance criterion, not a side observation collected
 * after the fact.
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

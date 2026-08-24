/**
 * SCRATCH, NOT COMMITTED (delete after use) -- runs the permanence oracle
 * (whole-segment vanish detector) for seed div-regress-1 over the same
 * window that render-divergence found its first residual divergence (tick
 * 899 / 15s), to see if a concrete vanish/overwrite event corroborates the
 * "revealed blossoms never threaten other content" gap documented in
 * botanical.ts (resolveBucketBakeThreats' own doc comment, lines ~580-588).
 */
import { describe, it } from 'vitest';
import { createRealisticMovementScript, runPermanenceOracleScenario } from './render-divergence-harness';

describe('oracle trace (scratch)', () => {
  it(
    'looks for vanish events near the first render-divergence checkpoint',
    () => {
      const result = runPermanenceOracleScenario({
        seed: 'div-regress-1',
        worldOverrides: { rootCount: 0.5 },
        totalTicks: 1000,
        fixedHeightPx: 240,
        movementScript: createRealisticMovementScript(),
      });

      // eslint-disable-next-line no-console
      console.log(`total events: ${result.events.length}`);
      for (const event of result.events) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              tick: event.tick,
              timeMs: event.timeMs,
              pixelCount: event.pixelCount,
              bboxPx: event.bboxPx,
              elements: event.elements.map((e) => ({
                layerId: e.layerId,
                bucket: e.bucket,
                kind: e.kind,
                kindIndex: e.kindIndex,
                id: e.id,
                z: e.z,
                lifecycle: e.lifecycle,
                finalInScene: e.finalInScene,
                bakeResolvedInState: e.bakeResolvedInState,
                bakedAccordingToCompositor: e.bakedAccordingToCompositor,
                flippedFinalThisTick: e.flippedFinalThisTick,
              })),
            },
            null,
            2,
          ),
        );
      }
    },
    180000,
  );
});

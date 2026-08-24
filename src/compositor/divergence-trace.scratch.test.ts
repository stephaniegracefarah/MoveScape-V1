/**
 * SCRATCH, NOT COMMITTED (delete after use) -- traces the first divergent
 * checkpoint found by the bucket-aligned render-divergence harness for seed
 * div-regress-1 (first divergence at tick 899 / 15.0s, 308px,
 * bbox(world)={minX:-0.0625, minY:0.325, maxX:0.7833, maxY:0.6875}).
 */
import { describe, it } from 'vitest';
import { createRealisticMovementScript, runDivergenceScenario } from './render-divergence-harness';

describe('trace first divergence (scratch)', () => {
  it(
    'dumps trace evidence for seed div-regress-1',
    () => {
      const result = runDivergenceScenario({
        seed: 'div-regress-1',
        worldOverrides: { rootCount: 0.5 },
        totalTicks: 960,
        checkpointIntervalTicks: 60,
        fixedHeightPx: 240,
        movementScript: createRealisticMovementScript(),
      });

      // eslint-disable-next-line no-console
      console.log('firstDivergence:', JSON.stringify(result.firstDivergence, null, 2));
      // eslint-disable-next-line no-console
      console.log('zRangesAtFirstDivergence:', JSON.stringify(result.zRangesAtFirstDivergence, null, 2));
      // eslint-disable-next-line no-console
      console.log('traceAtFirstDivergence:', JSON.stringify(result.traceAtFirstDivergence, null, 2));
    },
    120000,
  );
});

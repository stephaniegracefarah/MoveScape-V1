import { describe, expect, it } from 'vitest';
import type { MovementParams } from '../../adapters/movement-params';
import type { MechanismSample } from '../../styles/style-renderer';
import {
  annotateFunctionSource,
  buildMagicView,
  formatMagicNumber,
  magicCodeHeader,
} from './magic-panel';

const PARAMS: MovementParams = { v: 1, expansion: 0.62, speed: 0.41, symmetry: 0.88 };

const FAKE_SOURCE = [
  'export function fakeFn(args: {',
  '  dt: number;',
  '  speed: number;',
  '}): number {',
  '  return args.dt * args.speed;',
  '}',
].join('\n');

const FAKE_SOURCES = { 'fake.ts': FAKE_SOURCE };

function fakeSample(): MechanismSample {
  return {
    functions: [
      {
        tabLabel: 'speed → growth',
        sourceFunctionName: 'fakeFn',
        sourceModule: 'fake.ts',
        args: { dt: 16.666, speed: 0.41 },
        result: 6.833,
      },
      {
        tabLabel: 'expansion + symmetry → wander',
        sourceFunctionName: 'fakeFn',
        sourceModule: 'fake.ts',
        args: { dt: 8, speed: 0.1 },
        result: 0.00035,
      },
    ],
  };
}

describe('formatMagicNumber', () => {
  it('keeps ~4 significant figures and trims trailing zeros', () => {
    expect(formatMagicNumber(16.666)).toBe('16.67');
    expect(formatMagicNumber(0.41)).toBe('0.41');
    expect(formatMagicNumber(0.00005)).toBe('0.00005');
    expect(formatMagicNumber(0.00035)).toBe('0.00035');
    expect(formatMagicNumber(0.0003499)).toBe('0.0003499'); // 4 sig figs, not rounded to 0.00035
    expect(formatMagicNumber(0)).toBe('0');
    expect(formatMagicNumber(-0.0002100000001)).toBe('-0.00021');
  });
});

describe('annotateFunctionSource', () => {
  it('appends aligned // value notes to parameter lines and a final result line', () => {
    const out = annotateFunctionSource(FAKE_SOURCE, fakeSample().functions[0]!);
    expect(out).toMatch(/ {2}dt: number;\s+\/\/ 16\.67/);
    expect(out).toMatch(/ {2}speed: number;\s+\/\/ 0\.41/);
    expect(out.trimEnd().endsWith('→ 6.833')).toBe(true);
    // Body itself is still verbatim (the return line is untouched).
    expect(out).toContain('  return args.dt * args.speed;');
  });
});

describe('magicCodeHeader', () => {
  it('reads "<module> : <fn>()"', () => {
    expect(magicCodeHeader(fakeSample().functions[0]!)).toBe('fake.ts : fakeFn()');
  });
});

describe('buildMagicView', () => {
  it('is a warming-up view with no code but a live readout when there is no sample', () => {
    const view = buildMagicView(null, PARAMS, 0, FAKE_SOURCES);
    expect(view.warmingUp).toBe(true);
    expect(view.tabs).toEqual([]);
    expect(view.codeHeader).toBeNull();
    expect(view.codeBody).toBeNull();
    expect(view.readout.map((r) => `${r.label} ${r.value} ${r.barWidth}`)).toEqual([
      'Expansion 0.62 62.0%',
      'Speed 0.41 41.0%',
      'Symmetry 0.88 88.0%',
    ]);
  });

  it('shows the first tab active with its function source by default', () => {
    const view = buildMagicView(fakeSample(), PARAMS, 0, FAKE_SOURCES);
    expect(view.warmingUp).toBe(false);
    expect(view.tabs).toEqual([
      { label: 'speed → growth', active: true },
      { label: 'expansion + symmetry → wander', active: false },
    ]);
    expect(view.codeHeader).toBe('fake.ts : fakeFn()');
    expect(view.codeBody).toMatch(/\/\/ 16\.67/);
    expect(view.codeBody).toMatch(/→ 6\.833$/);
  });

  it('switches the active tab and the annotated values with activeTabIndex', () => {
    const view = buildMagicView(fakeSample(), PARAMS, 1, FAKE_SOURCES);
    expect(view.tabs[0]!.active).toBe(false);
    expect(view.tabs[1]!.active).toBe(true);
    expect(view.codeBody).toMatch(/\/\/ 8\b/);
    expect(view.codeBody).toMatch(/→ 0\.00035$/);
  });

  it('clamps an out-of-range activeTabIndex to a real tab', () => {
    const view = buildMagicView(fakeSample(), PARAMS, 99, FAKE_SOURCES);
    expect(view.tabs[1]!.active).toBe(true);
  });

  it('degrades to a message when the source module is not in the map', () => {
    const view = buildMagicView(fakeSample(), PARAMS, 0, {});
    expect(view.codeBody).toBe('(source unavailable for fake.ts)');
  });

  it('resolves real branch.ts source through the default source map', () => {
    const sample: MechanismSample = {
      functions: [
        {
          tabLabel: 'speed → growth',
          sourceFunctionName: 'growthStepFor',
          sourceModule: 'branch.ts',
          args: { dt: 16.667, speed: 0.41, baseGrowthPerTick: 0.00005 },
          result: 0.00035,
        },
      ],
    };
    const view = buildMagicView(sample, PARAMS, 0);
    expect(view.codeHeader).toBe('branch.ts : growthStepFor()');
    expect(view.codeBody).toContain('export function growthStepFor(args: {');
    expect(view.codeBody).toMatch(/dt: number;\s+\/\/ 16\.67/);
    expect(view.codeBody).toMatch(/speed: number;\s+\/\/ 0\.41/);
    expect(view.codeBody).toMatch(/baseGrowthPerTick: number;\s+\/\/ 0\.00005/);
    expect(view.codeBody).toMatch(/→ 0\.00035$/);
  });
});

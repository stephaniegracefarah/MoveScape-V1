import { describe, expect, it } from 'vitest';
import { createLabeledStream } from './labeled-stream';
import { createWorld } from './world';

describe('createWorld — same-seed identity', () => {
  it('two worlds built from identical inputs produce identical knob values', () => {
    const a = createWorld('worldSeed-1', 0);
    const b = createWorld('worldSeed-1', 0);
    for (const name of ['paletteHue', 'windAngle', 'density']) {
      expect(a.knob(name)).toBe(b.knob(name));
    }
  });

  it('two worlds built from identical inputs including overrides agree', () => {
    const overrides = { paletteHue: 0.3 };
    const a = createWorld('worldSeed-1', 0, overrides);
    const b = createWorld('worldSeed-1', 0, overrides);
    for (const name of ['paletteHue', 'windAngle']) {
      expect(a.knob(name)).toBe(b.knob(name));
    }
  });

  it('calling knob() twice on the same instance returns the same value', () => {
    const world = createWorld('worldSeed-1', 0);
    const first = world.knob('paletteHue');
    const second = world.knob('paletteHue');
    expect(first).toBe(second);
  });
});

describe('createWorld — session-index variation', () => {
  it('world-level knobs are identical across sessions sharing a worldSeed', () => {
    const a = createWorld('worldSeed-1', 0);
    const b = createWorld('worldSeed-1', 1);
    for (const name of ['paletteHue', 'windAngle', 'density']) {
      expect(a.knob(name)).toBe(b.knob(name));
    }
  });

  it('sessionSeed differs across session indices', () => {
    const a = createWorld('worldSeed-1', 0);
    const b = createWorld('worldSeed-1', 1);
    expect(a.sessionSeed).not.toBe(b.sessionSeed);
  });

  it('a stream built from each world sessionSeed differs -- this is where sibling-session variation shows up', () => {
    const a = createWorld('worldSeed-1', 0);
    const b = createWorld('worldSeed-1', 1);
    const jitterA = createLabeledStream(a.sessionSeed, 'jitter')();
    const jitterB = createLabeledStream(b.sessionSeed, 'jitter')();
    expect(jitterA).not.toBe(jitterB);
  });
});

describe('createWorld — override precedence', () => {
  it('an override returns exactly the overridden value', () => {
    const world = createWorld('worldSeed-1', 0, { paletteHue: 0.42 });
    expect(world.knob('paletteHue')).toBe(0.42);
  });

  it('a sibling world without overrides gets a different seed-derived value', () => {
    const overridden = createWorld('worldSeed-1', 0, { paletteHue: 0.42 });
    const plain = createWorld('worldSeed-1', 0);
    expect(overridden.knob('paletteHue')).not.toBe(plain.knob('paletteHue'));
  });

  it('overriding one knob leaves an unrelated knob unchanged (precedence is scoped per-name)', () => {
    const overridden = createWorld('worldSeed-1', 0, { paletteHue: 0.42 });
    const plain = createWorld('worldSeed-1', 0);
    expect(overridden.knob('windAngle')).toBe(plain.knob('windAngle'));
  });
});

describe('createWorld — knob-stream independence', () => {
  it('a knob value never depends on read order or what else was read first', () => {
    const seed = 'worldSeed-1';

    const instance1 = createWorld(seed, 0);
    const aFrom1 = instance1.knob('a');
    const bFrom1 = instance1.knob('b');

    // Instance 2 reads a different, previously-unread knob ('c') first.
    const instance2 = createWorld(seed, 0);
    instance2.knob('c');
    const aFrom2 = instance2.knob('a');
    const bFrom2 = instance2.knob('b');

    expect(aFrom2).toBe(aFrom1);
    expect(bFrom2).toBe(bFrom1);

    // Instance 3 reads b, then c, then a.
    const instance3 = createWorld(seed, 0);
    const bFrom3 = instance3.knob('b');
    instance3.knob('c');
    const aFrom3 = instance3.knob('a');

    // Instance 4 reads c, then a, then b -- yet another order.
    const instance4 = createWorld(seed, 0);
    instance4.knob('c');
    const aFrom4 = instance4.knob('a');
    const bFrom4 = instance4.knob('b');

    expect(aFrom3).toBe(aFrom1);
    expect(bFrom3).toBe(bFrom1);
    expect(aFrom4).toBe(aFrom1);
    expect(bFrom4).toBe(bFrom1);
  });
});

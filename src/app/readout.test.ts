import { describe, expect, it } from 'vitest';
import { clampDisplayUnit, formatBarWidth, formatParamValue } from './readout';

describe('clampDisplayUnit', () => {
  it('passes through in-range values', () => {
    expect(clampDisplayUnit(0)).toBe(0);
    expect(clampDisplayUnit(0.42)).toBe(0.42);
    expect(clampDisplayUnit(1)).toBe(1);
  });

  it('clamps out-of-range and NaN values', () => {
    expect(clampDisplayUnit(-0.5)).toBe(0);
    expect(clampDisplayUnit(1.5)).toBe(1);
    expect(clampDisplayUnit(Number.NaN)).toBe(0);
  });
});

describe('formatParamValue', () => {
  it('formats to two decimal places', () => {
    expect(formatParamValue(0)).toBe('0.00');
    expect(formatParamValue(0.5)).toBe('0.50');
    expect(formatParamValue(1)).toBe('1.00');
    expect(formatParamValue(0.123)).toBe('0.12');
  });

  it('clamps before formatting', () => {
    expect(formatParamValue(-1)).toBe('0.00');
    expect(formatParamValue(2)).toBe('1.00');
  });
});

describe('formatBarWidth', () => {
  it('formats as a CSS percentage string', () => {
    expect(formatBarWidth(0)).toBe('0.0%');
    expect(formatBarWidth(0.5)).toBe('50.0%');
    expect(formatBarWidth(1)).toBe('100.0%');
  });

  it('clamps before formatting', () => {
    expect(formatBarWidth(-1)).toBe('0.0%');
    expect(formatBarWidth(1.2)).toBe('100.0%');
  });
});

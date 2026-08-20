import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSliderAdapter, SLIDER_PANEL_MARKER, type MinimalDocument } from './index';
import { MOVEMENT_PARAMS_VERSION, type MovementParams } from '../movement-params';

const SAMPLE_PERIOD = 1000 / 30;

/**
 * A minimal in-memory stand-in for the DOM, just enough to exercise the
 * slider adapter's emission logic without a real browser or jsdom (neither
 * is available in this project's Node-only test environment). Real
 * `document` satisfies the same `MinimalDocument` interface in production.
 */
interface FakeElement {
  tagName: string;
  id: string;
  style: { cssText: string };
  value: string;
  children: FakeElement[];
  removed: boolean;
  appendChild(child: FakeElement): void;
  remove(): void;
  [key: string]: unknown;
}

function createFakeElement(tagName: string): FakeElement {
  const el: FakeElement = {
    tagName,
    id: '',
    style: { cssText: '' },
    value: '',
    children: [],
    removed: false,
    appendChild(child: FakeElement) {
      el.children.push(child);
    },
    remove() {
      el.removed = true;
    },
  };
  return el;
}

function createFakeDocument(): { doc: MinimalDocument; body: FakeElement; inputs: FakeElement[] } {
  const body = createFakeElement('body');
  const inputs: FakeElement[] = [];
  const doc: MinimalDocument = {
    createElement: (tagName: string) => {
      const el = createFakeElement(tagName);
      if (tagName === 'input') inputs.push(el);
      return el as unknown as HTMLElement;
    },
    body: {
      appendChild: (node: HTMLElement) => {
        body.appendChild(node as unknown as FakeElement);
      },
    },
  };
  return { doc, body, inputs };
}

describe('createSliderAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mounts a panel identified by the dev-only marker id', async () => {
    const { doc, body } = createFakeDocument();
    const adapter = createSliderAdapter(doc);
    await adapter.start(() => {});
    expect(body.children).toHaveLength(1);
    expect(body.children[0]?.id).toBe(SLIDER_PANEL_MARKER);
    adapter.stop();
  });

  it('emits MovementParams samples on a steady ~30 Hz timer', async () => {
    const { doc } = createFakeDocument();
    const adapter = createSliderAdapter(doc);
    const samples: { params: MovementParams; t: number }[] = [];

    await adapter.start((params, t) => samples.push({ params, t }));
    expect(samples).toHaveLength(0);

    vi.advanceTimersByTime(100); // ~3 ticks at 30 Hz (33.33ms period)
    expect(samples.length).toBeGreaterThanOrEqual(2);

    const first = samples[0];
    expect(first).toBeDefined();
    expect(first?.params.v).toBe(MOVEMENT_PARAMS_VERSION);
    expect(first?.params.expansion).toBeCloseTo(0.3);
    expect(first?.params.speed).toBeCloseTo(0.1);
    expect(first?.params.symmetry).toBeCloseTo(0.8);
    expect(typeof first?.t).toBe('number');

    adapter.stop();
  });

  it('reflects updated slider values on the next tick', async () => {
    const { doc, inputs } = createFakeDocument();
    const adapter = createSliderAdapter(doc);
    const samples: MovementParams[] = [];

    await adapter.start((params) => samples.push(params));

    // Creation order matches SLIDER_CONFIGS: expansion, speed, symmetry.
    const speedInput = inputs[1];
    expect(speedInput).toBeDefined();
    if (speedInput) speedInput.value = '0.92';

    vi.advanceTimersByTime(SAMPLE_PERIOD);
    const last = samples.at(-1);
    expect(last).toBeDefined();
    expect(last?.speed).toBeCloseTo(0.92);

    adapter.stop();
  });

  it('stop() clears the timer and removes the panel', async () => {
    const { doc, body } = createFakeDocument();
    const adapter = createSliderAdapter(doc);
    const samples: MovementParams[] = [];

    await adapter.start((params) => samples.push(params));
    vi.advanceTimersByTime(SAMPLE_PERIOD * 2);
    const countBeforeStop = samples.length;
    expect(countBeforeStop).toBeGreaterThan(0);

    adapter.stop();
    expect(body.children[0]?.removed).toBe(true);

    vi.advanceTimersByTime(SAMPLE_PERIOD * 5);
    expect(samples.length).toBe(countBeforeStop);
  });

  it('clamps out-of-range slider values into 0–1', async () => {
    const { doc, inputs } = createFakeDocument();
    const adapter = createSliderAdapter(doc);
    const samples: MovementParams[] = [];

    await adapter.start((params) => samples.push(params));

    const expansionInput = inputs[0];
    if (expansionInput) expansionInput.value = '1.5';

    vi.advanceTimersByTime(SAMPLE_PERIOD);
    expect(samples.at(-1)?.expansion).toBe(1);

    adapter.stop();
  });
});

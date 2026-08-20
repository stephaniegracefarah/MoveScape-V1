import { describe, expect, it } from 'vitest';
import type { Scene, SceneElement } from '../styles/style-renderer';
import { renderScene, type CanvasLike, type CanvasSize } from './render-scene';

// A single ordered trace of every CanvasLike interaction, so tests can
// assert both "what was drawn" and "in what order" without a real canvas.
type RecordedCall =
  | { method: 'clearRect'; args: [number, number, number, number] }
  | { method: 'setGlobalAlpha'; args: [number] }
  | { method: 'setFillStyle'; args: [string] }
  | { method: 'beginPath'; args: [] }
  | { method: 'arc'; args: [number, number, number, number, number] }
  | { method: 'fill'; args: [] };

function createMockCanvas(): CanvasLike & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let fillStyle = '';
  let globalAlpha = 1;

  return {
    calls,
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string) {
      fillStyle = value;
      calls.push({ method: 'setFillStyle', args: [value] });
    },
    get globalAlpha() {
      return globalAlpha;
    },
    set globalAlpha(value: number) {
      globalAlpha = value;
      calls.push({ method: 'setGlobalAlpha', args: [value] });
    },
    clearRect(x, y, w, h) {
      calls.push({ method: 'clearRect', args: [x, y, w, h] });
    },
    beginPath() {
      calls.push({ method: 'beginPath', args: [] });
    },
    arc(x, y, radius, startAngle, endAngle) {
      calls.push({ method: 'arc', args: [x, y, radius, startAngle, endAngle] });
    },
    fill() {
      calls.push({ method: 'fill', args: [] });
    },
  };
}

function makeElement(overrides: Partial<SceneElement> = {}): SceneElement {
  return {
    z: 0,
    x: 0.5,
    y: 0.5,
    radius: 0.1,
    color: 'red',
    opacity: 1,
    ...overrides,
  };
}

const CANVAS_SIZE: CanvasSize = { width: 200, height: 100 };

describe('renderScene — clearing', () => {
  it('clears the full canvas bounds once, before any drawing', () => {
    const canvas = createMockCanvas();
    const scene: Scene = { elements: [makeElement()] };

    renderScene(canvas, scene, CANVAS_SIZE);

    const clearCalls = canvas.calls.filter((c) => c.method === 'clearRect');
    expect(clearCalls).toHaveLength(1);
    expect(clearCalls[0]).toEqual({ method: 'clearRect', args: [0, 0, 200, 100] });
    expect(canvas.calls[0]).toEqual(clearCalls[0]);
  });
});

describe('renderScene — depth ordering', () => {
  it('draws farthest (largest z) first, regardless of input order', () => {
    const canvas = createMockCanvas();
    const scene: Scene = {
      elements: [
        makeElement({ z: 0.2, color: 'near' }),
        makeElement({ z: 0.9, color: 'far' }),
        makeElement({ z: 0.5, color: 'mid' }),
      ],
    };

    renderScene(canvas, scene, CANVAS_SIZE);

    const paintedColors = canvas.calls
      .filter((c) => c.method === 'setFillStyle')
      .map((c) => c.args[0]);
    expect(paintedColors).toEqual(['far', 'mid', 'near']);
  });
});

describe('renderScene — depth fade formula', () => {
  // shorterSide = min(200, 100) = 100.
  it('z=0 renders at full opacity and full radius', () => {
    const canvas = createMockCanvas();
    const scene: Scene = { elements: [makeElement({ z: 0, opacity: 1, radius: 0.1 })] };

    renderScene(canvas, scene, CANVAS_SIZE);

    const alphaSets = canvas.calls.filter((c) => c.method === 'setGlobalAlpha');
    // alphaSets[0] is the per-element alpha; the final reset-to-1 comes after.
    expect(alphaSets[0]?.args[0]).toBeCloseTo(1, 10);
    const arcCall = canvas.calls.find((c) => c.method === 'arc');
    expect(arcCall?.args[2]).toBeCloseTo(10, 10); // 0.1 * (1 - 0) * 100
  });

  it('z=1 fades opacity to 15% and radius to 40% of base', () => {
    const canvas = createMockCanvas();
    const scene: Scene = { elements: [makeElement({ z: 1, opacity: 1, radius: 0.1 })] };

    renderScene(canvas, scene, CANVAS_SIZE);

    const alphaSets = canvas.calls.filter((c) => c.method === 'setGlobalAlpha');
    expect(alphaSets[0]?.args[0]).toBeCloseTo(0.15, 10);
    const arcCall = canvas.calls.find((c) => c.method === 'arc');
    expect(arcCall?.args[2]).toBeCloseTo(4, 10); // 0.1 * (1 - 0.6) * 100
  });

  it('z=0.5 lands at the linear midpoint of the fade formula', () => {
    const canvas = createMockCanvas();
    const scene: Scene = { elements: [makeElement({ z: 0.5, opacity: 1, radius: 0.1 })] };

    renderScene(canvas, scene, CANVAS_SIZE);

    const alphaSets = canvas.calls.filter((c) => c.method === 'setGlobalAlpha');
    // 1 * (1 - 0.5 * 0.85) = 0.575
    expect(alphaSets[0]?.args[0]).toBeCloseTo(0.575, 10);
    const arcCall = canvas.calls.find((c) => c.method === 'arc');
    // 0.1 * (1 - 0.5 * 0.6) * 100 = 7
    expect(arcCall?.args[2]).toBeCloseTo(7, 10);
  });

  it('positions elements scaled by canvas width/height, not the shorter side', () => {
    const canvas = createMockCanvas();
    const scene: Scene = { elements: [makeElement({ x: 0.25, y: 0.75, z: 0 })] };

    renderScene(canvas, scene, CANVAS_SIZE);

    const arcCall = canvas.calls.find((c) => c.method === 'arc');
    expect(arcCall?.args[0]).toBeCloseTo(50, 10); // 0.25 * 200
    expect(arcCall?.args[1]).toBeCloseTo(75, 10); // 0.75 * 100
  });
});

describe('renderScene — cleanup', () => {
  it('resets globalAlpha to 1 after rendering', () => {
    const canvas = createMockCanvas();
    const scene: Scene = { elements: [makeElement({ z: 1, opacity: 0.5 })] };

    renderScene(canvas, scene, CANVAS_SIZE);

    expect(canvas.globalAlpha).toBe(1);
  });

  it('resets globalAlpha to 1 even with an empty scene', () => {
    const canvas = createMockCanvas();
    canvas.globalAlpha = 0.3;

    renderScene(canvas, { elements: [] }, CANVAS_SIZE);

    expect(canvas.globalAlpha).toBe(1);
  });
});

describe('renderScene — non-mutation', () => {
  it('does not mutate the order of the input scene.elements array', () => {
    const elements = [
      makeElement({ z: 0.1, color: 'a' }),
      makeElement({ z: 0.9, color: 'b' }),
      makeElement({ z: 0.5, color: 'c' }),
    ];
    const originalOrder = elements.map((e) => e.color);

    renderScene(createMockCanvas(), { elements }, CANVAS_SIZE);

    expect(elements.map((e) => e.color)).toEqual(originalOrder);
  });
});

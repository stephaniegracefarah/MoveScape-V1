import { describe, expect, it } from 'vitest';
import type { Scene, SceneElement } from '../styles/style-renderer';
import {
  computeCanvasSize,
  MIN_WORLD_WIDTH_UNITS,
  renderScene,
  WORLD_WIDTH_PADDING_UNITS,
  type CanvasLike,
  type CanvasSize,
} from './render-scene';

// A single ordered trace of every CanvasLike interaction, so tests can
// assert both "what was drawn" and "in what order" without a real canvas.
type RecordedCall =
  | { method: 'clearRect'; args: [number, number, number, number] }
  | { method: 'fillRect'; args: [number, number, number, number] }
  | { method: 'setGlobalAlpha'; args: [number] }
  | { method: 'setFillStyle'; args: [string] }
  | { method: 'setStrokeStyle'; args: [string] }
  | { method: 'setLineWidth'; args: [number] }
  | { method: 'setLineCap'; args: ['butt' | 'round' | 'square'] }
  | { method: 'beginPath'; args: [] }
  | { method: 'arc'; args: [number, number, number, number, number] }
  | { method: 'moveTo'; args: [number, number] }
  | { method: 'lineTo'; args: [number, number] }
  | { method: 'fill'; args: [] }
  | { method: 'stroke'; args: [] };

function createMockCanvas(): CanvasLike & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let fillStyle = '';
  let strokeStyle = '';
  let globalAlpha = 1;
  let lineWidth = 1;
  let lineCap: 'butt' | 'round' | 'square' = 'butt';

  return {
    calls,
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string) {
      fillStyle = value;
      calls.push({ method: 'setFillStyle', args: [value] });
    },
    get strokeStyle() {
      return strokeStyle;
    },
    set strokeStyle(value: string) {
      strokeStyle = value;
      calls.push({ method: 'setStrokeStyle', args: [value] });
    },
    get globalAlpha() {
      return globalAlpha;
    },
    set globalAlpha(value: number) {
      globalAlpha = value;
      calls.push({ method: 'setGlobalAlpha', args: [value] });
    },
    get lineWidth() {
      return lineWidth;
    },
    set lineWidth(value: number) {
      lineWidth = value;
      calls.push({ method: 'setLineWidth', args: [value] });
    },
    get lineCap() {
      return lineCap;
    },
    set lineCap(value: 'butt' | 'round' | 'square') {
      lineCap = value;
      calls.push({ method: 'setLineCap', args: [value] });
    },
    clearRect(x, y, w, h) {
      calls.push({ method: 'clearRect', args: [x, y, w, h] });
    },
    fillRect(x, y, w, h) {
      calls.push({ method: 'fillRect', args: [x, y, w, h] });
    },
    beginPath() {
      calls.push({ method: 'beginPath', args: [] });
    },
    arc(x, y, radius, startAngle, endAngle) {
      calls.push({ method: 'arc', args: [x, y, radius, startAngle, endAngle] });
    },
    moveTo(x, y) {
      calls.push({ method: 'moveTo', args: [x, y] });
    },
    lineTo(x, y) {
      calls.push({ method: 'lineTo', args: [x, y] });
    },
    fill() {
      calls.push({ method: 'fill', args: [] });
    },
    stroke() {
      calls.push({ method: 'stroke', args: [] });
    },
  };
}

function makeElement(overrides: Partial<SceneElement> = {}): SceneElement {
  return {
    kind: 'circle',
    z: 0,
    x: 0.5,
    y: 0.5,
    radius: 0.1,
    color: 'red',
    opacity: 1,
    ...overrides,
  } as SceneElement;
}

const CANVAS_SIZE: CanvasSize = { width: 200, height: 100 };

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

  it('sorts mixed circle and stroke elements farthest-z-first together', () => {
    const canvas = createMockCanvas();
    const scene: Scene = {
      elements: [
        makeElement({ z: 0.2, color: 'near-circle' }),
        {
          kind: 'stroke',
          z: 0.9,
          points: [
            { x: 0.1, y: 0.1 },
            { x: 0.5, y: 0.5 },
          ],
          baseWidth: 0.05,
          taperExponent: 1,
          color: 'far-stroke',
          opacity: 1,
        },
        makeElement({ z: 0.5, color: 'mid-circle' }),
      ],
    };

    renderScene(canvas, scene, CANVAS_SIZE);

    const paintedColors = canvas.calls
      .filter((c) => c.method === 'setFillStyle' || c.method === 'setStrokeStyle')
      .map((c) => c.args[0]);
    expect(paintedColors).toEqual(['far-stroke', 'mid-circle', 'near-circle']);
  });
});

describe('renderScene — depth fade formula', () => {
  // worldUnitPx = canvasSize.height = 100 (width no longer participates in radius or x-position scaling)
  it('z=0 renders at full opacity and full radius', () => {
    const canvas = createMockCanvas();
    const scene: Scene = { elements: [makeElement({ z: 0, opacity: 1, radius: 0.1 })] };

    renderScene(canvas, scene, CANVAS_SIZE);

    const alphaSets = canvas.calls.filter((c) => c.method === 'setGlobalAlpha');
    // alphaSets[0] is the per-element alpha; the final reset-to-1 comes after.
    expect(alphaSets[0]?.args[0]).toBeCloseTo(1, 10);
    const arcCall = canvas.calls.find((c) => c.method === 'arc');
    expect(arcCall?.args[2]).toBeCloseTo(10, 10); // 0.1 * (1 - 0) * worldUnitPx(100)
  });

  it('z=1 fades opacity to 15% and radius to 40% of base', () => {
    const canvas = createMockCanvas();
    const scene: Scene = { elements: [makeElement({ z: 1, opacity: 1, radius: 0.1 })] };

    renderScene(canvas, scene, CANVAS_SIZE);

    const alphaSets = canvas.calls.filter((c) => c.method === 'setGlobalAlpha');
    expect(alphaSets[0]?.args[0]).toBeCloseTo(0.15, 10);
    const arcCall = canvas.calls.find((c) => c.method === 'arc');
    expect(arcCall?.args[2]).toBeCloseTo(4, 10); // 0.1 * (1 - 0.6) * worldUnitPx(100)
  });

  it('z=0.5 lands at the linear midpoint of the fade formula', () => {
    const canvas = createMockCanvas();
    const scene: Scene = { elements: [makeElement({ z: 0.5, opacity: 1, radius: 0.1 })] };

    renderScene(canvas, scene, CANVAS_SIZE);

    const alphaSets = canvas.calls.filter((c) => c.method === 'setGlobalAlpha');
    // 1 * (1 - 0.5 * 0.85) = 0.575
    expect(alphaSets[0]?.args[0]).toBeCloseTo(0.575, 10);
    const arcCall = canvas.calls.find((c) => c.method === 'arc');
    // 0.1 * (1 - 0.5 * 0.6) * worldUnitPx(100) = 7
    expect(arcCall?.args[2]).toBeCloseTo(7, 10);
  });

  it('positions both axes using canvas height as the world-unit scale -- canvas width has no effect on position', () => {
    const canvas = createMockCanvas();
    const scene: Scene = { elements: [makeElement({ x: 0.25, y: 0.75, z: 0 })] };

    renderScene(canvas, scene, CANVAS_SIZE);

    const arcCall = canvas.calls.find((c) => c.method === 'arc');
    expect(arcCall?.args[0]).toBeCloseTo(25, 10); // 0.25 * worldUnitPx(100), NOT 0.25 * width(200)
    expect(arcCall?.args[1]).toBeCloseTo(75, 10); // 0.75 * 100

    // Permanent ink: the same element rendered against a wider canvas of
    // the same height must produce the exact same pixel position. Growing
    // the canvas's width must never move an already-placed mark.
    const widerCanvas = createMockCanvas();
    renderScene(widerCanvas, scene, { width: 800, height: 100 });
    const widerArcCall = widerCanvas.calls.find((c) => c.method === 'arc');
    expect(widerArcCall?.args[0]).toBe(arcCall?.args[0]);
    expect(widerArcCall?.args[1]).toBe(arcCall?.args[1]);
  });
});

describe('renderScene — circle ring', () => {
  it('a circle with ringColor produces an extra stroke() call beyond its fill()', () => {
    const canvas = createMockCanvas();
    const scene: Scene = {
      elements: [makeElement({ ringColor: 'gold', ringOpacity: 0.5 })],
    };

    renderScene(canvas, scene, CANVAS_SIZE);

    const fillCalls = canvas.calls.filter((c) => c.method === 'fill');
    const strokeCalls = canvas.calls.filter((c) => c.method === 'stroke');
    expect(fillCalls).toHaveLength(1);
    expect(strokeCalls).toHaveLength(1);

    const strokeStyleCall = canvas.calls.find((c) => c.method === 'setStrokeStyle');
    expect(strokeStyleCall?.args[0]).toBe('gold');
    const lineWidthCall = canvas.calls.find((c) => c.method === 'setLineWidth');
    expect(lineWidthCall?.args[0]).toBe(1);
  });

  it('a circle without ringColor produces no stroke() call', () => {
    const canvas = createMockCanvas();
    const scene: Scene = { elements: [makeElement()] };

    renderScene(canvas, scene, CANVAS_SIZE);

    const strokeCalls = canvas.calls.filter((c) => c.method === 'stroke');
    expect(strokeCalls).toHaveLength(0);
  });
});

describe('renderScene — stroke elements', () => {
  it('renders via moveTo/lineTo/stroke, not arc/fill', () => {
    const canvas = createMockCanvas();
    const scene: Scene = {
      elements: [
        {
          kind: 'stroke',
          z: 0,
          points: [
            { x: 0.1, y: 0.1 },
            { x: 0.5, y: 0.5 },
            { x: 0.9, y: 0.1 },
          ],
          baseWidth: 0.05,
          taperExponent: 1,
          color: 'blue',
          opacity: 1,
        },
      ],
    };

    renderScene(canvas, scene, CANVAS_SIZE);

    expect(canvas.calls.some((c) => c.method === 'arc')).toBe(false);
    expect(canvas.calls.some((c) => c.method === 'fill')).toBe(false);
    expect(canvas.calls.filter((c) => c.method === 'moveTo')).toHaveLength(2);
    expect(canvas.calls.filter((c) => c.method === 'lineTo')).toHaveLength(2);
    expect(canvas.calls.filter((c) => c.method === 'stroke')).toHaveLength(2);
  });

  it('tapers width: the first segment is wider than the last for taperExponent > 0', () => {
    const canvas = createMockCanvas();
    const scene: Scene = {
      elements: [
        {
          kind: 'stroke',
          z: 0,
          points: [
            { x: 0.1, y: 0.1 },
            { x: 0.4, y: 0.4 },
            { x: 0.7, y: 0.7 },
            { x: 0.9, y: 0.9 },
          ],
          baseWidth: 0.1,
          taperExponent: 2,
          color: 'green',
          opacity: 1,
        },
      ],
    };

    renderScene(canvas, scene, CANVAS_SIZE);

    const lineWidths = canvas.calls
      .filter((c) => c.method === 'setLineWidth')
      .map((c) => c.args[0]);
    expect(lineWidths.length).toBeGreaterThanOrEqual(3);
    expect(lineWidths[0]!).toBeGreaterThan(lineWidths[lineWidths.length - 1]!);
  });

  it('clamps stroke width to a minimum of 0.5px', () => {
    const canvas = createMockCanvas();
    const scene: Scene = {
      elements: [
        {
          kind: 'stroke',
          z: 0,
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
          baseWidth: 0.00001,
          taperExponent: 1,
          color: 'blue',
          opacity: 1,
        },
      ],
    };

    renderScene(canvas, scene, CANVAS_SIZE);

    const lineWidthCall = canvas.calls.find((c) => c.method === 'setLineWidth');
    expect(lineWidthCall?.args[0]).toBeGreaterThanOrEqual(0.5);
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

describe('computeCanvasSize', () => {
  const HEIGHT_PX = 100;

  it('an empty scene returns the minimum world width', () => {
    const size = computeCanvasSize({ elements: [] }, HEIGHT_PX);
    expect(size).toEqual({ width: HEIGHT_PX * MIN_WORLD_WIDTH_UNITS, height: HEIGHT_PX });
  });

  it('a single circle sizes width to its farthest-right extent plus padding', () => {
    const scene: Scene = { elements: [makeElement({ x: 2, radius: 0.1 })] };
    const size = computeCanvasSize(scene, HEIGHT_PX);
    expect(size.width).toBeCloseTo((2 + 0.1 + WORLD_WIDTH_PADDING_UNITS) * HEIGHT_PX, 10);
  });

  it('a stroke sizes width to its farthest point plus padding', () => {
    const scene: Scene = {
      elements: [
        {
          kind: 'stroke',
          z: 0,
          points: [
            { x: 0.5, y: 0.5 },
            { x: 3, y: 0.2 },
          ],
          baseWidth: 0.05,
          taperExponent: 1,
          color: 'blue',
          opacity: 1,
        },
      ],
    };
    const size = computeCanvasSize(scene, HEIGHT_PX);
    expect(size.width).toBeCloseTo((3 + WORLD_WIDTH_PADDING_UNITS) * HEIGHT_PX, 10);
  });

  it('height in the result always exactly equals the heightPx argument', () => {
    expect(computeCanvasSize({ elements: [] }, 100).height).toBe(100);
    expect(computeCanvasSize({ elements: [makeElement({ x: 5 })] }, 337).height).toBe(337);
  });
});

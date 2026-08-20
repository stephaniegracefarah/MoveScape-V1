/**
 * Manual slider adapter (dev builds only — invariant 1: this is just another
 * InputAdapter, coupled to downstream layers through MovementParams alone).
 *
 * Renders three range sliders (expansion, speed, symmetry) and samples their
 * current values on a steady ~30 Hz timer, emitting each sample through the
 * same ParamsListener callback every other adapter uses. The module lives
 * permanently in the codebase; only its UI is gated out of production builds
 * (see src/main.ts, which imports this module behind `import.meta.env.DEV`).
 */
import type { InputAdapter, ParamsListener } from '../input-adapter';
import type { MovementParams } from '../movement-params';
import { MOVEMENT_PARAMS_VERSION } from '../movement-params';

/** ~30 Hz sample rate, matching the recording rate described in the spec. */
const SAMPLE_INTERVAL_MS = 1000 / 30;

/**
 * Distinctive marker id, used both as the panel's DOM id and as the string
 * grepped for in the production bundle to prove dev-only code was excluded
 * (see the M1 build's dist verification step).
 */
export const SLIDER_PANEL_MARKER = 'movescape-dev-slider-panel';

type ParamKey = 'expansion' | 'speed' | 'symmetry';

interface SliderConfig {
  key: ParamKey;
  label: string;
  defaultValue: number;
}

const SLIDER_CONFIGS: readonly SliderConfig[] = [
  { key: 'expansion', label: 'Expansion', defaultValue: 0.3 },
  { key: 'speed', label: 'Speed', defaultValue: 0.1 },
  { key: 'symmetry', label: 'Symmetry', defaultValue: 0.8 },
];

interface SliderInputs {
  expansion: HTMLInputElement;
  speed: HTMLInputElement;
  symmetry: HTMLInputElement;
}

/**
 * The subset of the DOM `Document` API the slider adapter needs. Real
 * `document` satisfies this; tests can pass a minimal fake instead, so the
 * adapter's emission logic is exercisable without a full DOM environment.
 */
export interface MinimalDocument {
  createElement(tagName: string): HTMLElement;
  body: { appendChild(node: HTMLElement): void };
}

/** Manual slider adapter: three 0–1 range sliders driving MovementParams. */
export function createSliderAdapter(doc: MinimalDocument = document as unknown as MinimalDocument): InputAdapter {
  let panel: HTMLElement | null = null;
  let inputs: SliderInputs | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    id: 'sliders',

    start(onParams: ParamsListener): Promise<void> {
      const built = buildPanel(doc);
      panel = built.panel;
      inputs = built.inputs;
      doc.body.appendChild(panel);

      timer = setInterval(() => {
        if (!inputs) return;
        const params: MovementParams = {
          v: MOVEMENT_PARAMS_VERSION,
          expansion: readUnit(inputs.expansion),
          speed: readUnit(inputs.speed),
          symmetry: readUnit(inputs.symmetry),
        };
        onParams(params, performance.now());
      }, SAMPLE_INTERVAL_MS);

      return Promise.resolve();
    },

    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (panel) {
        panel.remove();
        panel = null;
      }
      inputs = null;
    },
  };
}

function readUnit(input: HTMLInputElement): number {
  const n = Number(input.value);
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function buildPanel(doc: MinimalDocument): { panel: HTMLElement; inputs: SliderInputs } {
  const panel = doc.createElement('div');
  panel.id = SLIDER_PANEL_MARKER;
  panel.style.cssText = [
    'position:fixed',
    'right:12px',
    'bottom:12px',
    'z-index:1000',
    'background:rgba(20,20,24,0.9)',
    'color:#f2f2f2',
    'font:12px/1.4 system-ui,sans-serif',
    'padding:12px 14px',
    'border-radius:8px',
    'box-shadow:0 2px 10px rgba(0,0,0,0.35)',
    'display:flex',
    'flex-direction:column',
    'gap:8px',
    'min-width:180px',
  ].join(';');

  const heading = doc.createElement('div');
  heading.textContent = 'Manual sliders (dev)';
  heading.style.cssText = 'font-weight:600;letter-spacing:0.02em;';
  panel.appendChild(heading);

  const built: Partial<SliderInputs> = {};

  for (const cfg of SLIDER_CONFIGS) {
    const row = doc.createElement('div');
    row.style.cssText = 'display:flex;flex-direction:column;gap:2px;';

    const label = doc.createElement('label');
    label.textContent = cfg.label;

    const input = doc.createElement('input') as HTMLInputElement;
    input.type = 'range';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    input.value = String(cfg.defaultValue);

    row.appendChild(label);
    row.appendChild(input);
    panel.appendChild(row);

    built[cfg.key] = input;
  }

  return { panel, inputs: built as SliderInputs };
}

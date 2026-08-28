/**
 * On-screen readout: labeled live-updating bars + numeric values for the
 * three instantaneous MovementParams. It subscribes only through the
 * InputAdapter's ParamsListener shape (invariant 1) — `update` can be passed
 * directly to any adapter's `start()`, so the readout behaves identically
 * whichever adapter is driving it (webcam or sliders).
 */
import type { MovementParams } from '../adapters/movement-params';
import type { ParamsListener } from '../adapters/input-adapter';

type ParamKey = 'expansion' | 'speed' | 'symmetry';

const PARAM_ROWS: readonly { key: ParamKey; label: string }[] = [
  { key: 'expansion', label: 'Expansion' },
  { key: 'speed', label: 'Speed' },
  { key: 'symmetry', label: 'Symmetry' },
];

export interface ParamsReadout {
  /** Matches ParamsListener — pass directly to InputAdapter.start(). */
  update: ParamsListener;
  /** Reset all bars/values to zero, e.g. when no adapter is active. */
  reset(): void;
}

/** Clamp a value into 0–1 before turning it into a display percentage. */
export function clampDisplayUnit(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Format a 0–1 movement parameter as a fixed-precision numeric label. */
export function formatParamValue(value: number): string {
  return clampDisplayUnit(value).toFixed(2);
}

/** Format a 0–1 movement parameter as a CSS width percentage string. */
export function formatBarWidth(value: number): string {
  return `${(clampDisplayUnit(value) * 100).toFixed(1)}%`;
}

interface RowElements {
  fill: HTMLElement;
  valueLabel: HTMLElement;
}

/** Builds the readout DOM inside `container` and returns its update/reset API. */
export function createParamsReadout(container: HTMLElement): ParamsReadout {
  const root = document.createElement('div');
  root.className = 'ms-readout';
  root.style.cssText =
    "display:flex;flex-direction:column;gap:10px;min-width:220px;font-family:'IBM Plex Mono',ui-monospace,'SF Mono',Menlo,monospace;color:var(--ink);";

  const rows = new Map<ParamKey, RowElements>();

  for (const { key, label } of PARAM_ROWS) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;';

    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    // Micro / section label per the style guide's typography table.
    labelEl.style.cssText = 'font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:0.12em;';

    const valueLabel = document.createElement('span');
    valueLabel.textContent = '0.00';
    valueLabel.style.cssText = 'font-size:13px;font-variant-numeric:tabular-nums;';

    header.appendChild(labelEl);
    header.appendChild(valueLabel);

    const track = document.createElement('div');
    track.style.cssText =
      'position:relative;height:6px;background:rgba(36,26,23,0.15);overflow:hidden;';

    const fill = document.createElement('div');
    fill.style.cssText =
      'position:absolute;left:0;top:0;bottom:0;width:0%;background:var(--ink);transition:width 60ms linear;';

    track.appendChild(fill);
    row.appendChild(header);
    row.appendChild(track);
    root.appendChild(row);

    rows.set(key, { fill, valueLabel });
  }

  container.appendChild(root);

  return {
    update(params: MovementParams): void {
      for (const { key } of PARAM_ROWS) {
        const els = rows.get(key);
        if (!els) continue;
        const value = params[key];
        els.fill.style.width = formatBarWidth(value);
        els.valueLabel.textContent = formatParamValue(value);
      }
    },
    reset(): void {
      for (const { key } of PARAM_ROWS) {
        const els = rows.get(key);
        if (!els) continue;
        els.fill.style.width = '0%';
        els.valueLabel.textContent = '0.00';
      }
    },
  };
}

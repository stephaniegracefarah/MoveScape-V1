/**
 * "Show the magic" panel (UX Stage 2, docs/UX/develop.md Live-session
 * decision C + fourth-pass layout). A user-facing card docked to the LEFT
 * edge of the full-bleed canvas that reveals exactly how movement drives
 * the art:
 *
 *  - Two tabs, one per real movement->art function boundary (NOT per
 *    readout number): `speed → growth` (growthStepFor) and
 *    `expansion + symmetry → wander` (wanderDeltaFor). Each shows that
 *    function's VERBATIM source (Vite `?raw` + extractFunctionSource) with
 *    the current tick's live argument values annotated inline and the
 *    computed result on a final `→` line.
 *  - Below the tabs, always visible: a bar-plus-number readout of
 *    Expansion / Speed / Symmetry from the live MovementParams.
 *
 * Style guide (docs/UX/deliver-style-guide/style-guide.md): 1px ~30%-ink
 * border, `--scrim` fill, no radius, no shadow, IBM Plex Mono, no colour.
 *
 * The panel keeps updating with the camera hidden -- only the separate
 * skeleton overlay needs the camera feed.
 */
import type { MovementParams } from '../../adapters/movement-params';
import type { MechanismFunctionSample, MechanismSample } from '../../styles/style-renderer';
import { formatBarWidth, formatParamValue } from '../readout';
import { extractFunctionSource } from './source-extract';
import branchRawSource from '../../styles/botanical/branch.ts?raw';

/**
 * `sourceModule` id -> that module's raw text. Dynamic `?raw` imports of an
 * arbitrary path aren't statically analyzable, so the known sources are
 * imported up front and looked up by the id the MechanismFunctionSample
 * carries (see style-renderer.ts's doc comment). Both current functions
 * live in branch.ts.
 */
export const MAGIC_RAW_SOURCES: Record<string, string> = {
  'branch.ts': branchRawSource,
};

const READOUT_ROWS: readonly { key: 'expansion' | 'speed' | 'symmetry'; label: string }[] = [
  { key: 'expansion', label: 'Expansion' },
  { key: 'speed', label: 'Speed' },
  { key: 'symmetry', label: 'Symmetry' },
];

/**
 * Formats a live scalar for inline display: ~4 significant figures, trailing
 * zeros trimmed, so `dt` reads `16.67`, a 0-1 param reads `0.41`, and a tiny
 * result reads `0.00035` rather than `0.00` or a wall of digits.
 */
export function formatMagicNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return '0';
  let s = n.toPrecision(4);
  if (s.includes('e') || s.includes('E')) return s;
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  return s;
}

/** Header shown above the code block, e.g. `branch.ts : growthStepFor()`. */
export function magicCodeHeader(fn: MechanismFunctionSample): string {
  return `${fn.sourceModule} : ${fn.sourceFunctionName}()`;
}

/**
 * Slices `fn`'s verbatim source out of `rawModuleSource` and annotates it:
 * every parameter in `fn.args` gets a `// <value>` note appended to its
 * declaration line (aligned into one column), and a final `→ <result>` line
 * is appended. Pragmatic matcher -- it targets the two known pure-math
 * functions, whose parameters each appear once as `  name: type;` /
 * `  name,` inside the destructured `args` object.
 */
export function annotateFunctionSource(rawModuleSource: string, fn: MechanismFunctionSample): string {
  const source = extractFunctionSource(rawModuleSource, fn.sourceFunctionName);
  const entries = Object.entries(fn.args);
  const lines = source.split('\n');

  const noteFor = (line: string): string | null => {
    for (const [name, value] of entries) {
      // A param's declaration line: the name at line start (after indent),
      // as a whole word, followed by `:` (typed) or `,` (bare). Body lines
      // like `const speedFloor = ...` or `return args.dt * ...` don't match.
      if (new RegExp(`^\\s*${name}\\b\\s*[:,]`).test(line)) return formatMagicNumber(value);
    }
    return null;
  };

  const annotations = lines.map((line) => ({ line, note: noteFor(line) }));
  const col =
    Math.max(
      0,
      ...annotations.filter((a) => a.note !== null).map((a) => a.line.replace(/\s+$/, '').length),
    ) + 2;

  const body = annotations
    .map((a) => (a.note === null ? a.line : `${a.line.replace(/\s+$/, '').padEnd(col)}// ${a.note}`))
    .join('\n');

  return `${body}\n\n→ ${formatMagicNumber(fn.result)}`;
}

export interface MagicView {
  /** No mechanism sample yet (art engine hasn't computed a tick). */
  warmingUp: boolean;
  tabs: { label: string; active: boolean }[];
  codeHeader: string | null;
  codeBody: string | null;
  readout: { key: string; label: string; value: string; barWidth: string }[];
}

/**
 * Pure view-model for the panel given the latest sample + params + which tab
 * is selected. The readout is always populated from `params` (it updates
 * even while `warmingUp`); the code block is null until a sample exists.
 */
export function buildMagicView(
  sample: MechanismSample | null,
  params: MovementParams,
  activeTabIndex: number,
  sources: Record<string, string> = MAGIC_RAW_SOURCES,
): MagicView {
  const readout = READOUT_ROWS.map(({ key, label }) => ({
    key,
    label,
    value: formatParamValue(params[key]),
    barWidth: formatBarWidth(params[key]),
  }));

  const fns = sample?.functions ?? [];
  if (fns.length === 0) {
    return { warmingUp: true, tabs: [], codeHeader: null, codeBody: null, readout };
  }

  const active = Math.min(Math.max(activeTabIndex, 0), fns.length - 1);
  const fn = fns[active]!;
  const raw = sources[fn.sourceModule];

  let codeBody: string;
  if (raw === undefined) {
    codeBody = `(source unavailable for ${fn.sourceModule})`;
  } else {
    try {
      codeBody = annotateFunctionSource(raw, fn);
    } catch (err) {
      codeBody = `(could not render source: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  return {
    warmingUp: false,
    tabs: fns.map((f, i) => ({ label: f.tabLabel, active: i === active })),
    codeHeader: magicCodeHeader(fn),
    codeBody,
    readout,
  };
}

export interface MagicPanel {
  setShown(shown: boolean): void;
  update(sample: MechanismSample | null, params: MovementParams): void;
  destroy(): void;
}

const STYLE_ID = 'ms-magic-panel-styles';
const PANEL_CSS = `
  .ms-magic {
    box-sizing: border-box;
    width: 100%;
    background: var(--scrim);
    border: 1px solid rgba(36, 26, 23, 0.3);
    padding: 16px;
    font-family: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    color: var(--ink);
  }
  .ms-magic[hidden] { display: none; }
  .ms-magic-eyebrow { font-size: 10px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; }
  .ms-magic-sub { font-size: 11px; opacity: 0.7; margin-top: 2px; }
  .ms-magic-tabs { display: flex; margin-top: 12px; }
  .ms-magic-tab {
    font: inherit;
    font-size: 11px;
    padding: 6px 10px;
    border: 1px solid rgba(36, 26, 23, 0.3);
    background: none;
    color: var(--ink);
    cursor: pointer;
  }
  .ms-magic-tab + .ms-magic-tab { border-left: none; }
  .ms-magic-tab.is-active { background: var(--ink); color: var(--paper); }
  .ms-magic-code { margin-top: 12px; border: 1px solid rgba(36, 26, 23, 0.3); padding: 12px; }
  .ms-magic-code-header { font-size: 12px; font-weight: 500; margin-bottom: 8px; }
  .ms-magic-code-body { margin: 0; font: inherit; font-size: 12px; line-height: 1.5; white-space: pre; overflow-x: auto; }
  .ms-magic-readout { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
  .ms-magic-rrow { display: grid; grid-template-columns: 76px 1fr 40px; align-items: center; gap: 10px; }
  .ms-magic-rlabel { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; }
  .ms-magic-rtrack { position: relative; height: 6px; background: rgba(36, 26, 23, 0.15); }
  .ms-magic-rfill { position: absolute; left: 0; top: 0; bottom: 0; width: 0%; background: var(--ink); }
  .ms-magic-rvalue { font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
  .ms-magic-foot { margin-top: 12px; font-size: 10px; opacity: 0.6; letter-spacing: 0.04em; }
`;

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = PANEL_CSS;
  document.head.appendChild(el);
}

/**
 * Builds the panel DOM inside `container` and returns its imperative API.
 * `update` is expected once per animation frame while shown; tab state is
 * internal (a tab click re-renders from the last `update`'s data).
 */
const WIDTH_STORAGE_KEY = 'ms-magic-panel-width';

/**
 * Restores the user's last dragged panel width (CSS `resize: horizontal` on
 * `.ms-magic-dock`, see main.ts) and persists new drags. Wrapped in
 * try/catch since localStorage can throw (private mode, disabled storage).
 */
function wirePersistentWidth(container: HTMLElement): void {
  try {
    const saved = localStorage.getItem(WIDTH_STORAGE_KEY);
    if (saved && /^\d+(\.\d+)?px$/.test(saved)) container.style.width = saved;
  } catch {
    /* storage unavailable -- panel just opens at its default width */
  }
  if (typeof ResizeObserver === 'undefined') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        localStorage.setItem(WIDTH_STORAGE_KEY, `${Math.round(container.getBoundingClientRect().width)}px`);
      } catch {
        /* ignore */
      }
    }, 250);
  });
  observer.observe(container);
}

export function createMagicPanel(container: HTMLElement): MagicPanel {
  injectStyles();
  wirePersistentWidth(container);

  const root = document.createElement('div');
  root.className = 'ms-magic';
  root.hidden = true;

  const eyebrow = document.createElement('div');
  eyebrow.className = 'ms-magic-eyebrow';
  eyebrow.textContent = 'Show the magic';

  const sub = document.createElement('div');
  sub.className = 'ms-magic-sub';
  sub.textContent = 'actual code + live values';

  const tabsEl = document.createElement('div');
  tabsEl.className = 'ms-magic-tabs';

  const codeEl = document.createElement('div');
  codeEl.className = 'ms-magic-code';
  const codeHeaderEl = document.createElement('div');
  codeHeaderEl.className = 'ms-magic-code-header';
  const codeBodyEl = document.createElement('pre');
  codeBodyEl.className = 'ms-magic-code-body';
  codeEl.appendChild(codeHeaderEl);
  codeEl.appendChild(codeBodyEl);

  const readoutEl = document.createElement('div');
  readoutEl.className = 'ms-magic-readout';
  const fills = new Map<string, HTMLElement>();
  const values = new Map<string, HTMLElement>();
  for (const { key, label } of READOUT_ROWS) {
    const row = document.createElement('div');
    row.className = 'ms-magic-rrow';
    const labelEl = document.createElement('span');
    labelEl.className = 'ms-magic-rlabel';
    labelEl.textContent = label;
    const track = document.createElement('div');
    track.className = 'ms-magic-rtrack';
    const fill = document.createElement('div');
    fill.className = 'ms-magic-rfill';
    track.appendChild(fill);
    const valueEl = document.createElement('span');
    valueEl.className = 'ms-magic-rvalue';
    valueEl.textContent = '0.00';
    row.appendChild(labelEl);
    row.appendChild(track);
    row.appendChild(valueEl);
    readoutEl.appendChild(row);
    fills.set(key, fill);
    values.set(key, valueEl);
  }

  const footEl = document.createElement('div');
  footEl.className = 'ms-magic-foot';
  footEl.textContent = 'verbatim function boundary; values annotated live';

  root.appendChild(eyebrow);
  root.appendChild(sub);
  root.appendChild(tabsEl);
  root.appendChild(codeEl);
  root.appendChild(readoutEl);
  root.appendChild(footEl);
  container.appendChild(root);

  let activeTabIndex = 0;
  let lastSample: MechanismSample | null = null;
  let lastParams: MovementParams = { v: 1, expansion: 0, speed: 0, symmetry: 0 };
  let tabLabels: string[] = [];

  function render(): void {
    const view = buildMagicView(lastSample, lastParams, activeTabIndex);

    const labels = view.tabs.map((t) => t.label);
    if (labels.join(' ') !== tabLabels.join(' ')) {
      tabLabels = labels;
      tabsEl.replaceChildren();
      view.tabs.forEach((tab, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ms-magic-tab';
        btn.textContent = tab.label;
        btn.addEventListener('click', () => {
          activeTabIndex = i;
          render();
        });
        tabsEl.appendChild(btn);
      });
    }
    Array.from(tabsEl.children).forEach((child, i) => {
      child.classList.toggle('is-active', view.tabs[i]?.active ?? false);
    });
    tabsEl.hidden = view.tabs.length === 0;

    codeHeaderEl.hidden = view.codeHeader === null;
    codeHeaderEl.textContent = view.codeHeader ?? '';
    codeBodyEl.textContent = view.warmingUp
      ? 'warming up… start moving to grow the art'
      : (view.codeBody ?? '');

    for (const { key } of READOUT_ROWS) {
      const row = view.readout.find((r) => r.key === key);
      if (!row) continue;
      const fill = fills.get(key);
      const value = values.get(key);
      if (fill) fill.style.width = row.barWidth;
      if (value) value.textContent = row.value;
    }
  }

  render();

  return {
    setShown(shown: boolean): void {
      root.hidden = !shown;
    },
    update(sample: MechanismSample | null, params: MovementParams): void {
      lastSample = sample;
      lastParams = params;
      render();
    },
    destroy(): void {
      root.remove();
    },
  };
}

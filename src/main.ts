/**
 * Entry point: wires layer 1 (input adapters) to the on-screen readout.
 * Only one adapter is active at a time; switching adapters stops the
 * previous one first. The slider adapter is a dev-only affordance — it is
 * reached only through a dynamic import gated behind `import.meta.env.DEV`,
 * so `vite build` (production) never includes its module in the bundle.
 */
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import { createWebcamAdapter } from './adapters/webcam';
import type { InputAdapter } from './adapters/input-adapter';
import { createParamsReadout } from './app/readout';
import { createMagicPanel } from './app/magic/magic-panel';
import { createSkeletonOverlay } from './app/magic/skeleton-overlay';
import { MOVEMENT_PARAMS_VERSION, type MovementParams } from './adapters/movement-params';
import { createPauseGate } from './app/pause-gate';
import { createActivationTokenSource } from './app/activation-token';
import { getOrCreateUserId } from './app/user-identity';
import { createLiveRenderLoop, type LiveRenderLoop } from './app/live-render-loop';
import type { OffscreenBuffer, OffscreenBufferFactory } from './compositor/live-compositor';
import type { CanvasLike, CanvasSize } from './compositor/render-scene';
import { renderStyleToExportCanvas, type ExportRenderCanvas, type ExportRenderCanvasFactory } from './compositor/export-render';
import { createWorld, type World, type WorldOverrides } from './world/world';
import { deriveWorldSeed, formatLocalDate } from './world/seed';
import { POSE_PARAM_TUNING } from './adapters/webcam/params-from-landmarks';
import { createBotanicalStyle } from './styles/botanical/botanical';
import { BOTANICAL_PALETTE_PRESETS, type BotanicalPaletteId } from './styles/botanical/palettes';
import { DEFAULT_BOTANICAL_TUNING_CONFIG, type BotanicalTuningConfig } from './styles/botanical/tuning-config';
import type { StyleRenderer } from './styles/style-renderer';
import { openRecipeStore, type RecipeStore } from './storage/recipe-store';
import { nextSessionIndexFor } from './storage/next-session-index';
import { exportCanvasAsPng } from './storage/image-export';
import { serializeRecipe } from './storage/recipe-export';
import { PIECE_RECIPE_VERSION, type PieceRecipe } from './storage/recipe';
import type { MovementRecording } from './engine/recording';

// The Scroll (M5 Stage 2, spec Part 3 "Composition and canvas"): the canvas
// has this fixed height and grows rightward as the piece grows -- see
// live-render-loop.ts's resizeCanvas callback below, which sets the real
// canvas element's width every frame to fit the current scene.
// Canvas backing-store height in px = the world-to-pixel scale (render-scene.ts's
// worldUnitPx). Every size in the art is a fraction of this, so raising it
// renders the same composition at higher resolution -- the fix for the
// full-bleed CSS upscale looking soft. Watch long-session frame rate if
// raised further (UX Stage 3 founder ask).
const CANVAS_HEIGHT_PX = 640;

/**
 * The real OffscreenBufferFactory (the fix for the frame-rate collapse,
 * docs/HANDOFF.md): implements src/compositor/live-compositor.ts's
 * OffscreenBuffer/OffscreenBufferFactory DI boundary against a real
 * `<canvas>` element, so live-compositor.ts itself never has to import a
 * DOM canvas type. One instance is created once (see below) and reused
 * across sessions -- it holds no session-specific state itself, since each
 * `create()` call hands back a brand-new, independent offscreen canvas.
 */
function createDomOffscreenBufferFactory(): OffscreenBufferFactory {
  return {
    create(size: CanvasSize): OffscreenBuffer {
      let canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      let activeCtx = canvas.getContext('2d');
      if (!activeCtx) throw new Error('2D context unavailable for an offscreen live-compositor buffer');

      return {
        // A getter, not a plain value: growTo below swaps in a fresh
        // canvas/context when the buffer grows, so `ctx` must always
        // reflect whichever context is current, not whatever it was at
        // construction time. See render-scene.ts's own CanvasLike doc
        // comment for why this cast is safe: CanvasLike is the
        // plain-string-fillStyle subset of CanvasRenderingContext2D this
        // app ever assigns.
        get ctx(): CanvasLike {
          return activeCtx as unknown as CanvasLike;
        },
        blitTo(dest: CanvasLike): void {
          (dest as unknown as CanvasRenderingContext2D).drawImage(canvas, 0, 0);
        },
        growTo(newSize: CanvasSize): void {
          // Resizing a canvas element's width/height attributes clears its
          // pixel contents, so snapshot the existing content onto a second
          // canvas first, resize the real one, then draw the snapshot back
          // -- growTo's own contract (live-compositor.ts) requires old
          // content to survive at (0,0), never a clear-and-resize.
          const snapshot = document.createElement('canvas');
          snapshot.width = canvas.width;
          snapshot.height = canvas.height;
          const snapshotCtx = snapshot.getContext('2d');
          snapshotCtx?.drawImage(canvas, 0, 0);

          canvas = document.createElement('canvas');
          canvas.width = newSize.width;
          canvas.height = newSize.height;
          const freshCtx = canvas.getContext('2d');
          if (!freshCtx) throw new Error('2D context unavailable while growing an offscreen live-compositor buffer');
          if (snapshotCtx) freshCtx.drawImage(snapshot, 0, 0);
          activeCtx = freshCtx;
        },
      };
    },
  };
}

/**
 * The real ExportRenderCanvasFactory (src/compositor/export-render.ts):
 * hands back a brand-new offscreen `<canvas>`, sized exactly for one
 * export, wired directly to that same canvas element's own real `toBlob` --
 * a real HTMLCanvasElement satisfies both `ctx: CanvasLike` (via its 2D
 * context, same cast rationale as createDomOffscreenBufferFactory above)
 * and ExportRenderCanvas's `toBlob` with zero extra plumbing. Unlike
 * createDomOffscreenBufferFactory's buffers, an export canvas is never
 * grown or reused across calls -- each saveSession() gets its own, sized up
 * front to its final (already-clamped) pixel dimensions.
 */
function createDomExportRenderCanvasFactory(): ExportRenderCanvasFactory {
  return {
    create(size: CanvasSize): ExportRenderCanvas {
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D context unavailable for the export-render offscreen canvas');
      return {
        ctx: ctx as unknown as CanvasLike,
        toBlob(callback: (blob: unknown) => void, type?: string): void {
          canvas.toBlob(callback, type);
        },
      };
    },
  };
}

/**
 * Roadmap item A ("Finish preview"): fitted "show the whole piece" display
 * geometry, entered at Finish. Pure and side-effect-free so it is
 * unit-testable without a DOM. Given the canvas backing-store size and the
 * viewport, it returns the CSS display size for the `<canvas>` element,
 * whether the wrap needs a horizontal scrollbar (long skinny pieces do not
 * fit even at the floor height), and -- when scrollable -- that the view
 * should start at the left edge rather than tracking the growth front.
 */
export interface FitDimensions {
  /** px, for the canvas element's inline CSS width. */
  displayWidth: number;
  /** px, for the canvas element's inline CSS height. */
  displayHeight: number;
  /** content wider than the viewport -> horizontal scroll needed. */
  scrollable: boolean;
  /** true when scrollable -- start the view at the beginning, not the right. */
  startAtLeft: boolean;
}

export function computeFitDimensions(
  canvasWidth: number,
  canvasHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  minHeightFraction: number,
): FitDimensions {
  // Defensive guard only: internal callers always pass real positive
  // numbers. A zero / non-finite input would otherwise divide through to
  // NaN dimensions -- fall back to a viewport-sized square.
  if (
    !Number.isFinite(canvasWidth) ||
    !Number.isFinite(canvasHeight) ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    canvasWidth <= 0 ||
    canvasHeight <= 0 ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    const side = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0;
    return { displayWidth: side, displayHeight: side, scrollable: false, startAtLeft: false };
  }

  const aspect = canvasWidth / canvasHeight;
  // Fit to width first: the whole width shown, height follows the aspect.
  const fitToWidthHeight = viewportWidth / aspect;
  const floorHeight = minHeightFraction * viewportHeight;

  if (fitToWidthHeight > viewportHeight) {
    // Piece taller than the viewport (near-square / very short session):
    // fit to height instead. displayWidth ends up <= viewportWidth.
    return {
      displayWidth: viewportHeight * aspect,
      displayHeight: viewportHeight,
      scrollable: false,
      startAtLeft: false,
    };
  }

  if (fitToWidthHeight < floorHeight) {
    // Long skinny piece (a 5-min session is ~19:1): fitting to width would
    // crush it to an unreadable sliver, so clamp to the floor height and
    // let the wrap scroll horizontally from the left.
    return {
      displayWidth: floorHeight * aspect,
      displayHeight: floorHeight,
      scrollable: true,
      startAtLeft: true,
    };
  }

  // The whole piece fits comfortably between the floor and the viewport
  // height (>= floor is inclusive): fit to width, no scroll.
  return {
    displayWidth: viewportWidth,
    displayHeight: fitToWidthHeight,
    scrollable: false,
    startAtLeft: false,
  };
}

const app = typeof document === 'undefined' ? null : document.querySelector<HTMLDivElement>('#app');

if (app) {
  app.innerHTML = `
    <div class="ms-canvas-wrap" id="ms-canvas-wrap">
      <canvas id="ms-canvas" class="ms-canvas" width="${CANVAS_HEIGHT_PX}" height="${CANVAS_HEIGHT_PX}"></canvas>
    </div>

    <div class="ms-left-stack" id="ms-left-stack">
      <header class="ms-float ms-header" id="ms-header">
        <span class="ms-wordmark">movescape</span>
        <span id="ms-timer" class="ms-timer" hidden>00:00</span>
      </header>

      <div class="ms-float ms-control-zone" id="ms-controls">
        <button id="ms-start-camera" type="button" class="ms-btn">[ Start ]</button>
        <span id="ms-activating" class="ms-activating-label" hidden>Starting…</span>
        <button id="ms-pause" type="button" class="ms-btn" hidden>[ Pause ]</button>
        <button id="ms-finish" type="button" class="ms-btn" hidden>[ Finish ]</button>
        <button id="ms-restart" type="button" class="ms-btn" hidden>[ Restart ]</button>
        <button id="ms-save-piece" type="button" class="ms-btn" hidden>[ Save this piece ]</button>
        <button id="ms-keep-moving" type="button" class="ms-btn" hidden>[ Keep moving ]</button>
        <button id="ms-discard-piece" type="button" class="ms-btn" hidden>[ Discard ]</button>
      </div>

      <p id="ms-error" class="ms-float ms-status-line" hidden></p>
      <p id="ms-finish-status" class="ms-float ms-status-line" hidden></p>

      <div id="ms-idle-block" class="ms-idle-block">
        <div class="ms-panel ms-explainer" id="ms-explainer">
          <p>Make art with your movement.</p>
          <p>Your camera feed stays on this device. Nothing is ever uploaded.</p>
          <p>Move however you want. The art responds live while you move (or don't move).</p>
          <p>Please use a desktop browser for the best experience.</p>
        </div>
        <div class="ms-float ms-palette-row" id="ms-palette-controls"></div>
      </div>
    </div>

    <div class="ms-float ms-pip" id="ms-preview-pip" hidden>
      <div id="ms-preview"></div>
      <button id="ms-toggle-preview" type="button" class="ms-btn">[ hide camera ]</button>
    </div>

    <div class="ms-magic-dock" id="ms-magic-dock"></div>
    <button id="ms-magic-toggle" type="button" class="ms-btn ms-float ms-magic-toggle" hidden>[ Show the magic ]</button>

    <div class="ms-modal-backdrop" id="ms-restart-dialog" hidden>
      <div class="ms-panel ms-modal">
        <p class="ms-modal-title">Restart?</p>
        <p>This discards the current piece and starts a fresh one. Your camera and magic display settings carry over.</p>
        <div class="ms-modal-actions">
          <button id="ms-restart-cancel" type="button" class="ms-btn">[ Cancel ]</button>
          <button id="ms-restart-do" type="button" class="ms-btn">[ Restart ]</button>
        </div>
      </div>
    </div>

    <div id="ms-readout"></div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    :root {
      --paper: #f7f0e3;
      --ink: #241a17;
      --scrim: rgba(247, 240, 227, 0.88);
    }

    html, body {
      margin: 0;
      height: 100%;
      overflow: hidden;
      background: var(--paper);
    }

    body {
      font-family: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
      color: var(--ink);
    }

    .ms-canvas-wrap {
      position: fixed;
      inset: 0;
      overflow-x: auto;
      overflow-y: hidden;
      background: var(--paper);
      z-index: 0;
    }
    .ms-canvas { height: 100%; width: auto; display: block; }

    /* Roadmap item A ("Finish preview"): at Finish the canvas switches to a
       fitted "show the whole piece" display. The wrap becomes a flex box
       that letterboxes the canvas in --paper; setCanvasDisplayMode('fit')
       sets the canvas element's own width/height inline, overriding the
       height:100%/width:auto rule above. overflow-x:auto is inherited from
       the base .ms-canvas-wrap rule so long pieces stay scrollable.
       Flexbox scroll gotcha: with justify-content:center a canvas wider
       than the wrap overflows unreachably on the left, so the scrollable
       variant packs to flex-start instead (setCanvasDisplayMode then parks
       scrollLeft at 0). align-items:center keeps the vertical letterbox in
       both cases. */
    .ms-canvas-wrap.ms-fit { display: flex; align-items: center; justify-content: center; }
    .ms-canvas-wrap.ms-fit-scroll { justify-content: flex-start; }

    .ms-left-stack {
      position: fixed;
      top: 16px;
      left: 16px;
      z-index: 10;
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 380px;
    }

    .ms-float { background: var(--scrim); padding: 8px 12px; }

    .ms-header { display: flex; align-items: baseline; gap: 24px; }
    .ms-wordmark { font-size: 14px; font-weight: 500; letter-spacing: 0.04em; }
    .ms-timer { font-size: 13px; font-weight: 400; font-variant-numeric: tabular-nums; }

    /* nowrap + max-content so the finished-state row
       ([ Save this piece ] [ Keep moving ] [ Discard ]) stays on one line;
       it may extend past the 380px left-stack width, which is fine (its own
       scrim background grows with it and nothing clips). */
    .ms-control-zone { display: flex; align-items: center; gap: 10px; flex-wrap: nowrap; width: max-content; max-width: calc(100vw - 32px); }

    .ms-btn {
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      background: none;
      border: none;
      color: var(--ink);
      cursor: pointer;
      padding: 15px 10px;
      margin: 0;
      white-space: nowrap;
      transition: transform 40ms ease, background-color 40ms ease;
    }
    .ms-btn:disabled { opacity: 0.5; cursor: default; }
    /* Press feedback: shows only while held, reverts on release. No colour
       (governing style-guide principle) -- a faint ink wash + 1px nudge. */
    .ms-btn:active:not(:disabled) { transform: translateY(1px); background: rgba(36, 26, 23, 0.08); }

    .ms-activating-label { font-size: 13px; font-weight: 400; opacity: 0.75; }
    .ms-status-line { font-size: 13px; font-weight: 400; }

    .ms-idle-block { display: flex; flex-direction: column; gap: 12px; }

    .ms-panel {
      border: 1px solid rgba(36, 26, 23, 0.3);
      background: var(--scrim);
      padding: 16px;
    }

    .ms-explainer { width: 360px; max-width: 100%; }
    .ms-explainer p { margin: 0 0 12px; font-size: 14px; font-weight: 400; line-height: 1.6; }
    .ms-explainer p:last-child { margin-bottom: 0; }

    .ms-palette-row { display: flex; flex-wrap: wrap; gap: 8px; }

    .ms-pip {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 10;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }
    .ms-preview-video { display: block; width: 160px; height: auto; transform: scaleX(-1); background: #000; }

    .ms-magic-dock {
      position: fixed;
      left: 16px;
      bottom: 64px;
      width: 340px;
      min-width: 260px;
      max-width: calc(100vw - 32px);
      /* Width is user-resizable by dragging the right-edge handle
         (createMagicPanel builds it); the chosen width is persisted. */
      z-index: 10;
    }
    .ms-magic-toggle { position: fixed; left: 16px; bottom: 16px; z-index: 11; }
    #ms-magic-toggle[hidden] { display: none; }

    .ms-modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 100;
      background: rgba(36, 26, 23, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .ms-modal { width: 440px; max-width: calc(100vw - 32px); }
    .ms-modal p { margin: 0 0 12px; font-size: 14px; line-height: 1.6; }
    .ms-modal-title { font-weight: 500; }
    .ms-modal-actions { display: flex; gap: 24px; margin-top: 4px; }

    #ms-readout { display: none; }

    /* Several floating containers below set their own non-default
       display (flex) via a class rule, which -- being an author-origin
       rule -- otherwise beats the browser's UA-stylesheet default of
       [hidden] { display: none; } regardless of source order (origin
       precedence, not specificity, decides that tie). Without these
       explicit, higher-specificity overrides, toggling the native
       hidden DOM property on these particular elements would silently
       do nothing. */
    #ms-idle-block[hidden],
    #ms-preview-pip[hidden],
    #ms-restart-dialog[hidden] {
      display: none;
    }

    /* Dev-only tools zone (UX Stage 3): one collapsed corner control instead
       of three scattered affordances. Deliberately inverted ink/paper --
       "system / debug surface", visibly NOT the product's Typewriter Utility
       chrome -- and fixed top-right, clear of every real control. The whole
       thing is created only inside import.meta.env.DEV blocks, so a
       production build has no dev DOM at all. */
    .ms-dev-zone {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 30;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 12px;
    }
    .ms-dev-toggle {
      font: inherit;
      cursor: pointer;
      background: #241a17;
      color: #f7f0e3;
      border: none;
      padding: 6px 10px;
      letter-spacing: 0.06em;
      transition: transform 40ms ease;
    }
    .ms-dev-toggle:active { transform: translateY(1px); }
    .ms-dev-panel {
      background: #17110e;
      color: #efe7d9;
      border: 1px solid #4a3f38;
      padding: 12px;
      width: 360px;
      max-width: calc(100vw - 32px);
      max-height: 80vh;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .ms-dev-panel input[type='range'] { accent-color: #c98f7a; }
    .ms-dev-panel[hidden] { display: none; }
    .ms-dev-panel-head { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.6; }
    .ms-dev-panel button {
      font: inherit;
      padding: 6px 10px;
      border: 1px solid #4a3f38;
      background: #241a17;
      color: #efe7d9;
      cursor: pointer;
      transition: transform 40ms ease, background-color 40ms ease;
    }
    .ms-dev-panel button:hover { background: #2e221c; }
    .ms-dev-panel button:active { transform: translateY(1px); background: #362a22; }
    .ms-dev-panel button:disabled { opacity: 0.5; cursor: default; }
  `;
  document.head.appendChild(style);

  const readoutContainerRef = app.querySelector<HTMLDivElement>('#ms-readout');
  const previewContainerRef = app.querySelector<HTMLDivElement>('#ms-preview');
  const errorElRef = app.querySelector<HTMLParagraphElement>('#ms-error');
  const startCameraBtnRef = app.querySelector<HTMLButtonElement>('#ms-start-camera');
  const pauseBtnRef = app.querySelector<HTMLButtonElement>('#ms-pause');
  const previewToggleBtnRef = app.querySelector<HTMLButtonElement>('#ms-toggle-preview');
  const previewPipElRef = app.querySelector<HTMLDivElement>('#ms-preview-pip');
  const finishBtnRef = app.querySelector<HTMLButtonElement>('#ms-finish');
  const restartBtnRef = app.querySelector<HTMLButtonElement>('#ms-restart');
  const activatingElRef = app.querySelector<HTMLSpanElement>('#ms-activating');
  const canvasElRef = app.querySelector<HTMLCanvasElement>('#ms-canvas');
  const canvasWrapElRef = app.querySelector<HTMLDivElement>('#ms-canvas-wrap');
  const paletteControlsElRef = app.querySelector<HTMLDivElement>('#ms-palette-controls');
  const idleBlockElRef = app.querySelector<HTMLDivElement>('#ms-idle-block');
  const timerElRef = app.querySelector<HTMLSpanElement>('#ms-timer');
  const finishStatusElRef = app.querySelector<HTMLParagraphElement>('#ms-finish-status');
  const savePieceBtnRef = app.querySelector<HTMLButtonElement>('#ms-save-piece');
  const keepMovingBtnRef = app.querySelector<HTMLButtonElement>('#ms-keep-moving');
  const discardPieceBtnRef = app.querySelector<HTMLButtonElement>('#ms-discard-piece');
  const restartDialogElRef = app.querySelector<HTMLDivElement>('#ms-restart-dialog');
  const restartCancelBtnRef = app.querySelector<HTMLButtonElement>('#ms-restart-cancel');
  const restartDoBtnRef = app.querySelector<HTMLButtonElement>('#ms-restart-do');
  const magicDockElRef = app.querySelector<HTMLDivElement>('#ms-magic-dock');
  const magicToggleBtnRef = app.querySelector<HTMLButtonElement>('#ms-magic-toggle');

  if (
    readoutContainerRef &&
    previewContainerRef &&
    errorElRef &&
    startCameraBtnRef &&
    pauseBtnRef &&
    previewToggleBtnRef &&
    previewPipElRef &&
    finishBtnRef &&
    restartBtnRef &&
    activatingElRef &&
    canvasElRef &&
    canvasWrapElRef &&
    paletteControlsElRef &&
    idleBlockElRef &&
    timerElRef &&
    finishStatusElRef &&
    savePieceBtnRef &&
    keepMovingBtnRef &&
    discardPieceBtnRef &&
    restartDialogElRef &&
    restartCancelBtnRef &&
    restartDoBtnRef &&
    magicDockElRef &&
    magicToggleBtnRef
  ) {
    // Re-bind to fresh consts so their (non-null) type is fixed at this
    // point — TypeScript would otherwise re-widen the outer refs to
    // `T | null` wherever they're read from inside the nested functions
    // below, since it can't prove a closure won't run before this guard.
    const readoutEl = readoutContainerRef;
    const previewEl = previewContainerRef;
    const errorEl = errorElRef;
    const startCameraBtn = startCameraBtnRef;
    const pauseBtn = pauseBtnRef;
    const previewToggleBtn = previewToggleBtnRef;
    const previewPipEl = previewPipElRef;
    const finishBtn = finishBtnRef;
    const restartBtn = restartBtnRef;
    const activatingEl = activatingElRef;
    const canvasEl = canvasElRef;
    const canvasWrapEl = canvasWrapElRef;
    const paletteControlsEl = paletteControlsElRef;
    const idleBlockEl = idleBlockElRef;
    const timerEl = timerElRef;
    const finishStatusEl = finishStatusElRef;
    const savePieceBtn = savePieceBtnRef;
    const keepMovingBtn = keepMovingBtnRef;
    const discardPieceBtn = discardPieceBtnRef;
    const restartDialogEl = restartDialogElRef;
    const restartCancelBtn = restartCancelBtnRef;
    const restartDoBtn = restartDoBtnRef;
    // Dev-only tools zone (UX Stage 3): the collapsible panel the three
    // import.meta.env.DEV blocks below mount into. Created lazily in the
    // first of those blocks; stays undefined (and unreferenced) in production.
    let devZoneEl: HTMLElement | undefined;
    const magicDockEl = magicDockElRef;
    const magicToggleBtn = magicToggleBtnRef;
    // getContext('2d') is effectively never null for a freshly-created
    // <canvas> in a real browser; guarded rather than asserted so a
    // hypothetical unsupported environment degrades to "no art rendering"
    // instead of a thrown error, without disabling the rest of the app.
    const canvasCtx = canvasEl.getContext('2d');

    const readout = createParamsReadout(readoutEl);

    // "Show the magic" (UX Stage 2): a user-facing panel + skeleton overlay,
    // both created once and reused. The panel is driven by its own
    // animation-frame loop (startMagicRaf) only while shown; the skeleton
    // overlay is layered over the camera-preview <video> and only draws
    // while the panel is shown AND the preview is visible.
    const magicPanel = createMagicPanel(magicDockEl);
    const skeletonOverlay = createSkeletonOverlay(previewEl);
    let magicShown = false;
    let magicRaf: number | null = null;
    // Latest MovementParams seen by the params listener -- the magic panel's
    // readout + code annotation poll this each frame (the live loop only
    // exposes the mechanism sample, not the raw params).
    let latestParams: MovementParams = {
      v: MOVEMENT_PARAMS_VERSION,
      expansion: 0,
      speed: 0,
      symmetry: 0,
    };
    // Created once, reused across every session/restart -- see the factory's
    // own doc comment above for why this is safe (each create() call hands
    // back an independent offscreen canvas; the factory itself holds no
    // per-session state). Each startLiveLoop() call below constructs a
    // fresh LiveRenderLoop (and therefore a fresh LiveCompositor internally,
    // src/app/live-render-loop.ts), which is what guarantees a new
    // session's buffers start empty -- no explicit reset() call needed here.
    const offscreenBufferFactory = createDomOffscreenBufferFactory();
    // Created once, reused across every save -- see createDomExportRenderCanvasFactory's
    // own doc comment: unlike offscreenBufferFactory's grow-in-place buffers,
    // each create() call here is a fresh, independent, exactly-sized canvas,
    // so the factory itself needs no per-session state either.
    const exportRenderCanvasFactory = createDomExportRenderCanvasFactory();
    let liveLoop: LiveRenderLoop | null = null;
    let selectedPaletteId: BotanicalPaletteId = 'default';
    // Opened once at app startup; awaited wherever a save/import actually
    // needs it (M5 Stage 3 -- recipe persistence). A rejected open (no
    // IndexedDB available) surfaces as an error only at the point of use,
    // not as a startup crash -- the live art experience works with zero
    // storage available, saving just won't.
    const recipeStorePromise: Promise<RecipeStore> = openRecipeStore();
    // Fixed once per session at "Start camera" time (see beginSession) --
    // spec Part 3: "the first session of the day is index 0, the second
    // index 1." Reused verbatim across any mid-session palette-switch
    // restart, since that's still the same session/performance, not a new
    // one. Recomputing this per palette switch would be both wasteful (an
    // extra store query) and wrong once a save has happened mid-session.
    let currentSessionIndex = 0;
    // Dev-only pose tuning (session 012): the webcam adapter's sensor-noise
    // floor (POSE_PARAM_TUNING.SPEED_JITTER_FLOOR) can only really be
    // calibrated against a real camera, not blind -- this tracks whatever
    // the founder last set live via the dev-only slider below, so a
    // re-tuned value survives a camera restart within the same page load
    // instead of resetting to the shipped default every time.
    let currentSpeedJitterFloor: number = POSE_PARAM_TUNING.SPEED_JITTER_FLOOR;
    // The exact WorldOverrides startLiveLoop last used to build currentWorld
    // -- captured so a saved recipe's userChoices matches what was actually
    // rendered, not recomputed from possibly-stale UI state.
    let currentOverrides: WorldOverrides = {};
    // The finished session's own recording + world + style, captured by
    // finishSession() and consumed by saveSession()/discardSession()/
    // keepMovingSession() -- null whenever no finished-but-undecided
    // session is pending.
    // pendingStyle is saveSession()'s handle onto the frozen scene state
    // (style.scene()/sceneLayers() below) for the high-resolution export
    // render -- the same style instance the live loop was just painting
    // from, still holding every element ever drawn this session (permanent
    // ink) since nothing resets it between finishSession() and this save.
    let pendingRecording: MovementRecording | null = null;
    let pendingWorld: World | null = null;
    let pendingStyle: StyleRenderer | null = null;
    const pauseGate = createPauseGate((params, timestampMs) => {
      latestParams = params;
      readout.update(params, timestampMs);
      liveLoop?.feed(params);
    });
    const activation = createActivationTokenSource();

    let activeAdapter: InputAdapter | null = null;
    let pendingAdapter: InputAdapter | null = null;
    let previewVideo: HTMLVideoElement | null = null;
    // Assigned once the dev-only slider button exists, so it can be
    // disabled/enabled alongside "Start camera" during activation.
    let useSlidersBtn: HTMLButtonElement | null = null;
    // Tracks whichever adapter kind was last activated (UX Stage 1's
    // Restart flow) -- confirmed Restart starts a fresh session with the
    // same kind of input source that was already running, camera or the
    // dev-only slider adapter, rather than always defaulting back to camera.
    let lastAdapterKind: 'camera' | 'sliders' = 'camera';

    // Handle onto the most recently created World (set at the bottom of
    // startLiveLoop), so the dev-only tuning panel (built lazily, see the
    // second import.meta.env.DEV block below) can initialize its world-knob
    // sliders from the world's actual current seed-derived values instead of
    // 0. Harmless and string-free in production -- stays null forever there.
    let currentWorld: World | null = null;
    // Same rationale as currentWorld above, one level further out:
    // finishSession() copies this into pendingStyle so saveSession() can
    // still reach the style's current scene state after startLiveLoop()
    // rebuilds a fresh style for the *next* session.
    let currentStyle: StyleRenderer | null = null;

    // Dev tuning panel hand-off state. These four stay inert (null/undefined,
    // never read meaningfully) in a production build, where the panel's own
    // block below is dead-code-eliminated entirely -- see that block for the
    // one clear rule governing how panelWorldOverrides and palette-preset
    // overrides interact once the founder starts hand-tuning.
    let manualOverridesActive = false;
    let panelWorldOverrides: WorldOverrides | undefined;
    let panelTuningConfig: Partial<BotanicalTuningConfig> | undefined;
    let onPaletteSelected: ((paletteId: BotanicalPaletteId) => void) | null = null;

    /**
     * Palette selection (M4 rebuild) flows through one raw-0-1 `paletteIndex`
     * world knob rather than a preset's own WorldOverrides object directly --
     * curated color lists (palettes.ts) aren't numeric, so there's nothing
     * else to override. Lands mid-bucket so botanical.ts's own
     * `Math.floor(raw * presets.length)` mapping reliably resolves back to
     * `paletteId`.
     */
    function paletteIndexOverride(paletteId: BotanicalPaletteId): WorldOverrides {
      const index = BOTANICAL_PALETTE_PRESETS.findIndex((preset) => preset.id === paletteId);
      const safeIndex = index === -1 ? 0 : index;
      return { paletteIndex: (safeIndex + 0.5) / BOTANICAL_PALETTE_PRESETS.length };
    }

    /**
     * (Re)starts the Botanical live-preview loop against a fresh World built
     * from the real persisted userId + today's date (M4's live-wiring
     * decision — see docs/HANDOFF.md). Called on session start and whenever
     * the palette selection changes while a session is already running, so
     * switching palettes recolors the piece from a fresh spawn rather than
     * leaving already-grown geometry in its old colors.
     */
    function startLiveLoop(): void {
      if (!canvasCtx) return;
      liveLoop?.stop();
      const userId = getOrCreateUserId();
      const worldSeed = deriveWorldSeed(userId, formatLocalDate(new Date()));
      // Once the dev tuning panel exists and the founder has touched a
      // world-knob slider, manualOverridesActive latches true for the rest
      // of the session: the panel's own fully-populated WorldOverrides
      // object takes over completely, replacing the palette-preset lookup
      // rather than merging with it. Both stay their production no-op
      // values (false / undefined) in a build where the panel itself was
      // dead-code-eliminated, so this line is a pure pass-through there.
      const overrides = manualOverridesActive ? panelWorldOverrides : paletteIndexOverride(selectedPaletteId);
      const world = createWorld(worldSeed, currentSessionIndex, overrides);
      currentWorld = world;
      currentOverrides = overrides ?? {};
      // Named distinctly from the top-level `style` <style> element in this
      // same closure (line ~134) -- shares no relationship with it.
      const botanicalStyle = createBotanicalStyle(panelTuningConfig);
      currentStyle = botanicalStyle;
      liveLoop = createLiveRenderLoop(
        botanicalStyle,
        world,
        // CanvasRenderingContext2D.fillStyle is `string | CanvasGradient |
        // CanvasPattern`; CanvasLike only needs the plain-string subset this
        // app ever assigns, so the cast is safe (same pattern already used
        // in src/engine/pixel-determinism.test.ts for @napi-rs/canvas).
        canvasCtx as unknown as CanvasLike,
        CANVAS_HEIGHT_PX,
        resizeCanvas,
        () => pauseGate.isPaused(),
        offscreenBufferFactory,
      );
    }

    /**
     * The Scroll (M5 Stage 2): called every frame by the live loop with the
     * size the canvas needs to be to fit the current scene. Resizing a
     * canvas element's width/height attributes clears its pixel contents,
     * but that's harmless here -- the live loop already does a full
     * clear-and-redraw (paper ground + renderScene) every frame regardless,
     * so nothing relies on pixels persisting across a resize. Auto-scrolls
     * the wrapper so the growth front (the canvas's right edge) stays in
     * view as the canvas widens, rather than leaving the viewport parked at
     * whatever it was scrolled to before the resize.
     */
    function resizeCanvas(size: CanvasSize): void {
      canvasEl.width = size.width;
      canvasEl.height = size.height;
      canvasWrapEl.scrollLeft = canvasWrapEl.scrollWidth;
    }

    function stopLiveLoop(): void {
      liveLoop?.stop();
      liveLoop = null;
      canvasCtx?.clearRect(0, 0, canvasEl.width, canvasEl.height);
      // Reset to the idle default size rather than leaving a session's full
      // grown width on screen once it's stopped.
      canvasEl.width = CANVAS_HEIGHT_PX;
      canvasEl.height = CANVAS_HEIGHT_PX;
      canvasWrapEl.scrollLeft = 0;
      setCanvasDisplayMode('tracking');
    }

    /**
     * Roadmap item A ("Finish preview"): swap the full-bleed canvas between
     * the live "tracking" display (stylesheet-driven height:100%/width:auto,
     * right-edge pinned every frame by resizeCanvas) and a one-shot "fit"
     * display that shows the whole finished piece letterboxed in the wrap.
     * Pure display change -- the canvas backing store is never touched.
     *
     * Fit dimensions are computed once here from the current viewport and
     * are deliberately NOT recomputed on a later window resize: the
     * finished state is transient (Save / Keep moving / Discard all leave
     * it within seconds), so a stale fit after a resize is acceptable for
     * v1, and no window resize handler exists to hook.
     */
    function setCanvasDisplayMode(mode: 'tracking' | 'fit'): void {
      if (mode === 'tracking') {
        canvasWrapEl.classList.remove('ms-fit', 'ms-fit-scroll');
        // Clear the inline sizes so .ms-canvas { height:100%; width:auto }
        // takes over again and resizeCanvas's right-edge tracking resumes.
        canvasEl.style.width = '';
        canvasEl.style.height = '';
        return;
      }
      const fit = computeFitDimensions(
        canvasEl.width,
        canvasEl.height,
        window.innerWidth,
        window.innerHeight,
        0.4,
      );
      canvasEl.style.width = `${fit.displayWidth}px`;
      canvasEl.style.height = `${fit.displayHeight}px`;
      canvasWrapEl.classList.add('ms-fit');
      // Flexbox scroll gotcha: justify-content:center makes the left
      // overflow of an over-wide canvas unreachable, so only center when it
      // fits; when scrollable, pack to flex-start and park at the left.
      canvasWrapEl.classList.toggle('ms-fit-scroll', fit.scrollable);
      if (fit.scrollable || fit.startAtLeft) {
        canvasWrapEl.scrollLeft = 0;
      }
    }

    // UX Stage 1 header timer: polls liveLoop.getElapsedMs() every ~250ms
    // while a session is live or finished. Pause-aware for free (frozen
    // while getElapsedMs() is frozen, i.e. while paused or once stop() has
    // been called) -- this poll just formats and displays whatever value
    // getElapsedMs() currently reports.
    let timerInterval: ReturnType<typeof setInterval> | null = null;

    function formatElapsed(ms: number): string {
      const totalSeconds = Math.floor(ms / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    function updateTimerDisplay(): void {
      timerEl.textContent = formatElapsed(liveLoop?.getElapsedMs() ?? 0);
    }

    function startTimerPolling(): void {
      timerEl.hidden = false;
      updateTimerDisplay();
      if (timerInterval !== null) return;
      timerInterval = setInterval(updateTimerDisplay, 250);
    }

    function stopTimerPolling(): void {
      if (timerInterval !== null) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      timerEl.hidden = true;
      timerEl.textContent = '00:00';
    }

    function showError(message: string): void {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }

    function clearError(): void {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }

    function hidePreview(): void {
      if (previewVideo) {
        // Detach so nothing keeps painting; mirroring stays CSS-only and the
        // stream/track data itself is never touched (spec Part 3).
        previewVideo.srcObject = null;
        previewVideo.remove();
        previewVideo = null;
      }
      previewToggleBtn.textContent = '[ show camera ]';
    }

    function showPreview(): void {
      const stream = activeAdapter?.previewStream?.() ?? null;
      if (!stream) return;
      const video = document.createElement('video');
      video.className = 'ms-preview-video';
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.srcObject = stream;
      previewEl.appendChild(video);
      previewVideo = video;
      void video.play().catch(() => {
        // Autoplay can be rejected by the browser; the preview is a pure UI
        // affordance, so a rejected play() here is not an app-level error.
      });
      previewToggleBtn.textContent = '[ hide camera ]';
    }

    /** Show/hide the whole camera PiP based on whether the active adapter has a live stream. */
    function refreshPreviewAvailability(): void {
      const stream = activeAdapter?.previewStream?.() ?? null;
      previewPipEl.hidden = !stream;
      if (!stream) hidePreview();
    }

    function setPaused(paused: boolean): void {
      if (paused) {
        pauseGate.pause();
        pauseBtn.textContent = '[ Resume ]';
        readoutEl.classList.add('ms-paused');
      } else {
        pauseGate.resume();
        pauseBtn.textContent = '[ Pause ]';
        readoutEl.classList.remove('ms-paused');
      }
    }

    function setStartButtonsDisabled(disabled: boolean): void {
      startCameraBtn.disabled = disabled;
      if (useSlidersBtn) useSlidersBtn.disabled = disabled;
      activatingEl.hidden = !disabled;
    }

    type ControlRow = 'idle' | 'live' | 'finished';

    /**
     * Swaps the control zone's contents by state (UX Stage 1 -- one row,
     * one DOM location, throughout the whole flow; only its *contents*
     * change). "activating" is deliberately not a fourth row here: visually
     * it's just the idle row with `[ Start ]` disabled plus the "Starting…"
     * label, handled by setStartButtonsDisabled(true) layered on top of the
     * idle row rather than a distinct row of its own.
     */
    function setControlRow(row: ControlRow): void {
      startCameraBtn.hidden = row !== 'idle';
      pauseBtn.hidden = row !== 'live';
      finishBtn.hidden = row !== 'live';
      restartBtn.hidden = row !== 'live';
      savePieceBtn.hidden = row !== 'finished';
      keepMovingBtn.hidden = row !== 'finished';
      discardPieceBtn.hidden = row !== 'finished';
      idleBlockEl.hidden = row !== 'idle';
      // "Show the magic" is a live/paused-session affordance only (mockup
      // frame 4 shows it during Live) -- never idle, never in the
      // finished/decision state. Leaving 'live' also force-hides the panel
      // itself, not just its toggle.
      magicToggleBtn.hidden = row !== 'live';
      if (row !== 'live' && magicShown) setMagicShown(false);
    }

    /**
     * The magic panel's own animation-frame loop: while shown, polls the
     * live loop's mechanism sample + the latest params into the panel, and
     * drives the pose-skeleton overlay. The overlay only draws while the
     * camera preview <video> is actually mounted (camera hidden -> code +
     * readout keep updating, skeleton stops) -- it never gates tracking.
     */
    function magicFrame(): void {
      if (!magicShown) return;
      magicPanel.update(liveLoop?.getMechanismSample() ?? null, latestParams);
      const previewVisible = previewVideo !== null;
      skeletonOverlay.setActive(previewVisible);
      skeletonOverlay.draw(previewVisible ? (activeAdapter?.latestPose?.() ?? null) : null);
      magicRaf = requestAnimationFrame(magicFrame);
    }

    function startMagicRaf(): void {
      if (magicRaf === null) magicRaf = requestAnimationFrame(magicFrame);
    }

    function stopMagicRaf(): void {
      if (magicRaf !== null) {
        cancelAnimationFrame(magicRaf);
        magicRaf = null;
      }
      skeletonOverlay.setActive(false);
      skeletonOverlay.draw(null);
    }

    function setMagicShown(shown: boolean): void {
      magicShown = shown;
      magicPanel.setShown(shown);
      magicToggleBtn.textContent = shown ? '[ Hide the magic ]' : '[ Show the magic ]';
      if (shown) startMagicRaf();
      else stopMagicRaf();
    }

    /**
     * Stops both the pending (mid-start) and active adapters and resets the
     * UI. Does NOT touch the activation token — callers that need to
     * invalidate an in-flight activate() do that explicitly, so this can be
     * shared with the start of a new activate() without a new activation
     * immediately invalidating itself.
     */
    function resetAdaptersAndUi(): void {
      if (pendingAdapter) {
        pendingAdapter.stop();
        pendingAdapter = null;
      }
      if (activeAdapter) {
        activeAdapter.stop();
        activeAdapter = null;
        readout.reset();
      }
      stopLiveLoop();
      stopTimerPolling();
      hidePreview();
      previewPipEl.hidden = true;
      pauseGate.reset();
      setPaused(false);
      latestParams = { v: MOVEMENT_PARAMS_VERSION, expansion: 0, speed: 0, symmetry: 0 };
      // A full abort: any not-yet-decided finished session is discarded
      // too, not left in limbo behind a hidden panel.
      pendingRecording = null;
      pendingWorld = null;
      pendingStyle = null;
      finishStatusEl.hidden = true;
      finishStatusEl.textContent = '';
      finishStatusEl.classList.remove('ms-status-error');
      setControlRow('idle');
      setStartButtonsDisabled(false);
    }

    /**
     * Ends capture without discarding the piece (UX Stage 1): freezes the
     * render loop in place (no clear-and-reset -- the finished piece stays
     * on screen for the Save/Keep-moving/Discard decision) and pauses the
     * gate so no further samples reach liveLoop.feed(), but -- unlike the
     * old Stop flow -- leaves the adapter/camera stream running untouched.
     * The camera PiP therefore stays exactly as visible/hidden as it
     * already was, matching the Finish mockup frame. saveSession(),
     * discardSession(), and keepMovingSession() are the only three ways out
     * of the pending state this leaves behind.
     */
    function finishSession(): void {
      if (!liveLoop || !currentWorld || !currentStyle) return;
      pendingRecording = liveLoop.getRecording();
      pendingWorld = currentWorld;
      pendingStyle = currentStyle;
      liveLoop.stop(); // freezes the loop only -- does not touch canvas contents, unlike stopLiveLoop()
      pauseGate.pause(); // same mechanism the Pause button uses -- stops new samples without touching the adapter/camera
      setControlRow('finished');
      // Disabled for the life of the pending decision so starting a new
      // session can't silently overwrite currentWorld/currentSessionIndex
      // out from under the still-undecided piece.
      setStartButtonsDisabled(true);
      finishStatusEl.hidden = false;
      finishStatusEl.textContent = 'This piece is yours.';
      finishStatusEl.classList.remove('ms-status-error');
      // Roadmap item A: the canvas backing store already holds the whole
      // piece (liveLoop.stop() above froze it). Switch from right-edge
      // tracking to the fitted "show the whole piece" display so the user
      // sees the entire artwork, not just its end. No entry animation.
      setCanvasDisplayMode('fit');
    }

    /**
     * "Keep moving" (UX Stage 1): the undo for Finish. Only valid from the
     * genuinely finished/pending state. Resumes the pause gate (syncing the
     * Pause button's own label regardless of whether the session happened
     * to already be paused before Finish was clicked) and re-schedules the
     * render loop exactly where stop() froze it -- the same style/world/
     * recording/accumulator state, so the piece keeps growing as one
     * continuous performance. The camera PiP needs no action: Finish never
     * touched it.
     */
    function keepMovingSession(): void {
      if (!liveLoop || !pendingWorld || !pendingStyle) return;
      // Roadmap item A: undo the fitted "show the whole piece" display so
      // resizeCanvas's right-edge tracking resumes as the piece keeps growing.
      setCanvasDisplayMode('tracking');
      setPaused(false);
      liveLoop.resume();
      pendingRecording = null;
      pendingWorld = null;
      pendingStyle = null;
      setControlRow('live');
    }

    /** Triggers a browser download of `json` as a file named `filename`. Same object-URL-plus-anchor technique as image-export.ts, inlined here since this is the only caller of a text (not canvas-pixel) download in the app. */
    function downloadJsonFile(json: string, filename: string): void {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    }

    /**
     * A real ender (UX Stage 1): unlike finishSession(), this genuinely
     * tears the adapter/camera down -- finishSession() no longer does that
     * itself, so Discard has to pick up that responsibility.
     */
    function discardSession(): void {
      pendingRecording = null;
      pendingWorld = null;
      pendingStyle = null;
      activeAdapter?.stop();
      activeAdapter = null;
      hidePreview();
      previewPipEl.hidden = true;
      stopLiveLoop();
      stopTimerPolling();
      finishStatusEl.hidden = true;
      finishStatusEl.textContent = '';
      setControlRow('idle');
      setStartButtonsDisabled(false);
    }

    /**
     * Persists the pending recording as a PieceRecipe (IndexedDB -- the
     * permanent record) and downloads the frozen canvas as a PNG (the
     * instant-viewing/sharing artifact) -- spec Part 2: "you save it — an
     * image at minimum, plus its tiny recipe." The recipe JSON download
     * itself is a separate, optional backup affordance (see the "Import
     * recipe backup" control below), not part of this routine save path.
     */
    async function saveSession(): Promise<void> {
      if (!pendingRecording || !pendingWorld || !pendingStyle) return;
      savePieceBtn.disabled = true;
      keepMovingBtn.disabled = true;
      discardPieceBtn.disabled = true;
      finishStatusEl.hidden = false;
      finishStatusEl.classList.remove('ms-status-error');
      finishStatusEl.textContent = 'Saving…';
      try {
        const store = await recipeStorePromise;
        const recipe: PieceRecipe = {
          version: PIECE_RECIPE_VERSION,
          styleId: 'botanical',
          userChoices: currentOverrides,
          worldSeed: pendingWorld.worldSeed,
          sessionIndex: pendingWorld.sessionIndex,
          movementRecording: pendingRecording,
        };
        await store.save(recipe);
        const baseName = `movescape-${recipe.worldSeed}-session${recipe.sessionIndex}`;
        // High-resolution export (founder backlog: exported PNGs were
        // pixelated when zoomed, since this used to just re-encode the live
        // on-screen canvas's own 480px-tall pixels). Re-renders the whole
        // frozen scene fresh, at DEFAULT_EXPORT_SCALE (3x) the live canvas's
        // current pixel size, replicating the live bucket paint order (see
        // export-render.ts's own top doc comment) rather than exporting
        // canvasEl's pixels directly -- canvasEl.width/height here is still
        // whatever size the live loop last resized it to (finishSession()
        // only freezes the loop, it never touches the canvas element), i.e.
        // exactly the "base" 1x size this session's piece actually needs.
        const { canvas: exportCanvas } = renderStyleToExportCanvas(
          pendingStyle,
          recipe.worldSeed,
          { width: canvasEl.width, height: canvasEl.height },
          exportRenderCanvasFactory,
        );
        exportCanvasAsPng(exportCanvas, `${baseName}.png`);
        downloadJsonFile(serializeRecipe(recipe), `${baseName}.json`);
        pendingRecording = null;
        pendingWorld = null;
        pendingStyle = null;
        // The piece is persisted now -- a real ender, so tear the
        // adapter/camera down for real (finishSession() deliberately left
        // them running; see its own doc comment).
        activeAdapter?.stop();
        activeAdapter = null;
        hidePreview();
        previewPipEl.hidden = true;
        finishStatusEl.textContent = 'Saved — image and recipe backup downloaded, stored locally.';
        stopLiveLoop(); // safe to reset the canvas now that the piece is persisted
        stopTimerPolling();
        setControlRow('idle');
        setStartButtonsDisabled(false);
      } catch (err) {
        // Deliberately does NOT tear down the adapter/camera on a failed
        // save: the user can still hit "Keep moving" and retry later
        // instead of being stuck with a lost piece and a dead camera.
        const message = err instanceof Error ? err.message : String(err);
        finishStatusEl.textContent = `Could not save: ${message}`;
        finishStatusEl.classList.add('ms-status-error');
      } finally {
        savePieceBtn.disabled = false;
        keepMovingBtn.disabled = false;
        discardPieceBtn.disabled = false;
      }
    }

    /**
     * Computes this session's sessionIndex (spec Part 3: "the first session
     * of the day is index 0, the second index 1") before the first
     * startLiveLoop() call of a new session, then starts it. A storage
     * failure here (no IndexedDB available) falls back to 0 rather than
     * blocking the live art experience on it -- saveSession() will surface
     * its own error later if storage still isn't reachable by the time the
     * user tries to save.
     */
    async function beginSession(): Promise<void> {
      const userId = getOrCreateUserId();
      const worldSeed = deriveWorldSeed(userId, formatLocalDate(new Date()));
      try {
        const store = await recipeStorePromise;
        currentSessionIndex = await nextSessionIndexFor(store, worldSeed);
      } catch {
        currentSessionIndex = 0;
      }
      startLiveLoop();
    }

    async function activate(adapter: InputAdapter, opts: { autoShowPreview?: boolean } = {}): Promise<void> {
      const autoShowPreview = opts.autoShowPreview ?? true;
      // Claim this activation and supersede any earlier one *before* the
      // await below, so a second click during a slow start() (webcam:
      // getUserMedia + model load can take seconds) is detected reliably —
      // this is the fix for the Stop-leaves-camera-on race: the previous
      // adapter is now tracked as `pendingAdapter` from the moment its
      // start() begins, not only after it resolves, so resetAdaptersAndUi()
      // below can stop it even if it never finished starting.
      const token = activation.next();
      resetAdaptersAndUi();

      pendingAdapter = adapter;
      clearError();
      setStartButtonsDisabled(true);

      try {
        await adapter.start(pauseGate.listener);
        if (!activation.isCurrent(token)) {
          // Superseded while start() was in flight (another activate() or a
          // reset happened) — discard this late resolution instead of
          // wiring a stale adapter into the UI. Belt-and-suspenders
          // alongside the synchronous stop in resetAdaptersAndUi().
          adapter.stop();
          return;
        }
        pendingAdapter = null;
        activeAdapter = adapter;
        setControlRow('live');
        setStartButtonsDisabled(false);
        refreshPreviewAvailability();
        // UX Stage 1: the camera preview defaults to VISIBLE once a session
        // goes live, rather than staying hidden until the user opts in --
        // no-op if refreshPreviewAvailability() just found no stream.
        // Restart's own flow opts out of this (autoShowPreview: false) so
        // it can instead preserve whatever visible/hidden state the
        // preview was already in before the restart.
        if (autoShowPreview) showPreview();
        // Carries a live-tuned pose-sensor value across a restart (dev-only
        // slider, no-op via optional chaining on adapters that don't
        // implement it, e.g. the slider adapter).
        activeAdapter.setSpeedJitterFloor?.(currentSpeedJitterFloor);
        await beginSession();
        startTimerPolling();
      } catch (err) {
        if (!activation.isCurrent(token)) return; // stale failure; a newer activation already owns the UI
        pendingAdapter = null;
        setStartButtonsDisabled(false);
        const message = err instanceof Error ? err.message : String(err);
        showError(`Could not start "${adapter.id}": ${message}`);
      }
    }

    /**
     * Confirmed Restart (UX Stage 1): discards the current piece entirely
     * and starts a brand-new one with the same adapter kind that was
     * running, preserving the camera-preview visible/hidden state across
     * the restart. resetAdaptersAndUi() does the "stop everything" half;
     * this does the "start a fresh session of the same kind" half on top.
     */
    async function performRestart(): Promise<void> {
      const previewWasVisible = previewVideo !== null;
      // Restart carries forward the camera + magic display settings (UX
      // Stage 1 Restart flow / develop.md) rather than resetting them.
      const magicWasShown = magicShown;
      resetAdaptersAndUi();
      try {
        const adapter =
          lastAdapterKind === 'camera'
            ? createWebcamAdapter()
            : (await import('./adapters/sliders')).createSliderAdapter();
        await activate(adapter, { autoShowPreview: false });
        if (previewWasVisible) showPreview();
        if (magicWasShown) setMagicShown(true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showError(`Could not restart: ${message}`);
      }
    }

    startCameraBtn.addEventListener('click', () => {
      void (async () => {
        clearError();
        try {
          const adapter = createWebcamAdapter();
          lastAdapterKind = 'camera';
          await activate(adapter);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          showError(`Could not start camera: ${message}`);
        }
      })();
    });

    finishBtn.addEventListener('click', () => {
      finishSession();
    });

    restartBtn.addEventListener('click', () => {
      restartDialogEl.hidden = false;
    });

    restartCancelBtn.addEventListener('click', () => {
      restartDialogEl.hidden = true;
    });

    restartDoBtn.addEventListener('click', () => {
      restartDialogEl.hidden = true;
      void performRestart();
    });

    savePieceBtn.addEventListener('click', () => {
      void saveSession();
    });

    keepMovingBtn.addEventListener('click', () => {
      keepMovingSession();
    });

    discardPieceBtn.addEventListener('click', () => {
      discardSession();
    });

    pauseBtn.addEventListener('click', () => {
      setPaused(!pauseGate.isPaused());
    });

    previewToggleBtn.addEventListener('click', () => {
      if (previewVideo) {
        hidePreview();
      } else {
        showPreview();
      }
    });

    magicToggleBtn.addEventListener('click', () => {
      setMagicShown(!magicShown);
    });

    // Palette presets (M4 palette system, narrowed in UX Stage 1 -- idle
    // only, see the "Leave alone, but keep working" section of the stage
    // spec: this control no longer appears mid-session, since the mockups
    // never show it live and the clean toolbar takes priority for this
    // stage). Founder-facing, not dev-only, so it's restyled to the
    // bracket-button convention rather than routed to the dev zone.
    for (const preset of BOTANICAL_PALETTE_PRESETS) {
      const paletteBtn = document.createElement('button');
      paletteBtn.type = 'button';
      paletteBtn.className = 'ms-btn';
      paletteBtn.textContent = `[ ${preset.displayName} ]`;
      paletteBtn.addEventListener('click', () => {
        selectedPaletteId = preset.id;
        // No-op in production (onPaletteSelected stays null); in dev, once
        // the tuning panel has taken over manual control, this pre-fills
        // the panel's own paletteIndex slider to the preset's value instead
        // of the preset supplying a second, competing override.
        onPaletteSelected?.(preset.id);
        if (activeAdapter) startLiveLoop();
      });
      paletteControlsEl.appendChild(paletteBtn);
    }

    // Initial state: idle, nothing running yet.
    setControlRow('idle');

    // Dev-only tools zone (UX Stage 3): one collapsed [ dev tools ] control
    // pinned top-right, expanding to a single panel that the three
    // import.meta.env.DEV blocks below populate (manual sliders, speed-jitter
    // slider, tuning panel). Created entirely inside this branch, so a
    // production build has no dev DOM, no dev strings, and `devZoneEl` stays
    // undefined -- the three blocks below each also check `devZoneEl`, so
    // they no-op in production exactly as before.
    if (import.meta.env.DEV) {
      const wrap = document.createElement('div');
      wrap.className = 'ms-dev-zone';

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'ms-dev-toggle';

      const panel = document.createElement('div');
      panel.className = 'ms-dev-panel';
      panel.hidden = true;

      const head = document.createElement('div');
      head.className = 'ms-dev-panel-head';
      head.textContent = 'DEV TOOLS · not in production';
      panel.appendChild(head);

      let devOpen = false;
      const setDevOpen = (open: boolean): void => {
        devOpen = open;
        panel.hidden = !open;
        toggle.textContent = open ? '[ dev tools ▾ ]' : '[ dev tools ▸ ]';
      };
      setDevOpen(false);
      toggle.addEventListener('click', () => setDevOpen(!devOpen));

      wrap.appendChild(toggle);
      wrap.appendChild(panel);
      app.appendChild(wrap);
      devZoneEl = panel;
    }

    // Dev-only: manual slider input. The button itself — and every string
    // that names it — is created only inside this block, and the adapter is
    // reached only through a dynamic import, so a production build (where
    // import.meta.env.DEV is statically false) tree-shakes this whole branch
    // away: no slider button, no slider strings, no slider module in the
    // bundle (M1 acceptance criterion: "a production build contains no
    // slider UI"). Mounted into the dev-tools panel (UX Stage 3) rather than
    // the real control zone, which is no longer a generic div dev code can
    // freely append into.
    if (import.meta.env.DEV && devZoneEl) {
      const devZone = devZoneEl;
      const devSlidersBtn = document.createElement('button');
      devSlidersBtn.type = 'button';
      devSlidersBtn.id = 'ms-use-sliders';
      devSlidersBtn.textContent = 'Use sliders instead of camera';
      devZone.appendChild(devSlidersBtn);
      useSlidersBtn = devSlidersBtn;

      devSlidersBtn.addEventListener('click', () => {
        void (async () => {
          clearError();
          try {
            const { createSliderAdapter } = await import('./adapters/sliders');
            const adapter = createSliderAdapter();
            lastAdapterKind = 'sliders';
            await activate(adapter);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            showError(`Could not start sliders: ${message}`);
          }
        })();
      });
    }

    // Dev-only pose tuning (session 012): a single live slider for the
    // webcam adapter's sensor-noise floor. This constant genuinely can't be
    // calibrated blind (no camera in the coordinator's own dev environment)
    // -- a real camera plus this slider is the only way to actually dial it
    // in, watching the Speed readout react live while sitting still vs.
    // moving. Every string/DOM node here lives only inside this
    // import.meta.env.DEV branch, tree-shaken from production the same way
    // as the two blocks above/below it. Mounted into the dev-tools panel (UX Stage 3).
    if (import.meta.env.DEV && devZoneEl) {
      const devZone = devZoneEl;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; flex-direction:column; gap:3px; margin:4px 0; font-size:12px;';

      const header = document.createElement('div');
      header.style.cssText = 'display:flex; justify-content:space-between; align-items:baseline; gap:8px;';

      const label = document.createElement('label');
      label.textContent = 'Speed jitter floor (dev)';

      const valueEl = document.createElement('span');
      valueEl.textContent = currentSpeedJitterFloor.toFixed(2);
      valueEl.style.cssText = 'flex-shrink:0; font-variant-numeric:tabular-nums; opacity:0.85;';

      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '2';
      input.step = '0.01';
      input.value = String(currentSpeedJitterFloor);
      input.style.cssText = 'width:100%; margin:0;';

      input.addEventListener('input', () => {
        currentSpeedJitterFloor = Number(input.value);
        valueEl.textContent = currentSpeedJitterFloor.toFixed(2);
        activeAdapter?.setSpeedJitterFloor?.(currentSpeedJitterFloor);
      });

      header.appendChild(label);
      header.appendChild(valueEl);
      row.appendChild(header);
      row.appendChild(input);
      devZone.appendChild(row);
    }

    // Dev-only: the "backend knobs" tuning panel (M4x). Every DOM node,
    // string, and BotanicalTuningConfig field name this block touches is
    // created/referenced only inside this `import.meta.env.DEV` branch, so
    // a production build tree-shakes the whole thing away exactly like the
    // "Use sliders" block above (verified the same way: grep the built
    // dist/ bundle for a panel-only string and confirm zero matches).
    // Mounted into the dev-tools panel (UX Stage 3).
    //
    // One clear rule for how this interacts with the palette-preset
    // mechanism (see also the comment in startLiveLoop): before the founder
    // touches any world-knob slider here, palette buttons behave exactly as
    // before (selectedPaletteId + the preset's own WorldOverrides). The
    // instant a world-knob slider is touched, manualOverridesActive latches
    // true and this panel's own fully-populated WorldOverrides object takes
    // over completely -- palette buttons from then on are just a shortcut
    // that pre-fills this panel's hueBase/hueSpread sliders to the preset's
    // values (via the onPaletteSelected hook), never a second simultaneous
    // override source.
    if (import.meta.env.DEV && devZoneEl) {
      const devZone = devZoneEl;
      const tuningToggleBtn = document.createElement('button');
      tuningToggleBtn.type = 'button';
      tuningToggleBtn.id = 'ms-tuning-toggle';
      tuningToggleBtn.textContent = 'Show tuning panel';
      devZone.appendChild(tuningToggleBtn);

      let panelEl: HTMLDivElement | null = null;
      let restartDebounceHandle: ReturnType<typeof setTimeout> | null = null;

      // Slider-drag restarts are debounced ~120ms after the last `input`
      // event so dragging doesn't trigger a full-piece restart on every
      // pixel of motion, while still feeling live/interactive.
      function scheduleRestart(): void {
        if (restartDebounceHandle !== null) clearTimeout(restartDebounceHandle);
        restartDebounceHandle = setTimeout(() => {
          restartDebounceHandle = null;
          if (activeAdapter) startLiveLoop();
        }, 120);
      }

      function makeSliderRow(
        labelText: string,
        min: number,
        max: number,
        step: number,
        initialValue: number,
        onChange: (value: number) => void,
      ): HTMLDivElement {
        // Stacked layout (UX Stage 3): label + value on one line, the slider
        // full-width beneath. The old side-by-side layout left the range
        // input ~0px wide once these moved into the narrow dev-tools panel.
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; flex-direction:column; gap:3px; margin:8px 0;';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex; justify-content:space-between; align-items:baseline; gap:8px; font-size:11px;';

        const label = document.createElement('label');
        label.textContent = labelText;
        label.style.cssText = 'overflow-wrap:anywhere;';

        const valueEl = document.createElement('span');
        valueEl.textContent = initialValue.toFixed(4);
        valueEl.style.cssText = 'flex-shrink:0; font-variant-numeric:tabular-nums; opacity:0.85;';

        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.value = String(initialValue);
        input.style.cssText = 'width:100%; margin:0;';

        input.addEventListener('input', () => {
          const value = Number(input.value);
          valueEl.textContent = value.toFixed(4);
          onChange(value);
          scheduleRestart();
        });

        header.appendChild(label);
        header.appendChild(valueEl);
        row.appendChild(header);
        row.appendChild(input);
        return row;
      }

      /** Reasonable UI slider bounds around each default -- roughly 0 to
       * 2-3x default for most fields, or a domain bound ([0,1] for
       * opacity/fraction-like fields, [0,100] for HSL percentages, etc.)
       * where that reads more naturally than a raw multiple. */
      const TUNING_RANGES: Record<keyof BotanicalTuningConfig, { min: number; max: number; step: number }> = {
        maxGeneration: { min: 1, max: 8, step: 1 },
        speedFloor: { min: 0, max: 1, step: 0.01 }, // blended fraction of speed [0,1]
        symmetryDamping: { min: 0, max: 1, step: 0.01 }, // damping fraction; >1 would invert wander
        windStrength: { min: 0, max: 0.002, step: 0.00002 },
        baseGrowthScale: { min: 0, max: 0.0002, step: 0.000001 },
        targetLengthBase: { min: 0, max: 1, step: 0.01 }, // normalized canvas-unit length
        targetLengthJitterSpan: { min: 0, max: 1.5, step: 0.01 },
        generationLengthDecay: { min: 0, max: 1, step: 0.01 }, // per-generation fraction
        branchBaseWidthMin: { min: 0, max: 0.05, step: 0.0005 }, // normalized stroke width
        branchBaseWidthSpan: { min: 0, max: 0.05, step: 0.0005 },
        generationWidthDecay: { min: 0, max: 1, step: 0.01 }, // per-generation fraction
        taperExponent: { min: 0.5, max: 4, step: 0.05 },
        branchBaseOpacity: { min: 0, max: 1, step: 0.01 },
        curvatureNoiseScale: { min: 0, max: 1, step: 0.005 }, // grownLength multiplier before noise sampling
        sweepStrength: { min: 0, max: 0.005, step: 0.00002 },
        childDirectionJitterMin: { min: 0, max: 1.5, step: 0.01 }, // radians
        childDirectionJitterSpan: { min: 0, max: 1.5, step: 0.01 },
        forkCountMin: { min: 0, max: 8, step: 1 },
        forkCountSpan: { min: 0, max: 8, step: 1 },
        forkFractionMin: { min: 0, max: 1, step: 0.01 }, // fraction of targetLength
        forkFractionMax: { min: 0, max: 1, step: 0.01 },
        rootYMin: { min: 0, max: 1, step: 0.01 }, // normalized canvas y
        rootYSpan: { min: 0, max: 1, step: 0.01 },
        rootBaseDirectionSpread: { min: 0, max: Math.PI, step: 0.01 }, // radians
        childZJitter: { min: 0, max: 0.3, step: 0.005 },
        blossomRadiusSmallMin: { min: 0, max: 0.05, step: 0.0005 },
        blossomRadiusSmallSpan: { min: 0, max: 0.05, step: 0.0005 },
        blossomRadiusLargeMin: { min: 0, max: 0.1, step: 0.001 },
        blossomRadiusLargeSpan: { min: 0, max: 0.1, step: 0.001 },
        blossomLargeFraction: { min: 0, max: 1, step: 0.01 },
        blossomOpacityMin: { min: 0, max: 1, step: 0.01 },
        blossomOpacitySpan: { min: 0, max: 1, step: 0.01 },
        blossomClusterSigmaMin: { min: 0, max: 0.15, step: 0.001 }, // normalized gaussian sigma
        blossomClusterSigmaSpan: { min: 0, max: 0.15, step: 0.001 },
        blossomZJitter: { min: 0, max: 0.2, step: 0.005 },
        blossomRingProbability: { min: 0, max: 1, step: 0.01 },
        blossomRingLightenAmount: { min: 0, max: 1, step: 0.01 },
        blossomCrossDrawProbability: { min: 0, max: 1, step: 0.01 },
        blossomRevealIntervalMs: { min: 0, max: 300, step: 1 }, // 0 = instant (old behavior); higher = slower "watercolor" build
        blossomRevealSpeedFloor: { min: 0, max: 1, step: 0.01 }, // blended fraction of speed [0,1], mirrors speedFloor
        crossRootBakeSafetyMargin: { min: 0, max: 0.5, step: 0.005 }, // world units, same scale as targetLengthBase
        forcedBakeCeilingMs: { min: 500, max: 20000, step: 250 }, // simulated ms a mature/revealed element may stay blocked before a forced bake (roadmap B)
      };

      function buildPanel(): HTMLDivElement {
        const panel = document.createElement('div');
        panel.id = 'ms-tuning-panel';
        panel.hidden = true;
        // The .ms-dev-panel wrapper (UX Stage 3) owns the dark palette and
        // the outer scroll now; this sub-panel just needs a divider rule and
        // its own font size. No inner max-height/scroll -- a nested
        // scrollbar inside the already-scrolling dev panel was unusable.
        panel.style.cssText = 'margin: 8px 0 0; padding-top: 10px; border-top: 1px solid #4a3f38; font-size: 12px;';

        // Seed the panel's world-knob sliders from the world's own current
        // seed-derived values (not 0): whatever world is already live, or
        // (no session started yet) a fresh same-seed World built the same
        // way startLiveLoop would, purely to read today's knob() values.
        const initWorld: World =
          currentWorld ??
          createWorld(deriveWorldSeed(getOrCreateUserId(), formatLocalDate(new Date())), 0);

        const worldKnobNames = createBotanicalStyle().worldKnobs();
        const initialOverrides: Record<string, number> = {};
        for (const name of worldKnobNames) {
          initialOverrides[name] = initWorld.knob(name);
        }
        // Always fully populated (all 11 keys) once the panel exists, per
        // spec -- even before manualOverridesActive flips true and this
        // object actually starts driving startLiveLoop's overrides.
        panelWorldOverrides = initialOverrides;

        const worldHeading = document.createElement('h4');
        worldHeading.textContent = 'World knobs (raw 0–1)';
        worldHeading.style.cssText = 'margin: 4px 0;';
        panel.appendChild(worldHeading);

        const worldSliderInputs: Record<string, HTMLInputElement> = {};
        const worldValueEls: Record<string, HTMLSpanElement> = {};

        for (const name of worldKnobNames) {
          const row = makeSliderRow(name, 0, 0.999999, 0.000001, initialOverrides[name] ?? 0, (value) => {
            manualOverridesActive = true;
            panelWorldOverrides = { ...(panelWorldOverrides ?? initialOverrides), [name]: value };
          });
          panel.appendChild(row);
          const input = row.querySelector('input');
          const valueEl = row.querySelector('span');
          if (input) worldSliderInputs[name] = input;
          if (valueEl) worldValueEls[name] = valueEl;
        }

        onPaletteSelected = (paletteId) => {
          if (!manualOverridesActive) return;
          const value = paletteIndexOverride(paletteId).paletteIndex;
          if (value === undefined) return;
          panelWorldOverrides = { ...(panelWorldOverrides ?? initialOverrides), paletteIndex: value };
          const input = worldSliderInputs['paletteIndex'];
          const valueEl = worldValueEls['paletteIndex'];
          if (input) input.value = String(value);
          if (valueEl) valueEl.textContent = value.toFixed(4);
        };

        const tuningHeading = document.createElement('h4');
        tuningHeading.textContent = 'Botanical tuning config';
        tuningHeading.style.cssText = 'margin: 10px 0 4px;';
        panel.appendChild(tuningHeading);

        const workingTuning: BotanicalTuningConfig = { ...DEFAULT_BOTANICAL_TUNING_CONFIG };
        panelTuningConfig = workingTuning;

        for (const key of Object.keys(DEFAULT_BOTANICAL_TUNING_CONFIG) as (keyof BotanicalTuningConfig)[]) {
          const range = TUNING_RANGES[key];
          const row = makeSliderRow(key, range.min, range.max, range.step, DEFAULT_BOTANICAL_TUNING_CONFIG[key], (value) => {
            workingTuning[key] = value;
            panelTuningConfig = workingTuning;
          });
          panel.appendChild(row);
        }

        const exportBtn = document.createElement('button');
        exportBtn.type = 'button';
        exportBtn.textContent = 'Export current values';
        exportBtn.style.cssText = 'margin-top: 10px;';

        const exportArea = document.createElement('textarea');
        exportArea.readOnly = true;
        exportArea.style.cssText =
          'display:block; width:100%; height:160px; margin-top:8px; font-family:monospace; font-size:11px; box-sizing:border-box;';

        exportBtn.addEventListener('click', () => {
          const payload = {
            worldOverrides: panelWorldOverrides ?? initialOverrides,
            tuningConfig: workingTuning,
          };
          exportArea.value = JSON.stringify(payload, null, 2);
          exportArea.focus();
          exportArea.select();
        });

        panel.appendChild(exportBtn);
        panel.appendChild(exportArea);

        return panel;
      }

      tuningToggleBtn.addEventListener('click', () => {
        if (!panelEl) {
          panelEl = buildPanel();
          devZone.appendChild(panelEl);
        }
        const willShow = panelEl.hidden;
        panelEl.hidden = !willShow;
        tuningToggleBtn.textContent = willShow ? 'Hide tuning panel' : 'Show tuning panel';
      });
    }
  }
}

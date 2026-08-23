/**
 * Entry point: wires layer 1 (input adapters) to the on-screen readout.
 * Only one adapter is active at a time; switching adapters stops the
 * previous one first. The slider adapter is a dev-only affordance — it is
 * reached only through a dynamic import gated behind `import.meta.env.DEV`,
 * so `vite build` (production) never includes its module in the bundle.
 */
import { createWebcamAdapter } from './adapters/webcam';
import type { InputAdapter } from './adapters/input-adapter';
import { createParamsReadout } from './app/readout';
import { createPauseGate } from './app/pause-gate';
import { createActivationTokenSource } from './app/activation-token';
import { getOrCreateUserId } from './app/user-identity';
import { createLiveRenderLoop, type LiveRenderLoop } from './app/live-render-loop';
import type { OffscreenBuffer, OffscreenBufferFactory } from './compositor/live-compositor';
import type { CanvasLike, CanvasSize } from './compositor/render-scene';
import { createWorld, type World, type WorldOverrides } from './world/world';
import { deriveWorldSeed, formatLocalDate } from './world/seed';
import { POSE_PARAM_TUNING } from './adapters/webcam/params-from-landmarks';
import { createBotanicalStyle } from './styles/botanical/botanical';
import { BOTANICAL_PALETTE_PRESETS, type BotanicalPaletteId } from './styles/botanical/palettes';
import { DEFAULT_BOTANICAL_TUNING_CONFIG, type BotanicalTuningConfig } from './styles/botanical/tuning-config';
import { openRecipeStore, type RecipeStore } from './storage/recipe-store';
import { nextSessionIndexFor } from './storage/next-session-index';
import { exportCanvasAsPng } from './storage/image-export';
import { serializeRecipe, deserializeRecipe } from './storage/recipe-export';
import { PIECE_RECIPE_VERSION, type PieceRecipe } from './storage/recipe';
import type { MovementRecording } from './engine/recording';

// The Scroll (M5 Stage 2, spec Part 3 "Composition and canvas"): the canvas
// has this fixed height and grows rightward as the piece grows -- see
// live-render-loop.ts's resizeCanvas callback below, which sets the real
// canvas element's width every frame to fit the current scene.
const CANVAS_HEIGHT_PX = 480;

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

const app = document.querySelector<HTMLDivElement>('#app');

if (app) {
  app.innerHTML = `
    <main class="ms-shell">
      <h1>MoveScape</h1>
      <p class="ms-privacy">
        Your camera never leaves this device — all processing happens locally.
      </p>
      <div class="ms-controls" id="ms-controls">
        <button id="ms-start-camera" type="button">Start camera</button>
        <button id="ms-pause" type="button" hidden>Pause</button>
        <button id="ms-toggle-preview" type="button" hidden>Show camera</button>
        <button id="ms-finish" type="button" hidden>Finish</button>
        <button id="ms-stop" type="button" hidden>Stop</button>
        <span id="ms-activating" class="ms-activating" hidden>Starting…</span>
      </div>
      <div class="ms-controls" id="ms-palette-controls"></div>
      <div class="ms-canvas-wrap" id="ms-canvas-wrap">
        <canvas id="ms-canvas" class="ms-canvas" width="${CANVAS_HEIGHT_PX}" height="${CANVAS_HEIGHT_PX}"></canvas>
      </div>
      <p id="ms-error" class="ms-error" hidden></p>
      <div class="ms-session-end" id="ms-session-end" hidden>
        <p>Session finished. Keep this piece?</p>
        <div class="ms-controls">
          <button id="ms-save-piece" type="button">Save piece</button>
          <button id="ms-discard-piece" type="button">Discard</button>
        </div>
        <p id="ms-session-end-status" class="ms-status" hidden></p>
      </div>
      <div id="ms-readout"></div>
      <div id="ms-pose-tuning"></div>
      <div id="ms-preview"></div>
      <div class="ms-backup">
        <button id="ms-import-recipe" type="button">Import recipe backup…</button>
        <input id="ms-import-recipe-file" type="file" accept="application/json" hidden />
        <p id="ms-import-status" class="ms-status" hidden></p>
      </div>
    </main>
  `;

  const style = document.createElement('style');
  style.textContent = `
    body { background: #0f0f13; margin: 0; }
    .ms-shell { max-width: 480px; margin: 0 auto; padding: 40px 20px;
      font-family: system-ui, sans-serif; color: #f2f2f2; }
    .ms-privacy { font-size: 13px; opacity: 0.75; }
    .ms-controls { display: flex; gap: 8px; margin: 16px 0; flex-wrap: wrap; }
    .ms-controls button { font: inherit; padding: 8px 14px; border-radius: 6px;
      border: 1px solid #444; background: #1c1c22; color: #f2f2f2; cursor: pointer; }
    .ms-controls button:hover { background: #26262e; }
    .ms-controls button:disabled { opacity: 0.5; cursor: default; }
    .ms-activating { font-size: 12px; opacity: 0.75; align-self: center; }
    .ms-error { color: #ff8080; font-size: 13px; }
    .ms-session-end { margin: 8px 0 16px; padding: 12px; border: 1px solid #444; border-radius: 8px; }
    .ms-session-end p { margin: 0 0 8px; }
    .ms-status { font-size: 13px; opacity: 0.85; margin: 8px 0 0; }
    .ms-status.ms-status-error { color: #ff8080; }
    .ms-backup { margin-top: 24px; padding-top: 16px; border-top: 1px solid #333; }
    .ms-backup button { font: inherit; padding: 8px 14px; border-radius: 6px;
      border: 1px solid #444; background: #1c1c22; color: #f2f2f2; cursor: pointer; }
    .ms-canvas-wrap { overflow-x: auto; max-width: 100%; border-radius: 8px;
      margin: 4px 0 16px; background: #f7f0e3; }
    .ms-canvas { display: block; height: ${CANVAS_HEIGHT_PX}px; width: auto; }
    #ms-readout.ms-paused { opacity: 0.55; }
    .ms-preview-video { display: block; margin-top: 12px; max-width: 320px; width: 100%;
      border-radius: 8px; transform: scaleX(-1); background: #000; }
  `;
  document.head.appendChild(style);

  const readoutContainerRef = app.querySelector<HTMLDivElement>('#ms-readout');
  const previewContainerRef = app.querySelector<HTMLDivElement>('#ms-preview');
  const errorElRef = app.querySelector<HTMLParagraphElement>('#ms-error');
  const controlsElRef = app.querySelector<HTMLDivElement>('#ms-controls');
  const startCameraBtnRef = app.querySelector<HTMLButtonElement>('#ms-start-camera');
  const pauseBtnRef = app.querySelector<HTMLButtonElement>('#ms-pause');
  const previewToggleBtnRef = app.querySelector<HTMLButtonElement>('#ms-toggle-preview');
  const finishBtnRef = app.querySelector<HTMLButtonElement>('#ms-finish');
  const stopBtnRef = app.querySelector<HTMLButtonElement>('#ms-stop');
  const activatingElRef = app.querySelector<HTMLSpanElement>('#ms-activating');
  const canvasElRef = app.querySelector<HTMLCanvasElement>('#ms-canvas');
  const canvasWrapElRef = app.querySelector<HTMLDivElement>('#ms-canvas-wrap');
  const paletteControlsElRef = app.querySelector<HTMLDivElement>('#ms-palette-controls');
  const sessionEndElRef = app.querySelector<HTMLDivElement>('#ms-session-end');
  const sessionEndStatusElRef = app.querySelector<HTMLParagraphElement>('#ms-session-end-status');
  const savePieceBtnRef = app.querySelector<HTMLButtonElement>('#ms-save-piece');
  const discardPieceBtnRef = app.querySelector<HTMLButtonElement>('#ms-discard-piece');
  const importRecipeBtnRef = app.querySelector<HTMLButtonElement>('#ms-import-recipe');
  const importRecipeFileRef = app.querySelector<HTMLInputElement>('#ms-import-recipe-file');
  const importStatusElRef = app.querySelector<HTMLParagraphElement>('#ms-import-status');
  const poseTuningElRef = app.querySelector<HTMLDivElement>('#ms-pose-tuning');

  if (
    readoutContainerRef &&
    previewContainerRef &&
    errorElRef &&
    controlsElRef &&
    startCameraBtnRef &&
    pauseBtnRef &&
    previewToggleBtnRef &&
    finishBtnRef &&
    stopBtnRef &&
    activatingElRef &&
    canvasElRef &&
    canvasWrapElRef &&
    paletteControlsElRef &&
    sessionEndElRef &&
    sessionEndStatusElRef &&
    savePieceBtnRef &&
    discardPieceBtnRef &&
    importRecipeBtnRef &&
    importRecipeFileRef &&
    importStatusElRef &&
    poseTuningElRef
  ) {
    // Re-bind to fresh consts so their (non-null) type is fixed at this
    // point — TypeScript would otherwise re-widen the outer refs to
    // `T | null` wherever they're read from inside the nested functions
    // below, since it can't prove a closure won't run before this guard.
    const readoutEl = readoutContainerRef;
    const previewEl = previewContainerRef;
    const errorEl = errorElRef;
    const controlsEl = controlsElRef;
    const startCameraBtn = startCameraBtnRef;
    const pauseBtn = pauseBtnRef;
    const previewToggleBtn = previewToggleBtnRef;
    const finishBtn = finishBtnRef;
    const stopBtn = stopBtnRef;
    const activatingEl = activatingElRef;
    const canvasEl = canvasElRef;
    const canvasWrapEl = canvasWrapElRef;
    const paletteControlsEl = paletteControlsElRef;
    const sessionEndEl = sessionEndElRef;
    const sessionEndStatusEl = sessionEndStatusElRef;
    const savePieceBtn = savePieceBtnRef;
    const discardPieceBtn = discardPieceBtnRef;
    const importRecipeBtn = importRecipeBtnRef;
    const importRecipeFile = importRecipeFileRef;
    const importStatusEl = importStatusElRef;
    const poseTuningEl = poseTuningElRef;
    // getContext('2d') is effectively never null for a freshly-created
    // <canvas> in a real browser; guarded rather than asserted so a
    // hypothetical unsupported environment degrades to "no art rendering"
    // instead of a thrown error, without disabling the rest of the app.
    const canvasCtx = canvasEl.getContext('2d');

    const readout = createParamsReadout(readoutEl);
    // Created once, reused across every session/restart -- see the factory's
    // own doc comment above for why this is safe (each create() call hands
    // back an independent offscreen canvas; the factory itself holds no
    // per-session state). Each startLiveLoop() call below constructs a
    // fresh LiveRenderLoop (and therefore a fresh LiveCompositor internally,
    // src/app/live-render-loop.ts), which is what guarantees a new
    // session's buffers start empty -- no explicit reset() call needed here.
    const offscreenBufferFactory = createDomOffscreenBufferFactory();
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
    // The finished session's own recording + world, captured by
    // finishSession() and consumed by saveSession()/discardSession() --
    // null whenever no finished-but-undecided session is pending.
    let pendingRecording: MovementRecording | null = null;
    let pendingWorld: World | null = null;
    const pauseGate = createPauseGate((params, timestampMs) => {
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

    // Handle onto the most recently created World (set at the bottom of
    // startLiveLoop), so the dev-only tuning panel (built lazily, see the
    // second import.meta.env.DEV block below) can initialize its world-knob
    // sliders from the world's actual current seed-derived values instead of
    // 0. Harmless and string-free in production -- stays null forever there.
    let currentWorld: World | null = null;

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
      liveLoop = createLiveRenderLoop(
        createBotanicalStyle(panelTuningConfig),
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
      previewToggleBtn.textContent = 'Show camera';
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
      previewToggleBtn.textContent = 'Hide camera';
    }

    /** Show/hide the preview toggle based on whether the active adapter has a live stream. */
    function refreshPreviewAvailability(): void {
      const stream = activeAdapter?.previewStream?.() ?? null;
      previewToggleBtn.hidden = !stream;
      if (!stream) hidePreview();
    }

    function setPaused(paused: boolean): void {
      if (paused) {
        pauseGate.pause();
        pauseBtn.textContent = 'Resume';
        readoutEl.classList.add('ms-paused');
      } else {
        pauseGate.resume();
        pauseBtn.textContent = 'Pause';
        readoutEl.classList.remove('ms-paused');
      }
    }

    function setStartButtonsDisabled(disabled: boolean): void {
      startCameraBtn.disabled = disabled;
      if (useSlidersBtn) useSlidersBtn.disabled = disabled;
      activatingEl.hidden = !disabled;
    }

    /**
     * Stops both the pending (mid-start) and active adapters and resets the
     * UI. Does NOT touch the activation token — callers that need to
     * invalidate an in-flight activate() do that explicitly, so this can be
     * shared between stopActive() and the start of a new activate() without
     * a new activation immediately invalidating itself.
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
      hidePreview();
      pauseGate.reset();
      setPaused(false);
      // Stop is a full abort: any not-yet-decided finished session is
      // discarded too, not left in limbo behind a hidden panel.
      pendingRecording = null;
      pendingWorld = null;
      sessionEndEl.hidden = true;
      stopBtn.hidden = true;
      pauseBtn.hidden = true;
      finishBtn.hidden = true;
      previewToggleBtn.hidden = true;
      setStartButtonsDisabled(false);
    }

    /**
     * Ends the current session without discarding it: freezes the render
     * loop in place (no clear-and-reset -- the finished piece stays on
     * screen for the Save/Discard decision), stops capturing movement, and
     * shows the session-end panel. saveSession()/discardSession() are the
     * only two ways out of the pending state this leaves behind.
     */
    function finishSession(): void {
      if (!liveLoop || !currentWorld) return;
      pendingRecording = liveLoop.getRecording();
      pendingWorld = currentWorld;
      activeAdapter?.stop();
      activeAdapter = null;
      readout.reset();
      liveLoop.stop(); // freezes the loop only -- does not touch canvas contents, unlike stopLiveLoop()
      hidePreview();
      pauseGate.reset();
      setPaused(false);
      stopBtn.hidden = true;
      pauseBtn.hidden = true;
      finishBtn.hidden = true;
      previewToggleBtn.hidden = true;
      // Disabled for the life of the pending decision so starting a new
      // session can't silently overwrite currentWorld/currentSessionIndex
      // out from under the still-undecided piece.
      setStartButtonsDisabled(true);
      savePieceBtn.hidden = false;
      discardPieceBtn.hidden = false;
      sessionEndStatusEl.hidden = true;
      sessionEndStatusEl.textContent = '';
      sessionEndStatusEl.classList.remove('ms-status-error');
      sessionEndEl.hidden = false;
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

    function discardSession(): void {
      pendingRecording = null;
      pendingWorld = null;
      sessionEndEl.hidden = true;
      stopLiveLoop();
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
      if (!pendingRecording || !pendingWorld) return;
      savePieceBtn.disabled = true;
      discardPieceBtn.disabled = true;
      sessionEndStatusEl.hidden = false;
      sessionEndStatusEl.classList.remove('ms-status-error');
      sessionEndStatusEl.textContent = 'Saving…';
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
        exportCanvasAsPng(canvasEl, `${baseName}.png`);
        downloadJsonFile(serializeRecipe(recipe), `${baseName}.json`);
        pendingRecording = null;
        pendingWorld = null;
        savePieceBtn.hidden = true;
        discardPieceBtn.hidden = true;
        sessionEndStatusEl.textContent = 'Saved — image and recipe backup downloaded, stored locally.';
        stopLiveLoop(); // safe to reset the canvas now that the piece is persisted
        setStartButtonsDisabled(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sessionEndStatusEl.textContent = `Could not save: ${message}`;
        sessionEndStatusEl.classList.add('ms-status-error');
      } finally {
        savePieceBtn.disabled = false;
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

    function stopActive(): void {
      activation.next(); // invalidate any in-flight activation so its late resolution is discarded
      resetAdaptersAndUi();
    }

    async function activate(adapter: InputAdapter): Promise<void> {
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
          // stop happened) — discard this late resolution instead of wiring
          // a stale adapter into the UI. Belt-and-suspenders alongside the
          // synchronous stop in resetAdaptersAndUi().
          adapter.stop();
          return;
        }
        pendingAdapter = null;
        activeAdapter = adapter;
        stopBtn.hidden = false;
        pauseBtn.hidden = false;
        finishBtn.hidden = false;
        refreshPreviewAvailability();
        setStartButtonsDisabled(false);
        // Carries a live-tuned pose-sensor value across a restart (dev-only
        // slider, no-op via optional chaining on adapters that don't
        // implement it, e.g. the slider adapter).
        activeAdapter.setSpeedJitterFloor?.(currentSpeedJitterFloor);
        await beginSession();
      } catch (err) {
        if (!activation.isCurrent(token)) return; // stale failure; a newer activation already owns the UI
        pendingAdapter = null;
        setStartButtonsDisabled(false);
        const message = err instanceof Error ? err.message : String(err);
        showError(`Could not start "${adapter.id}": ${message}`);
      }
    }

    startCameraBtn.addEventListener('click', () => {
      void (async () => {
        clearError();
        try {
          const adapter = createWebcamAdapter();
          await activate(adapter);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          showError(`Could not start camera: ${message}`);
        }
      })();
    });

    stopBtn.addEventListener('click', () => {
      stopActive();
    });

    finishBtn.addEventListener('click', () => {
      finishSession();
    });

    savePieceBtn.addEventListener('click', () => {
      void saveSession();
    });

    discardPieceBtn.addEventListener('click', () => {
      discardSession();
    });

    importRecipeBtn.addEventListener('click', () => {
      importRecipeFile.click();
    });

    importRecipeFile.addEventListener('change', () => {
      void (async () => {
        const file = importRecipeFile.files?.[0];
        importRecipeFile.value = ''; // clear so re-importing the same filename later still fires 'change'
        if (!file) return;
        importStatusEl.hidden = false;
        importStatusEl.classList.remove('ms-status-error');
        importStatusEl.textContent = 'Importing…';
        try {
          const text = await file.text();
          const recipe = deserializeRecipe(text);
          const store = await recipeStorePromise;
          await store.save(recipe);
          importStatusEl.textContent = `Imported recipe (world ${recipe.worldSeed}, session ${recipe.sessionIndex}).`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          importStatusEl.textContent = `Could not import: ${message}`;
          importStatusEl.classList.add('ms-status-error');
        }
      })();
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

    // Palette presets (M4 palette system): switching while a session is
    // running restarts the live loop with the new colors, keeping the same
    // camera/adapter running uninterrupted. A full custom color-wheel picker
    // is a later enhancement — see docs/HANDOFF.md.
    for (const preset of BOTANICAL_PALETTE_PRESETS) {
      const paletteBtn = document.createElement('button');
      paletteBtn.type = 'button';
      paletteBtn.textContent = preset.displayName;
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

    // Dev-only: manual slider input. The button itself — and every string
    // that names it — is created only inside this block, and the adapter is
    // reached only through a dynamic import, so a production build (where
    // import.meta.env.DEV is statically false) tree-shakes this whole branch
    // away: no slider button, no slider strings, no slider module in the
    // bundle (M1 acceptance criterion: "a production build contains no
    // slider UI").
    if (import.meta.env.DEV) {
      const devSlidersBtn = document.createElement('button');
      devSlidersBtn.type = 'button';
      devSlidersBtn.id = 'ms-use-sliders';
      devSlidersBtn.textContent = 'Use sliders';
      controlsEl.appendChild(devSlidersBtn);
      useSlidersBtn = devSlidersBtn;

      devSlidersBtn.addEventListener('click', () => {
        void (async () => {
          clearError();
          try {
            const { createSliderAdapter } = await import('./adapters/sliders');
            const adapter = createSliderAdapter();
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
    // as the two blocks above/below it.
    if (import.meta.env.DEV) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:8px; margin:8px 0; font-size:12px;';

      const label = document.createElement('label');
      label.textContent = 'Speed jitter floor (dev)';
      label.style.cssText = 'width:190px; flex-shrink:0;';

      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '2';
      input.step = '0.01';
      input.value = String(currentSpeedJitterFloor);
      input.style.cssText = 'flex: 1 1 auto; min-width: 0; max-width: 260px;';

      const valueEl = document.createElement('span');
      valueEl.textContent = currentSpeedJitterFloor.toFixed(2);
      valueEl.style.cssText = 'width:48px; text-align:right;';

      input.addEventListener('input', () => {
        currentSpeedJitterFloor = Number(input.value);
        valueEl.textContent = currentSpeedJitterFloor.toFixed(2);
        activeAdapter?.setSpeedJitterFloor?.(currentSpeedJitterFloor);
      });

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(valueEl);
      poseTuningEl.appendChild(row);
    }

    // Dev-only: the "backend knobs" tuning panel (M4x). Every DOM node,
    // string, and BotanicalTuningConfig field name this block touches is
    // created/referenced only inside this `import.meta.env.DEV` branch, so
    // a production build tree-shakes the whole thing away exactly like the
    // "Use sliders" block above (verified the same way: grep the built
    // dist/ bundle for a panel-only string and confirm zero matches).
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
    if (import.meta.env.DEV) {
      const tuningToggleBtn = document.createElement('button');
      tuningToggleBtn.type = 'button';
      tuningToggleBtn.id = 'ms-tuning-toggle';
      tuningToggleBtn.textContent = 'Show tuning panel';
      controlsEl.appendChild(tuningToggleBtn);

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
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:8px; margin:3px 0;';

        const label = document.createElement('label');
        label.textContent = labelText;
        label.style.cssText = 'width:190px; font-size:11px; flex-shrink:0;';

        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.value = String(initialValue);
        input.style.cssText = 'flex: 1 1 auto; min-width: 0;';

        const valueEl = document.createElement('span');
        valueEl.textContent = initialValue.toFixed(4);
        valueEl.style.cssText = 'font-size:11px; width:64px; flex-shrink:0; text-align:right;';

        input.addEventListener('input', () => {
          const value = Number(input.value);
          valueEl.textContent = value.toFixed(4);
          onChange(value);
          scheduleRestart();
        });

        row.appendChild(label);
        row.appendChild(input);
        row.appendChild(valueEl);
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
      };

      function buildPanel(): HTMLDivElement {
        const panel = document.createElement('div');
        panel.id = 'ms-tuning-panel';
        panel.hidden = true;
        // Explicit color (rather than relying on inheritance): this panel is
        // appended directly to #app, a sibling of <main class="ms-shell">
        // rather than a descendant of it, so it does NOT inherit .ms-shell's
        // `color: #f2f2f2` -- without this it renders in the browser's
        // default black text on the app's near-black background, effectively
        // invisible.
        panel.style.cssText =
          'margin: 12px 0; padding: 12px; border: 1px solid #444; border-radius: 8px; ' +
          'max-height: 420px; overflow-y: auto; font-size: 12px; color: #f2f2f2;';

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
          app.appendChild(panelEl);
        }
        const willShow = panelEl.hidden;
        panelEl.hidden = !willShow;
        tuningToggleBtn.textContent = willShow ? 'Hide tuning panel' : 'Show tuning panel';
      });
    }
  }
}

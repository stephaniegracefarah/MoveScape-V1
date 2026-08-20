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
import type { CanvasLike } from './compositor/render-scene';
import { createWorld } from './world/world';
import { deriveWorldSeed, formatLocalDate } from './world/seed';
import { createBotanicalStyle } from './styles/botanical/botanical';
import { BOTANICAL_PALETTE_PRESETS, type BotanicalPaletteId } from './styles/botanical/palettes';

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
        <button id="ms-stop" type="button" hidden>Stop</button>
        <span id="ms-activating" class="ms-activating" hidden>Starting…</span>
      </div>
      <div class="ms-controls" id="ms-palette-controls"></div>
      <canvas id="ms-canvas" class="ms-canvas" width="720" height="480"></canvas>
      <p id="ms-error" class="ms-error" hidden></p>
      <div id="ms-readout"></div>
      <div id="ms-preview"></div>
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
    .ms-canvas { display: block; width: 100%; max-width: 720px; height: auto;
      aspect-ratio: 3 / 2; background: #fdfdfb; border-radius: 8px; margin: 4px 0 16px; }
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
  const stopBtnRef = app.querySelector<HTMLButtonElement>('#ms-stop');
  const activatingElRef = app.querySelector<HTMLSpanElement>('#ms-activating');
  const canvasElRef = app.querySelector<HTMLCanvasElement>('#ms-canvas');
  const paletteControlsElRef = app.querySelector<HTMLDivElement>('#ms-palette-controls');

  if (
    readoutContainerRef &&
    previewContainerRef &&
    errorElRef &&
    controlsElRef &&
    startCameraBtnRef &&
    pauseBtnRef &&
    previewToggleBtnRef &&
    stopBtnRef &&
    activatingElRef &&
    canvasElRef &&
    paletteControlsElRef
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
    const stopBtn = stopBtnRef;
    const activatingEl = activatingElRef;
    const canvasEl = canvasElRef;
    const paletteControlsEl = paletteControlsElRef;
    // getContext('2d') is effectively never null for a freshly-created
    // <canvas> in a real browser; guarded rather than asserted so a
    // hypothetical unsupported environment degrades to "no art rendering"
    // instead of a thrown error, without disabling the rest of the app.
    const canvasCtx = canvasEl.getContext('2d');

    const readout = createParamsReadout(readoutEl);
    let liveLoop: LiveRenderLoop | null = null;
    let selectedPaletteId: BotanicalPaletteId = 'default';
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
      const overrides = BOTANICAL_PALETTE_PRESETS.find((preset) => preset.id === selectedPaletteId)?.overrides;
      const world = createWorld(worldSeed, 0, overrides);
      liveLoop = createLiveRenderLoop(
        createBotanicalStyle(),
        world,
        // CanvasRenderingContext2D.fillStyle is `string | CanvasGradient |
        // CanvasPattern`; CanvasLike only needs the plain-string subset this
        // app ever assigns, so the cast is safe (same pattern already used
        // in src/engine/pixel-determinism.test.ts for @napi-rs/canvas).
        canvasCtx as unknown as CanvasLike,
        { width: canvasEl.width, height: canvasEl.height },
        () => pauseGate.isPaused(),
      );
    }

    function stopLiveLoop(): void {
      liveLoop?.stop();
      liveLoop = null;
      canvasCtx?.clearRect(0, 0, canvasEl.width, canvasEl.height);
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
      stopBtn.hidden = true;
      pauseBtn.hidden = true;
      previewToggleBtn.hidden = true;
      setStartButtonsDisabled(false);
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
        refreshPreviewAvailability();
        setStartButtonsDisabled(false);
        startLiveLoop();
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
  }
}

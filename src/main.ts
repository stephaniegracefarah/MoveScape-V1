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
      </div>
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
    .ms-error { color: #ff8080; font-size: 13px; }
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

  if (
    readoutContainerRef &&
    previewContainerRef &&
    errorElRef &&
    controlsElRef &&
    startCameraBtnRef &&
    pauseBtnRef &&
    previewToggleBtnRef &&
    stopBtnRef
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

    const readout = createParamsReadout(readoutEl);
    const pauseGate = createPauseGate((params, timestampMs) => readout.update(params, timestampMs));

    let activeAdapter: InputAdapter | null = null;
    let previewVideo: HTMLVideoElement | null = null;

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

    function stopActive(): void {
      if (activeAdapter) {
        activeAdapter.stop();
        activeAdapter = null;
        readout.reset();
      }
      hidePreview();
      pauseGate.reset();
      setPaused(false);
      stopBtn.hidden = true;
      pauseBtn.hidden = true;
      previewToggleBtn.hidden = true;
    }

    async function activate(adapter: InputAdapter): Promise<void> {
      stopActive();
      clearError();
      try {
        await adapter.start(pauseGate.listener);
        activeAdapter = adapter;
        stopBtn.hidden = false;
        pauseBtn.hidden = false;
        refreshPreviewAvailability();
      } catch (err) {
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

    // Dev-only: manual slider input. The button itself — and every string
    // that names it — is created only inside this block, and the adapter is
    // reached only through a dynamic import, so a production build (where
    // import.meta.env.DEV is statically false) tree-shakes this whole branch
    // away: no slider button, no slider strings, no slider module in the
    // bundle (M1 acceptance criterion: "a production build contains no
    // slider UI").
    if (import.meta.env.DEV) {
      const useSlidersBtn = document.createElement('button');
      useSlidersBtn.type = 'button';
      useSlidersBtn.id = 'ms-use-sliders';
      useSlidersBtn.textContent = 'Use sliders';
      controlsEl.appendChild(useSlidersBtn);

      useSlidersBtn.addEventListener('click', () => {
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

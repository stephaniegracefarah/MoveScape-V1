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
        <button id="ms-stop" type="button" hidden>Stop</button>
      </div>
      <p id="ms-error" class="ms-error" hidden></p>
      <div id="ms-readout"></div>
    </main>
  `;

  const style = document.createElement('style');
  style.textContent = `
    .ms-shell { max-width: 480px; margin: 40px auto; padding: 0 20px;
      font-family: system-ui, sans-serif; color: #f2f2f2; }
    .ms-privacy { font-size: 13px; opacity: 0.75; }
    .ms-controls { display: flex; gap: 8px; margin: 16px 0; }
    .ms-controls button { font: inherit; padding: 8px 14px; border-radius: 6px;
      border: 1px solid #444; background: #1c1c22; color: #f2f2f2; cursor: pointer; }
    .ms-controls button:hover { background: #26262e; }
    .ms-error { color: #ff8080; font-size: 13px; }
  `;
  document.head.appendChild(style);

  const readoutContainer = app.querySelector<HTMLDivElement>('#ms-readout');
  const errorEl = app.querySelector<HTMLParagraphElement>('#ms-error');
  const controlsEl = app.querySelector<HTMLDivElement>('#ms-controls');
  const startCameraBtn = app.querySelector<HTMLButtonElement>('#ms-start-camera');
  const stopBtn = app.querySelector<HTMLButtonElement>('#ms-stop');

  if (readoutContainer && errorEl && controlsEl && startCameraBtn && stopBtn) {
    const readout = createParamsReadout(readoutContainer);

    let activeAdapter: InputAdapter | null = null;

    function showError(message: string): void {
      if (!errorEl) return;
      errorEl.textContent = message;
      errorEl.hidden = false;
    }

    function clearError(): void {
      if (!errorEl) return;
      errorEl.hidden = true;
      errorEl.textContent = '';
    }

    function stopActive(): void {
      if (activeAdapter) {
        activeAdapter.stop();
        activeAdapter = null;
        readout.reset();
      }
      if (stopBtn) stopBtn.hidden = true;
    }

    async function activate(adapter: InputAdapter): Promise<void> {
      stopActive();
      clearError();
      try {
        await adapter.start((params, timestampMs) => readout.update(params, timestampMs));
        activeAdapter = adapter;
        if (stopBtn) stopBtn.hidden = false;
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

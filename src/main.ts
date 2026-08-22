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
import { createWorld, type World, type WorldOverrides } from './world/world';
import { deriveWorldSeed, formatLocalDate } from './world/seed';
import { createBotanicalStyle } from './styles/botanical/botanical';
import { BOTANICAL_PALETTE_PRESETS, type BotanicalPaletteId } from './styles/botanical/palettes';
import { DEFAULT_BOTANICAL_TUNING_CONFIG, type BotanicalTuningConfig } from './styles/botanical/tuning-config';

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
      aspect-ratio: 3 / 2; background: #f7f0e3; border-radius: 8px; margin: 4px 0 16px; }
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
      const world = createWorld(worldSeed, 0, overrides);
      currentWorld = world;
      liveLoop = createLiveRenderLoop(
        createBotanicalStyle(panelTuningConfig),
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

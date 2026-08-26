/**
 * Paints a warm cream, watercolor-paper-textured background (docs/SPEC.md
 * Part 3, docs/styles/botanical.md section 4) -- fully deterministic from a
 * seed, no Math.random/Date.now, same invariant-3 rationale as src/world/
 * and src/styles/ even though this file lives outside those lint-banned
 * directories. Callers paint this *instead of* renderScene's old internal
 * clear (renderScene no longer clears -- see render-scene.ts), then call
 * renderScene on top to composite the actual scene.
 *
 * Note on positioning: this file has no concept of "world position" the
 * way render-scene.ts's SceneElements do (see that file's coordinate
 * convention doc comment). Its mottling/fine-grain texture positions are
 * seeded once per `worldSeed` and drawn as fractions of whatever the
 * current `canvasSize` is at repaint time -- it just fills whatever
 * rectangle it's given. As the canvas widens over a session, this means
 * the same ~15 mottle blobs and ~450 grain flecks spread across an
 * ever-larger area, so the texture visually thins out toward the growth
 * front rather than staying a constant density. That's a known, accepted
 * first-pass limitation for this milestone (a real tiling texture system
 * is out of scope here), not a bug.
 */
import { cyrb53 } from '../shared/hash';
import { createMulberry32 } from '../shared/prng';
import type { CanvasLike, CanvasSize } from './render-scene';

const BASE_COLOR = '#f7f0e3';

// A small fixed palette of cream/tan tones close to the base color, sampled
// by the seeded stream for both the low-frequency mottling and the fine
// grain passes.
const TONE_PALETTE = ['#efe4cf', '#f2ead9', '#faf5ea', '#e8dcc4'];

const MOTTLE_COUNT = 15;
const MOTTLE_RADIUS_MIN = 0.15; // fraction of shorter side
const MOTTLE_RADIUS_SPAN = 0.2; // radius lands in [0.15, 0.35)
const MOTTLE_OPACITY_MIN = 0.03;
const MOTTLE_OPACITY_SPAN = 0.05; // opacity lands in [0.03, 0.08)

const GRAIN_COUNT = 450;
const GRAIN_RADIUS_MIN_PX = 0.5;
const GRAIN_RADIUS_SPAN_PX = 1.0; // radius lands in [0.5, 1.5) px
const GRAIN_OPACITY_MIN = 0.02;
const GRAIN_OPACITY_SPAN = 0.03; // opacity lands in [0.02, 0.05)

// A control character separator (U+0001, "start of heading"), built via
// fromCharCode rather than an inline literal to keep it visible in
// editors/diffs. Mirrors src/world/labeled-stream.ts's own
// combineSeedLabel convention -- inlined rather than imported, to keep this
// file's dependency surface limited to src/shared/ (no src/world/ import).
const SEED_LABEL_SEPARATOR = String.fromCharCode(1);

/**
 * Paints a deterministic cream paper texture into `ctx`, sized to
 * `canvasSize`. Same seed always paints byte-identical pixels: every
 * position/radius/opacity/color-index draw comes from one seeded stream,
 * in the fixed order documented inline below.
 *
 * `grainScale` (default 1, added for src/compositor/export-render.ts's
 * high-resolution export path): a multiplier on the fine-grain pass's
 * device-pixel radius only. The mottling pass already sizes itself as a
 * fraction of `shorterSide`, so it scales itself correctly for free at any
 * `canvasSize` -- but the grain pass's radius (GRAIN_RADIUS_MIN_PX/SPAN_PX
 * above) is a fixed *device-pixel* count, deliberately NOT normalized
 * (this file's own top doc comment). Rendered at export resolution (e.g. 3x
 * the live canvas's pixel dimensions) with `grainScale` left at 1, the same
 * ~450 flecks at the same ~1px radius would occupy a proportionally smaller
 * fraction of the (now 3x wider/taller) canvas than they do live -- the
 * grain would visually thin out relative to the artwork instead of looking
 * like the same paper at higher fidelity. Passing the export's pixel scale
 * here (e.g. 3) keeps each fleck's radius proportional to the artwork's own
 * resolution, so grain density reads the same regardless of export scale.
 * Purely a post-multiply on each draw's radius -- never changes the seeded
 * stream's draw order/count, so this stays exactly as deterministic as
 * before (same seed + same grainScale always paints byte-identical pixels).
 */
export function renderPaperGround(ctx: CanvasLike, canvasSize: CanvasSize, seed: string, grainScale = 1): void {
  const draw = createMulberry32(cyrb53(`${seed}${SEED_LABEL_SEPARATOR}paper-ground`));
  const shorterSide = Math.min(canvasSize.width, canvasSize.height);

  // 1. Base fill.
  ctx.fillStyle = BASE_COLOR;
  ctx.globalAlpha = 1;
  ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);

  // 2. Low-frequency mottling: large, very-low-opacity circles. Per circle
  // draw order: x, y, radius, opacity, colorIndex.
  for (let i = 0; i < MOTTLE_COUNT; i++) {
    const x = draw();
    const y = draw();
    const radiusFrac = MOTTLE_RADIUS_MIN + draw() * MOTTLE_RADIUS_SPAN;
    const opacity = MOTTLE_OPACITY_MIN + draw() * MOTTLE_OPACITY_SPAN;
    const colorIndex = Math.floor(draw() * TONE_PALETTE.length);

    ctx.globalAlpha = opacity;
    ctx.fillStyle = TONE_PALETTE[colorIndex]!;
    ctx.beginPath();
    ctx.arc(x * canvasSize.width, y * canvasSize.height, radiusFrac * shorterSide, 0, 2 * Math.PI);
    ctx.fill();
  }

  // 3. Sparse fine grain: tiny, barely-there circles, fixed device-pixel
  // radius (not normalized). Per grain draw order: x, y, radius, opacity,
  // colorIndex -- same order/shape as the mottling pass above.
  for (let i = 0; i < GRAIN_COUNT; i++) {
    const x = draw();
    const y = draw();
    const radiusPx = (GRAIN_RADIUS_MIN_PX + draw() * GRAIN_RADIUS_SPAN_PX) * grainScale;
    const opacity = GRAIN_OPACITY_MIN + draw() * GRAIN_OPACITY_SPAN;
    const colorIndex = Math.floor(draw() * TONE_PALETTE.length);

    ctx.globalAlpha = opacity;
    ctx.fillStyle = TONE_PALETTE[colorIndex]!;
    ctx.beginPath();
    ctx.arc(x * canvasSize.width, y * canvasSize.height, radiusPx, 0, 2 * Math.PI);
    ctx.fill();
  }

  // 4. Leave the context in a clean state for whatever draws next.
  ctx.globalAlpha = 1;
}

# Bug retro — the fading/disappearing-marks bug (PR #16)

**Date:** 2026-08-23 · **Cost:** ~$80 in usage credits, 3 coordinator sessions, ~6 hours wall time
**Root cause:** a Canvas2D `globalAlpha` state leak in `src/compositor/live-compositor.ts` — per-element draws set the context's global opacity and never reset it, and `renderFrame` composited each persistent layer buffer without setting opacity first, so an entire layer's on-screen composite could silently render at ~4% opacity whenever a pale low-opacity element (watercolor blossom, echo stroke) happened to draw last. Fixed in `6eacd99`; regression test committed.

## What the money and time actually bought

- **7 real, verified bug fixes** — the state leak plus six latent paint-order/visibility bugs (cross-root, cross-branch, live-draw z-sort, ungated echo buckets, snapshot-timing gap, blocked-circle invisibility). All were genuine and would have surfaced later at their own cost.
- **Permanent tooling** — a committed pixel-divergence harness plus a "permanence oracle" (frame-to-frame vanish detection with per-element bake bookkeeping) that can catch this entire bug class automatically from now on.
- **Roughly half the spend, however, bought searching in the wrong bug class.** That half is what this retro targets.

## Why it took so long

1. **Real-but-irrelevant findings.** Five provably-real paint-order bugs sat in the same code area as the symptom. Each fix was backed by pixel evidence, felt like progress, and justified continuing in the same direction. A dead end makes you turn around; a real finding rewards you for staying on the wrong road.
2. **The falsifier was visible on day one and never weighed.** The symptom included marks *coming back* after a movement burst. No permanent-overwrite theory can explain restoration — permanently stamped-over pixels don't return. That one observation ruled out the entire bake-order family as the primary cause three sessions before it was abandoned.
3. **The symptom-shaped tool was built last.** The pixel-diff harness asked "does the live renderer match a reference?" — it surfaces every discrepancy but cannot distinguish "stamped in wrong order" from "faded on screen." The permanence oracle — which watches for the literal symptom, content vanishing between consecutive frames — found the bug on its first run; one draw-call forensic trace then pinned the root cause quantitatively (predicted vs measured pixels matched to rounding). ~5 hours of reference-diffing vs ~40 minutes of symptom-tracing.
4. **Unexplained residue got a reassuring label.** The simulations *did* reproduce the leak's signal twice, but it was filed under "known residual divergence / cross-bucket semantics" instead of being treated as unexplained.
5. **The bug's shape was adversarial.** A state leak manifests far from its cause, only under timing/content coincidences, and it mimicked the other bug class in the same early-canvas region (the earliest-baked content is exactly what fades).
6. **Cost mechanics amplified everything.** One long-lived builder agent was resumed dozens of times (reprocessing its growing history each time), and exhaustive verification sweeps were re-run after every fix instead of decisive spot checks.

## What changes (all in effect as of this session)

- **Symptom-first rule:** for any user-visible bug, the first tool built is an automated detector of the literal symptom in the cheapest environment that reproduces it. "Fixed" means that oracle reads clean — not that a related invariant holds.
- **Falsifier check:** before any fix is approved, list every observed symptom property; the hypothesis must explain all of them. Any unexplained property is a stop sign.
- **Residue discipline:** unexplained divergence is never filed under a known-cause label.
- **Canvas state hygiene:** any pass that sets `globalAlpha` (or similar shared-context state) restores it before returning — invariant documented in `live-compositor.ts` with a regression test reproducing the exact leak.
- **Cost hygiene:** builder agents retire after ~2–3 tasks instead of accumulating history; long verification runs are batched into single invocations; sweeps trim to decisive spot checks once a mechanism is confirmed. (Recorded in coordinator memory so future sessions start this way.)

## Tracked follow-ups (not part of this retro's scope)

- Cross-bucket z-overlap layering semantics — founder design decision, comparison renders generated.
- Live-drawn blossom count has no structural cap — watch long-session frame cost.

# MoveScape — UI Style Guide

*2026-08-24. Deliver phase's visual-design output (see `UX_PLAN.md`). Governs page/product UI only — button, panel, and text treatment. It does not touch the generative art itself, which stays `docs/styles/botanical.md`'s territory. Direction: "Typewriter Utility," from the founder's own hi-fi mockups (see `develop.md`'s fourth feedback pass for the structural decisions that came out of the same pass).*

## Governing principle

**The artwork supplies all color. UI chrome supplies none.** Every button, label, panel, and piece of UI text renders in one ink color against the canvas's own paper tone — no accent colors, no status colors, no distinct "this button means something different" color anywhere in the chrome. Color is not a UI vocabulary in this product; it's reserved entirely for what the movement makes. (This is also why Discard lost its earlier proposed muted-color treatment — see `develop.md`'s fourth-pass note.)

**The canvas is full-bleed.** It isn't a boxed panel inset in the page — it *is* the page background, edge to edge, on every screen. Everything else floats on top of it.

## Palette

| Token | Value | Use |
|---|---|---|
| `--paper` | `#f7f0e3` | Page/canvas background — reused verbatim from `docs/styles/botanical.md`'s decided cream watercolor paper, since the canvas is now the page background everywhere, not a separate surface. |
| `--ink` | `#241a17` | All text, icons, borders, and button labels. Warm near-black, not pure black. Confirmed by the founder 2026-08-25 — these hex values are authoritative, not estimates. |
| `--scrim` | `rgba(247, 240, 227, 0.88)` | Semi-opaque `--paper`-tinted backing behind any floating UI element (header, control zone, magic panel, camera PiP frame). Invisible over plain paper; a legible scrim over busy art. |

No other colors exist in the UI system. If a future screen seems to need one, that's a signal to solve it with layout/typography first, per the governing principle above.

## Typography

Single family throughout — deliberately one voice, not a display/body pairing:

- **IBM Plex Mono** (400 regular, 500 medium), fallback stack: `'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace`.

| Role | Size | Weight | Notes |
|---|---|---|---|
| Wordmark | 14px | 500 | lowercase `movescape`, slight letter-spacing |
| Body (explainer card) | 14–15px | 400 | line-height ~1.6 |
| Button / control label | 13px | 500 | bracket-wrapped: `[ Label ]` |
| Timer | 13px | 400 | tabular numerals |
| Code panel | 12–13px | 400 | the verbatim source itself — no separate "code font," it's already the UI font |
| Micro / section labels | 10–11px | 500 | uppercase, letter-spaced (e.g. "SHOW THE MAGIC", readout row labels) |

## Spacing

4px base unit. Common increments: 8, 12, 16, 24, 32, 48.

## Components

**Buttons** — plain bracket-style text controls, no fill, no border: `[ Start ]`, `[ Save this piece ]`. Ink-colored text on the scrim backing when floating over the canvas. No color distinguishes one button's consequence from another's (see governing principle) — hierarchy and misclick safety come from spacing and ordering, not color. Minimum 44px hit target (padding, not visible box size).

**Panels / cards** (explainer card, magic panel) — plain 1px rectangle, `--ink` at reduced opacity (~30%) for the border, `--scrim` fill. No corner radius, no shadow — flat, utilitarian.

**Camera preview** — small picture-in-picture, bottom-right corner of the canvas, on the same scrim backing.

**Magic panel** — floats over the canvas, docked left (growth sweeps left-to-right per `botanical.md`'s "the Scroll," so the left edge is typically the calmer, already-grown part of the piece). Exact size/shape intentionally left open until it's holding real content.

---

*Visual reference: [`movescape - high fidelity mockups.png`](./movescape%20-%20high%20fidelity%20mockups.png) in this folder — the founder's four-frame hi-fi mockup set (Idle / Live / Finish / Live with magic shown). It supersedes the earlier published design-canvas artifact, whose source files were deleted 2026-08-25 as redundant with this doc + the mockups.*

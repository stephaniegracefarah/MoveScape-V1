# Develop — Low-Fidelity Wireframes

*2026-08-23. Output of the Develop phase (see `UX_PLAN.md`). Six low-fidelity wireframes, two structural variants per key screen, each variant a real answer to one of Define's open questions rather than an arbitrary layout guess. Boxes and labels only — no color, type, or spacing decisions; that's Deliver's job.*

**Feedback pass (2026-08-23):** decisions and revisions below each screen's original variants — kept, not overwritten, so the exploration stays visible per this project's own documentation convention.

**Cross-screen layout principle (new, applies to all three screens):** every screen's session-level controls live in the same top row, above the content area — not one screen's controls above the canvas and another's below. `[ Start ]` on Idle becomes `[ Pause ]`/`[ Resume ]` in that exact slot during the live session, and the same slot is replaced by the three save/discard decision buttons once a session finishes — one control zone throughout the whole flow, never a second location.

**Fourth feedback pass (2026-08-24) — full-bleed canvas, from the founder's own hi-fi mockups.** Several structural decisions came out of a real style pass (visual direction: "Typewriter Utility" — warm paper, near-black ink, IBM Plex Mono, plain 1px rectangles, bracket-style `[ Label ]` buttons; "artwork supplies the color," meaning UI chrome carries no color of its own). These are structural, not just visual, so recorded here rather than only in the style guide:

- **The canvas is full-bleed.** It's not a boxed panel inset within the page — it *is* the page background, edge to edge, on every screen. All UI (header, control zone, magic panel, camera) floats on top of it rather than living beside or below it in its own frame. This also settles the earlier open palette question in `UX_PLAN.md`'s Develop phase: the UI doesn't get a separate neutral palette after all — it shares the canvas's own paper tone directly, since the canvas *is* the backdrop everywhere, not a panel next to a separate chrome.
- **Semi-opaque, canvas-tinted backing on every floating UI element.** Any button, label, or panel that can sit over the canvas gets a background tinted to match the canvas's own base paper color at reduced opacity — invisible (reads as plain paper) wherever there's no art underneath, and a legible scrim wherever there is. This is the resolution to the real legibility risk floating UI over unpredictable art color creates.
- **Camera moves from an equal-sized side panel to a small picture-in-picture**, bottom-right corner of the canvas, secondary and unobtrusive — consistent with the camera/skeleton already being an opt-in reveal behind "Show the magic," not a default focal point.
- **"Show the magic" now floats over the canvas itself, docked left**, rather than living in normal flow under the canvas. Deliberate: the canvas is full-bleed now, so the panel has to float *somewhere* over it; left is chosen because growth sweeps left-to-right (`docs/styles/botanical.md`'s "the Scroll"), so the left edge is typically the calmer, already-grown part of the piece rather than the active growth front. Exact size/shape (short vs. tall, compact vs. long) is explicitly deferred until real stats are sitting in it and it can be judged by eye.
- **A session elapsed-time readout** (`08:42`-style) joins the header next to the wordmark during a live session. Deliberately just elapsed time, not framed as a countdown, streak, or pace metric — checked against Discover's explicit rejection of fitness-gamification framing (theme 5 / competitive analysis) and judged to be on the right side of that line: it's information about the session, not a score.
- **Discard's button color is revised back to monochrome**, overriding the Finish-section decision below that gave it "a distinct, more neutral/muted color... purely to lower the odds of an accidental misclick." Under the new "artwork supplies all color" discipline, no UI chrome carries color, Discard included — so misclick protection has to come from layout (spacing, order, never adjacent to the equivalent of the old Stop/Finish risk) rather than a color cue. Flagged, not silently dropped: this is a real reversal of an explicit earlier decision, worth double-checking holds up once the three Finish buttons are actually sitting next to each other in bracket-button form.

**Fifth feedback pass (2026-08-25) — the finished hi-fi mockups** (`deliver-style-guide/movescape - high fidelity mockups.png`, four frames: Idle / Live / Finish / Live with magic shown). The mockups confirm the fourth-pass structure throughout, and add three decisions not previously recorded anywhere:

- **The canvas scrolls horizontally as the art grows.** A scroll bar appears at the bottom of the canvas once the piece outgrows the viewport — the full-bleed canvas is a window onto the growing Scroll, not a fixed frame the art is squeezed into. New structural element; nothing earlier in this doc covered what happens when the piece gets longer than the screen.
- **Finish-screen heading is "This piece is yours."** — replacing the wireframes' placeholder "Session finished." Decided copy, not a sketch.
- **The Idle explainer card gains two lines**: "…The art responds live while you move **(or don't move)**." and "**Please use a desktop browser for the best experience.**" Both decided copy.

The mockups' own style note that "text / controls will need to be color-responsive or otherwise visible against a variety of colors on the canvas" is already resolved by the fourth-pass scrim decision above — noted here so the mockup annotation isn't mistaken for an open question.

## Idle / first-load

*Testing: how does the page build trust and set expectations using only itself (Define's success criterion 3)?*

**A — minimal, art-forward**

```
+------------------------------------------+
|  MoveScape                                |
|                                            |
|  +--------------------------------------+ |
|  |                                      | |
|  |                                      | |
|  |         (empty paper canvas)         | |
|  |                                      | |
|  |                                      | |
|  +--------------------------------------+ |
|                                            |
|              [ Start ]                    |
|                                            |
|  On-device only. Camera never leaves      |
|  this device.                             |
+------------------------------------------+
```

Lets the empty canvas and a single line of privacy reassurance do all the work. Fastest path to starting; relies on the visual alone to communicate what MoveScape is.

**B — trust-building intro**

```
+------------------------------------------+
|  MoveScape                                |
|                                            |
|  +--------------------------------------+ |
|  | Make art with your body.              | |
|  |                                        | |
|  | Your camera stays on this device --   | |
|  | nothing is ever uploaded.             | |
|  |                                        | |
|  | Move however you want. The art        | |
|  | responds live, while you move.        | |
|  +--------------------------------------+ |
|                                            |
|              [ Start ]                    |
|                                            |
|      (faint hint of today's palette)      |
+------------------------------------------+
```

Spends a moment explaining the concept and the privacy model explicitly before asking for camera access, since (Discover finding) MoveScape has no gallery room or attendant to do this priming for it. Slower to "Start," but nothing is left for the user to infer.

**Decision: B.** Revised to put `[ Start ]` in the top control row rather than below the text card, per the cross-screen layout principle above:

```
+------------------------------------------+
|  MoveScape                    [ Start ]   |
|                                            |
|  +--------------------------------------+ |
|  | Make art with your body.              | |
|  |                                        | |
|  | Your camera stays on this device --   | |
|  | nothing is ever uploaded.             | |
|  |                                        | |
|  | Move however you want. The art        | |
|  | responds live, while you move.        | |
|  +--------------------------------------+ |
|                                            |
|      (faint hint of today's palette)      |
+------------------------------------------+
```

**Refinement (second feedback pass):** `[ Start ]` moves to be the first button, directly under the "MoveScape" title, not floated on the title's own line. This is also what carries the top-row zone forward into the live session below — `[ Start ]` becomes `[ Pause ]` in that same slot once a session begins, rather than being a separate button.

```
+------------------------------------------+
|  MoveScape                                |
|  [ Start ]                                |
|                                            |
|  +--------------------------------------+ |
|  | Make art with your body.              | |
|  |                                        | |
|  | Your camera stays on this device --   | |
|  | nothing is ever uploaded.             | |
|  |                                        | |
|  | Move however you want. The art        | |
|  | responds live, while you move.        | |
|  +--------------------------------------+ |
|                                            |
|      (faint hint of today's palette)      |
+------------------------------------------+
```

**Fourth-pass layout (2026-08-24):** same full-bleed rule as the other two screens — the paper background runs edge to edge behind the header, `[ Start ]`, and the explainer card, all sitting on the semi-opaque canvas-tinted backing described in the fourth-pass note above (here it just blends into plain paper, since there's no art yet to scrim against).

## Live session

*Testing: should the movement-tracking mechanism be visible or hidden (Discover/Define's central open tension)?*

**A — mechanism hidden**

```
+------------------------------------------+
|  [Pause]   [Finish]              [Stop]   |
|                                            |
|  +--------------------------------------+ |
|  |                                      | |
|  |                                      | |
|  |      (growing artwork --             | |
|  |       full width/height focus)       | |
|  |                                      | |
|  |                                      | |
|  +--------------------------------------+ |
|                                            |
+------------------------------------------+
```

No readout at all. Movement becomes art with nothing else on screen to look at — closest to "the live canvas is the experience" taken literally.

**B — mechanism visible, reframed**

```
+------------------------------------------+
|  [Pause]   [Finish]              [Stop]   |
|                                            |
|  +--------------------------------------+ |
|  |                                      | |
|  |      (growing artwork)               | |
|  |                                      | |
|  +--------------------------------------+ |
|                                            |
|   ~~~ reaching · steady · in motion ~~~   |
|      (ambient, qualitative, not the       |
|       raw Expansion/Speed/Symmetry        |
|       decimals)                          |
+------------------------------------------+
```

**Decision: neither A nor B.** Feedback: the camera feed should be visible alongside the canvas by default (not hidden, reversing today's actual default), with an option to hide it — and a dedicated **"Show the magic"** control that, while the camera is visible, overlays the body-tracking skeleton on the feed and exposes the real mechanism: the raw input decimals plus the actual, verbatim source of whichever function is computing that behavior right now.

**C — canvas + camera default, "Show the magic" toggle**

Default state (magic off):

```
+------------------------------------------+
|  [Pause] [Finish]  [Show the magic] [Stop]|
|                                            |
|  +----------------------+  +------------+ |
|  |                      |  |  (camera   | |
|  |   (growing artwork)  |  |   preview, | |
|  |                      |  |   visible  | |
|  |                      |  |   default) | |
|  +----------------------+  +------------+ |
|                              [hide camera] |
+------------------------------------------+
```

With "Show the magic" toggled on:

```
+------------------------------------------+
|  [Pause] [Finish]  [Hide the magic] [Stop]|
|                                           |
|  +----------------------+  +------------+ |
|  |                      |  | (camera +  | |
|  |   (growing artwork)  |  |  pose-     | |
|  |                      |  |  tracking  | |
|  |                      |  |  skeleton  | |
|  +----------------------+  |  overlay)  | |
|                             +------------+ |
|                              [hide camera] |
|                                            |
|  expansion 0.62   speed 0.41   symmetry 0.88 |
|                                            |
|  growthStep = baseRate x dt x (floor +    |
|               speed x (1 - floor))        |
|             = 0.00005 x 16.67 x (0.06 +   |
|               0.41 x 0.94)                |
|             = 0.00035                     |
+------------------------------------------+
```

The skeleton overlay depends on the camera feed being visible (it draws on top of it); the decimals and live-formula view don't strictly need to, and could stay available even with the camera hidden — worth deciding explicitly rather than assuming, when this gets built.

**Refinement (second feedback pass):**
- `[ Start ]` (from Idle) becomes `[ Pause ]` in the same top-row slot — not a separate button. Clicking it toggles the label to `[ Resume ]` in place.
- `[Show the magic]` moves out of the top control row entirely — it's a canvas-viewing option, not a session control, so it now sits under the canvas.
- The decimals go back to the app's existing bar-plus-number style (`readout.ts`'s current pattern), not a plain text line.
- `[ Stop ]` is removed — too easy to confuse with `[ Finish ]`, the same adjacency risk flagged earlier in this whole exercise. In its place: an optional `[ Restart ]`, which abandons the current piece and begins a fresh one, gated behind a confirmation (since it's destructive in a way Pause/Finish aren't), and carries forward the session's current camera/magic display settings rather than resetting them.
- **Sub-question resolved (third feedback pass, 2026-08-23):** raw source, not a curated formula. The honesty bar the founder set: someone who reads code should be able to watch the panel and verify what's actually running, not trust a summary of it — a formula translated for readability, however faithful, is still a claim standing between the viewer and the code, and can only be trusted, not checked. Scoped to the function actually computing the behavior (not the whole file it lives in), so the crop is a function boundary, not an editorial choice about what counts as "the mechanism." Checked against the real code (`branch.ts`, `params-from-landmarks.ts`) and confirmed the mechanism isn't one function per readout number — Speed drives its own function (`growthStepFor`); Expansion and Symmetry are both inputs to one shared function (`wanderDeltaFor`), not two independent ones. So the panel gives the viewer two lenses matching the two real functions, not three matching the three readout numbers, which would have implied a separation the code doesn't have. **This is illustrative of the pattern, not a locked contract** — the app is still in active dev, and `growthStepFor`/`wanderDeltaFor` may be renamed, split, or restructured before Deliver. The decision that survives any such refactor: two tabs, each grouped by real function boundary (not by readout label), each showing that function verbatim with its live argument values annotated inline, whatever that function is called by the time this gets built.

**Fourth-pass layout (full-bleed canvas, PiP camera):**

```
+------------------------------------------+
|  MoveScape                        08:42   |
|  [ Pause ]      [ Finish ]     [Restart]  |
|                                            |
|                                            |
|      (full-bleed growing artwork --       |
|       the canvas IS the page background,  |
|       edge to edge, not an inset panel)   |
|                                            |
|                                            |
|                                  +------+  |
|                                  |camera|  |
|                                  | PiP  |  |
|                                  +------+  |
|                              [hide camera] |
|                                            |
|            [ Show the magic ]             |
+------------------------------------------+
```

Header, control-zone buttons, `[hide camera]`, and `[ Show the magic ]` all sit on a semi-opaque canvas-tinted backing (see the fourth-pass note above) so they stay legible over busy art and disappear into plain paper where there isn't any.

With the magic shown (and mid-pause, to demonstrate the label toggle) — fourth-pass layout: full-bleed canvas behind everything, camera stays a PiP bottom-right, and the magic panel is now a floating card docked to the *left* edge of the canvas (not living under it in normal flow), on the same semi-opaque canvas-tinted backing as the rest of the chrome:

```
+------------------------------------------+
|  MoveScape                        08:42   |
|  [ Resume ]     [ Finish ]     [Restart]  |
|                                            |
|  +--------------------+                   |
|  | SHOW THE MAGIC     |                   |
|  | actual code + live |     (full-bleed   |
|  |       values       |      growing      |
|  |                    |      artwork,     |
|  | [Speed->growth]    |      edge to      |
|  | [Expansion+Symmetry|      edge, behind |
|  |  ->wander]         |      everything)  |
|  |                    |                   |
|  | branch.ts :        |                   |
|  |  growthStepFor()   |                   |
|  |                    |                   |
|  | export function    |                   |
|  |  growthStepFor(    |                   |
|  |   args: {          |                   |
|  |  dt,     // 16.67  |                   |
|  |  speed,  // 0.41   |                   |
|  |  ...               |                   |
|  |  -> 0.00035        |                   |
|  |                    |                   |
|  | Expansion   0.62   |                   |
|  | Speed       0.41   |                   |
|  | Symmetry    0.88   |                   |
|  +--------------------+          +------+ |
|                                   |camera| |
|                                   | PiP  | |
|                                   +------+ |
|                              [hide camera] |
|            [ Hide the magic ]             |
+------------------------------------------+
```

Size and shape of the floating magic panel (short/wide vs. tall/compact, how much padding, whether the tabs sit above or beside the code) is explicitly left open until it's holding real content and can be judged by eye — this ASCII shape is a placeholder for "floats left, sits on top," not a locked proportion. The other tab swaps the code block to that function's own real source (`wanderDeltaFor` as of this writing) with its own live-annotated arguments — same pattern, different function. The bar-plus-number readout for all three params stays visible underneath regardless of which tab is selected.

`[ Restart ]`'s confirmation, since it's the one destructive action left on this screen:

```
+------------------------------------------+
|  Restart?                                 |
|  This discards the current piece and      |
|  starts a fresh one. Your camera and      |
|  magic display settings carry over.       |
|                                            |
|         [ Cancel ]      [ Restart ]       |
+------------------------------------------+
```

One thing worth flagging rather than deciding silently: putting `[Restart]` back in the same top row as `[Finish]` risks quietly recreating the exact adjacency problem Stop just got removed for. The confirmation dialog is a real safety net, but `[Restart]`'s visual treatment (color, spacing) should stay clearly distinct from `[Finish]` in Deliver, not just rely on the confirm step to do all the work.

## Finish / save-discard

*Testing: binary Save/Discard, or a multi-path decision point (the Midjourney-inspired synthesis theme)?*

**A — binary, hierarchy fixed**

```
+------------------------------------------+
|  Session finished.                        |
|                                            |
|  +--------------------------------------+ |
|  |       (frozen finished piece)         | |
|  +--------------------------------------+ |
|                                            |
|         [ Keep this piece ]               |
|                                            |
|              discard                      |
|         (small, quiet, text-only)         |
+------------------------------------------+
```

Same two outcomes as today, but no longer equal-weight adjacent buttons — Keep is the obvious primary action, Discard is deliberately smaller and separated, closing the earlier Stop/Finish-style misclick risk without changing the underlying model.

**B — multi-path**

```
+------------------------------------------+
|  Session finished.                        |
|                                            |
|  +--------------------------------------+ |
|  |       (frozen finished piece)         | |
|  +--------------------------------------+ |
|                                            |
|   [ Keep ]      [ Keep moving ]           |
|                                            |
|              discard                      |
|         (small, quiet, text-only)         |
+------------------------------------------+
```

A real third path — "Keep moving" resumes the same session instead of forcing a hard stop, the direct answer to the Midjourney finding (keep/reroll/vary/discard, not just a binary).

**Decision: neither A nor B as drawn.** Feedback: all three paths at the same level, as real equal-status buttons — Discard included. Explicitly rejected the earlier "small, quiet, text-only" treatment for Discard as a dark pattern: discarding is a genuinely equally valid choice (the same principle the product already applies to effort — no judgment between valid options), so visually diminishing it would nudge against a choice the product itself claims not to rank. A distinct, more neutral/muted color for Discard is fine, purely to lower the odds of an accidental misclick — but same size, same weight, same button treatment as the other two. "Keep" renamed to "Save this piece" for concreteness.

*Revised, fourth feedback pass (2026-08-24):* Discard's distinct color is dropped — see the fourth-pass note under "Live session" above. Under the "artwork supplies all color" rule that came out of the real style pass, no button gets a color cue, Discard included; same size, same weight, same bracket-button treatment as the other two, now including color. Misclick protection has to come from spacing/order instead. Flagged there as worth double-checking once real buttons are sitting next to each other.

**C — three equal-weight buttons, one row**

```
+------------------------------------------+
|  Session finished.                        |
|                                            |
|  +--------------------------------------+ |
|  |       (frozen finished piece)         | |
|  +--------------------------------------+ |
|                                            |
|  [ Save this piece ] [ Keep moving ]      |
|  [ Discard ]                              |
|  (Discard: same size/weight as the        |
|   other two, distinct muted color only)   |
+------------------------------------------+
```

**Refinement (second feedback pass):** rather than a separate button row below the canvas, the three decision buttons *replace* the top control row directly — the same zone that held `[Pause] [Finish] [Restart]` a moment earlier now holds the decision buttons instead, so every session-level control lives in exactly one place throughout the whole flow, never a second location.

```
+------------------------------------------+
|  [Save this piece] [Keep moving][Discard] |
|                                            |
|  +--------------------------------------+ |
|  |       (frozen finished piece)         | |
|  +--------------------------------------+ |
+------------------------------------------+
```

**Fourth-pass layout (2026-08-24):** same full-bleed treatment as Live session — the frozen piece is the page background edge to edge, not an inset panel, and the three decision buttons sit on the semi-opaque canvas-tinted backing. All three are now monochrome (see the revision note above):

```
+------------------------------------------+
|  MoveScape                                |
|  [Save this piece] [Keep moving][Discard] |
|                                            |
|      (full-bleed frozen finished piece,   |
|       edge to edge, page background)      |
+------------------------------------------+
```

`[ Restart ]` doesn't reappear here — it's a mid-session, still-growing-piece action; once Finish has already been clicked, `[ Keep moving ]` covers the "I'm not actually done" case instead, which is a resume, not a full discard-and-restart.

## Dev tools zone

*Out of scope for this doc's actual subject (the real, shipped user's experience — a dev/QA user is a genuinely different persona from the one everything above is designed for), but explicitly addressed here so a builder reading this doc later doesn't mistake silence for "remove these." All three of the app's existing dev-only affordances — the slider input adapter, the pose-tuning jitter slider, and the backend-knobs tuning panel — are consolidated into one clearly-marked zone, instead of staying scattered across the main controls row and two separate divs the way they are today. Never appears in a production build; this whole zone is dev-build-only, same as it is now.*

Collapsed by default, sitting outside and below the real session flow entirely — never inside the top control row that Idle/live-session/finish share:

```
+------------------------------------------+
|  ... (real app content above) ...         |
|                                            |
|  --------------------------------------   |
|  [ Show dev tools ]  (dev builds only)    |
+------------------------------------------+
```

Expanded:

```
+------------------------------------------+
|  DEV TOOLS -- never shown in production   |
|  +--------------------------------------+ |
|  | Input source:                         | |
|  |   [ Use camera ]   [ Use sliders ]    | |
|  |                                        | |
|  | Pose jitter floor  [====------] 0.15  | |
|  |                                        | |
|  | World knobs / tuning config           | |
|  |   hueBase          [=====-----]       | |
|  |   branchDensity    [===-------]       | |
|  |   ... (remaining knob/tuning sliders) | |
|  |                                        | |
|  |   [ Export current values ]           | |
|  +--------------------------------------+ |
+------------------------------------------+
```

---

*Done: a direction is now chosen for all three screens (Idle: B, revised; Live session: C; Finish: C) — see the "Decision" note under each screen above. The one open sub-question (curated formula vs. raw source for "Show the magic") is now resolved in favor of raw source, verbatim, windowed to whichever real function drives the behavior — see the third-feedback-pass note under Live session. A fourth feedback pass (2026-08-24), prompted by the founder's own hi-fi mockups, moved the canvas to full-bleed, the camera to a PiP, floated the magic panel over the canvas, added a session timer, and reverted Discard to monochrome — see the fourth-pass notes throughout. A fifth pass (2026-08-25) against the finished mockups added the horizontal canvas scroll, the "This piece is yours." finish copy, and the expanded idle copy. Develop is complete; the visual system lives in `deliver-style-guide/style-guide.md`, with the mockups alongside it as the visual reference.*

# MoveScape — UX Plan

*Draft 1 — August 2026*

## What this document is

A deliberate, process-driven UX plan for MoveScape's **page/product experience** — layout, buttons, information architecture, and flow. It does not cover the look of any art style; each style's visual spec lives in its own `docs/styles/<style>.md` (see `docs/styles/botanical.md`), and that boundary is intentional. This document exists so the page-level UX gets the same deliberate treatment the engine and the art already get, rather than continuing to grow directly out of engineering milestones with no dedicated design pass.

This is a plan document: it lays out what each phase involves and produces. It gets filled in with real findings/decisions as each phase is actually run, not all at once up front.

## Framework

Structured around the **Double Diamond** (UK Design Council, first published 2004, refined 2019) — two cycles of widen-then-narrow thinking:

**Discover → Define → Develop → Deliver**

Compatible with, and can be cited alongside, **ISO 9241-210** ("Ergonomics of human-system interaction — Human-centred design for interactive systems"), the international standard covering the same territory in more formal terms (understand context of use → specify user requirements → produce design solutions → evaluate).

## Status

| Phase | Status |
|---|---|
| Discover | **Done** — see [`discover-findings.md`](./discover-findings.md) |
| Define | **Done** — see [`define.md`](./define.md) |
| Develop | **Done** — see [`develop.md`](./develop.md); direction chosen for all 3 screens, "Show the magic" resolved in favor of raw source |
| Deliver | Not started |

---

## 1. Discover

Widen: gather raw material broadly before deciding what the actual problem is. Given MoveScape v1's single user, this leans on autoethnography (studying one's own experience directly) and existing material rather than multi-user interviews.

**Purpose:** Understand the current state, the competitive/analog landscape, and any real signal already available — without yet committing to what to fix.

**Inputs:** `docs/SPEC.md`'s existing competitive analysis; the product as it exists today.

**Activities (scoped 2026-08-23, analog list revised same day):**
- **Competitive analysis** — reuse `SPEC.md`'s "why this is different from what exists" section (Chris Milk, Move Mirror, Art Blocks, Strava GPS art, fitness gamification) rather than redoing it.
- **Analog research** — look at adjacent products/practices that solve a piece of this problem. First pass leaned on fitness/wellness apps (Calm, Headspace, Strava, Apple Fitness+) and over-indexed on camera-as-privacy-problem, implicitly framing MoveScape as a fitness app with a camera bolted on — corrected per founder direction, since MoveScape's core identity is generative art from movement/data via math and code, camera being only the first of several possible input adapters. Revised to the creative-coding / generative-art / live-performance tradition instead: algorave/live coding (TidalCycles, Sonic Pi), the Processing/p5.js lineage and Vera Molnár's determinism-as-convention, Brian Eno & Peter Chilvers' *Bloom*/*Reflection*, and (unchanged from the first pass, never fitness-flavored) Midjourney's keep/reroll/vary/discard pattern.

**Explicitly deferred, with reasoning:**
- *Mining `HANDOFF.md`'s founder session-log feedback* — rejected as a Discover input. That feedback is almost entirely about the art/style (branch density, blossom reveal pacing, etc.), which is out of scope for a page-UX doc.
- *A cold-start ("fresh eyes") usability pass on the current UI* — deferred to **Deliver**. The current UI grew directly out of engineering milestones with no deliberate layout pass yet, so testing it now would mostly re-surface the informal heuristic critique already given, not yield new signal. It earns its keep once there's an intentional design to test against.

**Output artifacts:** A short synthesis of competitive/analog findings.

**Done when:** The competitive and analog research is actually written down, not just planned.

---

## 2. Define

Narrow: take Discover's findings and squeeze them into one sharp problem statement everything else gets measured against.

**Purpose:** Turn broad research into a single, agreed problem statement.

**Inputs:** Discover's completed synthesis (competitive + analog findings), plus any heuristic/expert critique already on record.

**Activities:** Cluster Discover's findings into themes; narrow those themes into one problem statement; write a short user-need statement ("as a [user], I need [thing], so that [outcome]"); set success criteria specific to page/product UX.

**Output artifacts:** One problem statement. One user-need statement. A short list of success criteria.

**Done when:** There's one sentence both collaborators can point to as "this is the thing we're solving" — not a list of issues, one statement.

---

## 3. Develop

Widen again: now that there's one problem statement, explore a real range of possible solutions before picking one.

**Purpose:** Generate and explore multiple layout/flow directions for the problem statement, on purpose not settling on the first idea.

**Inputs:** Define's problem statement, user-need statement, and success criteria.

**Activities:** Ideation across multiple structural directions; low-fidelity wireframing of the key screens (idle state, live session, finish/save), probably a few variants per screen; a prototype of the most promising direction, clickable enough to test flow sequencing; early informal feedback on the wireframes/prototype.

**Output artifacts:** Multiple wireframe options per key screen; at least one prototype of the primary flow (start → move → finish → save/discard); notes from early feedback.

**Done when:** A meaningful range of directions has been explored, and one is chosen to move forward with — not polished yet, just decided.

---

## 4. Deliver

Narrow for the last time: take the chosen direction and turn it into the real, built thing.

**Purpose:** Refine the chosen direction into a finished, tested, built solution.

**Inputs:** The winning wireframe/prototype from Develop.

**Activities:** Visual design (color, typography, spacing, iconography applied to the chosen structure); usability testing — this is where the cold-start test deferred from Discover happens, against the real design rather than the current ad-hoc one; refinement based on what testing turns up; implementation (writing the actual CSS/HTML changes, since this is a solo build with no separate handoff).

**Output artifacts:** Final visual design; usability test notes; the built UI itself.

**Done when:** The shipped page matches what was intended, and it can be checked plainly against Define's success criteria.

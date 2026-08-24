# Discover — Findings

*2026-08-23. Output of the Discover phase (see `UX_PLAN.md`). Scope: page/product UX only, not art style.*

## Competitive analysis

Reused from `docs/SPEC.md`, reframed through a page-UX lens — what each one teaches about *interface*, not just positioning:

- **Gallery installations** (Chris Milk's *The Treachery of Sanctuary*, Camille Utterback, teamLab) — succeed with almost no onboarding UI at all, because a physical gallery space, an attendant, and wall text do all the trust-building and expectation-setting for free. A browser app doesn't get that for free — MoveScape's page has to do, alone, what a room and a person normally do together.
- **Move Mirror / Pose Animator** — low-friction, single-purpose novelty demos (point your camera, see a puppet move). Not close analogs for a multi-session product, but a reminder that "just start" can work fine when the thing on the other side of starting is simple and disposable — which MoveScape's is not (a real, keepable piece is at stake).
- **Art Blocks / fxhash** — their interface is a marketplace/browsing UI first (mint, collect, view a gallery of others' pieces), not a live-performance UI. Not a direct analog for the live-creation moment, but relevant later for however MoveScape's own gallery view eventually looks.
- **Strava GPS art** — the picture is planned first, then performed (run the route you already designed), reversed from MoveScape (the art is discovered through moving, not pre-planned). This means MoveScape's reveal moment carries more weight than Strava GPS art's does — the user genuinely doesn't know what they're going to get.
- **Fitness gamification** (streaks, badges, leaderboards) — already a rejected pattern at the product-principle level. Worth restating here as a literal UI constraint: no streak counters, no badge icons, no leaderboards, anywhere in the interface, ever.

## Analog research

*Revised 2026-08-23 — the original pass leaned on fitness/wellness apps (Calm, Headspace, Strava, Apple Fitness+), which over-indexed on camera-as-privacy-problem and implicitly framed MoveScape as a fitness app with a camera bolted on. Corrected per founder direction: MoveScape's core identity is generative art from movement/data via math and code, with camera+pose as the first of several possible input adapters — not the product's identity. Re-run against the creative-coding / generative-art / live-performance tradition instead. The Midjourney entry below is unchanged from the original pass — it was never fitness-flavored and remains a valid analog.*

### Process transparency — algorave / live coding (TidalCycles, Sonic Pi)

This turned up the single strongest, most directly relevant finding of the whole research pass. Live coding is a real performance tradition — Sam Aaron's Sonic Pi and Alex McLean's TidalCycles are used to perform techno/breakbeat sets live at festivals (Glastonbury, the Royal Albert Hall) and at algorave events worldwide (London, Berlin, Tokyo, Mexico City), by literally projecting the performer's screen while they write and edit code in real time. The scene's own mantra is **"Show us your screens"** — the audience watches the code itself change, sees where a beat broke, and watches it get fixed live. TOPLAP, the movement's own manifesto group, states the philosophy directly: *"algorithms are thoughts, and thoughts should be visible."*

This directly complicates something I recommended earlier in our conversation — hiding MoveScape's Expansion/Speed/Symmetry readout because it felt too much like a dev tool. In live-coding culture, visible mechanism isn't a flaw to be polished away — it's the whole point, and part of what makes the audience trust and connect with what they're watching. Worth reconsidering whether some visible readout of *how* the movement is becoming art belongs in MoveScape's real experience, reframed as an honest window into the process rather than a debug panel, instead of being hidden entirely.

### Determinism as an artistic convention, not just an engineering constraint — Processing/p5.js lineage, Vera Molnár

Processing (Casey Reas and Ben Fry, 2001) and its web successor p5.js (Lauren Lee McCarthy, 2013) built the modern creative-coding movement on a "sketchbook-like environment" with immediate visual feedback — code as a visual art medium, deliberately de-intimidated. Vera Molnár, one of generative art's actual pioneers (working since the 1960s), built her practice on setting initial conditions and constraints and letting a rule-following system produce variation within them — and critically, **the same seed always produces the same composition**, a convention she shares with contemporary generative-art platforms like fxhash and artists like Tyler Hobbs.

That's not a coincidental resemblance — it's the exact mechanism MoveScape's own seed system already implements (`worldSeed = hash(userId, date)`). Worth being confident about this rather than treating it as internal plumbing to hide: MoveScape's determinism is squarely inside a real, respected artistic tradition, not just a technical requirement for replay. "Today's world is deterministic from your seed" is a legitimate thing to surface to the user as a feature — the calendar-personality framing your spec already wants ("Tuesday is Tuesday") — rather than something the UI stays quiet about.

### The ambient, session-less alternative — Brian Eno & Peter Chilvers' *Bloom* and *Reflection*

The closest thing to a direct product analog in this whole pass. *Bloom* (2008): you tap the screen, notes and a generative visual pattern respond, and when you stop touching it, "a generative music player takes over," continuing to compose on its own — Eno's own description is "part instrument, part composition, part artwork." *Reflection* (2017) goes further still: it's a continuous, never-ending ambient piece that shifts with the actual time of day and season, with no session concept at all — no start, no finish, no save.

This is a genuine, useful tension to name plainly rather than smooth over: MoveScape deliberately does the opposite of Reflection's model — sessions are discrete, a piece has a finish line, and it gets saved as a keepable, finite artifact. That's not a gap to close; it's a real, considered product decision (the spec is explicit that a finished piece is "yours," something to keep and show someone). But it's worth being clear-eyed that the closest analog in the wild takes the opposite approach, so the discrete-session model reads as a deliberate choice worth stating with confidence, not a default nobody examined.

### The keep/discard decision — Midjourney

This was the richest, best-documented analog. Midjourney doesn't offer a binary choice at all — after a generation, it offers **Upscale/keep one of four** (U1–U4), **Reroll** (regenerate a fresh set from the same prompt), **Variation** (riff on one result you liked without fully committing), and **Hide** (discard). Four distinct paths, not two.

MoveScape's own Save/Discard is meaningfully narrower than the leading pattern in this exact space. The caveat matters, though: MoveScape's art comes from a live performance, not a re-runnable prompt — you can't "reroll" without actually moving again, so this doesn't map one-to-one. But it does suggest the binary framing might be leaving something on the table: a "keep moving" option (continue the session instead of only Save-or-Discard-and-stop) is closer to what Midjourney's Variation/Reroll paths are really offering — a way to stay in the creative moment instead of being forced to a hard stop.

## Synthesis — themes to carry into Define

1. **Visible mechanism may be a feature, not something to hide.** Live-coding culture's "show us your screens" ethos directly challenges the earlier instinct to bury MoveScape's movement readout as a dev-only concern. Worth carrying into Define as an open question rather than a settled call.
2. **The seed/determinism system is a legitimate thing to surface to the user, not just internal plumbing.** It's the same mechanism serious generative artists (Molnár, fxhash-era artists) already use and are known for. "Today's world" deserves confident, visible framing, not silence.
3. **The discrete, finite, save-able session is a deliberate departure from the closest direct analog (Eno's *Reflection*), not an unexamined default.** Worth stating that choice with confidence in the actual UX, since the nearest comparable product took the opposite path.
4. **A binary Save/Discard is narrower than the best analog in the adjacent generative-art space (Midjourney's keep/reroll/vary/discard).** Worth questioning whether a "keep moving" option belongs as a third path, not just Save or Discard.
5. **MoveScape gets no free trust-building from physical context**, unlike every gallery-installation analog — the page is doing alone what a room and a person do together elsewhere. (Carried over from the competitive analysis; still holds regardless of the analog-research revision.)

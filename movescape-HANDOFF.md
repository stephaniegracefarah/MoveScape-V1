# MoveScape — Handoff / Changelog

This is the second document of the two-document system (see the main doc, Part 4). The main doc says what the system should be; this doc says where the build actually stands. The coordinator agent updates it at the end of every session; every new session starts by reading both documents.

Rules for the coordinator writing entries: newest session on top; be specific enough that a session with zero prior context can resume from the entry alone; every deviation from the main doc gets its reasoning written down; keep the running sections (state summary, open deviations, known issues) current rather than only appending.

---

## Current state summary

*(Keep this section updated — it is the fast path for a new session. What milestone is active, what works end-to-end right now, how to run the project and its tests.)*

- **Active milestone:** M0 (not started)
- **Works right now:** nothing yet — repo not initialized
- **Run:** —
- **Test:** —

## Open deviations from the main doc

*(Implementation choices that differ from or refine the spec, not yet folded back into the main doc. Each entry: what changed, why, and which part/section of the main doc it affects. When the founder folds one into the main doc, move it to the session log entry where the fold happened.)*

- None yet.

## Known issues / debt

*(Bugs, shortcuts taken knowingly, and anything a QA pass flagged but deferred. Each entry says what would make it done.)*

- None yet.

---

## Session log

*(Newest first. One entry per session.)*

### Session 000 — YYYY-MM-DD — Template

**Goal this session:** *(which milestone / which parts)*

**Completed:**
- *(what was built, by which builder tasks, and what QA verified — reference the milestone acceptance criteria and invariant numbers checked)*

**Deviations / decisions made, with reasoning:**
- *(anything done differently than the main doc specifies, or decided where the doc was silent — and why)*

**QA notes:**
- *(what was checked, what failed and was sent back, what passed on retry; determinism test status)*

**Known issues added/resolved:**
- *(cross-reference the section above)*

**Next session should:**
- *(the concrete starting point: milestone, first tasks, anything blocking)*

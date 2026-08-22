# Tuning panel reference

What each slider in the dev-only "backend knobs" panel (`main.ts`, behind
`import.meta.env.DEV` — click "Show tuning panel" in `npm run dev`) actually
controls. There are two groups, and they're different kinds of thing:

- **World knobs** — the day's seeded personality (palette, density, growth
  character). Normally these come from `hash(userId, date)`; the panel lets
  you override them by hand. Each slider shows the **raw 0–1 value**, which
  `botanical.ts` then maps into the actual range noted below.
- **Botanical tuning config** — internal calibration constants (line
  thickness, shrink speed, color formula, jitter amounts) that used to be
  hardcoded. The panel shows these in their **real units** directly (the
  slider value *is* the value used).

Use the panel's Export button to grab the current values as JSON once
something looks right — see `docs/HANDOFF.md` for how that gets locked in as
the new defaults.

---

## World knobs (raw 0–1 sliders)

| Knob | Mapped range | What it does |
|---|---|---|
| `hueBase` | 0–360° | The base hue for the world's whole palette. This is what "today's color" means — green vs. crimson vs. violet, etc. (the 3 palette-preset buttons just set this + `hueSpread` to fixed values). |
| `hueSpread` | 10–60° | How far individual branches' hues wander from `hueBase`. Low = a very tight, uniform color; high = a visibly varied palette within the same family. |
| `branchDensity` | 8–40 (max concurrent branches) | The population cap — how many branches can be alive on screen at once. This is the main knob for "too sparse" vs. "too busy." |
| `baseGrowthRate` | 0.5×–2.0× | Multiplier on how fast branches grow (how quickly they extend toward their target length). Higher = the piece fills in faster. |
| `matureDurationMs` | 3,000–12,000 ms | How long a branch stays in full bloom (mature, blossoms visible) before it starts shrinking away. Higher = blossoms linger longer. |
| `windAngle` | 0–2π rad | The compass direction branches get a gentle constant pull toward as they grow (via `windStrength`, below). Sets which way the whole piece "leans." |
| `rootCount` | 3–6 | How many root spawn points the piece grows from. More roots = a wider base of separate growth clusters. |
| `branchSpreadBase` | 0.3–1.2 rad | How wide a fan of directions a branch can spawn in relative to its parent's direction (or straight-up, for roots). Higher = branches fan out more aggressively; lower = branches stay closer to their parent's heading. |
| `wanderAmplitudeBase` | 0.02–0.15 rad | How much a branch's direction curves as it grows, before the fine per-tick jitter is applied. This is the main knob for "too spirally" — high values make branches curl tightly; low values make them grow in long, gentle sweeps. |
| `blossomsPerCluster` | 6–18 | How many individual blossom circles spawn when a branch matures. More = denser, more opaque-looking clusters. |
| `subBranchSpawnChance` | 0–1 (probability) | The odds that a mature branch spawns one child sub-branch. Higher = more recursive branching (up to the `maxGeneration` cap below); 0 = branches never fork. |

---

## Botanical tuning config (real-unit sliders)

### Growth & lifecycle

| Field | Default | What it does |
|---|---|---|
| `maxGeneration` | 4 | Recursion depth cap — how many generations of sub-branch a piece can fork through before forking stops. |
| `speedFloor` | 0.06 | The minimum growth rate that still applies even at `speed = 0` — "any movement counts," so true stillness still yields a faint trickle of growth rather than freezing completely. |
| `baseGrowthScale` | 0.00005 | Internal per-millisecond scale factor folded into every branch's growth rate alongside the `baseGrowthRate` world knob. Turning this up speeds up *all* growth regardless of the world-knob setting. |
| `targetLengthBase` | 0.35 | How long a root (generation-0) branch aims to grow, in normalized canvas units (before per-generation decay). This is the main knob for "only using the lower half of the canvas" — branches that can't reach a long enough target length never make it to the top. |
| `targetLengthJitterSpan` | 0.6 | How much random variation there is around `targetLengthBase` — each branch's actual target lands somewhere in `[0.7, 0.7 + span)` × the base. Higher = more variety in how far individual branches reach. |
| `generationLengthDecay` | 0.5 | Each sub-branch generation targets this fraction of its parent generation's base length. Lower = child branches shrink away faster generation-to-generation; closer to 1 = children grow almost as long as their parents. |
| `shrinkRate` | 0.0002 | How fast a branch retracts (in grown-length per millisecond) once it enters the shrinking phase. Lower = a slower, more graceful fade; higher = a quick vanish. This is the main knob for "not disappearing is too obvious." |

### Wander & wind

| Field | Default | What it does |
|---|---|---|
| `symmetryDamping` | 0.85 | How much the movement parameter `symmetry` damps wander amplitude. At `symmetry = 1`, wander is cut by this fraction; at `symmetry = 0`, wander is unaffected. Higher = symmetric movement calms the composition more strongly. |
| `windStrength` | 0.0005 | How strongly branches get pulled toward the world's `windAngle` over time. Very small by design (it's a constant per-tick nudge, not a one-time force) — raising it noticeably straightens growth toward the wind direction; lowering it makes wind nearly irrelevant. |

### Line & color

| Field | Default | What it does |
|---|---|---|
| `branchSegmentRadius` | 0.003 | The radius of each dot making up a branch's line (branches are drawn as a dense string of small circles, not a stroked path). Bigger = thicker-looking branches. |
| `branchBaseOpacity` | 0.92 | How opaque branch lines are. Branches are meant to read as solid, near-opaque lines — lowering this makes them look more translucent/washed out. |
| `maxSat` | 70 | Maximum HSL saturation (%), applied at `z = 0` (nearest/foreground layer). |
| `satFalloff` | 45 | How much saturation drops as depth (`z`) increases toward 1 (farthest/background layer) — saturation at max depth is `maxSat − satFalloff`. |
| `minLight` | 15 | Minimum HSL lightness (%), applied at `z = 0` (foreground — dark, saturated, per the depth-layering design). |
| `lightRise` | 65 | How much lightness increases as depth increases toward `z = 1` — lightness at max depth is `minLight + lightRise` (pale, faded background). |

### Root placement

| Field | Default | What it does |
|---|---|---|
| `rootYMin` | 0.7 | The minimum y-position (normalized, 0 = top of canvas, 1 = bottom) where root points can spawn. |
| `rootYSpan` | 0.3 | How much vertical range above `rootYMin` root points can land in — roots spawn somewhere in `[rootYMin, rootYMin + rootYSpan)`. Together with `rootYMin`, this is the other main knob for "only using the lower half of the canvas": roots that only ever spawn near the very bottom limit how much vertical reach the whole piece has, independent of how far branches can grow. |
| `rootBaseDirectionSpread` | 0.3 rad | How much each root's base growth direction can vary around straight-up. Higher = roots don't all point the same way. |

### Sub-branch variation

| Field | Default | What it does |
|---|---|---|
| `childZJitter` | 0.05 | Maximum random depth (`z`) offset a sub-branch gets relative to its parent's depth. |
| `childHueJitterDegrees` | 15° | Maximum random hue offset a sub-branch gets relative to its parent's hue. |

### Blossoms

| Field | Default | What it does |
|---|---|---|
| `blossomRadiusMin` | 0.01 | Minimum blossom circle radius (normalized). |
| `blossomRadiusSpan` | 0.04 | How much larger than the minimum a blossom's radius can randomly be — actual radius lands in `[blossomRadiusMin, blossomRadiusMin + blossomRadiusSpan)`. |
| `blossomOpacityMin` | 0.3 | Minimum blossom opacity. Blossoms are meant to be genuinely translucent (unlike branches) so overlapping ones visibly darken where they stack. |
| `blossomOpacitySpan` | 0.25 | How much more opaque than the minimum a blossom can randomly be. |
| `blossomJitterMax` | 0.02 | Maximum per-axis (x/y) random offset of a blossom from its anchor point on the branch — keeps blossoms clustered *around* the line rather than sitting exactly on it. |
| `blossomHueJitterDegrees` | 10° | Maximum random hue offset for an individual blossom relative to its owning branch's hue. |
| `blossomZJitter` | 0.03 | Maximum random depth (`z`) offset for an individual blossom relative to its owning branch's depth. |

---

## Quick map: the four founder tuning notes → likely knobs

From the M4 live review (`docs/HANDOFF.md`, Session 005):

1. **"Way too sparse"** → `branchDensity` (world knob), `subBranchSpawnChance` (world knob), `maxGeneration`.
2. **"Not disappearing is way too obvious"** → `shrinkRate` (slower = more graceful fade); branch segments don't currently fade opacity during shrink at all (only blossoms do) — that's a separate code change, not a slider, if lowering `shrinkRate` alone doesn't read right.
3. **"Only the lower half of the canvas is being used"** → `targetLengthBase`, `rootYMin`/`rootYSpan`, and `baseGrowthRate`/`baseGrowthScale` (growth pace — a branch that's too slow may never reach a far target within a typical session length even if the target itself is long enough).
4. **"Too spirally"** → `wanderAmplitudeBase` (world knob) is the primary one; if it's already low and still looks spirally, the noise sampling scale in `wanderDeltaFor`'s call site (`branch.grownLength`-scaled) may need a code change, not just a slider.

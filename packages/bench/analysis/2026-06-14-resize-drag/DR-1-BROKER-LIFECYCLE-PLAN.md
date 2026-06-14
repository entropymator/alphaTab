# DR-1 broker-lifecycle sub-slice — Phased implementation plan

**Status**: open, not started.
**Target**: `feature/perf` HEAD (`022d8c9a` at plan write time).
**Scenario**: `canon-resize-drag` (post-EW-9 median 230.77 ms ± 5.08 ms).
**Author rule**: this plan is the executor's checklist. Read it once top-to-bottom before touching code. The anti-revert directives in §11 are not optional. This is **structural work**, not an easy win — see §1.

---

## 1. Goal & framing

### 1.1 What we're trying to do, in plain English

**Goal**: stop spending ~7 ms / iter on `MultiVoiceContainerGlyph.registerLayoutingInfo` during resize, by not redoing work whose result hasn't changed.

`registerLayoutingInfo` is the call inside `BarRendererBase.reLayout` that pushes per-bar measurements — pre-beat block width, post-beat block width, beat spring constants — into a **per-masterbar broker** (`BarLayoutingInfo`). The broker accumulates `max-of` across all staves of the masterbar. Layout consumers later read the broker to decide how to distribute width across the bars of a system.

On resize this call re-runs for every bar on every width change. The values it pushes are derived from the bar's **glyph composition** (clef present? key signature width? beat count? grace notes?) — not from viewport width. So re-pushing the same numbers is wasted work.

EW-9 Variant B already captured the bar-local overflow walk (`calculateOverflows`) at ★ −9.69 ms. EW-9's broader form tried to capture `registerLayoutingInfo` too, and got bitten by the broker reset at `StaffSystem.addMasterBarRenderers:293` (broker reads 0 → bars collapse, 7 visual fixtures broke). This plan exists to find a path through that reset.

### 1.2 The architectural fact we have to design around

The broker reset at `addMasterBarRenderers:293` **is load-bearing**, not defensive. Pre-beat glyph composition genuinely *does* change between layouts: when a bar wraps to/from `isFirstOfStaff`, its leading clef (and key signature, time signature, etc.) appears or disappears, and its `preBeatSize` shrinks or grows. Without the reset, a bar that used to be first-of-line keeps its stale-wider `preBeatSize`, the broker keeps the stale max, and downstream layout overcompensates.

Post-beat composition has no analogue of "the clef disappears when the bar wraps" — that's why `postBeatSize` has no corresponding reset. The asymmetry is real and meaningful.

So the design question is **not** "can we drop the reset?" The answer is no. The design question is:

> The reset only matters when at least one stave's `(wasFirstOfStaff, isFirstOfStaff)` flipped. The vast majority of resize iterations on canon-resize-drag don't flip any bar's wrap state. Can we make the reset (and the subsequent `registerLayoutingInfo` work) skip those iterations?

The three options in §4 are three different answers to that question.

### 1.3 What this is in HOTSPOTS taxonomy

A **sub-slice of DR-1**. DR-1 is "Resize re-walks every bar even when only the viewport width changed" (HOTSPOTS.md:265). EW-9 Variant B (`bfcd943f`) landed the **`calculateOverflows` half** of DR-1. This plan attacks the **`registerLayoutingInfo` half** still un-captured.

### 1.4 Why this is NOT an EW candidate

Per `AGENT_WORKFLOW.md`'s classification rule cited in HOTSPOTS.md: "Easy win = single file, no public API change, no semantic change."

This work fails all three:

- **Multi-file**: touches `StaffSystem.ts` (the broker owner), `BarRendererBase.ts` (the reader/writer), `MasterBarsRenderers.ts` (likely the invalidation-state owner), possibly `BarLayoutingInfo.ts` (if a content-version field is added).
- **Semantic change**: the broker lifecycle contract changes — `preBeatSize` no longer resets unconditionally on `addMasterBarRenderers`. Any future caller relying on the reset breaks.
- **Public API risk**: `BarLayoutingInfo` is `@internal` but is reachable from public renderer fields; a new "needs reset" flag becomes part of the broker's effective contract.

It belongs under **DR-1 — Major refactors**. The landed entry, if it lands, goes under a **new** "Major refactors — landed" section in HOTSPOTS.md (creating that header if it doesn't yet exist; see §12.4).

### 1.5 Numerical envelope

| Quantity                                          | ms/iter | Source                                  |
|---------------------------------------------------|--------:|-----------------------------------------|
| Post-EW-9 baseline median                         | 230.77  | HOTSPOTS.md headline (round 2026-06-14) |
| Cross-trial σ                                     | ±5.08 (2.2 %) | same                              |
| 2σ ≈ `★` resolution threshold                     | ≈ 10    | derived (≥ 2σ rule)                     |
| **DR-1 sub-slice target on canon-resize-drag**    | **≥ -5 ms paired A/B (`★`)** | conservative; see §1.4 |
| `MultiVoiceContainerGlyph.registerLayoutingInfo` upper bound | ~7.0 | DR-1 quantification (HOTSPOTS.md:277-281) |
| `BarRendererBase._registerLayoutingInfo` wrapper  | ~0.2    | EW-9 plan §2.2                          |

### 1.6 Decision floor

Same shape as EW-9 §5.2:

- **`★` AND median Δ ≤ -5 ms (paired A/B n=64)** → proceed.
- **`★` but in (-5, -3) ms** → marginal; re-run at n=96/128 and reconsider.
- **`~`** → drop to next option in §4 matrix.
- **`·` or no significance** → falsify-and-stop; document in HOTSPOTS.md DR-1 that the `registerLayoutingInfo` slice is structurally blocked.

### 1.7 Acknowledged outcome possibilities

This plan may **not** land. That is an acceptable outcome. Documented falsification of all three options in §4 demotes DR-1's `registerLayoutingInfo` slice to "structurally blocked at this codebase shape" and updates HOTSPOTS.md accordingly. See §13.

---

## 2. Architectural map: the broker lifecycle

The **single most important section**. EW-9's Phase 1 broke 7 visual fixtures because plan §3.4 was wrong about broker persistence. This plan exists because of that falsification. The catalogue below is built from direct source inspection (re-verified at plan write time, files referenced at line-precise refs).

### 2.1 Broker ownership

- `BarLayoutingInfo` is created in **exactly one place**: `StaffSystem.addBars:354` (`result.layoutingInfo = new BarLayoutingInfo();`).
- Owned by `MasterBarsRenderers` (one broker per masterbar). Shared across N staves' renderers (Score + Tab + Slash + Numbered, etc).
- Lives as long as the `MasterBarsRenderers` lives. Resize cycles re-add the same `MasterBarsRenderers` instances to systems — the broker survives unless explicitly mutated.
- `addBars` runs **only during initial layout** (`VerticalLayoutBase:494`). `addMasterBarRenderers` runs both initial (`VerticalLayoutBase:313`) and resize (`VerticalLayoutBase:484` via `_barsFromPreviousSystem`).

### 2.2 Every broker field — write/read catalogue

(File refs use `BarLayoutingInfo.ts` for the broker, `BarRendererBase.ts`, `MultiVoiceContainerGlyph.ts`, `BeatContainerGlyph.ts`, `EffectBand.ts`, `StaffSystem.ts`.)

| Field                       | Type             | Accumulator   | Reset sites                              | Write sites                                                                                                  | Read sites                                                                          |
|-----------------------------|------------------|---------------|------------------------------------------|--------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------|
| `preBeatSize`               | number           | max-of        | **`StaffSystem.addMasterBarRenderers:293` (the smoking gun)** | `BarRendererBase._registerLayoutingInfo:445-447` (`info.preBeatSize = max(info.preBeatSize, _preBeatGlyphs.width)`) | `BarRendererBase.applyLayoutingInfo:487` (`_preBeatGlyphs.width = info.preBeatSize`) |
| `postBeatSize`              | number           | max-of        | **none** (never reset)                   | `BarRendererBase._registerLayoutingInfo:454-457`                                                              | `BarRendererBase.applyLayoutingInfo:496`                                            |
| `_beatSizes` (Map)          | per-beat sizes   | max-of in `setBeatSizes:81-95` | **none** (never reset; only `set`/`replace` per key) | `BeatContainerGlyph.registerLayoutingInfo:202-205` via `info.setBeatSizes(this, {preBeatSize, onBeatSize})` | `getBeatSizes(beat):73-79` — read by per-renderer beat-positioning code              |
| `springs` (Map)             | Spring per time  | max-of in `addSpring:138-187` | **none**                          | `addSpring` (via `addBeatSpring`); called from `BeatContainerGlyph.registerLayoutingInfo:197` (`addBeatSpring`) and `EffectBand.registerLayoutingInfo:218` | `getPreBeatSize/getPostBeatSize:97-123`, `spaceToForce`, `buildOnTimePositions`, `calculateVoiceWidth` |
| `_timeSortedSprings`        | Spring[]         | append (insertion-sorted) | **none**                            | `addSpring:163-168`                                                                                          | spring-constant calc, `buildOnTimePositions`, `_calculateSpringConstants`           |
| `allGraceRods` (Map)        | per-grace-group  | max-of grace springs in `addBeatSpring:210-227` | **none**                  | `addBeatSpring` grace branch                                                                                | `getPreBeatSize/getPostBeatSize` grace branch                                       |
| `incompleteGraceRods` (Map) | per-grace-group  | first-write wins                | **none**                          | `addBeatSpring:223-225`                                                                                      | `_incompleteGraceRodsWidth` in `finish:252-257`                                     |
| `_minDuration`              | number           | min-of in `addSpring:154-156`   | **none**; reset only via `_defaultMinDuration` initial value (-1 sentinel logic in StaffSystem) | `addSpring` (min-of) | `finish:259`, `recomputeSpringConstants:274`, `localMinDuration` getter             |
| `computedWithMinDuration`   | number           | last-write    | n/a                                      | `finish:260`, `recomputeSpringConstants:276`                                                                 | `StaffSystem._trackSystemMinDuration:446`, `reconcileMinDurationIfDirty:473`        |
| `minStretchForce`           | number           | max-of in `_updateMinStretchForce:67-71` | wholesale rewrite in `_calculateSpringConstants:303` | `_calculateSpringConstants:303,326`                                | `MultiVoiceContainerGlyph._scaleToForce`, `applyLayoutingInfo`                      |
| `totalSpringConstant`       | number           | rewrite       | rewritten in `_calculateSpringConstants:300` | same                                                                                                       | `spaceToForce`, `calculateVoiceWidth`                                               |
| `_onTimePositions` (Map)    | force-dependent  | memoized      | rewritten by `buildOnTimePositions:419-424` on force change | `buildOnTimePositions:423-424`                                              | `MultiVoiceContainerGlyph._scaleToForce:66`                                         |
| `_onTimePositionsForce`     | number           | last-write    | n/a                                      | `buildOnTimePositions:422`                                                                                   | `buildOnTimePositions:419` (memo key)                                               |
| `version`                   | number           | increment     | n/a                                      | `addSpring:136`, `finish:261`, `recomputeSpringConstants:277`                                                | (no readers — vestigial, see HOTSPOTS.md DR-1 references)                           |

**Key empirical claim** (verified by the catalogue above): *only* `preBeatSize` has an external reset. Every other broker field is either max-of-monotonic (never shrinks across resize cycles), force-derived (rewritten unconditionally), or per-beat-keyed (overwrites by key).

### 2.3 Broker invariants

After the catalogue, the broker holds these invariants across resize cycles:

- **(I1)** `springs[t]`, `allGraceRods[g]`, `_timeSortedSprings`, `_minDuration` are **monotonic max-of** in their respective dimensions. Once correctly populated for a given `Bar` content, they remain correct across resize cycles. They depend ONLY on `Bar.voices[].beats[]` (durations, grace types, pitches via beat glyphs), not on width.
- **(I2)** `_beatSizes[absoluteDisplayStart]` is monotonic max-of per beat-id key. Same invariance source as I1.
- **(I3)** `postBeatSize` is monotonic max-of, never reset.
- **(I4)** `preBeatSize` is the ONLY broker field that gets externally zeroed (`StaffSystem.addMasterBarRenderers:293`). Every `_registerLayoutingInfo` cycle re-populates it via max-of.
- **(I5)** `minStretchForce`, `totalSpringConstant`, `_onTimePositions` are derived from springs + a force input; they are rewritten unconditionally by `finish`/`recomputeSpringConstants`/`buildOnTimePositions`. Their inputs are width-invariant (springs) or width-dependent (force).
- **(I6)** `computedWithMinDuration` tracks which `minDuration` reference the spring constants were computed against; it's the gate for `_trackSystemMinDuration` to call `recomputeSpringConstants`. Width-invariant; cross-bar dependent.

### 2.4 Cross-stave coverage

- Each `MasterBarsRenderers` has N renderers (one per stave). All N share the same `BarLayoutingInfo` instance.
- During `addMasterBarRenderers`, the loop at `StaffSystem.ts:299-318` calls `s.addBarRenderer(renderer)` for every stave's renderer; this calls `renderer.reLayout()` (`RenderStaff.ts:135`).
- The current shape: `reLayout` calls `_registerLayoutingInfo` unconditionally (per EW-9 Variant B fix). Each renderer contributes via max-of. After all N renderers ran, `preBeatSize` reflects the maximum pre-beat-block width across all staves of this masterbar.
- **Cross-stave invariant** (from EW-9 §3.4 — re-verified, still holds): the broker's max-of accumulation is order-independent and idempotent. Skipping one stave's call while another runs leaves the broker correct IFF the skipped stave's previous contribution survives in the broker. **EW-9's falsification proved this is true for `_beatSizes`, springs, `postBeatSize`, but NOT for `preBeatSize` because of the `:293` reset.**

### 2.5 EW-9 §3.4 falsification — re-cite

EW-9 plan §3.4 claimed:

> "First resize cycle: every renderer ran `_registerLayoutingInfo`, broker reflects all-staves max. Second resize cycle: every renderer is skipped, broker is untouched and still reflects all-staves max from cycle 1. Correct."

This was wrong because `addMasterBarRenderers:293` resets `preBeatSize = 0` BEFORE any renderer runs `reLayout`. The first stave's `_registerLayoutingInfo` reads 0 and writes its own preBeatSize (correct). If a second stave is skipped, the broker holds only the first stave's contribution. Worst case (the one EW-9 Phase 1 hit): if all N renderers are skipped, `preBeatSize` reads 0 forever, `applyLayoutingInfo:487` sets `_preBeatGlyphs.width = 0`, and bars collapse to x=0 (visible: 23 bars stacked in `multi-system-slur-scale-up`).

**Lesson encoded as a hard rule for this plan**: *the executor MUST NOT assume any broker state persists across `addMasterBarRenderers` without grepping for explicit `<broker>.<field> = 0` resets across `staves/`, `layout/`, and `BarRendererBase.ts`.* The §2.2 catalogue is the authoritative grep result for the current code shape.

---

## 3. Why the reset exists (load-bearing, not defensive)

### 3.1 The real reason

A bar's `preBeatSize` is the width of its **leading glyph block** — clef, key signature, time signature, accidentals, repeat-open bracket, etc. Most of those glyphs are only emitted when the bar is **first on its staff line** (`isFirstOfStaff === true`):

- Clef and key signature: emitted on the first bar of each line.
- Time signature: emitted on the first bar where the time signature changes (which includes every wrap that lands on a meter change).
- Other "courtesy" glyphs follow the same line-leading semantics.

So a single bar's `preBeatSize` is **not invariant** across layouts: a bar that was line-leading at width 1400 may not be at width 800, and vice versa. The `BarRendererBase.reLayout` chain already detects this — when `(wasFirstOfStaff !== isFirstOfStaff)`, it calls `recreatePreBeatGlyphs()` (line 915) and the bar's leading glyph composition rebuilds.

The broker's `preBeatSize` accumulator is `max-of` across all staves of the masterbar. If the broker keeps the stale max from a previous layout where some stave was line-leading, the next layout (where that stave is mid-line) would read the stale-wider value and over-allocate space for the leading block. So the reset at `addMasterBarRenderers:293` zeroes the field every cycle and `_registerLayoutingInfo` re-accumulates the current cycle's max.

`postBeatSize` (notes + stems + tie-out + barline) has **no analogue** of "the leading clef disappears when the bar wraps to mid-line". Post-beat composition is determined by the bar's musical content, not its position in the staff. That's why there is no `postBeatSize` reset — the asymmetry is intentional, not a bug.

### 3.2 `git blame` corroboration

```
a15680687 src/rendering/staves/StaveGroup.ts (Daniel Kuschny 2020-07-16 19:07:29 +0200 293)
    renderers.layoutingInfo.preBeatSize = 0;
```

5+ years old, no load-bearing changes since. The previous version of this plan §3 read the `git blame` antiquity as evidence the reset was defensive cruft. It isn't — it's load-bearing code that's correct enough to have never needed revisiting. The asymmetry with `postBeatSize` (no corresponding reset) is the strongest internal evidence: if the reset were merely defensive, the absence on the post-beat side would imply a latent bug; since the post-beat side is empirically correct, the asymmetry must reflect a real semantic difference. §3.1 names that difference.

### 3.3 Working principle

**The reset cannot be removed unconditionally.** Any option in §4 must either:

- Preserve the reset's effect on iterations where any bar's `(wasFirstOfStaff, isFirstOfStaff)` flipped — i.e. the reset (and the subsequent `_registerLayoutingInfo` re-accumulation) must still fire on those cycles; OR
- Cache the per-stave contributions and replay them after the reset — letting the reset fire harmlessly while the broker is repopulated without redoing the glyph walk; OR
- Cache the *result of the glyph walk* on the renderer side and short-circuit `MultiVoiceContainerGlyph.registerLayoutingInfo` itself when the bar's pre-beat composition is unchanged.

### 3.4 The empirical question Phase 1 must answer

Given the reset is load-bearing, the new design question is **how often does the wrap-flip actually happen during canon-resize-drag?** If wrap-flips are rare (most resize iterations don't flip any bar's wrap state), Option 1 (conditional reset gated on `recreatePreBeatGlyphs`) wins because the skip applies on most iterations. If wrap-flips are common (e.g. every system re-pack as widths change), the conditional reset fires too often to win — Option 2 / Option 3 (which work renderer-locally and don't care about the broker reset) become the right primaries.

Phase 1 instrumentation (§5) now has a sharpened pass criterion: in addition to byte-identity of broker writes on stable bars, **count the number of iterations in which ≥ 1 renderer's `wasFirstOfStaff !== isFirstOfStaff`** across the 8 drag iterations × 12 widths. This is the deciding measurement for the option primary pick.

---

## 4. Option matrix

Three options. Each is a different answer to §3.4's question. The primary pick (§4.4) depends on the wrap-flip frequency Phase 1 measures.

### 4.1 Option 1 — Conditional reset (gated on wrap-flips)

**Shape sketch (no code)**:

1. Add a `brokerNeedsReset` flag to `MasterBarsRenderers` (default `true`).
2. After `BarLayoutingInfo` is constructed and the initial layout's `finish()` has run, set the flag `false`.
3. Modify `BarRendererBase.reLayout` so that **whenever the `(wasFirstOfStaff !== isFirstOfStaff)` branch fires** (the same branch that already calls `recreatePreBeatGlyphs`), it sets `this.masterBarsRenderers.brokerNeedsReset = true`. This is the one place pre-beat composition is allowed to change.
4. Modify `StaffSystem.addMasterBarRenderers:293` to make the reset conditional: `if (renderers.brokerNeedsReset) { renderers.layoutingInfo.preBeatSize = 0; }` — else: leave it.
5. Modify `BarRendererBase._registerLayoutingInfo` so that when the flag is false, the body is a no-op for the `preBeatSize` write site (the renderer's `preBeatSize` contribution hasn't changed; max-of of the existing broker value with itself is a no-op).
6. After the resize-cycle's loop over staves, set the flag back to false so subsequent iterations get the skip again.

**The architectural fact this option is exploiting**: pre-beat composition can only change when `recreatePreBeatGlyphs` fires. Every other resize cycle leaves it untouched. So the broker's `preBeatSize` is stable IFF no bar in the masterbar flipped its wrap state this cycle.

**Risk profile**:

- **Wrap-flip case**: handled by the §3.1 invariant. When ANY stave's bar flips wrap state, the broker is fully reset and all renderers re-register. Correct by construction.
- **Cross-stave coverage**: when no wrap-flip occurred, every stave skips its `_registerLayoutingInfo` write together. The broker holds the prior cycle's max — which is correct because the prior cycle's max came from the same staves with the same pre-beat composition.
- **Single-stave wrap-flip**: if stave A flips but stave B does not, the flag goes true, ALL staves re-register (B's contribution is re-pushed; max-of is idempotent so this is safe), and the broker is correctly re-maxed.

**Blast radius**: 3 files (`StaffSystem.ts`, `MasterBarsRenderers.ts`, `BarRendererBase.ts`).

**Dependency on EW-9**: independent. Coexists with the EW-9 `_layoutInvariantCached` flag (which gates `calculateOverflows`). The new flag is broker-side; the EW-9 flag is overflow-side. Document the two-flag separation.

**Expected payoff**: ranges from 0 ms (every iteration flips at least one wrap → reset always fires) to ~7 ms (no iteration flips a wrap → reset never fires). **Phase 1 instrumentation must measure wrap-flip frequency to size this.** A canon-resize-drag where ~60-80 % of iterations have zero wrap-flips would give ~4-6 ms expected — borderline `★`.

**Fallback**: if wrap-flips happen on most iterations during canon-resize-drag, Option 1 collapses to "the reset still fires often" and the perf win disappears. → Option 2.

**Anti-pattern (do NOT do this)**: lifting the reset *unconditionally*. That's exactly the EW-9 Phase 1 shape, and it broke 7 visual fixtures. The conditional gate is what makes Option 1 different.

### 4.2 Option 2 — Cache + replay

**Shape sketch (no code)**:

1. The first `_registerLayoutingInfo` call on a renderer records the (key, value) writes it produces into a per-renderer `_brokerWriteCache: { preBeatSize: number, postBeatSize: number, beatSizes: Map<...>, springs: ... }`.
2. Subsequent `_registerLayoutingInfo` calls become: "is `_brokerWriteCache` populated? Then replay the cached writes into the broker (cheap loop of max-of) and return."
3. Replay happens AFTER the `:293` reset. The broker is repopulated to the same state it would have been.

**Risk profile**:

- **Cross-stave coverage**: each stave has its own cache; replay is per-stave; broker still sees max-of from all staves.
- **Smaller blast radius than Option 1**: changes `BarRendererBase._registerLayoutingInfo` only (~1 file). No changes to `StaffSystem.ts` or `MasterBarsRenderers.ts`.
- **Memory cost**: each renderer stores its own broker contribution as data. Modest — already in the same memory order as `_preBeatGlyphs.width` etc.
- **Performance subtlety**: replay loop itself has cost. If replay walks all springs + grace rods + beat sizes per renderer, the saving over a fresh `_registerLayoutingInfo` walk may be small. The win comes from skipping the **glyph-walk** in `MultiVoiceContainerGlyph.registerLayoutingInfo` (which iterates `beatGlyphs.values()` and calls `b.registerLayoutingInfo(info)` per beat — that's where the ~7 ms / iter lives).

**Blast radius**: 1-2 files (`BarRendererBase.ts`, possibly `MultiVoiceContainerGlyph.ts` if cache lives on the container).

**Dependency on EW-9**: independent; can coexist with the EW-9 cache flag (in fact the same flag could gate both — replay when `_layoutInvariantCached`, full walk otherwise).

**Expected payoff**: 4-6 ms / iter (some replay overhead). Borderline `★`.

**Fallback**: if replay overhead eats the win → Option 3.

### 4.3 Option 3 — Record-on-first-call, no-op on subsequent

**Shape sketch (no code)**:

1. Each `MultiVoiceContainerGlyph.registerLayoutingInfo` (and its delegates `BeatContainerGlyph.registerLayoutingInfo`) short-circuits when its inputs (the bar's beat composition) haven't changed.
2. The detection: a content-version field on the bar/renderer; bumped only when `Bar.voices` mutates. Resize doesn't bump it.
3. Each `_registerLayoutingInfo` cycle still runs the broker-side max-of writes — but with cheap values pulled from a per-renderer-cached struct.

**Difference from Option 2**: Option 2 caches the *writes*. Option 3 caches the *intermediate computation* (the iteration over beat glyphs, the bbox queries, the tie-width additions) and reuses the resulting values.

**Risk profile**:

- **Broker reset still fires** (`:293`). Cache replays into the reset broker. Same correctness profile as Option 2.
- **Most surgical**: each `registerLayoutingInfo` becomes O(1) for the cache-hit case, vs Option 2's O(beats) replay.
- **Per-beat caching cost**: a `Map<beatId, {preBeatStretch, postBeatStretch}>` on each `MultiVoiceContainerGlyph` or `BeatContainerGlyph`.

**Blast radius**: 2-3 files (`MultiVoiceContainerGlyph.ts`, `BeatContainerGlyph.ts`, possibly `EffectBand.ts`).

**Dependency on EW-9**: independent.

**Expected payoff**: 5-7 ms / iter (best of the cache options because cache hit is O(1) not O(beats)).

**Fallback**: if all three fail → documented falsification (§13).

### 4.4 Primary pick — chosen AFTER Phase 1 instrumentation

**Do not commit to an option before Phase 1 measures wrap-flip frequency.** The previous version of this section recommended Option 1 unconditionally on the assumption the reset was defensive — that assumption is wrong (see §3). The correct primary depends on what Phase 1 finds:

| Wrap-flips per iteration (canon-resize-drag) | Primary | Rationale |
| --- | --- | --- |
| 0 most of the time (≤ 20 % of iterations have any flip) | **Option 1** | Conditional reset skips on ≥ 80 % of iterations; expected ≥ 5 ms. |
| Mixed (~20-60 % of iterations flip ≥ 1 bar) | **Option 3** | Bypasses the reset entirely; per-renderer short-circuit doesn't care how often the wrap-flips fire. Each non-flipping renderer is O(1). |
| Almost every iteration flips ≥ 1 bar | **Option 3** preferred, fallback to "stay with EW-9 Variant B; document falsification" | The broker reset fires too often for Option 1; cache+replay (Option 2) loses to a glyph-walk in this scenario; Option 3's O(1) cache hit is the only thing that can win. |

Option 2 is the **structural fallback for any branch where Option 3 has correctness issues** (e.g. if the per-`MultiVoiceContainerGlyph` cache turns out to interact badly with `applyLayoutingInfo`'s post-layout `.y` mutations).

**Phase 5 fallback order** is now Phase-1-dependent:

- If Option 1 primary: Option 1 → Option 3 → Option 2 → falsification.
- If Option 3 primary: Option 3 → Option 2 → Option 1 (conditional) → falsification.

**Why this matters**: EW-9 Phase 1 burned hours on the wrong primary because the architectural model was wrong. The new Phase 1 (§5) is specifically designed to prevent that by measuring the deciding fact first.

---

## 5. Phase 1 — instrument + verify the assumption

**Non-negotiable**. Do not proceed to any source-change phase without this.

### 5.1 Goal

Two measurements, both required before any code change:

1. **Stability**: confirm `_registerLayoutingInfo` writes are byte-identical across resize iterations *on bars whose wrap state did NOT flip this iteration*. If they aren't, there's a hidden write path beyond `recreatePreBeatGlyphs` and §3.1's invariant is incomplete.
2. **Wrap-flip frequency**: count, per iteration of canon-resize-drag, how many bars had `(wasFirstOfStaff !== isFirstOfStaff)`. This is the deciding fact for §4.4's primary pick.

### 5.2 Instrumentation sketch

In a temporary `BarRendererBase` patch (do NOT commit to feature/perf):

1. In `_registerLayoutingInfo`, after the broker write, capture a tuple `(masterBarIdx, staffIdx, _preBeatGlyphs.width, _postBeatGlyphs.width, iteration, width)`. Compare against the prior-cycle tuple stored on the renderer; on mismatch, record `(stable | flipped-wrap | mystery-mismatch)`.
2. In `reLayout`, on the `wasFirstOfStaff !== isFirstOfStaff` branch, increment a per-iteration wrap-flip counter on `ScoreRenderer` (or a module-global). Tag the bar's mismatch report with "flipped-wrap" so the categorisation in §5.5 can be automated.
3. After each `driveOnce` (one iteration of 12 widths), emit a summary line: `[DR1] iter N: wrap-flips per width = [...], stable bars = K, mystery-mismatches = M`.

### 5.3 Bench protocol

```bash
cd packages/bench
# build with the instrumentation patch applied
npx vite build
# run one trial of canon-resize-drag (8 iterations × 12 widths)
node dist/run.mjs --only canon-resize-drag --trials 1 --label DR1-instrument-2026XXXX 2>&1 | tee runs/DR1-instrument-*.log
# grep for the summary lines
grep '^\[DR1\]' runs/DR1-instrument-*.log
```

### 5.4 Pass criterion

- **Stability**: across the 8 iterations × 12 widths × ≥ 3 sampled bars, **mystery-mismatches must be 0**. Bars with "flipped-wrap" mismatches are expected and OK.
- **Wrap-flip frequency**: categorise the 96 (iteration × width) cells by "did any bar in the score flip wrap state":
  - **Low-flip regime**: ≤ 20 % of cells have any flip. → Option 1 primary.
  - **Mixed regime**: 20-60 %. → Option 3 primary.
  - **High-flip regime**: > 60 %. → Option 3 primary; consider declaring `registerLayoutingInfo` slice structurally blocked if even Option 3 doesn't clear σ.

### 5.5 Decision rule

| Phase 1 result | Action |
| --- | --- |
| Stable + low-flip | **Option 1** (conditional reset) — proceed to §6 with Option 1's sketch. |
| Stable + mixed/high-flip | **Option 3** (record-on-first-call cache) — proceed to §6 swapping in Option 3's sketch. |
| Mystery-mismatch (≥ 1) | §3.1 invariant incomplete; trace the hidden write path before choosing an option. Document the new mutation source; revise §2.3 / §3 / §4 accordingly. |
| Per-beat sizes (`_beatSizes`) vary across cycles on a non-flipping bar | Add Option-2-style per-beat cache to whichever primary is chosen. |

### 5.6 Phase 1 exit checklist

- [ ] Instrumentation patch produces a log file at `packages/bench/runs/DR1-instrument-*/snapshot.log` (or equivalent).
- [ ] ≥ 3 bars × 8 iterations × 12 widths = ≥ 288 tuple comparisons. All recorded.
- [ ] Decision row from §5.5 chosen and rationale captured in a working notes file.
- [ ] Instrumentation patch reverted (it does NOT ship).
- [ ] WIP doc commit allowed (e.g. `docs(bench): DR-1 broker-lifecycle Phase 1 instrumentation log`).

---

## 6. Phase 2 — implement the Phase-1-selected primary

(Phase 1's §5.5 decision row determines which option's sketch §6.1 implements. The sketch below is **Option 1's** because that's the highest-impact path; if Phase 1 selected Option 3, replace §6.1 with the Option 3 sketch from §4.3 before proceeding.)

### 6.1 Concrete sketch — Option 1 lifting

1. **Add to `MasterBarsRenderers`** (likely `packages/alphatab/src/rendering/staves/MasterBarsRenderers.ts`):
   - Field `public brokerNeedsReset: boolean = true;` (defaults to true so initial layout always resets — the broker is fresh anyway, so reset is a no-op there).

2. **Modify `StaffSystem.addBars:354`**:
   - After `result.layoutingInfo = new BarLayoutingInfo();`, set `result.brokerNeedsReset = true;` (explicit; matches initial-layout state).
   - After `barLayoutingInfo.finish()` at line 413, set `result.brokerNeedsReset = false;` — the broker is now populated correctly, no further reset needed unless something invalidates.

3. **Modify `StaffSystem.addMasterBarRenderers:293`**:
   - Replace `renderers.layoutingInfo.preBeatSize = 0;` with a conditional:
     - `if (renderers.brokerNeedsReset) { renderers.layoutingInfo.preBeatSize = 0; ... }`
   - The else branch: leave `preBeatSize` as-is from the previous layout pass.

4. **Modify `BarRendererBase.reLayout` (lines 908-935)**:
   - Inside the `wasFirstOfStaff !== isFirstOfStaff` branch (line 915), set `this.masterBarsRenderers.brokerNeedsReset = true;` — recreating pre-beat glyphs changes a stave's `preBeatSize` contribution, so the broker must re-accumulate from scratch.
   - The renderer reaching its `MasterBarsRenderers` parent: needs a back-pointer or pass-through. Most likely available via existing `renderer.staff.layout?` chain — verify during execution.

5. **Modify `BarRendererBase._registerLayoutingInfo` (lines 442-458)**:
   - Wrap the body in `if (this.masterBarsRenderers.brokerNeedsReset) { /* full walk */ }`.
   - The else branch: no-op (the broker already holds correct values).

6. **The EW-9 cache flag interaction**: `_layoutInvariantCached` in `BarRendererBase` currently gates `calculateOverflows`. It should continue to. The new `brokerNeedsReset` flag gates the broker-write side. Both can be set false simultaneously after a full layout; both invalidate independently. Document the two-flag separation with an inline comment.

### 6.2 Pitfalls to verify during execution

- **`StaffSystem.revertLastBar`** (line ~550): when a bar is reverted out of a system, does the broker need invalidation? The `_barsFromPreviousSystem` mechanism re-adds the bar to a different system on the next iteration. The broker is per-`MasterBarsRenderers`, not per-system — so it follows the bar. The reverted bar's broker survives the revert. No invalidation needed. **Verify**.
- **`StaffSystem._trackSystemMinDuration` / `reconcileMinDurationIfDirty`**: these mutate spring constants via `recomputeSpringConstants` (§2.2). They do NOT touch `preBeatSize`/`postBeatSize`/`_beatSizes`. Safe.
- **`ScoreRenderer.updateForBars`**: model-mutation entry path. This triggers a fresh `doLayout` pass which rebuilds `MasterBarsRenderers` from scratch — `brokerNeedsReset` defaults to true. Safe.
- **Empty / multibar-rest bars**: these have a different `MultiVoiceContainerGlyph` shape. `MultiBarRestBeatContainerGlyph.registerLayoutingInfo` (line 125) may have different semantics. Verify it's idempotent on the broker too.

### 6.3 Phase 2 exit checklist

- [ ] Diff is ≤ 60 lines across 2-3 files.
- [ ] `npx vite build` in `packages/bench` succeeds.
- [ ] `cd packages/alphatab && npx tsc --noEmit` clean.
- [ ] WIP commit: `perf(layout): DR-1 broker-lifecycle — lift addMasterBarRenderers preBeatSize reset (WIP, visuals may be red)`.

---

## 7. Phase 3 — perf verify

**Hard rule: do not begin Phase 4 visual triage until Phase 3 passes its decision rule.**

### 7.1 The A/B run

```bash
cd packages/bench
node scripts/build-ab.mjs --ref-a 022d8c9a   # EW-9 Variant B post-docs baseline
node dist/runAB.mjs --a dist/ab/A/runOneCore.mjs \
                    --b dist/ab/B/runOneCore.mjs \
                    --only canon-resize-drag \
                    --iterations 64 \
                    --label probe-DR1-lift
```

### 7.2 Decision rule

Read `runs/probe-DR1-lift/REPORT.md` and check the `canon-resize-drag` row.

| Condition                                       | Action                                                                                  |
|-------------------------------------------------|----------------------------------------------------------------------------------------|
| **`★` AND median Δ ≤ -5.0 ms**                 | PROCEED to Phase 4 visual triage.                                                       |
| `★` but median Δ in `(-5.0, -3.0)` ms           | Marginal. Re-run at `--iterations 96`; if still marginal, fall through to Option 2.    |
| `~` (CI overlaps 0 or `\|z\| < 2`)              | Re-run at `--iterations 128`. If still `~`, fall through to Option 2.                  |
| `·`                                              | Lifting is structurally correct but doesn't capture the slice; falsify lifting, fall through to Option 2. |
| `★` regression in any OTHER scenario            | The lift broke another path. Investigate (likely `nightwish-resize` or `fade-to-black-resize`'s broker handling). |

### 7.3 Anti-revert moment #1

If A/B shows `★` ≤ -5 ms, the win is real **and is not erased by visual failures**. Visual failures are a Phase 4+ problem. See §11.

### 7.4 Phase 3 exit checklist

- [ ] A/B report saved at `runs/probe-DR1-lift/REPORT.md`.
- [ ] Median delta on canon-resize-drag documented.
- [ ] No other scenario showed `★` regression (run `--only canon-resize-drag --only canon-resize --only nightwish-resize --only fade-to-black-resize` if uncertain).
- [ ] Decision recorded in the Phase 2 WIP commit message via `git commit --amend` OR follow-up note commit.

---

## 8. Phase 4 — visual triage

### 8.1 Run vitest

```bash
cd packages/alphatab && npx vitest run
```

Expect 5-15 failing tests. Each failing test produces a diff PNG. Open it before assuming a class.

**Do not run `npm run test-accept-reference`.** Hard rule. See §11.

### 8.2 Cross-reference EW-9's seven fixtures first

EW-9 Phase 3 hit:
- `sustain-pedal`, `sustain-pedal-alphatex`
- `multi-system-slur-scale-down`, `multi-system-slur-scale-up`
- `resize-sequence`, `grace-resize`, `whammy-resize-wrap`

All seven were caused by `preBeatSize = 0` leaking into `applyLayoutingInfo`. The lift directly fixes this. **These seven should pass under Option 1.** If any of them fail, the lift logic is wrong (probably the `brokerNeedsReset` invalidation isn't firing on `recreatePreBeatGlyphs`).

### 8.3 Spot-check first

- `multi-system-slur-scale-up` — was the most dramatic EW-9 failure (23 bars stacked at x=0). If this passes, the broker is being correctly maintained across resize cycles.
- Any `multivoice/` fixture (Class B-shaped failures from EW-9 plan §6).
- Any `grace-notes/` fixture (touches `allGraceRods`).

### 8.4 Class taxonomy

(Identical shape to EW-9 plan §6 — re-cite for the executor's convenience.)

#### Class A — overflow/skyline miscompute (tie-shaped)

**Symptoms**: vertical whitespace above/below staves; tie arcs at wrong y.
**Root cause this time**: same as EW-9 plan §6.1 — `_contentTopOverflow` monotonic max-of holding stale values.
**Fix**: as EW-9 plan — `_contentTopOverflow = 0` at reLayout head. **Note**: EW-9 Variant B kept `calculateOverflows` always-running, so this class should NOT appear under DR-1 broker-lifecycle (the overflow walk still runs). If it does, something is interacting unexpectedly.

#### Class B — cross-stave broker miscompute

**Symptoms**: stave A's notes at different x positions than reference; stave B looks fine. Visible only in multi-stave systems (Score+Tab, multi-staff piano).
**Root cause likely**: the lifted gate let a `recreatePreBeatGlyphs` event slip through without setting `brokerNeedsReset = true`. The broker holds stale `preBeatSize` reflecting old `_preBeatGlyphs.width`.
**Fix**: trace every `recreatePreBeatGlyphs` call site (BarRendererBase.ts:937 and LineBarRenderer override at line ~641 — verify). All must set `brokerNeedsReset = true` before mutating `_preBeatGlyphs`.

#### Class C — beam endpoint y-coords drift

**Symptoms**: beams tilted slightly wrong; tuplet brackets overlapping unexpectedly.
**Root cause**: EW-9 plan §6.3 — `calculateBeamingOverflows` skipped. Under DR-1 broker-lifecycle, `calculateOverflows` is still gated by `_layoutInvariantCached`, so this class CAN still appear. Same fix as EW-9.

#### Class D — anything else

**Process**:
1. Identify which broker field is stale (instrument the broker reader paths).
2. Find the mutation hook that should have set `brokerNeedsReset = true` but didn't.
3. Add the missing invalidation.
4. NEVER widen the lift's scope; NEVER accept the diff PNG; NEVER revert Phase 2.

### 8.5 Phase 4 exit checklist

- [ ] Every red test classified A/B/C/D in `runs/DR1-phase4-classifications.md`.
- [ ] Class breakdown counted.
- [ ] First fix attempt sketched per class.

---

## 9. Phase 5 — iterative fix loop

(Same shape as EW-9 plan §7.)

### 9.1 Loop body

For each red test:

1. Classify per §8.4.
2. Add the targeted `brokerNeedsReset = true` event (Class B) OR pull a calculation out of the gate (Class C) OR add an invalidation event (Class D).
3. Re-run that single failing test:
   ```bash
   cd packages/alphatab && npx vitest run -t "<test name fragment>"
   ```
4. Verify the diff PNG resolves.
5. Re-run A/B every 3-5 fixes:
   ```bash
   cd packages/bench
   node dist/runAB.mjs --a dist/ab/A/runOneCore.mjs \
                       --b dist/ab/B/runOneCore.mjs \
                       --only canon-resize-drag \
                       --iterations 64 \
                       --label probe-DR1-fix-$(date +%s)
   ```
6. **Targeted invalidation budget**: each event should cost ≤ 0.5 ms / iter. If cumulative cost erodes the Phase 3 win by > 30 %, an invalidation is too broad — see §9.3.
7. **Commit each fix separately** with class label.

### 9.2 Iteration cap

If after **10 iterations** vitest is still red OR A/B has fallen below σ on canon-resize-drag:

- **STOP** the per-test loop.
- Move to Phase 6 (§10).

### 9.3 Perf erosion budget

| Phase 3 win | Erosion limit (30 %) | Stop threshold        |
|-------------|----------------------|----------------------|
| -5 ms       | 1.5 ms cumulative    | win drops below -3.5 ms → Phase 6 Option 2 |
| -7 ms       | 2.1 ms               | drops below -5 ms → Phase 6 |
| -10 ms      | 3 ms                 | drops below -7 ms → Phase 6 |

### 9.4 Phase 5 exit checklist

- [ ] vitest 1599/1599.
- [ ] A/B re-measured at n=64 still shows `★` with median delta ≥ -5 ms.
- [ ] No other scenario shows `★` regression.
- [ ] Code committed as a series of small commits, each with a class label.
- [ ] Plan updated to reflect final shape.

---

## 10. Phase 6 — fall through to next option

If Phase 5 hits the iteration cap or the perf erosion threshold:

1. **Revert the Option 1 commits** (lifting the reset).
2. Switch to **Option 2** (cache + replay). Re-do Phase 2 with the cache+replay sketch.
3. If Option 2 also fails: switch to **Option 3** (record-on-first-call). Re-do Phase 2 with the per-beat caching sketch.
4. If all three fail: **documented falsification** (§13).

### 10.1 Why three options instead of two

EW-9 had one option (Variant B) and demoted to "falsify if it fails". This plan has three because the broker-lifecycle slice is the *next* DR-1 slice — its failure is more expensive to recover from (DR-1 then formally retires with a partial-shipment status). Three options give three independent shots at the same hotspot before declaring structural defeat.

### 10.2 Option N → Option N+1 protocol

- Branch off feature/perf at the post-EW-9 baseline (`022d8c9a`).
- Discard the Option N commits cleanly (`git reset --hard 022d8c9a` on the working branch).
- Implement Option N+1 from scratch (do not try to retain partial Option N infrastructure — it adds drift risk).
- Re-run Phases 1-5 in full for Option N+1. Phase 1 instrumentation values are reusable; don't re-instrument.

---

## 11. Anti-revert directives — read this twice

These rules exist because the natural reaction to a red vitest after Phase 2 is to revert. That reaction is wrong here.

> **DO NOT** run `npm run test-accept-reference`. This would accept the broken diff PNGs as the new reference and silently ship a visual regression. Hard rule.

> **DO NOT** revert the Phase 2 patch on the first red vitest. Expect 5-15 visual failures initially. They are diagnostic information.

> **DO NOT** abandon DR-1 broker-lifecycle on the first failed option. Move through the §4 matrix in order. All three options can plausibly capture the slice.

> **DO NOT** widen the lift's scope to "fix" a Class D failure. Class D's recipe is *add a targeted invalidation event*, never *expand the lifted region*.

> **DO NOT** mix Option 1 and Option 2 infrastructure in the same commit series. If Option 1 fails and you switch to Option 2, reset cleanly per §10.2.

> **DO NOT** accept "the reset is defensive and the test is testing nothing real" reasoning. Visual tests are the reference. Diffs are diagnostic.

> **DO** commit work-in-progress at each successful fix step. Separate commits per fix, each with a class label. Bisect-friendly.

> **DO** re-run A/B at n=64 every 3-5 fixes.

> **DO** treat the Phase 5 iteration cap (10 iterations) as a real ceiling.

> **DO** record falsification in HOTSPOTS.md if all three options fail. See §13.

---

## 12. Definition of done

DR-1 broker-lifecycle is shippable when **all four** hold simultaneously:

### 12.1 vitest

- **vitest 1599/1599** in `packages/alphatab`.
- Zero diff PNGs.
- Zero `npm run test-accept-reference` invocations in this work's history.

### 12.2 Perf

- **A/B `★` on canon-resize-drag at n=64**, median Δ **≤ -5 ms** (≥ ~2σ post-EW-9).
- The paired A/B is the authoritative measurement; multi-process diffs at 5 trials are below the σ floor for sub-5 % shifts (per EW-9 round documentation).

### 12.3 Cross-scenario neutrality

- **No `★` regression** in the 5-trial multi-process diff against the `022d8c9a`-era baseline.
  ```bash
  cd packages/bench
  node dist/run.mjs --trials 5 --label DR1-post-$(date +%s) --save-baseline DR1-post
  node dist/cli.mjs diff baselines/round-022d8c9a.json baselines/DR1-post.json
  ```
- Every non-target scenario must be `·` / `~` / `★ improvement`.

### 12.4 HOTSPOTS.md updated

- The lifecycle change is a **semantic contract change** (broker no longer resets unconditionally). This crosses the "Easy wins" threshold per §1.2.
- The landed entry goes under a NEW header **"Major refactors — landed"** in HOTSPOTS.md (create it if it doesn't yet exist). Place it before the existing "Major refactors — deferred" section.
- The entry includes: median Δ, commit SHA, one-line description of the lifecycle change, list of invalidation events added (`recreatePreBeatGlyphs` etc), cross-reference to this plan.
- The "Major refactors — deferred" DR-1 entry is updated to reflect partial shipment: "DR-1 broker-lifecycle slice landed at commit X; DR-1 remains open for the cross-bar content-version cache and the system-skyline incremental update sub-slices."

---

## 13. Documented falsification path

If all three options in §4 fail (Phase 5 caps OR Phase 3 perf is `·` on all three attempts):

### 13.1 What to record in HOTSPOTS.md

- Demote DR-1 broker-lifecycle slice to **"Demoted at this site"** table (the same section EW-2(b), EW-3 micro-devirt, EW-5 live in).
- Falsification entry shape:
  > **DR-1 broker-lifecycle slice** — attempted via Option 1 (lift reset, `★` Δ=...), Option 2 (cache+replay, `★` Δ=...), Option 3 (record-on-first-call, `★` Δ=...) at SHAs ..., .... All three either failed perf threshold OR introduced visual regressions Phase 5 couldn't resolve within the iteration cap. The `_registerLayoutingInfo` ~7 ms slice is structurally blocked at this codebase shape: [reason X traced]. Capturing it would require [Y structural change — e.g. a content-version cache spanning Bar.voices, or a re-architecture of MasterBarsRenderers to own the layout cache instead of distributing it across renderers].

### 13.2 Update DR-1 in HOTSPOTS.md

- Update the DR-1 entry under "Major refactors — deferred" to reflect:
  - EW-9 Variant B landed the `calculateOverflows` slice (already noted).
  - The `registerLayoutingInfo` slice is structurally blocked (cross-reference to the demotion entry above).
  - The "full content-version cache" form of DR-1 may still be viable but requires the broker lifecycle restructure that this sub-slice was unable to achieve.

### 13.3 Plan postscript

- Add a `§15. Execution outcome` section to THIS plan (same shape as EW-9 plan §15). Record:
  - Which option was tried first; the perf delta; the visual failure count; the iteration count.
  - Same for options 2 and 3 if attempted.
  - The structural reason all three failed (in 2-3 sentences — this is the load-bearing artifact for future DR-1 retries).
  - Cite the specific source-line hooks that defeated each option.

### 13.4 Acceptable-outcome framing

This is **not failure**. A documented structural-block on a known DR-1 sub-slice is a successful round outcome — it tells future work where the codebase's structural limits are. The 7 ms / iter slice goes from "open" to "structurally blocked" — a real status change.

---

## 14. Quick reference card

For the executor mid-Phase-5 who needs the decision tree in one screen:

```
Phase 1 instrumentation:
  preBeatSize/postBeatSize/_beatSizes byte-identical across cycles?
  YES → Option 1 viable, proceed to Phase 2
  PARTIAL (only on wasFirstOfStaff flip) → Option 1 still viable, gate the flip
  NO → Option 2 (cache+replay) or Option 3

Phase 2-3 (Option 1 lift):
  Add brokerNeedsReset to MasterBarsRenderers; gate :293 reset on the flag;
  wrap _registerLayoutingInfo body in same flag; flip true on recreatePreBeatGlyphs.

Phase 3 A/B at n=64:
  ★ ≤ -5 ms? → Phase 4
  ★ in (-5, -3)? → re-run n=96
  ~ → re-run n=128, then drop to Option 2
  · → Option 2

Phase 4 visual triage:
  Spot-check: multi-system-slur-scale-up first (EW-9's worst regression).
  Each red test: A/B/C/D classify per §8.4.

Phase 5 fix loop:
  Class B (cross-stave): find missing brokerNeedsReset=true site
  Class C (beam): lift calculateBeamingOverflows out of gate (EW-9 fix shape)
  Class D (other): trace mutation, add targeted invalidation
  After every 3-5 fixes: re-run A/B; budget ≤ 30 % erosion
  10 iterations cap → Phase 6

Phase 6:
  Option 1 failed → Option 2 (cache+replay), reset to 022d8c9a, redo Phases 2-5
  Option 2 failed → Option 3 (record-on-first-call), reset, redo
  Option 3 failed → §13 falsification path

Never:
  - npm run test-accept-reference
  - git revert Phase 2 on first red vitest
  - widen the lifted region to "fix" a Class D
  - mix Option N and Option N+1 in the same commit series
```

---

## 15. Supporting evidence (cite, don't quote)

- `packages/bench/analysis/2026-06-14-resize-drag/EW-9-PLAN.md` §15 postscript — the falsification record that motivates this plan's existence.
- `packages/bench/HOTSPOTS.md` DR-1 entry (lines 227-237, 265-296) — DR-1 quantification, post-EW-9 status.
- Commits `63e1afef` (Phase 1 max-skip — kept as bisect anchor), `bfcd943f` (Variant B narrowing — shipped), `022d8c9a` (docs commit + postscript).
- `packages/alphatab/src/rendering/staves/StaffSystem.ts:288-345` — `addMasterBarRenderers` (the resize entry point with the smoking-gun reset at line 293).
- `packages/alphatab/src/rendering/staves/StaffSystem.ts:347-425` — `addBars` (initial-layout entry point where `BarLayoutingInfo` is constructed).
- `packages/alphatab/src/rendering/staves/StaffSystem.ts:434-510` — `_trackSystemMinDuration` and `reconcileMinDurationIfDirty` (spring-constant rewrite paths; do NOT touch preBeatSize/postBeatSize/_beatSizes).
- `packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts` — broker field declarations and accumulator semantics (§2.2 catalogue source).
- `packages/alphatab/src/rendering/BarRendererBase.ts:442-458` — `_registerLayoutingInfo` (broker write entry).
- `packages/alphatab/src/rendering/BarRendererBase.ts:479-502` — `applyLayoutingInfo` (broker read entry).
- `packages/alphatab/src/rendering/BarRendererBase.ts:908-935` — current `reLayout` shape (EW-9 Variant B landed form).
- `packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts:200-215` — fan-out to beat containers.
- `packages/alphatab/src/rendering/glyphs/BeatContainerGlyph.ts:187-206` — broker `addBeatSpring`/`setBeatSizes` write site.
- `packages/alphatab/src/rendering/EffectBand.ts:198-220` — secondary broker `addBeatSpring` write site (effect-band contributions).
- `packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts:300-340, 475-500` — resize loop and the `addMasterBarRenderers` vs `addBars` distinction.
- `git blame -L 290,300 packages/alphatab/src/rendering/staves/StaffSystem.ts` — establishes the reset's 2020 origin (Daniel Kuschny, commit `a15680687`, then `StaveGroup.ts`).
- `packages/bench/AGENT_WORKFLOW.md` "Guardrails" section — visual-tests-are-sacred rule; no `test-accept-reference`; separate code and doc commits.

---

## 16. Estimated effort

| Phase | Wall-clock estimate | Notes                                                                                     |
|-------|---------------------|-------------------------------------------------------------------------------------------|
| 1     | 30-60 min           | Instrumentation patch + one bench trial + comparison.                                     |
| 2     | 30-60 min           | Option 1 multi-file diff. More careful than EW-9's single-file delta.                     |
| 3     | 10-15 min build + 5-8 min A/B run | Same shape as EW-9 §5.                                                          |
| 4     | 30-60 min           | Visual triage. Expect EW-9's seven fixtures to be the spot-check set.                     |
| 5     | 90-240 min          | Per-class fix loop. Iteration cap 10 × ~10-15 min each.                                    |
| 6     | 0 or +90-240 min per fallback option | Only if Phase 5 caps. Reset + re-do Phases 2-5 for Options 2 / 3.                   |
| Total | **3-8 hours** if Option 1 lands; up to **15-20 hours** if all three options + falsification | Multi-session work. Session boundaries: end of Phase 1, end of Phase 4, end of each option attempt. |

---

## 17. The two non-negotiable rules

1. **Phase 1 instrumentation MUST run before any source change.** Its outcome determines whether Option 1 is even possible. EW-9 plan §3.4's falsification is the reason — assumptions about broker persistence MUST be empirically verified, not reasoned from the diff.

2. **The §11 anti-revert directives MUST be obeyed.** Especially: do NOT accept reference PNGs; do NOT revert Phase 2 on first vitest red; do NOT widen scope to fix a Class D regression.

If either rule is broken, the executor has departed from the plan. Stop, re-read this document, and resume from the section where the deviation occurred.

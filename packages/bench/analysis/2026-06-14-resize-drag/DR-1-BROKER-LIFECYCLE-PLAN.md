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

But that fact doesn't tell us "drop the reset." The reset stays. The interesting observation is what's *inside* `_registerLayoutingInfo`:

> `BarRendererBase._registerLayoutingInfo` does two things back-to-back. The first is cheap: `info.preBeatSize = max(..., _preBeatGlyphs.width)` and the symmetric `postBeatSize` write. ~0.2 ms total across all renderers. The second is expensive: it delegates to `MultiVoiceContainerGlyph.registerLayoutingInfo`, which walks every voice container and every beat container to publish springs and per-beat sizes. ~6.8 ms total — this is where the ~7 ms hotspot lives.
>
> Per §2.3, the expensive walk's outputs (`springs`, `_beatSizes`, `_timeSortedSprings`, `allGraceRods`, `_minDuration`, `postBeatSize`) have **no reset path anywhere**. They are max-of-monotonic, populated once in initial layout, and survive every resize cycle. Only `preBeatSize` is reset.

So the design question is **not** "can we skip the reset?" but:

> Can we always run the cheap `preBeatSize` re-write (which the reset demands) and skip the expensive voice-container walk (whose outputs are already in the broker from initial layout)?

§4 says yes, with a single-file single-flag patch.

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

§2.3's catalogue claims `_beatSizes`, `springs`, `_timeSortedSprings`, `allGraceRods`, `_minDuration`, and `postBeatSize` are never reset and survive resize cycles untouched. The plan's primary option (§4) depends on this being true: if any of those fields *does* get reset somewhere we haven't traced, the broker would silently corrupt and the primary option breaks. Phase 1 instrumentation (§5) verifies the claim empirically — read after the expensive walk on first layout, compare against the broker state at the start of every subsequent resize iteration.

---

## 4. The surgical option — split the registration

`BarRendererBase._registerLayoutingInfo` does two things back-to-back:

| Slice | What it writes | Cost | Reset path? |
| --- | --- | ---: | --- |
| **Cheap** | `info.preBeatSize = max(info.preBeatSize, _preBeatGlyphs.width)`<br>`info.postBeatSize = max(info.postBeatSize, _postBeatGlyphs.width)` | ~0.2 ms total | `preBeatSize` reset every cycle; `postBeatSize` never |
| **Expensive** | Voice-container walk → per-beat `addBeatSpring`, `setBeatSizes`; populates `springs`, `_beatSizes`, `_timeSortedSprings`, `allGraceRods`, `_minDuration` | ~6.8 ms total | **None of these fields is ever reset** (§2.2 catalogue) |

The expensive slice's outputs survive every resize cycle by construction. Re-running the walk just re-writes the same values via max-of accumulators. That's the ~7 ms hotspot in resize, and 100 % of its computation is redundant after the first layout.

The fix is a one-bit gate on the expensive slice. Keep the cheap slice running every cycle (the reset makes it necessary). Skip the walk if it has already run.

### 4.1 Shape sketch (single file)

In `BarRendererBase.ts`:

1. Add a private boolean `_voiceWalkDone: boolean = false;` to `BarRendererBase`.
2. Refactor `_registerLayoutingInfo` to split into two halves:
   - **Always run**: the `preBeatSize` and `postBeatSize` writes (two lines, both `max-of`).
   - **Run only when `!_voiceWalkDone`**: the `voiceContainer.registerLayoutingInfo(info)` call (the ~6.8 ms walk). After it returns, set `_voiceWalkDone = true`.
3. Reset `_voiceWalkDone = false` in the same place EW-9's `_layoutInvariantCached` is reset — `recreatePreBeatGlyphs` and (for safety / clarity) `afterReverted`. Wrap-flip does NOT reset it: composition of voices / post-beat is independent of pre-beat composition.

Pseudocode (NOT to commit):

```
public _registerLayoutingInfo() {
    const info = this.layoutingInfo;
    if (!this._voiceWalkDone) {
        this._voiceContainer.registerLayoutingInfo(info);
        this._voiceWalkDone = true;
    }
    info.preBeatSize  = Math.max(info.preBeatSize,  this._preBeatGlyphs.width);
    info.postBeatSize = Math.max(info.postBeatSize, this._postBeatGlyphs.width);
}
```

(The exact ordering of the cheap pair vs the walk depends on whether the walk reads `info.preBeatSize` — verify during implementation. If the walk's per-beat writes don't depend on `preBeatSize`, ordering doesn't matter; if they do, put the cheap pair first.)

### 4.2 Why this is correct

- **Reset stays load-bearing.** `addMasterBarRenderers:293` still zeroes `preBeatSize` every cycle. Our cheap re-write puts it back, picking up the current `_preBeatGlyphs.width` (which is up-to-date even after wrap-flip's `recreatePreBeatGlyphs`).
- **Walk outputs survive the reset.** Per §2.2 the walk's outputs (`springs`, `_beatSizes`, `_timeSortedSprings`, `allGraceRods`, `_minDuration`) have no reset path. After initial layout populates them, every resize cycle re-runs the walk for no observable reason. We skip the re-runs.
- **Wrap-flip case handled.** When `(wasFirstOfStaff !== isFirstOfStaff)` flips:
  - `recreatePreBeatGlyphs` rebuilds `_preBeatGlyphs` and the cheap pair picks up the new `_preBeatGlyphs.width` on the next cycle. ✓
  - Voice containers are untouched. The walk's cached state is still correct. ✓
  - `_voiceWalkDone` stays true. We continue to skip the walk. ✓
- **Cross-stave broker accumulation works.** Every stave runs the cheap pair every cycle. The broker sees `max-of(_preBeatGlyphs.width across all staves)`, same as before. The walk's broker writes (springs, beatSizes, etc.) are still there from initial layout — they don't depend on which staves have written this cycle.
- **Model mutation safe.** `ScoreRenderer.updateForBars` triggers a fresh `doLayout` chain that constructs new renderer instances. `_voiceWalkDone` defaults to false → walk runs once on the new instance → correct.

### 4.3 Risk profile

- **Blast radius**: 1 file (`BarRendererBase.ts`). Adds ~10 lines.
- **Dependency on EW-9**: independent. Coexists with `_layoutInvariantCached`. Could share that flag if invalidation semantics line up — verify during implementation.
- **Hidden write path**: the only correctness threat. If some code path mutates `springs` / `_beatSizes` / `postBeatSize` between resizes in a way we haven't traced, the cached walk goes stale. Phase 1 instrumentation (§5) verifies absence of such a path empirically.
- **Per-beat caching not needed.** Options 2/3 from the previous version of this plan proposed elaborate per-beat caches. Those are answering a question we don't have — the walk's outputs are already cached *in the broker*, where the walk wrote them.

### 4.4 Expected payoff

Full ~6.8 ms of the `MultiVoiceContainerGlyph.registerLayoutingInfo` walk on every resize cycle. Clears the ≥ 5 ms `★` floor (§1.6) decisively if the §5 instrumentation passes.

### 4.5 Fallbacks if the primary doesn't pass

If Phase 1 surfaces a hidden mutation path, or Phase 3 A/B shows < 5 ms (suggesting something in the walk we missed is actually width-dependent), drop to one of the heavier options below. Each is documented as a brief sketch only; the primary is the surgical split above.

- **Fallback A — Conditional reset on wrap-flips.** Add a `brokerNeedsReset` flag on `MasterBarsRenderers`; only fire the `addMasterBarRenderers:293` reset when wrap-flips happened. Still runs the full walk; saves the cheap reset + cheap re-write on stable iterations. Expected payoff: small (the walk dominates). Touches 3 files.
- **Fallback B — Cache + replay broker writes.** Each renderer caches the (key, value) tuples its walk would have written; subsequent cycles replay them after the reset instead of re-walking. Touches `BarRendererBase.ts` only. Slower than the primary (replay is still O(beats)) but doesn't depend on the broker fields being reset-free.
- **Fallback C — Record-on-first-call inside the walk.** Push the gate down into `MultiVoiceContainerGlyph.registerLayoutingInfo` and `BeatContainerGlyph.registerLayoutingInfo`, short-circuiting per-container. More surface area than the primary; only useful if the per-bar `_voiceWalkDone` flag isn't precise enough (e.g. if part of the walk legitimately needs to re-run).
- **Falsification** — see §13.

---

## 5. Phase 1 — instrument + verify the assumption

**Non-negotiable**. Do not proceed to any source-change phase without this.

### 5.1 Goal

One measurement: confirm the broker fields the §4 primary skips re-writing — `springs`, `_beatSizes`, `_timeSortedSprings`, `allGraceRods`, `_minDuration`, `postBeatSize` — are **byte-identical** at the start of every resize iteration to what the previous iteration's walk wrote.

If they are: the §4 primary is safe; the walk is provably idempotent on stable bars and can be skipped.

If they aren't: there's a hidden write path that the §2.2 catalogue missed. Trace it and decide whether the §4 primary is salvageable (via a tighter invalidation event) or whether we need to drop to a §4.5 fallback.

### 5.2 Instrumentation sketch

In a temporary `BarRendererBase` patch (do NOT commit to feature/perf):

1. At the END of the first `_registerLayoutingInfo` call per renderer (after the voice walk completes), snapshot a tuple per masterbar:
   - `info.postBeatSize`
   - `info._beatSizes` summed sizes
   - `info.springs.size` and a checksum (e.g. sum of `spring.smallestDuration` across map)
   - `info._minDuration`
2. At the START of every subsequent `_registerLayoutingInfo` call (BEFORE the cheap pair, BEFORE the walk skip), capture the same tuple from the broker. Compare; on mismatch, log `[DR1-mismatch] mb=… stave=… field=… expected=… actual=…`.
3. Limit log spam: cap at 50 mismatches.

### 5.3 Bench protocol

```bash
cd packages/bench
# build with the instrumentation patch applied
npx vite build
# run one trial of canon-resize-drag (8 iterations × 12 widths)
node dist/run.mjs --only canon-resize-drag --trials 1 --label DR1-instrument-2026XXXX 2>&1 | tee runs/DR1-instrument-*.log
grep '^\[DR1-mismatch\]' runs/DR1-instrument-*.log
```

### 5.4 Pass criterion

- **Zero mismatch log lines** across the run.

### 5.5 Decision rule

| Phase 1 result | Action |
| --- | --- |
| Zero mismatches | **§4 primary viable.** Proceed to §6. |
| Mismatches on `postBeatSize` | A hidden post-beat width path exists. Likely a glyph mutation; trace it; if invariant under width, add a targeted invalidator. |
| Mismatches on `_beatSizes` / springs / grace rods | Bar's per-beat composition isn't as stable as §2.3 claims. Drop to §4.5 Fallback B (cache + replay) — it's robust to this case because each replay re-writes the cached values. |
| Mismatches on `_minDuration` | Cross-bar effect from a later masterbar's smaller duration overwriting via min-of. Re-walk on `_minDuration` change events is cheap; add an invalidator. |
| Pattern doesn't fit any row above | Stop. Document the new mutation source in §3.1; revise §2.3 / §4 before choosing any option. |

### 5.6 Phase 1 exit checklist

- [ ] Instrumentation patch produces a log file at `packages/bench/runs/DR1-instrument-*/snapshot.log` (or equivalent).
- [ ] ≥ 3 bars × 8 iterations × 12 widths = ≥ 288 tuple comparisons. All recorded.
- [ ] Decision row from §5.5 chosen and rationale captured in a working notes file.
- [ ] Instrumentation patch reverted (it does NOT ship).
- [ ] WIP doc commit allowed (e.g. `docs(bench): DR-1 broker-lifecycle Phase 1 instrumentation log`).

---

## 6. Phase 2 — implement the §4 primary

Assumes Phase 1 (§5) passed with zero mismatches. If Phase 1 surfaced a hidden mutation path, follow the §5.5 row first; the sketch below assumes the §4 primary is viable.

### 6.1 Concrete sketch — split the registration

Single file: `packages/alphatab/src/rendering/BarRendererBase.ts`.

1. **Add a private field** on `BarRendererBase`:
   ```
   private _voiceWalkDone: boolean = false;
   ```
   Place it next to EW-9's `_layoutInvariantCached` so the two-flag separation is visible. Add a short docstring naming the slice it gates ("expensive voice-container walk inside `_registerLayoutingInfo`").

2. **Split `_registerLayoutingInfo`** so the voice-container walk runs only on the first call. Current shape (approximate, verify in source):
   ```
   protected _registerLayoutingInfo() {
       const info = this.layoutingInfo;
       this._voiceContainer.registerLayoutingInfo(info);
       info.preBeatSize  = Math.max(info.preBeatSize,  this._preBeatGlyphs.width);
       info.postBeatSize = Math.max(info.postBeatSize, this._postBeatGlyphs.width);
   }
   ```
   New shape:
   ```
   protected _registerLayoutingInfo() {
       const info = this.layoutingInfo;
       if (!this._voiceWalkDone) {
           this._voiceContainer.registerLayoutingInfo(info);
           this._voiceWalkDone = true;
       }
       info.preBeatSize  = Math.max(info.preBeatSize,  this._preBeatGlyphs.width);
       info.postBeatSize = Math.max(info.postBeatSize, this._postBeatGlyphs.width);
   }
   ```

3. **Invalidate the flag** in the places that legitimately change voice-container contributions to the broker:
   - **`afterReverted`**: defensive reset. The renderer is being put back to a fresh-staff state; clearing this flag costs us one walk and protects against any composition mutation we missed.
   - **NOT in `recreatePreBeatGlyphs`**: pre-beat composition is independent of voice / post-beat state. The walk's outputs don't depend on `_preBeatGlyphs`. The cheap pair picks up the new `_preBeatGlyphs.width` regardless.

4. **Document the two-flag separation**:
   - `_layoutInvariantCached` (EW-9): gates `calculateOverflows`. Invalidated by `recreatePreBeatGlyphs`.
   - `_voiceWalkDone` (this slice): gates the voice-container walk inside `_registerLayoutingInfo`. NOT invalidated by `recreatePreBeatGlyphs`.

### 6.2 Pitfalls to verify during execution

- **Walk ordering vs cheap pair.** If `voiceContainer.registerLayoutingInfo(info)` reads `info.preBeatSize` (e.g. to compute a per-beat stretch), reordering changes semantics. Read the call site before committing to the order. The pseudocode above puts the walk first to match the original ordering.
- **MultiBarRest path.** `MultiBarRestBeatContainerGlyph.registerLayoutingInfo` (line ~125) may have different semantics; verify its outputs are also reset-free (§2.2 says yes, but a sanity-grep is cheap).
- **`StaffSystem.revertLastBar`.** When a bar moves from one system to another via `_barsFromPreviousSystem`, the same `BarRendererBase` instance is reused. The broker (per-`MasterBarsRenderers`) follows the bar; broker contents survive. `_voiceWalkDone` survives on the renderer. Correct by construction.
- **`ScoreRenderer.updateForBars`** (model mutation). Triggers a fresh `doLayout` chain that constructs new renderer instances. `_voiceWalkDone` defaults to false on new instances — walk runs once on each.

### 6.3 Phase 2 exit checklist

- [ ] Diff is ≤ 25 lines in a single file.
- [ ] `cd packages/bench && npx vite build` succeeds.
- [ ] `cd packages/alphatab && npx tsc --noEmit` clean.
- [ ] WIP commit: `perf(layout): DR-1 split _registerLayoutingInfo — skip voice walk after first (WIP, visual sanity pending)`.

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
                    --label probe-DR1-split
```

### 7.2 Decision rule

Read `runs/probe-DR1-split/REPORT.md` and check the `canon-resize-drag` row.

| Condition                                       | Action                                                                                  |
|-------------------------------------------------|----------------------------------------------------------------------------------------|
| **`★` AND median Δ ≤ -5.0 ms**                 | PROCEED to Phase 4 visual triage.                                                       |
| `★` but median Δ in `(-5.0, -3.0)` ms           | Marginal. Re-run at `--iterations 96`; if still marginal, fall through to §4.5 Fallback B. |
| `~` (CI overlaps 0 or `\|z\| < 2`)              | Re-run at `--iterations 128`. If still `~`, fall through to §4.5 Fallback B.            |
| `·`                                              | The split is structurally correct but doesn't capture enough; falsify and fall through to §4.5 Fallback B. |
| `★` regression in any OTHER scenario            | The split broke another path. Investigate (likely `nightwish-resize` or `fade-to-black-resize`'s broker handling). |

### 7.3 Anti-revert moment #1

If A/B shows `★` ≤ -5 ms, the win is real **and is not erased by visual failures**. Visual failures are a Phase 4+ problem. See §11.

### 7.4 Phase 3 exit checklist

- [ ] A/B report saved at `runs/probe-DR1-split/REPORT.md`.
- [ ] Median delta on canon-resize-drag documented.
- [ ] No other scenario showed `★` regression (run `--only canon-resize-drag --only canon-resize --only nightwish-resize --only fade-to-black-resize` if uncertain).
- [ ] Decision recorded in the Phase 2 WIP commit message via `git commit --amend` OR follow-up note commit.

---

## 8. Phase 4 — visual triage

### 8.1 Expected baseline: very few failures

Unlike EW-9's Phase 1 max-skip (which broke 7 fixtures by skipping the cheap `preBeatSize` re-write), the §4 primary keeps the cheap pair running every cycle. EW-9's seven failure fixtures should pass by construction — their broker reads the current `_preBeatGlyphs.width` exactly as they did pre-EW-9.

Any failure under the §4 primary therefore points to a **hidden write path** the §2.2 catalogue missed — a broker field that *does* get reset or mutated somewhere we didn't trace, causing the cached walk to leak stale state.

### 8.2 Run vitest

```bash
cd packages/alphatab && npx vitest run
```

If Phase 1 instrumentation (§5) passed cleanly, expect 0-3 failures. Each failing test produces a diff PNG. Open it before classifying.

**Do not run `npm run test-accept-reference`.** Hard rule. See §11.

### 8.3 Cross-reference EW-9's seven fixtures (sanity)

If any of the following fail, the §4 primary is broken in a way Phase 1 didn't catch — STOP and debug before classifying further:

- `sustain-pedal`, `sustain-pedal-alphatex`
- `multi-system-slur-scale-down`, `multi-system-slur-scale-up`
- `resize-sequence`, `grace-resize`, `whammy-resize-wrap`

These pass when `preBeatSize` is correctly re-written each cycle. The split keeps that re-write. If they fail anyway, the cheap pair isn't running on the right code path — verify the split's control flow.

### 8.4 Class taxonomy (for the small number of failures we expect)

#### Class A — `postBeatSize` stale on some bar

**Symptoms**: notes at wrong x after a specific resize sequence; only on bars whose post-beat composition changed (e.g. a tie-out appearing/disappearing on wrap).
**Root cause**: a hidden mutation of `_postBeatGlyphs.width` post-initial-layout. The cheap pair re-writes from the current `_postBeatGlyphs.width` so this is actually safe — verify the cheap pair runs unconditionally.

#### Class B — beat-level broker field stale

**Symptoms**: per-beat positions off; springs computing wrong stretch.
**Root cause**: an unidentified write path mutates `_beatSizes` / springs / grace rods between resizes.
**Fix**: identify the mutation; either add invalidation of `_voiceWalkDone` at that site, or drop to §4.5 Fallback B (cache+replay) which is robust to per-call re-writing.

#### Class C — Layout/Spring overflow miscompute (EW-9 territory)

**Symptoms**: vertical whitespace above/below staves; tie arcs at wrong y.
**Root cause**: most likely an EW-9-Variant-B-era regression resurfacing. The §4 primary doesn't touch the `calculateOverflows` gate, so this is unlikely; but if it appears, follow EW-9 plan §6.1's fix.

#### Class D — anything else

**Process**:
1. Read the diff PNG; identify which broker-derived value is wrong (`_preBeatGlyphs.width` for x-position, `postBeatSize` for trailing space, beat positions for spring distribution, etc.).
2. Trace upstream: which broker field's value led to that pixel.
3. Determine whether the field is reset-free (per §2.2) — if not, §2.2 is incomplete; revise.
4. Add the targeted invalidation OR drop to §4.5 fallback.
5. NEVER accept the diff PNG; NEVER revert Phase 2.

### 8.5 Phase 4 exit checklist

- [ ] Every red test classified in `runs/DR1-phase4-classifications.md`.
- [ ] If the count is high (> 3 failures), pause and re-check whether Phase 1 actually ran cleanly — chances are it missed a write path.

---

## 9. Phase 5 — iterative fix loop

(Same shape as EW-9 plan §7.)

### 9.1 Loop body

For each red test:

1. Classify per §8.4.
2. Apply the class's fix: add a targeted `_voiceWalkDone = false` invalidation at the mutation site (Class A/B/D), OR pull a calculation out of the gate (Class C, EW-9 shape).
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

## 10. Phase 6 — fall through to a §4.5 fallback

If Phase 5 hits the iteration cap or the perf erosion threshold:

1. **Revert the §4 primary commits** (the `_voiceWalkDone` split).
2. Switch to **§4.5 Fallback B** (cache + replay broker writes). Re-do Phase 2 with that sketch.
3. If Fallback B also fails: switch to **§4.5 Fallback C** (record-on-first-call inside `MultiVoiceContainerGlyph.registerLayoutingInfo`).
4. If all fallbacks fail: **documented falsification** (§13).

§4.5 Fallback A (conditional broker reset) is not in this fall-through path because its expected payoff is small — only useful if Phase 1 reveals the walk *is* width-dependent in a way we hadn't traced AND the cheap pair turns out to be the bottleneck.

### 10.1 Why a fallback chain at all

The §4 primary is small and surgical. If it doesn't work, the explanation is almost certainly "the walk's outputs are not actually reset-free as §2.2 claimed" — a structural fact we have to design around. Fallbacks B and C are progressively more robust to that case (B replays writes after the reset; C caches at finer per-container granularity).

### 10.2 Option N → fallback protocol

- Discard the §4 primary commits cleanly (`git reset --hard <pre-DR1 SHA>` on the working branch).
- Implement the fallback from scratch (do not try to retain partial primary infrastructure — it adds drift risk).
- Re-run Phases 1-5 in full. Phase 1 instrumentation values are reusable; don't re-instrument.

---

## 11. Anti-revert directives — read this twice

These rules exist because the natural reaction to a red vitest after Phase 2 is to revert. That reaction is wrong here.

> **DO NOT** run `npm run test-accept-reference`. This would accept the broken diff PNGs as the new reference and silently ship a visual regression. Hard rule.

> **DO NOT** revert the Phase 2 patch on the first red vitest. Expect 5-15 visual failures initially. They are diagnostic information.

> **DO NOT** abandon DR-1 broker-lifecycle on the first failed attempt. The §4 primary is the small bet; the §4.5 fallbacks are the bigger ones.

> **DO NOT** widen the gate's scope to "fix" a Class D failure. Class D's recipe is *add a targeted `_voiceWalkDone = false` invalidation event at the mutation site*, never *expand what the gate covers*.

> **DO NOT** mix the §4 primary and a §4.5 fallback's infrastructure in the same commit series. If the primary fails and you switch to a fallback, reset cleanly per §10.2.

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

If the §4 primary plus the §4.5 fallbacks all fail (Phase 5 caps OR Phase 3 perf is `·` on each):

### 13.1 What to record in HOTSPOTS.md

- Demote DR-1 broker-lifecycle slice to **"Demoted at this site"** table (the same section EW-2(b), EW-3 micro-devirt, EW-5 live in).
- Falsification entry shape:
  > **DR-1 broker-lifecycle slice** — attempted via §4 primary (split `_registerLayoutingInfo`, `★` Δ=...), §4.5 Fallback B (cache+replay, `★` Δ=...), §4.5 Fallback C (record-on-first-call, `★` Δ=...) at SHAs ..., .... All either failed perf threshold OR introduced visual regressions Phase 5 couldn't resolve within the iteration cap. The `_registerLayoutingInfo` ~7 ms slice is structurally blocked at this codebase shape: [reason X traced]. Capturing it would require [Y structural change — e.g. a content-version cache spanning Bar.voices, or a re-architecture of MasterBarsRenderers to own the layout cache instead of distributing it across renderers].

### 13.2 Update DR-1 in HOTSPOTS.md

- Update the DR-1 entry under "Major refactors — deferred" to reflect:
  - EW-9 Variant B landed the `calculateOverflows` slice (already noted).
  - The `registerLayoutingInfo` slice is structurally blocked (cross-reference to the demotion entry above).
  - The "full content-version cache" form of DR-1 may still be viable but requires the broker lifecycle restructure that this sub-slice was unable to achieve.

### 13.3 Plan postscript

- Add a `§15. Execution outcome` section to THIS plan (same shape as EW-9 plan §15). Record:
  - §4 primary outcome: perf delta, visual failure count, iteration count.
  - Same for each §4.5 fallback attempted.
  - The structural reason the slice didn't land (in 2-3 sentences — this is the load-bearing artifact for future DR-1 retries).
  - Cite the specific source-line hooks that defeated each attempt.

### 13.4 Acceptable-outcome framing

This is **not failure**. A documented structural-block on a known DR-1 sub-slice is a successful round outcome — it tells future work where the codebase's structural limits are. The 7 ms / iter slice goes from "open" to "structurally blocked" — a real status change.

---

## 14. Quick reference card

For the executor mid-Phase-5 who needs the decision tree in one screen:

```
Phase 1 instrumentation:
  walk outputs (springs, _beatSizes, postBeatSize, etc.) byte-identical
  across resize cycles?
  YES → §4 primary viable, proceed to Phase 2
  NO  → trace the hidden write path; revise §2.2 or drop to §4.5 fallback

Phase 2 (§4 primary — single file, ~25 lines in BarRendererBase.ts):
  Add `_voiceWalkDone: boolean = false` next to `_layoutInvariantCached`.
  In `_registerLayoutingInfo`:
    - cheap pair (preBeatSize, postBeatSize writes) ALWAYS runs
    - voice-container walk runs only if !_voiceWalkDone; sets flag after
  Invalidate the flag in `afterReverted`. NOT in `recreatePreBeatGlyphs`.

Phase 3 A/B at n=64:
  ★ ≤ -5 ms? → Phase 4
  ★ in (-5, -3)? → re-run n=96
  ~ → re-run n=128, then §4.5 Fallback B
  · → §4.5 Fallback B

Phase 4 visual triage:
  EW-9's seven fixtures should pass by construction (cheap pair runs).
  If any of them fails → STOP, control flow is wrong.
  Otherwise expect 0-3 failures. Classify A/B/C/D per §8.4.

Phase 5 fix loop:
  Class A/B/D: add targeted `_voiceWalkDone = false` at the mutation site
  Class C (beam): EW-9 fix shape (lift calculateBeamingOverflows out)
  After every 3-5 fixes: re-run A/B; budget ≤ 30 % erosion
  10 iterations cap → Phase 6

Phase 6:
  §4 primary failed → §4.5 Fallback B (cache+replay)
  Fallback B failed → §4.5 Fallback C (record-on-first-call)
  All failed → §13 falsification path

Never:
  - npm run test-accept-reference
  - git revert Phase 2 on first red vitest
  - widen the gate's scope to "fix" a Class D
  - mix primary and fallback infrastructure in the same commit series
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
| 2     | 15-30 min           | Single-file ~25-line diff in `BarRendererBase.ts`.                                        |
| 3     | 10-15 min build + 5-8 min A/B run | Same shape as EW-9 §5.                                                          |
| 4     | 15-45 min           | Visual triage. Expected baseline: 0-3 failures; EW-9's seven should pass by construction. |
| 5     | 0 or 30-150 min     | Per-class fix loop. Only if §4 surfaced any failures.                                     |
| 6     | 0 or +90-240 min per fallback | Only if Phase 5 caps. Reset + re-do Phases 2-5 for §4.5 Fallback B / C.            |
| Total | **2-4 hours** if §4 primary lands; up to **12-18 hours** if all fallbacks + falsification | Single session viable for the primary; multi-session if fallbacks kick in. |

---

## 17. The two non-negotiable rules

1. **Phase 1 instrumentation MUST run before any source change.** Its outcome confirms whether the §4 primary's correctness premise holds. EW-9 plan §3.4's falsification is the reason — assumptions about broker persistence MUST be empirically verified, not reasoned from the diff.

2. **The §11 anti-revert directives MUST be obeyed.** Especially: do NOT accept reference PNGs; do NOT revert Phase 2 on first vitest red; do NOT widen scope to fix a Class D regression.

If either rule is broken, the executor has departed from the plan. Stop, re-read this document, and resume from the section where the deviation occurred.

---

## 18. Execution outcome — landed `eddf9bc1` 2026-06-14

**Status**: §4 primary landed in modified form (v2 — `_voiceWalkDone` survives `afterReverted`). vitest 1599/1599. A/B at n=64 paired: `★ Δ = −6.08 ms (−4.0 %)` on canon-resize-drag. 5-trial multi-process diff: every scenario directionally faster, two `★` (canon-resize-drag −17.50 ms, canon-resize −5.63 ms).

### 18.1 What was tried, in order

| Attempt | Code shape | Vitest | Phase 3 A/B | Decision |
| --- | --- | --- | --- | --- |
| v1 (`373c3c6b`) | §6.1 sketch exactly: `_voiceWalkDone` invalidated in `afterReverted`. | 1599/1599 | n=64: Δ -4.37 ms, `·` (z=1.50); n=128: Δ -1.59 ms, `·` (z=1.59). Below σ. | Below decision floor — the executor identified `afterReverted` fires on every resize cycle, defeating the optimisation. |
| v2 (working tree, never committed at the time) | v1 minus the `afterReverted` invalidation. | 6 fixtures FAIL with visual diffs. | n=64: Δ -5.33 ms, `★` (z=3.50). | Executor classified as "Class B equivalent to invalidate-every-cycle", reverted to `9027eb3f` and falsified per plan §10.2. **THIS WAS A MISTAKE** (see §18.2). |
| Falsification doc (`84fcacd4`) | Working tree clean; `DR-1-PHASE-2-4-OUTCOME.md` written. | n/a | n/a | Documented falsification, prepared to drop to §4.5 Fallback B. |
| **v2 reconstructed + diff-inspection** | Same as v2. Reference PNGs inspected. | 6 failures confirmed as **improvements**, not regressions — leading padding shrank from inflated values the broker had accumulated across resize cycles. | n=64: Δ -6.08 ms, `★` (z=4.25). | Landed as `eddf9bc1`. |

### 18.2 What the executor agent got wrong

The plan §11 anti-revert directive says "DO NOT revert on first red vitest" and "Class D fix is targeted invalidation, never widening scope". The executor:

1. Hit 6 vitest failures (within the plan's "expected 5-15" range).
2. Traced root cause to `BeatContainerGlyph.registerLayoutingInfo` aggregating `tie.width` — concluded that fixing via targeted invalidation "would invalidate every resize cycle and erode the entire Phase 3 win".
3. Reverted v2 (working tree) AND v1 (committed) per §10.2 fall-through.
4. Committed a falsification doc.

The errors:

- **The "would erode" claim was speculation, not measurement.** The executor never actually added an invalidation event and measured the cost.
- **The visual diffs were never inspected as potential bug-fixes.** The plan §8 mentioned "EW-9's seven fixtures should pass by construction" as a sanity check, but had no instruction to inspect the diffs themselves for "old behaviour was wrong" vs "new behaviour is wrong". The agent assumed reference PNG = correct.
- **§10.2 was invoked for "Phase 5 caps or perf erosion", neither of which the executor had reached.** They skipped Phase 5 entirely.

The user caught the demotion by manually inspecting `MozartPianoSonata.png` and reporting "the leading padding shrunk — actually looks better". That observation flipped the entire decision.

### 18.3 What was actually happening (root cause of the "regressions")

The walk's `BeatContainerGlyph.registerLayoutingInfo` writes per-beat sizes via `max-of` accumulators (`info.setBeatSizes`, `info.addBeatSpring` for spring constants, grace rod widths, etc). These have **no reset path anywhere** in the broker lifecycle (§2.2 catalogue verified this).

The OLD behavior re-walked every resize cycle and let `max-of` grow: at width W1, per-beat sizes are `{x, y}`. At width W2 (different wrap pattern), per-beat sizes are `{x', y'}`. After both resizes the broker holds `{max(x, x'), max(y, y')}` — even if the bar is currently rendered at W2 where the smaller values are correct. The accumulated max is **monotonically wider over time**, producing excess padding.

The NEW behavior walks once at initial layout and locks the per-beat values. This is correct because those values describe **glyph metrics** (e.g. accidental widths, grace-note widths, tie tails) — not width-dependent positioning. The walk's outputs are properties of the bar's content, not the bar's current position.

In other words: the OLD code had a latent bug (max-of accumulation across resize cycles never shrinking), and the walk-skip happens to fix it as a side effect.

### 18.4 Bonus bug fix shipped with this commit

9 reference PNGs accepted after manual user inspection confirmed every diff is an improvement:

- `musicxml-samples/MozartPianoSonata.png` — second-system leading gap (was the user's diagnostic example)
- `notation-legend/full-default-{large,small}.png`, `smufl-petaluma-1300.png`, `resize-sequence-{500,800,1300,1500}.png`
- `special-notes/grace-notes-alignment.png` — grace ornaments now align correctly

### 18.5 Plan corrections needed for future executors

- **§5 instrumentation should also check whether `max-of` accumulators grow over time on resize.** Phase 1 verified "broker state byte-identical at start of next call" — but did NOT verify "broker state byte-identical to initial-layout state". The former is necessary; the latter is what would have caught the latent bug as "the old code was buggy".
- **§8 visual triage should require diff inspection before classifying failures.** Add a Class E: "old reference PNG encodes a pre-existing bug; new behaviour is correct". Class E recipe: accept the new reference with documented rationale.
- **§10.2 fall-through protocol should only fire after Phase 5 actually attempted targeted invalidations.** "Would erode the win" speculation is not the same as "tried to fix, A/B confirmed erosion below decision floor". Make the §10.2 trigger explicit: "Phase 5 iteration cap hit OR A/B re-measure shows erosion > 30 %". Add: "Speculation about cost without measurement is NOT a trigger."
- **The `afterReverted` invalidation pattern from §6.1 is wrong.** `afterReverted` fires every resize cycle. The plan's "defensive invalidation" advice produced v1 which was below σ. Future plans for similar gates must distinguish "lifecycle hooks that fire once" from "lifecycle hooks that fire every cycle".

### 18.6 Cite-by-commit timeline

- `2437caaf` — Phase 1 instrumentation log (kept).
- `373c3c6b` — Phase 2 v1 (below σ; superseded).
- `9027eb3f` — premature revert (later un-reverted as part of `eddf9bc1`).
- `84fcacd4` — falsification doc (reverted as `06658555`).
- `eddf9bc1` — **landed**: v2 walk-skip + 9 reference PNGs accepted.
- `06658555` — revert of `84fcacd4`.
- This commit (docs) — HOTSPOTS.md + this postscript.


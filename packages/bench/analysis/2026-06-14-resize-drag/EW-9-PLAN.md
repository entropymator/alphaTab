# EW-9 — Phased implementation plan

**Status**: open, not started.
**Target**: `feature/perf` HEAD.
**Scenario**: `canon-resize-drag` (235.30 ms median, σ ±3.48 ms / 1.48 %).
**Author rule**: this plan is the executor's checklist. Read it once top-to-bottom before touching code. The anti-revert directives in §9 are not optional.

---

## 1. Goal & σ floor

Skip the bar-local layout work that `BarRendererBase.reLayout` re-runs every width change, on the strength of the empirical width-invariance claim from the 2026-06-14 round (see `subagent-layout-walk.md` + `subagent-beam.md`).

Numerical envelope (canon-resize-drag, all numbers in ms/iter):

| Quantity                                  | ms/iter        | Source                          |
|-------------------------------------------|---------------:|---------------------------------|
| Baseline median                           | 235.30         | round-baseline `resize-drag-1781434957` |
| Cross-trial σ                             | ±3.48 (1.48 %) | same                            |
| 1 % σ floor                               | 2.35           | HOTSPOTS.md "Headline numbers"  |
| **≥ 2σ threshold (`★` resolution)**      | **≈ 7.0**      | the bar EW-9 must clear         |
| Upper bound of EW-9 sliver                | 12-16          | HOTSPOTS.md EW-9 signal table   |
| Aggregate width-invariant work in area    | ≈ 14 (+ beam 2.9) | DR-1 quantification          |

The candidate **must reach ≥ 7 ms median improvement** on `canon-resize-drag` to be defensible. ≤ 7 ms is `~` (1-2σ) and gets STOPPED at the end of Phase 2 (see §5 decision rule). The 12-16 ms upper bound means we have ~5-9 ms of margin if **every** invalidation event we wire up costs ≤ 0.5 ms.

No other scenario in the matrix may show `★` regression. Visual tests must end at 1599/1599.

---

## 2. Architectural map

### 2.1 Resize entry chain (the call path EW-9 lives inside)

```
ScoreRenderer.resizeRender
 └─ ScoreLayout.resize
     └─ VerticalLayoutBase.doResize                          [layout/VerticalLayoutBase.ts:140]
         └─ _resizeAndRenderScore                            [layout/VerticalLayoutBase.ts:281]
             ├─ (barsPerRowActive=false; canon-drag path)
             ├─ for every renderer:  bar.afterReverted()     [BarRendererBase.ts:460]   ← resets isFinalized, clears staff
             ├─ _systems = []; createEmptyStaffSystem(...)
             ├─ for every MasterBarsRenderers:
             │    StaffSystem.addMasterBarRenderers          [staves/StaffSystem.ts:~280, calls _trackSystemMinDuration→_applyLayoutAndUpdateWidth]
             │      └─ RenderStaff.addBarRenderer            [staves/RenderStaff.ts:132]
             │          └─ renderer.reLayout()               [BarRendererBase.ts:874]  ★ THE GATE TARGET
             ├─ system.isFull → _fitSystem(system)           [VerticalLayoutBase.ts:406]
             │    ├─ system.reconcileMinDurationIfDirty()    [StaffSystem.ts:460]  → may call applyLayoutingInfo on each renderer
             │    ├─ _scaleToWidth(system, w)                [VerticalLayoutBase.ts:429]
             │    │    └─ for each renderer: renderer.scaleToWidth(actualBarWidth)  [BarRendererBase.ts:362]
             │    │          ├─ barLocalSkyline.reset()
             │    │          ├─ invalidate every BeamingHelper drawing info
             │    │          ├─ voiceContainer.scaleToWidth → _scaleToForce(emit=true)  [MultiVoiceContainerGlyph.ts:58/64]
             │    │          ├─ emitHelperSkyline(h) for every beam helper
             │    │          ├─ topEffects/bottomEffects.alignGlyphs
             │    │          ├─ preBeatGlyphs[].populateSkyline (re-emit)
             │    │          ├─ topEffects/bottomEffects.populateSkyline
             │    │          ├─ emitSubclassBarLocalSkyline()
             │    │          └─ isFinalized = true
             │    └─ system.finalizeSystem()                 [StaffSystem.finalizeSystem]
             │         └─ for each staff: staff.finalizeStaff()   [RenderStaff.ts:273]
             │              ├─ for each renderer: finalizeOwnedTies / finalizeEffectBandSpans
             │              ├─    if (renderer.tiesDirty) { refreshSizes; registerStaffOverflows; clearTiesDirty }
             │              ├─    _unionBarLocalIntoStaffSkyline(renderer)
             │              └─ effectPlacement.placeAndApply()    [EffectSystemPlacement.ts:28]
             └─ _paintSystem(system, oldHeight)              [VerticalLayoutBase.ts:375]
                  ├─ system.buildBoundingsLookup(0, 0)
                  └─ register a partial; canvas paints later
```

### 2.2 Width-invariance classification

Per `subagent-layout-walk.md` §"Width-invariant work being re-run" and `subagent-beam.md` Q1/Q2:

**(A) Width-INVARIANT — currently re-runs every width change for no reason** (target of the skip):

| Function                                                      | File:line                                    | ms/iter | One-line justification                                                                  |
|---------------------------------------------------------------|----------------------------------------------|--------:|----------------------------------------------------------------------------------------|
| `BarRendererBase._registerLayoutingInfo`                      | BarRendererBase.ts:442                       |    ~0.2 | wrapper; dispatches to MultiVoiceContainerGlyph                                          |
| `MultiVoiceContainerGlyph.registerLayoutingInfo`              | MultiVoiceContainerGlyph.ts:200              |   ~7.0  | broker pre/postBeatSize + per-beat sizes are derived from `Bar`, not `width`.            |
| `BarRendererBase.calculateOverflows` + `_emitGroupOverflows`  | BarRendererBase.ts:643 / 683                 |   ~5.5  | pre/post-beat glyph bbox is bar-local; emits into `pre/postBeatLocalSkyline` with local x. |
| `LineBarRenderer._computeBeamingBounds` (and its callers)     | LineBarRenderer.ts:899                       |   ~2.9  | beam endpoint y in stem-local coords is invariant; only the post-spring x changes.       |
| `EffectSystemPlacement.placeAndApply` (sort+grouping subset)  | EffectSystemPlacement.ts:28                  |   ~10 of 20.2 | band sortKey, voice index, effect category all width-invariant; only `placedMagnitude` (skyline query) is width-dependent. |

Aggregate **bar-local invariant**: ≈ 15.6 ms / iter inside `reLayout`'s body alone. Plus ~2.9 ms in `scaleToWidth`'s emitHelperSkyline path. Plus ~10 ms in the placeAndApply sort/group portion. Total ceiling for the skip ≈ 18-25 ms; the practical EW-9 target is the first 12-16 ms because the rest needs a separate seam.

**(S/I) Width-DEPENDENT — must re-run** (DO NOT touch):

| Function                                              | File:line                                | Why it's width-dependent                                                                |
|-------------------------------------------------------|------------------------------------------|----------------------------------------------------------------------------------------|
| `MultiVoiceContainerGlyph._scaleToForce(force, true)` | MultiVoiceContainerGlyph.ts:64           | `force = spaceToForce(width)`; positions change per width.                              |
| `Skyline.unionShifted3` (system union)                | RenderStaff._unionBarLocalIntoStaffSkyline:236 | shifts each bar-local skyline by `renderer.x` which changes every resize.        |
| `_scaleToWidth` body (VerticalLayoutBase:429)         | VerticalLayoutBase.ts:429                | distributes content share across bars by width.                                          |
| `_emitBeatContainerSkyline` (called from _scaleToForce) | MultiVoiceContainerGlyph.ts:155       | re-emits bar-local skyline at new beat x positions.                                     |
| `EffectSystemPlacement._placeSide` skyline queries    | EffectSystemPlacement.ts:101             | reads `sky.upSky.maxHeightInRange(r.x, r.x + r.width)`; both inputs width-dependent.     |
| `buildBoundingsLookup`                                | BarRendererBase.ts:784, StaffSystem.ts   | absolute pixel coords; recorded under DR-6 separately.                                   |
| `paintBackground`/paint surface                        | various                                  | DR-3 territory.                                                                          |

### 2.3 The post-layout mutation hooks (where invalidation events live)

These are the call sites that mutate state EW-9 wants to cache. Each one is a candidate invalidation event:

| Site                                            | File:line                       | What it mutates                              |
|-------------------------------------------------|---------------------------------|----------------------------------------------|
| `BarRendererBase.afterReverted`                 | BarRendererBase.ts:460          | `staff = undefined; isFinalized = false`     |
| `BarRendererBase.afterStaffBarReverted`         | BarRendererBase.ts:466          | top/bottomEffects.height = 0; staff overflow |
| `BarRendererBase.scaleToWidth`                  | BarRendererBase.ts:362          | barLocalSkyline.reset + isFinalized=true     |
| `BarRendererBase.recreatePreBeatGlyphs`         | BarRendererBase.ts:889 (+ LineBarRenderer override at 641) | rebuilds `_preBeatGlyphs` group entirely |
| `BarRendererBase.applyLayoutingInfo`            | BarRendererBase.ts:479          | `_preBeatGlyphs.width`, voiceContainer.x, _postBeatGlyphs.width — pulls broker into renderer |
| `BarRendererBase._emitTies`                     | BarRendererBase.ts:535          | calls `tie.doLayout()` (mutates `tie.y`) + may register overflow → `markTiesDirty` |
| `RenderStaff.finalizeStaff` tie-dirty branch    | RenderStaff.ts:292              | `renderer.refreshSizes()`; calls `updateSizes` which rewrites width/height |
| `EffectSystemPlacement.placeAndApply`           | EffectSystemPlacement.ts:28     | writes `r.topEffects.height`, `r.bottomEffects.height`, `band.y`, `band.placedMagnitude` |
| `MultiVoiceContainerGlyph.applyLayoutingInfo`   | MultiVoiceContainerGlyph.ts:208 | child `.x` + a `_scaleToForce(force, emit=false)` positioning-only pass |
| `StaffSystem.reconcileMinDurationIfDirty`       | StaffSystem.ts:460              | when a later bar has shorter minDuration, calls `mb.layoutingInfo.recomputeSpringConstants` and `r.applyLayoutingInfo()` on every renderer of dirty masterbars |
| `StaffSystem._trackSystemMinDuration`           | StaffSystem.ts:434              | may flag `isMinDurationDirty=true` when a bar is added with a shorter min |

Important: **`BarLayoutingInfo` is per-`MasterBarsRenderers`, shared across all staves of the masterbar** (see `StaffSystem.addBars:354` → `result.layoutingInfo = new BarLayoutingInfo(); ... barLayoutingInfo = result.layoutingInfo; ... s.addBar(bar, barLayoutingInfo, ...)`). This is the **cross-stave broker** the executor must handle in §3.4.

---

## 3. Invalidation event catalogue

This section enumerates *every* mutation hook the Phase 1 skip is going to encounter. For each: what changes, whether the cache must invalidate, and how to detect.

### 3.1 `bar` content mutates (notes, voices, durations added/removed)

- **What changes**: `Bar.voices[].beats[]` — durations, note pitches, tuplet groups, grace groups, dynamics.
- **Impact on cached state**: `BarLayoutingInfo.springs/allGraceRods/_beatSizes` and the renderer's `_preBeatGlyphs/_postBeatGlyphs/voiceContainer` are derived from this. **All cached state is invalidated.**
- **How it reaches the renderer**: only via a fresh `doLayout()` (initial layout, or when `ScoreRenderer.updateForBars` is invoked from an editor harness). The resize path **does not** mutate `bar`.
- **Decision**: the cache need NOT actively listen to model changes during resize. The resize path is gated by the call chain — by the time `reLayout` fires, `bar` has not changed since `doLayout` set up the renderer. The gate is therefore: cache becomes valid after the **first** successful `doLayout`, and is invalidated by `afterReverted` (which the resize path itself triggers) — see §3.2.
- **Phase 1 wiring**: no listener needed for `bar` mutation. The lifecycle of `BarRendererBase` re-creation handles it (the renderer is destroyed and a fresh one made when bar content changes through the public API).

### 3.2 `afterReverted` fires (resize path's own re-pack)

- **What changes**: `staff = undefined; isFinalized = false`. The renderer is being put back into the "fresh, awaiting addBarRenderer" state.
- **Impact**: the cache **stays valid**. `afterReverted` is exactly the situation EW-9 exploits — the renderer's bar-local state survives, only the staff membership changes.
- **Phase 1 wiring**: `afterReverted` MUST NOT flip the cache flag off. This is the entire point of the optimisation.
- **Phase 1 paranoid setting**: keep `_layoutInvariantCached = true` across `afterReverted`. Only flip it off in §3.3 / §3.4.

### 3.3 `recreatePreBeatGlyphs` fires (`wasFirstOfStaff` flipped)

- **What changes**: `_preBeatGlyphs` (the clef/keysig/timesig/barline group) is rebuilt from scratch. Its width changes. Subclass `LineBarRenderer.recreatePreBeatGlyphs:641` may add staff lines.
- **Impact**: `preBeatSize` written into broker is now stale; `preBeatLocalSkyline` is stale; the `_preBeatGlyphs.width` value `applyLayoutingInfo` reads has changed.
- **Decision**: cache MUST invalidate.
- **Phase 1 wiring**: inside the existing `if ((wasFirstOfStaff && !isFirstOfStaff) || ...)` block in `reLayout` (line 881-883), set `_layoutInvariantCached = false` BEFORE calling `recreatePreBeatGlyphs`. The rebuild + the `_registerLayoutingInfo + calculateOverflows` that follow run in full and re-set the cache.

### 3.4 Cross-stave broker (`BarLayoutingInfo` shared across staves of a masterbar)

This is the highest-risk class of failure mode. Re-read `StaffSystem.addBars:354` and `StaffSystem.addMasterBarRenderers:~341` before designing the gate.

- **Setup**: each masterbar owns ONE `BarLayoutingInfo` instance. When `RenderStaff.addBarRenderer` calls `renderer.reLayout()` for stave-A's renderer, that renderer reads/writes to the shared broker. Then stave-B's renderer reads/writes to the same broker. The `max-of` discipline in `_registerLayoutingInfo` (`if (info.preBeatSize < preSize)`) accumulates the maximum across all staves.
- **Risk**: if stave-A is skipped (cached) but stave-B is **not** skipped (it's a different renderer class — Tab vs Score — and only one of them might be cached), the broker's max-of accumulates only stave-B's values, missing stave-A's contribution. This produces narrower-than-correct broker widths → visual regression on multi-stave systems.
- **Solution**: the gate runs **per renderer**, and `_registerLayoutingInfo`'s max-of is idempotent. Skipping a renderer leaves the broker's previous (correct) values intact, which were established during the renderer's previous `_registerLayoutingInfo` run. The cross-stave invariant survives because:
  - First resize cycle: every renderer ran `_registerLayoutingInfo`, broker reflects all-staves max.
  - Second resize cycle: every renderer is skipped, broker is untouched and still reflects all-staves max from cycle 1. **Correct.**
- **BUT — `StaffSystem.reconcileMinDurationIfDirty`** (StaffSystem.ts:460) can call `mb.layoutingInfo.recomputeSpringConstants(this.minDuration)` if a later-added bar shortens the system min. The `spring.springConstant` values change, but `preBeatSize`/`postBeatSize`/`_beatSizes` do not (those are bar-local glyph metrics, not spring constants). The cached `preBeatLocalSkyline` and `postBeatLocalSkyline` therefore survive `recomputeSpringConstants`. Springs only feed into `_scaleToForce`, which is in the width-dependent path and runs unconditionally.
- **Decision**: cross-stave broker is safe to leave untouched. NO invalidation event needed here. **But trip-wire this**: if a Class B regression (per Phase 3) appears, the suspicion is to look here first.
- **Phase 1 wiring**: no listener. Phase 4 may add one if Class B appears.

### 3.5 `applyLayoutingInfo` runs after `reLayout` (in `_applyLayoutAndUpdateWidth` and `reconcileMinDurationIfDirty`)

- **What changes**: pulls broker values into the renderer (`_preBeatGlyphs.width`, `voiceContainer.x/width`, `_postBeatGlyphs.width`, `width`, `computedWidth`). Internally calls `MultiVoiceContainerGlyph.applyLayoutingInfo` which runs `_scaleToForce(force, /*emit=*/false)` — positioning-only.
- **Impact on cache**: `_preBeatGlyphs.width` / `_postBeatGlyphs.width` are READ from broker, the broker is unchanged (see §3.4), so values come back identical IFF nothing has invalidated. The renderer's own `width`/`computedWidth` get rewritten from broker — those are NOT cached by EW-9, they always re-run.
- **Decision**: applyLayoutingInfo's writes are derived purely from broker state. The skip leaves them intact (they get rewritten next call). NO invalidation event needed.
- **Phase 1 wiring**: no listener.

### 3.6 Tie finalisation (`finalizeOwnedTies` → `_emitTies`)

- **What changes**: each tie's `doLayout()` is called (sets `tie.y`, `tie.height`, `tie.width`). Then for each tie spanning the renderer, `registerOverflowRangeTop`/`registerOverflowRangeBottom` writes to `_contentTopOverflow`/`_contentBottomOverflow` AND to `barLocalSkyline`. If the overflow value grew, `markTiesDirty()` is called → `renderer.refreshSizes(); registerStaffOverflows; clearTiesDirty` in `RenderStaff.finalizeStaff:292`.
- **Impact on cache**: tie height depends on note positions (post-spring positions, **width-dependent**). On a width change, ties shift, their overflow contribution changes, `_contentTopOverflow` may grow. Therefore **tie-driven overflow IS width-dependent** even though the *invariant* claim was about pre/post-beat glyph overflow.
- **Decision**: the EW-9 skip targets `_registerLayoutingInfo` + `calculateOverflows` (the pre/post-beat group overflow walk + the voiceContainer bbox walk). It does **NOT** skip the tie finalize path — that still runs after `_scaleToWidth` in `finalizeStaff`. So the tie writes still happen.
- **BUT — the question**: when `_contentTopOverflow` grows because of a tie, does the broker's `preBeatSize` need to grow too? Answer: NO. `preBeatSize` is the pre-beat glyph block width (clef + keysig + timesig); ties don't write to it. `_contentTopOverflow` is the renderer's content overflow used by `registerStaffOverflows` (which feeds `staff.topOverflow`), not the broker.
- **Decision**: tie finalisation does NOT need to invalidate the EW-9 cache. The values it writes (`_contentTopOverflow`, `barLocalSkyline` insertions) are part of the width-dependent path that already runs every cycle.
- **Trip-wire**: tie heights depend on `getBoundingBoxTop` of the start/end note glyphs, which use the post-spring x positions. If tie-emitted overflow on one cycle exceeds the cached `_contentTopOverflow` from a previous cycle, the value naturally accumulates (max-of in `registerOverflowTop`). If tie shrinks between cycles (e.g. wider system = flatter tie = less overflow), the cached value WON'T shrink because `_contentTopOverflow` is monotonic max-of. **This is the most likely Class A failure mode**: tie overflow grew on a previous resize, the cache now holds an inflated value, the visual paddings are stuck wider than they should be.
- **Phase 1 wiring**: no listener (it's already in the "always-runs" path). **If Phase 3 shows Class A, the fix is**: reset `_contentTopOverflow` / `_contentBottomOverflow` at the start of `reLayout` even when we skip the body. See §6 Class A.

### 3.7 Voice merging / multi-voice layout (`_doMultiVoiceLayout`)

- **What changes**: when `bar.isMultiVoice`, `MultiVoiceContainerGlyph.doLayout` calls `_doMultiVoiceLayout` which re-positions voices and may shift `b.x` and call `b.doMultiVoiceLayout()` (which writes to child `.y` for some BeatContainer subclasses).
- **Impact**: this is part of `doLayout`, not `reLayout`. Runs once, never re-runs on resize.
- **Decision**: no invalidation event. The multi-voice layout output is already invariant under resize.
- **Phase 1 wiring**: no listener.

### 3.8 Effect-band placement (`EffectSystemPlacement.placeAndApply`)

- **What changes**: writes `r.topEffects.height`, `r.bottomEffects.height`, `band.placedMagnitude`, `band.y`. Reads `staff.systemSkyline` (width-dependent) and `sky.upSky.maxHeightInRange(r.x, r.x+r.width)` (width-dependent).
- **Impact on cache**: outputs depend on width-dependent skyline; runs unconditionally in every `finalizeStaff` cycle. NOT skippable by EW-9's gate.
- **BUT**: this writes `r.topEffects.height` / `r.bottomEffects.height` AFTER `reLayout` already set `this.topEffects.height = 0; this.bottomEffects.height = 0` at the head of `reLayout` body. The Phase 1 skip MUST still execute these two resets — they live at lines 875-876, ABOVE the skip gate. (Confirmed when reading §4.)
- **Decision**: no invalidation listener; just make sure the two `effects.height = 0` resets aren't accidentally skipped.
- **Phase 1 wiring**: keep `topEffects.height = 0; bottomEffects.height = 0; updateSizes()` outside the gate.

### 3.9 `wasFirstOfStaff` lifecycle

- **What changes**: `wasFirstOfStaff` is set inside `createPreBeatGlyphs` at line 808 (`this.wasFirstOfStaff = this.isFirstOfStaff`). So after `doLayout` (or `recreatePreBeatGlyphs`), it reflects the staff position **as of the last full layout**. `isFirstOfStaff` is a getter on `index === 0`. The branch at line 881 triggers `recreatePreBeatGlyphs` when staff-position changes.
- **Impact**: the recreate triggers the cache invalidation already covered in §3.3.
- **Decision**: existing branch is sufficient.
- **Phase 1 wiring**: tied to §3.3, no separate event.

### 3.10 `_trackSystemMinDuration` → `recomputeSpringConstants`

- **What changes**: spring constants get re-derived. `BarLayoutingInfo.version++`. Springs feed `_scaleToForce` only.
- **Impact**: `preBeatSize`/`postBeatSize`/`_beatSizes` unchanged. Cache survives. `_scaleToForce` runs unconditionally and consumes new constants correctly.
- **Decision**: no invalidation event.
- **Phase 1 wiring**: no listener.

### 3.11 Catalogue summary

| Event                              | Phase 1 listener?                      | Phase 4 fallback if Class X seen |
|------------------------------------|----------------------------------------|----------------------------------|
| `bar` mutates (model change)       | NO (handled by renderer destruction)   | n/a                              |
| `afterReverted`                    | NO (cache preserved across this)       | Class D: revisit                 |
| `recreatePreBeatGlyphs`            | **YES — invalidate**                   | already there                    |
| Cross-stave broker accumulate      | NO (idempotent max-of survives skip)   | Class B: per-MasterBarsRenderers gate |
| `applyLayoutingInfo` reads broker  | NO (writes derived from cached state)  | Class D                          |
| Tie finalisation (`_emitTies`)     | NO (still runs every cycle)            | **Class A** — reset overflow accumulators |
| `_doMultiVoiceLayout`              | NO (runs in doLayout only)             | Class D                          |
| `EffectSystemPlacement.placeAndApply` | NO (still runs every cycle)         | Class D                          |
| `_trackSystemMinDuration`          | NO (springs invariant for cache)       | Class D                          |
| `scaleToWidth` runs                | NO (the cache survives `scaleToWidth`) | Class C — beam endpoint mismatch |

---

## 4. Phase 1 — naive max-skip patch

### 4.1 Goal

Stand up the gate. Expect breakage. Do not yet care about correctness on visual tests. Verify the perf delta first, fix visuals second.

### 4.2 Files to touch

**Single file**: `packages/alphatab/src/rendering/BarRendererBase.ts`.

No other source file. The gate must be self-contained at this stage so reverting is one diff.

### 4.3 Concrete sketch (no actual code)

1. **Add field** `private _layoutInvariantCached: boolean = false;` next to `isFinalized` (line 499 area).

2. **Add helper** `public invalidateLayoutCache(): void { this._layoutInvariantCached = false; }`. This is the externally-callable invalidation hook — Phase 4 may wire more callers into it.

3. **At the end of `doLayout`** (after line 640 `this.calculateOverflows(0, this.height);`): set `this._layoutInvariantCached = true;`. The first full layout pass establishes the cached state.

4. **Inside `reLayout`** (line 874), restructure to:
   - `this.topEffects.height = 0; this.bottomEffects.height = 0;` — KEEP (lines 875-876, EffectSystemPlacement writes this; resetting it lets the staff overflow recompute).
   - `this.updateSizes();` — KEEP (line 877, width/height geometry update).
   - The `wasFirstOfStaff` branch (lines 881-883):
     - When the branch fires, ADD `this._layoutInvariantCached = false;` BEFORE the call to `recreatePreBeatGlyphs()`.
   - **NEW: gate the rest**:
     - `if (!this._layoutInvariantCached) { this._registerLayoutingInfo(); this.calculateOverflows(0, this.height); this._layoutInvariantCached = true; }`
     - The two skipped calls are `_registerLayoutingInfo()` and `calculateOverflows(0, this.height)`.

5. **Inside `afterReverted`** (line 460): DO NOT touch `_layoutInvariantCached`. Explicit comment: `// _layoutInvariantCached survives afterReverted — that's the whole point of EW-9.`

6. **Inside `recreatePreBeatGlyphs`** (line 889): same logic as step 4's branch. Defensive `this._layoutInvariantCached = false;` at top so any other caller (e.g. a future hook) also flips it.

### 4.4 What about `_computeBeamingBounds`?

`_computeBeamingBounds` is called from two paths:
- `LineBarRenderer.emitHelperSkyline` (line 999) — called from `BarRendererBase.scaleToWidth` (line 381). **Width-dependent caller; runs every cycle. NOT in the EW-9 skip.**
- `LineBarRenderer.calculateBeamingOverflows` (line 984) — called from `ScoreBarRenderer.calculateOverflows` (line 91 — via the `super.calculateOverflows` chain). **This IS inside the `calculateOverflows` skip.** So Phase 1's gate already captures this 2.9 ms / iter slice via the existing skip; no separate change needed.

`BeamingHelper.invalidateDrawingInfos()` is called from `scaleToWidth:373` unconditionally. The cache is rebuilt by `emitHelperSkyline` (still in the width-dependent path). The cache is therefore correct.

### 4.5 What about post-resize `applyLayoutingInfo`?

Called from `StaffSystem._applyLayoutAndUpdateWidth:579` and `reconcileMinDurationIfDirty:483`. These read from the broker. The broker is **unchanged** when the gate skips (§3.4 / §3.5). The pulled values are identical to last cycle. No change needed.

### 4.6 Expected outcome of Phase 1

- A/B at n=64 paired iterations on canon-resize-drag: median delta `≤ -7 ms` (best case `-12 to -15 ms`).
- vitest: **5-15 visual regressions expected**. This is the point. DO NOT REVERT.

Likely first-pass red tests:
- Tie-heavy fixtures in `visual-tests/notation-elements/` (Class A from §6).
- Multi-stave fixtures in `visual-tests/multivoice/` (potential Class B).
- Fixtures whose first frame is a non-default width followed by a re-layout to default (cache primed on width X then read on width Y where layout shifted unexpectedly).

### 4.7 Phase 1 exit checklist

- [ ] Patch is a single-file diff on `BarRendererBase.ts`, under ~25 lines added/changed.
- [ ] `npx vite build` in `packages/bench` succeeds.
- [ ] `node dist/run.mjs --only canon-resize-drag --trials 3 --label probe-EW9-naive --save-baseline probe-EW9-naive` completes.
- [ ] WIP commit: `perf(layout): EW-9 Phase 1 — naive max-skip in reLayout (WIP, visuals expected red)`. **Commit even though tests are red.** The commit boundary preserves bisect-ability when Phase 4 starts adding invalidation events.

---

## 5. Phase 2 — perf verify before fixing breakage

**Hard rule: do not begin Phase 3 until Phase 2 passes its decision rule.**

### 5.1 The A/B run

```bash
cd packages/bench
node scripts/build-ab.mjs --ref-a HEAD~1     # baseline ref = the commit before Phase 1 WIP commit
node dist/runAB.mjs --a dist/ab/A/runOneCore.mjs \
                    --b dist/ab/B/runOneCore.mjs \
                    --only canon-resize-drag \
                    --iterations 64 \
                    --label probe-EW9-phase1
```

`--ref-a` may need to be the explicit SHA of the pre-Phase-1 commit instead of `HEAD~1` depending on intermediate commits.

### 5.2 Decision rule

Read `runs/probe-EW9-phase1/REPORT.md` and check the `canon-resize-drag` row.

| Condition                                                | Action                                                                                   |
|----------------------------------------------------------|-----------------------------------------------------------------------------------------|
| **`★` AND median Δ ≤ -7.0 ms**                          | **PROCEED to Phase 3.** EW-9 thesis confirmed.                                          |
| `★` but median Δ in `(-7.0, -3.5)` ms                    | Marginal. Re-run with `--iterations 96` to tighten the CI. If still in `(-7.0, -3.5)`, narrow skip per §8 Variant A/B and re-measure. |
| `~` (CI overlaps 0 or `\|z\| < 2`)                       | Re-run with `--iterations 128`. If still `~`, **narrow** to Variant B (skip only `calculateOverflows`). |
| `·` (no significance)                                    | DR-1 thesis is wrong, OR the gate isn't actually firing. Verify gate fires (add a counter log in `reLayout`); if it does fire and there's no perf delta, STOP, write a falsification entry in HOTSPOTS.md EW-9, do not proceed to visual fixes. |
| `★` regression in any OTHER scenario                     | Phase 1 is broken in an unexpected way. Investigate before proceeding. (Tip: the most likely cause is that `nightwish-resize` or similar exercises a path the cache didn't anticipate — usually a re-layout via `doUpdateForBars` triggered by the model.) |

### 5.3 Anti-revert moment #1

If A/B shows `★` ≤ -7 ms, the win is real **and is not erased by visual failures**. Visual failures are a Phase 3+ problem. Move on. The temptation to revert because "it broke things" must be resisted.

### 5.4 Phase 2 exit checklist

- [ ] A/B report saved at `runs/probe-EW9-phase1/REPORT.md`.
- [ ] Median delta on canon-resize-drag documented.
- [ ] No other scenario showed `★` regression (run `--iterations 64` across `--only canon-resize-drag --only canon-resize --only nightwish-resize --only fade-to-black-resize` if uncertain).
- [ ] Decision recorded inline in the Phase 1 WIP commit message via `git commit --amend` OR a follow-up note commit (per AGENT_WORKFLOW.md §"Guardrails", separate code and doc commits).

---

## 6. Phase 3 — visual triage

### 6.1 Run vitest

```bash
cd packages/alphatab && npx vitest run
```

Expect 5-15 failing tests. Each failing test produces a diff PNG next to the reference under `test-data/visual-tests/...`. Open the diff (e.g. `xdg-open <path>.diff.png`) for each red test — do NOT just stare at the error stack.

**Do not run `npm run test-accept-reference`.** This would accept the broken diff PNGs as the new truth and quietly hide the regression. Hard rule. See §9.

### 6.2 Classification taxonomy

Each failing test falls into one of four classes. For each class: symptoms, root cause, fix.

#### Class A — tie / slur / overflow miscompute

**Symptoms in the diff PNG**:
- Slight vertical offset between notes and the staves above/below them.
- Tie arcs look correct in shape but the *space* above the bar is wrong (too tall, with whitespace).
- An effect band sits closer to or further from the staff than reference.
- Differential is concentrated at the top/bottom edges of the staff, in narrow horizontal bands.

**Root cause**: `_contentTopOverflow` / `_contentBottomOverflow` are monotonic-max accumulators (lines 303-318 `registerOverflowTop/Bottom`). When the previous resize cycle's tie was taller (e.g. wide system, flat tie still registered some overflow), the cached value is bigger than the current cycle requires. The skipped `calculateOverflows` would normally reset and re-emit at line 643-680 — but reading the code at line 663 (`if (contentMinY < 0) this.registerOverflowTop(contentMinY * -1);`) it still uses `registerOverflowTop` which is max-of. So even **without** the skip, this is monotonic in a single render — except `calculateOverflows` is called freshly each reLayout, and the renderer is freshly added to a staff after `afterReverted` reset `staff = undefined` (but did NOT reset `_contentTopOverflow`).

Wait — re-reading: `_contentTopOverflow` / `_contentBottomOverflow` are not reset by `afterReverted` (lines 460-464). They ARE reset by... nothing. They only grow. So the cache is already in a degenerate state across resizes today, and `calculateOverflows` is the only thing that could lower them (but it can't — `registerOverflowTop` only grows). So actually `_contentTopOverflow` is already monotonic max-of across the entire history of the renderer. The skip doesn't change this.

**Re-classification**: Class A is more subtle. The actual symptom is likely that `preBeatLocalSkyline` / `postBeatLocalSkyline` are not reset at the right point. `calculateOverflows:648-649` does `this.preBeatLocalSkyline.reset(); this.postBeatLocalSkyline.reset();`. The skip prevents this reset. **The cached skylines therefore survive across resizes** — which is the intended behaviour, but if any downstream consumer expects the skyline state to be re-emitted afresh (e.g. because it inserted segments not via this path), the cache will hold stale segments.

**Fix for Class A**:
- Approach 1 (minimal): leave the skylines cached, just call `.reset()` and re-emit if a Class A symptom appears.
- Approach 2 (smarter): verify that NO other call site inserts into `preBeatLocalSkyline` / `postBeatLocalSkyline` outside `calculateOverflows`. (Search: `grep -rn "preBeatLocalSkyline\|postBeatLocalSkyline" packages/alphatab/src` — should return only the lazy getters in `BarRendererBase.ts` and the `_unionBarLocalIntoStaffSkyline` reader in `RenderStaff.ts:236-247`.) If only `calculateOverflows` writes them, the cache is provably stable.

**Hold-the-line directive**: when a Class A failure appears, the fix is NEVER "stop skipping calculateOverflows". The fix is either to ensure `_contentTopOverflow`/`_contentBottomOverflow` is reset to 0 at the head of `reLayout` (before the gate), OR to add a narrow re-emit path that runs even when the cache is valid.

#### Class B — pre/post-beat glyph spacing wrong on multi-stave systems

**Symptoms in the diff PNG**:
- Notes in stave B are at different x positions than reference, but stave A looks fine.
- The first-bar-of-system clef/keysig block is wider in stave A than stave B (or vice versa).
- Visible only in fixtures with ≥ 2 staves (Score+Tab on guitar, multi-staff piano fixtures).

**Root cause**: the shared `BarLayoutingInfo` broker's `preBeatSize`/`postBeatSize` were established with all staves contributing on cycle 1. On cycle 2+, if stave A skips (cached) but stave B doesn't (e.g. because B's `wasFirstOfStaff` flipped and invalidated B's cache), B's `_registerLayoutingInfo` runs alone and writes (effectively) the max of B's own contribution — but the existing values from cycle 1 are still in the broker via max-of, so this is actually fine *unless* stave A's contribution **shrank** between cycles (which it won't — `_preBeatGlyphs.width` is determined by glyph composition, invariant per `bar`).

**Real failure mode**: stave A's cache is for one `wasFirstOfStaff` value, stave B's cache is for the other. If staff repositioning during re-pack lands stave A as first-of-staff but on cycle 1 stave A was NOT first-of-staff, A's cache holds the non-first version (no clef/keysig), but A is now first-of-staff and needs the wide pre-beat block. The `recreatePreBeatGlyphs` branch in `reLayout:881` catches this and invalidates the cache — but only if `wasFirstOfStaff !== isFirstOfStaff`. Verify the branch fires correctly.

**Fix for Class B**:
- Approach 1 (verify): instrument `reLayout` to log when the `wasFirstOfStaff` branch fires. Compare against expected resize behaviour. If the branch fires correctly, the issue is elsewhere.
- Approach 2 (per-MasterBarsRenderers gate): if cross-stave drift is real, change `_layoutInvariantCached` to live on `MasterBarsRenderers` (the broker owner) instead of `BarRendererBase`. All renderers of a masterbar invalidate together. This trades a small additional skip cost (every renderer redoes work even when only one's `wasFirstOfStaff` flipped) for a stronger correctness guarantee.

**Hold-the-line directive**: do NOT abandon per-renderer caching at the first Class B failure. Verify the `wasFirstOfStaff` invalidation actually fires.

#### Class C — beam endpoint y-coords drift

**Symptoms in the diff PNG**:
- Beams (the bars connecting eighth/sixteenth notes) tilt slightly differently from reference.
- Stem extensions to beams are too short or too long by 1-2 px.
- Visible mostly in fixtures with long beam groups (`canon`, `nightwish` first system).

**Root cause**: `_computeBeamingBounds` reads beat x positions via `getBeatX` which calls into `voiceContainer.getBeatX → beatContainer.x + beatContainer.getBeatX`. The `beatContainer.x` was set by `_scaleToForce` (width-dependent, always runs). But `_computeBeamingBounds` is called from `calculateBeamingOverflows` (via `ScoreBarRenderer.calculateOverflows`), which the skip prevents. So the **OVERFLOW IMPACT** of beam endpoints is what's stale, not the beam paint position. The paint reads from `BeamingHelperDrawInfo` which IS rebuilt by `emitHelperSkyline` (called from `scaleToWidth`, unconditional). So the paint is correct; the overflow registration from the *beam* is what's missed.

**Fix for Class C**:
- Approach 1 (minimal): explicitly call `calculateBeamingOverflows(0, this.height)` from the skipped branch when there are beam helpers. Cost: one extra walk over beam helpers per cycle, ~0.5 ms.
- Approach 2 (lift): move `calculateBeamingOverflows` outside the gate — always run.

**Hold-the-line directive**: this is the smallest fix in the catalogue. Don't over-engineer it.

#### Class D — anything not covered above

**Symptoms**: anything else. Examples that might appear:
- Effect band paddings are wrong (sustain, vibrato, dynamics).
- Time signature alignment between adjacent bars looks off.
- A glyph appears at a different y position than reference (not just paddings).

**Process**:
1. Identify what state the diff implies is stale.
2. Trace which call site writes that state.
3. Determine whether the skip prevents that write.
4. Add a targeted invalidation event or move that write outside the gate.
5. **Never** widen the skip wholesale; never accept the diff PNG; never revert Phase 1.

### 6.3 Phase 3 exit checklist

- [ ] Every red test classified A / B / C / D in a working notes file (`runs/EW9-phase3-classifications.md`).
- [ ] Class breakdown counted: e.g. "A: 3 tests, B: 0 tests, C: 5 tests, D: 2 tests".
- [ ] First fix attempt sketched per class (cheapest class first).

---

## 7. Phase 4 — iterative fix loop

### 7.1 Loop body

For each red test:

1. **Classify** per Phase 3.
2. **Add the targeted invalidation event** or out-of-gate write per the class's fix recipe.
3. **Re-run that single failing test**:
   ```bash
   cd packages/alphatab && npx vitest run -t "<test name fragment>"
   ```
4. **Verify the diff PNG resolves** (test passes). If it doesn't, the class diagnosis was wrong — go back to step 1 with a fresh trace.
5. **Re-run A/B every 3-5 fixes** at n=64 on canon-resize-drag to confirm the cumulative invalidation cost hasn't eaten the perf delta:
   ```bash
   node dist/runAB.mjs --a dist/ab/A/runOneCore.mjs \
                       --b dist/ab/B/runOneCore.mjs \
                       --only canon-resize-drag \
                       --iterations 64 \
                       --label probe-EW9-fix-$(date +%s)
   ```
6. **Targeted invalidation budget**: each individual invalidation event should cost ≤ 0.5 ms / iter. If the cumulative cost erodes the Phase 2 win by more than ~30 %, the invalidation is too broad — see §7.3.
7. **Commit each fix as a separate commit** with a body that names the class and the failing test. Examples:
   - `fix(layout): EW-9 Class A — reset _preBeatLocalSkyline at reLayout head`
   - `fix(layout): EW-9 Class C — always run calculateBeamingOverflows`
   This makes bisect possible if a later perf regression surfaces.

### 7.2 Iteration cap

If after **10 iterations** vitest is still red OR the A/B has fallen below σ on canon-resize-drag:

- **STOP** the per-test loop.
- Move to Phase 5 fallback (§8).

### 7.3 Perf erosion budget

| Phase 2 win | Erosion limit (30 %) | Stop threshold        |
|-------------|----------------------|----------------------|
| -7 ms       | 2.1 ms cumulative cost | win drops below -5 ms ⇒ Phase 5 Variant C |
| -10 ms      | 3 ms                 | drops below -7 ms ⇒ Phase 5 |
| -14 ms      | 4.2 ms               | drops below -10 ms ⇒ Phase 5 |

Phase 5 is **not failure** — it's the engineering response to "the cache shape was too broad for the invalidation cost". Document and ship the narrower variant.

### 7.4 Phase 4 exit checklist

- [ ] vitest 1599/1599.
- [ ] A/B re-measured at n=64 still shows `★` with median delta ≥ -5 ms (≥ ~2σ).
- [ ] No other scenario shows `★` regression.
- [ ] Code committed as a series of small commits, each with a one-line body explaining the class.
- [ ] HOTSPOTS.md updated: move EW-9 to "Easy wins — landed" with the median delta and any caveats.

---

## 8. Phase 5 — fallback (only if Phase 4 hits the cap)

Three narrowed variants. Each is a smaller scope than Phase 1's max-skip.

### 8.1 Variant A — skip only `_computeBeamingBounds`

- **What it does**: leave `_registerLayoutingInfo` + `calculateOverflows` running in full. Only gate the beam-bounds computation. Implementation: add a cached `BeamingBounds` snapshot per helper-direction, invalidate on `scaleToWidth` (because beam endpoints are post-spring x-dependent — which means actually this variant doesn't save much because the cache invalidates every cycle).
- **Expected delta**: ~3 ms / iter (the 2.9 ms beam frame). **Below the ≥ 7 ms σ threshold** — this variant is probably not worth shipping on its own. List anyway.
- **Risk**: low. The smallest scope.

### 8.2 Variant B — skip only `calculateOverflows` + `_emitGroupOverflows`

- **What it does**: leave `_registerLayoutingInfo` running every cycle (writes to shared broker — safe). Only skip the pre/post-beat group overflow walk, which is the bar-local skyline + content overflow walk.
- **Expected delta**: ~5.5 ms / iter (the 1.33 % calculateOverflows + 1.00 % _emitGroupOverflows + ~1 ms _computeBeamingBounds via the same `super.calculateOverflows` chain in ScoreBarRenderer). **Borderline `★`** at ~2σ. Could resolve at `--iterations 96+`.
- **Risk**: medium. Pre/post-beat skylines stale, similar to Class A. Same invalidation event recipe.

### 8.3 Variant C — cache only `_registerLayoutingInfo` results, keep overflow re-run

- **What it does**: keep `calculateOverflows` running (eliminates Class A/C risk), only skip the `_registerLayoutingInfo` call (`MultiVoiceContainerGlyph.registerLayoutingInfo` — the 7.0 ms hotspot).
- **Expected delta**: ~7 ms / iter. **At the σ threshold.**
- **Risk**: medium. The broker accumulation is the strongest cross-stave invariant; skipping it is the riskiest part of Phase 1, isolated here.
- **Most likely "ship" candidate if Phase 4 caps out**: this variant captures the largest single hotspot in the area and has the smallest blast radius for failure modes.

### 8.4 Variant selection

If Phase 4 caps after, say, 5 of 15 red tests resolved: pick the variant whose narrowed scope **excludes the call site causing the remaining 10 red tests' class**.

| Most red tests classified as | Pick      | Reason |
|------------------------------|-----------|--------|
| Class A (overflow/skyline)   | Variant C | C skips `_registerLayoutingInfo` but keeps `calculateOverflows`/overflow walk |
| Class B (cross-stave)        | (none of A/B/C help; the broker is the issue) — drop EW-9 to "demoted, broker not safely cacheable per-stave" |
| Class C (beam endpoints)     | Variant B | B skips overflow walk but not the broker; beam recompute still runs via emitHelperSkyline |
| Class D (mixed)              | Variant C | most conservative |

Document the chosen variant under EW-9 in HOTSPOTS.md with the median delta and the failing-test classes that drove the narrowing.

---

## 9. Anti-revert directives — read this twice

These are the hard rules the executor must follow. They exist because the natural reaction to a red vitest after Phase 1 is to revert; that reaction is wrong for EW-9.

> **DO NOT** run `npm run test-accept-reference`. That would accept the broken diff PNGs as the new reference and silently ship a visual regression. The whole point of EW-9 is to *fix* the diffs by adding invalidation, not to redefine what's correct.

> **DO NOT** revert the Phase 1 patch on the first red vitest. Expect 5-15 visual failures initially. They are diagnostic information, not failure signals. The plan in §6 tells you what to do with each class.

> **DO NOT** abandon EW-9 without first dropping to a narrower Phase 5 variant. The candidate has ~14 ms of width-invariant work backing it — empirically established. A complete revert leaves that win on the table.

> **DO NOT** widen the skip to cover a Class D failure. Class D's recipe is *add a targeted invalidation event*, never *expand the skipped region*.

> **DO** commit work-in-progress at each successful fix step. Separate commits per fix, each with a one-line class label. Bisect-friendly.

> **DO** re-run A/B at n=64 every 3-5 fixes. If the win has eroded by > 30 % from Phase 2's number, an invalidation event is too broad. Investigate that event before adding more.

> **DO** treat the Phase 4 iteration cap (10 iterations) as a real ceiling. If you hit it, the cache shape is wrong for this codebase — drop to Phase 5, don't keep grinding.

> **DO** record falsification in HOTSPOTS.md if Phase 2 shows no perf delta. That's a real round result; demote EW-9 to the "Demoted" section and explain why.

---

## 10. Definition of done

EW-9 is shippable when **all four** of these hold simultaneously, in the same session, with no manual interpretation of "close enough":

1. **vitest 1599/1599** in `packages/alphatab`. Zero diff PNGs, zero `npm run test-accept-reference` invocations in the history of this work.
2. **A/B `★` on canon-resize-drag at n=64**, median Δ **≤ -5 ms** (≥ ~2σ). Phase 2's target was -7 ms; -5 ms after invalidation costs is the floor.
3. **No `★` regression in the 5-trial multi-process diff** against the `bcc5ed19`-era baseline (or whatever `feature/perf` HEAD baseline existed at the start of EW-9 work). Run:
   ```bash
   cd packages/bench
   node dist/run.mjs --trials 5 --label EW9-post-$(date +%s) --save-baseline EW9-post
   node dist/cli.mjs diff baselines/resize-drag.json baselines/EW9-post.json
   ```
   Every non-target scenario must be `·` / `~` / `★ improvement`. No `★ regression`.
4. **HOTSPOTS.md updated**: move EW-9 from "Open" to "Landed" table with median delta, commit SHA, and a short note on which invalidation events were added (one bullet per Class A/B/C/D fix encountered).

---

## 11. Estimated effort

| Phase | Wall-clock estimate | Notes                                                                                       |
|-------|---------------------|---------------------------------------------------------------------------------------------|
| 1     | 20-30 min           | Single-file diff. Mostly mechanical.                                                       |
| 2     | 10-15 min build + 5-8 min A/B run | A/B at n=64 on one scenario.                                                              |
| 3     | 20-40 min           | Reading diff PNGs + classifying. Larger if > 10 reds.                                       |
| 4     | 60-180 min          | Per-class fix loop. Iteration cap is 10, ~10 min per iteration including A/B re-runs.        |
| 5     | 30-60 min if invoked| Variant selection + re-measure.                                                             |
| Total | **2-4 hours**       | Phases 1-3 fit in one session (~1 hour). Phase 4 may need 2-3 sessions if visual classes are diverse. Phase 5 only if Phase 4 caps. |

A reasonable session boundary: end of Phase 3 (classification done, fix recipes drafted). Next session: Phase 4 loop. This keeps the executor from context-switching mid-fix.

---

## 12. Supporting evidence (cite, don't quote)

- `subagent-layout-walk.md` (this directory): primary background. Establishes width-invariance, the 14 ms aggregate, the call chain trace.
- `subagent-beam.md` (this directory): independently confirms BeamingHelper state is width-invariant; quantifies `_computeBeamingBounds` 2.9 ms and `registerLayoutingInfo` 7.0 ms.
- `README.md` (this directory): round overview. canon-resize-drag baseline 235.30 ms ± 3.48 ms.
- HOTSPOTS.md entries EW-9 + DR-1: candidate framing. DR-1's "full content-version cache" is the structural endgame; EW-9 is its smallest patch shape.
- `AGENT_WORKFLOW.md` §"Guardrails": no `test-accept-reference`, separate code/doc commits, no bundling unrelated refactors. The visual-tests-are-sacred rule is **explicitly inverted for EW-9 in §9 above** — diffs are diagnostic; the sacred rule (never accept a diff) still holds.
- HOTSPOTS.md "Demoted": EW-2(b), EW-3 micro-devirt, EW-5 rectangular `<path>`. Read these before proposing any alternate framing — they are the precedents for what doesn't work.

---

## 13. Common failure modes the executor will encounter

Concrete vignettes drawn from the call-chain inspection. Read these as "if you see X in your diff, that's almost certainly Y" hints — they save a fresh trace.

### 13.1 "Tie arcs flat but staff above looks pushed up"

**Likely**: Class A. `_contentTopOverflow` cached at a value from a previous resize when the tie arc was taller. The reLayout body that would normally call `calculateOverflows` → `voiceContainer.getBoundingBoxTop()` to recompute the top extent is skipped, so the cached `_contentTopOverflow` from the *first* cycle is still in effect.

**Quick check**: search the diff for whitespace above the staff line. If horizontal padding looks fine but vertical does not, this is it.

**Fix**: at the top of `reLayout`, after `this.topEffects.height = 0; this.bottomEffects.height = 0;` and BEFORE the gate, also do `this._contentTopOverflow = 0; this._contentBottomOverflow = 0;`. The downstream re-population (effect bands, tie finalization) will re-emit correct values via the always-runs path.

**Trap**: do NOT reset `_contentTopOverflow` after the gate skip — it must be reset *before* anything that registers overflow runs, including the `voiceContainer.getBoundingBoxTop()` writes the gate would have done.

### 13.2 "First system looks correct but second system bars are misaligned"

**Likely**: Class B (cross-stave) OR Class D (system packing not stable).

**Quick check**: do the bar lines line up between staves of the same system? If yes (staves agree but systems disagree), this is system packing — outside EW-9's gate, almost certainly noise from re-pack non-determinism. If no (staves of system 2 disagree with each other), it's the broker.

**Fix for the broker case**: lift `_layoutInvariantCached` from `BarRendererBase` onto `MasterBarsRenderers` (which already owns `layoutingInfo`). All renderers of a masterbar invalidate together.

### 13.3 "Beam tilts the wrong way on the last beat of a beam group"

**Likely**: Class C. `_computeBeamingBounds` was skipped, the stored beam endpoints are still from a previous force value. Paint reads from `BeamingHelperDrawInfo` which IS rebuilt by `emitHelperSkyline` — but the *overflow registration* the beam contributes (via `calculateBeamingOverflows`) was skipped, so the staff space above the beam is wrong.

**Quick check**: is the beam itself drawn at the wrong y, or is the *space above* the beam wrong? If the beam looks correct relative to its notes but a tuplet bracket above it overlaps a slur it shouldn't, that's `calculateBeamingOverflows` not running.

**Fix**: in `ScoreBarRenderer.calculateOverflows`, ensure `calculateBeamingOverflows` runs even if the rest is skipped. Cheapest: pull `calculateBeamingOverflows` out of `ScoreBarRenderer.calculateOverflows` and call it from `scaleToWidth`'s body (which is unconditional). Cost: ~0.5 ms / iter on canon-resize-drag.

### 13.4 "Effect band sits at y=0 instead of above the staff"

**Likely**: `topEffects.height` reset wasn't preserved. The gate is too aggressive: it skipped past `this.topEffects.height = 0` at lines 875-876.

**Quick check**: open `BarRendererBase.ts:874-886`. Verify lines 875-876 (the `height = 0` resets) and line 877 (`updateSizes`) are OUTSIDE the gate.

**Fix**: move the gate to start at line 885 (`_registerLayoutingInfo`) and end at line 886 (`calculateOverflows`). Nothing before line 885 should be gated.

### 13.5 "vitest is green but A/B shows no delta"

**Likely**: the gate is structurally correct but isn't actually firing. Possible causes:
- `_layoutInvariantCached` is set to true at the wrong moment (e.g. mistakenly inside `reLayout` even when invalidation should have fired).
- `wasFirstOfStaff` invalidation is firing on every cycle because of an unrelated change to staff layout.
- The renderer cache is getting reset by something not in the catalogue (Class D, find it).

**Quick check**: add a counter — `private static _skipCount = 0; private static _runCount = 0;` — increment from the gate. Log at end of `driveOnce`. If `_skipCount` is 0, the gate isn't firing. If `_skipCount` is high but A/B shows no delta, the skip itself is too small — drop to Variant C (skip only `registerLayoutingInfo`).

### 13.6 "Phase 2 A/B showed `★` but the post-Phase-4 re-measure shows `·`"

**Likely**: invalidation events added in Phase 4 cumulatively erased the win. This is exactly the budget §7.3 warns about.

**Process**:
1. Read the commit log in reverse: which 3 commits added invalidation hooks?
2. For each: how big is the invalidation hook's cost? (Add a Profiler timer around the hook's body for one A/B run.)
3. Identify the most expensive hook. If it's > 1 ms, simplify it (narrower scope, less work in the hook body) or move the work into the gate's unconditional pre-amble (paid once per cycle regardless of cache state).

---

## 14. Quick reference card

For the executor mid-Phase-4 who needs the decision tree in one screen:

```
red vitest? → diff PNG visible? → which class?
  Class A (tie/overflow): reset _contentTopOverflow/_contentBottomOverflow at reLayout head, OR
                          force pre/postBeatLocalSkyline.reset()+re-emit even when cache valid
  Class B (cross-stave):  move _layoutInvariantCached to MasterBarsRenderers
  Class C (beam):         lift calculateBeamingOverflows out of the gate (or call from ScoreBarRenderer override)
  Class D (other):        trace mutation → add targeted invalidateLayoutCache() call

After every 3-5 fixes:
  cd packages/bench && node dist/runAB.mjs ... --iterations 64
  if median Δ has eroded > 30% from Phase 2: investigate last 3 fixes for over-broad invalidation

10 iterations without green vitest? → Phase 5 (§8). Pick variant per the table in §8.4.

Never:
  - npm run test-accept-reference
  - git revert the Phase 1 commit
  - widen the skip to "fix" a Class D
```

---

## 15. Execution outcome — 2026-06-14

**Result**: shipped as **Variant B** (calculateOverflows-only skip). Commits
`63e1afef` (Phase 1 naive max-skip, kept as bisect anchor) +
`bfcd943f` (Variant B narrowing).

**A/B at n=64 (probe-EW9-phase1 vs probe-EW9-variantB)**:
- Phase 1 max-skip: `★` Δ=-10.46 ms CI [-13.50, -6.13] z=5.25 — **but
  7 visual regressions** (`sustain-pedal`, `sustain-pedal-alphatex`,
  `multi-system-slur-scale-down`, `multi-system-slur-scale-up`,
  `resize-sequence`, `grace-resize`, `whammy-resize-wrap`).
- Variant B (calculateOverflows-only): `★` Δ=-9.69 ms CI [-12.06, -4.91]
  z=6.50, 58/64 wins. **vitest 1599/1599.** Multi-process diff at 5/5
  trials vs `bb8ad4fb`: no `★` regression on any other scenario.

**Falsified assumption (plan §3.4)**: "broker state persists across
resize cycles". `StaffSystem.addMasterBarRenderers:293` explicitly
resets `renderers.layoutingInfo.preBeatSize = 0` at the head of every
resize cycle. With Phase 1 skipping `_registerLayoutingInfo`, the
broker read 0 and the bar collapsed (most dramatic: 23 bars stacked
at x=0 in `multi-system-slur-scale-up`). The reset is invisible from
`BarRendererBase` — it lives one layer up in the system entry path.

**Why Variant B works**: leaving `_registerLayoutingInfo` always-on
re-populates `preBeatSize` after the reset, costing the 7 ms broker
write back. The remaining ~5.5-9.7 ms win comes from gating
`calculateOverflows` + the beam-overflow chain via
`ScoreBarRenderer.calculateOverflows`. The cache holds across resize
cycles because the overflow accumulators (`_contentTopOverflow`,
`_contentBottomOverflow`) and the pre/postBeatLocalSkylines are
monotonic max-of and were already correct across cycles pre-EW-9.

**Remaining DR-1 slice**: the 7 ms `MultiVoiceContainerGlyph
.registerLayoutingInfo` hotspot is still un-captured. Capturing it
requires either lifting the `preBeatSize = 0` reset out of
`addMasterBarRenderers` (per-MasterBarsRenderers invalidation gate)
or restructuring the broker lifecycle. Documented in HOTSPOTS.md
DR-1 as the remaining open sub-task.

**Plan critique**: the catalogue in §3 missed `addMasterBarRenderers`
:293 as an invalidation event. Future EW-style plans against this
codebase should grep for explicit `<broker>.field = 0` resets at
system-level entry points before assuming broker persistence.

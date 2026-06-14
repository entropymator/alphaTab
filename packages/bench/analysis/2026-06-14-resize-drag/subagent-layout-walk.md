# Layout-walk / width-only re-walking (DR-1) — canon-resize-drag

Baseline 235.30 ms / iter; σ-floor 2.35 ms (1 %). 12 width changes / driveOnce ⇒ ~19.6 ms per resize, in line with canon-resize's 22.7 ms/resize (4 widths). Same physics, more samples.

## What actually re-runs per width change

`ScoreRenderer.resizeRender` → `ScoreLayout.resize` → `VerticalLayoutBase.doResize` → `_resizeAndRenderScore`. With `barsPerRowActive=false` (canon), the code path is:

1. **For every bar renderer in the score**: `afterReverted()` (resets `isFinalized`, `staff=undefined`).
2. Then re-pack: `createEmptyStaffSystem` ⇒ `addMasterBarRenderers` ⇒ `RenderStaff.addBarRenderer` ⇒ **`renderer.reLayout()`** for every bar.
3. `reLayout` calls `updateSizes`, conditionally `recreatePreBeatGlyphs`, then **`_registerLayoutingInfo()`** (calls `MultiVoiceContainerGlyph.registerLayoutingInfo` per bar — top-30 hit #4, 2.99 %) and **`calculateOverflows(0, height)`** (top-30 #18, 1.33 %; calls `_emitGroupOverflows` — top-30 #26, 1.00 %).
4. `_fitSystem` ⇒ `_scaleToWidth` ⇒ for every bar: `renderer.scaleToWidth(w)` ⇒ `voiceContainer.scaleToWidth` ⇒ `MultiVoiceContainerGlyph._scaleToForce(force, emit=true)` (top-30 #12, 1.72 %) which re-emits the bar-local skyline via `_emitBeatContainerSkyline` ⇒ `Skyline.insertPlaced` (the `_raiseRange` 3.42 % / `unionShifted3` 2.37 % / `_splitAt` 0.90 % / `_initBaseline` work).
5. Per system: `system.buildBoundingsLookup` then `_paintSystem` registers a partial that walks every glyph.

## Width-invariant work being re-run

The user's hypothesis is correct, but it has two distinct sub-buckets, only one of which is fully invariant:

**(A) Truly width-invariant (re-running needlessly):**
- `MultiVoiceContainerGlyph.registerLayoutingInfo` (2.99 % = ~7.0 ms / iter, 0.59 ms / resize) — walks every beat container to publish `preBeatSize/postBeatSize/onTimeX` into the bar-local `BarLayoutingInfo`. **The published values are bar-local; they don't change when the system's width changes**. The broker state is rebuilt every reLayout despite being deterministic from `bar` content alone.
- `calculateOverflows` + `_emitGroupOverflows` (2.33 % = ~5.5 ms) — pre/post-beat glyph bbox is bar-local. Only the post-beat group's absolute x changes per width, but `_emitGroupOverflows` only inserts into `pre/postBeatLocalSkyline` using local x — these skylines are width-invariant. The whole `calculateOverflows` call on `reLayout` is redundant after the first layout pass.

**(S/I) Width-dependent (must re-run):**
- `_scaleToForce(force=spaceToForce(width), emit=true)` — force is a function of available width, positions and spring stretch change every resize. **Intrinsic**.
- `Skyline.unionShifted3` / `_raiseRange` / `_initBaseline` — system skyline union runs every resize because per-bar local skylines get shifted by per-bar x (which changes). EW-1 already collapsed 6→2 union calls; further reduction is **structural** (DR-2 territory).
- `buildBoundingsLookup` (1.64 %) — pixel coords depend on packing; demoted under EW-2.

## (A) candidates — algorithmic, with realistic bound

### A1. Skip `_registerLayoutingInfo` + `calculateOverflows` in `reLayout` when bar content unchanged
- **Cost source**: every bar's `MultiVoiceContainerGlyph.registerLayoutingInfo` (writes 4-6 numeric fields per beat into the shared broker) + every glyph in pre/post groups walked by `_emitGroupOverflows`.
- **Call count**: canon has ~40 visible bars × 3-staff system; resize-drag re-walks all of them × 12 widths.
- **What a fix removes**: the body of `BarRendererBase.reLayout` after `updateSizes()` — call `_registerLayoutingInfo()` and `calculateOverflows()` only on first layout (or when `wasFirstOfStaff` changed, which already gates `recreatePreBeatGlyphs`). The `BarLayoutingInfo` broker is reused per `MasterBarsRenderers` across resize cycles; its values are bar-local.
- **Risk**: the per-bar `BarLayoutingInfo` is shared across the bar's staves; if any single staff's pre/postBeatSize *did* change between resizes (it shouldn't — they're glyph metrics, not spring positions), the broker's `max-of` discipline would carry stale values. Need to verify `preBeatSize/postBeatSize/onTimeX` are functions of `Bar` only, not `width`.
- **Upper bound on canon-resize-drag**: 2.99 % + 1.33 % + 1.00 % = 5.32 % CPU self = ~12.5 ms. After accounting for downstream `_emitGroupOverflows` callers it may scale to ~15 ms. **Clears σ-floor (>5×)**.

### A2. Memoize `MultiVoiceContainerGlyph._scaleToForce` "positioning" output by `force`
- **Cost source**: `layoutingInfo.buildOnTimePositions(force)` rebuilds a `Map<int,number>` of beat-start → x for every bar per resize; force may collide across nearby widths in a drag (12 widths step ~100 px apart, force values likely distinct, but `force` is bucketed by `spaceToForce` — could collide).
- **Call count × cost**: ~120 calls × ~0.14 ms = ~17 ms (1.72 % self + downstream).
- **What a fix removes**: redundant Map construction if `force` matches a prior call on the same bar.
- **Realistic bound**: depends on `force` collision rate across the 12 widths. In a true drag (close adjacent widths) collisions are plausible at the bucket level. Conservative estimate: 20-30 % hit rate × 17 ms = **~3-5 ms** (above σ-floor but small).
- **Risk**: medium — Map identity is consumed by `_scaleToForce`, mutating cached value would corrupt the next call. Needs an immutable view or `force`-keyed lazy table.

### A3. Trim `afterReverted` → re-pack → `reLayout` work for systems whose composition didn't change
- **Cost source**: when widths within `[800, 1200]` slot the same bars into the same systems, the entire `_systems = []; createEmptyStaffSystem(...); addBarRenderer(...)` cascade rebuilds identical system membership; only `_scaleToWidth` would have to run.
- **Call count**: drag widths in this baseline cycle in/out of the `~1200` range; canon at width 1300 vs 1200 may pack identically.
- **What a fix removes**: `RenderStaff` construction, `addBarRenderer × N`, all the `reLayout`/`registerLayoutingInfo`/`calculateOverflows` work — i.e. items A1 plus the staff-system rebuild overhead (`createEmptyStaffSystem` 280 kB heap, ~5 % of allocs).
- **Realistic bound**: hard to bound without measuring system-membership stability across the 12 drag widths. Could be 30-50 % of resizes ⇒ 5-10 ms / iter. **Clears σ-floor** if membership stability is ≥ 25 %.
- **Risk**: high — requires a "same packing" signature (bars per system × widths in/out). Folds into A1 if implemented as "skip reLayout on identical bar membership".

## (S) candidates — structural sketch

### S1. Per-bar layout cache keyed by bar content version
DR-1 in HOTSPOTS.md. The cleanest expression: tag each `BarRendererBase` with a `bar.contentVersion`; on resize, skip the entire `reLayout` chain when the version matches the cache and only run `_scaleToWidth` + `_paintSystem`. Combined with A3, system packing becomes the only width-sensitive layout work outside `Skyline.union`. Risk: high — `applyLayoutingInfo` post-layout still mutates child `.y` (DR-5 lifecycle note), so the cache must be invalidated by tie-finalize, voice-merge, and effect-band placement. Payoff: 8-15 ms / iter (4-7 % of canon-resize-drag). The largest single lever the codebase has.

### S2. Push-based skyline (DR-5 alternative)
Maintain running min/max y per renderer at glyph-add time so `calculateOverflows`'s tree walk vanishes. Folds 1.33 % + 1.00 % + the `getBoundingBoxTop` chain (1.09 % + 0.94 % = 2 %) into ~zero. Payoff: 5-8 ms / iter. Documented under DR-5 already.

## Verdict on DR-1's core question

Fraction of canon-resize-drag wall-clock that is invariant-under-width-only work being re-run per width change: a defensible lower bound is **~5-7 % (12-16 ms / iter)** from items A1+A2; an aggressive bound including S1 reaches **~10-15 %**. A1 alone clears the σ-floor decisively. The remaining ~85 % is genuinely width-dependent (force-based positioning, system packing, skyline union shift, paint markup generation) and falls under DR-2/DR-3/intrinsic.

## Sources
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/ScoreRenderer.ts:179
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts:140, 281-350, 406-418, 429-470
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/staves/StaffSystem.ts:288, 460-511
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/staves/RenderStaff.ts:132
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/BarRendererBase.ts:362, 442, 460, 479, 611, 643, 683, 874
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts:58, 64, 200, 208

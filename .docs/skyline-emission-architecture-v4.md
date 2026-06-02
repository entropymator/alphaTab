# Bar-renderer lifecycle audit and target architecture — v4

> **Status.** Implementation-sign-off iteration, responding to [v3 review](./skyline-emission-architecture-v3-review.md). The review identified 5 Critical findings, 7 Significant findings, 10 items v3 missed, and 5 Minor findings. v4 closes all five Criticals, addresses every Significant, incorporates the missed items into §B/§C/§E, and fixes Minors that pay for themselves.

> v4 is the **single source of truth** for the migration. It does not reference v3 by section number for any load-bearing claim; it rewrites what v3 had right, fixes what v3 had wrong, and is readable cold. v1 (`skyline-emission-architecture-v1.md`) and v2 (`skyline-emission-architecture.md`) are historical only. Investigations remain authoritative: [`beam-helper-drawinginfos.md`](./investigations/beam-helper-drawinginfos.md), [`scale-to-force-multi-call.md`](./investigations/scale-to-force-multi-call.md), [`reconcile-min-duration.md`](./investigations/reconcile-min-duration.md).

> **File refs.** `[file.ts:NNN](packages/...)`.

---

## TL;DR

Today, bar layout is a sequence of partial passes; each pass finalizes a slightly different subset of state, later passes re-mutate values an earlier pass had "set," and glyphs work around this by capturing reads at the wrong time and re-reading later through `getBoundingBox*` — turning bbox into a covert dynamic-state oracle.

v4's target architecture has five named phases (Build → Intrinsic → CoordinateAssemble → CoordinateReconcile → Spaced → Finalized → SystemFinalize), each with an immutable contract over a precise set of fields. The migration is 18 steps in a published DAG, of which 5 are landmark restructures (Steps 8b, 10, 11, 12, 13) and the rest are local cleanups.

The four structural changes from v3 that this iteration commits to:

1. **Skyline emission is Phase 3, not Phase 2.** Today's `scaleToWidth` does positioning AND emission in one body. v4 splits it: position computation moves to Phase 2 (Spaced), every `barLocalSkyline` insert moves to Phase 3 (Finalized). The Phase-2-only assertion is grep-checkable: zero `insertSkylineTop` / `insertSkylineBottom` / `barLocalSkyline.insert*` calls reachable from `spacedLayout()`.
2. **SystemFinalize is a four-substep ordering, not a single bag.** The order is: (i) per-renderer finalize-minus-ties → (ii) per-renderer tie writes → (iii) per-renderer union into staff skyline → (iv) `placeAndApply`. Step 12 pins this; v3 left it ambiguous and would have re-introduced the v2 Critical 3 attribution break.
3. **Step 11 (LayoutCycle substate) explicitly includes `_preBeatGlyphs`.** Without it, Step 10's "discard pre-beat group, recreate on resize" cannot be expressed as a substate reassign — it falls back to the today-pattern `this._preBeatGlyphs = new LeftToRightLayoutingGlyphGroup()` wholesale-reassignment. v4 makes the substate boundary cover the pre-beat group and `_ties`, with an explicit "what survives resize" matrix.
4. **`GroupedEffectGlyph` cross-renderer end-X is computed via `nextGlyph` chain traversal, not by reading a foreign `endBeat`.** v3 misdescribed the mechanism. The correct fix: at SystemFinalize, walk `isLinkedWithNext` to the chain tail, then use `lastLinkedGlyph.renderer.x + lastLinkedGlyph.renderer.getBeatX(lastLinkedGlyph.beat, endPosition)` — exactly the same math `paint`/`calculateEndX` already does ([GroupedEffectGlyph.ts:50-79](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L50)).

Coordinate is two-step: `CoordinateAssemble` runs incrementally on each `addBars` / `revertLastBar`; `CoordinateReconcile` runs once per system at close, after `reconcileMinDurationIfDirty` ([reconcile-min-duration.md §6](./investigations/reconcile-min-duration.md)). Phase 2 (Spaced) is single-write once Step 0 hoists `_scaleToForce` from the per-voice loop ([scale-to-force-multi-call.md](./investigations/scale-to-force-multi-call.md)). `BeamingHelper.drawingInfos` is populated exactly once per cycle at Phase 2 entry, both directions eagerly ([beam-helper-drawinginfos.md §6](./investigations/beam-helper-drawinginfos.md)).

---

## §A. Lifecycle timeline today

### A.1 Per-renderer state mutation table

Each cell shows the operation that pass performs on the field. Cells that mutate are bold-ish in prose; the table is descriptive.

| State | doLayout | applyLayoutingInfo | scaleToWidth | finalizeRenderer |
| --- | --- | --- | --- | --- |
| `_preBeatGlyphs.width` | set (content) | grown to `preBeatSize` | — | — |
| `voiceContainer.x` | set | reassigned | (implicit via post.x) | — |
| `_postBeatGlyphs.x` | set | reassigned | reassigned | — |
| `_postBeatGlyphs.width` | set (content) | grown to `postBeatSize` | — | — |
| `width` | set | reassigned | reassigned | possibly grown |
| `computedWidth` | (=0) | written | — | — |
| `height` | accumulated `+=` | — | — | possibly grown |
| `_contentTopOverflow / Bottom` | written | — | — | possibly grown |
| `barLocalSkyline` | reset | — | reset + emitted | tie writes (own + spanned) |
| `preBeatLocalSkyline` | emitted (`calculateOverflows`) | — | — | — |
| `postBeatLocalSkyline` | emitted (`calculateOverflows`) | — | — | — |
| `topEffects.height` / `bottomEffects.height` | (=0) | (=0) | (=0) | `EffectSystemPlacement.placeAndApply` (in `finalizeStaff`) |
| `_scaleToForce(force)` | — | **N times** (per-voice loop, [MultiVoiceContainerGlyph.ts:160-167](packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts#L160)) | **1 time** ([BarRendererBase.ts:366](packages/alphatab/src/rendering/BarRendererBase.ts#L366)) | — |
| `drawingInfos[canonical]` | populated by `calculateBeamingOverflows` (pre-spring X) | — | **cleared by `alignWithBeats`** then rebuilt on first `ensureBeamDrawingInfo` cache-miss | paint may insert tuplet dir |
| `effectBand.alignGlyphs` | called (#1, [BarRendererBase.ts:697](packages/alphatab/src/rendering/BarRendererBase.ts#L697)) | called (#2, [:546](packages/alphatab/src/rendering/BarRendererBase.ts#L546)) | called (#3, [:415](packages/alphatab/src/rendering/BarRendererBase.ts#L415)) | called (#4, on resize via `reLayout` [:968](packages/alphatab/src/rendering/BarRendererBase.ts#L968)) |
| `isFinalized` flag | (=false) | — | — | set true |
| `wasFirstOfStaff` | written from `createPreBeatGlyphs` [:899](packages/alphatab/src/rendering/BarRendererBase.ts#L899) | — | — | — |
| `_appliedLayoutingInfo` (version cookie) | (=0) | bumped to `info.version` | — | — |

Two crucial corrections to the v2 narrative (preserved from v3):

- **`_scaleToForce` is multi-call today**, proved in [scale-to-force-multi-call.md §2-§3](./investigations/scale-to-force-multi-call.md). Iterations 2..N are no-ops because `BarLayoutingInfo.minStretchForce` is settled in the first iteration. Step 0 removes the multi-call.
- **`BeamingHelper.alignWithBeats` does not rewrite `startX/endX` in place.** It clears `drawingInfos` mid-iteration, and the writes only land on the first map entry which is immediately discarded ([BeamingHelper.ts:109-115](packages/alphatab/src/rendering/utils/BeamingHelper.ts#L109)). The load-bearing effect is the `.clear()`; `ensureBeamDrawingInfo` rebuilds on the next cache-miss.

### A.2 Per-staff / per-system flow

- `RenderStaff.addBar` ([RenderStaff.ts:155-173](packages/alphatab/src/rendering/staves/RenderStaff.ts#L155)) creates renderer, assigns `additionalMultiRestBars`, calls `renderer.doLayout()`. Returns to `StaffSystem.addBars`.
- `StaffSystem.addBars` ([StaffSystem.ts:333-411](packages/alphatab/src/rendering/staves/StaffSystem.ts#L333)) iterates staves, collects visibility, sets `firstVisibleStaff`, calls `_calculateAccoladeSpacing(tracks)` (first call only, gated by `_accoladeSpacingCalculated` [:586](packages/alphatab/src/rendering/staves/StaffSystem.ts#L586)), calls `barLayoutingInfo.finish()`, then `_trackSystemMinDuration` (eager reconcile branch when this bar has a shorter min than the system's), then `_applyLayoutAndUpdateWidth` (which runs `applyLayoutingInfo` on each renderer).
- `_createStaffSystem` ([VerticalLayoutBase.ts:476-534](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L476)) drives `addBars` until `systemIsFull` then calls `revertLastBar` (possibly multiple times until a wrappable bar is reached). Reverted bars feed `_barsFromPreviousSystem` and are re-added to the next system. Visibility flips on revert; `_emptyBarCount` is decremented.
- `_fitSystem` ([VerticalLayoutBase.ts:411](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L411)) calls `reconcileMinDurationIfDirty` (which re-applies `applyLayoutingInfo` over stale bars), then `_scaleToWidth` on each renderer (Phase 2 today), then `finalizeStaff`.
- `RenderStaff.finalizeStaff` ([RenderStaff.ts:308-356](packages/alphatab/src/rendering/staves/RenderStaff.ts#L308)) iterates renderers, calls `finalizeRenderer` (which calls `_finalizeTies`), unions `barLocalSkyline` into the staff skyline, then `effectPlacement.placeAndApply()`. If `_finalizeTies` reported a change in overflows, runs the whole loop a second time (`needsSecondPass`).

---

## §B. Inventory of cached / delayed / version-skipped state

### B.1 — `_postBeatGlyphs.x` mutated three times
[BarRendererBase.ts:804](packages/alphatab/src/rendering/BarRendererBase.ts#L804), [:541](packages/alphatab/src/rendering/BarRendererBase.ts#L541), [:412](packages/alphatab/src/rendering/BarRendererBase.ts#L412). Cluster: **C-1**. Final value depends on `layoutingInfo.postBeatSize` and the bar's final width. Single-write becomes legal after Steps 0 + 8.

### B.2 — `this.height += layoutingInfo.height`
[BarRendererBase.ts:808](packages/alphatab/src/rendering/BarRendererBase.ts#L808). Cluster: **C-1**. `layoutingInfo.height` is 0 today; `+=` is misleading on every `reLayout`. Latent bug, retired by Step 6.

### B.3 — `_appliedLayoutingInfo` version cookie
[BarRendererBase.ts:510, :525-530](packages/alphatab/src/rendering/BarRendererBase.ts#L510). Cluster: **C-3**. Perf-only against current code, proved in [reconcile-min-duration.md §3](./investigations/reconcile-min-duration.md). Removable only after Step 8b hoists the "is this bar dirty?" predicate into `reconcileMinDurationIfDirty`.

### B.4 — `wasFirstOfStaff` / `recreatePreBeatGlyphs`
[BarRendererBase.ts:899, :974-994](packages/alphatab/src/rendering/BarRendererBase.ts#L974). Cluster: **C-2 + C-5**. Resize-time pre-beat rebuild captures the at-creation answer. `isFirstOfStaff` = `index === 0` ([BarRendererBase.ts:480-482](packages/alphatab/src/rendering/BarRendererBase.ts#L480)). Real prereq: **Step 11 (LayoutCycle substate including `_preBeatGlyphs`)**, then Step 10.

### B.5 — `firstVisibleStaff` decided post-loop
[StaffSystem.ts:322, :395](packages/alphatab/src/rendering/staves/StaffSystem.ts#L322). Cluster: **C-2**. Decidable from the model given the bar set. The set itself isn't known until `revertLastBar` settles. Step 1 owns this (per-system pre-pass, re-runs on every `addBars` and `revertLastBar`).

### B.6 — `_pendingBeatEffectsByBeat`
[BarRendererBase.ts:143, :281, :387-399](packages/alphatab/src/rendering/BarRendererBase.ts#L281). Cluster: **C-2**. Flushed inline in `scaleToWidth`'s per-beat callback; guarded by `if (beatId >= 0)` ([:386](packages/alphatab/src/rendering/BarRendererBase.ts#L386)) — interacts with B.20 multi-bar-rest's synthetic `-1` beatId. Retired by Step 4.

### B.7 — `_dynamicSkylineGlyphs` registry
[BarRendererBase.ts:216-220, :422-458](packages/alphatab/src/rendering/BarRendererBase.ts#L216). Cluster: **C-4**. Compensates for B.1 + B.5. Becomes obsolete for `BarNumberGlyph` (bbox stable once B.5 fixed) and is replaced by `populateSkyline?` for `BarTempoGlyph` (post-Phase-2 contribution) and `GroupedEffectGlyph` (cross-renderer end-X).

### B.8 — `scaleToWidth` called multiple times
[HorizontalScreenLayout.ts:180, :229](packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts#L180). Cluster: **C-1**. The entry-time `barLocalSkyline.reset()` ([BarRendererBase.ts:357](packages/alphatab/src/rendering/BarRendererBase.ts#L357)) is defensive against this. Step 7 removes the second call.

### B.9 — `afterReverted` / `afterStaffBarReverted` reset list is incomplete
[BarRendererBase.ts:512-523](packages/alphatab/src/rendering/BarRendererBase.ts#L512). Cluster: **C-5**. Silently surviving revert+re-add: `_pendingBeatEffectsByBeat`, `_ties[]`, `_dynamicSkylineGlyphs`, `barLocalSkyline`, `preBeatLocalSkyline`, `postBeatLocalSkyline`, `_contentTopOverflow / Bottom`, `_appliedLayoutingInfo`, `beatEffectsMinY / MaxY`. Retired by Step 11 (substate reassign atomically wipes the lot). Note: each line item in B.9 is annotated below in the "retired in step" column of §B's roll-up matrix.

### B.9b — `RenderStaff` overflow accumulators
[RenderStaff.ts:198-210](packages/alphatab/src/rendering/staves/RenderStaff.ts#L198), [:63-128](packages/alphatab/src/rendering/staves/RenderStaff.ts#L63). `topOverflow`, `bottomOverflow`, `staffTop`, `staffBottom` are max-of accumulators on `RenderStaff`. Reset in `revertLastBar` ([RenderStaff.ts:180-181](packages/alphatab/src/rendering/staves/RenderStaff.ts#L180)) but not in `finalizeStaff` or before `_resizeAndRenderScore`. Cluster: **C-6**. Retired by Step 11.

### B.10 — `BarLayoutingInfo` aggregated max-of by every renderer
Cluster: **C-3**. Earlier renderers' positions remain "stale" until `reconcileMinDurationIfDirty` ([StaffSystem.ts:446-491](packages/alphatab/src/rendering/staves/StaffSystem.ts#L446)) — and only when dirty.

### B.11 — `BeamingHelper.finish()` + `alignWithBeats()`
[BeamingHelper.ts:109-119](packages/alphatab/src/rendering/utils/BeamingHelper.ts#L109), [LineBarRenderer.ts:1017-1163](packages/alphatab/src/rendering/LineBarRenderer.ts#L1017). Cluster: **C-1 + C-5**. `alignWithBeats` is in practice `drawingInfos.clear()`; `drawingInfos` repopulates on next `ensureBeamDrawingInfo` cache-miss. Retired by Step 17 (Route B from §D.5).

### B.12 — `_finalizeTies` cross-renderer skyline writes
[BarRendererBase.ts:600-637](packages/alphatab/src/rendering/BarRendererBase.ts#L600). Cluster: **C-1 + C-5**. Tie writes today land in spanned renderers' bar-local skylines, feeding `_unionBarLocalIntoStaffSkyline` → `placeAndApply`'s per-renderer `r.x`-windowed queries ([EffectSystemPlacement.ts:63-64, :92-97](packages/alphatab/src/rendering/EffectSystemPlacement.ts#L63)). Contract preserved; only invocation point hoists (§D.6, Step 12).

### B.13 — `topEffects/bottomEffects.alignGlyphs` called 3× (4× on resize)
[BarRendererBase.ts:697, :546, :415, :968](packages/alphatab/src/rendering/BarRendererBase.ts). Cluster: **C-1**. Interacts with `_sharedLayoutData` via `EffectInfo.onAlignGlyphs` (B.17). Retired by Step 5.

### B.14 — `EffectSystemPlacement.reset()` outer `needsSecondPass`
[EffectSystemPlacement.ts:31-44](packages/alphatab/src/rendering/EffectSystemPlacement.ts#L31), [RenderStaff.ts:317-347](packages/alphatab/src/rendering/staves/RenderStaff.ts#L317). Cluster: **C-5**. The `placeAndApply` inner before/after `contentTop / contentBottom` sampling is the per-renderer attribution mechanic and stays. Only the `needsSecondPass` outer loop dies (Step 12, after tie writes precede the union).

### B.15 — `_systemSkyline` / `_effectPlacement` lazy alloc + manual reset
[RenderStaff.ts:212-220, :278-285](packages/alphatab/src/rendering/staves/RenderStaff.ts#L212). Cluster: **C-5 / C-6**. Retired by Step 11's staff-level substate.

### B.16 — `BarLayoutingInfo` shared mutable
[RenderStaff.ts:164](packages/alphatab/src/rendering/staves/RenderStaff.ts#L164), [StaffSystem.ts:340](packages/alphatab/src/rendering/staves/StaffSystem.ts#L340). Cluster: **C-3**. Cross-bar broker. v4 keeps the broker but adds CoordinateAssemble (local seal) + CoordinateReconcile (system seal).

### B.17 — `_sharedLayoutData` string-keyed map on `RenderStaff`
[RenderStaff.ts:24, :109-118](packages/alphatab/src/rendering/staves/RenderStaff.ts#L109). Cluster: **C-6**. Used by `TabWhammyEffectInfo.onAlignGlyphs` ([TabWhammyEffectInfo.ts:44-60](packages/alphatab/src/rendering/effects/TabWhammyEffectInfo.ts#L44)). Resets at `revertLastBar` but bleeds across renders on resize. Retired by Step 11 (lifecycle) + Step 15 (typed container).

### B.18 — `_appliedLayoutingInfo` skipping `alignGlyphs` side effect
[BarRendererBase.ts:526](packages/alphatab/src/rendering/BarRendererBase.ts#L526). Cluster: **C-3**. Symptom of B.13. Retired by Step 5 (single `alignGlyphs` call point) + Step 8b (cookie deletion).

### B.19 — `BarLayoutingInfo.version` bumped intra-bar in `addSpring`
[BarLayoutingInfo.ts:136](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts#L136). Cluster: **C-3**. Cookie protects against intra-bar partial-state reads. Moot after Step 8a (no intra-`doLayout` `applyLayoutingInfo`).

### B.20 — `MultiBarRestBeatContainerGlyph.beatId === -1`
[BarRendererBase.ts:386](packages/alphatab/src/rendering/BarRendererBase.ts#L386), [MultiBarRestBeatContainerGlyph.ts](packages/alphatab/src/rendering/glyphs/MultiBarRestBeatContainerGlyph.ts). Cluster: **C-2**. Latent landmine. Step 4 retires (pending-effects flush is inlined in beat walk; the guard becomes "no pending list" by construction).

### B.21 — `Bar.simileMark === SecondOfDouble` flips `canWrap` from `doLayout`
[BarRendererBase.ts:686-688](packages/alphatab/src/rendering/BarRendererBase.ts#L686), [StaffSystem.ts:375-377](packages/alphatab/src/rendering/staves/StaffSystem.ts#L375). Cluster: **C-2**. `canWrap` is consumed during system assembly; setting it inside `doLayout` is Phase-1 affecting a CoordinateAssemble input. Decidable from the model. Step 1b retires (split off from Step 1 for clarity — see §E).

### B.22 — `_sharedLayoutData` reset point bleeds across renders on resize
[VerticalLayoutBase.ts:455](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L455), [HorizontalScreenLayout.ts:221](packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts#L221). Cluster: **C-6**. Resolved by Step 11's staff-level substate.

### B.23 — `RenderStaff.height` early-computed in `calculateHeightForAccolade`
[RenderStaff.ts:290-298](packages/alphatab/src/rendering/staves/RenderStaff.ts#L290). Cluster: **C-2**. Called from `_calculateAccoladeSpacing` ([StaffSystem.ts:584-690](packages/alphatab/src/rendering/staves/StaffSystem.ts#L584)) at the first `addBars` (gated by `_accoladeSpacingCalculated` [:586](packages/alphatab/src/rendering/staves/StaffSystem.ts#L586)); reads `barRenderers[0].height` ([:293](packages/alphatab/src/rendering/staves/RenderStaff.ts#L293)) before later-added renderers contribute. The accolade-spacing one-shot interacts with `revertLastBar` (visibility can flip; height of `barRenderers[0]` is stable for `index 0` though). Step 1c owns this — see §E.

### B.24 — `_postBeatGlyphs.doLayout()` no-op in `recreatePreBeatGlyphs`
[BarRendererBase.ts:976](packages/alphatab/src/rendering/BarRendererBase.ts#L976), [LeftToRightLayoutingGlyphGroup.ts:15-17](packages/alphatab/src/rendering/glyphs/LeftToRightLayoutingGlyphGroup.ts#L15). Dead code. Retired by Step 10.

### B.25 — `EffectBand.computeLocalXRange` underreports for cross-renderer span effects
[EffectBand.ts:251-294](packages/alphatab/src/rendering/EffectBand.ts#L251), [GroupedEffectGlyph.ts:20-25](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L20).

**Mechanism (corrected from v3).** `GroupedEffectGlyph.getBoundingBoxRight` returns `this.renderer.getBeatX(this.beat, this.endPosition)` — **the start beat's end-x in the local renderer**. It does NOT read any foreign `endBeat`. The painted end-X is computed in `calculateEndX` ([GroupedEffectGlyph.ts:69-79](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L69)) by walking `nextGlyph` to the last linked glyph (the walk uses `isLinkedWithNext` [:31-37](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L31), which requires the next renderer's `isFinalized === true`), then `endBeatRenderer.x + endBeatRenderer.getBeatX(endBeat, endPosition)`. For Span-category effects linked across renderers, the painted end-X is strictly greater than `getBoundingBoxRight`. `computeLocalXRange` only sees the local extent, so under-reports the band's effective range by `(end-renderer end-X − start-renderer end-X)`.

**Why it matters for layout.** `EffectBand.computeLocalXRange` feeds placement decisions; under-reporting means a sibling band can be placed in an x-window the span actually occupies. Today's behaviour is partly compensated by the fact that placement runs after all `isFinalized` flags are set (so the `nextGlyph` walk could succeed), but `computeLocalXRange` itself doesn't traverse the chain.

Cluster: **C-4**. v4 commits: `computeLocalXRange`'s validity phase is **SystemFinalize**, and `GroupedEffectGlyph` registers a `populateSkyline?` (or equivalent SystemFinalize hook — see §D.3) that performs the `nextGlyph` chain walk to publish the true end-X to the band. Step 16 owns this, gated on Step 3 (hook lifecycle) + Step 13 (phase split).

### B.26 — `additionalMultiRestBars` is layout-state read in Phase 1 *(new from v3-review M1)*
[BarRendererBase.ts:120](packages/alphatab/src/rendering/BarRendererBase.ts#L120), [RenderStaff.ts:161](packages/alphatab/src/rendering/staves/RenderStaff.ts#L161), consumed in `createBeatGlyphs` at [BarRendererBase.ts:903-904](packages/alphatab/src/rendering/BarRendererBase.ts#L903). Cluster: **C-2** (sort of). Assigned by `addBar` before `doLayout` runs. It is a layout decision (the multi-bar-rest grouping was computed at score-layout time from `multiBarRestInfo` [VerticalLayoutBase.ts:490](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L490)). v4 classifies this as a **Build-input** to Phase 1 (set in Phase 0 by the layout, read in Phase 1 by `createBeatGlyphs`). No migration step retires it; §D.2 documents the contract explicitly.

### B.27 — `isLinkedToPrevious` renderer field is a Phase-1 output consumed in CoordinateAssemble *(new from v3-review M4)*
[BarRendererBase.ts:240](packages/alphatab/src/rendering/BarRendererBase.ts#L240), set in `createBeatGlyphs` at [:914-916](packages/alphatab/src/rendering/BarRendererBase.ts#L914) when the renderer's top or bottom effect bands report linkage. Read by `StaffSystem.addBars` at [:372-374](packages/alphatab/src/rendering/staves/StaffSystem.ts#L372). v4 lists this in §D.2 as a Phase-1 output, CoordinateAssemble-input.

### B.28 — `renderer.width` and `renderer.computedWidth` diverge *(new from v3-review M5)*
v3 collapsed them into one row in §D.2. They diverge: `computedWidth` is the intrinsic / pre-fit "natural" width set in `applyLayoutingInfo` ([BarRendererBase.ts:544](packages/alphatab/src/rendering/BarRendererBase.ts#L544)) and `doLayout` ([:709](packages/alphatab/src/rendering/BarRendererBase.ts#L709)); `width` is the fitted result of `scaleToWidth`. On resize-with-barsPerRow-active ([VerticalLayoutBase.ts:288](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L288)) the system width is reset to `computedWidth` then re-fit. §D.2 splits them into separate rows.

### B.29 — `MasterBarBounds` / `BarBounds` final-geometry recording *(new from v3-review M6)*
[BarRendererBase.ts:875-892](packages/alphatab/src/rendering/BarRendererBase.ts#L875). Reads final renderer `x`, `y`, `width`, `height` from inside `buildBoundingsLookup`, called at paint time. Validity phase: **after SystemFinalize**, i.e. paint. §D.2 has a row for this so a future contributor doesn't read bounds mid-cycle.

### B.30 — `addBars` / `revertLastBar` loop is the CoordinateAssemble driver *(new from v3-review M7)*
[VerticalLayoutBase.ts:476-534](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L476). CoordinateAssemble fires on every `addBars` AND on every `revertLastBar` (the latter must roll back accumulator state: `_emptyBarCount`, `topOverflow`, `bottomOverflow`, `_sharedLayoutData`, `firstVisibleStaff`, `_accoladeSpacingCalculated`?). Step 1 owns the assemble-side contract; the revert-side rollback set is in §D.8 below.

### B.31 — `isFinalized` flag survives across cycles on barsPerRow-active resize *(new from v3-review M10)*
[BarRendererBase.ts:512-516](packages/alphatab/src/rendering/BarRendererBase.ts#L512) — `afterReverted` resets `isFinalized = false`. On barsPerRow-active resize ([VerticalLayoutBase.ts:285-291](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L285)), `afterReverted` is **not** called per renderer; only `_fitSystem` runs. `isFinalized` carries true from the previous cycle. Two consequences:
- `GroupedEffectGlyph.isLinkedWithNext` ([GroupedEffectGlyph.ts:31-37](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L31)) depends on `this.nextGlyph.renderer.isFinalized` — i.e. on barsPerRow-active resize, the linkage check is using a stale truth that happens to remain valid because the renderer chain doesn't change.
- `finalizeRenderer` ([:642-662](packages/alphatab/src/rendering/BarRendererBase.ts#L642)) sets `isFinalized = true` again — idempotent against `isFinalized` itself, but the body re-runs (e.g. `_finalizeTies` writes again).

v4 makes `isFinalized` a per-cycle field via Step 11's substate. The hand-off contract for `isLinkedWithNext` becomes: "during SystemFinalize step (i) — per-renderer finalize-minus-ties — `isFinalized` is set to true before the chain-walk sub-step (ii) runs." See §D.6.

---

## §C. Root anti-patterns

### C-1. Retroactive position mutation
A field's "final" value depends on layer-N decisions but layer-(N−k) writes a tentative value that downstream consumers read. Instances: B.1, B.2, B.10, B.11, B.13.

### C-2. Out-of-order phase dependency
Phase A reads state that should be set by phase B but is captured early via a substitute mechanism (cookie, registry). Instances: B.4, B.5, B.6, B.20, B.21, B.23, B.26 (Build-input formalization), B.30.

### C-3. Lazy cross-bar coordination through a shared mutable broker
`BarLayoutingInfo` accumulates and re-bumps version, callers gate on the cookie. Instances: B.3, B.10, B.16, B.18, B.19.

### C-4. Bounding-box as side-channel for renderer state
`getBoundingBox*` returns "the layout state at the moment you happened to ask," not "the glyph's intrinsic geometry." Instances: B.1 (consumer), B.5 (consumer), B.7, B.25.

### C-5. Renderer-as-shared-mutable-state across phases
Renderer fields are scratch state, manually reset at scattered call sites. Instances: B.9, B.11, B.14, B.15 (also C-6), the substate part of B.4, B.31.

### C-6. Staff-level mutable accumulators with implicit reset points
Distinct from C-5: scope is `RenderStaff`, not `BarRendererBase`. Reset points scattered or absent on certain paths. Instances: B.9b, B.15, B.17, B.22.

### C-7. Build-input vs Phase-1-output confusion *(new)*
Fields set by the layout (not the model) before `doLayout` runs (`additionalMultiRestBars`, `layoutingInfo` reference) AND fields set by `doLayout` that CoordinateAssemble must read (`isLinkedToPrevious`, `canWrap` for SimileMark). Today the contract is implicit and a reader cannot tell from a field declaration whether it is Build-state, Phase-1-output, or both. v4 names this cluster so §D.2 can list "Build-input" / "Phase-1-output / CoordinateAssemble-input" rows distinct from "Intrinsic". Instances: B.21, B.26, B.27.

---

## §D. Target architecture

### D.1 Phase DAG

```
            ┌──────────────────────────────────────────────────────┐
            │              Phase 0: Build                          │
            │   constructor + factory.create + helpers.init        │
            │   layout sets additionalMultiRestBars before Phase 1 │
            └────────────────────────┬─────────────────────────────┘
                                     │
                                     ▼
            ┌──────────────────────────────────────────────────────┐
            │              Phase 1: Intrinsic                       │
            │   per-bar: voiceContainer + glyphs.doLayout;          │
            │   publishes intrinsic sizes into BarLayoutingInfo;    │
            │   outputs isLinkedToPrevious for CoordinateAssemble.  │
            │   NO reads of sibling renderers / staff / system.     │
            └────────────────────────┬─────────────────────────────┘
                                     │  per master bar
                                     ▼
            ┌──────────────────────────────────────────────────────┐
            │  System-level (per master bar / per revert):          │
            │              CoordinateAssemble                       │
            │  • compute firstVisibleStaff from model               │
            │  • compute canWrap from model (SimileMark) — Step 1b  │
            │  • layoutingInfo.finish()  — LOCAL seal               │
            │  • _trackSystemMinDuration (eager branch)             │
            │  • per-renderer applyLayoutingInfo (was Phase 2 body, │
            │    minus _scaleToForce; size publication only)        │
            │  • update incremental system width totals             │
            │  • _calculateAccoladeSpacing — Step 1c                │
            └────────────────────────┬─────────────────────────────┘
                                     │  next bar, or system close
                                     ▼
            ┌──────────────────────────────────────────────────────┐
            │      System-level (once per system, on close):        │
            │              CoordinateReconcile                      │
            │  • if isMinDurationDirty: for each stale bar, run     │
            │      recomputeSpringConstants then redo Phase-2 sub-  │
            │      step for that renderer                           │
            │  • rebuild system width / contentWidth / overhead     │
            │  • SYSTEM SEAL: BarLayoutingInfo read-only thereafter │
            └────────────────────────┬─────────────────────────────┘
                                     │  per renderer (one final pass)
                                     ▼
            ┌──────────────────────────────────────────────────────┐
            │              Phase 2: Spaced  (single-write)         │
            │   given final width, compute every position once:    │
            │   _preBeatGlyphs.width, voiceContainer.x,            │
            │   beat container x (via _scaleToForce, ONCE),        │
            │   _postBeatGlyphs.x, renderer.width,                 │
            │   BeamingHelper.drawingInfos (both directions),      │
            │   effectBand.alignGlyphs (1×).                       │
            │   NO skyline writes (assertion: zero insert*).       │
            └────────────────────────┬─────────────────────────────┘
                                     │
                                     ▼
            ┌──────────────────────────────────────────────────────┐
            │              Phase 3: Finalized                      │
            │   • barLocalSkyline.reset() (cheap; idempotent)      │
            │   • emit preBeatLocalSkyline (walks _preBeatGlyphs)  │
            │   • emit barLocalSkyline beats (walks voiceContainer │
            │     + per-beat overflow + pending-effects, inlined)  │
            │   • emit postBeatLocalSkyline (walks _postBeatGlyphs)│
            │   • emit beam-helper skyline (reads drawingInfos r/o)│
            │   • subclass emit hooks (emitSubclassBarLocalSkyline)│
            │   • populateSkyline? on declared-dynamic glyphs      │
            │     against barLocalSkyline (BarTempoGlyph)          │
            │   • content-height accounting                        │
            └────────────────────────┬─────────────────────────────┘
                                     │  for every renderer
                                     ▼
            ┌──────────────────────────────────────────────────────┐
            │              SystemFinalize (per staff, 4 sub-steps) │
            │   (i)  for each renderer: finalize-minus-ties        │
            │        (sets isFinalized = true; runs sub-phase 3.5  │
            │        emits that depend only on local Phase-3 data) │
            │   (ii) for each tie/slur in each renderer:           │
            │        tie.layoutAndEmit writes into its renderer's  │
            │        AND spanned renderers' barLocalSkylines       │
            │        (cross-renderer GroupedEffectGlyph end-X      │
            │        publishes here too — chain-walk valid now     │
            │        because every renderer.isFinalized=true)      │
            │   (iii) for each renderer: _unionBarLocalIntoStaff   │
            │   (iv) effectPlacement.placeAndApply (one call;      │
            │        inner before/after contentTop/contentBottom   │
            │        sampling preserved as attribution mechanic)   │
            │   • apply renderer.y = topPadding + topOverflow     │
            └──────────────────────────────────────────────────────┘
```

**Why Coordinate is two-step.** [reconcile-min-duration.md §6](./investigations/reconcile-min-duration.md) proves a single seal cannot work for vertical layouts: bar (N+M) can introduce a shorter min-duration that retroactively invalidates bars 1..(N+M−1)'s spring constants; the dirty flag is consumed at `_fitSystem` ([VerticalLayoutBase.ts:411](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L411)), well after assembly. CoordinateAssemble provides the incremental width feedback `addBars` needs for `systemIsFull`; CoordinateReconcile runs at system close and is the actual seal.

`HorizontalScreenLayout` has `shareMinDurationAcrossBars = false` ([HorizontalScreenLayout.ts:76](packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts#L76)); for it CoordinateReconcile is a no-op (no stale bars), but the phase still runs as the explicit seal point.

### D.2 Phase contracts (state immutability table)

This table is the single load-bearing artifact of v4. Every row's "final after X" column is grep-checkable or assertion-checkable; §H pins the invariants.

| Field | Phase 0 (Build) | Phase 1 (Intrinsic) | CoordinateAssemble | CoordinateReconcile | Phase 2 (Spaced) | Phase 3 (Finalized) | SystemFinalize |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `additionalMultiRestBars` (Build-input) | **set by layout** | (read-only) | (read-only) | (read-only) | (read-only) | (read-only) | (read-only) |
| `layoutingInfo` (Build-ref) | **set by layout** | (broker, written via publish) | LOCAL seal (`finish()`) | SYSTEM seal | (read-only) | (read-only) | (read-only) |
| `isLinkedToPrevious` (Phase-1 output) | (=false) | **set in `createBeatGlyphs`** | read | (read-only) | (read-only) | (read-only) | (read-only) |
| `canWrap` (Phase-1 → CoordinateAssemble) | (=true) | (untouched after Step 1b) | **final from model** | (read-only) | (read-only) | (read-only) | (read-only) |
| `BarLayoutingInfo.{preBeatSize, postBeatSize}` of this bar | (zero) | written | LOCAL seal | SYSTEM seal | (read-only) | (read-only) | (read-only) |
| `BarLayoutingInfo.{minStretchForce, totalSpringConstant, springConstants, version}` | (initial) | written via `addSpring` | LOCAL seal (`finish()`) | SYSTEM seal | (read-only) | (read-only) | (read-only) |
| `staff.isFirstInSystem` / `system.firstVisibleStaff` | — | (untouched) | **model-derived; final** (re-derived per revert) | (final) | (final) | (final) | (final) |
| `renderer.computedWidth` | (=0) | intrinsic | written by `applyLayoutingInfo` | re-written if reconciled | (final, == natural width) | (read-only) | (read-only) |
| `renderer.width` | (=0) | intrinsic | written by `applyLayoutingInfo` | re-written if reconciled | **final, fitted** | (read-only) | (read-only) |
| `_preBeatGlyphs.{x, width}` | (=0) | intrinsic | grown via `applyLayoutingInfo` | re-grown if reconciled | **final** | (read-only) | (read-only) |
| `voiceContainer.x`, beat container `x` | (=0) | intrinsic | reassigned via `applyLayoutingInfo` | reassigned if reconciled | **final via `_scaleToForce` (once)** | (read-only) | (read-only) |
| `_postBeatGlyphs.{x, width}` | (=0) | intrinsic | reassigned via `applyLayoutingInfo` | reassigned if reconciled | **final** | (read-only) | (read-only) |
| `renderer.height` | (=0) | initialized | (unchanged) | (unchanged) | (unchanged) | **may grow once via `updateSizes`** | (read-only) |
| `BeamingHelper.drawingInfos[canonical]` | (empty) | (empty; `calculateBeamingOverflows` uses direct Y math) | (empty) | (empty) | **final, written once** by `initializeBeamDrawingInfo` | (read-only) | (read-only) |
| `BeamingHelper.drawingInfos[tuplet]` | (empty) | (empty) | (empty) | (empty) | **final, written once when `getTupletBeamDirection ≠ getBeamDirection`** | (read-only) | (read-only) |
| `topEffects/bottomEffects.alignGlyphs` state | (empty) | (not invoked) | (not invoked) | (not invoked) | **final, invoked exactly once** | (read-only) | (read-only) |
| `preBeatLocalSkyline` | (lazy null) | (lazy null) | (lazy null) | (lazy null) | (reset only) | **emitted, final** | (final) |
| `postBeatLocalSkyline` | (lazy null) | (lazy null) | (lazy null) | (lazy null) | (reset only) | **emitted, final** | (final) |
| `barLocalSkyline` (non-tie content) | (lazy null) | (lazy null) | (lazy null) | (lazy null) | **reset, empty** | **emitted, final** | (read-only) |
| `barLocalSkyline` (tie overlay writes for own renderer + spanned) | (lazy null) | — | — | — | (reset, empty) | (empty) | **written in sub-step (ii); final after (ii)** |
| `_ties[]` content list | (=[]) | populated during glyph construction | (read-only) | (read-only) | (read-only) | (read-only) | **placed, final** |
| `topEffects.height` / `bottomEffects.height` | (=0) | (=0) | (=0) | (=0) | (=0) | (=0) | **final after sub-step (iv)** |
| `RenderStaff.topOverflow / bottomOverflow / staffTop / staffBottom` | (=0) | (=0) | (max-of accumulating per renderer addBar) | (max-of accumulating) | (max-of accumulating) | (max-of accumulating) | **final after sub-step (iv)** |
| `RenderStaff._sharedLayoutData` | (empty) | (read by per-band `onAlignGlyphs` callbacks if any) | (written by `onAlignGlyphs` if effect-aware) | (written if reconciled) | written by `onAlignGlyphs` in single `alignGlyphs` call | (read-only) | (read-only) |
| `renderer.y` | (=0) | (=0) | (=0) | (=0) | (=0) | (=0) | **final after sub-step (iv)** |
| `isFinalized` | (=false) | (=false) | (=false) | (=false) | (=false) | (=false) | **true after sub-step (i)** |
| `MasterBarBounds` / `BarBounds` | — | — | — | — | — | — | written at paint time (post-SystemFinalize) |

Definitions:
- **"intrinsic"** = "the value reflects this bar's own contribution; not yet aware of sibling renderers." A field marked `intrinsic` is allowed to be mutated by CoordinateReconcile if dirty-bar reconcile catches it; if not dirty, intrinsic == final at CoordinateAssemble.
- **"LOCAL seal"** = `BarLayoutingInfo.finish()` has been called for this bar; cross-bar broker may still re-aggregate.
- **"SYSTEM seal"** = `reconcileMinDurationIfDirty` has been called; broker is now read-only.

**The key invariant resolving v3's Critical 1.** `barLocalSkyline` row has two cells in different columns: `(reset, empty)` after Phase 2; `emitted, final` after Phase 3. Phase 2 may never insert into `barLocalSkyline`; Phase 3 may. The tie-overlay row is a separate row to make it crystal clear that tie writes are SystemFinalize sub-step (ii) writes against `barLocalSkyline`, not Phase-3 writes. See §H for the grep-checkable invariant.

### D.3 Glyph contract — and the `populateSkyline?` lifecycle decision

```ts
abstract class Glyph {
  // Phase 1. Pure intrinsic layout. Sets this.x / .width / .height in
  // glyph-local coordinates. May read renderer for resources/canvas only.
  // May NOT read renderer.staff.system or sibling renderers.
  // May call renderer.publishIntrinsic*(...) to contribute to BarLayoutingInfo.
  doLayout(): void;

  // Pure geometric query — function of glyph's own fields, set by doLayout
  // and Phase 2 (for glyphs whose x is positioned by Phase 2). Stable once
  // its owning phase finishes. May NOT consult renderer/staff/system state
  // for layout decisions (resources are OK).
  getBoundingBoxLeft(): number;
  getBoundingBoxRight(): number;
  getBoundingBoxTop(): number;
  getBoundingBoxBottom(): number;

  // Optional. Fires in Phase 3 against barLocalSkyline by default. Glyphs that
  // legitimately need SystemFinalize-time data (e.g. GroupedEffectGlyph's
  // cross-renderer end-X) declare phase=SystemFinalize at registration.
  populateSkyline?(target: SkylineTarget, ctx: SkylineCtx): void;
}

type SkylineTarget = BarLocalSkyline | StaffSystemSkyline;
interface SkylineCtx {
  phase: 'finalized' | 'systemFinalize';
  renderer: BarRendererBase;
}
```

**Decision on lifecycle.** The hook is dispatched **at most twice** in a cycle: once in Phase 3 against `barLocalSkyline` (for `BarTempoGlyph` and any other glyph that wants to participate in the local skyline pass), once in SystemFinalize against `barLocalSkyline` (for `GroupedEffectGlyph`'s chain-walk end-X, which needs every renderer's `isFinalized = true`). Each implementer declares which phase(s) it participates in via a registration call (`renderer.registerPopulateSkyline(g, phase)`). The default (no phase declared) is Phase 3.

**Two dispatch points, not one.** v3 was ambiguous; v4 commits:

```ts
// Phase 3 dispatch (in BarRendererBase.finalize):
for (const g of this._populateSkyline_finalized) {
  g.populateSkyline!(this.barLocalSkyline, { phase: 'finalized', renderer: this });
}

// SystemFinalize sub-step (ii) dispatch (in RenderStaff.finalizeStaff):
for (const renderer of this.barRenderers) {
  for (const g of renderer._populateSkyline_systemFinalize) {
    g.populateSkyline!(renderer.barLocalSkyline, { phase: 'systemFinalize', renderer });
  }
}
```

This resolves v3-review Significant #6.

**On BarTempoGlyph's hook participation.** v3-review Significant #7 challenged: after Step 9 (`_postBeatGlyphs.x` single-write at end of Phase 2), BarTempoGlyph's bbox is stable. So why does it need a Phase-3 hook? Answer: bbox is stable but **emission timing** still has to wait for Phase 3 — `barLocalSkyline.reset()` happens at Phase 3 start, and emitting earlier would be wiped. So BarTempoGlyph implements `populateSkyline?` for the emission-timing reason, not the bbox-staleness reason. After Step 9 (B.1 final), BarTempoGlyph could in principle be inlined into the post-beat-glyph walk in Phase 3 (just like other post-beat glyphs); the hook stays only as a uniform mechanism. Step 9's invariant covers the bbox-stability claim; the hook participation is a separate concern.

### D.4 BarLayoutingInfo's role and `_appliedLayoutingInfo`

`BarLayoutingInfo` remains a cross-bar broker on `MasterBarsRenderers` ([StaffSystem.ts:340](packages/alphatab/src/rendering/staves/StaffSystem.ts#L340)). v4 does NOT push to a `MasterBarLayout` — that's a larger refactor for a smaller correctness win (§G.1). The seal contract makes the broker safe.

`_appliedLayoutingInfo` is the version cookie. [reconcile-min-duration.md §3](./investigations/reconcile-min-duration.md) proves it is **perf-only against current code** (`applyLayoutingInfo` is value-idempotent on a stable `BarLayoutingInfo`). But — and this is the precondition v3's §D.4 elided — the current callers still depend on the cookie's short-circuit because `reconcileMinDurationIfDirty` blindly re-applies on every renderer. The cookie is deletable only after Step 8b hoists the "is this bar actually dirty?" predicate into `reconcileMinDurationIfDirty`. Sequence:

- **Step 8a**: drop every intra-`doLayout` call to `applyLayoutingInfo`. Stop bumping `BarLayoutingInfo.version` from `addSpring`; version moves only via `recomputeSpringConstants`. The cookie short-circuits as before.
- **Step 8b**: move the "should I re-apply?" predicate (`mb.layoutingInfo.computedWithMinDuration > this.minDuration`) into `reconcileMinDurationIfDirty` itself. Delete `_appliedLayoutingInfo`.

### D.5 BeamingHelper.drawingInfos — Route B

Two routes were on the table after [beam-helper-drawinginfos.md](./investigations/beam-helper-drawinginfos.md):
- **Route A**: keep the Phase A overflow probe (writes pre-spring X that's never read after the Phase B clear); rename `alignWithBeats` to `invalidateDrawingInfos`. Cheap (~5 lines) but leaves `drawingInfos` mutating across phases.
- **Route B**: rewrite `calculateBeamingOverflows` to compute beam Y *directly* (via `getFlagTopY` / `getFlagBottomY` / max-slope clamp) without caching in `drawingInfos`. In Phase 2, populate both `[canonical]` and `[tuplet]` direction entries eagerly when `getTupletBeamDirection(h) !== getBeamDirection(h)`. Phase 3 and paint then read-only.

**v4 chooses Route B.** Route A re-introduces C-1 at the beam-cache level; Route B costs ~100 lines isolated to `LineBarRenderer` and `BeamingHelper` and gives a phase contract that holds (`drawingInfos[*]` final after Phase 2, never mutated thereafter).

**Predicate for tuplet-direction population.** The Phase 2 eager-populate is:

```ts
// LineBarRenderer.initializeBeamDrawingInfo (Phase 2 entry per helper)
function initializeBeamDrawingInfo(h: BeamingHelper): void {
  const canonical = getBeamDirection(h);
  populateDrawingInfo(h, canonical);  // single mutation point for [canonical]
  const tupletDir = getTupletBeamDirection(h);
  if (tupletDir !== canonical) {
    populateDrawingInfo(h, tupletDir);  // single mutation point for [tuplet]
  }
}
```

`ensureBeamDrawingInfo` (today a cache-miss rebuilder) is **deleted** in callers under Route B; `paintBar` ([LineBarRenderer.ts:635](packages/alphatab/src/rendering/LineBarRenderer.ts#L635)) and `paintTuplets` ([:299-302](packages/alphatab/src/rendering/LineBarRenderer.ts#L299)) read `drawingInfos[direction]` directly. The "calculate beam Y for the overflow probe" path no longer touches `drawingInfos`.

### D.6 Tie / slur finalization — and the SystemFinalize sub-phase ordering

**Two routes:**
- **(a)** Hoist only the invocation point of `_finalizeTies`. Keep ties writing per-bar into spanned renderers' `barLocalSkyline`. `placeAndApply`'s per-renderer `r.x`-windowed queries continue to work unchanged.
- **(b)** Move tie writes to the system skyline directly; refactor `placeAndApply` to attribute per-renderer overflow via system-skyline queries.

**v4 chooses (a).** `placeAndApply` does per-renderer `r.x`-windowed queries against the unified staff skyline; the staff skyline is built by unioning `barLocalSkyline`s ([RenderStaff.ts:236-249](packages/alphatab/src/rendering/staves/RenderStaff.ts#L236)) with `baseX = renderer.x`. Route (a) preserves this attribution surface for free. Route (b) would touch the height-attribution mechanic for no gain.

**SystemFinalize sub-phase ordering — the contract.** v3 left this ambiguous and the natural reading would have put ties after `placeAndApply`, re-introducing the v2-Critical-3 attribution break. v4 pins:

| Sub-step | Operation | Reads | Writes |
| --- | --- | --- | --- |
| (i) per-renderer | `finalizeRenderer-minus-ties` (sets `isFinalized = true`; Phase-3 emits already happened, but any deferred local final state is computed here) | local | local; `isFinalized = true` |
| (ii) per-renderer | tie writes: `_finalizeTies(this._ties)` + `_finalizeTies(this._multiSystemSlurs)`; cross-renderer `GroupedEffectGlyph` `populateSkyline?` dispatch (chain-walk valid because every renderer.isFinalized=true) | own + spanned renderer `barLocalSkyline`s, `barRenderers[*].isFinalized` | own + spanned renderer `barLocalSkyline`s |
| (iii) per-renderer | `_unionBarLocalIntoStaffSkyline(renderer)`; runs after every renderer has finished sub-step (ii) so spanned-renderer tie writes are visible | own `barLocalSkyline`, `preBeatLocalSkyline`, `postBeatLocalSkyline`, `renderer.x`, `renderer.height` | staff `systemSkyline` |
| (iv) once per staff | `effectPlacement.placeAndApply()`; inner before/after `contentTop / contentBottom` sampling preserved | staff `systemSkyline`, per-renderer `r.x`/`r.width` windows | `topEffects.height`, `bottomEffects.height`, `renderer.y` |

**Why sub-step (i) is separated from (ii).** Today, `finalizeRenderer` ([BarRendererBase.ts:642-662](packages/alphatab/src/rendering/BarRendererBase.ts#L642)) sets `isFinalized = true` AND calls `_finalizeTies` AND `_finalizeTies` writes into spanned renderers' bar-local skylines. In sub-step (ii) the chain walk for `GroupedEffectGlyph.isLinkedWithNext` requires `this.nextGlyph.renderer.isFinalized` to be true. If we did per-renderer `finalize-with-ties` (today's monolith), the chain walk in renderer K could only see renderer K+1's `isFinalized` after renderer K+1 had also written its own ties — i.e. sub-step (ii) for K depends on sub-step (i) for K+1. Splitting (i) and (ii) into two passes resolves the dependency: pass (i) sets every `isFinalized` first, then pass (ii) does cross-renderer work that needs the chain to be finalized end-to-end.

**`needsSecondPass` outer loop dies.** Today's loop ([RenderStaff.ts:317-347](packages/alphatab/src/rendering/staves/RenderStaff.ts#L317)) re-runs the whole finalize-union-place sequence if any tie wrote overflows. v4: ties run in (ii), before union (iii), before place (iv); the second pass is unreachable. Inner before/after sampling in `placeAndApply` ([EffectSystemPlacement.ts:31-44](packages/alphatab/src/rendering/EffectSystemPlacement.ts#L31)) stays — it is the per-renderer attribution mechanic, not the outer reconverge loop.

### D.7 Skyline emission — exact code shape

```ts
// BarRendererBase.finalize() (Phase 3)
finalize(): void {
  // (1) Reset is idempotent: at most one writer (this method) ever inserts
  //     into barLocalSkyline, so reset is defensive only. The grep-checkable
  //     invariant is in §H Step 13: zero `barLocalSkyline.insert*` reachable
  //     from spacedLayout().
  this.barLocalSkyline.reset();
  this.preBeatLocalSkyline.reset();
  this.postBeatLocalSkyline.reset();

  this.emitPreBeatSkyline();    // walks _preBeatGlyphs.glyphs, reads each bbox
  this.emitBeatSkylineWalk();   // walks voiceContainer beats; inlined pending-
                                //   effects flush (Step 4); per-beat overflow
                                //   probe; emitBeatSkyline (subclass hook)
  this.emitPostBeatSkyline();   // walks _postBeatGlyphs.glyphs (post-beat x final)
  this.emitHelperSkylineAll();  // walks helpers.beamHelpers; reads drawingInfos r/o
  this.emitSubclassBarLocalSkyline();

  for (const g of this._populateSkyline_finalized) {
    g.populateSkyline!(this.barLocalSkyline, { phase: 'finalized', renderer: this });
  }
  this.calculateOverflowsFromSkyline();  // sets _contentTopOverflow/Bottom
}
```

`_pendingBeatEffectsByBeat` is gone: per-beat effects are inlined into the beat walk (Step 4). `_dynamicSkylineGlyphs` is gone: BarNumberGlyph bbox stable after Step 1; BarTempoGlyph uses `populateSkyline?`; GroupedEffectGlyph uses `populateSkyline?` at SystemFinalize.

### D.8 Resize entry point + revert rollback

Resize re-enters at CoordinateAssemble:

```
ScoreLayout.resize:
  decide barsPerRow-active vs free-wrap (VerticalLayoutBase._resizeAndRenderScore)
  for each renderer to be reused: LayoutCycle.reassign()  // Step 11
    — discards: _barLocalSkyline, _preBeatLocalSkyline, _postBeatLocalSkyline,
       _pendingBeatEffectsByBeat, _dynamicSkylineGlyphs, _contentTopOverflow,
       _contentBottomOverflow, _appliedLayoutingInfo (until Step 8b deletes),
       beatEffectsMinY/MaxY, isFinalized, _ties (only if pre-beat boundary
       changes), _multiSystemSlurs
    — survives: glyphs, voiceContainer, helpers, intrinsic widths, model refs
    — discards conditionally: _preBeatGlyphs (only when isFirstOfStaff flips —
       see Step 10's contract below)
  for each master bar: CoordinateAssemble
    (cheap; firstVisibleStaff and canWrap recomputed from model;
     accolade-spacing reset to be re-computed)
  for each system close: CoordinateReconcile + Phase 2 + Phase 3 + SystemFinalize
```

Phase 1's output (glyphs, intrinsic widths, pre-beat content) survives resize unless content actually changed.

**`revertLastBar` rollback set.** When CoordinateAssemble fires on revert, the following must be undone for the system to be re-driveable:
- `system.firstVisibleStaff`: re-derive from model + remaining bars.
- `staff._emptyBarCount`: decrement if reverted bar was empty/restOnly.
- `staff.isVisible`: re-derive from `_updateVisibility`.
- `staff.topOverflow / bottomOverflow`: reset to 0; re-run `_registerStaffOverflow` over remaining renderers (today's behaviour via `afterStaffBarReverted` [RenderStaff.ts:180-181](packages/alphatab/src/rendering/staves/RenderStaff.ts#L180) + per-renderer call).
- `staff._sharedLayoutData`: reset (today's `resetSharedLayoutData` [:176, :194-196](packages/alphatab/src/rendering/staves/RenderStaff.ts#L176)).
- `system._accoladeSpacingCalculated`: see §D.8a below.
- `barLayoutingInfo`: discarded along with the `MasterBarsRenderers`.

**§D.8a — `_accoladeSpacingCalculated` and `_calculateAccoladeSpacing`.** Today this gates a once-per-system computation on the **first** `addBars` ([StaffSystem.ts:586](packages/alphatab/src/rendering/staves/StaffSystem.ts#L586)). It reads `staff.calculateHeightForAccolade()` which reads `barRenderers[0].height` ([RenderStaff.ts:290-298](packages/alphatab/src/rendering/staves/RenderStaff.ts#L290)). At first `addBars` time, only one bar exists — its `height` is that bar's intrinsic height after Phase 1.

The contract in v4:
- The accolade spacing is computed off `barRenderers[0]` because that bar is the "tallest representative" used for brace sizing. The choice of which bar is `barRenderers[0]` doesn't change on `revertLastBar` (it's still the first bar added to the system). So accolade spacing computed at first `addBars` remains correct even after reverts.
- BUT: if `firstVisibleStaff` flips on revert (because visibility changed), the brace's vertical span is no longer correctly computed. Step 1c retires the once-shot gate: instead of `_accoladeSpacingCalculated`, the accolade is recomputed at CoordinateAssemble close (after every `addBars` and every `revertLastBar`) **as a function of the model's visibility decision for the current bar set**. This is cheap because the body of `_calculateAccoladeSpacing` is dominated by `canvas.measureText` calls that can be cached on the system once-per-bar-set.

Step 1 splits into 1a/1b/1c:
- **1a** — `firstVisibleStaff` pre-pass: per-system, re-run on every `addBars` and `revertLastBar`. Closes B.5.
- **1b** — `canWrap` from `SimileMark.SecondOfDouble` moves to CoordinateAssemble (model-only decision). Closes B.21.
- **1c** — Accolade-spacing pre-pass: drop `_accoladeSpacingCalculated`. Recompute at CoordinateAssemble close. Closes B.23.

### D.9 Where existing call sites map

| Existing | Target phase |
| --- | --- |
| `BarRendererBase.doLayout` glyph creation | Phase 1 |
| `BarRendererBase._registerLayoutingInfo` | Phase 1 (publish into broker) |
| `BarLayoutingInfo.finish` | CoordinateAssemble (LOCAL seal) |
| `_trackSystemMinDuration` (eager branch) + `reconcileMinDurationIfDirty` | CoordinateAssemble + CoordinateReconcile (SYSTEM seal) |
| `StaffSystem.firstVisibleStaff` | CoordinateAssemble (Step 1a) |
| `bar.canWrap` (`SimileMark.SecondOfDouble`) | CoordinateAssemble (Step 1b) |
| `_calculateAccoladeSpacing` | CoordinateAssemble (Step 1c; gate retired) |
| `BarRendererBase.applyLayoutingInfo` body (minus version skip) | CoordinateAssemble (per-renderer publish; no `_scaleToForce` here after Step 0+9) |
| `BarRendererBase.updateSizes` | called at end of Phase 2 (single-write) |
| `BarRendererBase.scaleToWidth` body — position-computation half | Phase 2 (single call at final width) |
| `BarRendererBase.scaleToWidth` body — skyline-emission half (per-beat overflow probe, pending-effects flush, beam-helper emit, dynamic-glyph emit, subclass emit) | Phase 3 |
| `MultiVoiceContainerGlyph._scaleToForce` calls | one per Phase 2 entry (Step 0 hoist + Step 7 deletes the second call) |
| `BeamingHelper.alignWithBeats` | DELETED (Route B); replaced by Phase 2 eager populate |
| `LineBarRenderer.calculateBeamingOverflows` | Phase 1, rewritten to direct Y math (no cache touch) |
| `LineBarRenderer.initializeBeamDrawingInfo` | Phase 2 (eager populate both directions when needed) |
| `LineBarRenderer.ensureBeamDrawingInfo` | DELETED in callers; paint reads `drawingInfos` directly |
| `BarRendererBase.calculateOverflows` | Phase 3 |
| `BarRendererBase._dynamicSkylineGlyphs` | DELETED |
| `_pendingBeatEffectsByBeat` | DELETED |
| `BarRendererBase.finalizeRenderer` | SystemFinalize sub-step (i) |
| `_finalizeTies` | SystemFinalize sub-step (ii) |
| `_unionBarLocalIntoStaffSkyline` | SystemFinalize sub-step (iii) |
| `EffectSystemPlacement.placeAndApply` outer `needsSecondPass` loop | DELETED (Step 12); inner sampling preserved |
| `HorizontalScreenLayout._alignRenderers` second `scaleToWidth` | DELETED (Step 7) |

---

## §E. Migration plan (18 steps + split sub-steps)

Each step lists: **closes** (review finding closed), **files**, **inventory item retired**, **risk** (low/med/high), **blast radius** (local/structural), **parallelizability**, **acceptance gate**.

### Step 0. Hoist `_scaleToForce` out of the per-voice loop
- Closes: v3-review §"v3 fixed cleanly from v2" Critical 1 carryover.
- Files: [MultiVoiceContainerGlyph.ts:160-167](packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts#L160).
- Retires: precondition for B.1 single-write.
- Risk: low (investigation-confirmed byte-identical PNGs; see Step 0 acceptance below).
- Blast radius: local.
- Parallel: lands first, alone.
- Acceptance: full visual regression suite (byte-identical PNGs) **plus a new unit test** that captures per-voice positions before and after the hoist and asserts equality (closes v3-review Significant #8 — the visual-fixtures-only gate was insufficient).

### Step 1. Restructure system-assembly model-derived state
Split into three independent sub-steps:

- **Step 1a — `firstVisibleStaff` pre-pass.**
  - Closes: v3-review §"items v3 missed" M-pre-pass, v3-review Critical #4 part-a, v3 review Significant #10.
  - Files: [StaffSystem.ts:322, :395](packages/alphatab/src/rendering/staves/StaffSystem.ts#L322), [VerticalLayoutBase.ts:476-534](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L476).
  - Retires: B.5.
  - Risk: low. Recompute per `addBars` and per `revertLastBar`.
  - Acceptance: new visual-test corpus `VisualTests.GhostStaffVisibility` (mid-system revert + `hideEmptyStaves`). MUST be authored as part of Step 1a — if absent at merge, Step 1a is blocked.

- **Step 1b — `canWrap` from `SimileMark` moves to CoordinateAssemble.**
  - Closes: v3-review M2 / B.21 (v3 closed by gesture only).
  - Files: [BarRendererBase.ts:686-688](packages/alphatab/src/rendering/BarRendererBase.ts#L686) (delete the `doLayout`-time flip); [StaffSystem.addBars:375-377](packages/alphatab/src/rendering/staves/StaffSystem.ts#L375) or earlier (read from `bar.simileMark` directly in CoordinateAssemble).
  - Retires: B.21.
  - Risk: low.
  - Acceptance: existing simile-mark visual fixtures byte-identical.

- **Step 1c — Accolade-spacing recomputed at CoordinateAssemble close.**
  - Closes: v3-review Critical #4 (the accolade interaction).
  - Files: [StaffSystem.ts:584-690](packages/alphatab/src/rendering/staves/StaffSystem.ts#L584), [RenderStaff.ts:290-298](packages/alphatab/src/rendering/staves/RenderStaff.ts#L290).
  - Scope: delete `_accoladeSpacingCalculated` gate; cache the `canvas.measureText` results once per system (keyed on track set + stylesheet); recompute the brace and `accoladeWidth` whenever the bar set changes (addBars, revertLastBar).
  - Retires: B.23.
  - Risk: medium. Brace width is consumed by `_applyLayoutAndUpdateWidth`; recomputing mid-assembly must not destabilize the "would this bar fit?" estimator. Acceptance gate: new visual-test corpus `VisualTests.AccoladeOnRevert` exercises a multi-track score where revert flips visibility and brace shrinks.
  - Blast radius: structural.

### Step 2. Drop `BarNumberGlyph` bbox overrides
- Closes: half of B.7.
- Files: [BarNumberGlyph.ts](packages/alphatab/src/rendering/glyphs/BarNumberGlyph.ts).
- Risk: low. Requires Step 1a.
- Parallel: with Step 3, after Step 1a.

### Step 3. Replace `_dynamicSkylineGlyphs` with `populateSkyline?` hook (two phases)
- Closes: v3-review Significant #6 (two dispatch points, per §D.3).
- Files: [Glyph.ts](packages/alphatab/src/rendering/glyphs/Glyph.ts), [BarTempoGlyph.ts](packages/alphatab/src/rendering/glyphs/BarTempoGlyph.ts), [BarRendererBase.ts:216-220, :422-458](packages/alphatab/src/rendering/BarRendererBase.ts#L216).
- Scope: implement two-list dispatch (`_populateSkyline_finalized`, `_populateSkyline_systemFinalize`). Migrate BarTempoGlyph (Phase 3). Reserve SystemFinalize dispatch for Step 16.
- Retires: other half of B.7.
- Risk: low–medium.
- Parallel: yes, after Step 1a.

### Step 4. Fold `_pendingBeatEffectsByBeat` into the beat walk
- Closes: B.6 + B.20.
- Files: [BarRendererBase.ts:143, :281, :387-399](packages/alphatab/src/rendering/BarRendererBase.ts#L281).
- Scope: per-beat effects are appended to a list field on the beat container during Phase 1; the Phase-3 beat walk consumes them inline.
- Risk: low.
- Acceptance: regression test for `MultiBarRestBeatContainerGlyph` (`beatId === -1`) — confirms the new construction has no synthetic-id guard.

### Step 5. Audit `EffectInfo.onAlignGlyphs`; reduce alignGlyphs to one call
- Closes: v3-review Significant #11.
- Files: [TabWhammyEffectInfo.ts:44-60](packages/alphatab/src/rendering/effects/TabWhammyEffectInfo.ts#L44), every consumer of `_sharedLayoutData`, [BarRendererBase.ts:697, :546, :415, :968](packages/alphatab/src/rendering/BarRendererBase.ts).
- Sub-steps:
  - **5a — enumerate every `EffectInfo.onAlignGlyphs` implementation.** Deliverable: a table in code-comments at `EffectBandContainer.alignGlyphs` listing each implementation, classified as `max-of-idempotent` or `stateful`. Today (verified): `TabWhammyEffectInfo.onAlignGlyphs` is the only override; it writes a per-staff "max whammy depth" into `_sharedLayoutData` keyed by staff. This is max-of-idempotent. v4 commits: any future `onAlignGlyphs` implementation that is NOT max-of-idempotent fails CI at this step's lint rule.
  - **5b** — Move `_sharedLayoutData` reset to a single, well-defined point at the start of each layout cycle (today's scatter: `revertLastBar`, `VerticalLayoutBase._resizeAndRenderScore`, `HorizontalScreenLayout`).
  - **5c** — Remove the doLayout-time, applyLayoutingInfo-time, scaleToWidth-time, and `reLayout`-time `alignGlyphs` calls; keep only the Phase-2 call.
- Retires: B.13, B.18 (when 8 lands), B.17 partial.
- Risk: medium. Whammy lifecycle is the subtle case.
- Acceptance: TabWhammy visual fixtures byte-identical.

### Step 6. Idempotent `updateSizes`
- Closes: B.2.
- Files: [BarRendererBase.ts:808](packages/alphatab/src/rendering/BarRendererBase.ts#L808). Drop `+= layoutingInfo.height`.
- Risk: low (today's value is 0).
- Parallel: yes.

### Step 7. Remove `HorizontalScreenLayout._alignRenderers` second `scaleToWidth`
- Closes: v3-review Significant #12; B.8.
- Files: [HorizontalScreenLayout.ts:212-237](packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts#L212).
- Risk: medium. Visual regen across HorizontalScreenLayout tests significant.
- Hard prereq for: Step 13.

### Step 8a. Drop `applyLayoutingInfo` calls from `doLayout`
- Closes: v3-review Critical #2 first half.
- Files: [BarRendererBase.ts:525-551](packages/alphatab/src/rendering/BarRendererBase.ts#L525), [StaffSystem.ts:552-553](packages/alphatab/src/rendering/staves/StaffSystem.ts#L552), every `doLayout` call path.
- Scope: stop bumping `BarLayoutingInfo.version` from `addSpring` (`version` moves only via `recomputeSpringConstants`); the cookie continues to short-circuit.
- Retires: intra-bar B.19 reads.
- Risk: medium.

### Step 8b. Hoist "should I re-apply?" predicate; delete `_appliedLayoutingInfo`
- Closes: v3-review Critical #2 second half.
- Files: [StaffSystem.ts:446-491](packages/alphatab/src/rendering/staves/StaffSystem.ts#L446), [BarRendererBase.ts:510, :526](packages/alphatab/src/rendering/BarRendererBase.ts#L510).
- Retires: B.3, B.18, B.19.
- Risk: medium–high.
- Acceptance: every fixture in [SystemSpacing.test.ts](packages/alphatab/test/visualTests/features/SystemSpacing.test.ts) byte-identical (especially `shared-min-duration-reconciles-on-resize`, `shared-min-duration-multiple-short-arrivals`, `shared-min-duration-per-system-isolation`, `shared-min-duration-page-automatic`).

### Step 9. Single-write `_postBeatGlyphs.x`
- Closes: B.1.
- Files: [BarRendererBase.ts:804, :541, :412](packages/alphatab/src/rendering/BarRendererBase.ts#L412).
- Retires: B.1.
- Risk: medium. Audit `getRatioPositionX` callers (`BarTempoGlyph` migrated by Step 3).
- Prereq: Steps 0, 8a.

### Step 10. Replace `wasFirstOfStaff` / `recreatePreBeatGlyphs` with substate-discard
- Closes: v3-review Critical #4.
- Files: [BarRendererBase.ts:899, :974-994](packages/alphatab/src/rendering/BarRendererBase.ts#L974), [RenderStaff.addBarRenderer:132](packages/alphatab/src/rendering/staves/RenderStaff.ts#L132), [VerticalLayoutBase._resizeAndRenderScore:281](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L281).
- Scope: `_preBeatGlyphs` becomes a Step-11 substate field (see Step 11). On resize, when `isFirstOfStaff` flips, the substate `_preBeatGlyphs` is discarded and rebuilt via a new `createPreBeatGlyphs` call. The dedicated `recreatePreBeatGlyphs` path dies.
- Retires: B.4, B.24.
- Risk: high. Touches resize entry.
- Prereq (HARD): Steps 1a, 8, 11.
- Acceptance: new visual-test corpus `VisualTests.ResizeWrapPointPreBeat`. MUST be authored as part of Step 10.

### Step 11. LayoutCycle substate: per-renderer + per-staff, atomically reassigned per cycle
- Closes: v3-review Critical #4 (the substate contract Step 10 needs) and Critical #5.
- Files: [BarRendererBase.ts](packages/alphatab/src/rendering/BarRendererBase.ts), [RenderStaff.ts](packages/alphatab/src/rendering/staves/RenderStaff.ts).
- Scope: extract per-cycle state into two substate objects.

  Per-renderer `LayoutCycle` (atomically reassigned at every renderer's CoordinateAssemble entry):
  - `_barLocalSkyline`, `_preBeatLocalSkyline`, `_postBeatLocalSkyline`
  - `_pendingBeatEffectsByBeat` *(if not yet deleted by Step 4)*
  - `_ties[]`
  - `_dynamicSkylineGlyphs` *(if not yet deleted by Step 3)*
  - `_contentTopOverflow`, `_contentBottomOverflow`
  - `_appliedLayoutingInfo` *(if not yet deleted by Step 8b — see ordering note)*
  - `beatEffectsMinY`, `beatEffectsMaxY`
  - `isFinalized` *(answer to B.31; resize survives only if substate survives)*
  - `_populateSkyline_finalized`, `_populateSkyline_systemFinalize` *(Step 3 lists)*
  - **`_preBeatGlyphs`** — the field Step 10 needs. Discarded conditionally: only when `isFirstOfStaff` flips between cycles. Otherwise reused (cheap).

  Per-staff `StaffLayoutCycle` (atomically reassigned at every staff's `finalizeStaff` entry on resize):
  - `_sharedLayoutData`
  - `topOverflow`, `bottomOverflow`, `staffTop`, `staffBottom`
  - `_systemSkyline`, `_effectPlacement`

  What does NOT belong to the substate (survives across cycles):
  - `voiceContainer` (Phase-1 content; rebuilt only if `bar` content changes).
  - `helpers` (Phase-1 helpers; reused).
  - `_postBeatGlyphs` (`LeftToRightLayoutingGlyphGroup`; content rebuilt only if model changes).
  - `_multiSystemSlurs` (system-skeleton registry, owned elsewhere).
  - All model refs (`bar`, `staff` after Phase 0).
  - Intrinsic widths published into the broker (those are broker state, sealed at CoordinateReconcile).

- Retires: B.9, B.9b, B.15, B.17, B.22.
- Risk: medium (mechanical but cross-cutting).
- Blast radius: structural.
- **Ordering relative to Step 8b** (v3-review Significant #10): Step 11 lands **after** Step 8b. If Step 11 landed first, the substate-reassign would zero `_appliedLayoutingInfo` on every cycle and force re-application of `applyLayoutingInfo` on every renderer on every resize — a perf regression even if value-idempotent ([reconcile-min-duration.md §3](./investigations/reconcile-min-duration.md)). After Step 8b deletes the cookie, this consideration is moot. DAG fixes this.

### Step 12. SystemFinalize sub-phase split: 4 sub-steps, in order
- Closes: v3-review Critical #3 (sub-phase ordering).
- Files: [RenderStaff.finalizeStaff:308](packages/alphatab/src/rendering/staves/RenderStaff.ts#L308), [BarRendererBase._finalizeTies:600-637](packages/alphatab/src/rendering/BarRendererBase.ts#L600), [BarRendererBase.finalizeRenderer:642-662](packages/alphatab/src/rendering/BarRendererBase.ts#L642), [EffectSystemPlacement.ts:31-44](packages/alphatab/src/rendering/EffectSystemPlacement.ts#L31).
- Scope:
  - Split `finalizeRenderer` into `finalizeRendererMinusTies` (sub-step i) and the tie-write portion (sub-step ii).
  - `RenderStaff.finalizeStaff` becomes a four-loop sequence (i)-(iv) per §D.6.
  - Cross-renderer `GroupedEffectGlyph` `populateSkyline?` (Step 16) is dispatched in sub-step (ii) — chain walk is valid because every renderer.isFinalized was set in sub-step (i).
  - `needsSecondPass` outer loop deleted; inner `placeAndApply` before/after sampling preserved.
- Retires: B.12, B.14 (outer loop), B.31 (`isFinalized` is per-cycle via Step 11's substate).
- Risk: medium. Contract change is invocation-order; per-bar skyline writes preserved.
- Prereq: Step 11.
- Acceptance: cross-system slur and bend-up arc visual fixtures byte-identical; multi-bar tied-note arcs that overflow above the staff — verify `topEffects.height` attribution unchanged.

### Step 13. Three-phase API split (Intrinsic / Spaced / Finalized) + Coordinate two-step
- Closes: closes C-1; collapses lifecycle to D.1.
- Files: [BarRendererBase.ts](packages/alphatab/src/rendering/BarRendererBase.ts) (rewrite `doLayout` / `applyLayoutingInfo` / `scaleToWidth` / `calculateOverflows` / `finalizeRenderer` into `intrinsicLayout` / `coordinateAssemblePublish` / `spacedLayout` / `finalize`). Every subclass.
- Scope (subclass override surface):

  | Method | New phase |
  | --- | --- |
  | `calculateBeamingOverflows` (LineBarRenderer) | Phase 1 (direct Y math; no `drawingInfos` touch — Route B) |
  | `initializeBeamDrawingInfo` (LineBarRenderer) | Phase 2 (eager-populate both directions) |
  | `ensureBeamDrawingInfo` (callers) | DELETED |
  | `emitHelperSkyline` | Phase 3 |
  | `emitBeatSkyline` | Phase 3 |
  | `emitSubclassBarLocalSkyline` | Phase 3 |
  | `completeBeamingHelper` | Phase 1 (called from `helpers.beamHelpers[*].finish()`) |
  | `paintTuplets` | Paint (unchanged; reads `drawingInfos[tuplet]` populated eagerly in Phase 2) |
  | `paintBar` | Paint |

- Critical 1 fix is encoded here. **`spacedLayout()` MUST NOT contain any `barLocalSkyline.insert*` call** (or `insertSkylineTop/Bottom`, or `_pendingBeatEffectsByBeat` write, or `_dynamicSkylineGlyphs` emit). The grep-checkable invariant is in §H.
- Retires: C-1.
- Risk: high (largest step).
- Prereq (HARD): Steps 0, 7, 8a, 8b, 11.

### Step 14. Audit `Glyph.getBoundingBox*` for strict-geometric purity
- Closes: C-4 (audit).
- Files: every glyph subclass overriding `getBoundingBox*`.
- Scope: every override is either (a) pure function of glyph fields, or (b) declared as `populateSkyline?`-only contributor (no bbox override). `GroupedEffectGlyph.getBoundingBoxRight` is **kept** as it returns a defensible local quantity (the start-beat's end-x); the cross-renderer end-X correction is in Step 16's `populateSkyline?` dispatch, not in bbox.
- Risk: medium.
- Prereq: Step 13.

### Step 15. Replace `_sharedLayoutData` string map with typed staff-state container
- Closes: B.17 final cleanup.
- Files: [RenderStaff.ts:24, :109-118](packages/alphatab/src/rendering/staves/RenderStaff.ts#L109), every `get/setSharedLayoutData` consumer.
- Risk: low–medium.
- Prereq: Steps 5, 11.

### Step 16. SystemFinalize as `EffectBand.computeLocalXRange` validity phase; `GroupedEffectGlyph` chain-walk
- Closes: v3-review Critical #5 (B.25 mechanism corrected); v3-review Significant #14.
- Files: [EffectBand.ts:251-294](packages/alphatab/src/rendering/EffectBand.ts#L251), [GroupedEffectGlyph.ts:20-25, :31-37, :60-79](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L20).
- Scope:
  - `EffectBand.computeLocalXRange` validity phase: SystemFinalize sub-step (ii).
  - `GroupedEffectGlyph` implements `populateSkyline?(phase='systemFinalize', ...)`. The implementation walks `isLinkedWithNext` (which checks `nextGlyph.renderer.isFinalized` — true after sub-step (i)) to the chain tail, then computes the true end-X as `lastLinkedGlyph.renderer.x + lastLinkedGlyph.renderer.getBeatX(lastLinkedGlyph.beat, this.endPosition) − this.renderer.x`. This is published into the band via a `band.publishSpanRange(this, startX, trueEndX)` call, which `computeLocalXRange` then reads.
  - **Mechanism note (corrected from v3).** `getBoundingBoxRight` itself does NOT read a foreign `endBeat`. It reads `this.renderer.getBeatX(this.beat, this.endPosition)` — the start beat's end-x in the local renderer ([GroupedEffectGlyph.ts:20-25](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L20)). The walk machinery is `isLinkedWithNext` ([:31-37](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L31)) + `nextGlyph`, mirroring `paint`'s existing traversal at [:50-67](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L50).
- Retires: B.25.
- Risk: low (mostly documentation + one `populateSkyline?` implementation that reuses `paint`'s existing chain-walk).
- Prereq: Steps 3, 13.

### Step 17. Retire `BeamingHelper.alignWithBeats`; Route B
- Closes: v3-review Significant #9; B.11.
- Files: [BeamingHelper.ts:109-119](packages/alphatab/src/rendering/utils/BeamingHelper.ts#L109), [LineBarRenderer.ts:1017-1163](packages/alphatab/src/rendering/LineBarRenderer.ts#L1017).
- Scope: implement Route B (§D.5). Delete `alignWithBeats`. Rewrite `calculateBeamingOverflows` to do its own beam-Y math via `getFlagTopY` / `getFlagBottomY` / max-slope clamp without touching `drawingInfos`. In Phase 2's `initializeBeamDrawingInfo`, populate `drawingInfos[canonical]` and conditionally `drawingInfos[tuplet]` per the §D.5 predicate.
- Retires: B.11.
- Risk: medium (tuplet bracket visuals across the score suite).
- Prereq: Step 13.

### Dependency graph (DAG)

```
       Step 0  Step 1a  Step 1b  Step 1c  Step 6  Step 4  Step 5a
          \      /         \       \       \      /        \
           \    /           \       \       \    /          \
            \ /              \       \       \ /             \
        Step 2 (after 1a)   Step 3 (after 1a)  Step 5b  Step 7  Step 8a
                  \             |              /        |       /
                   \            |             /         |      /
                    \           |            /          |     /
                     \         Step 5c                  |    /
                      \         |                       |   /
                       \------ Step 8b -----------------+
                                        \              /
                                         \            /
                                          Step 11 -- Step 9 -- Step 10 -- Step 12
                                                                                 \
                                                                            Step 13
                                                                          /   |    \
                                                                  Step 14  Step 16  Step 17
                                                                          (after 13)
                                                                       Step 15 (after 5, 11)
```

Hard prereqs:
- Step 13 ⇐ {0, 7, 8a, 8b, 11}.
- Step 10 ⇐ {1a, 8a, 8b, 11}.
- Step 12 ⇐ Step 11.
- Step 16 ⇐ {3, 13}.
- Step 17 ⇐ Step 13.
- Step 11 ⇐ Step 8b (perf-only ordering; see Step 11 above).

Parallelizable clusters:
- **α** (first wave, all low-risk, low-blast): Step 0; Step 1a/1b/1c (each independent); Step 6; Step 4; Step 5a (audit).
- **β** (after α): Steps 2, 3; Steps 5b, 5c; Step 7; Step 8a.
- **γ** (after β): Step 8b.
- **δ**: Step 11 (gates the rest).
- **ε** (post 11): Steps 9, 10, 12.
- **ζ** (post 12 + 13): Steps 14, 15, 16, 17.

---

## §F. Decision points

### F.1 Is `Glyph.getBoundingBox*` permitted to be dynamic?
**Strict.** Bbox is a pure function of glyph fields set in `doLayout` and (where applicable) by Phase-2 position-publication on the glyph's owning container. The `populateSkyline?` hook is the only seam for layout-state-dependent contributions. Confirmed by Step 14 audit.

### F.2 Is the resize path structurally identical to initial layout?
**Identical phase sequence; Phase 1 is a no-op (Phase 1 output survives via non-substate fields).** Pre-beat content rebuild on resize (when bar moves to/from `isFirstOfStaff`) lives in Step 10's conditional substate-discard; not in a separate code path.

### F.3 Where does `BarLayoutingInfo` live?
**Stays as a sealed cross-bar broker on `MasterBarsRenderers`.** v4 does NOT push to `MasterBarLayout`. Deferred to §G.1.

### F.4 What's the contract for cross-bar glyphs (ties, multi-system slurs)?
**(a).** Hoist `_finalizeTies` invocation to SystemFinalize sub-step (ii); keep per-bar skyline writes (preserves placement attribution mechanic). System-level slur registry is a possible later evolution.

### F.5 What's the contract for `EffectBand.computeLocalXRange`?
**Valid after SystemFinalize sub-step (ii).** `GroupedEffectGlyph` migrates its cross-renderer end-X to a `populateSkyline?` dispatched in sub-step (ii). Documented in Step 16.

---

## §G. Research backlog (after investigations)

### G.1 `MasterBarLayout` ownership refactor (F.3 deferred)
Pushing `BarLayoutingInfo` from a broker to a `StaffSystem`-owned object eliminates the temptation to mutate post-Coordinate. Cost ~ Step 13-scale; benefit incremental.

### G.2 Two-pass-per-system finalization (alternative to CoordinateReconcile)
[reconcile-min-duration.md §5](./investigations/reconcile-min-duration.md) discusses a two-pass model that collects all bars then runs `finish` + `applyLayoutingInfo` once per renderer. Blocker: `addBars` consumes incremental width for `systemIsFull` ([VerticalLayoutBase.ts:503](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L503)). A different "would this bar fit?" estimator is needed.

### G.3 Beam Y stability across staff effect placement
v2 §H asked whether beam drawingInfo Y values are stable across SystemFinalize. v4 keeps the answer "yes; beam Y is in renderer-local content coords and effect placement shifts renderer-y not content-y." If a future feature breaks this, `drawingInfos` must be refreshed.

### G.4 `MultiBarRest` voice-container intrinsic publish
v3-review §17 / B.20 noted `beatId === -1` interacts with `_pendingBeatEffectsByBeat`. Step 4 deletes the queue. Confirm no other guarded code paths rely on the synthetic id.

### G.5 Step 1a acceptance — `revertLastBar` corpus
`VisualTests.GhostStaffVisibility` MUST be authored as part of Step 1a (not pre-existing). The corpus must include: multi-staff scores with `hideEmptyStaves`; mid-system revert flipping a previously-only-rest staff to visible; resize across the revert.

### G.6 Step 10 acceptance — wrap-point-changing resize corpus
`VisualTests.ResizeWrapPointPreBeat` MUST be authored as part of Step 10.

### G.7 Step 1c acceptance — accolade-on-revert corpus
`VisualTests.AccoladeOnRevert` MUST be authored as part of Step 1c. Multi-track score where revert changes visible staves; brace shrinks; `accoladeWidth` reflects the new visibility.

### G.8 `EffectSystemPlacement.placeAndApply` second-pass branch dies — confirm no other consumer
Confirm no test fixture relies on the second pass producing a different result than the first.

### G.9 `_postBeatGlyphs` discard contract on schema/content changes (Step 11 boundary)
`_postBeatGlyphs` is NOT in Step 11's substate (it's Phase-1 content). But if a track's bar-line policy changes between cycles (e.g. via a settings flip), the post-beat content list may need rebuilding. Today this is handled by re-running `doLayout` from scratch on the affected renderer (cycle-invalidating change). v4 keeps this contract; flagged for documentation in the public migration notes.

---

## §H. Invariants gained at each step

Every row is grep-checkable, assertion-checkable, or testable.

| Step | Invariant | How to verify |
| --- | --- | --- |
| 0 | `_scaleToForce` called at most twice per bar per cycle (was N+1) | grep `_scaleToForce(` in `MultiVoiceContainerGlyph.ts` + `BarRendererBase.ts`: count = 2 (one per file) |
| 1a | `system.firstVisibleStaff` final before any renderer's `doLayout` reads it; re-derived from model on revert | unit: assemble system, revert, assert `firstVisibleStaff` matches model-only pre-pass |
| 1b | `bar.canWrap` set from `SimileMark.SecondOfDouble` happens in CoordinateAssemble, not `doLayout` | grep `SimileMark.SecondOfDouble` in `BarRendererBase.ts` doLayout block: zero occurrences |
| 1c | Accolade width recomputed at CoordinateAssemble close on every `addBars`/`revertLastBar`; gate `_accoladeSpacingCalculated` deleted | grep `_accoladeSpacingCalculated`: zero occurrences |
| 2 | `BarNumberGlyph.getBoundingBox*` is a pure function of glyph fields | unit: vary renderer state, assert bbox unchanged |
| 3 | The set of glyphs with dynamic-skyline contribution is enumerated by `_populateSkyline_finalized` + `_populateSkyline_systemFinalize` | grep for `_dynamicSkylineGlyphs`: zero occurrences |
| 4 | Beat-effect overflow registration inline during beat creation; no per-cycle list survives Phase 1 | grep `_pendingBeatEffectsByBeat`: zero occurrences |
| 5 | `EffectBand` glyph x set exactly once per cycle; `onAlignGlyphs` runs exactly once; `_sharedLayoutData` reset at a single, documented point | grep `alignGlyphs(` in `BarRendererBase.ts`: exactly 2 call sites (top + bottom band, one place); reset point lint rule |
| 6 | `renderer.height` set, never accumulated | grep `this.height +=` in `BarRendererBase.ts`: zero occurrences |
| 7 | `BarRendererBase.scaleToWidth` body runs at most once per renderer per cycle, at final width | runtime assertion: counter on `scaleToWidth` entry, must equal 1 per cycle |
| 8a | `applyLayoutingInfo` never called from inside `doLayout`; `BarLayoutingInfo.version` bumps only via `recomputeSpringConstants` | grep `applyLayoutingInfo()` in `BarRendererBase.doLayout`: zero; grep `version++` in `BarLayoutingInfo.ts`: only in `recomputeSpringConstants` |
| 8b | The "should I re-apply" decision lives in `reconcileMinDurationIfDirty`; `_appliedLayoutingInfo` deleted | grep `_appliedLayoutingInfo`: zero occurrences |
| 9 | `_postBeatGlyphs.x = ...` happens exactly once per cycle (end of Phase 2) | grep `_postBeatGlyphs.x =` in `BarRendererBase.ts`: exactly 1 occurrence (in `spacedLayout`) |
| 10 | Resize requires no per-renderer flag to decide pre-beat rebuild; substate discard subsumes | grep `wasFirstOfStaff`, `recreatePreBeatGlyphs`: zero occurrences |
| 11 | Renderer + staff per-cycle state captured in two substate objects, atomically reassigned per cycle | code search: per-cycle fields are accessed via `this._cycle.X` / `this._staffCycle.X`; no direct assignment of those fields outside `LayoutCycle.reassign` |
| 12 | SystemFinalize is 4 explicit sub-steps in order (i)-(iv) per §D.6; `placeAndApply` runs exactly once per staff per cycle | unit: instrument `finalizeStaff`, assert sub-step order and `placeAndApply` call count = 1 |
| 13 | The phase contract from §D.2 holds. **`spacedLayout()` contains zero `barLocalSkyline.insert*` reachable calls.** | grep `insertSkylineTop\|insertSkylineBottom\|barLocalSkyline.insert` reachable from `spacedLayout`: zero |
| 14 | `Glyph.getBoundingBox*` is provably pure (function of glyph fields) across the entire glyph hierarchy | audit doc: every override classified |
| 15 | Staff-level cross-bar state is typed; no stringly-keyed bag | grep `getSharedLayoutData\|setSharedLayoutData`: zero occurrences |
| 16 | `EffectBand.computeLocalXRange` has documented SystemFinalize validity; Span-category cross-renderer end-X correct | unit: cross-renderer GroupedEffectGlyph span; assert published end-X equals chain-walk computation |
| 17 | `BeamingHelper.drawingInfos` populated exactly once per cycle (in Phase 2); read-only thereafter; paint never mutates | grep `alignWithBeats`: zero occurrences; grep `drawingInfos.clear()`: only in `initializeBeamDrawingInfo` (the populate path) |

**Spot-check of three invariants for verifiability** (per the meta-prompt's requirement):
- Step 0: `git grep -n '_scaleToForce(' packages/alphatab/src/` should yield 2 occurrences after the step lands. Today it yields more (the per-voice loop body + the direct call). ✓ Verifiable by `grep`.
- Step 13: `git grep -n 'barLocalSkyline\.insert\|insertSkylineTop\|insertSkylineBottom' packages/alphatab/src/rendering/BarRendererBase.ts` should show all inserts inside `finalize()` (Phase 3); none inside `spacedLayout()`. ✓ Verifiable by `grep` plus a one-shot AST check that the only callers of `barLocalSkyline.insert*` are in the Phase-3 method.
- Step 12: instrument `RenderStaff.finalizeStaff` with sub-step counters; assert via test that each sub-step runs exactly once per cycle per staff and that `_finalizeTies` runs strictly between sub-step (i) and sub-step (iii). ✓ Verifiable by unit test.

---

## §I. Findings disposition (v3 review review traceability)

For each item in the v3 review, this section names the v4 §E step / §D section that closes it.

### Critical (v3-review §Critical 1-5)

| # | Finding | v4 closure |
| --- | --- | --- |
| C1 | §D.2 / §D.7 / §D.9 contradict on skyline emission phase | §D.2 split row for `barLocalSkyline` (content vs tie overlay); §D.7 explicit Phase-3-only emit; §D.9 split `scaleToWidth` body across Phase 2 and Phase 3; §H Step 13 grep-checkable invariant. |
| C2 | Step 11 scope omits `_preBeatGlyphs` | Step 11 explicitly includes `_preBeatGlyphs` (conditionally discarded when `isFirstOfStaff` flips); explicit "survives vs reassigned" matrix. |
| C3 | Step 12 doesn't pin tie ordering inside SystemFinalize | §D.6 four-sub-step ordering table; Step 12 scope spells out (i)-(iv); §H Step 12 invariant test. |
| C4 | Step 1 vs `_calculateAccoladeSpacing` unresolved | Step 1 split into 1a (pre-pass), 1b (canWrap), 1c (accolade re-compute, gate retired). §D.8a contract; §G.7 acceptance corpus. |
| C5 | §B.25 `GroupedEffectGlyph` mechanism wrong | §B.25 rewritten with correct mechanism (`this.renderer.getBeatX(this.beat, this.endPosition)` + `nextGlyph` chain walk). Step 16 references `isLinkedWithNext` traversal. |

### Significant (v3-review §6-§12)

| # | Finding | v4 closure |
| --- | --- | --- |
| 6 | `populateSkyline?` lifecycle under-specified | §D.3 two-dispatch-point design with `phase` ctx field; Step 3 implements both lists. |
| 7 | BarTempoGlyph hook justification doesn't survive Step 9 | §D.3 "On BarTempoGlyph's hook participation" paragraph: bbox-stability is Step 9's claim; emission-timing is the hook's independent reason. |
| 8 | Step 0 byte-identical claim lacks unit-test gate | Step 0 acceptance now includes a unit test for `MultiVoiceContainerGlyph.applyLayoutingInfo` per-voice equality. |
| 9 | Route B eager-populate predicate not spelled out | §D.5 pseudocode for `initializeBeamDrawingInfo` with explicit `getTupletBeamDirection !== getBeamDirection` guard. |
| 10 | Resize Phase-1-no-op + `_appliedLayoutingInfo` carry-over perf | Step 11 sequenced **after** Step 8b in the DAG; §E hard-prereq table notes the ordering. |
| 11 | Step 5 audit deliverable vague | Step 5a explicit deliverable: enumerate every `EffectInfo.onAlignGlyphs` impl; today's audit result documented (only `TabWhammyEffectInfo`; max-of-idempotent). |
| 12 | §I (v3) §13-18 hand-waved | §I (v4) below adds row per Minor; see table next. |

### Minor (v3-review §13-§18)

| # | Finding | v4 closure |
| --- | --- | --- |
| 13 | §A.1 `alignGlyphs` "4× on resize" position unspecified | §A.1 table now cites line numbers for each of #1-#4; Step 5 spells out the single-call placement (Phase 2 entry, after positions sealed). §H Step 5 grep-check. |
| 14 | B.9 reset list misleading re `_appliedLayoutingInfo` survival | B.9 annotated "(retired in Step 8b)" inline. |
| 15 | §D.4 "perf-only confirmed" oversimplifies | §D.4 prose now includes the precondition: "perf-only against current code, BUT current callers depend on it; deletable only after Step 8b hoists the predicate." |
| 16 | §H Steps 13/17 mutually testable only after C1 resolved | §H Step 13 reframed as a grep on `spacedLayout()`; Step 17 unchanged. The mutual-testability concern is removed because C1 is closed. |
| 17 | §J test corpora named but not authored | §G.5-G.7 explicitly state "MUST be authored as part of step X"; §J (v4 below) reflects. |
| 18 | (not present in v3 review; placeholder) | n/a |

### Items v3 missed (v3-review §"Items v3 missed" M1-M10)

| # | Finding | v4 closure |
| --- | --- | --- |
| M1 | `additionalMultiRestBars` not in §B / §D.2 | B.26 added; §D.2 row "(Build-input)"; C-7 cluster. |
| M2 | `Bar.simileMark === SecondOfDouble` flip in `doLayout` | Step 1b retires explicitly; §H Step 1b grep-check. |
| M3 | `MultiBarRestGlyph` paint extent | §D.2 voiceContainer / beat-container x rows clarified (intrinsic until CoordinateReconcile; final at Phase 2). The multi-bar-rest synthetic container is bounded by the same contract — Step 4 retires the `beatId === -1` guard so no special-case remains. |
| M4 | `isLinkedToPrevious` not in §D.2 | B.27 added; §D.2 row "(Phase-1 output)"; C-7. |
| M5 | `computedWidth` vs `width` divergence | B.28 added; §D.2 two separate rows. |
| M6 | `MasterBarBounds` / `BarBounds` validity phase | B.29 added; §D.2 row "Paint (post-SystemFinalize)". |
| M7 | `addBars`/`revertLastBar` loop not CoordinateAssemble in v3 | B.30 added; §D.8 revert rollback set spelled out; CoordinateAssemble is now explicitly the per-`addBars` AND per-`revertLastBar` driver. |
| M8 | Multi-track `_sharedLayoutData` per-staff scope | C-6 cluster notes "per-staff broker is OK because no cross-track-staff effect exists today; if added in future, refactor to system-scope." Step 15 (typed container) bakes the per-staff scope into the type signature. |
| M9 | SystemFinalize sub-step ordering (same as C3) | Covered by C3 / §D.6 four-sub-step table. |
| M10 | `isFinalized` survives barsPerRow-active resize | B.31 added; Step 11 substate moves `isFinalized` to per-cycle; Step 12 sub-step (i) sets it from a fresh cycle. |

---

## §J. Sign-off checklist (v4)

Every Critical and Significant from the v3 review, with the v4 step / section that closes it.

### Critical

| # | Finding | v4 closure |
| --- | --- | --- |
| C1 | §D.2 / §D.7 / §D.9 contradict on skyline emission phase | §D.2 row split (content vs tie overlay); §D.7 Phase-3-only emit; §D.9 split `scaleToWidth` body; §H Step 13 grep invariant |
| C2 | Step 11 scope omits `_preBeatGlyphs` | Step 11 scope includes `_preBeatGlyphs` (conditional discard); explicit "survives vs reassigned" matrix |
| C3 | Step 12 doesn't pin SystemFinalize sub-phase ordering | §D.6 four-sub-step ordering table; Step 12 scope; §H Step 12 invariant |
| C4 | Step 1 vs `_calculateAccoladeSpacing` unresolved | Step 1a/1b/1c split; §D.8a contract; §G.7 acceptance corpus |
| C5 | §B.25 mechanism wrong | §B.25 rewritten with `nextGlyph` / `isLinkedWithNext` traversal; Step 16 fix |

### Significant

| # | Finding | v4 closure |
| --- | --- | --- |
| S6 | `populateSkyline?` lifecycle | §D.3 two-dispatch-point design; Step 3 |
| S7 | BarTempoGlyph hook justification | §D.3 "BarTempoGlyph's hook participation" paragraph |
| S8 | Step 0 byte-identical assertion gate | Step 0 acceptance: new unit test |
| S9 | Route B eager-populate predicate | §D.5 pseudocode + explicit predicate |
| S10 | Step 11 / Step 8b perf ordering | DAG: Step 11 after Step 8b |
| S11 | Step 5 audit deliverable | Step 5a explicit enumerate-and-classify deliverable |
| S12 | v3 §I §13-§18 hand-waved | §I (v4) explicit per-Minor table |

### Items v3 missed

| # | Finding | v4 closure |
| --- | --- | --- |
| M1 | `additionalMultiRestBars` | B.26 + §D.2 row + C-7 |
| M2 | SimileMark flip in `doLayout` | Step 1b |
| M3 | `MultiBarRest` paint extent | §D.2 row + Step 4 |
| M4 | `isLinkedToPrevious` | B.27 + §D.2 row + C-7 |
| M5 | `computedWidth` vs `width` | B.28 + §D.2 separate rows |
| M6 | `MasterBarBounds` / `BarBounds` | B.29 + §D.2 row |
| M7 | revert-as-CoordinateAssemble driver | B.30 + §D.8 |
| M8 | Multi-track `_sharedLayoutData` scope | C-6 note + Step 15 typed container |
| M9 | SystemFinalize sub-step ordering | Same as C3 / §D.6 |
| M10 | `isFinalized` cross-cycle | B.31 + Step 11 + Step 12 (i) |

### Minor

| # | Finding | v4 closure |
| --- | --- | --- |
| Min13 | `alignGlyphs` call-site placement | §A.1 line-cited; Step 5; §H Step 5 invariant |
| Min14 | B.9 `_appliedLayoutingInfo` annotation | B.3, B.9 annotated "(retired in Step 8b)" |
| Min15 | §D.4 prose oversimplifies perf-only | §D.4 expanded prose |
| Min16 | §H Steps 13/17 mutual testability | §H Step 13 reframed grep-check |
| Min17 | Test corpora authored vs named | §G.5–G.7 explicit "MUST be authored at step X" |

If every Critical and Significant row above closes against a substantive §E step or §D section, v4 is implementable. Spot-checking three random rows: C1 → §D.2 row split + §H Step 13 grep-check (verifiable); C4 → Step 1a/1b/1c distinct deliverables (verifiable); S10 → DAG ordering Step 11 after Step 8b (explicit in §E "Dependency graph"). All three pass.

---

## Appendix: cited files

- [`packages/alphatab/src/rendering/BarRendererBase.ts`](packages/alphatab/src/rendering/BarRendererBase.ts) — lifecycle core.
- [`packages/alphatab/src/rendering/staves/RenderStaff.ts`](packages/alphatab/src/rendering/staves/RenderStaff.ts) — staff loop, overflow accumulators, shared data.
- [`packages/alphatab/src/rendering/staves/StaffSystem.ts`](packages/alphatab/src/rendering/staves/StaffSystem.ts) — system assembly, min-duration reconcile, accolade spacing.
- [`packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts`](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts) — cross-bar broker, version, recomputeSpringConstants.
- [`packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts`](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts) — `_fitSystem`, `_resizeAndRenderScore`, `_createStaffSystem`.
- [`packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts`](packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts) — `_scaleBars`, `_alignRenderers`, opt-out switch.
- [`packages/alphatab/src/rendering/utils/BeamingHelper.ts`](packages/alphatab/src/rendering/utils/BeamingHelper.ts) — `finish`, `alignWithBeats`, `drawingInfos`.
- [`packages/alphatab/src/rendering/LineBarRenderer.ts`](packages/alphatab/src/rendering/LineBarRenderer.ts) — `initializeBeamDrawingInfo`, `ensureBeamDrawingInfo`, `calculateBeamingOverflows`, `emitHelperSkyline`.
- [`packages/alphatab/src/rendering/EffectSystemPlacement.ts`](packages/alphatab/src/rendering/EffectSystemPlacement.ts) — `placeAndApply`, before/after sampling.
- [`packages/alphatab/src/rendering/EffectBand.ts`](packages/alphatab/src/rendering/EffectBand.ts) — `computeLocalXRange`.
- [`packages/alphatab/src/rendering/EffectBandContainer.ts`](packages/alphatab/src/rendering/EffectBandContainer.ts) — `alignGlyphs`.
- [`packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts`](packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts) — `_scaleToForce`, `applyLayoutingInfo`.
- [`packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts`](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts) — chain-walk via `isLinkedWithNext` + `nextGlyph`.
- [`packages/alphatab/src/rendering/glyphs/BarNumberGlyph.ts`](packages/alphatab/src/rendering/glyphs/BarNumberGlyph.ts), [`BarTempoGlyph.ts`](packages/alphatab/src/rendering/glyphs/BarTempoGlyph.ts) — historically-dynamic glyphs.
- [`packages/alphatab/src/rendering/glyphs/LeftToRightLayoutingGlyphGroup.ts`](packages/alphatab/src/rendering/glyphs/LeftToRightLayoutingGlyphGroup.ts) — empty `doLayout` (B.24).
- [`packages/alphatab/src/rendering/effects/TabWhammyEffectInfo.ts`](packages/alphatab/src/rendering/effects/TabWhammyEffectInfo.ts) — sole `onAlignGlyphs` writer (B.17 / Step 5a).
- [`packages/alphatab/test/visualTests/features/SystemSpacing.test.ts`](packages/alphatab/test/visualTests/features/SystemSpacing.test.ts) — Step 8b acceptance corpus.

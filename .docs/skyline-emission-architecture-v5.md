# Bar-renderer lifecycle audit and target architecture — v5

> **Status.** Implementation-sign-off iteration, responding to [v4 review](./skyline-emission-architecture-v4-review.md). The v4 review identified 2 Critical findings, 4 Significant findings, 3 Minor findings, and 2 items v4 missed. v5 closes all of them so v6 has nothing left to find. The macro architecture from v4 (five named phases, four-substep SystemFinalize, two-step Coordinate) is unchanged; v5 is a focused edit pass that tightens contracts the implementer would trip over.

> v5 is the **single source of truth** for the migration. It is readable cold — no prior version needs to be open in another tab. v1 (`skyline-emission-architecture-v1.md`), v2 (`skyline-emission-architecture.md`), v3 (`skyline-emission-architecture-v3.md`), and v4 (`skyline-emission-architecture-v4.md`) are historical. Investigations remain authoritative: [`beam-helper-drawinginfos.md`](./investigations/beam-helper-drawinginfos.md), [`scale-to-force-multi-call.md`](./investigations/scale-to-force-multi-call.md), [`reconcile-min-duration.md`](./investigations/reconcile-min-duration.md).

> **File refs.** `[file.ts:NNN](packages/...)`.

> **What v5 changes from v4.** Six paragraph-scale fixes inside existing §E steps. (1) Step 1c is rewritten around the load-bearing accumulation problem: `_calculateAccoladeSpacing` mutates `system.width`, `system.computedWidth`, `system.accoladeWidth`, and `staff.y` via `+=` accumulators ([StaffSystem.ts:673-690](packages/alphatab/src/rendering/staves/StaffSystem.ts#L673)); naive recompute-without-gate accumulates. v5 specifies idempotent assignment rather than `+=` and folds v4's Step 1a into Step 1c (today's code already recomputes `firstVisibleStaff` on each `addBars`/`revertLastBar`, so the v4 Step 1a framing was a no-op — the real B.5 bug is `_calculateAccoladeSpacing`'s first-call timing). (2) §D.3's `populateSkyline?` hook drops the `target` parameter; the hook signature is `populateSkyline(ctx)` and the implementer pulls its write destination from `ctx`, because Step 16's GroupedEffectGlyph use case publishes to an `EffectBand` (not to `barLocalSkyline`). (3) Step 11 adds a third substate tier — `SystemLayoutCycle` — covering the nine per-system accumulators (`width`, `computedWidth`, `totalFixedOverhead`, `totalContentWidth`, `totalBarDisplayScale`, `accoladeWidth`, `firstVisibleStaff`, `minDuration`, `isMinDurationDirty`) so revert and resize roll back atomically. (4) §H Step 0 / Step 8a / Step 13 grep invariants are reworded so they verify against actual code shape. (5) §D.2's `renderer.y` row reflects the Phase-2 write at [VerticalLayoutBase.ts:462](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L462) (Step 13 retires the Phase-2 write). (6) §B.16 / §A.2 clarify `BarLayoutingInfo` is owned by `MasterBarsRenderers`, not `StaffSystem`. A new §B.32 documents `EffectBand.finalizeBand`'s SystemFinalize-substep-(iv) mutation, and §D.2 has a row for `EffectBand.height`.

---

## TL;DR

Today, bar layout is a sequence of partial passes; each pass finalizes a slightly different subset of state, later passes re-mutate values an earlier pass had "set," and glyphs work around this by capturing reads at the wrong time and re-reading later through `getBoundingBox*` — turning bbox into a covert dynamic-state oracle.

The target architecture has five named phases (Build → Intrinsic → CoordinateAssemble → CoordinateReconcile → Spaced → Finalized → SystemFinalize), each with an immutable contract over a precise set of fields. The migration is 17 steps in a published DAG (v4's Step 1a is folded into Step 1c in v5; the v4 numbering otherwise stands), of which 5 are landmark restructures (Steps 8b, 10, 11, 12, 13) and the rest are local cleanups.

The four structural commitments that distinguish this architecture from incremental cleanups:

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
- `StaffSystem.addBars` ([StaffSystem.ts:333-411](packages/alphatab/src/rendering/staves/StaffSystem.ts#L333)) creates a fresh `MasterBarsRenderers` and assigns its `layoutingInfo = new BarLayoutingInfo()` at [:340](packages/alphatab/src/rendering/staves/StaffSystem.ts#L340) — the broker is owned by `MasterBarsRenderers` ([MasterBarsRenderers.ts:39](packages/alphatab/src/rendering/staves/MasterBarsRenderers.ts#L39)), not by `StaffSystem`. It then iterates staves, collects visibility, sets `firstVisibleStaff`, calls `_calculateAccoladeSpacing(tracks)` (first call only, gated by `_accoladeSpacingCalculated` [:586](packages/alphatab/src/rendering/staves/StaffSystem.ts#L586)), calls `barLayoutingInfo.finish()`, then `_trackSystemMinDuration` (eager reconcile branch when this bar has a shorter min than the system's), then `_applyLayoutAndUpdateWidth` (which runs `applyLayoutingInfo` on each renderer).
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
Owner: `MasterBarsRenderers.layoutingInfo` ([MasterBarsRenderers.ts:39](packages/alphatab/src/rendering/staves/MasterBarsRenderers.ts#L39)); allocated by `StaffSystem.addBars` at [StaffSystem.ts:340](packages/alphatab/src/rendering/staves/StaffSystem.ts#L340) and handed to each new renderer at [RenderStaff.ts:164](packages/alphatab/src/rendering/staves/RenderStaff.ts#L164). `StaffSystem` *iterates* `masterBarsRenderers[].layoutingInfo` via `_trackSystemMinDuration` and `reconcileMinDurationIfDirty` but does not own it. Cluster: **C-3**. Cross-bar broker. v5 keeps the broker on `MasterBarsRenderers` but adds CoordinateAssemble (local seal) + CoordinateReconcile (system seal). The ownership-relocation refactor (`MasterBarLayout`) is §G.1, deferred.

### B.17 — `_sharedLayoutData` string-keyed map on `RenderStaff`
[RenderStaff.ts:24, :109-118](packages/alphatab/src/rendering/staves/RenderStaff.ts#L109). Cluster: **C-6**. Used by `TabWhammyEffectInfo.onAlignGlyphs` ([TabWhammyEffectInfo.ts:44-60](packages/alphatab/src/rendering/effects/TabWhammyEffectInfo.ts#L44)). Resets at `revertLastBar` but bleeds across renders on resize. Retired by Step 11 (lifecycle) + Step 15 (typed container).

### B.18 — `_appliedLayoutingInfo` skipping `alignGlyphs` side effect
[BarRendererBase.ts:526](packages/alphatab/src/rendering/BarRendererBase.ts#L526). Cluster: **C-3**. Symptom of B.13. Retired by Step 5 (single `alignGlyphs` call point) + Step 8b (cookie deletion).

### B.19 — `BarLayoutingInfo.version` is bumped from three sites
Three bump sites today: `addSpring` ([BarLayoutingInfo.ts:136](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts#L136)), `finish` ([:261](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts#L261)), and `recomputeSpringConstants` ([:277](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts#L277)). Cluster: **C-3**. The cookie protects downstream consumers against intra-bar partial-state reads (the `addSpring` bump) and signals system reconcile retroactively re-derived spring constants (the `recomputeSpringConstants` bump); the `finish` bump signals "LOCAL seal complete." After Step 8a removes intra-`doLayout` `applyLayoutingInfo`, the `addSpring` bump becomes redundant and is deleted. The post-step shape: version is bumped at LOCAL seal (`finish()`) and at SYSTEM seal–driven recompute (`recomputeSpringConstants`); NOT inside `addSpring`. §H Step 8a's grep is "`version++` in `BarLayoutingInfo.ts`: exactly 2 occurrences (`finish`, `recomputeSpringConstants`)."

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

### B.32 — `EffectBand.finalizeBand` is a SystemFinalize sub-step (iv) mutation site *(new from v4-review M12)*
[EffectSystemPlacement.ts:78-83](packages/alphatab/src/rendering/EffectSystemPlacement.ts#L78) calls `b.finalizeBand()` for every non-empty top/bottom band before placement. This is where dynamic-height bands (TabWhammy specifically) settle their `height` value as a function of `_sharedLayoutData`'s max-whammy-depth. v5 lists this in §D.2 as a row for `EffectBand.height` — the band height is `(=0)` through every phase up to SystemFinalize sub-step (iv) entry, then **final after `finalizeBand` runs in sub-step (iv) before `placeAndApply`'s top/bottom placement loop**. Cluster: **C-7** (Phase-output dependency: needs `_sharedLayoutData` written by Phase-2 `alignGlyphs`).

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
| `RenderStaff._sharedLayoutData` | (empty) | (read by `EffectBandContainer.alignGlyphs` if invoked; pre-Step-5 this fires in Phase 1) | (written by `onAlignGlyphs` if effect-aware) | (written if reconciled) | **written by `onAlignGlyphs` in the single `alignGlyphs` call** (post-Step-5) | (read-only) | (read-only) |
| `EffectBand.height` | (=0) | (=0) | (=0) | (=0) | (=0) | (=0) | **final after `EffectSystemPlacement.placeAndApply`'s `finalizeBand` loop in sub-step (iv)** ([EffectSystemPlacement.ts:78-83](packages/alphatab/src/rendering/EffectSystemPlacement.ts#L78)) |
| `renderer.y` | (=0) | (=0) | (=0) | (=0) | **provisional**: written by Phase-2 driver to `s.topPadding + s.topOverflow` ([VerticalLayoutBase.ts:462](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L462)); Step 13 retires this write | (read-only; provisional value carried forward only if Step 13 hasn't landed) | **final after sub-step (iv)** at [RenderStaff.ts:331](packages/alphatab/src/rendering/staves/RenderStaff.ts#L331) |
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

  // Optional. The implementer pulls its write destination from ctx; this is
  // EITHER ctx.renderer.barLocalSkyline (BarTempoGlyph, Phase 3) OR a band on
  // ctx.renderer (GroupedEffectGlyph, SystemFinalize). The hook does not take
  // a "target" parameter because the two use cases write into different
  // containers and resolving the destination here would be a lie. The
  // registered phase decides which dispatch loop fires the hook.
  populateSkyline?(ctx: SkylineCtx): void;
}

interface SkylineCtx {
  phase: 'finalized' | 'systemFinalize';
  renderer: BarRendererBase;
}
```

**Decision on lifecycle.** The hook is dispatched **at most twice** in a cycle: once in Phase 3 (for `BarTempoGlyph` and any other glyph that participates in `barLocalSkyline` after `reset()`), once in SystemFinalize sub-step (ii) (for `GroupedEffectGlyph`'s chain-walk end-X, which needs every renderer's `isFinalized = true`). Each implementer declares which phase(s) it participates in via a registration call (`renderer.registerPopulateSkyline(g, phase)`). The default (no phase declared) is Phase 3.

**Why the hook has no `target` parameter.** v4 modelled the hook as `populateSkyline(target: SkylineTarget, ctx)` with `target ∈ {BarLocalSkyline, StaffSystemSkyline}`. The v4 review caught the gap: Step 16's GroupedEffectGlyph use case writes to an `EffectBand` (`band.publishSpanRange(this, startX, trueEndX)`), not to a `SkylineTarget`. The two cases that drive this hook write to *different containers*:

- **Phase 3 / `BarTempoGlyph`**: writes into `ctx.renderer.barLocalSkyline` via `insertSkylineTop`/`Bottom`.
- **SystemFinalize / `GroupedEffectGlyph`**: writes into `ctx.renderer.topEffects.bands[k]` (or `bottomEffects`) via `band.publishSpanRange(this, startX, trueEndX)`. The band is the one this glyph belongs to. **There is no `renderer.bandOf(glyph)` reverse map in the current code** ([EffectBandContainer.ts](packages/alphatab/src/rendering/EffectBandContainer.ts)) — Step 16 must either (a) build this reverse map (populated when the band registers the glyph during effect-band assembly), or (b) walk `topEffects.bands` + `bottomEffects.bands` linearly inside the dispatch loop and let the glyph identify its own band by reference comparison. Step 16 picks one; (a) is preferred for O(1) lookup and is the spec.

A unified signature with a passed-in `target` would force one of the implementers to ignore the parameter. v5 keeps a single hook *name* (the dispatch mechanism is uniform — one list per phase per renderer) but drops `target` from the signature; each implementer resolves its destination from `ctx`. The phase-segregated registration (`_populateSkyline_finalized` vs `_populateSkyline_systemFinalize`) is the one-mechanism guarantee — the two dispatch loops differ only in *when* they fire and *which list* they walk.

**Two dispatch points, one hook signature:**

```ts
// Phase 3 dispatch (in BarRendererBase.finalize):
for (const g of this._populateSkyline_finalized) {
  g.populateSkyline!({ phase: 'finalized', renderer: this });
  // Conventional implementer body for BarTempoGlyph:
  //   ctx.renderer.barLocalSkyline.insertSkylineTop(...);
}

// SystemFinalize sub-step (ii) dispatch (in RenderStaff.finalizeStaff):
for (const renderer of this.barRenderers) {
  for (const g of renderer._populateSkyline_systemFinalize) {
    g.populateSkyline!({ phase: 'systemFinalize', renderer });
    // Conventional implementer body for GroupedEffectGlyph:
    //   const band = renderer.bandOf(this);  // reverse map added in Step 16
    //   band.publishSpanRange(this, startX, trueEndX);
  }
}
```

`EffectBand.publishSpanRange(glyph, xStart, xEnd)` is a new method on `EffectBand` added in Step 16: it stores a span entry that `computeLocalXRange` reads in addition to the per-glyph bbox loop, so cross-renderer span ranges are reflected in placement queries. See Step 16 for the implementation detail.

**On BarTempoGlyph's hook participation.** After Step 9 (`_postBeatGlyphs.x` single-write at end of Phase 2), BarTempoGlyph's bbox is stable. So why does it need a Phase-3 hook? Because **emission timing** still has to wait for Phase 3 — `barLocalSkyline.reset()` happens at Phase 3 start, and emitting earlier would be wiped. So BarTempoGlyph implements `populateSkyline?` for the emission-timing reason, not the bbox-staleness reason. After Step 9 (B.1 final), BarTempoGlyph could in principle be inlined into the post-beat-glyph walk in Phase 3 (just like other post-beat glyphs); the hook stays only as a uniform mechanism. Step 9's invariant covers the bbox-stability claim; the hook participation is a separate concern.

### D.4 BarLayoutingInfo's role and `_appliedLayoutingInfo`

`BarLayoutingInfo` remains a cross-bar broker on `MasterBarsRenderers` ([MasterBarsRenderers.ts:39](packages/alphatab/src/rendering/staves/MasterBarsRenderers.ts#L39); allocated in `StaffSystem.addBars` at [StaffSystem.ts:340](packages/alphatab/src/rendering/staves/StaffSystem.ts#L340)). v5 does NOT push to a `MasterBarLayout` — that's a larger refactor for a smaller correctness win (§G.1). The seal contract makes the broker safe.

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
    g.populateSkyline!({ phase: 'finalized', renderer: this });
  }
  this.calculateOverflowsFromSkyline();  // sets _contentTopOverflow/Bottom
}
```

`_pendingBeatEffectsByBeat` is gone: per-beat effects are inlined into the beat walk (Step 4). `_dynamicSkylineGlyphs` is gone: BarNumberGlyph bbox stable after Step 1; BarTempoGlyph uses `populateSkyline?`; GroupedEffectGlyph uses `populateSkyline?` at SystemFinalize.

### D.8 Resize entry point + revert rollback

Resize re-enters at CoordinateAssemble. The substate model is three-tiered (per Step 11): `LayoutCycle` per renderer, `StaffLayoutCycle` per staff, `SystemLayoutCycle` per system. All three are atomically reassigned at the rollback boundary.

```
ScoreLayout.resize:
  decide barsPerRow-active vs free-wrap (VerticalLayoutBase._resizeAndRenderScore)
  for each system to be reused: SystemLayoutCycle.reassign()  // Step 11 v5
    — discards: width, computedWidth, totalFixedOverhead, totalContentWidth,
       totalBarDisplayScale, accoladeWidth, firstVisibleStaff, minDuration,
       isMinDurationDirty
  for each staff to be reused: StaffLayoutCycle.reassign()  // Step 11
    — discards: _sharedLayoutData, topOverflow, bottomOverflow, staffTop,
       staffBottom, _systemSkyline, _effectPlacement
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
     accolade-spacing recomputed via idempotent _calculateAccoladeSpacing)
  for each system close: CoordinateReconcile + Phase 2 + Phase 3 + SystemFinalize
```

Phase 1's output (glyphs, intrinsic widths, pre-beat content) survives resize unless content actually changed.

**Two paths today, mapped to v5.** [VerticalLayoutBase.ts:281-321](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L281) has two resize paths: `barsPerRowActive` (set `system.width = system.computedWidth` then `_fitSystem` [:288](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L288)), and the free-wrap path that does `this._systems = []` [:301](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L301) and re-drives `_createStaffSystem` from scratch. v5's contract: both paths terminate in `SystemLayoutCycle.reassign()` for systems being reused (`barsPerRowActive`) or in fresh-allocation (`free-wrap`). The ad-hoc `system.width = system.computedWidth` line is replaced by the substate reassign, which resets all nine fields in one operation.

**`revertLastBar` rollback set.** When CoordinateAssemble fires on revert ([StaffSystem.ts:497-543](packages/alphatab/src/rendering/staves/StaffSystem.ts#L497)), the following must be undone for the system to be re-driveable. Today's code handles most of these via scattered `-=` decrements at [:535-539](packages/alphatab/src/rendering/staves/StaffSystem.ts#L535); v5 promotes them to a substate reassign.

| Rollback target | Today | v5 mechanism |
| --- | --- | --- |
| `system.firstVisibleStaff` | re-derived per revert at [:533](packages/alphatab/src/rendering/staves/StaffSystem.ts#L533) | re-derived; lives in `SystemLayoutCycle` |
| `system.width` | `-= width` at [:535](packages/alphatab/src/rendering/staves/StaffSystem.ts#L535) | recomputed from `SystemLayoutCycle` running total |
| `system.computedWidth` | `-= width` at [:536](packages/alphatab/src/rendering/staves/StaffSystem.ts#L536) | recomputed from substate |
| `system.totalBarDisplayScale` | `-= barDisplayScale` at [:537](packages/alphatab/src/rendering/staves/StaffSystem.ts#L537) | recomputed |
| `system.totalFixedOverhead` | `-= toRemove.maxFixedOverhead` at [:538](packages/alphatab/src/rendering/staves/StaffSystem.ts#L538) | recomputed |
| `system.totalContentWidth` | `-= toRemove.maxContentWidth` at [:539](packages/alphatab/src/rendering/staves/StaffSystem.ts#L539) | recomputed |
| `system.accoladeWidth` | (not unwound — relies on `_accoladeSpacingCalculated` gate; see §D.8a) | recomputed by idempotent `_calculateAccoladeSpacing` |
| `system.minDuration` / `isMinDurationDirty` | (not unwound — relies on `BarLayoutingInfo` being discarded with the `MasterBarsRenderers`) | recomputed from remaining bars |
| `staff._emptyBarCount` | decremented in `RenderStaff.revertLastBar` if reverted bar was empty/restOnly | unchanged |
| `staff.isVisible` | re-derived from `_updateVisibility` | unchanged |
| `staff.topOverflow / bottomOverflow` | reset to 0; re-run `_registerStaffOverflow` over remaining renderers (today's behaviour via `afterStaffBarReverted` [RenderStaff.ts:180-181](packages/alphatab/src/rendering/staves/RenderStaff.ts#L180) + per-renderer call) | lives in `StaffLayoutCycle` |
| `staff._sharedLayoutData` | reset (today's `resetSharedLayoutData` [:176, :194-196](packages/alphatab/src/rendering/staves/RenderStaff.ts#L176)) | lives in `StaffLayoutCycle` |
| `barLayoutingInfo` | discarded along with `MasterBarsRenderers` | unchanged |

**§D.8a — `_accoladeSpacingCalculated` and idempotent `_calculateAccoladeSpacing`.** This is the load-bearing v5 contract; the v4 description elided the actual cost center.

**The today-pattern.** [StaffSystem.ts:584-697](packages/alphatab/src/rendering/staves/StaffSystem.ts#L584) gates the body on `if (!this._accoladeSpacingCalculated)` ([:586](packages/alphatab/src/rendering/staves/StaffSystem.ts#L586)). On the first `addBars`, the gate flips and the body runs. The body mutates the system via four `+=` accumulators:

```ts
this.accoladeWidth = 0;                    // [:589] — reset
// ... measureText accumulates into this.accoladeWidth via Math.max ...
this.accoladeWidth += systemLabelPaddingLeft;  // [:653]
this.accoladeWidth += systemLabelPaddingRight; // [:655]  (conditional)

let currentY: number = 0;
for (const staff of this.allStaves) {
    staff.y = currentY;                    // [:675]
    staff.calculateHeightForAccolade();    // [:676]
    currentY += staff.height;              // [:677]
}

// braces:
let braceWidth = 0;
for (const b of this._brackets) {
    b.updateCanPaint();                    // [:682]
    b.finalizeBracket(...);                // [:683]
    braceWidth = Math.max(braceWidth, b.width);
}

this.accoladeWidth += braceWidth;          // [:687]  — ACCUMULATOR
this.width += this.accoladeWidth;          // [:689]  — ACCUMULATOR
this.computedWidth += this.accoladeWidth;  // [:690]  — ACCUMULATOR
```

The else-branch ([:691-696](packages/alphatab/src/rendering/staves/StaffSystem.ts#L691)) re-runs `b.updateCanPaint()` and `b.finalizeBracket(...)` on subsequent calls but does NOT re-touch `system.width` / `system.computedWidth` / `system.accoladeWidth`. The gate is what makes the function safe to call repeatedly.

**Naive recompute is wrong.** Removing the gate and calling `_calculateAccoladeSpacing` on every `addBars` causes `system.width` and `system.computedWidth` to grow by `accoladeWidth` on every call. Worse, `this.accoladeWidth += braceWidth` is also incremental against `this.accoladeWidth` — so the brace contribution itself drifts. After N bars, `system.width = actual + (N−1) × accoladeWidth`. `_applyLayoutAndUpdateWidth`'s `systemIsFull` estimator at [VerticalLayoutBase.ts:503](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L503) consumes the inflated width → every multi-bar system wraps too early. The v4 review caught this; v5's Step 1c is the fix.

**v5 fix: rewrite `_calculateAccoladeSpacing` to be idempotent.** Step 1c replaces every `+=` accumulator with an explicit assignment, and unwinds any prior contribution before reapplying:

1. Save the previous contribution: `const prevContrib = this.accoladeWidth;`
2. Unwind: `this.width -= prevContrib; this.computedWidth -= prevContrib;`
3. **Reset `this.accoladeWidth = 0` at function entry** (already done at [:589](packages/alphatab/src/rendering/staves/StaffSystem.ts#L589) inside the gate; v5 moves it outside).
4. Body runs: `measureText` Math.max loop sets `accoladeWidth` to the max of the per-track sizes; padding/brace contributions are computed; `accoladeWidth` ends up holding the **assigned-not-accumulated** total.
5. Reapply: `this.width += this.accoladeWidth; this.computedWidth += this.accoladeWidth;`

The `staff.y` / `currentY` accumulator at [:673-678](packages/alphatab/src/rendering/staves/StaffSystem.ts#L673) is also part of the idempotency contract: `currentY` is a local accumulator that resets to 0 at function entry, so it's already idempotent per call; what isn't idempotent is `staff.calculateHeightForAccolade()` if that method itself accumulates. [RenderStaff.ts:290-298](packages/alphatab/src/rendering/staves/RenderStaff.ts#L290) reads `barRenderers[0].height` directly — no accumulation, idempotent. So the four call sites that need `+=` → `=` rewrites are [:687, :689, :690](packages/alphatab/src/rendering/staves/StaffSystem.ts#L687); the rest of the body is already idempotent against `currentY`/`staff.y` reassignment.

The `canvas.measureText` cost is real but secondary — it's amortized via a one-per-bar-set cache (keyed on `(tracks, stylesheet, trackNamePolicy, trackNameMode, trackNameOrientation, systemIndex)`) added in Step 1c. The cache is invalidated when any keyed input changes (e.g. settings flip between renders).

**Step 1c also subsumes v4's Step 1a (folded).** v4 framed Step 1a as "recompute `firstVisibleStaff` per `addBars` and `revertLastBar`." [StaffSystem.ts:344-395](packages/alphatab/src/rendering/staves/StaffSystem.ts#L344) already does this incrementally in `addBars`; [:504-533](packages/alphatab/src/rendering/staves/StaffSystem.ts#L504) does it in `revertLastBar`. The v4 framing was a no-op against current code. The substantive B.5 bug is that `_calculateAccoladeSpacing`'s **first call** (gated to the first `addBars`) sees only one bar in the system — and `firstVisibleStaff` at that point reflects only one bar's visibility decision. After idempotent recompute lands in Step 1c, `_calculateAccoladeSpacing` runs at every `addBars` and every `revertLastBar`, so its read of `firstVisibleStaff` always sees the up-to-date model decision for the current bar set. v5 folds v4's Step 1a into Step 1c. Step 1b (`canWrap` from `SimileMark`) is independent and remains its own sub-step.

Step 1 splits into 1b/1c:
- **1b** — `canWrap` from `SimileMark.SecondOfDouble` moves to CoordinateAssemble (model-only decision). Closes B.21.
- **1c** — Idempotent `_calculateAccoladeSpacing`: drop `_accoladeSpacingCalculated`; rewrite `+=` → `=` against `system.width` / `computedWidth` / `accoladeWidth`; recompute at CoordinateAssemble close (after every `addBars` and every `revertLastBar`). Closes B.5, B.23.

### D.9 Where existing call sites map

| Existing | Target phase |
| --- | --- |
| `BarRendererBase.doLayout` glyph creation | Phase 1 |
| `BarRendererBase._registerLayoutingInfo` | Phase 1 (publish into broker) |
| `BarLayoutingInfo.finish` | CoordinateAssemble (LOCAL seal) |
| `_trackSystemMinDuration` (eager branch) + `reconcileMinDurationIfDirty` | CoordinateAssemble + CoordinateReconcile (SYSTEM seal) |
| `StaffSystem.firstVisibleStaff` | CoordinateAssemble (Step 1c) |
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

## §E. Migration plan (17 steps + split sub-steps)

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
Split into two sub-steps (v4's three-way split is collapsed: v4's Step 1a was a no-op against today's code that already recomputes `firstVisibleStaff` per `addBars`/`revertLastBar`; the substantive fix lives in Step 1c).

- **Step 1b — `canWrap` from `SimileMark` moves to CoordinateAssemble.**
  - Closes: v3-review M2 / B.21 (v3 closed by gesture only).
  - Files: [BarRendererBase.ts:686-688](packages/alphatab/src/rendering/BarRendererBase.ts#L686) (delete the `doLayout`-time flip); [StaffSystem.addBars:375-377](packages/alphatab/src/rendering/staves/StaffSystem.ts#L375) or earlier (read from `bar.simileMark` directly in CoordinateAssemble).
  - Retires: B.21.
  - Risk: low.
  - Acceptance: existing simile-mark visual fixtures byte-identical.

- **Step 1c — Idempotent `_calculateAccoladeSpacing`; gate retired; recompute at CoordinateAssemble close.**
  - Closes: v3-review Critical #4 (accolade interaction); v4-review Critical #1 (`system.width += accoladeWidth` accumulation); v4-review Significant #6 (v4's Step 1a was a no-op — folded here).
  - Files: [StaffSystem.ts:584-697](packages/alphatab/src/rendering/staves/StaffSystem.ts#L584), [RenderStaff.ts:290-298](packages/alphatab/src/rendering/staves/RenderStaff.ts#L290).
  - Scope (the load-bearing detail per §D.8a):
    1. Delete the `_accoladeSpacingCalculated` field and its gate at [:586-587](packages/alphatab/src/rendering/staves/StaffSystem.ts#L586).
    2. Rewrite the body to be idempotent: replace `this.width += this.accoladeWidth` ([:689](packages/alphatab/src/rendering/staves/StaffSystem.ts#L689)), `this.computedWidth += this.accoladeWidth` ([:690](packages/alphatab/src/rendering/staves/StaffSystem.ts#L690)), and `this.accoladeWidth += braceWidth` ([:687](packages/alphatab/src/rendering/staves/StaffSystem.ts#L687)) with the unwind+reassign sequence in §D.8a (save previous contribution, unwind from `system.width`/`computedWidth`, reset `accoladeWidth = 0`, recompute, re-apply).
    3. `currentY` / `staff.y` accumulator at [:673-678](packages/alphatab/src/rendering/staves/StaffSystem.ts#L673) is local — already idempotent per call.
    4. Cache `canvas.measureText` results in a `Map<TrackNamesCacheKey, number>` field on `StaffSystem` keyed on `(tracks, stylesheet, trackNamePolicy, trackNameMode, trackNameOrientation, systemIndex)`; invalidate when any keyed input changes.
    5. Call `_calculateAccoladeSpacing(tracks)` at CoordinateAssemble close on every `addBars` AND on every `revertLastBar`. Closes B.5 (the first-call-sees-one-bar bug): after this change, every call sees the up-to-date bar set's `firstVisibleStaff`.
  - Retires: B.5, B.23.
  - Risk: medium. Brace width is consumed by `_applyLayoutAndUpdateWidth`'s width totals which `systemIsFull` reads ([VerticalLayoutBase.ts:503](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L503)); the idempotent rewrite is the gate against wrap-point regressions. The unit-test gate at Step 1c acceptance is **two**: (i) `VisualTests.AccoladeOnRevert` — multi-track score where revert flips visibility and brace shrinks; (ii) `system.width` sentinel test — drive 5 addBars and confirm `system.width` matches a single-call baseline (catches the `+=` regression directly).
  - Blast radius: structural.

### Step 2. Drop `BarNumberGlyph` bbox overrides
- Closes: half of B.7.
- Files: [BarNumberGlyph.ts](packages/alphatab/src/rendering/glyphs/BarNumberGlyph.ts).
- Risk: low. Requires Step 1c.
- Parallel: with Step 3, after Step 1c.

### Step 3. Replace `_dynamicSkylineGlyphs` with `populateSkyline?` hook (two phases)
- Closes: v3-review Significant #6 (two dispatch points, per §D.3).
- Files: [Glyph.ts](packages/alphatab/src/rendering/glyphs/Glyph.ts), [BarTempoGlyph.ts](packages/alphatab/src/rendering/glyphs/BarTempoGlyph.ts), [BarRendererBase.ts:216-220, :422-458](packages/alphatab/src/rendering/BarRendererBase.ts#L216).
- Scope: implement two-list dispatch (`_populateSkyline_finalized`, `_populateSkyline_systemFinalize`). Migrate BarTempoGlyph (Phase 3). Reserve SystemFinalize dispatch for Step 16.
- Retires: other half of B.7.
- Risk: low–medium.
- Parallel: yes, after Step 1c.

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
- Prereq (HARD): Steps 1c, 8, 11.
- Acceptance: new visual-test corpus `VisualTests.ResizeWrapPointPreBeat`. MUST be authored as part of Step 10.

### Step 11. LayoutCycle substate: per-renderer + per-staff + per-system, atomically reassigned per cycle
- Closes: v3-review Critical #4 (the substate contract Step 10 needs); v3-review Critical #5; v4-review Significant #4 (per-system substate tier).
- Files: [BarRendererBase.ts](packages/alphatab/src/rendering/BarRendererBase.ts), [RenderStaff.ts](packages/alphatab/src/rendering/staves/RenderStaff.ts), [StaffSystem.ts](packages/alphatab/src/rendering/staves/StaffSystem.ts).
- Scope: extract per-cycle state into **three** substate objects (v4 had only two; v5 adds the per-system tier because `system.width`, `system.computedWidth`, `system.totalFixedOverhead`, `system.totalContentWidth`, `system.totalBarDisplayScale`, `system.accoladeWidth`, `system.firstVisibleStaff`, `system.minDuration`, `system.isMinDurationDirty` are per-cycle accumulators that today are managed by ad-hoc `-=` in `revertLastBar` and `system.width = system.computedWidth` in `_resizeAndRenderScore`'s `barsPerRowActive` branch — the C-6 anti-pattern at system scope).

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

  Per-system `SystemLayoutCycle` (atomically reassigned at every system's `_createStaffSystem` entry and at every `_resizeAndRenderScore` re-fit):
  - `width` ([StaffSystem.ts:187](packages/alphatab/src/rendering/staves/StaffSystem.ts#L187))
  - `computedWidth` ([:198](packages/alphatab/src/rendering/staves/StaffSystem.ts#L198))
  - `totalFixedOverhead` ([:211](packages/alphatab/src/rendering/staves/StaffSystem.ts#L211))
  - `totalContentWidth` ([:218](packages/alphatab/src/rendering/staves/StaffSystem.ts#L218))
  - `totalBarDisplayScale` ([:204](packages/alphatab/src/rendering/staves/StaffSystem.ts#L204))
  - `accoladeWidth` ([:172](packages/alphatab/src/rendering/staves/StaffSystem.ts#L172))
  - `firstVisibleStaff` ([:258](packages/alphatab/src/rendering/staves/StaffSystem.ts#L258))
  - `minDuration` ([:230](packages/alphatab/src/rendering/staves/StaffSystem.ts#L230))
  - `isMinDurationDirty` ([:238](packages/alphatab/src/rendering/staves/StaffSystem.ts#L238))

  The `SystemLayoutCycle` is the atomic-reassign target for resize. In v5 the `barsPerRowActive` branch at [VerticalLayoutBase.ts:285-291](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L285) replaces `system.width = system.computedWidth` with `system.cycle.reassign()` (which resets all nine fields); the free-wrap branch at [:301](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L301) discards `_systems` and gets fresh `SystemLayoutCycle` instances by construction. The `-=` decrements in `revertLastBar` ([:535-539](packages/alphatab/src/rendering/staves/StaffSystem.ts#L535)) are rewritten as substate recompute (re-sum from remaining `masterBarsRenderers[].maxFixedOverhead` / `maxContentWidth` / `width`); the C-6 anti-pattern at system scope dies.

  What does NOT belong to the substate (survives across cycles):
  - `voiceContainer` (Phase-1 content; rebuilt only if `bar` content changes).
  - `helpers` (Phase-1 helpers; reused).
  - `_postBeatGlyphs` (`LeftToRightLayoutingGlyphGroup`; content rebuilt only if model changes).
  - `_multiSystemSlurs` (system-skeleton registry, owned elsewhere).
  - All model refs (`bar`, `staff` after Phase 0).
  - Intrinsic widths published into the broker (those are broker state, sealed at CoordinateReconcile).
  - System-level identity fields (`system.index`, `system.x`, `system.y`, `system.staves`, `system._brackets`, `system.layout` ref — these are owned by the system across cycles, not per-cycle state).

- Retires: B.9, B.9b, B.15, B.17, B.22; per-system accumulator C-6 anti-pattern.
- Risk: medium (mechanical but cross-cutting; per-system tier touches `_resizeAndRenderScore`'s two branches and `revertLastBar`'s decrement loop).
- Blast radius: structural.
- **Ordering relative to Step 8b** (v3-review Significant #10): Step 11 lands **after** Step 8b. If Step 11 landed first, the substate-reassign would zero `_appliedLayoutingInfo` on every cycle and force re-application of `applyLayoutingInfo` on every renderer on every resize — a perf regression even if value-idempotent ([reconcile-min-duration.md §3](./investigations/reconcile-min-duration.md)). After Step 8b deletes the cookie, this consideration is moot. DAG fixes this.
- **Ordering relative to Step 1c** (v5): Step 11's per-system tier owns `system.accoladeWidth`; Step 1c's idempotent `_calculateAccoladeSpacing` writes through to it. If Step 1c lands before Step 11, the idempotent rewrite is on the raw `system.accoladeWidth` field. If Step 11 lands first, Step 1c writes through `system.cycle.accoladeWidth`. Either order works because both mechanisms are designed to be idempotent; the DAG sequences Step 1c first (it's a smaller change) but the two are compatible in either order.

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
- Closes: v3-review Critical #5 (B.25 mechanism corrected); v4-review Critical #2 (`populateSkyline?` signature aligned with EffectBand write target).
- Files: [EffectBand.ts:251-294](packages/alphatab/src/rendering/EffectBand.ts#L251), [GroupedEffectGlyph.ts:20-25, :31-37, :60-79](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L20).
- Scope:
  - `EffectBand.computeLocalXRange` validity phase: SystemFinalize sub-step (ii).
  - Add a new method `EffectBand.publishSpanRange(glyph: EffectGlyph, xStart: number, xEnd: number): void` that stores `{glyph, xStart, xEnd}` in a per-cycle list on the band. `computeLocalXRange` reads both (i) per-glyph bbox extents (today's loop at [EffectBand.ts:258-269, :276-287](packages/alphatab/src/rendering/EffectBand.ts#L258)) and (ii) the published span list, taking the union: `xStart = min(bbox-min, span-mins)`, `xEnd = max(bbox-max, span-maxes)`.
  - `GroupedEffectGlyph` implements `populateSkyline?(ctx)` registered at SystemFinalize phase. The implementation:
    1. If `!this.isLinkedWithNext && !this.forceGroupedRendering`, return — there's no cross-renderer span and bbox is already correct.
    2. Otherwise walk the chain: `let last = this.isLinkedWithNext ? this.nextGlyph as GroupedEffectGlyph : this; while (last.isLinkedWithNext) { last = last.nextGlyph as GroupedEffectGlyph; }` (mirrors `paint`'s walk at [GroupedEffectGlyph.ts:50-58](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L50)).
    3. Compute true end-X in this renderer's local coords: `const trueEndX = last.renderer.x + last.renderer.getBeatX(last.beat!, this.endPosition) − this.renderer.x;`
    4. Resolve the band: `const band = ctx.renderer.bandOf(this);` (the renderer maintains a glyph→band map — already implicit in how the glyph is registered).
    5. Publish: `band.publishSpanRange(this, this.x, trueEndX);`
  - **Why the hook signature has no `target`** (per §D.3): the GroupedEffectGlyph use case writes to a band, not to `barLocalSkyline`. The implementer pulls the destination from `ctx.renderer`.
  - The `_uniqueEffectGlyphs` bbox loop in `computeLocalXRange` keeps working for non-Span glyphs and for the local extent of Span glyphs — `publishSpanRange` is additive, not a replacement.
  - **Mechanism note (corrected from v3, kept in v5).** `getBoundingBoxRight` itself does NOT read a foreign `endBeat`. It reads `this.renderer.getBeatX(this.beat, this.endPosition)` — the start beat's end-x in the local renderer ([GroupedEffectGlyph.ts:20-25](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L20)). The walk machinery is `isLinkedWithNext` ([:31-37](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L31)) + `nextGlyph`, mirroring `paint`'s existing traversal at [:50-67](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L50). The bbox stays as-is; the SystemFinalize dispatch publishes the *additional* cross-renderer extent.
- Retires: B.25.
- Risk: low (mostly documentation + one `populateSkyline?` implementation that reuses `paint`'s existing chain-walk + one new `EffectBand.publishSpanRange` method).
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
       Step 0   Step 1b   Step 1c   Step 6   Step 4   Step 5a
          \       \         \        \       /         \
           \       \         \        \     /           \
            \       \         \        \   /             \
        Step 2 (after 1c)   Step 3 (after 1c)   Step 5b   Step 7   Step 8a
                  \                |              /         |       /
                   \               |             /          |      /
                    \              |            /           |     /
                     \           Step 5c                    |    /
                      \           |                         |   /
                       \------- Step 8b -------------------+
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
- Step 10 ⇐ {1c, 8a, 8b, 11}.
- Step 12 ⇐ Step 11.
- Step 16 ⇐ {3, 13}.
- Step 17 ⇐ Step 13.
- Step 11 ⇐ Step 8b (perf-only ordering; see Step 11 above).
- Step 1c is the carrier of v4's Step 1a work (`firstVisibleStaff` correctness via idempotent accolade recompute) — see §D.8a.

Parallelizable clusters:
- **α** (first wave, all low-risk, low-blast): Step 0; Steps 1b and 1c (each independent); Step 6; Step 4; Step 5a (audit).
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

### G.5 Step 1c acceptance — `revertLastBar` corpus (visibility)
`VisualTests.GhostStaffVisibility` MUST be authored as part of Step 1c (not pre-existing). The corpus must include: multi-staff scores with `hideEmptyStaves`; mid-system revert flipping a previously-only-rest staff to visible; resize across the revert. This corpus exercises the path that was v4's Step 1a — folded into Step 1c in v5 because the substantive fix is `_calculateAccoladeSpacing` re-running per `addBars`/`revertLastBar`.

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
| 0 | `_scaleToForce` is invoked once per `applyLayoutingInfo` (outside the per-voice loop); the method declaration remains a private on `MultiVoiceContainerGlyph` | grep `_scaleToForce(` in `MultiVoiceContainerGlyph.ts`: exactly 3 lines — method declaration + the `scaleToWidth` call site + the hoisted `applyLayoutingInfo` call site (one per caller, no longer inside the per-voice loop). No call sites in `BarRendererBase.ts`. (Step 7 later eliminates the `scaleToWidth` call entirely, dropping the count to 2.) |
| 1b | `bar.canWrap` set from `SimileMark.SecondOfDouble` happens in CoordinateAssemble, not `doLayout` | grep `SimileMark.SecondOfDouble` in `BarRendererBase.ts` doLayout block: zero occurrences |
| 1c | Accolade width recomputed at CoordinateAssemble close on every `addBars`/`revertLastBar`; gate `_accoladeSpacingCalculated` deleted; `_calculateAccoladeSpacing` is idempotent under repeated invocation (write-then-read sentinel) | grep `_accoladeSpacingCalculated`: zero occurrences; runtime: drive 5 `addBars` calls in sequence, assert `system.width` equals the single-call baseline (catches `+=` regressions on `system.width`/`computedWidth`/`accoladeWidth`) |
| 2 | `BarNumberGlyph.getBoundingBox*` is a pure function of glyph fields | unit: vary renderer state, assert bbox unchanged |
| 3 | The set of glyphs with dynamic-skyline contribution is enumerated by `_populateSkyline_finalized` + `_populateSkyline_systemFinalize`; `populateSkyline?` signature is `(ctx)` only (no `target` parameter) | grep `_dynamicSkylineGlyphs`: zero occurrences; grep `populateSkyline\?\(target` in `Glyph.ts`: zero occurrences |
| 4 | Beat-effect overflow registration inline during beat creation; no per-cycle list survives Phase 1 | grep `_pendingBeatEffectsByBeat`: zero occurrences |
| 5 | `EffectBand` glyph x set exactly once per cycle; `onAlignGlyphs` runs exactly once; `_sharedLayoutData` reset at a single, documented point | grep `alignGlyphs(` in `BarRendererBase.ts`: exactly 2 call sites (top + bottom band, one place); reset point lint rule |
| 6 | `renderer.height` set, never accumulated | grep `this.height +=` in `BarRendererBase.ts`: zero occurrences |
| 7 | `BarRendererBase.scaleToWidth` body runs at most once per renderer per cycle, at final width | runtime assertion: counter on `scaleToWidth` entry, must equal 1 per cycle |
| 8a | `applyLayoutingInfo` never called from inside `doLayout`; `BarLayoutingInfo.version` is bumped only at `finish()` (LOCAL seal) and `recomputeSpringConstants` (SYSTEM seal–driven recompute); NOT inside `addSpring` | grep `applyLayoutingInfo()` in `BarRendererBase.doLayout`: zero; grep `version++` in `BarLayoutingInfo.ts`: exactly 2 occurrences (in `finish` and `recomputeSpringConstants`). The v4 invariant claimed "only in `recomputeSpringConstants`" but `finish()` also bumps — see B.19. |
| 8b | The "should I re-apply" decision lives in `reconcileMinDurationIfDirty`; `_appliedLayoutingInfo` deleted | grep `_appliedLayoutingInfo`: zero occurrences |
| 9 | `_postBeatGlyphs.x = ...` happens exactly once per cycle (end of Phase 2) | grep `_postBeatGlyphs.x =` in `BarRendererBase.ts`: exactly 1 occurrence (in `spacedLayout`) |
| 10 | Resize requires no per-renderer flag to decide pre-beat rebuild; substate discard subsumes | grep `wasFirstOfStaff`, `recreatePreBeatGlyphs`: zero occurrences |
| 11 | Renderer + staff + system per-cycle state captured in three substate objects, atomically reassigned per cycle; the nine per-system fields in §D.8 are the `SystemLayoutCycle` payload | code search: per-cycle fields are accessed via `this._cycle.X` / `this._staffCycle.X` / `system.cycle.X`; no direct assignment of those fields outside the `*.reassign()` paths. Sentinel: `system.width = system.computedWidth` line at [VerticalLayoutBase.ts:288](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L288) replaced by `system.cycle.reassign()` |
| 12 | SystemFinalize is 4 explicit sub-steps in order (i)-(iv) per §D.6; `placeAndApply` runs exactly once per staff per cycle | unit: instrument `finalizeStaff`, assert sub-step order and `placeAndApply` call count = 1 |
| 13 | The phase contract from §D.2 holds. The method body of `BarRendererBase.spacedLayout()` contains zero `barLocalSkyline.insert*` / `insertSkylineTop` / `insertSkylineBottom` call sites; emission lives in `finalize()` (Phase 3) and `_finalizeTies` (SystemFinalize sub-step (ii)) | the file containing `spacedLayout()` (the renamed Phase-2 entry point in `BarRendererBase.ts`) yields zero matches for `insertSkylineTop\|insertSkylineBottom\|barLocalSkyline\.insert` between the `spacedLayout` opening brace and its closing brace. Tooling: a Step 13 acceptance check parses the method body and asserts. The v4 invariant predicated on a renamed method (`spacedLayout`) — that name exists post-Step-13, so the invariant is verifiable only after Step 13 has landed; before then, the equivalent invariant is "`scaleToWidth`'s body emits zero insert calls" against the split scheduled in §D.9 |
| 14 | `Glyph.getBoundingBox*` is provably pure (function of glyph fields) across the entire glyph hierarchy | audit doc: every override classified |
| 15 | Staff-level cross-bar state is typed; no stringly-keyed bag | grep `getSharedLayoutData\|setSharedLayoutData`: zero occurrences |
| 16 | `EffectBand.computeLocalXRange` has documented SystemFinalize validity; Span-category cross-renderer end-X correct; `EffectBand.publishSpanRange` exists and is read by `computeLocalXRange` | unit: cross-renderer GroupedEffectGlyph span; assert published end-X equals chain-walk computation; assert `computeLocalXRange` returns a value strictly greater than the local-bbox-only max when a `publishSpanRange` entry exists |
| 17 | `BeamingHelper.drawingInfos` populated exactly once per cycle (in Phase 2); read-only thereafter; paint never mutates | grep `alignWithBeats`: zero occurrences; grep `drawingInfos.clear()`: only in `initializeBeamDrawingInfo` (the populate path) |

**Spot-check of three invariants for verifiability** (per the meta-prompt's requirement):
- Step 0: `git grep -n '_scaleToForce(' packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts` should yield exactly 3 lines after the step lands (method declaration + `scaleToWidth` call + hoisted `applyLayoutingInfo` call). Today the third match is inside the per-voice loop ([MultiVoiceContainerGlyph.ts:165](packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts#L165)); Step 0 hoists it outside the loop but does not delete it (Step 7 later does). ✓ Verifiable by `grep`.
- Step 13: with `spacedLayout()` as the post-Step-13 method name, `git grep -n 'barLocalSkyline\.insert\|insertSkylineTop\|insertSkylineBottom' packages/alphatab/src/rendering/BarRendererBase.ts` should show every match inside `finalize()` (Phase 3) and zero matches inside `spacedLayout()`. ✓ Verifiable by grep plus a one-shot AST check on method-body bounds.
- Step 12: instrument `RenderStaff.finalizeStaff` with sub-step counters; assert via test that each sub-step runs exactly once per cycle per staff and that `_finalizeTies` runs strictly between sub-step (i) and sub-step (iii). ✓ Verifiable by unit test.

---

## §I. Findings disposition (v3 review traceability — historical)

For each item in the v3 review, this section names the §E step / §D section that closes it. (The v4 review is closed in §J below.)

### Critical (v3-review §Critical 1-5)

| # | Finding | v4 closure |
| --- | --- | --- |
| C1 | §D.2 / §D.7 / §D.9 contradict on skyline emission phase | §D.2 split row for `barLocalSkyline` (content vs tie overlay); §D.7 explicit Phase-3-only emit; §D.9 split `scaleToWidth` body across Phase 2 and Phase 3; §H Step 13 grep-checkable invariant. |
| C2 | Step 11 scope omits `_preBeatGlyphs` | Step 11 explicitly includes `_preBeatGlyphs` (conditionally discarded when `isFirstOfStaff` flips); explicit "survives vs reassigned" matrix. |
| C3 | Step 12 doesn't pin tie ordering inside SystemFinalize | §D.6 four-sub-step ordering table; Step 12 scope spells out (i)-(iv); §H Step 12 invariant test. |
| C4 | Step 1 vs `_calculateAccoladeSpacing` unresolved | Step 1 split into 1b (canWrap) + 1c (idempotent accolade recompute; v4's Step 1a folded in). §D.8a contract; §G.5 + §G.7 acceptance corpora. |
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

## §J. Sign-off checklist (v5)

Every Critical, Significant, Minor, and Item-v4-missed from the v4 review, with the v5 §E step or §D section that closes it. Each row is substantively verifiable (grep, unit test, or by reading the cited §E/§D text and confirming it engages with the v4-review entry).

### Critical (v4-review §Critical 1-2)

| # | v4-review finding | v5 closure |
| --- | --- | --- |
| C1 | Step 1c retired `_accoladeSpacingCalculated` without addressing `system.width += accoladeWidth` accumulation at [StaffSystem.ts:689-690](packages/alphatab/src/rendering/staves/StaffSystem.ts#L689) | §D.8a rewritten with the idempotency contract: replace `+=` with `=` and unwind+reapply on each call. §E Step 1c scope spells out the five concrete code edits (delete gate, rewrite three `+=` accumulators, cache `measureText`, recompute at every `addBars`/`revertLastBar`). §H Step 1c invariant gains a sentinel: drive 5 `addBars` and assert `system.width` matches single-call baseline. The `staff.y`/`currentY` accumulator is named and confirmed already-idempotent. |
| C2 | `populateSkyline?` signature in §D.3 didn't match Step 16's `band.publishSpanRange` write target | §D.3 hook signature is `populateSkyline(ctx)` (no `target` parameter); the implementer pulls its destination from `ctx.renderer`. §D.3 §"Why the hook signature has no `target` parameter" justifies. Step 16 spells out `EffectBand.publishSpanRange(glyph, xStart, xEnd)` as the new method that publishes cross-renderer span ranges into the band; `computeLocalXRange` reads both bbox and published spans. §H Step 3 invariant adds: grep `populateSkyline\?\(target` is zero. |

### Significant (v4-review §3-§6)

| # | v4-review finding | v5 closure |
| --- | --- | --- |
| S3 | `BarLayoutingInfo.version` is also bumped from `finish()` at [BarLayoutingInfo.ts:261](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts#L261), not only `addSpring` and `recomputeSpringConstants`; v4's §H grep was wrong | §B.19 rewritten to enumerate all three bump sites and specify the post-Step-8a target shape (`finish` and `recomputeSpringConstants` only; `addSpring` bump removed). §H Step 8a invariant reworded: "exactly 2 occurrences (in `finish` and `recomputeSpringConstants`)" — verifies against actual code. |
| S4 | Step 11 missed `SystemLayoutCycle` substate tier; per-system accumulators (`width`, `computedWidth`, `totalFixedOverhead`, `totalContentWidth`, `totalBarDisplayScale`, `accoladeWidth`, `firstVisibleStaff`, `minDuration`, `isMinDurationDirty`) survive resize as ad-hoc fields, C-6 anti-pattern at system scope | §E Step 11 scope adds the per-system `SystemLayoutCycle` tier with all nine fields enumerated and cited by file:line. §D.8 revert rollback table replaces the stale `_accoladeSpacingCalculated` bullet with a SystemLayoutCycle reassign contract, and maps `barsPerRowActive` / free-wrap branches at [VerticalLayoutBase.ts:285-321](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L285) to substate reassign / discard. §H Step 11 invariant references the per-system tier and the sentinel-line replacement at `_resizeAndRenderScore:288`. |
| S5 | §D.2 `renderer.y` row said `(=0)` through Phase 2 but Phase 2 actually writes at [VerticalLayoutBase.ts:462](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L462) | §D.2 `renderer.y` row updated: Phase 2 cell now reads "provisional: written by Phase-2 driver to `s.topPadding + s.topOverflow`; Step 13 retires this write." SystemFinalize cell points to [RenderStaff.ts:331](packages/alphatab/src/rendering/staves/RenderStaff.ts#L331). The Phase-2 write is a known dead-on-arrival contract item; Step 13's renamed `spacedLayout()` will not contain a `renderer.y =` line. |
| S6 | Step 1a was a no-op against today's code that already recomputes `firstVisibleStaff` per `addBars`/`revertLastBar` ([StaffSystem.ts:344-395, :504-533](packages/alphatab/src/rendering/staves/StaffSystem.ts#L344)) | v5 folds v4's Step 1a into Step 1c. §D.8a §"Step 1c also subsumes v4's Step 1a" explains that the substantive B.5 fix is `_calculateAccoladeSpacing`'s first-call timing (first call sees only one bar; gate-retired idempotent recompute fires on every assemble so `firstVisibleStaff` is always the up-to-date model decision). §E now lists Step 1b and Step 1c only. DAG, parallelizable clusters, and §H Step 1a row updated. |

### Minor (v4-review §7-§9)

| # | v4-review finding | v5 closure |
| --- | --- | --- |
| Min7 | §H Step 0 grep "count = 2 (one per file)" wrong — `_scaleToForce` is not called from `BarRendererBase.ts` | §H Step 0 invariant reworded: "in `MultiVoiceContainerGlyph.ts`, `_scaleToForce(` appears exactly 2 lines — one call site and one method declaration. No call sites in `BarRendererBase.ts`." |
| Min8 | §D.2 `RenderStaff._sharedLayoutData` row labeled "Phase 1 read" but `EffectBandContainer.alignGlyphs` writes too in Phase 1 today (C-7 shape) | §D.2 row updated: Phase 1 cell reads "read by `EffectBandContainer.alignGlyphs` if invoked; pre-Step-5 this fires in Phase 1." Phase-2 cell marks "written by `onAlignGlyphs` in the single `alignGlyphs` call" as the post-Step-5 contract. The read/write asymmetry is the C-7 cluster's surface; Step 5 closes it. |
| Min9 | §H Step 13 grep invariant assumed renamed `spacedLayout()` exists | §H Step 13 invariant reworded to bound the grep by the method-body bracketing: "the method body of `BarRendererBase.spacedLayout()` contains zero `barLocalSkyline.insert*` calls." Pre-Step-13 the equivalent invariant is documented as "`scaleToWidth`'s body emits zero insert calls" against the §D.9 split. |

### Items v4 missed (v4-review §M11-§M12)

| # | v4-review finding | v5 closure |
| --- | --- | --- |
| M11 | `BarLayoutingInfo` ownership is `MasterBarsRenderers`, not `StaffSystem`; §B.16 and §A.2 read as if `StaffSystem` owns it | §A.2 explicitly says the broker is owned by `MasterBarsRenderers` (with [MasterBarsRenderers.ts:39](packages/alphatab/src/rendering/staves/MasterBarsRenderers.ts#L39) citation). §B.16 rewritten with the owner/iterator distinction. §D.4 cites the owning file:line. §G.1 (deferred `MasterBarLayout` refactor) now reads as a move *away* from `MasterBarsRenderers`, consistent. |
| M12 | `EffectBand.finalizeBand` mutation site at [EffectSystemPlacement.ts:78-83](packages/alphatab/src/rendering/EffectSystemPlacement.ts#L78) had no §D.2 row | §B.32 added documenting the sub-step (iv) mutation. §D.2 has a new row for `EffectBand.height` with the "final after `finalizeBand` loop in sub-step (iv)" contract. C-7 cluster gains this instance (Phase-output dependency on `_sharedLayoutData`). |

### Carryover from v3 review (still closed; preserved from v4)

| Category | Disposition |
| --- | --- |
| v3-Critical 1-5 | §I above (v3 traceability table); §H Step 13 grep, Step 11 substate scope, §D.6 four-substep ordering, §D.8a Step 1c, §B.25 mechanism rewrite all preserved. |
| v3-Significant 6-12 | §I; §D.3 two-dispatch hook (signature corrected per C2 above), §D.3 BarTempoGlyph paragraph, Step 0 unit-test gate, §D.5 Route B predicate, DAG ordering, Step 5a deliverable, §I per-Minor table. |
| v3-Minor 13-17 | §I; §A.1 line citations, B.3/B.9 annotations, §D.4 prose, §H Step 13 reframing, §G.5-G.7 acceptance corpora. |
| v3-M1-M10 | §B.26-B.31, §D.2 rows, C-7 cluster, Step 11 substate, Step 1b/1c, Step 12 (i) — all preserved. |

**Self-verification (spot-check of three random rows):**

- **C1** → §E Step 1c scope point 2 ("replace `this.width += this.accoladeWidth` ... with the unwind+reassign sequence in §D.8a"), §D.8a §"v5 fix: rewrite `_calculateAccoladeSpacing` to be idempotent" (5-step recipe), §H Step 1c invariant with 5-`addBars` sentinel test. Substantive. ✓
- **S4** → §E Step 11 scope per-system `SystemLayoutCycle` block with nine file:line-cited fields, §D.8 revert rollback table, §H Step 11 invariant referencing `_resizeAndRenderScore:288` sentinel-line replacement. Substantive. ✓
- **M11** → §A.2 ownership note with [MasterBarsRenderers.ts:39](packages/alphatab/src/rendering/staves/MasterBarsRenderers.ts#L39) citation, §B.16 owner/iterator distinction, §D.4 reference. Substantive. ✓

If every Critical, Significant, Minor, and Items-v4-missed row above closes against a substantive §E step or §D section, v5 is implementable. The architecture from v4 is unchanged; v5 is the contract-tightening pass that closes the v4 review's gaps.

---

## Appendix: cited files

- [`packages/alphatab/src/rendering/BarRendererBase.ts`](packages/alphatab/src/rendering/BarRendererBase.ts) — lifecycle core.
- [`packages/alphatab/src/rendering/staves/RenderStaff.ts`](packages/alphatab/src/rendering/staves/RenderStaff.ts) — staff loop, overflow accumulators, shared data.
- [`packages/alphatab/src/rendering/staves/StaffSystem.ts`](packages/alphatab/src/rendering/staves/StaffSystem.ts) — system assembly, min-duration reconcile, accolade spacing; per-system accumulators (Step 11 `SystemLayoutCycle`).
- [`packages/alphatab/src/rendering/staves/MasterBarsRenderers.ts`](packages/alphatab/src/rendering/staves/MasterBarsRenderers.ts) — owner of `BarLayoutingInfo`; per-master-bar renderer aggregate.
- [`packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts`](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts) — cross-bar broker, version, recomputeSpringConstants; three `version++` sites (addSpring, finish, recomputeSpringConstants).
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

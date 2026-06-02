# Bar-renderer lifecycle audit and target architecture — v3

> **Status.** Implementation-sign-off iteration. v2 (`skyline-emission-architecture.md`) was reviewed adversarially in [`skyline-emission-architecture-review.md`](./skyline-emission-architecture-review.md) and v3 is the response. Three investigations now settle open questions: [`investigations/beam-helper-drawinginfos.md`](./investigations/beam-helper-drawinginfos.md), [`investigations/scale-to-force-multi-call.md`](./investigations/scale-to-force-multi-call.md), [`investigations/reconcile-min-duration.md`](./investigations/reconcile-min-duration.md). v1 remains at [`skyline-emission-architecture-v1.md`](./skyline-emission-architecture-v1.md) for historical reference only; v3 does not relitigate it.

> **File refs.** All file references are absolute paths against the repo root, in the form `[file.ts:NNN](packages/...)`.

---

## TL;DR

Today, bar layout is a sequence of partial passes; each pass finalizes a slightly different subset of the same state, and later passes re-mutate values an earlier pass had "set." Glyphs work around this by capturing reads at the wrong time and re-reading later through `getBoundingBox*` — turning bbox into a covert dynamic-state oracle.

v3 retains v2's diagnosis (the cluster of five anti-patterns in §C) but reshapes the target architecture in three significant ways:

1. **Coordinate is two-step.** `CoordinateAssemble` runs incrementally during system assembly (each `addBars` call). `CoordinateReconcile` runs once at system close, after `reconcileMinDurationIfDirty`. v2's "single seal" was provably too strong (see [reconcile-min-duration.md §6](./investigations/reconcile-min-duration.md)).
2. **Phase 2 (Spaced) is genuinely single-write after a Step 0 hoist.** [scale-to-force-multi-call.md](./investigations/scale-to-force-multi-call.md) proved the per-voice `_scaleToForce` multi-call is an accidental refactoring artifact. Lifting it out of the voice loop is byte-identical and unblocks the single-write Spaced contract.
3. **`BeamingHelper.drawingInfos` is one-shot, populated at end of Spaced.** [beam-helper-drawinginfos.md](./investigations/beam-helper-drawinginfos.md) showed today's behaviour is "clear-and-rebuild on every `alignWithBeats`." v3 drops the Phase-A overflow probe (rewrite to direct Y queries) and eagerly populates both directions in Phase B.

Tie finalization keeps writing into bar-local skylines (only the *invocation point* hoists). Effect-band `placeAndApply`'s before/after `contentTop`/`contentBottom` sampling is preserved as an internal mechanic; what dies is the `needsSecondPass` outer loop.

Skyline emission is now one point: end of Phase 3 / Finalized. `_dynamicSkylineGlyphs` and `_pendingBeatEffectsByBeat` disappear in favour of (a) stable bboxes for previously-dynamic glyphs whose only dynamism was C-2 phase order (BarNumberGlyph), and (b) an optional `populateSkyline?` hook for the small set of glyphs that legitimately have post-Phase-2 contributions (BarTempoGlyph, GroupedEffectGlyph cross-renderer end-X).

---

## §A. Lifecycle timeline today

The current state-mutation timeline is preserved from v2 with two corrections forced by the investigations:

- **`_scaleToForce` is documented as multi-call in v2's row for `applyLayoutingInfo`. Today it is called N+1 times per multi-voice bar — once per voice inside the `applyLayoutingInfo` voice loop ([MultiVoiceContainerGlyph.ts:160-167](packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts#L160)), then again from `scaleToWidth` ([BarRendererBase.ts:366](packages/alphatab/src/rendering/BarRendererBase.ts#L366)). Iterations 2..N are no-ops** (proved in [scale-to-force-multi-call.md §2-§3](./investigations/scale-to-force-multi-call.md)). v2's "Spaced has a single seal point" was untrue against this code — v3's Step 0 removes the multi-call before the rest of the plan runs.
- **`BeamingHelper.alignWithBeats` does NOT rewrite `startX/endX` for every direction.** It clears `drawingInfos` mid-iteration and the writes only land on the first map entry, which is immediately discarded ([BeamingHelper.ts:109-115](packages/alphatab/src/rendering/utils/BeamingHelper.ts#L109)). The function's real load-bearing effect is the `.clear()`; the next `ensureBeamDrawingInfo` cache-miss rebuilds with post-spring X. v2's "alignWithBeats rewrites x" line is wrong as written.

Other than those two corrections, v2's §A.1 and §A.2 timelines remain accurate. The one-renderer state-mutation table (preserved from v2 with corrections):

| State | doLayout | applyLayoutingInfo | scaleToWidth | finalizeRenderer |
| --- | --- | --- | --- | --- |
| `_preBeatGlyphs.width` | set (content) | grown (== preBeatSize) | — | — |
| `voiceContainer.x` | set | reassigned | (implicit via post.x) | — |
| `_postBeatGlyphs.x` | set | reassigned | reassigned | — |
| `_postBeatGlyphs.width` | set (content) | grown (== postBeatSize) | — | — |
| `width` | set | reassigned | reassigned | possibly grown |
| `height` | accumulated `+=` | — | — | possibly grown |
| `_contentTopOverflow/Bottom` | set | — | — | possibly grown |
| `barLocalSkyline` | reset | — | reset + emitted | tie writes |
| `preBeatLocalSkyline` | emitted | — | — | — |
| `postBeatLocalSkyline` | emitted | — | — | — |
| `topEffects.height` / `bottomEffects.height` | — | — | — | EffectSystemPlacement |
| `_scaleToForce(force)` | — | **N times (voice loop)** | **1 time** | — |
| `drawingInfos[direction]` | populated by `calculateBeamingOverflows` (canonical dir, pre-spring X) | — | **cleared + rebuilt on first miss** | paint may insert tuplet dir |
| `effectBand.alignGlyphs` | called (#1) | called (#2) | called (#3); also called from `reLayout` (#4 on resize) | — |

Also note: the v2 table counted `alignGlyphs` as 3×; on resize there is a 4th call from `reLayout` ([BarRendererBase.ts:968](packages/alphatab/src/rendering/BarRendererBase.ts#L968)).

---

## §B. Inventory of cached / delayed / version-skipped state

v2's 18 rows are preserved, refined where the investigations corrected them, and extended with the items the review listed as v2-missed.

### B.1 — `_postBeatGlyphs.x` mutated three times

[BarRendererBase.ts:804](packages/alphatab/src/rendering/BarRendererBase.ts#L804), [:541](packages/alphatab/src/rendering/BarRendererBase.ts#L541), [:412](packages/alphatab/src/rendering/BarRendererBase.ts#L412). Cluster: **C-1**. Final value depends on `layoutingInfo.postBeatSize` and the bar's final width. Single-write becomes legal once Step 0 + Step 8 land.

### B.2 — `this.height += layoutingInfo.height` accumulation

[BarRendererBase.ts:808](packages/alphatab/src/rendering/BarRendererBase.ts#L808). Cluster: **C-1**. `layoutingInfo.height` is 0 today but the `+=` is misleading on every `reLayout`. Latent bug.

### B.3 — `_appliedLayoutingInfo` version cookie

[BarRendererBase.ts:510, :525-530](packages/alphatab/src/rendering/BarRendererBase.ts#L510). Cluster: **C-3**. v2 framed this as pure perf. The investigation [reconcile-min-duration.md §3](./investigations/reconcile-min-duration.md) confirms: in the current code, the guard is perf-only — `applyLayoutingInfo` is value-idempotent on a stable `BarLayoutingInfo`. But v3 is careful: the *current callers* depend on the guard's selective short-circuit because the reconcile loop blindly re-applies on every renderer. v3 removes the guard only after step 8b moves the "is the bar actually dirty?" predicate into the reconcile loop itself.

### B.4 — `wasFirstOfStaff` / `recreatePreBeatGlyphs`

[BarRendererBase.ts:899, :974-994](packages/alphatab/src/rendering/BarRendererBase.ts#L974). Cluster: **C-2 + C-5**. Resize-time pre-beat rebuild captures the at-creation answer. The review (Critical #4) correctly identifies that this is `index === 0` ([BarRendererBase.ts:478-482](packages/alphatab/src/rendererBase.ts#L478)), not first-visible-staff. Its real prereq is **Step 11 (LayoutCycle substate)**, not Step 1.

### B.5 — `firstVisibleStaff` decided post-loop

[StaffSystem.ts:322, :395](packages/alphatab/src/rendering/staves/StaffSystem.ts#L322). Cluster: **C-2**. Decidable from the model (which bars in this master bar are empty/rest-only + previous empty count). The pre-pass must also re-run on `revertLastBar` (review §10).

### B.6 — `_pendingBeatEffectsByBeat`

[BarRendererBase.ts:143, :281, :387-399](packages/alphatab/src/rendering/BarRendererBase.ts#L281). Cluster: **C-2**. Flushed inline in `scaleToWidth`'s per-beat callback. Guarded by `if (beatId >= 0)` ([BarRendererBase.ts:386](packages/alphatab/src/rendering/BarRendererBase.ts#L386)) — latent multi-bar-rest interaction (B.20 below).

### B.7 — `_dynamicSkylineGlyphs` registry

[BarRendererBase.ts:216-220, :422-458](packages/alphatab/src/rendering/BarRendererBase.ts#L216). Cluster: **C-4**. Compensates for B.1 + B.5. Becomes obsolete for BarNumberGlyph (bbox stable once B.5 fixed) and is replaced by `populateSkyline?` for BarTempoGlyph + GroupedEffectGlyph end-X.

### B.8 — `scaleToWidth` called multiple times

[HorizontalScreenLayout.ts:180](packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts#L180), [:229](packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts#L229). Cluster: **C-1**. The current entry-time `barLocalSkyline.reset()` is defensive. The real fix is one call at the final width.

### B.9 — `afterReverted` / `afterStaffBarReverted` reset list is incomplete

[BarRendererBase.ts:512-520](packages/alphatab/src/rendering/BarRendererBase.ts#L512). Cluster: **C-5**. Fields silently surviving revert+re-add include `_pendingBeatEffectsByBeat`, `_ties[]`, `_dynamicSkylineGlyphs`, `barLocalSkyline`, `preBeatLocalSkyline`, `postBeatLocalSkyline`, `_contentTopOverflow/Bottom`, `_appliedLayoutingInfo`, `beatEffectsMinY`, `beatEffectsMaxY`.

### B.9b — `RenderStaff` overflow accumulators (NEW; review §Critical 5)

[RenderStaff.ts:198-210](packages/alphatab/src/rendering/staves/RenderStaff.ts#L198), [:63-128](packages/alphatab/src/rendering/staves/RenderStaff.ts#L63). `topOverflow`, `bottomOverflow`, `staffTop`, `staffBottom` are max-of accumulators on `RenderStaff` itself. They reset in `revertLastBar` ([RenderStaff.ts:180-181](packages/alphatab/src/rendering/staves/RenderStaff.ts#L180)) but not in `finalizeStaff` or before `_resizeAndRenderScore`. Cluster: **C-5** at the staff level — v3 either lifts the substate concept to a per-(staff, cycle) object (preferred) or adds an explicit reset at the start of `finalizeStaff`.

### B.10 — `BarLayoutingInfo` aggregated max-of by every renderer

Cluster: **C-3**. Refined: v2 said "applyLayoutingInfo re-runs against the final aggregate post-hoc" — that's only the LAST renderer per staff ([StaffSystem.ts:552-553](packages/alphatab/src/rendering/staves/StaffSystem.ts#L552)). Earlier renderers' positions remain "stale" until `reconcileMinDurationIfDirty` (and only when dirty).

### B.11 — `BeamingHelper.finish()` + `alignWithBeats()`

[BeamingHelper.ts:109-119](packages/alphatab/src/rendering/utils/BeamingHelper.ts#L109), [LineBarRenderer.ts:1017-1163](packages/alphatab/src/rendering/LineBarRenderer.ts#L1017). Cluster: **C-1 + C-5**. *Corrected against v2.* `alignWithBeats` is in practice a `drawingInfos.clear()`; the in-place `startX/endX` writes are dead. `drawingInfos` is repopulated on the next `ensureBeamDrawingInfo` cache-miss in `emitHelperSkyline`. v3 commits to "Drop Phase A, eagerly populate both directions in Phase B" — see §D.5.

### B.12 — `_finalizeTies` cross-renderer skyline writes

[BarRendererBase.ts:600-637](packages/alphatab/src/rendering/BarRendererBase.ts#L600). Cluster: **C-1 + C-5**. Tie writes today land in spanned renderers' *bar-local* skylines, which feed `_unionBarLocalIntoStaffSkyline`, which feeds `placeAndApply`'s per-renderer `r.x`-windowed queries ([EffectSystemPlacement.ts:63-64, 92-97](packages/alphatab/src/rendering/EffectSystemPlacement.ts#L63)). v3 keeps this contract (decision recorded in §D.6).

### B.13 — `topEffects/bottomEffects.alignGlyphs` called 3× (4× on resize)

[BarRendererBase.ts:692, :550, :414, :968](packages/alphatab/src/rendering/BarRendererBase.ts). Cluster: **C-1**. Interacts with `_sharedLayoutData` lifecycle via `EffectInfo.onAlignGlyphs` (see B.17).

### B.14 — `EffectSystemPlacement.reset()`

[EffectSystemPlacement.ts:31-44](packages/alphatab/src/rendering/EffectSystemPlacement.ts#L31). Cluster: **C-5**. Today exists because `finalizeStaff` can run placement twice (`needsSecondPass`). v3 retains the inner before/after `contentTop`/`contentBottom` *sampling* (which is `placeAndApply`'s height-attribution mechanic, not a second pass) and deletes only the `needsSecondPass` outer loop — see §D.6.

### B.15 — `_systemSkyline` lazy alloc + manual reset

[RenderStaff.ts:222, :278](packages/alphatab/src/rendering/staves/RenderStaff.ts#L278). Cluster: **C-5**.

### B.16 — `BarLayoutingInfo` shared mutable

[RenderStaff.ts:164](packages/alphatab/src/rendering/staves/RenderStaff.ts#L164), [StaffSystem.ts:340](packages/alphatab/src/rendering/staves/StaffSystem.ts#L340). Cluster: **C-3**. The cross-bar broker. v3 keeps it as a broker but adds an explicit seal contract (CoordinateAssemble seals local; CoordinateReconcile seals system-aware).

### B.17 — `_sharedLayoutData` string-keyed map on `RenderStaff`

[RenderStaff.ts:24, :109-118](packages/alphatab/src/rendering/staves/RenderStaff.ts#L109). Cluster: **C-5**. Used by `TabWhammyEffectInfo.onAlignGlyphs` ([TabWhammyEffectInfo.ts:44-60](packages/alphatab/src/rendering/effects/TabWhammyEffectInfo.ts#L44)). Reset point bleeds across renders on resize (review M4) — fixed in concert with B.13.

### B.18 — `_appliedLayoutingInfo` skipping `alignGlyphs` side effect

[BarRendererBase.ts:526](packages/alphatab/src/rendering/BarRendererBase.ts#L526). Cluster: **C-3**. Symptom of B.13. Single `alignGlyphs` call point retires it.

### B.19 — `BarLayoutingInfo.version` bumped intra-bar in `addSpring` (NEW; review M1)

[BarLayoutingInfo.ts:136](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts#L136). Cluster: **C-3**. The cookie protects against intra-bar partial-state reads too, not just cross-bar. After Step 8 seals "no `applyLayoutingInfo` calls inside `doLayout`," this protection becomes moot.

### B.20 — `MultiBarRestBeatContainerGlyph.beatId === -1` skips pending-effect flush (NEW; review M2)

[BarRendererBase.ts:386](packages/alphatab/src/rendererBase.ts#L386), [MultiBarRestBeatContainerGlyph.ts](packages/alphatab/src/rendering/MultiBarRestBeatContainerGlyph.ts). Cluster: **C-2**. Latent landmine. Step 4 retires.

### B.21 — `Bar.simileMark === SecondOfDouble` flips `canWrap` from `doLayout` (NEW; review M3)

[BarRendererBase.ts:686-688](packages/alphatab/src/rendering/BarRendererBase.ts#L686), [StaffSystem.ts:375-377](packages/alphatab/src/rendering/staves/StaffSystem.ts#L375). Cluster: **C-2**. `canWrap` is consumed during system-assembly; setting it inside `doLayout` is Phase-1 affecting Coordinate's consumers. Decidable from the model alone — moves to CoordinateAssemble.

### B.22 — `_sharedLayoutData` reset point bleeds across renders on resize (NEW; review M4)

[VerticalLayoutBase.ts:455](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L455), [HorizontalScreenLayout.ts:221](packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts#L221). Cluster: **C-5**. The keyed bag is not versioned, so resize's pre-`alignGlyphs` reads pick up prior-cycle values. Resolved by the staff-level substate from Step 11.

### B.23 — `RenderStaff.height` early-computed in `calculateHeightForAccolade` (NEW; review M6)

[RenderStaff.ts:290-298](packages/alphatab/src/rendering/staves/RenderStaff.ts#L290). Cluster: **C-2**. Called from `_calculateAccoladeSpacing` mid-`addBars`/`addMasterBarRenderers`; uses `barRenderers[0].height` before later-added renderers contribute. Step 1's pre-pass restructuring can destabilize this — Step 1 includes an explicit invariant for accolade height.

### B.24 — `_postBeatGlyphs.doLayout()` no-op in `recreatePreBeatGlyphs` (NEW; review M7)

[BarRendererBase.ts:976](packages/alphatab/src/rendering/BarRendererBase.ts#L976). `LeftToRightLayoutingGlyphGroup.doLayout` is empty ([LeftToRightLayoutingGlyphGroup.ts:15-17](packages/alphatab/src/rendering/glyphs/LeftToRightLayoutingGlyphGroup.ts#L15)). Dead code. Step 10 retires.

### B.25 — Effect-band x range queries `getBeatX` on the wrong renderer (NEW; review §F.5 / Minor 14)

[EffectBand.ts:251-294](packages/alphatab/src/rendering/EffectBand.ts#L251), `GroupedEffectGlyph.getBoundingBoxRight` → `renderer.getBeatX(endBeat, endPosition)`. For Span-category effects that cross a renderer, `endBeat` lives in a different renderer's voiceContainer and `getBeatX` returns 0. `computeLocalXRange` under-reports. Cluster: **C-4**. v3 says: validity phase for `computeLocalXRange` is *SystemFinalize* (after staff placement is closed), and the cross-renderer end-X case goes through `populateSkyline?` / a system-aware query.

---

## §C. Root anti-patterns

v2's five clusters are preserved verbatim by name. One new cluster is added.

### C-1. Retroactive position mutation
Definition unchanged from v2. Instances: B.1, B.2, B.10, B.11, B.13.

### C-2. Out-of-order phase dependency
Definition unchanged. Instances: B.4 (the `index===0` part), B.5, B.6, B.7, B.20, B.21, B.23.

### C-3. Lazy cross-bar coordination through a shared mutable broker
Definition unchanged. Instances: B.3, B.10, B.16, B.18, B.19.

### C-4. Bounding-box as side-channel for renderer state
Definition unchanged. Instances: B.1 (consumer), B.5 (consumer), B.7, B.25.

### C-5. Renderer-as-shared-mutable-state across phases
Definition unchanged. Instances: B.9, B.9b, B.11, B.14, B.15, B.22, plus B.4's substate part.

### C-6. Staff-level mutable accumulators with implicit reset points (NEW)
**Definition.** `RenderStaff` itself carries max-of accumulators (`topOverflow`, `bottomOverflow`, `staffTop`, `staffBottom`) and a keyed bag (`_sharedLayoutData`) that are reset at scattered call sites or not at all on certain paths. Distinct from C-5 because C-5 is renderer-scoped; C-6 is staff-scoped and not addressed by Step 11's renderer-level substate unless explicitly lifted.

**Instances**: B.9b, B.17, B.22.

**Target.** Lift the substate concept from renderer-level (Step 11) to a per-(staff, cycle) container, OR add explicit, single-call-site staff resets at the top of `finalizeStaff` / before `_resizeAndRenderScore`. The former is preferred because it composes with renderer-level substate.

---

## §D. Target architecture

### D.1 Phase DAG

```
            ┌─────────────────────────────────────────────────┐
            │              Phase 0: Build                      │
            │   constructor + factory.create + helpers.init    │
            └────────────────────────┬─────────────────────────┘
                                     │
                                     ▼
            ┌─────────────────────────────────────────────────┐
            │              Phase 1: Intrinsic                  │
            │   per-bar; voiceContainer.doLayout + glyphs;     │
            │   publishes intrinsic sizes into BarLayoutingInfo│
            │   No reads of sibling renderers or staff state.  │
            └────────────────────────┬─────────────────────────┘
                                     │  per master bar
                                     ▼
            ┌─────────────────────────────────────────────────┐
            │  System-level (per master bar): CoordinateAssemble│
            │  • compute firstVisibleStaff from model           │
            │  • compute canWrap from model (SimileMark)        │
            │  • layoutingInfo.finish()  — local seal           │
            │  • _trackSystemMinDuration (eager-recompute branch)│
            │  • per-staff per-renderer Phase 2 (Spaced)         │
            │  • update incremental system width totals          │
            └────────────────────────┬─────────────────────────┘
                                     │  next bar, or system close
                                     ▼
            ┌─────────────────────────────────────────────────┐
            │      System-level (once per system, on close):   │
            │              CoordinateReconcile                  │
            │  • if isMinDurationDirty: for each stale bar,     │
            │      recomputeSpringConstants + Phase 2 re-run   │
            │  • rebuild system width / contentWidth / overhead │
            │  • SEAL: BarLayoutingInfo is read-only thereafter │
            └────────────────────────┬─────────────────────────┘
                                     │  per renderer (one final pass)
                                     ▼
            ┌─────────────────────────────────────────────────┐
            │              Phase 2: Spaced  (single-write)     │
            │   given final width, compute every position once:│
            │   _preBeatGlyphs.width, voiceContainer.x,        │
            │   beat container x (via _scaleToForce, ONCE),    │
            │   _postBeatGlyphs.x, width, beam drawingInfos    │
            │   (both directions), effect-band alignGlyphs (1×)│
            └────────────────────────┬─────────────────────────┘
                                     │
                                     ▼
            ┌─────────────────────────────────────────────────┐
            │              Phase 3: Finalized                  │
            │   • emit pre/beat/post bar-local skyline (bbox-  │
            │     driven, valid because Spaced sealed positions)│
            │   • populateSkyline? hook for declared-dynamic    │
            │     glyphs (BarTempoGlyph, GroupedEffectGlyph)    │
            │   • content-height accounting                     │
            └────────────────────────┬─────────────────────────┘
                                     │  for every renderer
                                     ▼
            ┌─────────────────────────────────────────────────┐
            │              SystemFinalize (per staff)          │
            │   • for each tie: tie.layoutAndEmit              │
            │       writes into spanned renderer's bar-local   │
            │       skyline (contract preserved from today)    │
            │   • union every bar-local into staffSkyline      │
            │   • effectPlacement.placeAndApply (one call;     │
            │     internal contentTop/contentBottom sampling   │
            │     preserved as height-attribution mechanic)    │
            │   • apply renderer.y = topPadding + topOverflow  │
            └─────────────────────────────────────────────────┘
```

**Why Coordinate is two-step.** [reconcile-min-duration.md §6](./investigations/reconcile-min-duration.md) proves a single seal cannot work for vertical layouts: bar (N+M) can introduce a shorter min-duration that retroactively invalidates bars 1..(N+M−1)'s springs, and the dirty flag is consumed at `_fitSystem` ([VerticalLayoutBase.ts:411](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L411)) — well past assembly. `CoordinateAssemble` provides the incremental width feedback `addBars` needs ("would this bar push us past page width?"); `CoordinateReconcile` runs at system close and is the actual seal.

`HorizontalScreenLayout` has `shareMinDurationAcrossBars = false` ([HorizontalScreenLayout.ts:76](packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts#L76)); for it `CoordinateReconcile` is a no-op (no stale bars), but the phase still runs as the explicit seal point.

### D.2 Phase contracts (state immutability table)

This is the answer to v2's missing "what's final after each phase" question. After a phase ends, the listed fields are immutable for the rest of the layout cycle.

| Field | After Phase 1 (Intrinsic) | After CoordinateAssemble | After CoordinateReconcile | After Phase 2 (Spaced) | After Phase 3 (Finalized) | After SystemFinalize |
| --- | --- | --- | --- | --- | --- | --- |
| `BarLayoutingInfo.{preBeatSize, postBeatSize}` of this bar | written | LOCAL seal | SYSTEM seal | (read-only) | (read-only) | (read-only) |
| `BarLayoutingInfo.{minStretchForce, totalSpringConstant, springConstants}` | written | LOCAL seal | SYSTEM seal | (read-only) | (read-only) | (read-only) |
| `staff.isFirstInSystem` / `staff.firstVisibleStaff` ref | model-derived | **final** | (final) | (final) | (final) | (final) |
| `bar.canWrap` | (untouched in Phase 1) | **final** (from model) | (final) | (final) | (final) | (final) |
| `renderer.width`, `renderer.computedWidth` | intrinsic | intrinsic | **system-aware final** | **final** | (final) | (final) |
| `_preBeatGlyphs.{x, width}` | intrinsic | intrinsic | (final) | **final** | (final) | (final) |
| `voiceContainer.x`, beat container x | intrinsic | intrinsic | (intermediate) | **final** | (final) | (final) |
| `_postBeatGlyphs.{x, width}` | intrinsic | intrinsic | (intermediate) | **final** | (final) | (final) |
| `renderer.height` | initialized | (unchanged) | (unchanged) | (unchanged) | **may grow once** | (final) |
| `BeamingHelper.drawingInfos[canonical]` | (not populated) | (not populated) | (not populated) | **final, written once** | (final) | (final) |
| `BeamingHelper.drawingInfos[tuplet]` | (not populated) | (not populated) | (not populated) | **final, written once when needed** | (final) | (final) |
| `topEffects/bottomEffects.alignGlyphs` state | (not invoked) | (not invoked) | (not invoked) | **final, invoked once** | (final) | (final) |
| `barLocalSkyline`, `preBeatLocalSkyline`, `postBeatLocalSkyline` | (reset only) | (reset) | (reset) | (reset only) | **emitted, final** | (final; system also receives tie writes) |
| `_ties[]` content list | populated during glyph construction | (unchanged) | (unchanged) | (unchanged) | (unchanged) | **placed, final** |
| `topEffects.height` / `bottomEffects.height` | (=0) | (=0) | (=0) | (=0) | (=0) | **final** |
| `RenderStaff.topOverflow / bottomOverflow / staffTop / staffBottom` | (reset at staff cycle start) | (max-of accumulating) | (max-of accumulating) | (max-of accumulating) | (max-of accumulating) | **final** |
| `renderer.y` | (=0) | (=0) | (=0) | (=0) | (=0) | **final** |

"intrinsic" = "the value reflects this bar's own contribution before sibling renderers have published." A field marked `intrinsic` is allowed to be mutated by CoordinateReconcile if dirty-bar reconcile catches it; if not dirty, intrinsic == final.

### D.3 Glyph contract

```ts
abstract class Glyph {
  // Phase 1. Pure intrinsic layout. Sets this.x / .width / .height in
  // glyph-local coordinates. May read renderer for resources/canvas only.
  // May NOT read renderer.staff.system or sibling renderers.
  // May call renderer.publishIntrinsic*(...) to contribute to BarLayoutingInfo.
  doLayout(): void;

  // Pure geometric query — function of glyph's own fields, set by doLayout.
  // Stable once doLayout returns. May NOT consult renderer/staff/system state.
  getBoundingBoxLeft(): number;
  getBoundingBoxRight(): number;
  getBoundingBoxTop(): number;
  getBoundingBoxBottom(): number;

  // Optional. Phase 3 hook for glyphs whose skyline contribution legitimately
  // depends on placement state set in Phase 2 (BarTempoGlyph reads the final
  // post-beat group x; GroupedEffectGlyph end-X case from B.25). Stays in v3
  // because not every dynamic case is retired by Phase 2 finality.
  populateSkyline?(target: BarLocalSkyline | StaffSystemSkyline,
                   renderer: BarRendererBase): void;
}
```

**Decision on the v2 ambiguity (review §9).** v2 was inconsistent about whether `populateSkyline?` survives Phase 13 or not. v3 commits: **the hook stays.** It is the canonical seam for the small set of glyphs that have post-Phase-2 contributions. Currently two glyphs implement it (BarTempoGlyph for the post-beat-anchored case, GroupedEffectGlyph for the cross-renderer end-X case). Phase 13's audit (Step 13) is `getBoundingBox*` purity, not hook elimination.

### D.4 BarLayoutingInfo's role and `_appliedLayoutingInfo`

`BarLayoutingInfo` remains a shared cross-bar broker. v3 does **not** push it to a `MasterBarLayout` per review §F.3 — that's a larger refactor for a smaller correctness win; deferred to §G.

The `_appliedLayoutingInfo` version cookie is **perf-only**, confirmed by [reconcile-min-duration.md §3](./investigations/reconcile-min-duration.md). v3's order:

- **Step 8a** drops every intra-`doLayout` call to `applyLayoutingInfo` and lets the version cookie continue to short-circuit redundant work where the call sites haven't been cleaned yet. Removes the `BarLayoutingInfo.version` bumps in `addSpring` (B.19) by separating "spring publish" from "version bump" — version moves only when `recomputeSpringConstants` runs.
- **Step 8b** moves the "should I re-apply?" predicate (`mb.layoutingInfo.computedWithMinDuration > this.minDuration`) into `reconcileMinDurationIfDirty` itself, so the loop only re-applies on bars it actually re-derived ([reconcile-min-duration.md §5](./investigations/reconcile-min-duration.md)). After 8b, the version cookie is purely defensive against future regressions and can be deleted.

### D.5 BeamingHelper drawingInfos — decision

Two routes were on the table after [beam-helper-drawinginfos.md](./investigations/beam-helper-drawinginfos.md):

- **Route A** ("two phases"): keep Phase A (overflow probe populates canonical drawingInfo in `doLayout`/`calculateOverflows`) and Phase B (invalidate + rebuild in Phase 2). The Phase A probe writes pre-spring X that's never read after the Phase B clear, so it's expensive but harmless.
- **Route B** ("drop Phase A, eagerly populate both directions in Phase B"): rewrite `calculateBeamingOverflows` to compute beam Y *directly* (via `getFlagTopY` / `getFlagBottomY` / max-slope clamp) without caching in `drawingInfos`. In Phase 2, populate `drawingInfos[canonical]` and — if `getTupletBeamDirection(h) !== getBeamDirection(h)` — also `drawingInfos[tuplet]`. Phase 3 and paint then read-only.

**v3 chooses Route B.**

Cost of Route B: rewrite `LineBarRenderer.calculateBeamingOverflows` to do its own beam-Y math without touching `drawingInfos` (50–80 lines, isolated to LineBarRenderer); add a "populate-both-directions" path inside `initializeBeamDrawingInfo` / `ensureBeamDrawingInfo` (20–30 lines).

Cost of Route A: rename the misleading `alignWithBeats` to `invalidateDrawingInfos` and leave the rest; ~5 lines. But it leaves `drawingInfos` mutating across phases (touched in Phase 1 *and* Phase 2 *and* paint), which contradicts D.2's table row for `drawingInfos[canonical]` being "final after Phase 2."

**Justification.** Route A would re-introduce the C-1 anti-pattern at the beam-cache level. Route B costs ~100 lines and gives v3 a phase contract that holds. The "clear-in-iteration" bug from §B.11 is moot under Route B (the `.clear()` call goes away entirely along with the loop).

### D.6 Tie / slur finalization — decision

Two routes:

- **(a)** Hoist *only the invocation point* of `_finalizeTies`; keep ties writing per-bar into spanned renderers' bar-local skylines. `EffectSystemPlacement.placeAndApply`'s per-renderer `r.x`-windowed queries continue to work unchanged.
- **(b)** Move tie writes to the system skyline directly and refactor `EffectSystemPlacement.placeAndApply` to attribute per-renderer overflow via system-skyline queries.

**v3 chooses (a).**

Reasoning. The review (Critical #3) showed `placeAndApply` already does per-renderer `r.x`-windowed queries against the unified staff skyline — meaning the staff skyline (which is built by unioning bar-local skylines via `_unionBarLocalIntoStaffSkyline` with `baseX = renderer.x` at [RenderStaff.ts:236-249](packages/alphatab/src/rendering/staves/RenderStaff.ts#L236)) is *already* the attribution surface. Route (a) preserves this. Route (b) would touch `placeAndApply`'s height-attribution mechanic (the before/after `contentTop`/`contentBottom` sampling) for no gain.

The change in v3 is therefore narrow: `_finalizeTies` runs after every renderer's Phase 3 has finished, not interleaved with `_finalizeRenderer`. `needsSecondPass` outer loop dies because ties are placed before `placeAndApply` runs. The inner before/after sampling in `placeAndApply` stays (it's how `topEffects.height` is computed per renderer — it is NOT validation).

Span-category effects' cross-renderer end-X (B.25) is handled by `populateSkyline?` on `GroupedEffectGlyph`: at SystemFinalize time, the glyph knows the staff's full renderer chain and can compute its true end-X.

### D.7 Skyline emission

One point, end of Phase 3:

```ts
// BarRendererBase.finalize()
finalize(): void {
  emitPreBeatSkyline();    // walks _preBeatGlyphs.glyphs, reads each bbox
  emitBeatSkyline();       // walks voiceContainer beats, reads each bbox +
                           //   per-beat effect ranges captured during Phase 1
  emitPostBeatSkyline();   // walks _postBeatGlyphs.glyphs (post-beat x final)
  for (const g of populateSkylineGlyphs) {
    g.populateSkyline!(barLocalSkyline, this);
  }
  // ties / slurs / cross-renderer GroupedEffectGlyph end-X: SystemFinalize
}
```

No reset, no version, no pending queue. `_pendingBeatEffectsByBeat` becomes a per-beat list attached to the beat container during Phase 1 and consumed in the Phase 3 beat walk (which now runs *after* Phase 2 sealed positions). `_dynamicSkylineGlyphs` disappears (BarNumberGlyph bbox stable; BarTempoGlyph uses `populateSkyline?`).

### D.8 Resize entry point

Resize re-enters at CoordinateAssemble:

```
ScoreLayout.resize:
  for each reused renderer: drop Phase-2+ substate (LayoutCycle reassign)
  for each master bar: CoordinateAssemble (cheap; firstVisibleStaff
                                            and canWrap recomputed from model)
  for each system close: CoordinateReconcile + Phase 2 + Phase 3 + SystemFinalize
```

Phase 1's output (glyphs, intrinsic widths, pre-beat content) survives the resize unless content actually changed. `wasFirstOfStaff`/`recreatePreBeatGlyphs` does not survive — because `staff.index` may have changed (a bar may now sit at `index===0` of a new system), pre-beat content must be rebuilt for that bar specifically. Step 10 retires the dedicated `recreatePreBeatGlyphs` path by letting `LayoutCycle`-discard plus a per-cycle `createPreBeatGlyphs` call do it.

### D.9 Where existing call sites map

| Existing | Target phase |
| --- | --- |
| `BarRendererBase.doLayout` glyph creation | Phase 1 |
| `BarRendererBase._registerLayoutingInfo` | Phase 1 (publish into broker) |
| `BarLayoutingInfo.finish` | CoordinateAssemble |
| `_trackSystemMinDuration` (eager branch) + `reconcileMinDurationIfDirty` | CoordinateAssemble + CoordinateReconcile |
| `StaffSystem.firstVisibleStaff` / `bar.canWrap` | CoordinateAssemble |
| `BarRendererBase.applyLayoutingInfo` body (minus version skip) | Phase 2 |
| `BarRendererBase.updateSizes` | folded into Phase 2 |
| `BarRendererBase.scaleToWidth` body | Phase 2 (single call at final width) |
| `MultiVoiceContainerGlyph._scaleToForce` calls | one per Phase 2 entry |
| `BeamingHelper.alignWithBeats` | DELETED (Route B); replaced by Phase 2 eager populate |
| `LineBarRenderer.calculateBeamingOverflows` | Phase 1, rewritten to direct Y math (no cache touch) |
| `BarRendererBase.calculateOverflows` | Phase 3 |
| `BarRendererBase._dynamicSkylineGlyphs` | DELETED |
| `_pendingBeatEffectsByBeat` | DELETED |
| `BarRendererBase.finalizeRenderer` | Phase 3 |
| `_finalizeTies` | SystemFinalize (post Phase 3 loop) |
| `EffectSystemPlacement.placeAndApply` outer `needsSecondPass` loop | DELETED (ties placed before; inner sampling preserved) |
| `HorizontalScreenLayout._alignRenderers` second `scaleToWidth` | DELETED (Step 7) |

---

## §E. Migration plan (18 steps)

Each step lists: **finding closed** (review §X / investigation Y), **files touched**, **inventory item retired**, **risk tier**, **blast radius**, **parallelizability**, **acceptance gate**.

The plan has a real DAG, not a linear chain. The §"Dependency graph" subsection below shows it.

### Step 0. Hoist `_scaleToForce` out of the voice loop
- **Closes**: review Critical #1.
- **Outcome**: per-bar `_scaleToForce` call count drops from N+1 to 2 (one in `applyLayoutingInfo`, one in `scaleToWidth`). Subsequent steps retire the second.
- **Note**: this is an investigation outcome ([scale-to-force-multi-call.md](./investigations/scale-to-force-multi-call.md)), not architectural; do this before phase work begins so the rest of the plan can rely on Phase 2 being single-write.
- **Touch**: [MultiVoiceContainerGlyph.ts:160-167](packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts#L160) only.
- **Retires**: nothing in §B directly; precondition for B.1 single-write.
- **Risk**: low. Pixel-identical expected ([investigation §"Visual / behavioural impact"](./investigations/scale-to-force-multi-call.md)).
- **Blast radius**: low; one method.
- **Parallel**: stands alone; should land first.
- **Acceptance**: full visual regression suite, byte-identical PNGs.

### Step 1. Pre-pass `firstVisibleStaff` from model, with revert handling
- **Closes**: review §10; closes B.5.
- **Touch**: [StaffSystem.ts:322, :395, :510](packages/alphatab/src/rendering/staves/StaffSystem.ts#L322), [RenderStaff.ts:175-192](packages/alphatab/src/rendering/staves/RenderStaff.ts#L175).
- **Retires**: B.5, half of B.7.
- **Risk**: low. Loop above the staves loop simulates visibility from model.
- **Blast radius**: low.
- **Parallel**: yes, with Steps 2/3/4/5/6.
- **Acceptance**: tests `hideEmptyStaves` with multi-staff; plus a `revertLastBar` test where reverting flips visibility mid-system. **The acceptance test corpus is named explicitly in Step 1**: `VisualTests.GhostStaffVisibility` test set (mid-system revert + hideEmptyStaves) — if no such test exists, Step 1 must add one before merge.

### Step 2. Drop `BarNumberGlyph` bbox overrides
- **Closes**: review Critical-adjacent (the §G dismissal complaint resolves only partially).
- **Touch**: [BarNumberGlyph.ts](packages/alphatab/src/rendering/glyphs/BarNumberGlyph.ts).
- **Retires**: half of B.7.
- **Risk**: low. Requires Step 1.
- **Blast radius**: low.
- **Parallel**: with Step 3 after Step 1 lands.

### Step 3. Replace `_dynamicSkylineGlyphs` with `populateSkyline?` hook
- **Closes**: review §9 (ambiguity resolved by D.3 decision).
- **Touch**: [Glyph.ts](packages/alphatab/src/rendering/glyphs/Glyph.ts), [BarTempoGlyph.ts](packages/alphatab/src/rendering/glyphs/BarTempoGlyph.ts), [BarRendererBase.ts:216-220, :422-458](packages/alphatab/src/rendering/BarRendererBase.ts#L216).
- **Retires**: other half of B.7; introduces the canonical hook from D.3.
- **Risk**: low–medium. Net-zero behaviour with cleaner shape.
- **Blast radius**: low.
- **Parallel**: yes.

### Step 4. Fold `_pendingBeatEffectsByBeat` into the beat walk
- **Closes**: B.6 + B.20.
- **Touch**: [BarRendererBase.ts:143, :281, :387-399](packages/alphatab/src/rendering/BarRendererBase.ts#L281).
- **Retires**: B.6, B.20.
- **Risk**: low.
- **Blast radius**: low.
- **Parallel**: yes.

### Step 5. Audit `EffectInfo.onAlignGlyphs` consumers; **then** reduce alignGlyphs call sites to one
- **Closes**: review §8.
- **Touch**: [TabWhammyEffectInfo.ts:44-60](packages/alphatab/src/rendering/effects/TabWhammyEffectInfo.ts#L44), every consumer of `_sharedLayoutData`, [BarRendererBase.ts:692, :550, :414, :968](packages/alphatab/src/rendering/BarRendererBase.ts).
- **Sub-steps**: 5a (audit `onAlignGlyphs` for max-of semantics — currently true for whammy); 5b (move `_sharedLayoutData` reset to Phase 1 entry point); 5c (remove the doLayout-time and applyLayoutingInfo-time and reLayout-time `alignGlyphs` calls).
- **Retires**: B.13, B.18 (when 8 lands and the cookie goes), partially B.17.
- **Risk**: medium. The whammy `_sharedLayoutData` lifecycle is the subtle case.
- **Blast radius**: structural (touches every band-using renderer).
- **Parallel**: 5a is parallel; 5b/5c are sequential.
- **Acceptance**: TabWhammy visual fixtures stay byte-identical.

### Step 6. Idempotent `updateSizes` (drop `height += layoutingInfo.height`)
- **Closes**: B.2.
- **Touch**: [BarRendererBase.ts:808](packages/alphatab/src/rendering/BarRendererBase.ts#L808).
- **Retires**: B.2.
- **Risk**: low. `layoutingInfo.height` is 0 today; the `+=` is misleading.
- **Blast radius**: low.
- **Parallel**: yes.

### Step 7. Remove `HorizontalScreenLayout._alignRenderers` second `scaleToWidth`
- **Closes**: review §12; B.8.
- **Touch**: [HorizontalScreenLayout.ts:212-237](packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts#L212).
- **Retires**: B.8.
- **Risk**: medium. The "verify what's dropped" concern from v2 is real; visual regen across HorizontalScreenLayout tests is significant.
- **Blast radius**: structural (touches one layout file but every horizontal-mode test).
- **Parallel**: yes (independent of other early steps).
- **Hard prereq for**: Step 13.

### Step 8a. Drop `applyLayoutingInfo` calls from `doLayout`; rename to `phaseTwo` (or equivalent); keep version cookie temporarily
- **Closes**: review Critical #2 (first half).
- **Touch**: [BarRendererBase.ts:525-551](packages/alphatab/src/rendering/BarRendererBase.ts#L525), [StaffSystem.ts:552-553](packages/alphatab/src/rendering/staves/StaffSystem.ts#L552), every doLayout call path.
- **Retires**: intra-bar B.19 reads (version still bumps but no intra-bar consumer reads partial state).
- **Risk**: medium. Cross-cutting.
- **Blast radius**: structural.
- **Parallel**: with 8b (different files).

### Step 8b. Move "should I re-apply?" predicate into `reconcileMinDurationIfDirty`; then delete `_appliedLayoutingInfo`
- **Closes**: review Critical #2 (second half).
- **Touch**: [StaffSystem.ts:446-491](packages/alphatab/src/rendering/staves/StaffSystem.ts#L446), [BarRendererBase.ts:510, :526](packages/alphatab/src/rendering/BarRendererBase.ts#L510).
- **Retires**: B.3, B.18, B.19.
- **Risk**: medium–high. Cross-bar correctness.
- **Blast radius**: structural.
- **Parallel**: with 8a (independent test load).
- **Acceptance**: every fixture in [SystemSpacing.test.ts](packages/alphatab/test/visualTests/features/SystemSpacing.test.ts) byte-identical (especially `shared-min-duration-reconciles-on-resize`, `shared-min-duration-multiple-short-arrivals`, `shared-min-duration-per-system-isolation`, `shared-min-duration-page-automatic`).

### Step 9. Single-write `_postBeatGlyphs.x`
- **Closes**: B.1.
- **Touch**: [BarRendererBase.ts:804, :541, :412](packages/alphatab/src/rendering/BarRendererBase.ts#L412).
- **Retires**: B.1.
- **Risk**: medium. Audit `getRatioPositionX` callers (BarTempoGlyph was the only one; Step 3 moved it to `populateSkyline?`).
- **Blast radius**: low–structural.
- **Parallel**: with Steps 10/11.
- **Prereq**: Steps 0, 8a (so that "final" is achievable).

### Step 10. Replace `wasFirstOfStaff` / `recreatePreBeatGlyphs` with `LayoutCycle`-discard pre-beat rebuild
- **Closes**: review Critical #4.
- **Touch**: [BarRendererBase.ts:899, :974-994](packages/alphatab/src/rendering/BarRendererBase.ts#L974), [RenderStaff.addBarRenderer:132](packages/alphatab/src/rendering/staves/RenderStaff.ts#L132), [VerticalLayoutBase._resizeAndRenderScore:281](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L281).
- **Retires**: B.4, B.24 (the `_postBeatGlyphs.doLayout()` no-op line dies).
- **Risk**: high. Touches the whole resize entry.
- **Blast radius**: structural.
- **Parallel**: no (sequential after 11).
- **Prereq (CORRECTED)**: **Steps 1, 8, 11.** Not "1, 8" as v2 said — review Critical #4 was right: the substate refactor is the actual prerequisite.
- **Acceptance**: `triggerResize` test that flips a bar's line-index across wrap (i.e. resize from "bar 5 at line position 4" to "bar 5 at line position 0"). Pre-beat content (clef/key-sig/time-sig) must reflect the new line position. **Test corpus name**: `VisualTests.ResizeWrapPointPreBeat` — if absent, Step 10 adds it before merge.

### Step 11. Unify renderer + staff per-cycle state into `LayoutCycle` substate, atomically swapped on resize
- **Closes**: review Critical #5; C-5 + C-6.
- **Touch**: [BarRendererBase.ts](packages/alphatab/src/rendering/BarRendererBase.ts), [RenderStaff.ts](packages/alphatab/src/rendering/staves/RenderStaff.ts).
- **Scope**: extract per-renderer fields (`_barLocalSkyline`, `_preBeatLocalSkyline`, `_postBeatLocalSkyline`, `_pendingBeatEffectsByBeat` *(if not already deleted)*, `_ties`, `_dynamicSkylineGlyphs` *(if not already deleted)*, `_contentTopOverflow`, `_contentBottomOverflow`, `_appliedLayoutingInfo` *(if not already deleted)*, `beatEffectsMinY`, `beatEffectsMaxY`) AND per-staff fields (`_sharedLayoutData`, `topOverflow`, `bottomOverflow`, `staffTop`, `staffBottom`, `_systemSkyline`, `_effectPlacement`) into substate objects that are atomically reassigned per layout cycle.
- **Retires**: B.9, B.9b, B.15, B.17, B.22.
- **Risk**: medium (mechanical, but cross-cutting).
- **Blast radius**: structural.
- **Parallel**: no (must precede 10, 12, 13).
- **Prereq for**: Step 10, Step 12, Step 13.

### Step 12. Hoist tie/slur finalization invocation to SystemFinalize (keep per-bar writes)
- **Closes**: review Critical #3.
- **Touch**: [RenderStaff.finalizeStaff:308](packages/alphatab/src/rendering/staves/RenderStaff.ts#L308), [BarRendererBase._finalizeTies:600-637](packages/alphatab/src/rendering/BarRendererBase.ts#L600).
- **Retires**: B.12. B.14's `needsSecondPass` outer loop dies; the inner before/after `contentTop`/`contentBottom` sampling is preserved.
- **Risk**: medium. The contract change is invocation-order only; per-bar skyline writes remain.
- **Blast radius**: structural.
- **Parallel**: with 13 in principle, but easier serially.
- **Prereq**: Step 11.
- **Acceptance**: cross-system slur and bend-up arc visual fixtures byte-identical.

### Step 13. Three-phase BarRendererBase API split (Intrinsic / Spaced / Finalized) + Coordinate two-step
- **Closes**: closes C-1; collapses the lifecycle to D.1.
- **Touch**: [BarRendererBase.ts](packages/alphatab/src/rendering/BarRendererBase.ts) (rewrite `doLayout` / `applyLayoutingInfo` / `scaleToWidth` / `calculateOverflows` / `finalizeRenderer` into `intrinsicLayout` / `spacedLayout` / `finalize`). Every subclass override.
- **Subclass override surface (per review §11)**: `LineBarRenderer.emitHelperSkyline`, `emitBeatSkyline`, `emitSubclassBarLocalSkyline`, `completeBeamingHelper`, `initializeBeamDrawingInfo`, `calculateBeamingOverflows` — each is explicitly relocated:

| Subclass method | New phase |
| --- | --- |
| `calculateBeamingOverflows` | Phase 1 (rewritten to direct Y math, no `drawingInfos` touch — Route B from D.5) |
| `initializeBeamDrawingInfo` | Phase 2 (eagerly populate both directions when needed) |
| `ensureBeamDrawingInfo` | DELETED in callers; paint reads `drawingInfos` directly |
| `emitHelperSkyline` | Phase 3 |
| `emitBeatSkyline` | Phase 3 |
| `emitSubclassBarLocalSkyline` | Phase 3 |
| `completeBeamingHelper` | Phase 1 (called from `helpers.beamHelpers[*].finish()`) |
| `paintTuplets` | Paint (unchanged; reads `drawingInfos` which now contains tuplet direction eagerly) |

- **Retires**: closes C-1.
- **Risk**: high. The largest single step; subclass relocation surface is larger than the v2 estimate.
- **Blast radius**: structural.
- **Parallel**: no.
- **Prereq (HARD)**: Steps 0, 7, 8, 11. **Step 7 is a hard prereq because HorizontalScreenLayout's double `scaleToWidth` violates Phase 2 monotonicity (review §12).**

### Step 14. Audit `Glyph.getBoundingBox*` for strict-geometric purity
- **Closes**: closes C-4 (audit step).
- **Note**: review §"Recommendations" #7 suggested folding into Step 13. v3 keeps it separate because the audit is a *test* against Step 13's invariant — surfacing it as a step means it gets a dedicated acceptance gate. Fewer surprises than burying it inside Step 13.
- **Touch**: every glyph subclass overriding `getBoundingBox*`. Cross-reference with `populateSkyline?` decisions from Step 3.
- **Retires**: tightens C-4 closure.
- **Risk**: medium. `GroupedEffectGlyph.getBoundingBoxRight` is the canonical one to migrate (B.25 / review §F.5).
- **Blast radius**: low (per-glyph).
- **Parallel**: yes, after Step 13.
- **Prereq**: Step 13.

### Step 15. Replace `_sharedLayoutData` string map with typed staff-state container
- **Closes**: B.17 (final cleanup).
- **Touch**: [RenderStaff.ts:24, :109-118](packages/alphatab/src/rendering/staves/RenderStaff.ts#L109), every consumer of `getSharedLayoutData/setSharedLayoutData`.
- **Retires**: B.17 (B.22 already retired by Step 11's lift to per-cycle).
- **Risk**: low–medium.
- **Blast radius**: structural.
- **Parallel**: yes, after Step 5 (which fixed the reset point) and Step 11 (which already lifted lifecycle).
- **Prereq**: Steps 5, 11.

### Step 16. Document and assert SystemFinalize as `EffectBand.computeLocalXRange` validity phase
- **Closes**: review §F.5 / Minor 14 / B.25.
- **Touch**: [EffectBand.ts:251-294](packages/alphatab/src/rendering/EffectBand.ts#L251), `GroupedEffectGlyph.getBoundingBoxRight`, doc-level invariant added to `EffectBand` class header.
- **Scope**: `computeLocalXRange` is contractually called *only* from `EffectSystemPlacement.placeAndApply` (which runs in SystemFinalize). The cross-renderer end-X for Span-category effects is computed at this point via the populated linked-glyph chain — `GroupedEffectGlyph.populateSkyline?` walks to the end renderer to get the real end-X.
- **Retires**: B.25.
- **Risk**: low (mostly documentation + one populateSkyline implementation).
- **Blast radius**: low.
- **Parallel**: with Step 14.
- **Prereq**: Steps 3, 13.

### Step 17. Retire `BeamingHelper.alignWithBeats` and rebuild `drawingInfos` semantics
- **Closes**: review §7; B.11 cluster.
- **Touch**: [BeamingHelper.ts:109-119](packages/alphatab/src/rendering/utils/BeamingHelper.ts#L109), [LineBarRenderer.ts:1017-1163](packages/alphatab/src/rendering/LineBarRenderer.ts#L1017).
- **Scope**: implement Route B from D.5. Delete `alignWithBeats`. Replace `calculateBeamingOverflows`'s `drawingInfos` reads with direct Y math. In Phase 2, populate both directions eagerly if `getTupletBeamDirection(h) !== getBeamDirection(h)`.
- **Retires**: B.11.
- **Risk**: medium. Tuplet-bracket visuals across the score suite.
- **Blast radius**: structural.
- **Parallel**: after Step 13.
- **Prereq**: Step 13.

### Dependency graph (DAG)

```
       Step 0  Step 1  Step 6  Step 4  Step 3  Step 2 (needs 1)
          \      /        \      /      |
           \    /          \    /       |
            \ /             \ /         |
             Step 5  -  Step 7  Step 8a  Step 8b
                            \     |     /
                             \    |    /
                              Step 11
                             /  |    \  \
                            /   |     \  \
                         Step 9 Step 10 Step 12 Step 13
                                            |       |
                                            |       └── Step 14
                                            |       └── Step 16
                                            |       └── Step 17
                                            |
                                          Step 15 (after 5, 11)
```

Hard prereqs:
- Step 13 ⇐ {0, 7, 8a, 8b, 11}.
- Step 10 ⇐ {1, 8 (both), 11}.
- Step 17 ⇐ Step 13.
- Step 12 ⇐ Step 11.

Parallelizable clusters:
- Cluster α (first wave): Steps 0, 1, 6, 4 — all low-risk, low-blast-radius.
- Cluster β (after α): Steps 2, 3 (after 1); Step 5 audit can run in parallel.
- Cluster γ (after β): Steps 7, 8a, 8b can land independently.
- Cluster δ: Step 11 (gates the rest).
- Cluster ε (post 11): Steps 9, 10, 12; Step 13 then unlocks 14, 15, 16, 17.

Total estimate, with parallelism: Cluster α+β+γ in ~1 week of engineering effort across multiple PRs; Cluster δ+ε in ~2 weeks. The migration is gated on review depth for Steps 8b, 10, 11, 13.

---

## §F. Decision points — owner answers

Per review §F: each entry has a concrete answer, not "the author leans X."

### F.1 Is `Glyph.getBoundingBox*` permitted to be dynamic?
**Strict.** Bbox is a pure function of glyph fields set in `doLayout`. The `populateSkyline?` hook is the only seam for layout-state-dependent contributions. Confirmed by Step 14 audit.

### F.2 Is the resize path structurally identical to initial layout?
**Identical code path, but Phase 1 is a no-op.** Resize = same lifecycle phases, but Phase 1's output (intrinsic glyph state) survives from initial layout. Phase 2 onwards always re-runs. Pre-beat content rebuild on resize (when bar moves to/from line-index 0) lives in Step 10's substate-discard path, not in a separate code path.

### F.3 Where does `BarLayoutingInfo` live?
**Stays as a sealed cross-bar broker.** v3 does NOT push to a `MasterBarLayout`. Reasoning: the broker shape is fine *given* the CoordinateAssemble/CoordinateReconcile two-step seal; pushing to `MasterBarLayout` is a larger refactor that doesn't change correctness, just ownership. Deferred to §G.

### F.4 What's the contract for cross-bar glyphs (ties, multi-system slurs)?
**(a) for now.** Hoist `_finalizeTies` invocation to SystemFinalize; keep per-bar skyline writes (preserves placement attribution mechanic). System-level slur registry is a possible later evolution, not part of this migration.

### F.5 What's the contract for `EffectBand.computeLocalXRange`?
**Valid after SystemFinalize.** Not after Phase 2 — because Span-category effects' end-X depends on cross-renderer placement that isn't sealed until SystemFinalize. `GroupedEffectGlyph` migrates its cross-renderer case to `populateSkyline?` at SystemFinalize time. Documented in Step 16.

---

## §G. Research backlog (after investigations)

Honest open items v3 does not close.

### G.1 `MasterBarLayout` ownership refactor (F.3 deferred)
Pushing `BarLayoutingInfo` from a renderer-held broker to a `StaffSystem`-owned object eliminates the temptation to mutate post-Coordinate. Cost ~ Step 13-scale; benefit incremental. Defer until v3 lands.

### G.2 Two-pass-per-system finalization (alternative to CoordinateReconcile)
`reconcile-min-duration.md §5` discusses a two-pass model that collects all bars, then `finish` + `applyLayoutingInfo` once per renderer. Would eliminate the dirty flag entirely. Blocker: `addBars` consumes incremental width feedback for the `systemIsFull` check ([VerticalLayoutBase.ts:503](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L503)). A different "would this bar fit?" estimator is needed. Out of scope for v3.

### G.3 Beam Y stability across staff effect placement
v2 §H asked whether beam drawingInfo Y values are stable across SystemFinalize. v3 keeps the answer "yes, beam Y is in renderer-local content coords and effect placement shifts renderer-y not content-y." This is an *invariant*, not a question, after Step 13. If a future feature breaks this (e.g. effect placement that reaches into the staff content area), it has to refresh `drawingInfos`.

### G.4 `MultiBarRest` voice container intrinsic publish
Review §17 / B.20 noted `MultiBarRestBeatContainerGlyph.beatId === -1` interacts with `_pendingBeatEffectsByBeat`. Step 4 deletes the pending queue. Confirm no other guarded code paths rely on the synthetic beatId. Regression test recommended.

### G.5 Step 1 acceptance with `revertLastBar` corpus
Currently no test directly exercises mid-system revert flipping `firstVisibleStaff`. Step 1 must add `VisualTests.GhostStaffVisibility`. If the test corpus is missing at Step 1 merge time, that's a Step 1 gate, not a Step 1 caveat.

### G.6 Step 10 acceptance with wrap-point-changing resize
Same gate as G.5: `VisualTests.ResizeWrapPointPreBeat` must exist at Step 10 merge time. Pre-beat rebuild on line-index change is otherwise untested.

### G.7 `EffectSystemPlacement.placeAndApply` second-pass branch dies — confirm no other consumer
Review §6 noted the inner before/after sampling stays; v3 commits to deleting only the `needsSecondPass` outer loop. Confirm no test fixture relies on the second pass producing a different result than the first.

---

## §H. Invariants gained at each step

Each step's payoff in terms of system-wide invariants. This is the reader's anchor for understanding progress.

| Step | New invariant after the step lands |
| --- | --- |
| 0 | `_scaleToForce` is called at most twice per bar per layout cycle (was N+1). After Step 13, exactly once. |
| 1 | `staff.isFirstInSystem` is final before any renderer's `doLayout` reads it. Re-derived from model on revert. |
| 2 | `BarNumberGlyph.getBoundingBox*` is a pure function of glyph fields. |
| 3 | The set of glyphs with dynamic-skyline contribution is enumerated by `populateSkyline?`-implementers — no implicit registry. |
| 4 | Beat-effect overflow registration happens inline during beat creation; no per-cycle list survives Phase 1. |
| 5 | `EffectBand` glyph x is set exactly once per cycle. `onAlignGlyphs` runs exactly once per cycle. `_sharedLayoutData` reset point is single and well-defined. |
| 6 | `renderer.height` is set, never accumulated. |
| 7 | `BarRendererBase.scaleToWidth` body runs at most once per renderer per cycle, at the final width. |
| 8a | `applyLayoutingInfo` is never called from inside `doLayout`. `BarLayoutingInfo.version` bumps only via `recomputeSpringConstants`. |
| 8b | The "should I re-apply" decision lives in the reconcile loop, not the apply function. `_appliedLayoutingInfo` is deletable. `BarLayoutingInfo` is read-only after CoordinateReconcile. |
| 9 | `_postBeatGlyphs.x` is written exactly once per cycle (at end of Phase 2). |
| 10 | Resize requires no per-renderer flag to decide pre-beat rebuild — the substate discard pattern subsumes it. |
| 11 | Renderer + staff per-cycle state is captured in two substate objects, atomically reassigned per cycle. No manual reset list survives. |
| 12 | Ties / slurs are placed exactly once per system. `placeAndApply` runs exactly once per staff. |
| 13 | The three-phase contract from D.1 / D.2 holds. Every state field is final after a single named phase. |
| 14 | `Glyph.getBoundingBox*` is provably pure (function of glyph fields) across the entire glyph hierarchy. |
| 15 | Staff-level cross-bar state is typed; no stringly-keyed bag. |
| 16 | `EffectBand.computeLocalXRange` has a documented validity phase (SystemFinalize) and Span-category effects' cross-renderer end-X is correct. |
| 17 | `BeamingHelper.drawingInfos` is populated exactly once per cycle (in Phase 2) and is read-only thereafter. Paint never mutates it. |

After all 18 steps, the invariants in D.2's table are provable, not aspirational.

---

## §I. Significant findings disposition (review §6–§12)

For traceability, each review-Significant finding is mapped to a v3 disposition.

| Review § | Finding | Disposition in v3 |
| --- | --- | --- |
| 6 | `EffectSystemPlacement` two-pass diffing not addressed | Addressed in §D.6: inner sampling preserved, `needsSecondPass` outer loop deleted in Step 12. |
| 7 | `BeamingHelper.alignWithBeats` clears in iteration | Addressed in §D.5 (Route B chosen): function deleted in Step 17; `drawingInfos` populated eagerly in Phase 2. |
| 8 | Step 5 misses `_sharedLayoutData` interaction | Addressed in Step 5 sub-steps (5a/5b/5c). |
| 9 | `populateSkyline?` decision unsettled | Addressed in §D.3: hook stays; Step 3 lands it; Step 13 doesn't delete it. |
| 10 | `revertLastBar` interaction with Step 1 | Addressed in Step 1 acceptance (test corpus `GhostStaffVisibility` named as gate). |
| 11 | Step 13 subclass impact under-scoped | Addressed in Step 13's subclass-method-to-phase table. |
| 12 | HorizontalScreenLayout's double `scaleToWidth` | Addressed in Step 7 + Step 13 hard prereq. |

Review §13–§18 (Minor): all folded into §B inventory entries or §G research backlog.

---

## §J. Sign-off checklist

Mapping back to the review's 10 sign-off conditions:

1. **Critical 1 resolved** — Step 0 hoists `_scaleToForce`; §D.2 table makes "single-write Phase 2" explicit; §D.1 contract matches.
2. **Critical 2 resolved** — §B.3 and §C-3 acknowledge `_appliedLayoutingInfo` as perf-only (per investigation); Step 8a/8b are explicit; version-cookie deletion pinned to 8b.
3. **Critical 3 resolved** — §D.6 commits to keeping per-bar tie writes; only the invocation point hoists. Step 12 reflects this.
4. **Critical 4 resolved** — Step 10's prereq corrected to {1, 8, 11}.
5. **Critical 5 resolved** — B.9b added; C-6 new cluster; Step 11 lifts substate to per-(staff, cycle).
6. **Significant 7 resolved** — §D.5 chooses Route B; Step 17 retires `alignWithBeats`.
7. **§F decisions made** — each F.1–F.5 has a concrete answer.
8. **§E dependency DAG** — added inline above.
9. **Revert+resize test corpus named** — Step 1 (`GhostStaffVisibility`), Step 10 (`ResizeWrapPointPreBeat`).
10. **Decide-and-document gaps resolved** — F.5 / B.25 / cross-renderer end-X resolved via Step 16's `populateSkyline?` migration.

All 10 sign-off conditions are addressed. v3 is ready for implementation review.

---

## Appendix: cited files

- [`packages/alphatab/src/rendering/BarRendererBase.ts`](packages/alphatab/src/rendering/BarRendererBase.ts) — the lifecycle core.
- [`packages/alphatab/src/rendering/staves/RenderStaff.ts`](packages/alphatab/src/rendering/staves/RenderStaff.ts) — staff loop, overflow accumulators, shared data.
- [`packages/alphatab/src/rendering/staves/StaffSystem.ts`](packages/alphatab/src/rendering/staves/StaffSystem.ts) — system assembly, min-duration reconcile.
- [`packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts`](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts) — cross-bar broker, version, recomputeSpringConstants.
- [`packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts`](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts) — `_fitSystem`, `_resizeAndRenderScore`.
- [`packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts`](packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts) — `_scaleBars`, `_alignRenderers`, opt-out switch.
- [`packages/alphatab/src/rendering/utils/BeamingHelper.ts`](packages/alphatab/src/rendering/utils/BeamingHelper.ts) — `finish`, `alignWithBeats`, `drawingInfos`.
- [`packages/alphatab/src/rendering/LineBarRenderer.ts`](packages/alphatab/src/rendering/LineBarRenderer.ts) — `initializeBeamDrawingInfo`, `ensureBeamDrawingInfo`, `calculateBeamingOverflows`, `emitHelperSkyline`.
- [`packages/alphatab/src/rendering/EffectSystemPlacement.ts`](packages/alphatab/src/rendering/EffectSystemPlacement.ts) — `placeAndApply`, the before/after sampling.
- [`packages/alphatab/src/rendering/EffectBand.ts`](packages/alphatab/src/rendering/EffectBand.ts) — `computeLocalXRange`.
- [`packages/alphatab/src/rendering/EffectBandContainer.ts`](packages/alphatab/src/rendering/EffectBandContainer.ts) — `alignGlyphs`.
- [`packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts`](packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts) — `_scaleToForce`, `applyLayoutingInfo`.
- [`packages/alphatab/src/rendering/glyphs/BarNumberGlyph.ts`](packages/alphatab/src/rendering/glyphs/BarNumberGlyph.ts), [`BarTempoGlyph.ts`](packages/alphatab/src/rendering/glyphs/BarTempoGlyph.ts) — the two historically-dynamic glyphs.
- [`packages/alphatab/src/rendering/glyphs/LeftToRightLayoutingGlyphGroup.ts`](packages/alphatab/src/rendering/glyphs/LeftToRightLayoutingGlyphGroup.ts) — empty `doLayout` (B.24).
- [`packages/alphatab/src/rendering/effects/TabWhammyEffectInfo.ts`](packages/alphatab/src/rendering/effects/TabWhammyEffectInfo.ts) — `onAlignGlyphs` writes `_sharedLayoutData`.
- [`packages/alphatab/test/visualTests/features/SystemSpacing.test.ts`](packages/alphatab/test/visualTests/features/SystemSpacing.test.ts) — Step 8b acceptance corpus.

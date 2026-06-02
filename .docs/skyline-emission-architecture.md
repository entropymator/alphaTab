# Bar-renderer lifecycle audit and target architecture

> **Scope shift from v1.** The previous version of this document (preserved verbatim at [`skyline-emission-architecture-v1.md`](./skyline-emission-architecture-v1.md)) framed the problem as "where do two dynamic-bbox glyphs emit their skyline." That framing was too narrow. The owner's verdict:
>
> > the overall current state of registering things is not clean. […] things are cached+delayed to somewhen be picked up again. this is not a proper feature implementation.
>
> The skyline emission is now treated as a *symptom*. This v2 doc audits the whole per-bar layout pipeline, names the structural anti-patterns, and proposes a clean target with a sequenced migration plan.
>
> All file refs are absolute against the repo root unless noted.

---

## TL;DR

The bar-renderer pipeline today is **a sequence of partial passes that each finalize a slightly different subset of the same state, with cross-references that force later passes to mutate values an earlier pass had already "set."** Glyphs cope by capturing reads at the wrong time, then re-reading later through bbox queries — making `Glyph.getBoundingBox*` a covert dynamic-state oracle rather than a geometric query. The most invasive fix is also the cleanest: split bar layout into three monotone phases with explicit pre/post conditions, move cross-bar coordination into a system-level pass that sits *between* the local phases, and forbid bbox queries from reading renderer/staff/system state.

Recommendation: **adopt a 3-phase contract (Intrinsic / Spaced / Finalized), with a system-level "Coordinate" step between Intrinsic and Spaced.** Resize re-enters at Spaced. Skyline emission lives at one point: end of Finalized. The two dynamic-bbox glyphs and the `_dynamicSkylineGlyphs` registry are byproducts of the current phase order; they disappear once Spaced is genuinely final before Finalized runs.

---

## A. The lifecycle today — as it actually runs

### A.1 Initial layout (full render)

```
ScoreRenderer.renderTracks
  ScoreLayout.layoutAndRender
    ScoreLayout.doLayoutAndRender                                # subclass-specific (Page / Parchment / HorizontalScreen)
      ── per master bar ──
      StaffSystem.addBars(tracks, barIndex, …)                   # [packages/alphatab/src/rendering/staves/StaffSystem.ts:333]
        ├── for g in staves:
        │     for s in g.staves:
        │       bar = … model …
        │       s.addBar(bar, layoutingInfo, additionalRest)     # [RenderStaff.ts:155]
        │         renderer = factory.create(…)                   # fresh renderer instance
        │         renderer.layoutingInfo = layoutingInfo         # SHARED across all staves of this master bar
        │         renderer.doLayout()                            # [BarRendererBase.ts:673]
        │           ├ helpers.initialize()
        │           ├ topEffects.doLayout / bottomEffects.doLayout
        │           ├ resetBarLocalSkyline()                     # clears skylines AND _dynamicSkylineGlyphs AND _pendingBeatEffects
        │           ├ createPreBeatGlyphs()                      # each glyph.doLayout(); group width frozen at content extent
        │           │     └─ glyphs may registerDynamicSkylineGlyph(...)         # BarNumberGlyph, BarTempoGlyph
        │           ├ createBeatGlyphs()                         # voiceContainer.doLayout
        │           │     └─ each ScoreNoteChordGlyph etc. may call registerBeatEffectOverflowsForBeat(...)
        │           │        which writes into _pendingBeatEffectsByBeat (the queue, not a final position)
        │           ├ createPostBeatGlyphs()
        │           ├ _registerLayoutingInfo()                   # publishes preBeatSize / postBeatSize / spring data
        │           │                                            #   into the SHARED layoutingInfo (a max-aggregator)
        │           ├ topEffects.alignGlyphs / bottomEffects.alignGlyphs    # band-internal alignment (#1)
        │           ├ updateSizes()                              # voiceContainer.x, _postBeatGlyphs.x, width, height SET
        │           │                                            #   NOTE: this.height += layoutingInfo.height — ACCUMULATING
        │           ├ helpers.beamHelpers[*].finish()            # initializes drawingInfos (start/end X)
        │           └ calculateOverflows(0, this.height)         # writes _contentTopOverflow/Bottom + pre/postBeatLocalSkyline
        │         _updateVisibility()                            # may change s.isVisible AFTER doLayout already read it
        │
        ├ firstVisibleStaff = …                                  # decided HERE — AFTER every renderer.doLayout returned
        ├ layoutingInfo.finish()                                 # spring constants finalized
        ├ _trackSystemMinDuration(...)                           # may flip isMinDurationDirty (cross-bar concern)
        └ _applyLayoutAndUpdateWidth()                           # calls applyLayoutingInfo on every staff's LAST renderer
            └ last.applyLayoutingInfo()                          # [BarRendererBase.ts:525]
                ├ _preBeatGlyphs.width = layoutingInfo.preBeatSize        # may GROW past content extent
                ├ voiceContainer.x reassigned (= preBeat.x + preBeat.width)
                ├ container.applyLayoutingInfo(layoutingInfo)             # spring positions
                ├ _postBeatGlyphs.x reassigned, width = layoutingInfo.postBeatSize
                ├ this.width updated
                ├ topEffects.alignGlyphs / bottomEffects.alignGlyphs      # band-internal alignment (#2 — same call)
                └ _registerStaffOverflow()

  // later, per system, once system assembly is finished:
  VerticalLayoutBase._fitSystem(system)                          # [VerticalLayoutBase.ts:407]
    ├ system.reconcileMinDurationIfDirty()                       # re-runs applyLayoutingInfo on every renderer in the system
    ├ _scaleToWidth(system, target_width)                        # [VerticalLayoutBase.ts:430]
    │   for each staff:
    │     for each renderer:
    │       renderer.x = w
    │       renderer.scaleToWidth(actualBarWidth)                # [BarRendererBase.ts:349]
    │         ├ barLocalSkyline.reset()                          # bar-local skyline reset (NOT pre/post)
    │         ├ voiceContainer.scaleToWidth(...)                 # repacks beats at this width; fires per-beat callback
    │         │     └ per-beat callback emits voice content overflows + flushes _pendingBeatEffectsByBeat into skyline
    │         ├ helpers.beamHelpers[*].alignWithBeats()          # rewrites drawingInfo.startX/endX (the previously
    │         │                                                  #    "finished" beam helpers — see B.6)
    │         ├ _postBeatGlyphs.x reassigned                     # mutation #3 of this field
    │         ├ this.width = width                               # mutation of width
    │         ├ topEffects.alignGlyphs / bottomEffects.alignGlyphs    # band-internal alignment (#3)
    │         ├ _emitDynamicSkylineGlyphs(...)                   # the workaround for B.7
    │         └ emitSubclassBarLocalSkyline()                    # LineBarRenderer / etc.
    └ system.finalizeSystem()
        ├ _finalizeTrackGroups(...)
        │   for each staff: staff.finalizeStaff()                # [RenderStaff.ts:308]
        │     ├ systemSkyline.reset / effectPlacement.reset
        │     ├ for renderer in staff.barRenderers:
        │     │     finalizeRenderer()                           # [BarRendererBase.ts:642]
        │     │       └ _finalizeTies(...)                       # each tie.doLayout, may write into OTHER renderers' skylines
        │     │         if any overflow grew: updateSizes(); _registerStaffOverflow()
        │     │     _unionBarLocalIntoStaffSkyline(renderer)
        │     ├ effectPlacement.placeAndApply()
        │     ├ if needsSecondPass: redo the union + place
        │     └ apply renderer.y = topPadding + topOverflow
```

The state-mutation timeline of one renderer over the full pass:

| State | doLayout | applyLayoutingInfo | scaleToWidth | finalizeRenderer |
| --- | --- | --- | --- | --- |
| `_preBeatGlyphs.width` | set (content extent) | grown (== preBeatSize) | — | — |
| `voiceContainer.x` | set | reassigned | (implicit via post.x) | — |
| `_postBeatGlyphs.x` | **set** | **reassigned** | **reassigned** | — |
| `_postBeatGlyphs.width` | set (content) | grown (== postBeatSize) | — | — |
| `width` | set | reassigned | reassigned | possibly grown |
| `height` | accumulated `+=` | — | — | possibly grown |
| `_contentTopOverflow/Bottom` | set (calcOverflows) | — | — | possibly grown |
| `barLocalSkyline` | reset | — | reset + emitted | tie writes |
| `preBeatLocalSkyline` | emitted | — | — | — |
| `postBeatLocalSkyline` | emitted (group-local) | — | — | — |
| `topEffects.height` / `bottomEffects.height` | — | — | — | `EffectSystemPlacement.placeAndApply` |
| `beam drawingInfo.startX/endX` | initialized (helpers.finish) | — | rewritten (alignWithBeats) | — |
| `effectBand` glyph x | aligned (call #1) | aligned (call #2) | aligned (call #3) | — |

### A.2 Resize (incremental re-render)

```
ScoreRenderer.resizeRender                                       # [ScoreRenderer.ts:175]
  layout.resize()
    layout.doResize()
      VerticalLayoutBase.doResize()                              # [VerticalLayoutBase.ts:140]
        _resizeAndRenderScore(...)                               # [VerticalLayoutBase.ts:281]
          ── two strategies ──
          (a) barsPerRowActive:                                  # fixed-bars-per-row mode
              for system in _systems:
                system.width = system.computedWidth
                _fitSystem(system)                               # same as init-layout call
                _paintSystem(...)
          (b) otherwise (the common case):
              for r in _allMasterBarRenderers:
                for b in r.renderers:
                  b.afterReverted()                              # [BarRendererBase.ts:512]
                                                                 #   staff = undefined; isFinalized = false
                                                                 #   registerMultiSystemSlurs(undefined)
              _systems = []
              loop building new systems:
                system.addMasterBarRenderers(tracks, renderers)  # [StaffSystem.ts:274]
                  ├ for g in staves:
                  │   for s in g.staves:
                  │     renderer = renderers.renderers[src++]    # reuse EXISTING renderer instance
                  │     s.addBarRenderer(renderer)               # [RenderStaff.ts:132]
                  │       ├ renderer.staff = this
                  │       ├ renderer.reLayout()                  # [BarRendererBase.ts:965]
                  │       │   ├ topEffects.height = 0; bottomEffects.height = 0
                  │       │   ├ topEffects.alignGlyphs / bottomEffects.alignGlyphs
                  │       │   ├ updateSizes()                    # IMPORTANT: this.height += layoutingInfo.height again
                  │       │   ├ IF wasFirstOfStaff != isFirstOfStaff:
                  │       │   │     recreatePreBeatGlyphs()      # tear down + recreate _preBeatGlyphs
                  │       │   │     _postBeatGlyphs.doLayout()
                  │       │   ├ _registerLayoutingInfo()
                  │       │   └ calculateOverflows(0, this.height)
                  │       ├ register in layout barRendererLookup
                  │       └ _updateVisibility()
                  ├ firstVisibleStaff = …                        # decided here (post-loop again)
                  ├ _trackSystemMinDuration(...)
                  └ _applyLayoutAndUpdateWidth()                 # applyLayoutingInfo on last renderer
                _fitSystem(system) … _paintSystem(...)
```

**State that survives a revert + re-add cycle on the same renderer instance:**

- glyph instances in `_preBeatGlyphs`, voiceContainer, `_postBeatGlyphs` (unless `recreatePreBeatGlyphs` fires)
- `_ties[]` (built only in `doLayout`; not cleared on revert — see B.12)
- `_pendingBeatEffectsByBeat`: cleared by `resetBarLocalSkyline()`, but **only `doLayout` calls that**, not `reLayout` — so on the resize path the queue keeps the entries from the original `doLayout`. Re-flushing in `scaleToWidth` will use those entries with potentially-different beat positions. (Whether the entries are still semantically valid is by accident.)
- `_dynamicSkylineGlyphs`: same. Cleared only on `doLayout`; if a `reLayout` adds new glyphs via `recreatePreBeatGlyphs`, the manual pruning at [`BarRendererBase.ts:988`] strips only `'pre'` entries before recreate. A latent leak when post-anchored dynamics appear.
- `_contentTopOverflow / _contentBottomOverflow`: not reset by `reLayout` — only re-grown.
- `_appliedLayoutingInfo`: version cookie that *will* mismatch the layoutingInfo from the new master bar context, forcing `applyLayoutingInfo` to re-run (see B.3).

The resize path is structurally a partial subset of initial layout, but it shares enough of the same methods that bugs in the "this only runs once" assumption surface here first.

---

## B. The cached + delayed inventory

Every place where state is stashed, queued, or version-skipped because a needed input isn't ready when called. Each row's **dependency** column is the root: "we'd not need this entry if X were ready when we ran."

| # | Location | What's cached | Dependency (not ready) | Consumed where | If upstream were ready |
| --- | --- | --- | --- | --- | --- |
| B.1 | `BarRendererBase._postBeatGlyphs.x` mutated in `updateSizes` ([BarRendererBase.ts:804](../packages/alphatab/src/rendering/BarRendererBase.ts#L804)), `applyLayoutingInfo` ([:541](../packages/alphatab/src/rendering/BarRendererBase.ts#L541)), `scaleToWidth` ([:412](../packages/alphatab/src/rendering/BarRendererBase.ts#L412)) | the x of the post-beat group | the *final* width, which depends on `layoutingInfo.postBeatSize` (system-wide max, settled only after `_applyLayoutAndUpdateWidth`) AND on `containerWidth` at `scaleToWidth` time | every `getRatioPositionX`, `BarTempoGlyph` bbox, post-beat skyline union | one phase that knows the final width before any consumer asks ⇒ value is set once |
| B.2 | `this.height += this.layoutingInfo.height` in `updateSizes` ([BarRendererBase.ts:808](../packages/alphatab/src/rendering/BarRendererBase.ts#L808)) | accumulating height | `layoutingInfo.height` is always 0 today (set in commented-out paint code) — but the `+=` accepts a non-zero contribution. The accumulation **is** observable because `updateSizes` runs at least twice on the resize path (once during `doLayout` via the previous render, once in `reLayout`). | every height consumer | drop the accumulation; assign once. Currently masked because `layoutingInfo.height` happens to be 0. **Latent bug.** |
| B.3 | `_appliedLayoutingInfo` version cookie ([:510, :525-530](../packages/alphatab/src/rendering/BarRendererBase.ts#L510)) | a version snapshot | `applyLayoutingInfo` is called from multiple paths: `_applyLayoutAndUpdateWidth` after the last renderer added, `reconcileMinDurationIfDirty` after a late shorter-note, `_fitSystem`'s indirect chain. The cookie prevents re-doing the same work. | `applyLayoutingInfo` early-out | one call site that knows when the info is final and calls apply once — eliminates the version dance |
| B.4 | `wasFirstOfStaff` / `recreatePreBeatGlyphs` in `reLayout` ([:899, :974-994](../packages/alphatab/src/rendering/BarRendererBase.ts#L974)) | a flag remembering doLayout's view of "am I first?" | At initial `doLayout` time, the renderer doesn't know if it'll be re-positioned to be first/not-first on resize. So it captures the at-creation answer and on `reLayout` compares against the new index. If different, tear down and rebuild pre-beat glyphs. | `reLayout` only | resize that fully recomputes pre-beat content (or pre-beat that doesn't depend on staff position) — recreate path goes away |
| B.5 | `firstVisibleStaff` decided post-loop in `StaffSystem.addBars`/`addMasterBarRenderers` ([StaffSystem.ts:322, :395](../packages/alphatab/src/rendering/staves/StaffSystem.ts#L322)) | which staff "owns" cross-staff annotations | needs *every* staff's `isVisible` after that staff added this master bar's renderer. `isVisible` flips with `_emptyBarCount`. So the loop must run before the decision. But `renderer.doLayout()` runs *inside* `addBar`. ⇒ `BarNumberGlyph` reads `isFirstInSystem` at doLayout time and sees stale/undefined. | `BarNumberGlyph.getBoundingBoxLeft/Right` (and `paint`) | `firstVisibleStaff` decided from the *model* (bar.isEmpty/isRestOnly + previous count) in a pre-pass over staves before any `doLayout` |
| B.6 | `_pendingBeatEffectsByBeat` ([BarRendererBase.ts:143, :281](../packages/alphatab/src/rendering/BarRendererBase.ts#L281)) | per-beat (minY, maxY) ranges captured at note-glyph `doLayout` | beat container x is not final at note-glyph doLayout time. The queue defers per-x skyline emission. | flushed in `scaleToWidth`'s per-beat callback ([:387-399](../packages/alphatab/src/rendering/BarRendererBase.ts#L387)) | beat container x final before emission ⇒ skyline can be emitted inline during the same walk that creates the glyph |
| B.7 | `_dynamicSkylineGlyphs` registry ([:216-220, :422-458](../packages/alphatab/src/rendering/BarRendererBase.ts#L216)) | references to glyphs whose bbox is dynamic | `BarNumberGlyph` bbox depends on B.5; `BarTempoGlyph` bbox depends on B.1. Cannot emit at `calculateOverflows` time because bbox would be wrong. | re-emit in `_emitDynamicSkylineGlyphs` at scaleToWidth end | if B.1 and B.5 fix their root causes, these bboxes are stable at `calculateOverflows` time — registry vanishes |
| B.8 | `scaleToWidth` called multiple times | width-dependent state (beat x, _postBeatGlyphs.x, beam drawing, dynamic skyline) | the layout pipeline calls `scaleToWidth` from `_scaleBars` ([HorizontalScreenLayout.ts:180](../packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts#L180)) AND from `_alignRenderers` ([:229](../packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts#L229)) — same renderer, potentially different widths. Idempotency depends on `barLocalSkyline.reset()` at entry. | next consumers expect "settled per-x skyline" | width is computed once before `scaleToWidth` is called once. The recent fix that added the `barLocalSkyline.reset()` at entry is defensive; the true fix removes the second call. |
| B.9 | `afterReverted` (`staff = undefined; isFinalized = false; registerMultiSystemSlurs(undefined)`) ([:512](../packages/alphatab/src/rendering/BarRendererBase.ts#L512)) and `afterStaffBarReverted` (`topEffects.height = 0; bottomEffects.height = 0; _registerStaffOverflow`) ([:518](../packages/alphatab/src/rendering/BarRendererBase.ts#L518)) | "we kept the renderer instance but need to reset a few fields" | the resize path reuses renderer instances. Most state survives. Some specific fields must be reset because they're "downstream of placement," but `_pendingBeatEffectsByBeat`, `_ties[]`, `_dynamicSkylineGlyphs`, `barLocalSkyline`, `preBeatLocalSkyline`, `postBeatLocalSkyline`, `_contentTopOverflow/Bottom`, `_appliedLayoutingInfo` are not. | the renderer is then re-attached and `reLayout`'d | if resize built a fresh state container (or always called the full `doLayout`), the manual reset list goes away |
| B.10 | `BarLayoutingInfo.minStretchForce`, `preBeatSize`, `postBeatSize` accumulated max-of via every renderer's `_registerLayoutingInfo` | per-master-bar shared maxima | each renderer contributes during its own `doLayout`. By the time the LAST renderer's `doLayout` is done, the shared aggregate is final. But the earlier renderers already finished `doLayout` reading a smaller aggregate. ⇒ `applyLayoutingInfo` re-runs against the final aggregate post-hoc. | `_applyLayoutAndUpdateWidth` calls `last.applyLayoutingInfo()` (and resize path applies to every renderer via `reconcileMinDurationIfDirty`) | a two-phase split (Intrinsic → Coordinate → Spaced) cleanly separates these, see §D |
| B.11 | `BeamingHelper.finish()` at doLayout end + `alignWithBeats()` at scaleToWidth ([BeamingHelper.ts:117, :109](../packages/alphatab/src/rendering/utils/BeamingHelper.ts#L109)) | beam drawingInfo `startX/endX/startY/endY` | `finish()` initializes drawingInfo with the *current* beat X (post-`updateSizes`, pre-width-finalization). `alignWithBeats()` rewrites startX/endX with the post-scale beat X. Y is initialized once and never refreshed — implicitly assumed stable. | beam paint code | beat X is final once before beam initialization. `finish()` becomes the only beam-init step. |
| B.12 | `_finalizeTies` cross-renderer skyline writes ([:582-640](../packages/alphatab/src/rendering/BarRendererBase.ts#L582)) | tie/slur bbox sliced into spanned bars' `barLocalSkyline` | tie geometry depends on the start-beat's renderer and the end-beat's renderer both having final positions. Ties live on the start renderer but write into spanned renderers' bar-local skylines. | `_unionBarLocalIntoStaffSkyline` reads the post-tie skyline | ties placed at a system-level phase that owns *all* renderer positions ⇒ writes to a system-level skyline, no cross-renderer mutation |
| B.13 | `topEffects.alignGlyphs` / `bottomEffects.alignGlyphs` called 3× (doLayout, applyLayoutingInfo, scaleToWidth) | band-internal glyph x alignment | the bands need to know beat container x, which moves with each phase. So each phase re-runs the alignment. | painted at the end; placement reads `computeLocalXRange` which calls glyph bbox | one alignment pass at the point where beat positions are sealed |
| B.14 | `EffectSystemPlacement.reset` ([EffectSystemPlacement.ts:31-44](../packages/alphatab/src/rendering/EffectSystemPlacement.ts#L31)) | band y, placedMagnitude reset across all renderers and bands | `finalizeStaff` may run placement twice (second pass on `needsSecondPass` from ties). Without reset, the second pass would double-count. | second-pass `placeAndApply` | tie finalization happens *before* placement begins ⇒ placement runs once, reset removed |
| B.15 | `_systemSkyline` lazily allocated + manually `reset()` from `finalizeStaff` and `resetSkylines` ([RenderStaff.ts:222, :278](../packages/alphatab/src/rendering/staves/RenderStaff.ts#L278)) | per-staff system skyline | resize reuses staves. Skyline persists between renders. Caller must remember to reset. | `_unionBarLocalIntoStaffSkyline` and `effectPlacement.placeAndApply` | a fresh staff-skyline per finalize call instead of lazy + manual reset |
| B.16 | `BarLayoutingInfo` shared mutable across staves ([RenderStaff.ts:164], [StaffSystem.ts:340]) | spring data, beat sizes, pre/post sizes, grace rods | every renderer in the same MasterBarsRenderers writes into it during its `_registerLayoutingInfo`. The shared instance IS the cross-bar synchronization mechanism. | every renderer's `applyLayoutingInfo`, beat spacing, voice container scaling | this isn't really a "cache" — it's the cross-bar broker. But its **mutation order is undefined**: it's "whoever calls last wins via max-of." See §C-3. |
| B.17 | `_sharedLayoutData` on `RenderStaff` ([RenderStaff.ts:24, :109-118](../packages/alphatab/src/rendering/staves/RenderStaff.ts#L109)) | typed key-value bag used by renderers to coordinate across bars in the same staff (e.g. beaming-bar key signatures) | siblings of the current renderer have data we need; we don't want to walk them. | various LineBarRenderer / specific glyph paths | a dedicated cross-bar staff-state object with named fields beats a stringly-typed map |
| B.18 | `_appliedLayoutingInfo` skipping `topEffects.alignGlyphs` in `applyLayoutingInfo` when the version hasn't moved ([:526](../packages/alphatab/src/rendering/BarRendererBase.ts#L526)) | implicit: also skipping the side effect of alignment | callers expect alignGlyphs to run idempotently | downstream skyline emit, etc. | one alignGlyphs call point, not three, eliminates the version-skip concern |

---

## C. Root anti-patterns

The 18 inventory rows cluster into **five** patterns. Each is the *blame for many entries*, and a single architectural fix usually retires the whole cluster.

### C-1. Retroactive position mutation

**Definition.** A field that should be "set once when known" is instead set *now* (best-effort), then re-set in later phases as more inputs arrive.

**Instances**: B.1 (post-beat x), B.10 (layoutingInfo aggregation), B.11 (beam start/end X), B.13 (effect band alignment), B.2 (height accumulation).

**Blast radius.** Every downstream reader either accepts a stale value (B.6's pending queue, B.7's dynamic registry) or has to re-do its own work (B.13 alignGlyphs ×3). The flip side is callers becoming defensive: `scaleToWidth` resets `barLocalSkyline` because *its own* output might run twice. The fragility is structural.

**Target.** Phase boundaries with explicit post-conditions: "after phase N, no Y mutates." Mutation past the boundary is a defect, not a feature.

### C-2. Out-of-order phase dependency

**Definition.** A function reads value X to produce value Y; later, the system computes X "for real"; nobody reruns the producer of Y.

**Instances**: B.5 (firstVisibleStaff settled after staves loop, doLayout already ran), B.4 (wasFirstOfStaff captured before final placement → forces recreatePreBeatGlyphs on resize), B.6 (pending beat effects deferred to scaleToWidth), B.7 (dynamic skyline registry compensating for B.5+B.1).

**Blast radius.** Forces every consumer to choose: "live with stale value" (paint wrong), "defer until later" (queue / registry), or "re-do the producer" (recreatePreBeatGlyphs). Each is a workaround for the same root: the function ran in the wrong phase.

**Target.** Cross-bar/cross-staff state that any bar needs is computed in a system-level phase BEFORE any per-bar layout that reads it. `firstVisibleStaff` is decidable from the model alone (which staves have at least one non-empty bar in this master bar), so it can move to a pre-pass.

### C-3. Lazy cross-bar coordination through a shared mutable broker

**Definition.** `BarLayoutingInfo` is shared across all renderers of a master bar. Every renderer writes (max-of) into it during its own per-bar layout. There is no explicit "we're done writing" phase boundary.

**Instances**: B.10, B.16, B.3 (`_appliedLayoutingInfo` is the symptom — "did the info change since we last looked"), B.18.

**Blast radius.** Renderers can't safely cache info-derived values during `doLayout` because a sibling renderer hasn't contributed yet. The `_applyLayoutAndUpdateWidth` flow patches the last renderer afterwards; the resize/reconcile flow patches all of them. The "version" cookie exists because `applyLayoutingInfo` could legitimately re-run with new data.

**Target.** Explicitly two-phase: (1) every renderer publishes its intrinsic sizes/springs into the shared info; (2) the info is *sealed* (`finish()` is the only existing seam — extend it); (3) renderers' spacing-dependent computations run AFTER seal. Then there's a single `apply` step per renderer with no version cookie.

### C-4. Bounding-box as side-channel for renderer state

**Definition.** `Glyph.getBoundingBoxLeft/Right/Top/Bottom` are documented as geometric queries, but `BarNumberGlyph`, `BarTempoGlyph`, `GroupedEffectGlyph`, even `EffectBand.computeLocalXRange`, read renderer/staff/system state from them.

**Instances**: B.7 (registry exists because bbox is dynamic), B.5 (bbox is the consumer), B.1 (bbox is the consumer).

**Blast radius.** The phase in which it's safe to call bbox becomes glyph-specific. Callers (`calculateOverflows`, `_finalizeTies`, `EffectBand.computeLocalXRange`) must either accept "wrong but stable" data or be called at the unique time each glyph happens to be valid. There's no contract.

**Target.** Either (a) bbox is purely a function of `this.x/y/width/height/...` set in the glyph's own `doLayout` (strict), and any cross-cutting placement query goes through a dedicated `populateSkyline(renderer, target)` method called at a phase-defined time; or (b) bbox is officially dynamic, but with a documented "validity phase" tag per glyph. (a) is cleaner and tighter.

### C-5. Renderer-as-shared-mutable-state across phases

**Definition.** The renderer instance survives revert+re-add. Some state is reset on those transitions, some isn't. Skylines, registry, ties, dynamic glyph list, content overflows, version cookies, beam helpers — each has its own lifecycle.

**Instances**: B.9 (reset list incomplete), B.11 (beam helpers re-aligned), B.14, B.15, B.13.

**Blast radius.** Adding a new piece of per-bar state means picking the right place(s) to reset it — easy to miss. The `_dynamicSkylineGlyphs` leak that just got patched was exactly this: glyphs registered fresh on `recreatePreBeatGlyphs` but old entries were never removed because the resize path didn't know about them.

**Target.** Either (a) a fresh per-layout-cycle state container that the renderer holds a reference to (and replaces atomically per cycle); or (b) a discipline where the only valid state transitions are documented as a state machine and the resetters are autogenerated/reviewed against it.

---

## D. Target architecture

### D.1 Phase contract

Three monotone phases per renderer, with a single system-level coordination step between phases 1 and 2.

```
            ┌─────────────────────────────────────────────────┐
            │                  Phase 0: Build                  │
            │   create renderer; bind to staff; build helpers  │
            │   (constructor + factory.create + helpers.init)  │
            └────────────────────────┬─────────────────────────┘
                                     │
                                     ▼
            ┌─────────────────────────────────────────────────┐
            │              Phase 1: Intrinsic                  │
            │   create pre/beat/post glyphs; each glyph.doLayout │
            │   publishes its own intrinsic size into            │
            │   layoutingInfo (springs, pre/postBeatSize).      │
            │   No reads from layoutingInfo, no reads of        │
            │   sibling renderer state.                         │
            │                                                   │
            │   Post-condition:                                 │
            │     • every glyph has its intrinsic geometry     │
            │     • layoutingInfo has this bar's contribution  │
            │     • beat content/effect overflow is recorded   │
            └────────────────────────┬─────────────────────────┘
                                     │  one call to this phase per renderer
                                     │  (per-staff loop inside addBars)
                                     ▼
            ┌─────────────────────────────────────────────────┐
            │      System-level: Coordinate (per master bar)   │
            │                                                   │
            │   • compute firstVisibleStaff from model state   │
            │   • layoutingInfo.finish() — seal springs        │
            │   • cross-bar / system-min-duration reconcile     │
            │     (was: addBars + addMasterBarRenderers tail   │
            │      + reconcileMinDurationIfDirty)               │
            │                                                   │
            │   Post-condition:                                 │
            │     • staff.isFirstInSystem is final             │
            │     • layoutingInfo is read-only thereafter      │
            └────────────────────────┬─────────────────────────┘
                                     │  for each renderer
                                     ▼
            ┌─────────────────────────────────────────────────┐
            │              Phase 2: Spaced                     │
            │                                                   │
            │   given the bar's final width (== "intrinsic"    │
            │   width in initial pass, or "fitted" width in    │
            │   resize), compute every position:                │
            │     • _preBeatGlyphs.width = layoutingInfo.preBS │
            │     • voiceContainer.x, beat container x         │
            │     • _postBeatGlyphs.x (FINAL)                  │
            │     • beam drawingInfos (start/end X+Y, FINAL)   │
            │     • effect band x alignment                    │
            │   No further x/width mutation after this phase.  │
            │                                                   │
            │   Post-condition:                                 │
            │     • all renderer-local x / width are final     │
            │     • all beat positions are final               │
            └────────────────────────┬─────────────────────────┘
                                     │
                                     ▼
            ┌─────────────────────────────────────────────────┐
            │             Phase 3: Finalized                   │
            │                                                   │
            │   • bbox-driven pre/beat/post skyline emit       │
            │     (now valid because Phase 2 sealed positions) │
            │   • ties / multi-system slurs: per-system pass   │
            │     writes into a system skyline directly        │
            │   • effect band placement (one call)             │
            │   • content height accounting                    │
            │                                                   │
            │   Post-condition: nothing mutates that downstream│
            │     paint reads. The bar is "done."              │
            └─────────────────────────────────────────────────┘
```

### D.2 Resize re-enters at Phase 2

```
Resize cycle:
   for each renderer reused: drop Phase-2-and-later state
   re-run Coordinate (firstVisibleStaff stable if same model)
   for each renderer: Phase 2 (new width) → Phase 3
```

Phase 1 ("Intrinsic") is **not** re-run on resize unless model content changed. That's the whole point of resize being cheap. Phase 1's output is independent of width.

The current resize path conflates "I need to recompute springs at a new width" with "I need to potentially recompute pre-beat content because I'm now first-of-staff." Splitting Phase 1 from Phase 2 makes resize's job unambiguous: only Phase 2+ runs. Pre-beat content that depends on "first-of-staff" is computed in Phase 1 based on a value `Coordinate` has already settled, so no recreate is necessary.

### D.3 Glyph contract

```ts
abstract class Glyph {
  // Phase 1: pure intrinsic layout. Sets this.x, this.width, this.height etc.
  //   May read this.renderer for resources/canvas only.
  //   May NOT read renderer.staff.system or sibling renderers.
  //   May call renderer.publishIntrinsic*(...) to contribute to layoutingInfo.
  doLayout(): void;

  // Pure geometric query of this glyph's own painted extent in glyph-local
  // coords. Stable once doLayout returns. May NOT consult renderer state.
  getBoundingBoxLeft(): number;
  getBoundingBoxRight(): number;
  getBoundingBoxTop(): number;
  getBoundingBoxBottom(): number;

  // Phase 3 hook for glyphs whose skyline contribution depends on placement
  // state set in Phase 2 (rare — currently only BarTempoGlyph would need it,
  // BarNumberGlyph wouldn't because Coordinate sealed firstVisibleStaff).
  populateSkyline?(target: BarLocalSkyline, rendererTop: number, rendererBottom: number): void;
}
```

The crucial change: **bbox is renormalized as "geometric query, no environment reads."** Anything dynamic goes through `populateSkyline`, which has a documented validity phase (= Finalized).

### D.4 BarLayoutingInfo's role

**Demotion to write-once cross-bar broker.** Phase 1 publishes; Coordinate seals; Phase 2+ reads only. No version cookie. No "did anyone change me since I was last applied" question, because the answer is now "no, by construction."

This also retires `reconcileMinDurationIfDirty` as a separate phase — it folds into Coordinate, run once per master bar after every Phase 1 finishes. The "dirty flag" cache exists today because today bars are added and "fit" in two different cycles; in the target, system assembly and per-bar Coordinate are interleaved by master bar.

### D.5 Skyline emission

One place, end of Phase 3:

```ts
// BarRendererBase.finalize()  [target, replaces calculateOverflows + scaleToWidth + finalizeRenderer]
finalize(): void {
  emitPreBeatSkyline();    // walks _preBeatGlyphs.glyphs, reads each bbox
  emitBeatSkyline();       // walks voiceContainer beats, reads each bbox + already-flushed effect ranges
  emitPostBeatSkyline();   // walks _postBeatGlyphs.glyphs (post-beat group offset is final)
  emitDynamicSkylineHooks();   // glyphs that need a different-from-bbox contribution

  // ties / slurs: not here. Done by SystemFinalize after every renderer's finalize.
}
```

No reset, no version, no pending queue — because every input is final.

`_pendingBeatEffectsByBeat` disappears: the registration happens during `createBeatGlyphs` (Phase 1) into a list, and the beat-callback walk in Phase 3 reads beat container x (final) + the list to emit. No deferral, just one walk at the right time.

### D.6 Tie / slur finalization

Today: `_finalizeTies` runs per-renderer in `finalizeRenderer`, may write into other renderers' skylines, sometimes needs a second pass.

Target: a single `SystemFinalize` pass after every renderer's Phase 3 finishes:

```
RenderStaff.finalizeStaff:
  for renderer in barRenderers: renderer.finalize()      // Phase 3
  for tie in all ties in this staff:                     // collected during Phase 1
     tie.layoutAndEmit(systemSkyline)
  effectPlacement.placeAndApply(systemSkyline)
  apply y-offsets
```

`_finalizeTies` becomes a free function over (tie, systemSkyline). No second-pass loop because ties are placed before `placeAndApply`.

### D.7 Resize structurally identical to initial layout

`afterReverted` and the manual reset list go away. Resize:

```
ScoreLayout.resize:
  drop Phase-2+ state on all reused renderers
  re-Coordinate every master bar (cheap, model-only)
  re-fit every system: Phase 2 + Phase 3 + SystemFinalize
```

The renderer holds a `LayoutCycle` substate that's atomically reassigned per cycle. Skylines, pending lists, tie list, dynamic glyph list all live there. Discard the substate = clean state.

### D.8 Where existing call sites map

| Existing | Target phase |
| --- | --- |
| `BarRendererBase.doLayout` glyph creation | Phase 1 |
| `BarRendererBase._registerLayoutingInfo` | Phase 1 (publish) |
| `BarLayoutingInfo.finish` + min-duration reconcile | Coordinate |
| `StaffSystem.firstVisibleStaff` assignment | Coordinate (pre-pass over model) |
| `BarRendererBase.applyLayoutingInfo` body (minus version skip) | Phase 2 |
| `BarRendererBase.updateSizes` | folded into Phase 2 |
| `BarRendererBase.scaleToWidth` body | Phase 2 (called at the bar's final width — once) |
| beam `helper.finish` and `helper.alignWithBeats` | one call at end of Phase 2 |
| `BarRendererBase.calculateOverflows` | Phase 3 emit |
| `BarRendererBase._dynamicSkylineGlyphs` | DELETED (BarNumberGlyph no longer dynamic; BarTempoGlyph uses `populateSkyline?`) |
| `_pendingBeatEffectsByBeat` | DELETED (emit inline in Phase 3 beat walk) |
| `BarRendererBase.finalizeRenderer` / `_finalizeTies` | Phase 3 + SystemFinalize tie pass |
| `EffectSystemPlacement.placeAndApply` second-pass branch | DELETED (ties placed before; no overflow grow after) |
| `HorizontalScreenLayout._alignRenderers` second `scaleToWidth` | DELETED (the first call uses final width) |

---

## E. Migration plan

Ordered low-blast-radius first. Each step:
- self-contained (visual tests stay green),
- names files,
- states which inventory entries it retires,
- states which target contract it introduces.

Marked **[parallel]** steps can run concurrently.

### Step 1. Pre-pass `firstVisibleStaff` from model
- **Touch**: `packages/alphatab/src/rendering/staves/StaffSystem.ts`, `RenderStaff.ts` (add `_isBarVisibleForMasterBar(bar)` helper).
- **Retires**: B.5; **enables**: B.7 simplification.
- **Contract**: `staff.isFirstInSystem` final at start of `doLayout`. (Step toward "Coordinate before Phase 1's bbox-reading.")
- **Cost**: ~30 lines. Small loop above the staves loop in `addBars`/`addMasterBarRenderers` that simulates the visibility update before `s.addBar(...)` is called.
- **Risk**: low. The simulation just reads model `bar.isEmpty / bar.isRestOnly`.

### Step 2. Drop `BarNumberGlyph` bbox overrides
- **Touch**: `packages/alphatab/src/rendering/glyphs/BarNumberGlyph.ts`.
- **Retires**: half of B.7 (BarNumberGlyph's dynamic registration).
- **Contract**: BarNumberGlyph contributes a stable bbox. When not first in system, sets `width = 0` in `doLayout`.
- **Cost**: 5–10 lines.
- **Risk**: low. Requires Step 1 first.
- **[parallel]** with Step 3 once Step 1 lands.

### Step 3. Inline `BarTempoGlyph` skyline contribution via a `populateSkyline` hook
- **Touch**: `Glyph.ts` (add optional hook), `BarTempoGlyph.ts`, `BarRendererBase.ts` (replace `_dynamicSkylineGlyphs` emit with a hook-driven walk; the hook only fires when the glyph implements it).
- **Retires**: other half of B.7. **Introduces**: the canonical `populateSkyline?` interface from D.3.
- **Contract**: bbox stays geometric and stale; dynamic emission goes through the hook called at the right phase.
- **Cost**: ~30 lines.
- **Risk**: low–medium. Replaces a working registry with a working hook — net zero behaviour, simpler shape.

### Step 4. Fold `_pendingBeatEffectsByBeat` into the beat walk
- **Touch**: `BarRendererBase.ts` (`registerBeatEffectOverflowsForBeat` now writes directly to barLocalSkyline during the Phase-3 beat walk, given beat container x; or keeps a per-beat list that's consumed inline).
- **Retires**: B.6.
- **Cost**: low; depends on whether Phase 3 already runs after positions seal. With current pipeline, just attach the list to the beat container and read it in the per-beat callback (already happens — drop the indirection).
- **Risk**: low. The per-beat callback already iterates in `scaleToWidth`.

### Step 5. Single `alignGlyphs` call point for effect bands
- **Touch**: `BarRendererBase.ts` (remove alignment from `doLayout` and `applyLayoutingInfo`; keep only at end of `scaleToWidth`).
- **Retires**: B.13.
- **Risk**: medium. Need to verify that any consumer of pre-scaleToWidth band geometry (e.g. tempo/lyrics reading band width during `doLayout`) actually exists. If not, this is a pure simplification.
- **Cost**: 5–10 lines. Visual regen pass to verify.

### Step 6. Idempotent `updateSizes` (drop `height += layoutingInfo.height`)
- **Touch**: `BarRendererBase.ts:808`.
- **Retires**: B.2.
- **Risk**: low. `layoutingInfo.height` is always 0 today; the `+=` is misleading. Assign once. If a future feature wants to use that field, it can do so cleanly.
- **Cost**: 1 line.

### Step 7. Remove `_alignRenderers`' second `scaleToWidth` in horizontal layout
- **Touch**: `packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts:217-237` — instead of re-calling `scaleToWidth(renderer.width)`, do the renderer.x assignment and the bookkeeping without re-running the scaling. Or refactor `_scaleBars` to produce final positions in one pass.
- **Retires**: B.8.
- **Risk**: medium. The current `_alignRenderers` call is what reinitialises beam helpers' x positions after the horizontal-screen second pass — verify nothing it computed gets dropped.
- **Cost**: 20–40 lines, plus visual regen.

### Step 8. Move `BarLayoutingInfo.finish` + `reconcileMinDurationIfDirty` into a single Coordinate call per master bar
- **Touch**: `StaffSystem.ts`, `BarRendererBase.applyLayoutingInfo` (drop version cookie), `VerticalLayoutBase._fitSystem`.
- **Retires**: B.3, B.10, B.18.
- **Contract**: `BarLayoutingInfo` is read-only after Coordinate.
- **Risk**: medium–high. This is the cross-bar coordination refactor. Test load: every layout mode (Page Automatic, Page UseModelLayout, Parchment, HorizontalScreen).
- **Cost**: 100–200 lines.

### Step 9. Single-write `_postBeatGlyphs.x`
- **Touch**: `BarRendererBase.ts` — remove the assignments in `updateSizes` and `applyLayoutingInfo`; compute once in `scaleToWidth` (or its successor) from final width.
- **Retires**: B.1.
- **Risk**: medium. Any caller of `getRatioPositionX` during `doLayout` will now read 0/garbage. Audit `getRatioPositionX` callers (BarTempoGlyph is the only known one; Step 3 already moved it off bbox).
- **Cost**: 15 lines + regression test.

### Step 10. Replace `wasFirstOfStaff` / `recreatePreBeatGlyphs` with a clean resize entry
- **Touch**: `BarRendererBase.ts` (drop `wasFirstOfStaff`, `recreatePreBeatGlyphs`), `RenderStaff.addBarRenderer`, the resize path in `VerticalLayoutBase._resizeAndRenderScore`.
- **Retires**: B.4, plus B.9's most fragile element.
- **Contract**: resize re-runs Phase 1 only when content changed; the pre-beat content question becomes "what's my current `staff.isFirstInSystem`" and reads a Coordinate-stable value.
- **Risk**: high. Touches the whole resize entry.
- **Cost**: 100+ lines.
- **Prereq**: Steps 1, 8.

### Step 11. Unify renderer per-cycle state into a `LayoutCycle` object; atomic reassign on resize
- **Touch**: `BarRendererBase.ts` — extract `_barLocalSkyline / _preBeatLocalSkyline / _postBeatLocalSkyline / _pendingBeatEffectsByBeat / _ties / _dynamicSkylineGlyphs / _contentTopOverflow / _contentBottomOverflow / _appliedLayoutingInfo / beatEffectsMinY / beatEffectsMaxY` into a `LayoutCycle` struct.
- **Retires**: B.9, B.15. Closes C-5.
- **Risk**: medium (mechanical, but touches every field access). Most call sites become `this.cycle.foo`.
- **Cost**: cross-cutting; could be done in one PR if scoped tightly.

### Step 12. Move tie/slur finalization to SystemFinalize
- **Touch**: `RenderStaff.finalizeStaff`, `BarRendererBase._finalizeTies`, `_finalizeRenderer`.
- **Retires**: B.12, B.14 (second-pass branch).
- **Contract**: tie geometry computed once after all renderers' Phase 3 done; writes to system skyline; effect placement runs once after ties.
- **Risk**: medium. Cross-cutting on the staff finalize loop.
- **Cost**: 80–120 lines.

### Step 13. Three-phase BarRendererBase API split (Intrinsic / Spaced / Finalized)
- **Touch**: `BarRendererBase.ts` rewrite of `doLayout / applyLayoutingInfo / scaleToWidth / calculateOverflows / finalizeRenderer` into `intrinsicLayout / spacedLayout / finalize`. Every subclass renderer that overrides these names.
- **Retires**: closes C-1.
- **Contract**: D.1.
- **Risk**: high (mechanical but everywhere). All `BarRenderer*` subclasses overriding any of the old method names need adjustment.
- **Cost**: largest single step; 200–400 lines plus subclass updates.

### Step 14. Make `Glyph.getBoundingBox*` strictly geometric (audit & fix)
- **Touch**: every glyph subclass with a `getBoundingBox*` override that consults renderer state. Survey from v1 §3.2 + spot-check additions.
- **Retires**: closes C-4.
- **Risk**: medium. Most overrides are already "geometric," but `GroupedEffectGlyph.getBoundingBoxRight` reads `renderer.getBeatX`. That one needs to migrate to `populateSkyline` or to be cached in `doLayout` against the final beat x (which is the *point* of Phase 2 sealing positions).
- **Cost**: file-by-file audit; ~20 glyph files.

### Step 15. Replace `_sharedLayoutData` string map with a typed staff-state container
- **Touch**: `RenderStaff.ts`, every consumer of `getSharedLayoutData/setSharedLayoutData`.
- **Retires**: B.17.
- **Risk**: low–medium. Stringly-typed bag with maybe 5–10 keys becomes a typed object.

### Parallelization

After Step 1:
- Steps 2, 3, 4, 5, 6, 15 can land independently (small, mostly local).
- Step 7 needs care but is local to HorizontalScreenLayout.
- Steps 8, 11 are the big architectural enablers; do 8 first.
- Steps 9, 10, 12, 13, 14 build on 1+8+11 and can be staged.

Total estimate: Steps 1–7 reclaim ~30% of the structural fragility for ~1–2 days of effort. Steps 8–14 are the real refactor, ~2 weeks given test load.

---

## F. Decisions the owner needs to make

These are *contract* choices the agent shouldn't unilaterally lock in.

### F.1 Is `Glyph.getBoundingBox*` permitted to be dynamic?
- **Strict (recommended)**: bbox is pure function of glyph fields set in `doLayout`. Any non-static contribution goes through `populateSkyline?`. Easier to reason about, slightly more code (one extra method per dynamic glyph).
- **Lenient**: bbox is allowed to read renderer state, but the renderer documents *when* bbox is callable per glyph. Less code, more lifecycle knowledge required.

The author leans strict because every workaround in B.6/B.7 stems from "we called bbox at the wrong time." The strict contract is enforceable by review; the lenient contract requires per-glyph lifecycle annotations.

### F.2 Is the resize path structurally identical to initial layout?
- **Identical (recommended)**: resize discards Phase 2+ state and runs Phase 2+Phase 3 again. The path is one code path.
- **Distinct first-class concept**: resize is "I have Phase 1 output; just re-Phase-2 with a new width." Slightly cheaper; means two code paths.

Identical is simpler and matches the Phase-1-output-survives-resize invariant. The difference in cost is small because Phase 1 is what's expensive (note layout); skipping it is what makes resize cheap regardless.

### F.3 Where does `BarLayoutingInfo` live?
- **Keep as cross-bar broker (current)**: shared mutable, sealed by `Coordinate`.
- **Push job into a `MasterBarLayout` owned by `StaffSystem`**: lifts spring assembly out of the per-renderer code path entirely. Renderers `publishIntrinsic(...)`; the master-bar object computes springs.

The author has no strong preference; the latter is more "MVC" but a bigger refactor. The current shape with a sealed contract is good enough.

### F.4 What's the contract for cross-bar glyphs (ties, multi-system slurs)?
- They live on the start renderer today but paint across renderers. Either:
  - (a) keep the data structure, hoist finalization to system-level (Step 12);
  - (b) move ownership to the system-level slur registry and have renderers reference into it. Slightly cleaner; bigger refactor.

(a) is recommended for the migration; (b) is a possible later evolution.

### F.5 What's the contract for `EffectBand.computeLocalXRange` reading bbox?
- It's "officially dynamic" today — called from `EffectSystemPlacement.placeAndApply` which runs after every renderer's `scaleToWidth`. In the target, it's called at end of Phase 3 (SystemFinalize), where positions are sealed and bbox reads are valid.
- Decision: just document that effect-band glyph bbox is valid after Phase 2. No code change needed.

---

## G. What the v1 doc got right / wrong

### Right (preserve by reference, do not relitigate)

- The walk inventory in §2 of v1 (every walk currently in the pipeline, what it iterates, what it reads/writes) is accurate. Use it.
- The dynamic-bbox glyph census in §3 of v1 (BarNumberGlyph, BarTempoGlyph, GroupedEffectGlyph; everything else stable) is accurate.
- The mechanical lifecycle map in §1.1 / §1.2 of v1 is accurate; this doc's A.1 is a structural rewrite, not a correction.
- The recommendation that `BarNumberGlyph`'s dependency can be retired by precomputing `firstVisibleStaff` from the model — that's the right idea (it became Step 1 here).

### Wrong, in the sense of "narrower than the problem"

- v1's "candidate A vs D vs ..." framed the choice as "where do these two glyphs emit." With C-1 through C-5 in view, the choice is "do we keep retroactively mutating positions and let glyphs read dynamic state, or do we phase-segment the lifecycle." v1's recommended path D, while a correct local fix, leaves C-1, C-2, C-3, C-5 in place. The two glyphs would disappear; the architecture wouldn't get cleaner.
- v1 treated `_dynamicSkylineGlyphs` as a *registry to eliminate*. The deeper issue is "phase 2 isn't actually finalized before phase 3 emits." The registry is a *consequence* of that ordering, not a separate concern.
- v1's "Risk: 2" for path D is accurate for the local change but ignores that without the wider lifecycle cleanup, every future glyph with a layout-state dependency will rediscover the same registry-shaped hole.

The takeaway: v1 was a correct *answer to its own question*. The owner reframed the question, and this v2 doc treats the lifecycle as the unit of work.

---

## H. Outstanding questions

These are not blockers but should be confirmed during implementation:

- **revertLastBar's interaction with `firstVisibleStaff`**: Step 1 needs to handle the case where reverting a bar flips a staff's visibility back. The pre-pass needs to be re-run on revert. Easy to forget.
- **MultiBarRest renderer**: its `additionalMultiBarsRestBars` short-circuits `createBeatGlyphs`. Verify Phase 1 still publishes correct `_registerLayoutingInfo` for it (it should — `voiceContainer.doLayout` still runs).
- **Layout in `HorizontalScreenLayout`**: there's no "system fit" phase — bars are scaled per-bar at the bar's intrinsic display width. In the target, Phase 2 just uses that width directly and `_alignRenderers` collapses to position-assignment only.
- **Per-track / per-staff effect band rendering interaction** with bands that span renderers: confirm that Step 12's SystemFinalize ordering doesn't break linked-chain magnitude propagation in `_placeSide`.
- **BeamingHelper drawingInfo Y axis**: today, Y is set once in `helper.finish()` and never refreshed. The target Phase 2 contract says positions are sealed — confirm beam Y doesn't need re-derivation after, e.g., effect placement shifts. (Looks fine; effects shift only outside the staff content area, so beam Y, which is in renderer-local content coords, is independent.)

---

## Appendix: file index for the audit

Most cited:

- `packages/alphatab/src/rendering/BarRendererBase.ts` — the heart of the lifecycle; ~1000 lines, every phase visible.
- `packages/alphatab/src/rendering/staves/RenderStaff.ts` — addBar, addBarRenderer, finalizeStaff, the staff-level skyline union.
- `packages/alphatab/src/rendering/staves/StaffSystem.ts` — addBars, addMasterBarRenderers, _trackSystemMinDuration, reconcileMinDurationIfDirty, _applyLayoutAndUpdateWidth.
- `packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts` — the shared cross-bar broker, the `version` field, the `finish()` / `recomputeSpringConstants` seam.
- `packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts` — _fitSystem, _scaleToWidth, _resizeAndRenderScore.
- `packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts` — _scaleBars, _alignRenderers (the double-scaleToWidth case).
- `packages/alphatab/src/rendering/utils/BeamingHelper.ts` — finish vs alignWithBeats (the two beam finalization seams).
- `packages/alphatab/src/rendering/EffectSystemPlacement.ts` — staff-level placement consumer, the reset() / second-pass shape.
- `packages/alphatab/src/rendering/EffectBand.ts` — computeLocalXRange (bbox-as-side-channel consumer).
- `packages/alphatab/src/rendering/EffectBandContainer.ts` — alignGlyphs (called from 3 phases).
- `packages/alphatab/src/rendering/glyphs/LeftToRightLayoutingGlyphGroup.ts` — addGlyph (the one well-behaved layout phase).
- `packages/alphatab/src/rendering/glyphs/BarNumberGlyph.ts`, `BarTempoGlyph.ts` — the two dynamic-bbox holdouts that motivated v1.
- `packages/alphatab/src/rendering/LineBarRenderer.ts:1017+` — initializeBeamDrawingInfo, ensureBeamDrawingInfo.

The v1 doc remains available at `.docs/skyline-emission-architecture-v1.md` for cross-reference.

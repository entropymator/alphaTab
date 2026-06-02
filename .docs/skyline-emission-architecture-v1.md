# Skyline emission — lifecycle, walks, candidate architectures

> **This is the v1 audit, preserved verbatim for reference.** The current architecture document is
> [`skyline-emission-architecture.md`](./skyline-emission-architecture.md). The owner rejected this
> v1's "path D" recommendation as too narrow; see v2 §G for why.

Reference for the skyline-emission seam at the bar-renderer level. The recent fold
(`cfb80602`) removed three extra walks from `BarRendererBase.scaleToWidth` but introduced
a `_dynamicSkylineGlyphs` registry for two glyphs whose bboxes are not stable at
`calculateOverflows` time. This doc maps the actual data lifecycle so that registry can
be replaced by something the rest of the renderer doesn't have to know about.

All file refs are relative to `packages/alphatab/src/`.

---

## 1. Lifecycle map

The bar-rendering pipeline produces final state in this order. Times are expressed as
"earliest read-safe phase" — i.e. the first point at which any reader can treat the
value as immutable for the rest of that layout pass.

### 1.1 Per-renderer state

| State | First set | All mutators | Safe to read as final |
| --- | --- | --- | --- |
| `Glyph.x` / `Glyph.width` inside `_preBeatGlyphs` | `LeftToRightLayoutingGlyphGroup.addGlyph` (`rendering/glyphs/LeftToRightLayoutingGlyphGroup.ts:19`) — chains x off prior glyph + `gap`, calls `g.doLayout()` | none after add | end of `createPreBeatGlyphs` (`BarRendererBase.ts:690`) — i.e. immediately after `addPreBeatGlyph` returns |
| `_preBeatGlyphs.width` (group width, individual glyph extent sum + gaps) | `LeftToRightLayoutingGlyphGroup.addGlyph` (`LeftToRightLayoutingGlyphGroup.ts:23`) | `BarRendererBase.applyLayoutingInfo` writes `_preBeatGlyphs.width = layoutingInfo.preBeatSize` (`BarRendererBase.ts:533`) — may *grow* it past content extent | after `applyLayoutingInfo` returns (`BarRendererBase.ts:525`) |
| `_preBeatGlyphs.x` | constructor (0) | never reassigned | always — invariant |
| `voiceContainer.x` (= `_preBeatGlyphs.x + _preBeatGlyphs.width`) | `BarRendererBase.updateSizes` (`BarRendererBase.ts:803`) called from `doLayout` (`BarRendererBase.ts:700`) | reassigned in `applyLayoutingInfo` (`BarRendererBase.ts:537`), in `updateSizes` calls from `doLayout` (`BarRendererBase.ts:700`), and not directly in `scaleToWidth` (but `_postBeatGlyphs.x` reassign at `BarRendererBase.ts:412` *implicitly* depends on this being current) | after `applyLayoutingInfo` |
| `BeatContainerGlyphBase.x` inside voiceContainer | `MultiVoiceContainerGlyph.doLayout` (`MultiVoiceContainerGlyph.ts:279`) — left-to-right packed | rewritten in `MultiVoiceContainerGlyph._scaleToForce` (`MultiVoiceContainerGlyph.ts:70-128`), invoked from `scaleToWidth` and `applyLayoutingInfo` | only inside the `onBeatSettled` callback of the current `scaleToWidth` pass (`MultiVoiceContainerGlyph.ts:56`) |
| `_postBeatGlyphs` glyph-local positions (within group) | `LeftToRightLayoutingGlyphGroup.addGlyph` (`LeftToRightLayoutingGlyphGroup.ts:19`) | never reassigned per glyph | immediately after `createPostBeatGlyphs` returns (`BarRendererBase.ts:692`) |
| `_postBeatGlyphs.x` (group offset) | `BarRendererBase.updateSizes` (`BarRendererBase.ts:804`) — first set at end of `doLayout` | reassigned in `applyLayoutingInfo` (`BarRendererBase.ts:541`), in `updateSizes` calls, and in `scaleToWidth` (`BarRendererBase.ts:412`) | after `scaleToWidth` returns |
| `_postBeatGlyphs.width` | `LeftToRightLayoutingGlyphGroup.addGlyph` sums | `applyLayoutingInfo` writes `layoutingInfo.postBeatSize` (`BarRendererBase.ts:542`) | after `applyLayoutingInfo` |
| `renderer.height` | `BarRendererBase.updateSizes` (`BarRendererBase.ts:808`) | each `reLayout` (`BarRendererBase.ts:970`); accumulated via `+=` from base height | after `updateSizes`, but **may grow** via `registerOverflowTop/Bottom` until `finalizeRenderer` returns false |
| `renderer.width` | `BarRendererBase.updateSizes` (`BarRendererBase.ts:806`) | `applyLayoutingInfo` (`BarRendererBase.ts:543`), `scaleToWidth` (`BarRendererBase.ts:413`) | after `scaleToWidth` for the current pass |
| `renderer.x` (within staff) | `RenderStaff` consumers: `HorizontalScreenLayout._alignRenderers` (`layout/HorizontalScreenLayout.ts:225`), `VerticalLayoutBase._scaleToWidth` (`layout/VerticalLayoutBase.ts:461`) | per resize pass | only inside `RenderStaff.finalizeStaff` and beyond |
| `_contentTopOverflow` / `_contentBottomOverflow` | `BarRendererBase.calculateOverflows` (`BarRendererBase.ts:727,737,754,766,781,786,791,796`) | also `finalizeRenderer → _finalizeTies → registerOverflowRangeTop/Bottom` (`BarRendererBase.ts:614,619`), `topEffects.height` / `bottomEffects.height` set in `EffectSystemPlacement.placeAndApply` (`EffectSystemPlacement.ts:95,98`) | NEVER fully final until `finalizeStaff` runs its second pass (`RenderStaff.ts:334-347`) |
| `beatEffectsMinY` / `beatEffectsMaxY` | `BarRendererBase.registerBeatEffectOverflows` from note-glyph `doLayout` (`ScoreNoteChordGlyph.ts:243`, `TabNoteChordGlyph.ts:164`, `SlashNoteHeadGlyph.ts:69`) | accumulating max during `createBeatGlyphs` walk | end of `createBeatGlyphs` (`BarRendererBase.ts:691`) |
| `_pendingBeatEffectsByBeat` entries | same call sites as above, via `registerBeatEffectOverflowsForBeat` (`BarRendererBase.ts:281`) | cleared in `resetBarLocalSkyline` (`BarRendererBase.ts:205`) | end of `createBeatGlyphs` |
| `topEffects` / `bottomEffects` band heights | `EffectBand.doLayout` (in `createVoiceGlyphs` chain) | finalized in `EffectBand.finalizeBand` from `EffectSystemPlacement.placeAndApply` (`EffectSystemPlacement.ts:79-83`) | after `EffectSystemPlacement.placeAndApply` returns |
| `topEffects.height` / `bottomEffects.height` (container heights) | initially 0; set in `EffectSystemPlacement.placeAndApply` (`EffectSystemPlacement.ts:95,98`) | reset in `EffectSystemPlacement.reset` (`EffectSystemPlacement.ts:33,34`) at each `finalizeStaff` cycle | only after `placeAndApply` of that cycle |
| Tie geometry (`startX/endX/startY/endY/ctrlX/ctrlY`) | `TieGlyph.doLayout` invoked from `BarRendererBase._finalizeTies` (`BarRendererBase.ts:587`) | re-runs in `finalizeStaff` second pass | inside `_finalizeTies`, immediately after `tie.doLayout()` returns |
| `BeamingHelper.drawingInfos[*].startX/endX` | `LineBarRenderer.initializeBeamDrawingInfo` (`LineBarRenderer.ts:1025,1032`), called from `helper.finish()` → `completeBeamingHelper` (`BarRendererBase.ts:706`) | rewritten in `BeamingHelper.alignWithBeats` (`utils/BeamingHelper.ts:111-113`) from `scaleToWidth` (`BarRendererBase.ts:407`) | after the inner alignment loop in `scaleToWidth` (`BarRendererBase.ts:405-410`) |
| `layoutingInfo.preBeatSize` / `layoutingInfo.postBeatSize` | `BarLayoutingInfo` aggregation during `_registerLayoutingInfo` calls (`BarRendererBase.ts:494-507`) — max across all renderers sharing this info | bumped by every renderer's `_registerLayoutingInfo` at doLayout / reLayout | after the LAST renderer in the same MasterBarsRenderers has finished `_registerLayoutingInfo`. This is **after** the per-renderer `doLayout` has already begun reading its own `_preBeatGlyphs.width`. |
| `staff.system.firstVisibleStaff` | computed bottom-up: `RenderStaff._updateVisibility` (`RenderStaff.ts:144`) sets `isVisible`; then `StaffSystem.addBars` / `addMasterBarRenderers` decides `firstVisibleStaff` (`StaffSystem.ts:322,395`) **AFTER** the loop over staves completes | every `addBars` / `addMasterBarRenderers` call | after `StaffSystem.addBars` / `addMasterBarRenderers` returns — i.e. after `RenderStaff.addBar(renderer)` (which calls `renderer.doLayout()` at `RenderStaff.ts:165`) has ALREADY returned for every staff |

### 1.2 Pipeline phase boundaries

```text
StaffSystem.addBars(...)                           // staves loop
  for each staff s:
    s.addBar(bar, layoutingInfo, multiRest)
      renderer = factory.create(...)
      renderer.layoutingInfo = layoutingInfo
      renderer.doLayout()
        ├── createPreBeatGlyphs   (each glyph.doLayout(); _preBeatGlyphs.width frozen at content extent)
        ├── createBeatGlyphs      (voiceContainer.doLayout(); beat container x packed L→R)
        ├── createPostBeatGlyphs  (each glyph.doLayout(); _postBeatGlyphs.width frozen)
        ├── _registerLayoutingInfo  (publishes own preBeatSize/postBeatSize to the SHARED info)
        ├── topEffects.alignGlyphs / bottomEffects.alignGlyphs
        ├── updateSizes           (voiceContainer.x, _postBeatGlyphs.x, width, height SET — first time)
        ├── beamHelpers.finish    (initializes drawingInfo with current beat X)
        └── calculateOverflows    (reads bboxes; writes _contentTopOverflow + _preBeatLocalSkyline + _postBeatLocalSkyline)
    s._updateVisibility()         (s.isVisible may CHANGE based on this renderer)
  end staves loop
  this.firstVisibleStaff = ...    (FINAL — only here)
  _applyLayoutAndUpdateWidth      (calls applyLayoutingInfo on every staff's last renderer
                                   → _preBeatGlyphs.width may GROW to layoutingInfo.preBeatSize
                                   → _postBeatGlyphs.x re-shifted, voiceContainer scaled)

// later, at layout-distribution time per system:
VerticalLayoutBase._scaleToWidth(system, width)
  for each staff:
    for each renderer:
      renderer.x = w
      renderer.scaleToWidth(actualBarWidth)        // may be called multiple times across passes
        ├── barLocalSkyline.reset()
        ├── voiceContainer.scaleToWidth(...)       (beat container x repacked; per-beat callback)
        ├── beamHelpers[*].alignWithBeats          (drawingInfo.startX/endX refreshed)
        ├── _postBeatGlyphs.x reassigned (final for THIS width)
        ├── width = `width` (final for THIS width)
        ├── topEffects.alignGlyphs / bottomEffects.alignGlyphs
        ├── _emitDynamicSkylineGlyphs              (re-reads dynamic bboxes — only place they're stable)
        └── emitSubclassBarLocalSkyline

RenderStaff.finalizeStaff
  for each renderer:
    finalizeRenderer            (tie doLayout; bbox slicing into staff-skyline)
    _unionBarLocalIntoStaffSkyline(renderer)        (reads barLocal + pre + post, shifts pre/post into staff frame)
  EffectSystemPlacement.placeAndApply               (places effect bands; sets r.topEffects.height etc.)
  // possibly a SECOND pass if ties shifted overflows
```

### 1.3 The key visibility-ordering hazard

The hazard `BarNumberGlyph` exposes is concrete: `renderer.doLayout()` runs inside
`RenderStaff.addBar(bar, …)` (`RenderStaff.ts:165`). `_updateVisibility()` runs at
`RenderStaff.ts:172`, AFTER `doLayout` returned. And `system.firstVisibleStaff` is assigned
at `StaffSystem.ts:395` — even later, AFTER the loop over all staves of this master bar
finishes. So at `doLayout` time, `staff.isFirstInSystem` reads `system.firstVisibleStaff`,
which is either `undefined` (first master bar of the system) or stale from the PREVIOUS
master bar (subsequent master bars).

```ts
// BarNumberGlyph.ts:35-46  — collapses bbox if NOT first visible staff
public override getBoundingBoxLeft(): number {
    if (!this.renderer.staff!.isFirstInSystem) {
        return this.x;
    }
    return super.getBoundingBoxLeft();
}
```

`isFirstInSystem` is `this.system.firstVisibleStaff === this` (`RenderStaff.ts:39`) — and
on the first master bar that decision hasn't been made yet when `doLayout` runs.

---

## 2. Walk inventory

Every walk currently in the bar-renderer pipeline that could absorb extra work, with what
it iterates and the state it requires/produces. "Iterates per-bar" means within a single
renderer's lifecycle.

| Walk | Caller / location | Iterates | Requires (read) | Produces (write) |
| --- | --- | --- | --- | --- |
| `_preBeatGlyphs.addGlyph` loop | `LeftToRightLayoutingGlyphGroup.addGlyph` per glyph (`LeftToRightLayoutingGlyphGroup.ts:19`) | each newly-added pre-beat glyph | renderer ref | glyph.x, group.width |
| `_postBeatGlyphs.addGlyph` loop | same class, post-beat instance | each post-beat glyph | renderer ref | glyph.x, group.width |
| `voiceContainer.doLayout` | `MultiVoiceContainerGlyph.ts:275-296` | every beat container × every voice | beat container layout state | beat container x (left-packed), tupletGroups |
| `MultiVoiceContainerGlyph._scaleToForce` per-beat | `MultiVoiceContainerGlyph.ts:64-149` | every beat container × every voice | layoutingInfo positions for current force | beat container x, beat width; fires `onBeatSettled` callback per beat |
| `BarRendererBase.scaleToWidth` per-beat callback | `BarRendererBase.ts:366-403` | each settled beat (via voiceContainer's callback) | beat container's bbox top/bottom, beat container x, `_pendingBeatEffectsByBeat[beatId]` | inserts into `barLocalSkyline` for content overflows + pending effect ranges + `emitBeatSkyline` hook |
| Beam-helper alignment | `BarRendererBase.ts:405-410` calling `BeamingHelper.alignWithBeats` (`utils/BeamingHelper.ts:109`) | every voice × every beam helper | settled beat x | drawingInfo.startX/endX; also fires `emitHelperSkyline` (`LineBarRenderer.ts:998`) which inserts into `barLocalSkyline` |
| Dynamic skyline glyph re-emit | `BarRendererBase._emitDynamicSkylineGlyphs` (`BarRendererBase.ts:422-458`) | every entry of `_dynamicSkylineGlyphs` (2 glyph types today) | glyph's now-final bbox | inserts into `barLocalSkyline` (pre) or `postBeatLocalSkyline` (post) |
| Effect band alignment | `EffectBandContainer.alignGlyphs` via `topEffects.alignGlyphs` / `bottomEffects.alignGlyphs` | each effect band | layoutingInfo positions, beat x | band internal glyph positions |
| `calculateOverflows` pre-beat walk | `BarRendererBase.ts:721-745` | every `_preBeatGlyphs.glyphs` entry | glyph bbox (currently INCLUDING dynamic, but yielding stale values for the 2 dynamic ones) | `_contentTopOverflow`, `_contentBottomOverflow`, `_preBeatLocalSkyline` |
| `calculateOverflows` post-beat walk | `BarRendererBase.ts:748-776` | every `_postBeatGlyphs.glyphs` entry | glyph bbox in post-group-local x | `_contentTopOverflow`, `_contentBottomOverflow`, `_postBeatLocalSkyline` |
| Tie finalization | `BarRendererBase._finalizeTies` (`BarRendererBase.ts:582-640`) called from `finalizeRenderer` | each `_ties[]` entry + each `_multiSystemSlurs[]` entry × each staff renderer it crosses | tie bbox after `tie.doLayout()`, every staff renderer.x/width | `_contentTopOverflow/Bottom`, per-bar `barLocalSkyline` slicing |
| Bar-local → staff-skyline union | `RenderStaff._unionBarLocalIntoStaffSkyline` (`RenderStaff.ts:236-276`) | each segment of barLocal + preBeatLocal + postBeatLocal (3 sub-skylines × 2 sides) | renderer.x, renderer.postBeatGroupOffset | `systemSkyline` segments |
| Effect placement | `EffectSystemPlacement.placeAndApply` (`EffectSystemPlacement.ts:46-111`) | every effect band on every renderer in the staff | every band's `computeLocalXRange` + `height` + `placementCategory`/`order` | band.placedMagnitude, band.y, container.height, registers staff overflows |

Two of these walks are candidates for absorbing the dynamic-glyph emit: the
`calculateOverflows` pre/post walks (they already touch every pre/post-beat glyph) and
the existing per-beat callback (already in `scaleToWidth`).

---

## 3. Dynamic-bbox glyph inventory

Glyphs whose `getBoundingBoxLeft/Right/Top/Bottom` reads something the glyph instance
doesn't already own. Sorted by whether the dependency settles late or just looks late.

### 3.1 Truly dynamic — depends on state set LATER than this glyph's `doLayout`

| Glyph | Where it lives | Dynamic dim | Reads | Settles at |
| --- | --- | --- | --- | --- |
| `BarNumberGlyph` | pre-beat group | `getBoundingBoxLeft/Right` | `renderer.staff!.isFirstInSystem` = `system.firstVisibleStaff === this` (`RenderStaff.ts:38`, `BarNumberGlyph.ts:36`) | `StaffSystem.addBars/addMasterBarRenderers` AFTER the staves loop (`StaffSystem.ts:322`/`StaffSystem.ts:395`) |
| `BarTempoGlyph` | pre-beat group (zero-rod effect glyph) | `getBoundingBoxLeft/Right` | `renderer.getRatioPositionX(a.ratioPosition)` → `beatGlyphsStart` (= `voiceContainer.x` = `_preBeatGlyphs.x + _preBeatGlyphs.width`) AND `postBeatGlyphsStart` (= `_postBeatGlyphs.x`) (`BarRendererBase.ts:944-951`) | both settled by `applyLayoutingInfo` (`BarRendererBase.ts:533,541`), but if `scaleToWidth` runs at a width different from doLayout's, `_postBeatGlyphs.x` shifts again (`BarRendererBase.ts:412`) |
| `GroupedEffectGlyph` (parent of `OttavaGlyph`, etc.) | effect band — not pre/post-beat | `getBoundingBoxRight` returns `this.renderer.getBeatX(this.beat, this.endPosition)` (`GroupedEffectGlyph.ts:24`) | beat container x is final inside the per-beat callback in `scaleToWidth`; effect-band x ranges are recomputed in `EffectBand.computeLocalXRange` at placement time |

`GroupedEffectGlyph` lives in effect bands, not pre/post-beat groups, so it does not
participate in the renderer-level skyline emission (effect bands have their own placement
pass via `EffectSystemPlacement`). It IS a dynamic-bbox glyph in the same architectural
sense, but the placement code already queries `computeLocalXRange` at the right time
(during `placeAndApply` after `scaleToWidth` has settled). Worth noting because any
candidate architecture should explain how it generalizes to this third case rather than
treating BarNumber + BarTempo as the only dynamic glyphs.

### 3.2 "Computed bbox" but stable at end of own `doLayout`

These derive their bbox from values they CAN cache at the end of their own `doLayout`,
so they are not late-binding. Listing them only to dispel false alarms:

- `TextGlyph`, `LyricsGlyph` — `textWidth` measured + cached in `doLayout`; bbox reads
  cached width plus alignment math against `this.x`.
- `RepeatCountGlyph` — `_textWidth` cached in `doLayout`; bbox uses `this.x` (post-beat
  group local, frozen by `LeftToRightLayoutingGlyphGroup.addGlyph`).
- `TripletFeelGlyph` — `_paintWidth` cached in `doLayout` (`TripletFeelGlyph.ts:54`).
- `OttavaGlyph.getBoundingBoxLeft` — `this.x - this._symbolWidth / 2`; symbolWidth cached
  in `doLayout`. (But: `OttavaGlyph` extends `GroupedEffectGlyph`, so its right edge is
  the 3.1 dynamic case.)
- `MusicFontGlyph`, `TrillGlyph`, `BeatTimerGlyph`, `DirectionsContainerGlyph` —
  all read `this.x` / `this.width` / smufl metrics; values fixed by end of `doLayout`.
- `ScoreNoteChordGlyphBase`, `ScoreBeatGlyph`, `BeatContainerGlyph`, `GlyphGroup`,
  `MultiVoiceContainerGlyph` — bbox composed from child glyphs. Stable once the children
  have run their `doLayout` and been left-packed. The composition itself walks children
  on each query, which is a different concern (allocation/perf), not a correctness one.
- `TieGlyph` — recomputed inside `_finalizeTies` immediately after `tie.doLayout()`.
- `LineRangedGlyph` — `getBoundingBoxRight` calls `super.getBoundingBoxRight()` and then
  conditionally adds dash-tail length from smufl metrics. Stable.
- `TabBendGlyph`, `ScoreBendGlyph`, `ScoreSlideLineGlyph`, `TabSlideLineGlyph`,
  `TabWhammyBarGlyph`, `ScoreWhammyBarGlyph` — bbox derived from cached note glyph
  positions inside the same beat container. Stable once `BeatContainerGlyph.doLayout`
  has finished packing its children.

The dynamic set is exactly `BarNumberGlyph`, `BarTempoGlyph`, and (in the effect-band
world) `GroupedEffectGlyph`. There are not "more lurking" pre/post-beat dynamics.

### 3.3 Dynamic top/bottom?

None of the surveyed glyphs have a top/bottom that depends on late state. `y` and
`height` are always set in `doLayout` and `BeatContainerGlyph.doLayout` packs children
vertically eagerly. The dynamic seam is purely horizontal.

---

## 4. Why the dependency exists for the two known cases

### 4.1 `BarNumberGlyph`

The visibility rule is intentional: only the staff that paints the bar number should
claim skyline horizontal space for it. Non-first staves still pay the vertical overflow
(via the scalar `registerOverflowTop`) but must not block neighbouring x-ranges.

`firstVisibleStaff` is computed across staves and depends on each staff's `isVisible`,
which itself depends on `_emptyBarCount < barRenderers.length` (`RenderStaff.ts:149`).
That count moves whenever a bar is added/reverted (`RenderStaff.ts:139, 170, 189`). So
visibility per-staff is a function of the bars added so far, and `firstVisibleStaff` is
the first staff with `isVisible === true` after THIS master bar's renderers were all
added.

Could the decision be moved earlier? Options:

- **Split `addBar`**: change `RenderStaff.addBar` so it (a) creates the renderer and
  registers layoutingInfo, (b) updates visibility, then (c) calls `renderer.doLayout()`
  AFTER `StaffSystem` has reassigned `firstVisibleStaff`. The catch: `doLayout` is what
  fills `layoutingInfo.preBeatSize` from `_preBeatGlyphs.width`. If we split, `addBar`
  must run partial layout first (enough to know the pre-beat width), then full layout
  after visibility is known. That requires either a two-phase `doLayout` (basically
  exactly what `populateBarSkyline` in candidate A is), or skipping doLayout for
  `BarNumberGlyph` until later. Both are forms of the same fix.

- **Precompute `firstVisibleStaff` from model**: visibility is "is this staff's `_emptyBarCount`
  going to be less than `barRenderers.length` after adding this bar?" — which is a
  function of `bar.isEmpty || bar.isRestOnly`, predictable from the model BEFORE creating
  any renderer. `StaffSystem` could pre-pass: for each staff, simulate the visibility
  update, derive `firstVisibleStaff` for this master bar, THEN run the loop that creates
  renderers and calls `doLayout`. This is the cleanest path because it does not change
  the doLayout contract for any other glyph. Cost: one extra pre-pass per master bar
  (cheap — it's a `bar.isEmpty` check per staff), plus `firstVisibleStaff` becomes a
  per-master-bar derivation rather than a side effect of the add loop.

### 4.2 `BarTempoGlyph`

`BarTempoGlyph.doLayout` runs in `createPreBeatGlyphs`, but its bbox depends on
`renderer.getRatioPositionX` which uses `voiceContainer.x` and `_postBeatGlyphs.x`.
Both are settled by `updateSizes` (the LAST step of `doLayout` itself), but then
re-shifted whenever `applyLayoutingInfo` or `scaleToWidth` runs again at a new width.
So the bbox isn't "wrong at doLayout" — it's "different at every scaleToWidth pass."

Two possible re-factorings:

- **Store ratio anchors, resolve at union time**: have `BarTempoGlyph` emit, not a bbox,
  but a list of `(ratioPosition, leftPadding, rightPadding)` anchors. The skyline-emit
  code, at the point where renderer x and post-beat-group x are known, converts each
  anchor to an absolute x range. This makes `BarTempoGlyph` opt out of the bbox contract
  entirely, but pollutes the skyline writer with knowledge of "ratio anchor" entries.

- **Stable bbox in renderer-local coords**: `BarTempoGlyph` returns the bbox it WOULD
  produce if `voiceContainer.x` = its own current best estimate. The `scaleToWidth`-end
  re-emit (current dynamic registry) updates with the final value. This is what the
  current registry does — it's not architecturally wrong, just opaquely glyph-specific.

The cleanest path is to NOT have `BarTempoGlyph` override `getBoundingBoxLeft/Right` at
all. Instead, give it a `populateBarSkyline(renderer, ranges)` method that the renderer
calls from the right phase. The bbox API stays "static at doLayout time" for every
glyph; the skyline API becomes the documented seam for "I contribute spatially-resolved
geometry." See candidate A.

---

## 5. Candidate architectures

### (A) Two-phase glyph contract: `populateBarSkyline` hook

```ts
// rendering/glyphs/Glyph.ts (proposal)
public populateBarSkyline?(
    renderer: BarRendererBase,
    target: BarLocalSkyline,
    rendererTop: number,
    rendererBottom: number
): void;
```

Every pre-beat / post-beat glyph optionally implements the hook. The renderer calls it
at a single well-defined phase: end of `calculateOverflows` for pre-beat (group x = 0)
and post-beat (group-local x); the `_dynamicSkylineGlyphs` registry goes away because
the hook can re-read whatever state it needs at the time it's called. For dynamic glyphs
that need to wait for `scaleToWidth`, the hook is called *again* at the end of
`scaleToWidth` — but only for glyphs that registered as dynamic via a property
(`get isSkylineDynamic(): boolean`). Default false; `BarTempoGlyph` overrides to true.

`BarNumberGlyph` doesn't need to be dynamic at all if we fix `firstVisibleStaff` ordering
(see D below); it can populate its skyline range with a final visibility check inside
the hook because `firstVisibleStaff` will be set by then.

- **Files touched**: `Glyph.ts` (add hook), `BarRendererBase.ts` (call hook in pre/post
  walks instead of bbox sniff), `BarNumberGlyph.ts`, `BarTempoGlyph.ts`. Maybe also
  refactor every other pre/post-beat glyph's bbox query to go through the hook for
  uniformity (~30+ glyph files), but that's optional — bbox-stable glyphs work with the
  current bbox-based emit just fine.
- **Risk**: 2.
- **Keeps recent fold gains?** Yes — the pre/post-beat walks in `calculateOverflows`
  remain the canonical emit walk. The hook is called inline during those walks.
- **Scales to GroupedEffectGlyph?** Yes — `EffectBand` already has its own `computeLocalXRange`;
  it can be presented as a special case of the same hook (or kept separate; the
  contract just becomes "any glyph that knows about layout state owns its skyline
  contribution").
- **Compatible with resize?** Yes — hook is called from `calculateOverflows`
  (re-run on every reLayout) and `scaleToWidth` (re-run on every resize).

### (B) Layout-state finalization point

Restructure the lifecycle so a single phase finalizes `firstVisibleStaff`,
`layoutingInfo.preBeatSize`, AND `_postBeatGlyphs.x` before any skyline emit. The first
two settle in `StaffSystem.addBars` after the staves loop and in `applyLayoutingInfo`
respectively; the last settles in `scaleToWidth`. So the "single point" naturally is
end of `scaleToWidth`. Move the entire pre/post-beat emit from `calculateOverflows` into
the end of `scaleToWidth`.

- **Files touched**: `BarRendererBase.ts` only (revert the `calculateOverflows` fold,
  fold it back into `scaleToWidth`).
- **Risk**: 3 — we re-introduce work into `scaleToWidth` that's now in `calculateOverflows`.
  The owner moved it OUT of `scaleToWidth` because that's the hot path during resize.
  This regresses the recent commits.
- **Keeps recent fold gains?** **No.** It actively undoes them — every pre/post-beat
  glyph would be walked on every `scaleToWidth`, where they only need to be walked when
  the renderer's pre-beat content changes (much rarer).
- **Scales to other dynamics?** Trivially.
- **Compatible with resize?** Yes but at cost of regressed perf.

### (C) Group-owned skylines

`LeftToRightLayoutingGlyphGroup` (or a `PreBeatGlyphGroup` / `PostBeatGlyphGroup`
subclass) becomes the skyline owner. `addGlyph` inserts the just-added glyph's bbox
into the group's own `BarLocalSkyline` immediately. Dynamic glyphs implement a
`refreshSkyline(group)` method; the group calls it on dynamic members just before
the staff-skyline union (`RenderStaff._unionBarLocalIntoStaffSkyline`).

- **Files touched**: `LeftToRightLayoutingGlyphGroup.ts`, `GlyphGroup.ts` (maybe),
  `BarRendererBase.ts` (delete pre/post emit from `calculateOverflows`),
  `RenderStaff.ts` (call refresh before union), `BarNumberGlyph.ts`, `BarTempoGlyph.ts`.
- **Risk**: 3 — moving ownership of the pre/post-beat skyline to the group adds a
  layer of indirection but the dependency graph isn't simplified, just relocated. The
  renderer still has to know about post-beat-group-local vs. bar-local coords.
- **Keeps recent fold gains?** Mostly — the `calculateOverflows` walk over the group
  goes away (group emits as it grows), but the staff-skyline union loop in
  `RenderStaff` adds a `refreshSkyline()` call per dynamic glyph.
- **Scales to other dynamics?** Yes within pre/post-beat; doesn't help effect-band
  dynamics (those live outside `LeftToRightLayoutingGlyphGroup`).
- **Compatible with resize?** Yes — `refreshSkyline` is called from the union step
  that's already run on every layout pass.

### (D) Status quo + targeted refactor of the two dynamic glyphs

Make their bbox stable by changing what they depend on.

For `BarNumberGlyph`: compute `firstVisibleStaff` in `StaffSystem.addBars` /
`addMasterBarRenderers` BEFORE the per-staff `renderer.doLayout()`. Visibility for THIS
master bar only depends on `bar.isEmpty || bar.isRestOnly` (cheap, model-only). A
pre-pass over the staves of this master bar (separate loop above the existing one)
decides `firstVisibleStaff`. After this, `BarNumberGlyph.getBoundingBoxLeft/Right` reads
a final value at `doLayout` / `calculateOverflows` time. No bbox override needed at all
if we move the "collapse to this.x" logic to the doLayout level — `BarNumberGlyph` sets
`this.width = 0` when not first visible (and zero-height? no — vertical overflow still
matters, but vertical is conveyed via `registerOverflowTop`, not via the skyline range).

For `BarTempoGlyph`: stop deriving from `getRatioPositionX` inside the bbox call. Two
sub-options:
- (D1) Compute the bbox once in `doLayout` using the renderer's current `beatGlyphsStart`
  / `postBeatGlyphsStart`. When `applyLayoutingInfo` or `scaleToWidth` runs, those
  shift, but the renderer already calls `_postBeatGlyphs.doLayout()` only in
  specific paths (`recreatePreBeatGlyphs` at `BarRendererBase.ts:976`). For the common
  case, `getRatioPositionX` returns the same value across `scaleToWidth` calls when
  computed from the post-fold pre-beat width. Wrong: the bbox would shift as
  `_postBeatGlyphs.x` shifts. So D1 doesn't work alone.
- (D2) Refactor `BarTempoGlyph` to NOT live in `_preBeatGlyphs`. The glyph is anchored
  by `ratioPosition` over the bar's content area, not before/after beats — it logically
  belongs in the voiceContainer scope. Put it where `_pendingBeatEffectsByBeat` lives,
  i.e. anchored to a beat (the first beat whose `absoluteDisplayStart` matches the
  ratio's resolved time). Then its bbox derives from beat container x, which is final
  in the per-beat callback. The bbox is stable per `scaleToWidth` pass and emits
  cleanly from the per-beat fold.

- **Files touched**: `StaffSystem.ts` (~20 lines for visibility pre-pass), `RenderStaff.ts`
  (factor `_isBarVisible(bar)` helper), `BarNumberGlyph.ts` (drop bbox override; set
  `width=0` in doLayout when not first visible), `BarTempoGlyph.ts` (drop bbox override;
  emit via per-beat or a hook), `BarRendererBase.ts` (delete `_dynamicSkylineGlyphs`,
  `registerDynamicSkylineGlyph`, `_emitDynamicSkylineGlyphs`, the `recreatePreBeatGlyphs`
  pruning).
- **Risk**: 2 — the visibility pre-pass is small and isolated; the BarTempoGlyph move
  is the larger change but well-scoped to one glyph.
- **Keeps recent fold gains?** Yes, and removes the registry entirely.
- **Scales to other dynamics?** Not as a general mechanism — it fixes the two known
  cases by hand. GroupedEffectGlyph still handles its own dynamic right edge via
  EffectBand.computeLocalXRange. If a future dynamic-bbox glyph appears, we'd be
  back to picking one of A/B/C. But: the survey in §3 found NO other current dynamic
  glyphs in pre/post-beat. So "scales to others" is a hypothetical cost.
- **Compatible with resize?** Yes — both refactorings make the bbox final per
  `scaleToWidth` pass, which is what resize iterates.

---

## 6. Recommendation

**Do D — targeted refactor of the two dynamic glyphs — combined with a small piece of A
(the `populateBarSkyline` hook as the documented seam name) so future dynamic glyphs
have a contract to opt into.**

Concretely:

1. Add a `Glyph.populateBarSkyline?(target, top, bottom)` optional method. Calling it is
   not required for stable-bbox glyphs (they continue to be read via bbox in the
   `calculateOverflows` pre/post walks). Naming the seam now makes the next dynamic glyph
   self-evident.
2. In `StaffSystem.addBars` and `StaffSystem.addMasterBarRenderers`, decide
   `firstVisibleStaff` in a pre-pass over `g.staves` BEFORE the renderer-creation loop.
   Use `_isBarVisible(bar)` derived from `bar.isEmpty || bar.isRestOnly` mirrored against
   the staff's existing `_emptyBarCount`. After this, `staff.isFirstInSystem` reads a
   final value during `doLayout`.
3. Drop `BarNumberGlyph`'s bbox overrides. In `doLayout`, if `!staff.isFirstInSystem`,
   set `this.width = 0`. The standard pre-beat bbox path picks up the right ranges.
4. Move `BarTempoGlyph` from `_preBeatGlyphs` to a beat-anchored emission via the new
   hook (resolve `ratioPosition` → beat at `doLayout` time, store `(beatId, leftPad,
   rightPad)`; `populateBarSkyline` reads beat container x when called from the per-beat
   callback in `scaleToWidth`).
5. Delete `_dynamicSkylineGlyphs`, `registerDynamicSkylineGlyph`,
   `_emitDynamicSkylineGlyphs`, and the pre-prune in `recreatePreBeatGlyphs`.

Why D over A as the primary frame: candidate A keeps the dynamic seam architecturally —
every dynamic glyph just opts in. Candidate D **eliminates the dynamic seam** by removing
the only two dynamic glyphs. The result is a renderer where bbox is the canonical input
to skyline emit and no glyph-specific machinery exists in `BarRendererBase`. That's a
smaller renderer with a stronger invariant (all pre/post-beat glyph bboxes are stable at
`calculateOverflows` time, full stop). The added hook from A becomes a documented escape
hatch we don't need to use yet; it just removes the temptation for the next contributor
to invent a parallel registry.

Costs we accept: a small loss of "automatic" support for future dynamic glyphs we didn't
think of. We pay that cost in exchange for deleting ~50 lines of registry machinery in
`BarRendererBase` and ~30 lines of bbox overrides in the two glyphs. If a new dynamic
case appears, the hook from step 1 is in place and the path is obvious.

---

## 7. Open questions

- **Does `firstVisibleStaff` ever change AFTER `addBars` for the same master bar?**
  `_updateVisibility` runs on `addBarRenderer` (resize path) and `addBar`. `revertLastBar`
  (`RenderStaff.ts:175-192`) decrements `_emptyBarCount` and re-runs `_updateVisibility`.
  If a revert during system assembly causes a previously-not-first staff to become first,
  the `BarNumberGlyph`s of bars ALREADY laid out on that staff have already-stale
  visibility decisions cached. The current `_dynamicSkylineGlyphs` registry handles this
  by re-emitting on every `scaleToWidth`. If we move visibility to a pre-pass, we need
  to confirm that `revertLastBar`'s `_updateVisibility` does not flip `firstVisibleStaff`
  in a way that retro-actively changes bar-number rendering. Suspect file:
  `RenderStaff.ts:175-192`, `StaffSystem.ts:497-543`. Likely a runtime experiment with
  `hideEmptyStaves` enabled across a multi-staff score where one staff becomes empty
  mid-system.

- **`BarTempoGlyph`'s ratioPosition resolution to a beat**: does
  `Automation.ratioPosition` always have a "nearest beat" mapping inside the bar?
  Behavior when the ratio lands between beats matters for skyline placement. Source:
  the structure of `Bar.voices[0].beats[0].absoluteDisplayStart` arithmetic. Need to
  confirm by reading `Automation` and the player-side resolver used today.

- **`triggerResize` interaction with `_dynamicSkylineGlyphs`**: today the registry is
  re-walked on every `scaleToWidth` and the entries are pruned on `recreatePreBeatGlyphs`.
  Does `triggerResize` ever call `applyLayoutingInfo` without a subsequent `scaleToWidth`?
  If yes, dynamic emit would be skipped under the current scheme and any replacement must
  also handle that path. Worth tracing in `ScoreRendererWrapper` and `VerticalLayoutBase.doResize`.

- **Effect-band skyline coupling**: the `_unionBarLocalIntoStaffSkyline` union runs in
  `finalizeStaff` BEFORE `EffectSystemPlacement.placeAndApply` (`RenderStaff.ts:324-327`).
  The effect placement reads `systemSkyline` to decide where to stack bands; that means
  pre/post-beat skyline data must already be in the systemSkyline before placement.
  Confirm: does `BarTempoGlyph` need its bbox represented in `systemSkyline` for the
  benefit of any other effect band placement? If yes, the beat-anchored emission in
  D step 4 still arrives via the per-beat callback → `barLocalSkyline` → union, so the
  data IS in `systemSkyline` before placement. Likely fine, but worth checking against
  `EffectSystemPlacement.placeAndApply` x-range queries.

- **`GroupedEffectGlyph`'s right edge**: it queries `renderer.getBeatX(beat, endPosition)`
  in `getBoundingBoxRight`. Is anything in the renderer pipeline reading
  `GroupedEffectGlyph.getBoundingBoxRight` BEFORE the per-beat callback has settled the
  beat x? `EffectBand.computeLocalXRange` is the consumer; need to confirm its caller
  fires after beat positions are final (looks like yes via `EffectSystemPlacement.placeAndApply`
  → `m.computeLocalXRange` post-`finalizeBand`, but only static reading can confirm).

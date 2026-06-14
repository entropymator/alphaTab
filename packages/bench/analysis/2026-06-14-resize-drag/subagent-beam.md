# Beam + beat container + spring layout — canon-resize-drag analysis

Baseline median **235.30 ms / iter**, σ floor **±3.48 ms (1.48 %)**, 1 % = **2.35 ms**.
Drag scenario has the same hot-spot shape as canon-resize, scaled ~4.6× (3 widths reused vs
12 widths cycled). All numbers below are absolute ms/iter from canon-resize-drag TOP30.

## Entry classifications (≥ 0.5 % CPU or ≥ 50 kB heap)

| Frame | ms/iter | %CPU | Class | Note |
|---|---:|---:|:---:|---|
| `_scaleToForce` (MultiVoiceContainerGlyph:64) | 34.09 | 1.72 | **A** | Spring re-distribution every width change |
| `registerLayoutingInfo` (MultiVoiceContainerGlyph:200) | 59.40 | 2.99 | **S/A** | Bar-local invariant under width change |
| `paintBar` (LineBarRenderer:709 — beam-bar painter) | 46.66 | 2.35 | **I** | Pure SVG paint |
| `_paintNormal` (BeatGlyphBase:64) | 27.23 | 1.37 | **I** | Loops `_normalGlyphs[].paint()`; trivial |
| `_computeBeamingBounds` (LineBarRenderer:899) | 24.24 | 1.22 | **A** | See Q2 below |
| `paint` (MultiVoiceContainerGlyph:362) | 17.06 | 0.86 | **I** | Voice draw-order loop |
| `paint` (ScoreNoteChordGlyphBase:603) | 20.75 | 1.04 | **I** | Per-chord paint |
| `placeAndApply` (EffectSystemPlacement:28) | 20.20 | 1.02 | **A/S** | See Q4 below |
| `_emitBeatContainerSkyline` (MultiVoiceContainerGlyph) | heap 31.13 kB | — | **S** | Allocation hot in drag mode |

## Specific answers

**Q1 — Is BeamingHelper state width-invariant?** **Mostly YES, with a narrow exception.**
`BeamingHelper` is fully constructed during `BarRendererBase.doLayout`'s `createBeatGlyphs`
walk; ctor + `checkBeat`/`_canJoin`/`_checkNote` (BeamingHelper.ts:101, 150, 245) populate
beam grouping, `shortestDuration`, low/high notes, tuplet flags, beam direction — all
properties of the model. The only width-dependent fields are the `_drawingInfoUp/Down`
**cache pair** at lines 327-330, invalidated by `BarRendererBase.scaleToWidth:373` via
`h.invalidateDrawingInfos()`. So the structural object is invariant; only the cached
post-spring endpoint X/Y needs invalidation. **Cacheable** → if DR-1 lands, `BeamingHelper`
construction (54529 ctor, not visible in TOP30 → already cheap) is **not** the win — the
win is skipping all the downstream consumers (`_computeBeamingBounds`, `emitHelperSkyline`,
`paintBeams`) when only `system.x` changes.

**Q2 — `_computeBeamingBounds` 1.22 % call path.** Two call sites both in `BarRendererBase.scaleToWidth`:
`emitHelperSkyline:381` (post-spring skyline emission) and `calculateBeamingOverflows`
(via `ScoreBarRenderer.applyLayoutingInfo`). Both invoke
`ensureBeamDrawingInfo(h, direction)` → `initializeBeamDrawingInfo` → `getBeatX(Stem)`
lookups that resolve through the spring-positioned beat containers. So this fires on
**every renderer × every beam group × every width change**. Under DR-1 with a stable
bar-membership cache, this is fully skippable when only `system.x` changes — only when
`actualBarWidth` changes (per `VerticalLayoutBase._scaleToWidth:465`) is recomputation
needed. **Upper bound: 24.24 ms / iter (full elimination on x-only resize)**.

**Q3 — When does `_scaleToForce` re-invoke per resize?**
`BarRendererBase.scaleToWidth:377` → `MultiVoiceContainerGlyph.scaleToWidth:58` →
`_scaleToForce(force, /*emit=*/true)` runs on **every renderer per width change**
(`VerticalLayoutBase._scaleToWidth:465`). Also runs `emit=false` once in
`applyLayoutingInfo:214` during `_applyLayoutAndUpdateWidth`. It's bar-local: it reads
`this.renderer.layoutingInfo.spaceToForce(width)` / `calculateVoiceWidth(force)` /
`buildOnTimePositions(force)`. **The spring constants themselves don't change** when only
the system's distributed share changes — only `force` does, and the inner walks at lines
67-152 (`positions.get(...)`, sets `currentBeatGlyph.x`, calls each `previous.scaleToWidth`)
all repeat. **34.09 ms / iter; DR-1 captures all of it for x-only resizes (none in drag
profile, all 12 width values change `actualBarWidth`), but it captures 100 % of
`registerLayoutingInfo`'s 59.40 ms — that walk's outputs are width-invariant.**

**Q4 — `placeAndApply` 1.02 %.** EffectSystemPlacement:28. Runs once per staff per resize
from `RenderStaff.finalizeStaff:303`. Reads `staff.systemSkyline` and per-renderer
`topEffects/bottomEffects.bands`, then sorts by `sortKey` and walks `_placeSide`. The
sort key, band identity, voice index, effect category are all width-invariant. Only the
skyline coordinates (`sky.upSky.maxHeightInRange(r.x, r.x + r.width)` lines 49-50, 77-80)
and band x-ranges depend on width. **20.20 ms / iter. Under DR-1's x-only mode, the band
sort + grouping is skippable; only the skyline-query coordinates need updating.** Heap
~12.5 kB/iter (the `groupBands/groupXStarts/groupXEnds` scratch arrays already pool, so
the 64.24 kB attributed by 5-trial total includes setup, not pure resize).

**Q5 — Width-only DR-1 fraction.** Aggregating the bar-local invariant portion of beam +
beat-container + spring work:

| Frame | ms/iter | Invariant under x-only? |
|---|---:|---|
| `registerLayoutingInfo` | 59.40 | **YES** (spring constants are bar-local & duration-derived) |
| `_scaleToForce` | 34.09 | **NO** (force changes when `actualBarWidth` changes) |
| `_computeBeamingBounds` | 24.24 | **YES** (beam endpoints invariant in stem coords) |
| `placeAndApply` (sort + grouping portion) | ~10 of 20.20 | **YES** |
| `_emitBeatContainerSkyline` | ~5 (allocations) | **YES** |

**Aggregate x-only-skippable in this area: ~98 ms / iter = ~42 % of total.** The drag
scenario specifically changes `actualBarWidth` on every iteration (12 widths × 3 drag
phases), so `_scaleToForce` cannot be skipped here without an actual-bar-width memoisation
key. The other ~98 ms is pure cache-on-bar-membership candidate territory.

**No micro-devirt angle found.** Polymorphic call sites in this area (BeatContainerGlyph
overrides for `registerLayoutingInfo`/`applyLayoutingInfo`, with 4 receivers:
MultiVoice/MultiBarRest/NumberedDash/(default)) match the EW-3 demoted pattern: per-call
absolute cost in the noise floor. The wins are algorithmic (DR-1 cache) or intrinsic
(SVG paint). Recommend: bundle `_computeBeamingBounds` (24.24 ms) and
`registerLayoutingInfo` (59.40 ms) into the DR-1 cache key alongside Skyline.union work
identified by the skyline-walk agent.

## Files of interest (absolute paths)
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/utils/BeamingHelper.ts (lines 47-106, 316-346)
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/LineBarRenderer.ts (lines 462-525, 899-997)
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/BarRendererBase.ts (lines 362-408, 442-458, 640-708)
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts (lines 58-215, 362-374)
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/EffectSystemPlacement.ts (lines 28-94)
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts (lines 140-164, 281-350, 429-470)
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/staves/RenderStaff.ts (lines 273-313)

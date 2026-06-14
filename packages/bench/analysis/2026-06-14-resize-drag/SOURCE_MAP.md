# Dist-line → source-file map for the resize-drag-1781434957 baseline

canon-resize-drag baseline: median **235.30 ms**, cross-trial σ **±3.48 ms (1.48 %)**.
1 % of scenario = **2.35 ms**; this is the σ-floor candidates must clear.

The TOP30.md / cpuprofile / heapprofile reference functions by their position
in the bundled `packages/bench/dist/runOne.mjs`. Below is the source-map
resolution for the lines that show up in the top-30:

| dist line | source file:line |
| ---: | --- |
| 49856 | packages/alphatab/src/platform/svg/SvgCanvas.ts:52 (`fillRect`) |
| 49872 | packages/alphatab/src/platform/svg/SvgCanvas.ts:83 (`lineTo`) |
| 49900 | packages/alphatab/src/platform/svg/SvgCanvas.ts:126 |
| 49919 | packages/alphatab/src/platform/svg/SvgCanvas.ts:151 (`fillText`) |
| 49979 | packages/alphatab/src/platform/svg/CssFontSvgCanvas.ts:39 (`_fillMusicFontSymbolText`) |
| 51629 | packages/alphatab/src/rendering/glyphs/GlyphGroup.ts:10 (`GlyphGroup` ctor) |
| 51634 | packages/alphatab/src/rendering/glyphs/GlyphGroup.ts:17 (`getBoundingBoxTop`) |
| 51668 | packages/alphatab/src/rendering/glyphs/GlyphGroup.ts:67 (`paint`) |
| 53365 | packages/alphatab/src/rendering/skyline/Skyline.ts:217 (`unionShifted3`) |
| 53510 | packages/alphatab/src/rendering/skyline/Skyline.ts:448 (`_initBaseline`) |
| 53534 | packages/alphatab/src/rendering/skyline/Skyline.ts:483 (`_raiseRange`) |
| 53556 | packages/alphatab/src/rendering/skyline/Skyline.ts:538 (`_splitAt`) |
| 53634 | packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts:64 (`_scaleToForce`) |
| 53706 | packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts:200 (`registerLayoutingInfo`) |
| 53803 | packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts:362 (`paint`) |
| 54049 | packages/alphatab/src/rendering/glyphs/TieGlyph.ts:428 (`_calculateActualTieHeightFromCps`) |
| 54529 | packages/alphatab/src/rendering/utils/BeamingHelper.ts:48 (`BeamingHelper` ctor) |
| 54858 | packages/alphatab/src/rendering/utils/BarHelpers.ts:28 (`initialize`) |
| 55311 | packages/alphatab/src/rendering/BarRendererBase.ts:424 (`get settings`) |
| 55455 | packages/alphatab/src/rendering/BarRendererBase.ts:643 (`calculateOverflows`) |
| 55473 | packages/alphatab/src/rendering/BarRendererBase.ts:683 (`_emitGroupOverflows`) |
| 55536 | packages/alphatab/src/rendering/BarRendererBase.ts:784 (`buildBoundingsLookup`) |
| 55577 | packages/alphatab/src/rendering/BarRendererBase.ts:845 (`getBeatX`) |
| 55606 | packages/alphatab/src/rendering/BarRendererBase.ts:895 (`paintSimileMark`) |
| 57413 | packages/alphatab/src/rendering/utils/ObjectPool.ts:38 (`acquire`) |
| 57457 | packages/alphatab/src/rendering/skyline/SkylineSegmentPool.ts:21 |
| 57483 | packages/alphatab/src/rendering/EffectSystemPlacement.ts:28 (`placeAndApply`) |
| 57651 | packages/alphatab/src/rendering/staves/RenderStaff.ts:83 (`RenderStaff` ctor) |
| 57684 | packages/alphatab/src/rendering/staves/RenderStaff.ts:132 (`addBarRenderer`) |
| 57736 | packages/alphatab/src/rendering/staves/RenderStaff.ts:215 (`get effectPlacement`) |
| 57740 | packages/alphatab/src/rendering/staves/RenderStaff.ts:222 (`get systemSkyline`) |
| 58620 | packages/alphatab/src/rendering/staves/StaffSystem.ts:789 (`addStaff`) |
| 58846 | packages/alphatab/src/rendering/staves/StaffSystem.ts:1200 (`buildBoundingsLookup`) |
| 59121 | packages/alphatab/src/rendering/layout/ScoreLayout.ts:381 (`createEmptyStaffSystem`) |
| 60177 | packages/alphatab/src/rendering/glyphs/BeatGlyphBase.ts:64 (`_paintNormal`) |
| 61109 | packages/alphatab/src/rendering/LineBarRenderer.ts:118 (`paintBackground`) |
| 61114 | packages/alphatab/src/rendering/LineBarRenderer.ts:131 (`paintStaffLines`) |
| 61297 | packages/alphatab/src/rendering/LineBarRenderer.ts:462 (`paintBeams`) |
| 61367 | packages/alphatab/src/rendering/LineBarRenderer.ts:650 (`createPreBeatGlyphs`) |
| 61394 | packages/alphatab/src/rendering/LineBarRenderer.ts:709 (`paintBar`) |
| 61484 | packages/alphatab/src/rendering/LineBarRenderer.ts:899 (`_computeBeamingBounds`) |
| 62379 | packages/alphatab/src/rendering/glyphs/ScoreNoteChordGlyphBase.ts:323 |
| 62517 | packages/alphatab/src/rendering/glyphs/ScoreNoteChordGlyphBase.ts:603 (`paint`) |
| 62683 | packages/alphatab/src/rendering/glyphs/ScoreNoteChordGlyph.ts:106 (`_internalGetNoteY`) |
| 62726 | packages/alphatab/src/rendering/glyphs/ScoreNoteChordGlyph.ts:174 |
| 63384 | packages/alphatab/src/rendering/glyphs/ScoreBeatGlyph.ts:217 (`_createNoteGlyphs`) |
| 63480 | packages/alphatab/src/rendering/glyphs/ScoreBeatGlyph.ts:392 (`_createNoteGlyph`) |
| 64403 | packages/alphatab/src/rendering/ScoreBeatContainerGlyph.ts:86 (`getBoundingBoxTop`) |
| 64527 | packages/alphatab/src/rendering/ScoreBarRenderer.ts:67 (`get drawnLineCount`) |
| 65204 | packages/alphatab/src/rendering/glyphs/NoteNumberGlyph.ts:113 (`paint`) |
| 65469 | packages/alphatab/src/rendering/glyphs/TabBeatGlyph.ts:87 (`doLayout`) |
| 66011 | packages/alphatab/src/rendering/TabBarRenderer.ts:89 (`collectSpaces`) |

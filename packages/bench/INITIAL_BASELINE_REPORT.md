# alphaTab bench report — svg-baseline-3trials

Generated: 2026-06-13T12:49:55.487Z
Trials per scenario: 3

## Wall-clock summary

`median*` is the median of per-trial medians. `±` is the standard deviation across the per-trial medians — a noise floor for cross-run comparison. A delta smaller than 2× this number is not distinguishable from run-to-run drift.

| Scenario | trials | iters/trial | median* | mean | ± cross-trial | avg intra-trial SE | min | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tiny-render | 3 | 20 | 0.76 ms | 0.76 ms | ± 0.01 ms | 0.10 ms | 0.69 ms | 2.10 ms |
| nightwish-resize | 3 | 10 | 31.44 ms | 30.80 ms | ± 1.24 ms | 8.73 ms | 24.81 ms | 217.81 ms |
| nightwish-render | 3 | 10 | 24.46 ms | 24.54 ms | ± 0.51 ms | 1.43 ms | 17.14 ms | 28.95 ms |
| canon-resize | 3 | 8 | 130.38 ms | 130.64 ms | ± 0.46 ms | 4.63 ms | 122.40 ms | 155.50 ms |
| canon-render | 3 | 8 | 98.96 ms | 99.60 ms | ± 5.02 ms | 5.50 ms | 79.39 ms | 135.20 ms |
| fade-to-black-resize | 3 | 8 | 72.58 ms | 72.22 ms | ± 1.98 ms | 9.89 ms | 49.81 ms | 183.67 ms |

Per-trial medians (ms):

- **tiny-render**: 0.75, 0.76, 0.76
- **nightwish-resize**: 29.38, 31.44, 31.59
- **nightwish-render**: 24.08, 24.46, 25.09
- **canon-resize**: 130.37, 131.18, 130.38
- **canon-render**: 98.96, 94.94, 104.91
- **fade-to-black-resize**: 70.08, 73.99, 72.58

## Stage breakdown (Profiler) — first trial

### tiny-render

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| render.total | 20 | 18.08 | 904.06 | 2.09 |
| render.layoutAndRender | 20 | 17.66 | 883.10 | 2.05 |
| layout.doLayoutAndRender | 20 | 15.34 | 767.05 | 1.88 |
| layout.finalizeSystem | 20 | 1.42 | 71.05 | 0.12 |
| layout.finalizeStaff | 40 | 1.30 | 32.47 | 0.09 |

Heap delta: used 4275.6 kB, total 256.0 kB

### nightwish-resize

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| resize.total | 40 | 291.94 | 7298.55 | 10.16 |
| resize.layoutResize | 40 | 285.96 | 7149.12 | 10.05 |
| layout.doResize | 40 | 285.87 | 7146.72 | 10.04 |
| layout.finalizeSystem | 950 | 47.00 | 49.48 | 2.55 |
| layout.finalizeStaff | 950 | 45.69 | 48.09 | 2.55 |

Heap delta: used 25468.1 kB, total 40960.0 kB

### nightwish-render

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| render.total | 10 | 230.37 | 23036.62 | 26.48 |
| render.layoutAndRender | 10 | 227.80 | 22780.19 | 26.30 |
| layout.doLayoutAndRender | 10 | 226.68 | 22667.94 | 26.20 |
| layout.finalizeSystem | 200 | 19.36 | 96.79 | 0.29 |
| layout.finalizeStaff | 200 | 18.34 | 91.68 | 0.29 |

Heap delta: used 50503.4 kB, total 84992.0 kB

### canon-resize

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| resize.total | 32 | 1063.01 | 33219.17 | 53.44 |
| resize.layoutResize | 32 | 1039.43 | 32482.17 | 52.97 |
| layout.doResize | 32 | 1039.34 | 32479.45 | 52.97 |
| layout.finalizeSystem | 2800 | 123.01 | 43.93 | 4.56 |
| layout.finalizeStaff | 5600 | 113.85 | 20.33 | 0.68 |

Heap delta: used 112629.2 kB, total 65536.0 kB

### canon-render

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| render.total | 8 | 787.96 | 98495.42 | 105.74 |
| render.layoutAndRender | 8 | 781.56 | 97695.04 | 105.13 |
| layout.doLayoutAndRender | 8 | 780.72 | 97589.88 | 105.03 |
| layout.finalizeSystem | 576 | 46.21 | 80.22 | 1.05 |
| layout.finalizeStaff | 1152 | 43.97 | 38.17 | 1.02 |

Heap delta: used 168728.6 kB, total 118016.0 kB

### fade-to-black-resize

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| resize.total | 24 | 554.38 | 23099.22 | 29.46 |
| resize.layoutResize | 24 | 544.71 | 22696.08 | 28.74 |
| layout.doResize | 24 | 544.65 | 22693.63 | 28.73 |
| layout.finalizeSystem | 976 | 85.27 | 87.36 | 1.71 |
| layout.finalizeStaff | 1952 | 83.12 | 42.58 | 1.64 |

Heap delta: used 84574.8 kB, total 81920.0 kB

## CPU hotspots (top 15 self-time, measured-loop only)

### tiny-render

Total sampled: 44.96 ms across 122 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 25.90 | 57.6% | post | node:inspector:115 |
| 0.78 | 1.7% | _layoutAndRenderScoreInfo | packages/bench/dist/runOne.mjs:59342 |
| 0.50 | 1.1% | runScenario | packages/bench/dist/runOne.mjs:66769 |
| 0.47 | 1.1% | createEmptyStaffSystem | packages/bench/dist/runOne.mjs:58949 |
| 0.47 | 1.0% | measureText | packages/bench/dist/runOne.mjs:49947 |
| 0.47 | 1.0% | _createScoreInfoGlyphs | packages/bench/dist/runOne.mjs:58878 |
| 0.32 | 0.7% | doLayout | packages/bench/dist/runOne.mjs:65306 |
| 0.32 | 0.7% | doLayout | packages/bench/dist/runOne.mjs:61773 |
| 0.32 | 0.7% | placeAndApply | packages/bench/dist/runOne.mjs:57307 |
| 0.32 | 0.7% | _scaleToForce | packages/bench/dist/runOne.mjs:53496 |
| 0.32 | 0.7% | measureString | packages/bench/dist/runOne.mjs:30542 |
| 0.32 | 0.7% | doLayout | packages/bench/dist/runOne.mjs:55299 |
| 0.32 | 0.7% | doLayout | packages/bench/dist/runOne.mjs:55299 |
| 0.31 | 0.7% | Skyline | packages/bench/dist/runOne.mjs:53228 |
| 0.31 | 0.7% | paint | packages/bench/dist/runOne.mjs:57625 |

### nightwish-resize

Total sampled: 336.92 ms across 1,851 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 44.04 | 13.1% | post | node:inspector:115 |
| 20.51 | 6.1% | (garbage collector) | <native> |
| 15.52 | 4.6% | unionShifted | packages/bench/dist/runOne.mjs:53291 |
| 4.36 | 1.3% | placeAndApply | packages/bench/dist/runOne.mjs:57307 |
| 4.32 | 1.3% | registerLayoutingInfo | packages/bench/dist/runOne.mjs:44664 |
| 4.05 | 1.2% | buildBoundingsLookup | packages/bench/dist/runOne.mjs:44723 |
| 4.01 | 1.2% | scaleToWidth | packages/bench/dist/runOne.mjs:55147 |
| 3.59 | 1.1% | fillRect | packages/bench/dist/runOne.mjs:49856 |
| 3.32 | 1.0% | _usingCtx | packages/bench/dist/runOne.mjs:49555 |
| 2.83 | 0.8% | doLayout | packages/bench/dist/runOne.mjs:53723 |
| 2.67 | 0.8% | paintContent | packages/bench/dist/runOne.mjs:55381 |
| 2.50 | 0.7% | getBoundingBoxTop | packages/bench/dist/runOne.mjs:63130 |
| 2.49 | 0.7% | fillRect | packages/bench/dist/runOne.mjs:49856 |
| 2.35 | 0.7% | buildBoundingsLookup | packages/bench/dist/runOne.mjs:53633 |
| 2.29 | 0.7% | paint | packages/bench/dist/runOne.mjs:59813 |

### nightwish-render

Total sampled: 277.74 ms across 1,419 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 46.13 | 16.6% | post | node:inspector:115 |
| 24.63 | 8.9% | (garbage collector) | <native> |
| 4.61 | 1.7% | initialize | packages/bench/dist/runOne.mjs:54720 |
| 3.94 | 1.4% | _paintEffects | packages/bench/dist/runOne.mjs:60008 |
| 3.43 | 1.2% | unionShifted | packages/bench/dist/runOne.mjs:53291 |
| 3.22 | 1.2% | getScoreChordNoteHeadInfo | packages/bench/dist/runOne.mjs:62476 |
| 2.34 | 0.8% | _createNoteGlyphs | packages/bench/dist/runOne.mjs:63221 |
| 2.03 | 0.7% | paintStaffLines | packages/bench/dist/runOne.mjs:60948 |
| 1.95 | 0.7% | paint | packages/bench/dist/runOne.mjs:62351 |
| 1.87 | 0.7% | createVoiceGlyphs | packages/bench/dist/runOne.mjs:64523 |
| 1.86 | 0.7% | createVoiceGlyphs | packages/bench/dist/runOne.mjs:53154 |
| 1.74 | 0.6% | _prepareForLayout | packages/bench/dist/runOne.mjs:62231 |
| 1.58 | 0.6% | createEmptyStaffSystem | packages/bench/dist/runOne.mjs:58949 |
| 1.56 | 0.6% | doLayout | packages/bench/dist/runOne.mjs:53723 |
| 1.42 | 0.5% | paint | packages/bench/dist/runOne.mjs:44709 |

### canon-resize

Total sampled: 1140.65 ms across 6,639 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 76.37 | 6.7% | post | node:inspector:115 |
| 74.05 | 6.5% | (garbage collector) | <native> |
| 36.06 | 3.2% | unionShifted | packages/bench/dist/runOne.mjs:53291 |
| 21.33 | 1.9% | fillRect | packages/bench/dist/runOne.mjs:49856 |
| 15.56 | 1.4% | collectSpaces | packages/bench/dist/runOne.mjs:65848 |
| 14.54 | 1.3% | buildBoundingsLookup | packages/bench/dist/runOne.mjs:44723 |
| 12.96 | 1.1% | fillRect | packages/bench/dist/runOne.mjs:49856 |
| 12.79 | 1.1% | paintBackground | packages/bench/dist/runOne.mjs:60943 |
| 12.51 | 1.1% | paintBar | packages/bench/dist/runOne.mjs:61228 |
| 12.51 | 1.1% | fillRect | packages/bench/dist/runOne.mjs:49856 |
| 11.95 | 1.0% | _usingCtx | packages/bench/dist/runOne.mjs:49555 |
| 11.59 | 1.0% | paintStaffLines | packages/bench/dist/runOne.mjs:60948 |
| 11.31 | 1.0% | registerLayoutingInfo | packages/bench/dist/runOne.mjs:53568 |
| 11.01 | 1.0% | fillText | packages/bench/dist/runOne.mjs:49919 |
| 10.96 | 1.0% | placeAndApply | packages/bench/dist/runOne.mjs:57307 |

### canon-render

Total sampled: 855.20 ms across 4,705 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 107.05 | 12.5% | (garbage collector) | <native> |
| 66.18 | 7.7% | post | node:inspector:115 |
| 14.50 | 1.7% | fillRect | packages/bench/dist/runOne.mjs:49856 |
| 14.24 | 1.7% | paintStaffLines | packages/bench/dist/runOne.mjs:60948 |
| 10.62 | 1.2% | unionShifted | packages/bench/dist/runOne.mjs:53291 |
| 8.27 | 1.0% | fillRect | packages/bench/dist/runOne.mjs:49856 |
| 7.77 | 0.9% | collectSpaces | packages/bench/dist/runOne.mjs:65848 |
| 7.68 | 0.9% | paintBar | packages/bench/dist/runOne.mjs:61228 |
| 7.29 | 0.9% | buildBoundingsLookup | packages/bench/dist/runOne.mjs:44723 |
| 6.82 | 0.8% | initialize | packages/bench/dist/runOne.mjs:54720 |
| 6.72 | 0.8% | createVoiceGlyphs | packages/bench/dist/runOne.mjs:64523 |
| 6.14 | 0.7% | fillText | packages/bench/dist/runOne.mjs:49919 |
| 5.22 | 0.6% | paint | packages/bench/dist/runOne.mjs:44709 |
| 4.73 | 0.6% | _paintLedgerLines | packages/bench/dist/runOne.mjs:62363 |
| 4.70 | 0.5% | _escapeText | packages/bench/dist/runOne.mjs:49927 |

### fade-to-black-resize

Total sampled: 611.52 ms across 3,353 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 56.11 | 9.2% | post | node:inspector:115 |
| 40.73 | 6.7% | (garbage collector) | <native> |
| 26.17 | 4.3% | unionShifted | packages/bench/dist/runOne.mjs:53291 |
| 15.07 | 2.5% | paintStaffLines | packages/bench/dist/runOne.mjs:60948 |
| 9.83 | 1.6% | fillRect | packages/bench/dist/runOne.mjs:49856 |
| 8.01 | 1.3% | registerLayoutingInfo | packages/bench/dist/runOne.mjs:53568 |
| 7.33 | 1.2% | buildBoundingsLookup | packages/bench/dist/runOne.mjs:44723 |
| 7.11 | 1.2% | finish | packages/bench/dist/runOne.mjs:33947 |
| 7.07 | 1.2% | fillRect | packages/bench/dist/runOne.mjs:49856 |
| 6.67 | 1.1% | placeAndApply | packages/bench/dist/runOne.mjs:57307 |
| 5.13 | 0.8% | paintContent | packages/bench/dist/runOne.mjs:55381 |
| 4.49 | 0.7% | addMasterBarRenderers | packages/bench/dist/runOne.mjs:58146 |
| 4.48 | 0.7% | paintBackground | packages/bench/dist/runOne.mjs:60943 |
| 4.29 | 0.7% | fillText | packages/bench/dist/runOne.mjs:49919 |
| 4.23 | 0.7% | paintStaffLines | packages/bench/dist/runOne.mjs:60948 |

## Heap allocation hotspots (top 15 bytes, measured-loop only)

### tiny-render

Total sampled: 289.6 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 64.2 | 0 | #onMessage | node:inspector:84 |
| 16.5 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:58041 |
| 16.4 | 0 | _layoutAndRenderTunings | packages/bench/dist/runOne.mjs:59298 |
| 16.2 | 0 | push | <native> |
| 16.2 | 0 | RenderStaff | packages/bench/dist/runOne.mjs:57475 |
| 16.0 | 0 | GlyphGroup | packages/bench/dist/runOne.mjs:51627 |
| 16.0 | 0 | newGuid | packages/bench/dist/runOne.mjs:3685 |
| 16.0 | 0 | push | <native> |
| 16.0 | 0 | paintPartial | packages/bench/dist/runOne.mjs:58498 |
| 16.0 | 0 | push | <native> |
| 16.0 | 0 | addBar | packages/bench/dist/runOne.mjs:57522 |
| 16.0 | 0 | push | <native> |
| 16.0 | 0 | EffectGlyph | packages/bench/dist/runOne.mjs:50535 |
| 16.0 | 0 | scaleWith | packages/bench/dist/runOne.mjs:18723 |
| 16.0 | 0 | _initBaseline | packages/bench/dist/runOne.mjs:53372 |

### nightwish-resize

Total sampled: 1937.5 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 367.3 | 0 | #onMessage | node:inspector:84 |
| 192.9 | 0 | unionShifted | packages/bench/dist/runOne.mjs:53291 |
| 113.7 | 0 | buildBoundingsLookup | packages/bench/dist/runOne.mjs:44723 |
| 101.7 | 0 | addBeatSpring | packages/bench/dist/runOne.mjs:57764 |
| 57.3 | 0 | paint | packages/bench/dist/runOne.mjs:44709 |
| 56.0 | 0 | ElementStyleScope | packages/bench/dist/runOne.mjs:51796 |
| 55.0 | 0 | values | <native> |
| 49.3 | 0 | get drawnLineCount | packages/bench/dist/runOne.mjs:64364 |
| 48.0 | 0 | _scaleToForce | packages/bench/dist/runOne.mjs:53496 |
| 44.3 | 0 | set | <native> |
| 38.8 | 0 | minBoundingBox | packages/bench/dist/runOne.mjs:4187 |
| 35.7 | 0 | splice | <native> |
| 35.5 | 0 | bezierCurveTo | packages/bench/dist/runOne.mjs:49880 |
| 35.1 | 0 | next | <native> |
| 34.2 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:50891 |

### nightwish-render

Total sampled: 4621.5 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 256.4 | 0 | #onMessage | node:inspector:84 |
| 160.8 | 0 | _createNoteGlyphs | packages/bench/dist/runOne.mjs:63221 |
| 144.7 | 0 | Map | <native> |
| 144.7 | 0 | _createNoteGlyph | packages/bench/dist/runOne.mjs:63317 |
| 144.7 | 0 | ScoreNoteChordGlyphBase | packages/bench/dist/runOne.mjs:62213 |
| 144.4 | 0 | unionShifted | packages/bench/dist/runOne.mjs:53291 |
| 128.2 | 0 | BeamingHelper | packages/bench/dist/runOne.mjs:54391 |
| 112.5 | 0 | initialize | packages/bench/dist/runOne.mjs:54720 |
| 112.2 | 0 | _prepareForLayout | packages/bench/dist/runOne.mjs:62231 |
| 112.2 | 0 | buildBoundingsLookup | packages/bench/dist/runOne.mjs:44723 |
| 96.7 | 0 | set | <native> |
| 96.5 | 0 | EffectGlyph | packages/bench/dist/runOne.mjs:50535 |
| 96.3 | 0 | Set | <native> |
| 80.3 | 0 | _collectNoteDisplacements | packages/bench/dist/runOne.mjs:62314 |
| 80.3 | 0 | Map | <native> |

### canon-resize

Total sampled: 4534.8 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 1155.6 | 0 | buildBoundingsLookup | packages/bench/dist/runOne.mjs:44723 |
| 616.7 | 0 | #onMessage | node:inspector:84 |
| 568.1 | 0 | unionShifted | packages/bench/dist/runOne.mjs:53291 |
| 208.1 | 0 | finish | packages/bench/dist/runOne.mjs:34091 |
| 176.3 | 0 | buildBoundingsLookup | packages/bench/dist/runOne.mjs:55398 |
| 81.4 | 0 | _scaleToForce | packages/bench/dist/runOne.mjs:53496 |
| 64.7 | 0 | getFontForNotationElement | packages/bench/dist/runOne.mjs:28056 |
| 64.2 | 0 | get systemSkyline | packages/bench/dist/runOne.mjs:57564 |
| 64.1 | 0 | get effectPlacement | packages/bench/dist/runOne.mjs:57560 |
| 56.5 | 0 | acquire | packages/bench/dist/runOne.mjs:57267 |
| 56.0 | 0 | set | <native> |
| 54.1 | 0 | get contributesToBeatSpacing | packages/bench/dist/runOne.mjs:50493 |
| 53.3 | 0 | paintSimileMark | packages/bench/dist/runOne.mjs:55468 |
| 52.0 | 0 | RenderStaff | packages/bench/dist/runOne.mjs:57475 |
| 51.6 | 0 | paint | packages/bench/dist/runOne.mjs:62633 |

### canon-render

Total sampled: 21296.3 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 1091.9 | 0 | doLayout | packages/bench/dist/runOne.mjs:65306 |
| 963.0 | 0 | buildBoundingsLookup | packages/bench/dist/runOne.mjs:44723 |
| 947.9 | 0 | Map | <native> |
| 869.4 | 0 | initialize | packages/bench/dist/runOne.mjs:54720 |
| 788.6 | 0 | initialize | packages/bench/dist/runOne.mjs:54720 |
| 610.6 | 0 | _createNoteGlyphs | packages/bench/dist/runOne.mjs:63221 |
| 562.4 | 0 | Map | <native> |
| 530.2 | 0 | _createNoteGlyph | packages/bench/dist/runOne.mjs:63317 |
| 510.8 | 0 | #onMessage | node:inspector:84 |
| 497.6 | 0 | reserveBeatSlot | packages/bench/dist/runOne.mjs:54625 |
| 465.6 | 0 | unionShifted | packages/bench/dist/runOne.mjs:53291 |
| 403.2 | 0 | doLayout | packages/bench/dist/runOne.mjs:62560 |
| 320.9 | 0 | Set | <native> |
| 305.2 | 0 | BeatContainerGlyphBase | packages/bench/dist/runOne.mjs:44569 |
| 273.2 | 0 | addSpring | packages/bench/dist/runOne.mjs:57730 |

### fade-to-black-resize

Total sampled: 3265.4 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 568.8 | 0 | buildBoundingsLookup | packages/bench/dist/runOne.mjs:44723 |
| 518.1 | 0 | #onMessage | node:inspector:84 |
| 436.9 | 0 | unionShifted | packages/bench/dist/runOne.mjs:53291 |
| 160.3 | 0 | buildBoundingsLookup | packages/bench/dist/runOne.mjs:58674 |
| 160.1 | 0 | finish | packages/bench/dist/runOne.mjs:33947 |
| 80.3 | 0 | addStaff | packages/bench/dist/runOne.mjs:58448 |
| 64.3 | 0 | addGlyph | packages/bench/dist/runOne.mjs:51661 |
| 59.0 | 0 | _calculateActualTieHeightFromCps | packages/bench/dist/runOne.mjs:53911 |
| 54.2 | 0 | using | packages/bench/dist/runOne.mjs:49560 |
| 53.4 | 0 | random | <native> |
| 50.5 | 0 | get smuflMetrics | packages/bench/dist/runOne.mjs:55170 |
| 37.3 | 0 | createPreBeatGlyphs | packages/bench/dist/runOne.mjs:61201 |
| 36.2 | 0 | populateSkyline | packages/bench/dist/runOne.mjs:44561 |
| 35.5 | 0 | get drawnLineCount | packages/bench/dist/runOne.mjs:64364 |
| 34.6 | 0 | doLayout | packages/bench/dist/runOne.mjs:59723 |

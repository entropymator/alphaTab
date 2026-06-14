# Aggregated top-30 — canon-resize-drag
# trials = 5

## CPU top 30 (self-time, summed across 5 trials)
# total sampled across trials: 9937.1 ms

| # | Self ms (sum) | Self ms / trial | Self % | Function | File:line |
| ---: | ---: | ---: | ---: | --- | --- |
| 1 | 775.32 | 155.06 | 7.80% | fillRect | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:49856 |
| 2 | 507.22 | 101.44 | 5.10% | (garbage collector) | <unknown>:0 |
| 3 | 339.52 | 67.90 | 3.42% | _raiseRange | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53534 |
| 4 | 297.01 | 59.40 | 2.99% | registerLayoutingInfo | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53706 |
| 5 | 247.84 | 49.57 | 2.49% | _fillMusicFontSymbolText | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:49979 |
| 6 | 235.10 | 47.02 | 2.37% | unionShifted3 | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53365 |
| 7 | 233.30 | 46.66 | 2.35% | paintBar | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:61394 |
| 8 | 224.06 | 44.81 | 2.25% | paintBackground | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:61109 |
| 9 | 222.80 | 44.56 | 2.24% | collectSpaces | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:66011 |
| 10 | 200.64 | 40.13 | 2.02% | fillText | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:49919 |
| 11 | 178.35 | 35.67 | 1.79% | paint | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:44709 |
| 12 | 170.44 | 34.09 | 1.72% | _scaleToForce | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53634 |
| 13 | 163.95 | 32.79 | 1.65% | paintStaffLines | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:61114 |
| 14 | 163.27 | 32.65 | 1.64% | buildBoundingsLookup | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:44723 |
| 15 | 158.67 | 31.73 | 1.60% | (program) | <unknown>:0 |
| 16 | 138.54 | 27.71 | 1.39% | lineTo | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:49872 |
| 17 | 136.14 | 27.23 | 1.37% | _paintNormal | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:60177 |
| 18 | 132.14 | 26.43 | 1.33% | calculateOverflows | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:55455 |
| 19 | 121.22 | 24.24 | 1.22% | _computeBeamingBounds | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:61484 |
| 20 | 109.80 | 21.96 | 1.10% | getBeatX | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:55577 |
| 21 | 108.57 | 21.71 | 1.09% | getBoundingBoxTop | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:64403 |
| 22 | 106.14 | 21.23 | 1.07% | paint | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:51668 |
| 23 | 103.74 | 20.75 | 1.04% | paint | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:62517 |
| 24 | 103.55 | 20.71 | 1.04% | paint | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:65204 |
| 25 | 100.98 | 20.20 | 1.02% | placeAndApply | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:57483 |
| 26 | 99.45 | 19.89 | 1.00% | _emitGroupOverflows | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:55473 |
| 27 | 93.80 | 18.76 | 0.94% | getBoundingBoxTop | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:51634 |
| 28 | 89.92 | 17.98 | 0.90% | _splitAt | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53556 |
| 29 | 88.48 | 17.70 | 0.89% | _internalGetNoteY | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:62683 |
| 30 | 85.32 | 17.06 | 0.86% | paint | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53803 |

## Heap top 30 (self-bytes, summed across 5 trials)
# total sampled across trials: 255464.9 kB

| # | Bytes (sum) | kB / trial | Self % | Function | File:line |
| ---: | ---: | ---: | ---: | --- | --- |
| 1 | 220881768 | 43140.97 | 84.44% | unionShifted3 | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53365 |
| 2 | 14191000 | 2771.68 | 5.42% | _raiseRange | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53534 |
| 3 | 4958960 | 968.55 | 1.90% | _initBaseline | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53510 |
| 4 | 4882184 | 953.55 | 1.87% | buildBoundingsLookup | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:44723 |
| 5 | 3702248 | 723.10 | 1.42% | #onMessage | node:inspector:84 |
| 6 | 1294976 | 252.93 | 0.50% | finish | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:34091 |
| 7 | 739312 | 144.40 | 0.28% | buildBoundingsLookup | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:55536 |
| 8 | 721520 | 140.92 | 0.28% | (anonymous) | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:57457 |
| 9 | 672680 | 131.38 | 0.26% | set | <unknown>:0 |
| 10 | 476544 | 93.08 | 0.18% | createPreBeatGlyphs | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:61367 |
| 11 | 476480 | 93.06 | 0.18% | GlyphGroup | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:51629 |
| 12 | 430216 | 84.03 | 0.16% | get effectPlacement | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:57736 |
| 13 | 426880 | 83.38 | 0.16% | buildBoundingsLookup | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:58846 |
| 14 | 410024 | 80.08 | 0.16% | newGuid | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:3685 |
| 15 | 388488 | 75.88 | 0.15% | splice | <unknown>:0 |
| 16 | 359872 | 70.29 | 0.14% | paint | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:44709 |
| 17 | 352864 | 68.92 | 0.13% | paintSimileMark | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:55606 |
| 18 | 328896 | 64.24 | 0.13% | placeAndApply | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:57483 |
| 19 | 296832 | 57.98 | 0.11% | _scaleToForce | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53634 |
| 20 | 296192 | 57.85 | 0.11% | addStaff | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:58620 |
| 21 | 280408 | 54.77 | 0.11% | RenderStaff | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:57651 |
| 22 | 280240 | 54.73 | 0.11% | createEmptyStaffSystem | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:59121 |
| 23 | 278176 | 54.33 | 0.11% | fillText | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:49919 |
| 24 | 199560 | 38.98 | 0.08% | getBeatX | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:55577 |
| 25 | 198248 | 38.72 | 0.08% | addBarRenderer | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:57684 |
| 26 | 180800 | 35.31 | 0.07% | _calculateActualTieHeightFromCps | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:54049 |
| 27 | 180576 | 35.27 | 0.07% | Map | <unknown>:0 |
| 28 | 164584 | 32.15 | 0.06% | get systemSkyline | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:57740 |
| 29 | 163104 | 31.86 | 0.06% | sort | <unknown>:0 |
| 30 | 152824 | 29.85 | 0.06% | paintBeams | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:61297 |

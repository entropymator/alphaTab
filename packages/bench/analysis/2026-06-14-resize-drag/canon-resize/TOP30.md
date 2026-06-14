# Aggregated top-30 — canon-resize
# trials = 5

## CPU top 30 (self-time, summed across 5 trials)
# total sampled across trials: 3416.9 ms

| # | Self ms (sum) | Self ms / trial | Self % | Function | File:line |
| ---: | ---: | ---: | ---: | --- | --- |
| 1 | 258.50 | 51.70 | 7.57% | fillRect | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:49856 |
| 2 | 227.45 | 45.49 | 6.66% | (garbage collector) | <unknown>:0 |
| 3 | 98.02 | 19.60 | 2.87% | registerLayoutingInfo | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53706 |
| 4 | 91.67 | 18.33 | 2.68% | _raiseRange | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53534 |
| 5 | 89.27 | 17.85 | 2.61% | unionShifted3 | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53365 |
| 6 | 78.98 | 15.80 | 2.31% | paintBar | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:61394 |
| 7 | 76.86 | 15.37 | 2.25% | _fillMusicFontSymbolText | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:49979 |
| 8 | 71.72 | 14.34 | 2.10% | fillText | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:49919 |
| 9 | 70.05 | 14.01 | 2.05% | collectSpaces | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:66011 |
| 10 | 69.24 | 13.85 | 2.03% | (program) | <unknown>:0 |
| 11 | 61.52 | 12.30 | 1.80% | paintStaffLines | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:61114 |
| 12 | 52.81 | 10.56 | 1.55% | _scaleToForce | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53634 |
| 13 | 50.92 | 10.18 | 1.49% | buildBoundingsLookup | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:44723 |
| 14 | 48.41 | 9.68 | 1.42% | paintBackground | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:61109 |
| 15 | 46.46 | 9.29 | 1.36% | paint | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:44709 |
| 16 | 43.77 | 8.75 | 1.28% | _paintNormal | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:60177 |
| 17 | 39.75 | 7.95 | 1.16% | _computeBeamingBounds | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:61484 |
| 18 | 38.37 | 7.67 | 1.12% | lineTo | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:49872 |
| 19 | 37.11 | 7.42 | 1.09% | paintContent | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:55519 |
| 20 | 34.48 | 6.90 | 1.01% | placeAndApply | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:57483 |
| 21 | 33.70 | 6.74 | 0.99% | getBeatX | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:55577 |
| 22 | 33.35 | 6.67 | 0.98% | getBoundingBoxTop | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:64403 |
| 23 | 32.66 | 6.53 | 0.96% | calculateOverflows | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:55455 |
| 24 | 31.80 | 6.36 | 0.93% | paint | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:62517 |
| 25 | 31.42 | 6.28 | 0.92% | _splitAt | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53556 |
| 26 | 31.19 | 6.24 | 0.91% | paint | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53803 |
| 27 | 30.14 | 6.03 | 0.88% | _internalGetNoteY | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:62683 |
| 28 | 27.70 | 5.54 | 0.81% | paint | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:65204 |
| 29 | 27.52 | 5.50 | 0.81% | _emitGroupOverflows | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:55473 |
| 30 | 26.61 | 5.32 | 0.78% | getBoundingBoxTop | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:51634 |

## Heap top 30 (self-bytes, summed across 5 trials)
# total sampled across trials: 86228.5 kB

| # | Bytes (sum) | kB / trial | Self % | Function | File:line |
| ---: | ---: | ---: | ---: | --- | --- |
| 1 | 54210024 | 10587.90 | 61.39% | unionShifted3 | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53365 |
| 2 | 13375000 | 2612.30 | 15.15% | _raiseRange | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53534 |
| 3 | 5310680 | 1037.24 | 6.01% | buildBoundingsLookup | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:44723 |
| 4 | 2294728 | 448.19 | 2.60% | #onMessage | node:inspector:84 |
| 5 | 1278608 | 249.73 | 1.45% | finish | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:34091 |
| 6 | 799536 | 156.16 | 0.91% | set | <unknown>:0 |
| 7 | 783152 | 152.96 | 0.89% | _initBaseline | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53510 |
| 8 | 722696 | 141.15 | 0.82% | buildBoundingsLookup | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:55536 |
| 9 | 607184 | 118.59 | 0.69% | buildBoundingsLookup | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:58846 |
| 10 | 459752 | 89.80 | 0.52% | splice | <unknown>:0 |
| 11 | 410744 | 80.22 | 0.47% | GlyphGroup | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:51629 |
| 12 | 333336 | 65.10 | 0.38% | placeAndApply | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:57483 |
| 13 | 311744 | 60.89 | 0.35% | get effectPlacement | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:57736 |
| 14 | 296400 | 57.89 | 0.34% | _placeSide | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:57531 |
| 15 | 280064 | 54.70 | 0.32% | Map | <unknown>:0 |
| 16 | 279832 | 54.65 | 0.32% | addGlyph | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:51663 |
| 17 | 258792 | 50.55 | 0.29% | sort | <unknown>:0 |
| 18 | 235376 | 45.97 | 0.27% | addBeatSpring | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:57936 |
| 19 | 219528 | 42.88 | 0.25% | fillText | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:49919 |
| 20 | 214856 | 41.96 | 0.24% | next | <unknown>:0 |
| 21 | 214016 | 41.80 | 0.24% | addStaff | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:58620 |
| 22 | 213824 | 41.76 | 0.24% | createEmptyStaffSystem | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:59121 |
| 23 | 213120 | 41.63 | 0.24% | _scaleToForce | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53634 |
| 24 | 190840 | 37.27 | 0.22% | paint | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:44709 |
| 25 | 180688 | 35.29 | 0.20% | get systemSkyline | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:57740 |
| 26 | 180400 | 35.23 | 0.20% | Glyph | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:44539 |
| 27 | 163984 | 32.03 | 0.19% | (anonymous) | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:57457 |
| 28 | 159368 | 31.13 | 0.18% | _emitBeatContainerSkyline | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:53678 |
| 29 | 156472 | 30.56 | 0.18% | addMasterBarRenderers | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:58318 |
| 30 | 146600 | 28.63 | 0.17% | paintSimileMark | file:///home/daniel/dev/alphaTab2/packages/bench/dist/runOne.mjs:55606 |

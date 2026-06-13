# alphaTab bench report — svg-baseline

Generated: 2026-06-13T12:41:50.118Z

## Wall-clock summary

| Scenario | n | median | mean | p5 | p95 | min | max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tiny-render | 20 | 0.80 ms | 0.95 ms | 0.71 ms | 1.73 ms | 0.67 ms | 1.73 ms |
| nightwish-resize | 10 | 29.99 ms | 30.19 ms | 27.41 ms | 35.81 ms | 27.41 ms | 35.81 ms |
| nightwish-render | 10 | 24.54 ms | 23.02 ms | 17.69 ms | 27.49 ms | 17.69 ms | 27.49 ms |
| canon-resize | 8 | 145.16 ms | 145.28 ms | 133.09 ms | 172.30 ms | 133.09 ms | 172.30 ms |
| canon-render | 8 | 95.09 ms | 100.64 ms | 89.12 ms | 131.78 ms | 89.12 ms | 131.78 ms |
| fade-to-black-resize | 8 | 67.53 ms | 68.21 ms | 61.23 ms | 77.76 ms | 61.23 ms | 77.76 ms |

## Stage breakdown (Profiler)

### tiny-render

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| render.total | 20 | 18.78 | 938.96 | 1.71 |
| render.layoutAndRender | 20 | 18.38 | 919.18 | 1.68 |
| layout.doLayoutAndRender | 20 | 15.77 | 788.32 | 1.50 |
| layout.finalizeSystem | 20 | 1.52 | 75.80 | 0.14 |
| layout.finalizeStaff | 40 | 1.40 | 35.02 | 0.11 |

Heap delta: used 4489.0 kB, total 256.0 kB

### nightwish-resize

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| resize.total | 40 | 301.69 | 7542.36 | 10.91 |
| resize.layoutResize | 40 | 294.97 | 7374.16 | 10.79 |
| layout.doResize | 40 | 294.88 | 7372.02 | 10.78 |
| layout.finalizeSystem | 950 | 45.48 | 47.88 | 1.03 |
| layout.finalizeStaff | 950 | 43.91 | 46.22 | 1.03 |

Heap delta: used 25413.3 kB, total 40192.0 kB

### nightwish-render

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| render.total | 10 | 229.93 | 22992.58 | 27.42 |
| render.layoutAndRender | 10 | 228.14 | 22813.67 | 27.22 |
| layout.doLayoutAndRender | 10 | 226.89 | 22689.07 | 27.11 |
| layout.finalizeSystem | 200 | 19.40 | 96.98 | 0.23 |
| layout.finalizeStaff | 200 | 18.44 | 92.21 | 0.22 |

Heap delta: used 50802.6 kB, total 84736.0 kB

### canon-resize

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| resize.total | 32 | 1162.01 | 36312.81 | 47.74 |
| resize.layoutResize | 32 | 1134.14 | 35441.96 | 47.27 |
| layout.doResize | 32 | 1134.02 | 35438.05 | 47.27 |
| layout.finalizeSystem | 2800 | 128.10 | 45.75 | 0.63 |
| layout.finalizeStaff | 5600 | 122.30 | 21.84 | 0.59 |

Heap delta: used 124371.0 kB, total 72448.0 kB

### canon-render

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| render.total | 8 | 804.96 | 100619.97 | 131.75 |
| render.layoutAndRender | 8 | 799.92 | 99990.57 | 131.17 |
| layout.doLayoutAndRender | 8 | 799.09 | 99886.08 | 131.08 |
| layout.finalizeSystem | 576 | 47.14 | 81.84 | 0.85 |
| layout.finalizeStaff | 1152 | 44.97 | 39.03 | 0.83 |

Heap delta: used 168568.8 kB, total 120832.0 kB

### fade-to-black-resize

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| resize.total | 24 | 545.48 | 22728.50 | 30.71 |
| resize.layoutResize | 24 | 536.86 | 22369.14 | 30.25 |
| layout.doResize | 24 | 536.81 | 22366.99 | 30.25 |
| layout.finalizeSystem | 976 | 80.07 | 82.04 | 0.73 |
| layout.finalizeStaff | 1952 | 77.97 | 39.94 | 0.71 |

Heap delta: used 84525.1 kB, total 81408.0 kB

## CPU hotspots (top 15 self-time per scenario)

### tiny-render

Total sampled: 239.07 ms across 1,364 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 57.53 | 24.1% | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 15.95 | 6.7% | (garbage collector) | <native> |
| 7.45 | 3.1% | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 4.69 | 2.0% | decodeUTF8 | <native> |
| 4.24 | 1.8% | fillFromSmufl | packages/bench/dist/runOne.mjs:25398 |
| 2.54 | 1.1% | read | <native> |
| 2.52 | 1.1% | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 1.72 | 0.7% | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 1.61 | 0.7% | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 1.57 | 0.7% | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 1.51 | 0.6% | readBytes | packages/bench/dist/runOne.mjs:15961 |
| 1.41 | 0.6% | _addBytes | packages/bench/dist/runOne.mjs:16103 |
| 1.41 | 0.6% | createVoiceGlyphs | packages/bench/dist/runOne.mjs:53153 |
| 1.15 | 0.5% | parseXml | packages/bench/dist/runOne.mjs:19282 |
| 1.14 | 0.5% | finalizeStaff | packages/bench/dist/runOne.mjs:57601 |

### nightwish-resize

Total sampled: 730.93 ms across 4,468 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 72.60 | 9.9% | (garbage collector) | <native> |
| 46.74 | 6.4% | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 15.56 | 2.1% | unionShifted | packages/bench/dist/runOne.mjs:53290 |
| 5.60 | 0.8% | unionShifted | packages/bench/dist/runOne.mjs:53290 |
| 5.10 | 0.7% | createEmptyStaffSystem | packages/bench/dist/runOne.mjs:58948 |
| 5.09 | 0.7% | buildBoundingsLookup | packages/bench/dist/runOne.mjs:44722 |
| 4.89 | 0.7% | fillRect | packages/bench/dist/runOne.mjs:49855 |
| 4.89 | 0.7% | readSInt8 | packages/bench/dist/runOne.mjs:9767 |
| 4.70 | 0.6% | decodeUTF8 | <native> |
| 4.64 | 0.6% | scaleToWidth | packages/bench/dist/runOne.mjs:55146 |
| 3.96 | 0.5% | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 3.64 | 0.5% | paintStaffLines | packages/bench/dist/runOne.mjs:60947 |
| 3.48 | 0.5% | finish | packages/bench/dist/runOne.mjs:2937 |
| 3.44 | 0.5% | paint | packages/bench/dist/runOne.mjs:62350 |
| 3.28 | 0.4% | _paintEffects | packages/bench/dist/runOne.mjs:60007 |

### nightwish-render

Total sampled: 612.60 ms across 3,666 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 65.65 | 10.7% | (garbage collector) | <native> |
| 54.82 | 8.9% | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 7.01 | 1.1% | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 5.25 | 0.9% | unionShifted | packages/bench/dist/runOne.mjs:53290 |
| 4.85 | 0.8% | decodeUTF8 | <native> |
| 4.29 | 0.7% | createVoiceGlyphs | packages/bench/dist/runOne.mjs:53153 |
| 4.05 | 0.7% | doLayout | packages/bench/dist/runOne.mjs:64216 |
| 3.79 | 0.6% | readBeat | packages/bench/dist/runOne.mjs:18066 |
| 3.48 | 0.6% | fillFromSmufl | packages/bench/dist/runOne.mjs:25398 |
| 3.32 | 0.5% | _createStaffSystem | packages/bench/dist/runOne.mjs:59491 |
| 3.04 | 0.5% | buildBoundingsLookup | packages/bench/dist/runOne.mjs:44722 |
| 3.02 | 0.5% | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 2.94 | 0.5% | finish | packages/bench/dist/runOne.mjs:2937 |
| 2.92 | 0.5% | doLayout | packages/bench/dist/runOne.mjs:53722 |
| 2.64 | 0.4% | placeAndApply | packages/bench/dist/runOne.mjs:57306 |

### canon-resize

Total sampled: 2423.43 ms across 14,919 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 215.32 | 8.9% | (garbage collector) | <native> |
| 56.51 | 2.3% | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 48.29 | 2.0% | unionShifted | packages/bench/dist/runOne.mjs:53290 |
| 29.63 | 1.2% | buildBoundingsLookup | packages/bench/dist/runOne.mjs:44722 |
| 28.50 | 1.2% | fillRect | packages/bench/dist/runOne.mjs:49855 |
| 22.93 | 0.9% | fillRect | packages/bench/dist/runOne.mjs:49855 |
| 16.59 | 0.7% | placeAndApply | packages/bench/dist/runOne.mjs:57306 |
| 16.31 | 0.7% | paintStaffLines | packages/bench/dist/runOne.mjs:60947 |
| 15.10 | 0.6% | paintBar | packages/bench/dist/runOne.mjs:61227 |
| 14.97 | 0.6% | collectSpaces | packages/bench/dist/runOne.mjs:65847 |
| 14.60 | 0.6% | collectSpaces | packages/bench/dist/runOne.mjs:65847 |
| 14.50 | 0.6% | fillRect | packages/bench/dist/runOne.mjs:49855 |
| 13.34 | 0.6% | paintBackground | packages/bench/dist/runOne.mjs:60942 |
| 12.65 | 0.5% | registerLayoutingInfo | packages/bench/dist/runOne.mjs:53567 |
| 12.40 | 0.5% | paintStaffLines | packages/bench/dist/runOne.mjs:60947 |

### canon-render

Total sampled: 1512.02 ms across 9,289 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 204.15 | 13.5% | (garbage collector) | <native> |
| 36.34 | 2.4% | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 19.46 | 1.3% | paintStaffLines | packages/bench/dist/runOne.mjs:60947 |
| 19.10 | 1.3% | fillRect | packages/bench/dist/runOne.mjs:49855 |
| 18.70 | 1.2% | unionShifted | packages/bench/dist/runOne.mjs:53290 |
| 11.11 | 0.7% | initialize | packages/bench/dist/runOne.mjs:54719 |
| 9.82 | 0.6% | paintBar | packages/bench/dist/runOne.mjs:61227 |
| 8.39 | 0.6% | createVoiceGlyphs | packages/bench/dist/runOne.mjs:53153 |
| 8.37 | 0.6% | collectSpaces | packages/bench/dist/runOne.mjs:65847 |
| 7.61 | 0.5% | buildBoundingsLookup | packages/bench/dist/runOne.mjs:44722 |
| 6.99 | 0.5% | placeAndApply | packages/bench/dist/runOne.mjs:57306 |
| 6.96 | 0.5% | _paintLedgerLines | packages/bench/dist/runOne.mjs:62362 |
| 6.86 | 0.5% | createVoiceGlyphs | packages/bench/dist/runOne.mjs:64522 |
| 6.60 | 0.4% | paint | packages/bench/dist/runOne.mjs:44708 |
| 6.45 | 0.4% | fillText | packages/bench/dist/runOne.mjs:49918 |

### fade-to-black-resize

Total sampled: 1272.19 ms across 7,878 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 124.69 | 9.8% | (garbage collector) | <native> |
| 61.01 | 4.8% | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 26.94 | 2.1% | unionShifted | packages/bench/dist/runOne.mjs:53290 |
| 19.32 | 1.5% | paintStaffLines | packages/bench/dist/runOne.mjs:60947 |
| 18.60 | 1.5% | fillRect | packages/bench/dist/runOne.mjs:49855 |
| 9.55 | 0.8% | registerLayoutingInfo | packages/bench/dist/runOne.mjs:53567 |
| 9.42 | 0.7% | collectSpaces | packages/bench/dist/runOne.mjs:65847 |
| 8.84 | 0.7% | buildBoundingsLookup | packages/bench/dist/runOne.mjs:44722 |
| 8.17 | 0.6% | unionShifted | packages/bench/dist/runOne.mjs:53290 |
| 7.61 | 0.6% | paintBar | packages/bench/dist/runOne.mjs:61227 |
| 7.15 | 0.6% | _usingCtx | packages/bench/dist/runOne.mjs:49554 |
| 6.73 | 0.5% | paintContent | packages/bench/dist/runOne.mjs:55380 |
| 6.71 | 0.5% | placeAndApply | packages/bench/dist/runOne.mjs:57306 |
| 6.66 | 0.5% | fillRect | packages/bench/dist/runOne.mjs:49855 |
| 6.62 | 0.5% | (anonymous) | packages/bench/dist/runOne.mjs:1 |

## Heap allocation hotspots (top 15 bytes per scenario)

### tiny-render

Total sampled: 5037.9 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 1828.6 | 0 | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 774.8 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 240.3 | 0 | EngravingSettings | packages/bench/dist/runOne.mjs:25192 |
| 148.6 | 0 | #asyncInstantiate | node:internal/modules/esm/module_job:304 |
| 98.3 | 0 | set | <native> |
| 97.8 | 0 | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 51.3 | 0 | (anonymous) | node:internal/readline/interface:1 |
| 48.2 | 0 | filter | <native> |
| 48.2 | 0 | Set | <native> |
| 48.1 | 0 | Found | packages/bench/dist/runOne.mjs:15646 |
| 34.8 | 0 | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 32.4 | 0 | finish | packages/bench/dist/runOne.mjs:34175 |
| 32.2 | 0 | Set | <native> |
| 32.1 | 0 | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 32.1 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:5479 |

### nightwish-resize

Total sampled: 6295.0 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 2053.1 | 0 | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 885.7 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 180.7 | 0 | #asyncInstantiate | node:internal/modules/esm/module_job:304 |
| 98.3 | 0 | set | <native> |
| 80.1 | 0 | EngravingSettings | packages/bench/dist/runOne.mjs:25192 |
| 71.0 | 0 | fillFromSmufl | packages/bench/dist/runOne.mjs:25398 |
| 64.5 | 0 | Set | <native> |
| 51.5 | 0 | next | <native> |
| 48.3 | 0 | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 48.1 | 0 | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 40.1 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:4646 |
| 36.9 | 0 | lineTo | packages/bench/dist/runOne.mjs:49871 |
| 33.9 | 0 | paintBar | packages/bench/dist/runOne.mjs:61227 |
| 33.8 | 0 | ensureBeamDrawingInfo | packages/bench/dist/runOne.mjs:61414 |
| 33.3 | 0 | doLayout | packages/bench/dist/runOne.mjs:53722 |

### nightwish-render

Total sampled: 5883.4 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 1826.1 | 0 | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 760.6 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 164.6 | 0 | #asyncInstantiate | node:internal/modules/esm/module_job:304 |
| 128.4 | 0 | EngravingSettings | packages/bench/dist/runOne.mjs:25192 |
| 105.3 | 0 | Map | <native> |
| 64.6 | 0 | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 64.5 | 0 | Set | <native> |
| 64.2 | 0 | doLayout | packages/bench/dist/runOne.mjs:53722 |
| 64.1 | 0 | createVoiceGlyphs | packages/bench/dist/runOne.mjs:53153 |
| 50.8 | 0 | Spring | packages/bench/dist/runOne.mjs:57634 |
| 48.3 | 0 | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 48.1 | 0 | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 42.1 | 0 | set | <native> |
| 40.1 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:4646 |
| 38.9 | 0 | fillFromSmufl | packages/bench/dist/runOne.mjs:25398 |

### canon-resize

Total sampled: 27552.6 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 3837.7 | 0 | readBeat | packages/bench/dist/runOne.mjs:18066 |
| 3599.4 | 0 | readNote | packages/bench/dist/runOne.mjs:18388 |
| 2342.3 | 0 | readBeat | packages/bench/dist/runOne.mjs:18066 |
| 2181.8 | 0 | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 1928.0 | 0 | Map | <native> |
| 1862.6 | 0 | readNote | packages/bench/dist/runOne.mjs:18388 |
| 1108.3 | 0 | Map | <native> |
| 674.2 | 0 | readVoice | packages/bench/dist/runOne.mjs:18058 |
| 537.3 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 513.9 | 0 | Map | <native> |
| 497.9 | 0 | Map | <native> |
| 400.5 | 0 | finishTuplet | packages/bench/dist/runOne.mjs:7375 |
| 307.3 | 0 | set | <native> |
| 304.9 | 0 | readVoice | packages/bench/dist/runOne.mjs:18058 |
| 224.1 | 0 | Note | packages/bench/dist/runOne.mjs:5571 |

### canon-render

Total sampled: 27360.5 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 4733.5 | 0 | readBeat | packages/bench/dist/runOne.mjs:18066 |
| 4165.2 | 0 | readNote | packages/bench/dist/runOne.mjs:18388 |
| 2377.6 | 0 | Map | <native> |
| 2040.9 | 0 | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 1658.9 | 0 | readBeat | packages/bench/dist/runOne.mjs:18066 |
| 1248.0 | 0 | readNote | packages/bench/dist/runOne.mjs:18388 |
| 867.5 | 0 | Map | <native> |
| 689.9 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 642.2 | 0 | readVoice | packages/bench/dist/runOne.mjs:18058 |
| 449.6 | 0 | Map | <native> |
| 416.5 | 0 | finishTuplet | packages/bench/dist/runOne.mjs:7375 |
| 401.4 | 0 | Map | <native> |
| 336.2 | 0 | Note | packages/bench/dist/runOne.mjs:5571 |
| 307.6 | 0 | readBar | packages/bench/dist/runOne.mjs:18036 |
| 259.1 | 0 | set | <native> |

### fade-to-black-resize

Total sampled: 23472.2 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 4880.2 | 0 | readNote | packages/bench/dist/runOne.mjs:18388 |
| 4441.1 | 0 | readBeat | packages/bench/dist/runOne.mjs:18066 |
| 1812.0 | 0 | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 1397.8 | 0 | Map | <native> |
| 995.8 | 0 | Map | <native> |
| 597.4 | 0 | readBar | packages/bench/dist/runOne.mjs:18036 |
| 515.0 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 370.1 | 0 | finish | packages/bench/dist/runOne.mjs:2106 |
| 369.8 | 0 | addNote | packages/bench/dist/runOne.mjs:7312 |
| 369.4 | 0 | readVoice | packages/bench/dist/runOne.mjs:18058 |
| 288.4 | 0 | finishTuplet | packages/bench/dist/runOne.mjs:7375 |
| 275.6 | 0 | readNote | packages/bench/dist/runOne.mjs:18388 |
| 244.0 | 0 | readBeat | packages/bench/dist/runOne.mjs:18066 |
| 208.8 | 0 | Map | <native> |
| 208.2 | 0 | Beat | packages/bench/dist/runOne.mjs:6840 |

# alphaTab bench report — initial-baseline

Generated: 2026-06-13T12:01:29.553Z

## Wall-clock summary

| Scenario | n | median | mean | p5 | p95 | min | max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tiny-render | 20 | 2.02 ms | 2.19 ms | 1.85 ms | 3.22 ms | 1.79 ms | 3.22 ms |
| nightwish-resize | 10 | 102.11 ms | 110.15 ms | 97.37 ms | 139.46 ms | 97.37 ms | 139.46 ms |
| nightwish-render | 10 | 46.62 ms | 44.60 ms | 37.81 ms | 49.28 ms | 37.81 ms | 49.28 ms |
| canon-resize | 8 | 553.94 ms | 546.61 ms | 523.79 ms | 567.06 ms | 523.79 ms | 567.06 ms |
| canon-render | 8 | 230.74 ms | 228.41 ms | 213.80 ms | 246.83 ms | 213.80 ms | 246.83 ms |
| fade-to-black-resize | 8 | 225.25 ms | 227.57 ms | 211.65 ms | 250.72 ms | 211.65 ms | 250.72 ms |

## Stage breakdown (Profiler)

### tiny-render

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| render.total | 20 | 43.58 | 2178.99 | 3.21 |
| render.layoutAndRender | 20 | 43.05 | 2152.61 | 3.17 |
| layout.doLayoutAndRender | 20 | 37.84 | 1892.14 | 2.91 |
| layout.finalizeSystem | 20 | 1.62 | 80.99 | 0.17 |
| layout.finalizeStaff | 40 | 1.51 | 37.67 | 0.14 |

Heap delta: used 4388.9 kB, total 768.0 kB

### nightwish-resize

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| resize.total | 40 | 1101.23 | 27530.82 | 47.61 |
| resize.layoutResize | 40 | 1096.16 | 27404.05 | 47.40 |
| layout.doResize | 40 | 1096.05 | 27401.17 | 47.40 |
| layout.finalizeSystem | 880 | 60.07 | 68.26 | 1.38 |
| layout.finalizeStaff | 880 | 57.97 | 65.88 | 1.37 |

Heap delta: used 11143.8 kB, total 2048.0 kB

### nightwish-render

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| render.total | 10 | 445.85 | 44585.11 | 49.27 |
| render.layoutAndRender | 10 | 443.94 | 44394.21 | 49.10 |
| layout.doLayoutAndRender | 10 | 440.96 | 44096.01 | 48.88 |
| layout.finalizeSystem | 180 | 20.89 | 116.07 | 0.47 |
| layout.finalizeStaff | 180 | 19.90 | 110.57 | 0.46 |

Heap delta: used 45426.0 kB, total 84992.0 kB

### canon-resize

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| resize.total | 32 | 4372.66 | 136645.75 | 174.03 |
| resize.layoutResize | 32 | 4350.45 | 135951.71 | 173.47 |
| layout.doResize | 32 | 4350.35 | 135948.54 | 173.46 |
| layout.finalizeSystem | 2408 | 162.87 | 67.64 | 0.54 |
| layout.finalizeStaff | 4816 | 155.74 | 32.34 | 0.49 |

Heap delta: used 73208.0 kB, total 55040.0 kB

### canon-render

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| render.total | 8 | 1827.13 | 228391.32 | 246.82 |
| render.layoutAndRender | 8 | 1821.92 | 227740.62 | 246.06 |
| layout.doLayoutAndRender | 8 | 1820.18 | 227522.81 | 245.85 |
| layout.finalizeSystem | 480 | 75.69 | 157.68 | 13.92 |
| layout.finalizeStaff | 960 | 73.16 | 76.21 | 13.70 |

Heap delta: used 165337.0 kB, total 113664.0 kB

### fade-to-black-resize

| Stage | calls | total ms | mean us | max ms |
| --- | --- | --- | --- | --- |
| resize.total | 24 | 1820.33 | 75846.96 | 88.13 |
| resize.layoutResize | 24 | 1812.22 | 75509.33 | 87.71 |
| layout.doResize | 24 | 1812.14 | 75505.75 | 87.70 |
| layout.finalizeSystem | 800 | 92.79 | 115.99 | 5.33 |
| layout.finalizeStaff | 1600 | 89.81 | 56.13 | 5.23 |

Heap delta: used 64642.7 kB, total 77568.0 kB

## CPU hotspots (top 15 self-time per scenario)

### tiny-render

Total sampled: 295.02 ms across 1,663 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 54.77 | 18.6% | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 14.19 | 4.8% | (garbage collector) | <native> |
| 11.39 | 3.9% | switchToFreeTypeFonts | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:345 |
| 7.24 | 2.5% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 7.20 | 2.4% | read | <native> |
| 6.63 | 2.2% | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 6.57 | 2.2% | register | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:672 |
| 4.41 | 1.5% | decodeUTF8 | <native> |
| 3.34 | 1.1% | dlopen | <native> |
| 2.94 | 1.0% | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 2.68 | 0.9% | fillRect | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:446 |
| 2.54 | 0.9% | beginRender | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:408 |
| 2.53 | 0.9% | read | <native> |
| 2.51 | 0.9% | measureText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:583 |
| 2.37 | 0.8% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |

### nightwish-resize

Total sampled: 1958.20 ms across 12,109 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 62.43 | 3.2% | (garbage collector) | <native> |
| 56.29 | 2.9% | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 50.08 | 2.6% | beginRender | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:408 |
| 45.66 | 2.3% | fillText | packages/bench/dist/runOne.mjs:49750 |
| 37.99 | 1.9% | beginRender | packages/bench/dist/runOne.mjs:49681 |
| 34.15 | 1.7% | beginRender | packages/bench/dist/runOne.mjs:49681 |
| 31.98 | 1.6% | paintExtended | packages/bench/dist/runOne.mjs:59612 |
| 30.55 | 1.6% | paintTie | packages/bench/dist/runOne.mjs:53993 |
| 26.13 | 1.3% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 25.89 | 1.3% | paintStaffLines | packages/bench/dist/runOne.mjs:60948 |
| 25.79 | 1.3% | measureText | packages/bench/dist/runOne.mjs:49781 |
| 25.22 | 1.3% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 21.61 | 1.1% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 21.52 | 1.1% | paintStaffLines | packages/bench/dist/runOne.mjs:60948 |
| 21.14 | 1.1% | fillText | packages/bench/dist/runOne.mjs:49750 |

### nightwish-render

Total sampled: 938.83 ms across 5,723 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 62.30 | 6.6% | (garbage collector) | <native> |
| 58.66 | 6.2% | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 25.11 | 2.7% | beginRender | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:408 |
| 18.16 | 1.9% | measureText | packages/bench/dist/runOne.mjs:49781 |
| 14.91 | 1.6% | _fillMusicFontSymbolText | packages/bench/dist/runOne.mjs:49811 |
| 12.26 | 1.3% | _fillMusicFontSymbolText | packages/bench/dist/runOne.mjs:49811 |
| 11.69 | 1.2% | fillRect | packages/bench/dist/runOne.mjs:49709 |
| 11.18 | 1.2% | switchToFreeTypeFonts | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:345 |
| 10.40 | 1.1% | _fillMusicFontSymbolText | packages/bench/dist/runOne.mjs:49811 |
| 9.79 | 1.0% | paintExtended | packages/bench/dist/runOne.mjs:59612 |
| 8.94 | 1.0% | read | <native> |
| 7.55 | 0.8% | measureText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:583 |
| 7.46 | 0.8% | register | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:672 |
| 7.45 | 0.8% | unionShifted | packages/bench/dist/runOne.mjs:53291 |
| 6.68 | 0.7% | (anonymous) | packages/bench/dist/runOne.mjs:1 |

### canon-resize

Total sampled: 7082.41 ms across 43,605 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 319.48 | 4.5% | fillRect | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:446 |
| 270.38 | 3.8% | beginRender | packages/bench/dist/runOne.mjs:49681 |
| 244.41 | 3.5% | fillRect | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:446 |
| 215.44 | 3.0% | paintExtended | packages/bench/dist/runOne.mjs:59612 |
| 198.38 | 2.8% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 173.47 | 2.4% | (garbage collector) | <native> |
| 161.51 | 2.3% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 158.12 | 2.2% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 136.49 | 1.9% | paintStaffLines | packages/bench/dist/runOne.mjs:60948 |
| 106.53 | 1.5% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 91.83 | 1.3% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 88.72 | 1.3% | paintPartial | packages/bench/dist/runOne.mjs:58498 |
| 85.88 | 1.2% | fillRect | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:446 |
| 85.16 | 1.2% | fill | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:547 |
| 79.73 | 1.1% | fillRect | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:446 |

### canon-render

Total sampled: 3111.91 ms across 19,285 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 192.29 | 6.2% | (garbage collector) | <native> |
| 161.48 | 5.2% | paintExtended | packages/bench/dist/runOne.mjs:59612 |
| 97.10 | 3.1% | paintStaffLines | packages/bench/dist/runOne.mjs:60948 |
| 93.73 | 3.0% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 55.10 | 1.8% | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 53.84 | 1.7% | beginRender | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:408 |
| 45.34 | 1.5% | measureText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:583 |
| 41.22 | 1.3% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 38.24 | 1.2% | measureText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:583 |
| 31.87 | 1.0% | measureText | packages/bench/dist/runOne.mjs:49781 |
| 31.68 | 1.0% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 31.36 | 1.0% | measureText | packages/bench/dist/runOne.mjs:49781 |
| 30.01 | 1.0% | measureText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:583 |
| 27.60 | 0.9% | measureText | packages/bench/dist/runOne.mjs:49781 |
| 25.33 | 0.8% | fill | packages/bench/dist/runOne.mjs:49740 |

### fade-to-black-resize

Total sampled: 3141.91 ms across 19,797 samples.

| Self ms | Self % | Function | File:line |
| ---: | ---: | --- | --- |
| 194.77 | 6.2% | paintExtended | packages/bench/dist/runOne.mjs:59612 |
| 109.67 | 3.5% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 109.14 | 3.5% | (garbage collector) | <native> |
| 100.77 | 3.2% | paintStaffLines | packages/bench/dist/runOne.mjs:60948 |
| 79.62 | 2.5% | fillRect | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:446 |
| 67.26 | 2.1% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 65.41 | 2.1% | fillRect | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:446 |
| 51.76 | 1.6% | beginRender | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:408 |
| 49.32 | 1.6% | fillRect | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:446 |
| 45.12 | 1.4% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 40.20 | 1.3% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 38.95 | 1.2% | beginRender | packages/bench/dist/runOne.mjs:49681 |
| 37.83 | 1.2% | paintTie | packages/bench/dist/runOne.mjs:53993 |
| 37.67 | 1.2% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |
| 36.29 | 1.2% | fillText | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:569 |

## Heap allocation hotspots (top 15 bytes per scenario)

### tiny-render

Total sampled: 5194.1 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 1875.6 | 0 | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 531.6 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 112.1 | 0 | EngravingSettings | packages/bench/dist/runOne.mjs:25193 |
| 105.1 | 0 | #asyncInstantiate | node:internal/modules/esm/module_job:304 |
| 82.7 | 0 | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 64.2 | 0 | internalBinding | node:internal/bootstrap/realm:182 |
| 49.8 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:4647 |
| 48.1 | 0 | fillFromSmufl | packages/bench/dist/runOne.mjs:25399 |
| 46.2 | 0 | exec | <native> |
| 44.1 | 0 | (anonymous) | node:internal/streams/readable:1 |
| 43.1 | 0 | decode | node:internal/encoding:482 |
| 42.1 | 0 | set | <native> |
| 35.4 | 0 | set | <native> |
| 34.2 | 0 | (anonymous) | node:internal/streams/writable:1 |
| 33.7 | 0 | compileForInternalLoader | node:internal/bootstrap/realm:383 |

### nightwish-resize

Total sampled: 6540.6 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 2070.9 | 0 | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 580.0 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 192.1 | 0 | #asyncInstantiate | node:internal/modules/esm/module_job:304 |
| 99.3 | 0 | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 97.3 | 0 | EngravingSettings | packages/bench/dist/runOne.mjs:25193 |
| 80.1 | 0 | fillFromSmufl | packages/bench/dist/runOne.mjs:25399 |
| 73.1 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:59454 |
| 68.4 | 0 | set | <native> |
| 64.2 | 0 | createVoiceGlyphs | packages/bench/dist/runOne.mjs:53154 |
| 55.1 | 0 | sort | <native> |
| 52.7 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:4647 |
| 52.5 | 0 | get barLineBarSubElement | packages/bench/dist/runOne.mjs:64352 |
| 51.3 | 0 | get bravuraDefaults | packages/bench/dist/runOne.mjs:25201 |
| 50.4 | 0 | set color | packages/bench/dist/runOne.mjs:49697 |
| 49.0 | 0 | next | <native> |

### nightwish-render

Total sampled: 6236.4 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 1973.7 | 0 | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 692.8 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 116.6 | 0 | #asyncInstantiate | node:internal/modules/esm/module_job:304 |
| 114.1 | 0 | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 100.9 | 0 | EngravingSettings | packages/bench/dist/runOne.mjs:25193 |
| 73.4 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:59454 |
| 70.9 | 0 | fillFromSmufl | packages/bench/dist/runOne.mjs:25399 |
| 54.0 | 0 | finish | packages/bench/dist/runOne.mjs:7394 |
| 49.8 | 0 | compileForInternalLoader | node:internal/bootstrap/realm:383 |
| 48.9 | 0 | internalBinding | node:internal/bootstrap/realm:182 |
| 48.3 | 0 | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 48.0 | 0 | MidiFileGenerator | packages/bench/dist/runOne.mjs:43065 |
| 46.2 | 0 | exec | <native> |
| 42.1 | 0 | set | <native> |
| 35.2 | 0 | AlphaSkiaTextMetrics | /home/daniel/dev/alphaTab2/node_modules/@coderline/alphaskia/dist/alphaskia.mjs:311 |

### canon-resize

Total sampled: 26759.8 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 4394.3 | 0 | readNote | packages/bench/dist/runOne.mjs:18389 |
| 4294.5 | 0 | readBeat | packages/bench/dist/runOne.mjs:18067 |
| 2113.2 | 0 | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 1879.9 | 0 | Map | <native> |
| 1479.9 | 0 | readBeat | packages/bench/dist/runOne.mjs:18067 |
| 1134.1 | 0 | readNote | packages/bench/dist/runOne.mjs:18389 |
| 883.9 | 0 | Map | <native> |
| 712.0 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 546.1 | 0 | Map | <native> |
| 497.9 | 0 | Map | <native> |
| 417.4 | 0 | readVoice | packages/bench/dist/runOne.mjs:18059 |
| 400.5 | 0 | finishTuplet | packages/bench/dist/runOne.mjs:7376 |
| 386.4 | 0 | readBar | packages/bench/dist/runOne.mjs:18037 |
| 368.2 | 0 | Note | packages/bench/dist/runOne.mjs:5572 |
| 289.1 | 0 | finish | packages/bench/dist/runOne.mjs:2107 |

### canon-render

Total sampled: 28072.5 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 4587.2 | 0 | readNote | packages/bench/dist/runOne.mjs:18389 |
| 4373.6 | 0 | readBeat | packages/bench/dist/runOne.mjs:18067 |
| 2265.7 | 0 | Map | <native> |
| 2147.1 | 0 | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 1528.1 | 0 | readBeat | packages/bench/dist/runOne.mjs:18067 |
| 1118.0 | 0 | readNote | packages/bench/dist/runOne.mjs:18389 |
| 915.5 | 0 | Map | <native> |
| 772.3 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 722.7 | 0 | Map | <native> |
| 546.3 | 0 | readVoice | packages/bench/dist/runOne.mjs:18059 |
| 418.6 | 0 | readBar | packages/bench/dist/runOne.mjs:18037 |
| 368.6 | 0 | finishTuplet | packages/bench/dist/runOne.mjs:7376 |
| 305.5 | 0 | Map | <native> |
| 288.1 | 0 | Note | packages/bench/dist/runOne.mjs:5572 |
| 259.0 | 0 | set | <native> |

### fade-to-black-resize

Total sampled: 24673.7 kB.

| Bytes | Count | Function | File:line |
| ---: | ---: | --- | --- |
| 4784.7 | 0 | readNote | packages/bench/dist/runOne.mjs:18389 |
| 4245.9 | 0 | readBeat | packages/bench/dist/runOne.mjs:18067 |
| 2120.9 | 0 | compileSourceTextModule | node:internal/modules/esm/utils:316 |
| 1943.2 | 0 | Map | <native> |
| 835.8 | 0 | (anonymous) | packages/bench/dist/runOne.mjs:1 |
| 707.1 | 0 | Map | <native> |
| 578.4 | 0 | readVoice | packages/bench/dist/runOne.mjs:18059 |
| 499.3 | 0 | readBar | packages/bench/dist/runOne.mjs:18037 |
| 418.0 | 0 | addNote | packages/bench/dist/runOne.mjs:7313 |
| 304.4 | 0 | finishTuplet | packages/bench/dist/runOne.mjs:7376 |
| 274.9 | 0 | set | <native> |
| 257.1 | 0 | Map | <native> |
| 240.9 | 0 | finish | packages/bench/dist/runOne.mjs:2107 |
| 224.1 | 0 | Note | packages/bench/dist/runOne.mjs:5572 |
| 208.2 | 0 | Beat | packages/bench/dist/runOne.mjs:6841 |

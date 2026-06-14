# EW-10 — `SvgCanvas.fillRect` — surgical caller-aware plan

**Status**: planning round, not started.
**Target HEAD**: `feature/perf` `be8b724b` (DR-1 broker-lifecycle landed).
**Scenario**: `canon-resize-drag` (DR-1 final median **217.80 ± 1.34 ms** per `baselines/DR1-final.json`).
**Author rule**: this is *not* an easy win in the original HOTSPOTS framing. The plan exists because the user flagged three correctness risks the HOTSPOTS entry waved past — subpixel rasteriser variance, `beginGroup`/`endGroup` element identity, and z-order. Section §4 is the structural backbone. If you arrive here looking for "buffer the rects, flush in `endRender`", that shape is wrong for most call sites; §4 explains which subset it is right for.

---

## 1. Goal & framing

### 1.1 Plain-English statement

`SvgCanvas.fillRect` (`packages/alphatab/src/platform/svg/SvgCanvas.ts:52`) appends one `<rect …/>` element per call to the canvas buffer using a template-literal interpolation that does five number-to-string conversions (4 coordinate multiplies × scale, 1 color lookup), then concatenates ~120 bytes to a growing string. On `canon-resize-drag` it is the single hottest self-time frame in the post-DR-1 profile at **~19.6 ms / iter, 8.5 % of measured CPU** (see §2). That ms-share is the highest in the entire profile after garbage-collect overhead.

The HOTSPOTS.md EW-10 entry suggested "batched-fillRect typed buffer, defer string serialisation, keep `<rect>` kind, 2-4 ms estimated". That framing is wrong for most call sites:

- Some rects are emitted inside `beginGroup`/`endGroup` blocks that carry element-level identity (used by callers for hover/highlight handlers); moving them to a deferred batch loses identity.
- Many rects render *before* note glyphs and rely on document-order for z-stack (staff lines under noteheads, NOT over them). A buffer flushed at `endRender` is at the wrong document-order position.
- SVG rasterisers do not necessarily render `<rect>` and `<path>` identically at fractional coordinates. EW-5's `<path>`-batch attempt regressed for this reason. Any alternative to `<rect>` carries the same rasteriser-physics risk.

### 1.2 The design question this plan answers

> Of the ~10k+ `fillRect` calls per iter on `canon-resize-drag`, what is the largest subset that is **(a) safe to batch** (no group identity, no z-order pin, no fractional-coordinate rasteriser concern) AND **(b) emits enough volume from a single caller** that batching it crosses ≥ 2σ (≥ 2.7 ms) on the canon-resize-drag A/B?

Sub-question: before answering "what to batch", check whether the simpler alternative — intra-function tweaks to `fillRect`'s body — can alone clear σ. If it can, ship that instead. (§5.)

### 1.3 What "easy win" really means for this candidate

- It is **single-file scope only** for §5 intra-function tweaks. If the executor lands §5 alone and clears σ, EW-10 stays under "Easy wins — landed".
- It is **multi-file scope** for §6/§7 batching: the SvgCanvas gains a new `fillRectBatched` opt-in API, and one or two callers migrate. That crosses the EW boundary. If batching is the landed form, EW-10 moves to "Major refactors — landed" per the DR-1 plan §12.4 precedent.
- Either way, the plan output is **phased**: §5 first, §6/§7 only if §5 falls short. Falling out of any phase = stop and land what's already landed.

### 1.4 Numerical envelope (post-DR-1)

| Quantity | Value | Source |
|---|---:|---|
| `canon-resize-drag` median (DR-1 final, 5-trial multi-process) | 217.80 ms | `baselines/DR1-final.json` |
| Cross-trial σ | ±1.34 ms (0.6 %) | same |
| 2σ ≈ `★` resolution floor | ≈ **2.7 ms** | derived |
| `SvgCanvas.fillRect` self-time post-DR-1 | **19.57 ms / iter (8.47 %)** | `runs/EW10-postDR1/canon-resize-drag` aggregated top-30 (§2) |
| `paintStaffLines` self-time (parent frame, holds most fillRect callers) | 4.07 ms / iter (1.76 %) | same |
| `paintBar` (holds beam fillRect callers) | 5.63 ms / iter (2.43 %) | same |
| `paintBackground` (holds paintStaffLines + paintSimileMark) | 5.12 ms / iter (2.22 %) | same |

### 1.5 Worst-case failure modes (the three the user flagged)

These are the structural backbone of §4 safety classification. They are not hypothetical; each has a real source-line pin.

1. **Subpixel rasteriser variance** (Class **C**). At fractional `x*scale + ε` coordinates, SVG renderers (browser SVG, librsvg, Chrome/Firefox/Safari, Inkscape, headless test harnesses) **do not necessarily render `<rect>` and `<path>` identically**. EW-5 demoted rectangular `<path>` per-bar batching for this reason. Any rect whose coordinates land at non-integer values after `* scale` is fragile to anything that changes the emission shape. In `BarLineGlyph.BarLineDottedGlyph` and the float-arithmetic in `LineRangedGlyph` the coords are explicitly fractional (`lineWidth / 2`, `dashSize/2 + dashThickness/2`, etc).

2. **`beginGroup`/`endGroup` element identity** (Class **G**). `BeatContainerGlyph.paint:313-326` wraps the entire beat (preNotes + onNotes + ties) in `canvas.beginGroup(BeatContainerGlyph.getGroupId(this.beat))` / `canvas.endGroup()`. The group's class attribute is the hook for user-side hover/highlight handlers (the user explicitly named note stems). Every fillRect emitted inside a beat-container subtree must stay in document order at that group's emission point — it cannot be hoisted to a global deferred batch.

   `BarRendererBase.paintSimileMark:985-1010` also wraps with `beginGroup`/`endGroup` (Simile/SecondOfDouble marks), but those use `fillMusicFontSymbolSafe`, not `fillRect`.

3. **Z-order / layering** (Class **Z**). `BarRendererBase.paintContent:817-827` emits in this fixed order:
   1. `paintBackground` (LineBarRenderer override at :118-129: `paintStaffLines` + `paintSimileMark`)
   2. `_preBeatGlyphs.paint` (clef, key sig, time sig, etc.)
   3. `voiceContainer.paint` (noteheads, stems, ledger lines, ties — wrapped in BeatContainer groups)
   4. `_postBeatGlyphs.paint`
   5. multi-system slurs
   6. `topEffects` / `bottomEffects` paint (effect bands, sustain pedal, line-ranged)

   **Staff lines render FIRST, before noteheads.** If `paintStaffLines`'s fillRect calls were moved to a deferred batch flushed in `endRender`, they would render *after* every note glyph in the system — striking through noteheads. The user named this exact failure mode.

   Same z-pin applies to: `BarLineGlyph` (drawn from `_postBeatGlyphs` in some bar styles), accolade/bracket bar in `StaffSystem._paintBrackets:1059-1064` (renders before per-staff content of next system in some layouts).

### 1.6 What this plan deliberately is NOT

- **Not** "fix all of fillRect with one buffer". Don't generalize to all callers — the user was explicit. Inventory first (§3), classify (§4), then surgically target only Class **S** callers.
- **Not** a rewrite of `SvgCanvas` element emission. EW-5 already validated that rasteriser-physics constraints limit the structural-rewrite shape.
- **Not** EW-3 (`collectSpaces`) territory. EW-3 was demoted (+11.7 % regression) and is unrelated.

---

## 2. Fresh post-DR-1 profile (single trial)

Captured per the user's instructions:

```
cd packages/bench
node dist/run.mjs --only canon-resize-drag --trials 1 --label EW10-postDR1
node scripts/aggregate-top30.mjs runs/EW10-postDR1/canon-resize-drag   # NOTE: single-trial layout
```

Note: the single-trial harness writes artifacts directly under the scenario dir (no `trial-N` subdirs). The `aggregate-top30.mjs` script expects `trial-N/`. For single-trial profiles, aggregate the `cpu.cpuprofile` directly with the inline script in `runs/EW10-postDR1/REPORT.md` data, OR re-run `--trials 5` if you need the multi-trial aggregate. Below is the inline-aggregated top-30 used for this plan.

### 2.1 Wall-clock summary

- 8 iterations, median **216.66 ± 4.68 ms (SE)**, p5 203.12 ms, p95 239.05 ms.
- Within noise of `DR1-final` 5-trial multi-process median (217.80 ± 1.34 ms). No drift detected.

### 2.2 Inline-aggregated CPU top 30 (single-trial)

(All entries are V8 self-time. Sample interval derived from `(endTime - startTime) / samples.length`.)

| # | Self ms / iter | Self % | Function | File:line |
|---:|---:|---:|---|---|
| 1 | **19.57** | **8.47 %** | **fillRect** | dist/runOne.mjs:49856 (= `SvgCanvas.ts:52`) |
| 2 | 11.62 | 5.03 % | (garbage collector) | <native> |
| 3 | 7.72 | 3.34 % | _raiseRange | (Skyline) |
| 4 | 7.33 | 3.17 % | unionShifted3 | (Skyline) |
| 5 | 5.86 | 2.53 % | _fillMusicFontSymbolText | CssFontSvgCanvas.ts:39 |
| 6 | 5.63 | 2.43 % | paintBar | LineBarRenderer.ts:709 |
| 7 | 5.33 | 2.31 % | fillText | SvgCanvas.ts:151 |
| 8 | 5.19 | 2.25 % | collectSpaces | (LineBarRenderer.collectSpaces et al.) |
| 9 | 5.17 | 2.24 % | _scaleToForce | BarLayoutingInfo |
| 10 | 5.12 | 2.22 % | paintBackground | LineBarRenderer.ts:118 |
| 11 | 4.50 | 1.95 % | buildBoundingsLookup | … |
| 12 | 4.30 | 1.86 % | paint | LineBarRenderer subclass |
| 13 | 4.11 | 1.78 % | (program) | <native> |
| 14 | **4.07** | **1.76 %** | **paintStaffLines** | LineBarRenderer.ts:131 |
| 15 | 3.47 | 1.50 % | _paintNormal | BeatGlyphBase |
| 16 | 3.45 | 1.49 % | applyLayoutingInfo | BarRendererBase |
| 17 | 3.12 | 1.35 % | getBoundingBoxTop | (multi-site) |
| 18 | 3.12 | 1.35 % | lineTo | SvgCanvas.ts:83 |
| 19 | 2.85 | 1.23 % | getBeatX | … |
| 20 | 2.80 | 1.21 % | placeAndApply | … |
| 21 | 2.73 | 1.18 % | reset | … |
| 22 | 2.73 | 1.18 % | scaleToWidth | … |
| 23 | 2.48 | 1.07 % | paint | EffectBand etc. |
| 24 | 2.48 | 1.07 % | paint | … |
| 25 | 2.44 | 1.05 % | _internalGetNoteY | … |
| 26 | 2.32 | 1.00 % | paint | … |
| 27 | 2.25 | 0.97 % | paint | … |
| 28 | 2.21 | 0.95 % | _computeBeamingBounds | … |
| 29 | 2.07 | 0.89 % | alignGlyphs | … |
| 30 | 1.98 | 0.85 % | _splitAt | … |

(Earlier `REPORT.md` showed three V8-bucket-fragmented `fillRect` rows totalling ~95 ms across all iterations; the inline aggregation above coalesces them into one frame at 156.59 ms / 8 iter = 19.57 ms/iter. Both readings agree on total.)

### 2.3 fillRect rank verdict

**Still #1 self-time post-DR-1**, slightly *higher* than pre-DR-1 (was 18.20 ms / 7.80 %; now 19.57 ms / 8.47 %). DR-1 reduced layout walk overhead, leaving paint a larger relative share. The hotspot did **not** shift away — proceed with EW-10 investigation.

### 2.4 Other paint frames

- `_fillMusicFontSymbolText` at 5.86 ms (2.53 %) — DR-3 territory, NOT EW-10.
- `fillText` at 5.33 ms (2.31 %) — EW-8 already optimised the escape path.
- `paintStaffLines` at 4.07 ms (its own self-time, excluding the fillRect leaf cost it contains) — this is the parent frame of the largest single-caller fillRect volume.

---

## 3. Caller inventory

Source: `grep -rn "canvas\.fillRect" packages/alphatab/src --include="*.ts"` plus the per-file paint-call inspection in §3.2. Comments and unused-on-canon-resize-drag callers are noted.

All live emission sites in the rendering layer flow to **exactly one** `SvgCanvas.fillRect` body (`SvgCanvas.ts:52`). `Html5Canvas.fillRect` (`packages/alphatab/src/platform/javascript/Html5Canvas.ts:93`) and `SkiaCanvas.fillRect` (`packages/alphatab/src/platform/skia/SkiaCanvas.ts:171`) are out of scope — they call native `CanvasRenderingContext2D.fillRect` / Skia respectively.

### 3.1 Master table

Per-iter call counts are estimated from canon corpus geometry (rough, no instrumentation yet — Phase 0 §8 will measure). Volume notation: **H**igh (>1k/iter), **M**edium (100-1k), **L**ow (10-100), **N**ano (<10).

| # | Caller | File:line | ~Calls/iter | Group context | Z-pin (what's drawn before/after?) | Coordinate type | Safety class |
|---:|---|---|---|---|---|---|---|
| 1 | `LineBarRenderer.paintStaffLines` (inner gap loop) | `LineBarRenderer.ts:167` | **H** ~5000-8000 | **no** group (paintBackground) | **YES** — `paintBackground` runs before all glyphs; staff lines must stay BEHIND noteheads | int after `cx+x+lineX` integer skylines; `lineY = getLineY(i) - lineYOffset`; `lineYOffset = staffLineThickness/2` fractional | **Z** |
| 2 | `LineBarRenderer.paintStaffLines` (line tail) | `LineBarRenderer.ts:175` | **H** ~1000-2000 | no group | same Z-pin as #1 | same as #1 | **Z** |
| 3 | `BarLineLightGlyph.paintExtended` | `BarLineGlyph.ts:41` | **M** ~200 | no group | mild Z — bar line on top of staff lines, expected order matches | integer `cx + this.x` + integer `thinBarlineThickness` | **S** (safe — but volume too low to matter solo) |
| 4 | `BarLineHeavyGlyph.paintExtended` | `BarLineGlyph.ts:104` | L | no group | same as #3 | integer | **S** |
| 5 | `BarLineShortGlyph.paintExtended` | `BarLineGlyph.ts:165` | N | no group | minor Z | `padding = staffLineThickness/2` fractional possible | **C** |
| 6 | `BarLineTickGlyph.paintExtended` | `BarLineGlyph.ts:179` | N | no group | minor Z | `lineY = -(lineHeight/2) + 1` fractional | **C** |
| 7 | `ChordDiagramGlyph.paint` strings | `ChordDiagramGlyph.ts:117` | L (chord diagrams only) | no group; inside preBeatGlyphs/postBeatGlyphs | weak Z — chord diagram is self-contained | depends on `stringSpacing` (fractional) | **C** |
| 8 | `ChordDiagramGlyph.paint` first-fret bar | `ChordDiagramGlyph.ts:123` | L | no group | weak Z | fractional possible | **C** |
| 9 | `ChordDiagramGlyph.paint` nut | `ChordDiagramGlyph.ts:125` | L | no group | weak Z | `nutHeight/2` fractional | **C** |
| 10 | `ChordDiagramGlyph.paint` frets | `ChordDiagramGlyph.ts:135` | L | no group | weak Z | `fretSpacing` fractional | **C** |
| 11 | `ChordDiagramGlyph.paint` barre | `ChordDiagramGlyph.ts:174` | N | no group | weak Z | `circleHeight/2` fractional | **C** |
| 12 | `ScoreNoteChordGlyphBase.paintLedgerLines` (top) | `ScoreNoteChordGlyphBase.ts:641` | **M** ~50-200 | **YES** — called inside `BeatContainerGlyph.paint`'s `beginGroup` | strong G — ledger lines belong to the beat group for hover/highlight | `lineYOffset = (legerLineThickness * scale)/2` fractional | **G** |
| 13 | `ScoreNoteChordGlyphBase.paintLedgerLines` (bottom) | `ScoreNoteChordGlyphBase.ts:652` | **M** | same as #12 | same | same | **G** |
| 14 | `LineRangedGlyph.paintGrouped` dash | `LineRangedGlyph.ts:69` | L | inside effect band paint; effect band has no beginGroup itself but is z-pinned at top/bottom effects | weak Z | `dashThickness` fractional; loop in `lineX` non-integer | **C** |
| 15 | `LineRangedGlyph.paintGrouped` end-cap-V | `LineRangedGlyph.ts:73` | L | same | same | fractional | **C** |
| 16 | `LineRangedGlyph.paintGrouped` non-dashed line | `LineRangedGlyph.ts:76` | L | same | same | fractional | **C** |
| 17 | `LineRangedGlyph.paintGrouped` non-dashed end-cap | `LineRangedGlyph.ts:77` | L | same | same | fractional | **C** |
| 18 | `SustainPedalGlyph` line (in-bar) | `SustainPedalGlyph.ts:66` | L (rare — only when pedal markers present) | inside bottom-effects band | weak Z — pedal line on top of stems possibly, but coord-isolated | `pedalLineThickness` fractional | **C** |
| 19 | `SustainPedalGlyph` line (cross-bar) | `SustainPedalGlyph.ts:71` | L | same | same | fractional | **C** |
| 20 | `SustainPedalGlyph` lead-in line | `SustainPedalGlyph.ts:79` | L | same | same | fractional | **C** |
| 21 | `StaffSystem` accolade bar (per-stave gap) | `StaffSystem.ts:1014` | L (~accoladed staves only) | no group (inside `using ElementStyleHelper.bar`, but that's a style scope, not a `beginGroup` for SVG) | weak Z — drawn before noteheads of next system | `Math.ceil(thisTop - previousBottom)` integer-ish | **S** (low volume) |
| 22 | `StaffSystem._paintBrackets` bracket bar | `StaffSystem.ts:1059` | L | no group | weak Z | `Math.ceil(...)` integer-ish but `barShift = 3` and `accoladeStart - barShift` may be fractional | **C** (low volume; defer) |
| 23 | `ScoreBarRenderer.paintBeamingStem` (stem) | `ScoreBarRenderer.ts:421` | **H** ~2000-4000 | **YES** — called from `paintBar` (LineBarRenderer:747), which runs from `paintContent` → `voiceContainer.paint` → inside the `BeatContainerGlyph` `beginGroup`. NOTE: paintBeamingStem is invoked from `paintBar` at LineBarRenderer:747 BEFORE the `using ElementStyleHelper.beat(canvas, beamsElement, beat)` at LineBarRenderer:749 — but it IS inside `voiceContainer.paint`'s wrapping `BeatContainerGlyph` group (see §3.2.A) | strong G — stem identity is the user's named example | `stemThickness` is fractional (SMuFL value); `x` is integer-ish | **G** |
| 24 | `SlashBarRenderer.paintBeamingStem` | `SlashBarRenderer.ts:197` | M (slash bars only) | same G as #23 | same | same | **G** |
| 25 | `TabBarRenderer.paintBeamingStem` (single-note fast path) | `TabBarRenderer.ts:324` | M (tab bars only) | same G as #23 | same | same | **G** |
| 26 | `TabBarRenderer.paintBeamingStem` (multi-note bottom segment) | `TabBarRenderer.ts:331` | M | same G | same | same | **G** |
| 27 | `TabBarRenderer.paintBeamingStem` (multi-note hole segment) | `TabBarRenderer.ts:342` | M | same G | same | same | **G** |
| 28 | `TripletFeelGlyph` beam segment (left) | `TripletFeelGlyph.ts:336` | N (only on triplet-feel marker) | inside topEffects band | weak Z | integer-ish via floor/ceil bookkeeping | **S** (low volume) |
| 29 | `TripletFeelGlyph` beam segment (full) | `TripletFeelGlyph.ts:339` | N | same | same | same | **S** |
| 30 | `TripletFeelGlyph` beam segment (right) | `TripletFeelGlyph.ts:342` | N | same | same | same | **S** |
| 31 | `NumberedDashBeatContainerGlyph.paint` dash | `NumberedDashBeatContainerGlyph.ts:188` | L (numbered notation only) | inside `voiceContainer.paint` → BeatContainer group | strong G | `dashY = Math.ceil(cy + getLineY(0) - dashHeight)` integer | **G** |
| 32 | `DummyEffectGlyph.paint` | `DummyEffectGlyph.ts:26` | N (debug only — corpus does not exercise) | no group | weak | integer | **S** (low volume; debug) |

Commented-out callers (do not appear in the live profile):

- `BarRendererBase.ts:806, 847` — debug fillRect calls
- `LineBarRenderer.ts:121` — debug background fillRect
- `BeatContainerGlyph.ts:261, 262, 266, 277, 280` — debug
- `NoteNumberGlyph.ts:127` — debug
- `BarLayoutingInfo.ts:358, 361` — debug
- `RenderStaff.ts:321` — debug
- `TieGlyph.ts:586` — debug

### 3.2 Critical paint-context details

Two relationships in §3.1 deserve explicit pinning:

**3.2.A — paintBeamingStem and the BeatContainer group.** `paintBar` lives in `LineBarRenderer.ts:709` and runs from `paintContent` → `voiceContainer.paint` → per-beat-container `paint()` → various inner-glyph paints. **But `paintBar` itself is called from `paintContent` (LineBarRenderer:114)** — *outside* of any per-beat group. Wait: re-reading. `LineBarRenderer.paintContent` at 112-116 calls `super.paintContent(cx, cy, canvas)` (which paints background + preBeatGlyphs + voiceContainer + postBeatGlyphs), THEN `paintBeams` THEN `paintTuplets`. **`paintBar` is called from `paintBeams` (LineBarRenderer side), OUTSIDE the BeatContainer group.** Re-classify: stems are emitted OUTSIDE the per-beat group, but `ElementStyleHelper.beat(canvas, BeatSubElement.…Stem, beat)` is the `using` style scope wrapping `fillRect`. The user said "note stems light up on hover" — this is mediated by `ElementStyleHelper.beat`, which on Html5Canvas/SVG translates to a `class=` attribute on the emitted element via the `using` scope. **If `fillRect` is replaced by batched-buffer emission, the `ElementStyleHelper.beat` scope wrapping must still inject its identifier into the batched record** — otherwise hover-highlight breaks.

  Verdict: re-class stems as **G** (group/style-pinned). The user's instinct is right: stems carry per-beat identity even if not literally inside a `beginGroup`.

**3.2.B — paintStaffLines and ElementStyleHelper.bar.** `LineBarRenderer.paintStaffLines:132` opens a `using _ = ElementStyleHelper.bar(canvas, this.staffLineBarSubElement, this.bar, true)` scope. That helper, on SVG, sets `canvas.color` per the sub-element style mapping (no group element is emitted — the `true` 4th arg controls bar-level grouping behaviour, see `ElementStyleHelper.bar` for exact semantics). So each `fillRect` inside `paintStaffLines` carries a per-bar style. If batched, the batched record must include the active `canvas.color` snapshot at the time of the call. This is straightforward (color is one of the four `fill="…"` template fields), but it pins the buffer-record shape.

### 3.3 Distribution by class (count, not volume-weighted)

- **Class S** (safe): #3 (BarLineLight), #4 (BarLineHeavy), #21 (accolade bar), #28-30 (TripletFeel beam), #32 (DummyEffect) — 7 sites
- **Class G** (group/identity-pinned): #12, #13 (ledger lines), #23-27 (stems), #31 (numbered dash) — 8 sites
- **Class Z** (z-order-pinned): #1, #2 (paintStaffLines) — 2 sites, **highest volume**
- **Class C** (coordinate-sensitive): #5, #6 (BarLine variants), #7-11 (ChordDiagram), #14-17 (LineRanged), #18-20 (SustainPedal), #22 (bracket) — 14 sites

### 3.4 Volume-weighted distribution

Without precise instrumentation, the breakdown is:

- **paintStaffLines (#1, #2)** ≈ 60-75 % of total fillRect call volume
- **paintBeamingStem stems (#23-27)** ≈ 15-25 %
- **paintLedgerLines (#12, #13)** ≈ 5-10 %
- everything else ≈ 5-10 %

The volume dominance of **paintStaffLines** is the single most consequential fact in this plan. If paintStaffLines were Class S, EW-10 would be a straightforward batching exercise. **It is not** — it is Class Z (z-pinned to render before noteheads).

---

## 4. Safety classification — the structural backbone

The four classes from the user's framing:

### 4.1 Class S — Safe to batch

**Definition**: fillRect call where ALL three hold:
- no `beginGroup`/`endGroup` element identity OR `ElementStyleHelper` scope downstream-binding to the rect
- no z-order constraint (rect's place in document order does not affect rendering correctness against subsequent primitives)
- coordinates are integer (or integer-after-`*scale` for `scale=1`), so rasteriser cannot disagree about anti-aliasing rules between `<rect>` and any alternative

**Recipe for batching**: append a record to a typed buffer; flush in `endRender` as a `<rect …/>` per record. Element kind preserved; rasteriser output identical at integer coordinates.

**Members from §3.1**: #3, #4, #21, #28-30, #32. Low aggregate volume.

### 4.2 Class G — Group-locked

**Definition**: fillRect emitted inside `beginGroup`/`endGroup` OR inside an `ElementStyleHelper` scope that injects sub-element classes downstream into the rect element. Either the rect carries its own identity OR is wrapped in a `<g>` with identity-bearing class.

**Why batching is wrong**: a deferred-buffer flush emits all rects after the closing `</g>`. The rect loses its containing-group context (or its own attribute). On the user-side, hover handlers checking `event.target.closest('.beat-...')` no longer find the group.

**Recipe**: **leave as-is**. Or — if a batching shape is invented per-group (a per-`beginGroup` mini-buffer that flushes at the matching `endGroup`), the SvgCanvas would need to track group nesting depth and per-depth buffers. That's a substantial change and not in scope for EW-10.

**Members from §3.1**: #12, #13 (ledger lines), #23-27 (stems), #31 (numbered dash). Medium aggregate volume.

### 4.3 Class Z — Z-order-pinned

**Definition**: fillRect emitted at a specific point in document order such that subsequent primitives **render over** it. Moving it to a different document position would change pixel-level output.

**The concrete failure mode**: `paintStaffLines` rects are emitted from `paintBackground` (LineBarRenderer:118-129), which runs at the *start* of `paintContent`. After it run: preBeatGlyphs (clef etc.), then voiceContainer (noteheads + stems), then postBeatGlyphs, then multi-system slurs, then effect bands. Noteheads paint **over** staff lines. If staff-line fillRects are deferred to `endRender`, they emit **after** every notehead — visually striking through them.

**Recipe**: leave as-is, OR batch with a flush boundary that preserves z-order (e.g. flush at the end of `paintBackground` rather than `endRender`).

**Members from §3.1**: #1, #2 (paintStaffLines). High aggregate volume — this is the prize.

### 4.4 Class C — Coordinate-sensitive

**Definition**: fillRect at fractional coordinates AND where the rect's pixel-level rendering depends on element kind. Anti-aliasing rules between `<rect>` (filled primitive) and `<path>`/`<line>` (stroked) differ in SVG 1.1 + SVG 2 implementations. If the executor proposes batching as anything other than `<rect>`-per-record, Class C members are at risk.

**Members from §3.1**: #5, #6, #7-11, #14-22 (BarLine variants, ChordDiagram, LineRanged, SustainPedal, brackets). Mostly low volume per-site.

**Recipe**: if batching shape stays `<rect>`-per-record at flush time, Class C is no worse than the current code. If batching shape changes element kind (e.g. one `<path d="M.. h.. v.. h.. z M.. h..">` collapsing N rects), Class C members are at risk and need fixture-level verification.

### 4.5 What classification means for §6 batching scope

**Only Class S is unconditionally safe to batch with the "deferred flush at endRender" recipe.** Class S aggregate volume is small (perhaps 1-5 % of total fillRect calls) — under-σ savings even at zero per-call cost. **Class S alone does NOT clear σ.** This is the key reason EW-10 is not the easy win HOTSPOTS framed it as.

**Class Z (paintStaffLines)** *can* be batched with the right flush boundary (per-`paintBackground` mini-buffer, not per-`endRender`). That's the structural shape §6 proposes.

**Class G** stays as-is unless the SvgCanvas is taught about per-`beginGroup` buffering — not in scope.

**Class C** stays as-is at the current `<rect>` element kind.

---

## 5. Counter-investigation: intra-function tweaks alone

Before any caller-side change, exhaust optimisations of the `fillRect` body itself. The body (`SvgCanvas.ts:52-58`) is:

```ts
public fillRect(x: number, y: number, w: number, h: number): void {
    if (w > 0) {
        this.buffer += `<rect x="${x * this.scale}" y="${y * this.scale}" width="${
            w * this.scale
        }" height="${h * this.scale}" fill="${this.color.rgba}" />\n`;
    }
}
```

### 5.1 Per-call work breakdown (4 candidates)

| Op | Per-call cost (est.) | Removable? | How |
|---|---:|---|---|
| 4× `* this.scale` multiplies | ~10 ns | Partially | At `scale === 1`, all four are no-ops semantically but still cost float ops |
| 5× number-to-string interpolations (`${x*scale}` … `${color.rgba}`) | ~400-800 ns | No (output shape constraint) | These are the bulk of per-call cost |
| `this.color.rgba` getter | ~20-50 ns (depends on Color caching) | Possibly | Inspect `Color.rgba` — if it allocates a new string each call, hoist |
| `this.buffer += <120-byte-string>` cons-rope append | ~50-200 ns | No | V8 cons-rope already optimal |
| Total per call | ~500-1100 ns | | |

### 5.2 Total ms/iter budget

At 19.57 ms / iter and ~500-1100 ns / call → estimated **18k-39k fillRect calls per iter** on canon-resize-drag. (Phase 0 §8 will measure exactly.)

### 5.3 Candidate intra-function tweaks

**T1. `scale === 1` short-circuit.** Skip 4 multiplies when scale is the default 1. Savings: ~4 × 4-5 ns × 30k calls ≈ 0.5-0.6 ms / iter. **Below σ.**

**T2. Hoist `this.color.rgba` getter.** If `Color.rgba` allocates per call, cache last color → string. Savings depend on `Color.rgba`'s body — could be 0 (if already cached) to ~1-2 ms (if it recomputes). **Below σ alone.** Inspect `packages/alphatab/src/model/Color.ts` to know.

**T3. Pre-formatted scale-1 fast path.** Replace the template literal with manual `+` concatenation that branches on `scale === 1`. V8 has known mild wins from avoiding template-literal-overhead. Savings: ~5-15 % of the string-build cost = ~1-3 ms. **Possibly clears σ on its own**, but uncertain.

**T4. Combined T1 + T2 + T3.** Best-case sum ~1.5-4 ms. At the upper end, **clears σ at 2.7 ms** but with no margin.

### 5.4 Counter-evidence

`HOTSPOTS.md` EW-4 already attempted intra-function fillRect tweaks (per observation 17137 from Jun 13: "EW-4 fillRect 10v10 trial confirms ABANDONED: Δ +0.5%"). That was on the pre-DR-1 profile shape. Post-DR-1 the absolute fillRect cost is ~7 % higher (19.57 vs 18.20), so the same tweaks *might* clear σ now where they didn't then — but only marginally.

### 5.5 §5 decision rule

Phase 0 §8 measures exact per-call cost via a microbench. If the measured per-call cost suggests T1+T2+T3 combined will give ≥ 2.7 ms savings, run §5 first. Otherwise skip to §6.

**Honest expectation**: §5 alone is **likely below σ**, with maybe 30-50 % chance of clearing 2σ if T2 has bigger-than-expected wins from a hidden `Color.rgba` recomputation. Worth a single Phase A attempt before going to §6.

---

## 6. Batching shape (only if §5 is insufficient)

If §5 falls below σ, the structural target is **paintStaffLines fillRect batching with a `paintBackground`-boundary flush**.

### 6.1 Why paintStaffLines (Class Z) and not Class S

Class S aggregate volume is too low to clear σ even at 100 % cost-elimination per call. Class G has identity constraints. Class C has rasteriser-physics risk. **Class Z's paintStaffLines is the only call site with enough volume to matter AND a tractable z-order workaround.** That workaround: flush the batch at the **end of `paintBackground`** (BarRendererBase:840-849), not at `endRender`. This preserves document order — staff lines still come out before any pre-beat / voice glyph emitted by the same bar.

### 6.2 Buffer location and shape

- **Per-SvgCanvas instance**, not per-render. Lives as a field next to `buffer`: `private _rectBuffer: number[] = [];` (or `Float32Array`).
- **Record shape**: 4 numbers per rect, **no color**, **no scale**:
  - `x, y, w, h` (already-scaled values pushed by the caller via the new API, see §6.4)
  - color is captured as a string index into a small color-table (`private _rectColors: string[] = [];` and `private _rectColorIdx: number[] = [];`) — when color changes, push a new entry to `_rectColors` and reuse the index.
- Estimated per-call work for the new path:
  - 4× number push to `Float32Array` (or `number[]`): ~20 ns
  - 1× color-table lookup (compare with last entry): ~10 ns
  - 1× index push: ~5 ns
  - **Total ~35 ns vs 500-1100 ns** → ~30× per-call win.

### 6.3 Flush strategy — the key design decision

| Flush boundary | Z-order safety | Group safety | Recipe |
|---|---|---|---|
| `endRender` | **BROKEN for Class Z** | **BROKEN for Class G** | Trivial — single flush at end |
| `beginGroup` boundary | OK | OK (flush before group opens) | Need to also flush at `endGroup`, `beginRotate`, etc. |
| `paintBackground` end | **OK** (Class Z preserved) | OK (paintBackground is outside any group) | Hook from caller side; SvgCanvas exposes `flushRectBatch()` |
| Per-`fillRectBatched` call's containing `using` style scope | Most fine-grained | OK | Requires `using` to call `flushRectBatch` on dispose — non-trivial |

**Recommended**: `paintBackground`-end flush, exposed as a `canvas.flushRectBatch()` no-op-default API that SvgCanvas overrides. Caller-side: at the end of `BarRendererBase.paintBackground` (line 849), call `canvas.flushRectBatch?.()`. Symmetric flushes at:
- `endRender`
- before each `beginGroup`/`endGroup`/`beginRotate`/`endRotate`
- before each non-batched `fillRect`/`fillText`/`fill`/`stroke`/`fillMusicFontSymbol`/etc. emission

The last bullet is essential: any emission that needs document-order positioning must flush the pending batch first. This is mechanical but error-prone — needs a single guard in SvgCanvas. Implementation sketch: every existing emission method calls `this._flushRectBatchIfPending()` as line 1.

### 6.4 Opt-in API

Add to `ICanvas` (or as an SvgCanvas-only extension method discovered via instanceof):

```ts
fillRectBatched(x: number, y: number, w: number, h: number): void
```

Callers OPT IN: `LineBarRenderer.paintStaffLines:167` and `:175` change from `canvas.fillRect(…)` to `canvas.fillRectBatched(…)`. Other callers stay on `canvas.fillRect`.

Default implementation in `ICanvas` (or a base): falls back to `this.fillRect(x, y, w, h)`. Only `SvgCanvas` overrides with the buffered path.

This means `Html5Canvas` and `SkiaCanvas` continue calling native fillRect (already fast); only SVG benefits.

### 6.5 How callers OPT OUT (Class G/Z/C)

By not migrating. The default `fillRect` path stays unchanged for every Class G/Z/C site listed in §3.1. Migration is per-caller and gated on §4 classification.

### 6.6 Estimated savings

paintStaffLines fillRect volume ≈ 60-75 % of total fillRect calls. Per-call cost reduction ≈ ~30× → effective elimination of paintStaffLines's contribution to fillRect self-time.

- 19.57 ms × 0.65 (mid volume estimate) × 0.96 (fraction of per-call cost saved) = **~12 ms saving on canon-resize-drag**

Even at a conservative 30 % of that estimate, the saving is ~4 ms — well above 2σ (2.7 ms). At full estimate, it's a 5 % iter-time win.

The flush emits batched rects as a single template-literal concat with N×5 interpolations, but the total string-build cost is similar to N individual calls (V8 still does the interpolations) UNLESS the flush uses `Array.join`. That's the structural lever: **build the flush as `array.join('')` over pre-templated chunks** OR pre-allocate one big string with manual integer-to-string via a custom fast-path. The latter is the EW-5 lesson applied positively.

### 6.7 Anti-patterns to avoid

- **Do not flush in a `using`-style scope that fires every cycle.** That's the DR-1 §18.5 `afterReverted` lesson — if `flushRectBatch` is hooked into a cycle-firing hook, the optimisation evaporates. The flush points must be **document-order-natural** (paintBackground end, group open/close, render end) — not lifecycle hooks.

- **Do not change `<rect>` element kind on flush.** EW-5 lesson. Each batched record emits as a `<rect …/>` (preserves rasteriser output).

- **Do not migrate Class G/Z/C callers in the same commit as paintStaffLines.** Phase the migration per §7.

---

## 7. Per-caller migration strategy

The migration is **phased per-caller**, not all-at-once. Each phase ships independently. Falling out of a phase stops the migration; previous phases stay landed.

### 7.1 Phase ordering

| Phase | Caller | Class | Volume | Expected saving | Risk |
|---|---|---|---:|---:|---|
| **A** | §5 intra-function tweaks alone | n/a | n/a | 0-3 ms | Low |
| **B** | `paintStaffLines` (#1, #2) | Z | High | 4-12 ms | Z-order via flush boundary |
| **C** | Class S small callers (#3, #4, #21, #28-30) | S | Low | <0.5 ms | Trivial |
| **D** | Maybe `paintBeamingStem` (#23-27) | G | High | ~3-5 ms | **Group identity preservation** — requires sub-element-class injection into the batched record. Likely too complex; defer to a separate DR-X major refactor. |

**Decision**: ship A → B only. Stop after B. **Do not attempt C, D in this round.** C is below σ (not worth the API surface). D is a major refactor (separate planning round).

### 7.2 Phase A — intra-function tweaks

Single-commit, single-file. Touches `SvgCanvas.ts:52-58` only. See §5 for candidate tweaks (T1, T2, T3, T4).

Per-commit decision rule (§10):
- `★ ≥ -2.7 ms` → land.
- `★ < 2.7 ms` (below σ) → revert. Proceed to Phase B.

### 7.3 Phase B — paintStaffLines batching

Two-file change: `SvgCanvas.ts` (gains `fillRectBatched` + flush plumbing) and `LineBarRenderer.ts` (migrate two call sites at line 167 and 175). Also touches `ICanvas.ts` (declare the new method) and `BarRendererBase.ts` (call `canvas.flushRectBatch?.()` at end of paintBackground).

Per-commit decision rule:
- vitest 1599/1599 — strict. Visual diffs must be inspected per §11 (Class E pattern).
- `★ ≥ -2.7 ms` on paired A/B n=64 vs `be8b724b` → land.
- below σ → revert Phase B only, keep Phase A if landed.

### 7.4 What NOT to migrate

Class G (stems #23-27, ledger lines #12-13, numbered dash #31): structurally infeasible without per-`beginGroup` buffer support. Separate planning round if ever revisited.

Class C (small callers with fractional coords): rasteriser-risk; aggregate volume too low to justify the per-fixture verification cost.

---

## 8. Phase 0 — empirical correctness probes (before any code change)

Three measurements. All read-only (instrumentation patches that don't ship).

### 8.1 Subpixel sample — establish Class C bound

Render a tiny fixture (one bar with the existing canon corpus, NOT a custom fixture) twice:
1. Stock SvgCanvas (HEAD).
2. SvgCanvas patched to emit `<path d="M0,0 h W v H h -W z" fill="…"/>` instead of `<rect>` for fillRect.

Compare pixel-by-pixel with the existing visual-regression toolchain (`packages/alphatab/test`). Classify diffs by site:
- If only fractional-coord callers diff (Class C sites) → Class C bound is correct, scope §6 to integer-coord callers only.
- If any integer-coord caller diffs → rasteriser is more sensitive than expected; restrict §6 to Class S (and abandon the paintStaffLines target, because while paintStaffLines coordinates *are* fractional at `lineYOffset = staffLineThickness/2`, this measurement isolates whether `<rect>`-vs-`<path>` is the variable or something else).

**Output**: a single Markdown sub-doc `EW-10-PHASE-0-SUBPIXEL.md` with the per-site diff counts and pixel deltas. Decision artifact.

### 8.2 Group inventory — grep + cross-reference

```bash
grep -rn "beginGroup\|endGroup" packages/alphatab/src --include="*.ts" | grep -v "//\|interface\|abstract"
```

Currently confirmed `beginGroup`/`endGroup` call sites:
- `BarRendererBase.ts:985, 994, 997, 998, 1009, 1010` — `paintSimileMark` (does NOT contain fillRect)
- `BeatContainerGlyph.ts:313, 326` — `BeatContainerGlyph.paint` (CONTAINS fillRect via stems, ledger lines)

Result: the only group context containing fillRect is `BeatContainerGlyph.paint`. Class G membership is bounded by this. Anything emitted from `voiceContainer.paint` is inside this group.

### 8.3 Z-order trace — paintBar diagram

`BarRendererBase.paintContent` emission order, line-precise:
```
BarRendererBase.paintContent:
  817 → paintBackground(cx, cy, canvas)
        818 → LineBarRenderer.paintBackground:118
              126 → paintStaffLines(cx, cy, canvas)   [Z-PIN ANCHOR]
              128 → paintSimileMark(cx, cy, canvas)
  820 → canvas.color = mainGlyphColor
  821 → this._preBeatGlyphs.paint(...)                 [clef, key sig, time sig]
  822 → this.voiceContainer.paint(...)
                each beat: BeatContainerGlyph.paint:313 → beginGroup
                  → preNotes.paint (accidentals, dots, ...)
                  → onNotes.paint (NOTEHEADS, stems via paintBar later, ledger lines)
                  → ties
                  326 → endGroup
        + LineBarRenderer.paintContent:114 calls paintBeams AFTER super.paintContent → this is where paintBar emits beam rects + stems
  824 → this._postBeatGlyphs.paint(...)                [barlines, repeat counts]
  826 → _paintMultiSystemSlurs(...)
  811 → this.topEffects.paint(...)                     [chord diagrams, line-ranged, sustain-pedal]
  814 → this.bottomEffects.paint(...)                  [sustain-pedal again]
```

Crucial fact: `paintStaffLines` is the **first paint** in any bar. Every notehead, stem, ledger line emitted afterwards overlays it. **Deferred-flush at `endRender` reverses this — staff lines render over all bars' content.**

**This trace must be re-verified by the executor at Phase B start.** Codebase shifts (e.g. someone moves `paintBeams` into `paintBackground`) would invalidate the plan.

---

## 9. Phase 1 — fresh CPU profile interpretation (gate)

§2 captured this already. The verdict:

- fillRect is **still #1 self-time post-DR-1** at 19.57 ms / 8.47 %. The DR-1 win on other frames left the paint surface a *larger* relative share, not smaller.
- **Proceed to Phase A (intra-function tweaks)**.

If at a later run the profile drifts and fillRect is no longer top-5 → demote EW-10 to "investigated, paint surface no longer dominant; revisit only if structural shifts re-promote it" and document in HOTSPOTS.md.

---

## 10. Phase 2-3 — phased migration, A/B + vitest per phase

### 10.1 Phase A (intra-function tweaks)

**Implementation**: apply one or more of T1-T4 from §5.3 to `SvgCanvas.ts:52-58`. Single-file.

**A/B**:
```bash
cd packages/bench
npm run bench:ab:build
node dist/runAB.mjs --a dist/ab/A/runOneCore.mjs --b dist/ab/B/runOneCore.mjs --only canon-resize-drag --n 64 --label EW10-A
```

**Vitest**:
```bash
cd packages/alphatab
npm run test
```

**Decision rule**:
- vitest 1599/1599 strict. Zero diff PNGs. Zero `npm run test-accept-reference` invocations.
- `★ Δ ≤ -2.7 ms (≥ 2σ)` → land as `perf(svg): fillRect intra-function tweaks (T1+T2+T3 if applicable)`.
- `★ Δ ∈ (-2.7, 0) ms` → below σ; revert; proceed to Phase B.
- Visual diffs → inspect per §11 Class E. If diffs are genuine regressions (not improvements), revert; do NOT accept-reference without user confirmation. **Visual diffs from changing the number-to-string formatting are unlikely but possible** (e.g. trailing-zero changes in fractional output).

### 10.2 Phase B (paintStaffLines batching)

**Implementation** (in order):
1. Add `fillRectBatched(x, y, w, h)` to `ICanvas` interface with default delegation to `fillRect`.
2. Add SvgCanvas-only override + buffer + `flushRectBatch()`.
3. Add flush calls to every existing SvgCanvas emission method (`fillRect`, `strokeRect`, `fillText`, `fill`, `stroke`, `fillCircle`, `strokeCircle`, `fillMusicFontSymbol*`, `beginGroup`, `endGroup`, `beginRotate`, `endRotate`, `endRender`).
4. Add `canvas.flushRectBatch?.()` to end of `BarRendererBase.paintBackground` (line 849, before the closing brace).
5. Migrate `LineBarRenderer.paintStaffLines` lines 167 and 175 from `canvas.fillRect` to `canvas.fillRectBatched`.

**A/B**: same protocol as Phase A but labelled `EW10-B`.

**Vitest**: 1599/1599 strict.

**Decision rule**:
- `★ Δ ≤ -2.7 ms` → land as `perf(svg): batched fillRect for paintStaffLines (paintBackground-flush)` (or `refactor(svg)` if the API surface change is the primary characterisation).
- Below σ → revert Phase B. Keep Phase A if landed. Document.
- Visual diffs → §11 Class E inspection. Expected baseline: **0-3 failures**; staff-line rendering at integer-aligned coordinates should be pixel-identical to current. If staff-line pixels differ → flush boundary is wrong; do NOT widen scope. Restart Phase B with revised flush point.

### 10.3 Cross-scenario neutrality

After each phase land, run:
```bash
cd packages/bench
node dist/run.mjs --trials 5 --label EW10-post-$(date +%s) --save-baseline EW10-post
node dist/cli.mjs diff baselines/DR1-final.json baselines/EW10-post.json
```

Every non-target scenario must be `·` / `~` / `★ improvement`. Any `★` regression → revert the last phase.

---

## 11. Anti-revert directives + DR-1 §18.5 lessons applied

These rules carry over from the DR-1 plan §11 + §18.5. Read them before each phase.

> **DO NOT** run `npm run test-accept-reference` without first inspecting every diff PNG and user-confirming it is an improvement (DR-1 §18.5 Class E pattern).

> **DO NOT** revert Phase B on the first red vitest. Expect 0-3 visual failures; classify each via §11.1 before reverting.

> **DO NOT** generalize to all fillRect callers. The user said this explicitly. Stay surgical. Class G/C/Z (except paintStaffLines) stays on the unchanged `fillRect` path.

> **DO NOT** speculate about per-call cost without measurement. DR-1 §18.5 lesson #3. If "intra-function tweaks won't clear σ" is the argument for skipping Phase A, measure first.

> **DO NOT** hook the flush into a cycle-firing lifecycle hook. DR-1 §18.5 lesson #4 — the equivalent here is: do NOT call `flushRectBatch()` from any kind of `afterReverted`/`afterRender`/`beforePaint`-style cycle hook. The flush points are **document-order-natural events** (paintBackground-end, group open/close, render end), not lifecycle events.

> **DO** commit Phase A and Phase B as separate commits. Bisect-friendly.

> **DO** re-run cross-scenario neutrality after each landed phase.

> **DO** record falsification per §13 if both phases below σ.

### 11.1 Class E visual-diff inspection (carried over from DR-1)

If vitest produces visual diffs:
- **Class A**: clear regression — pixel content moved or text broken. Revert immediately.
- **Class B**: subpixel anti-aliasing shift at fractional coords. Investigate per §8.1; may need to restrict the batched-emission shape.
- **Class C**: layout regression — wrong glyph position. Likely flush-boundary is wrong; do NOT widen scope; restart with corrected flush.
- **Class D**: identity-related (an element that used to have a class no longer does). Class G migration in disguise. Revert and re-classify the caller.
- **Class E** (DR-1 §18.5 addition): old reference PNG encoded a pre-existing bug; new behaviour is correct. Accept the new reference **only after** user-side manual inspection AND user confirmation. Do NOT auto-accept.

---

## 12. Definition of done

EW-10 is shippable when **all** hold:

- **vitest 1599/1599** in `packages/alphatab`. Zero diff PNGs without manual user confirmation. Zero `test-accept-reference` invocations.
- **A/B `★` Δ ≤ -2.7 ms (≥ 2σ)** on canon-resize-drag at n=64, paired vs `be8b724b`.
- **5-trial multi-process** diff vs `baselines/DR1-final.json`: every non-target scenario `·` / `~` / `★ improvement`. No `★` regressions.
- **HOTSPOTS.md updated**:
  - If only Phase A landed: EW-10 goes under "Easy wins — landed" with the intra-function-tweak description.
  - If Phase B landed: EW-10 goes under **"Major refactors — landed"** (creating that header if it doesn't yet exist, per DR-1 plan §12.4 precedent). The reason: Phase B adds public-ish API (`fillRectBatched`) and changes the SvgCanvas emission contract.

---

## 13. Documented falsification path

If both Phase A and Phase B fail to land:

- HOTSPOTS.md: demote EW-10 to **"Demoted at this site"** (same section as EW-2(b), EW-3 micro-devirt, EW-5).
- Falsification entry shape:
  > **EW-10 fillRect surface** — attempted via Phase A intra-function tweaks (`★` Δ=..., below σ) and Phase B paintStaffLines-batched (`★` Δ=..., below σ OR vitest regressions Class A/B/C). The fillRect surface is now intrinsic post-DR-1: the per-call string-serialisation cost dominates, the only volume-significant caller (paintStaffLines) is Z-pinned, and the Z-pin's workaround (paintBackground-end flush) either (a) does not save enough OR (b) leaks a rasteriser-physics regression that vitest catches. Future revisit requires either: a structural shift to non-`<rect>`-emission (raster-physics validated per fixture), or DR-X-class per-`beginGroup` batched buffering that opens the Class G surface.

- This is an **acceptable outcome**. A documented structural-block on a known hotspot is a successful round.

---

## 14. Quick reference card

```
Phase 0 (empirical correctness probes):
  §8.1 subpixel sample → Class C bound established
  §8.2 group inventory → only BeatContainerGlyph holds fillRect-bearing groups
  §8.3 z-order trace → paintStaffLines is FIRST paint of any bar (z-pin anchor)
  Confirm before any code change.

Phase 1 (post-DR-1 profile interpretation):
  fillRect ≥ top-5? → proceed
  fillRect dropped from top-10? → demote EW-10, document, stop

Phase A (§5 intra-function tweaks):
  T1: scale=1 short-circuit (+0.5 ms est)
  T2: hoist color.rgba (0-2 ms — inspect Color.rgba first)
  T3: manual concat + scale-1 fast path (1-3 ms)
  T4: T1+T2+T3 combined (1.5-4 ms upper bound)
  A/B n=64:
    ★ ≤ -2.7 ms? → land as easy-win, proceed to B (still valuable)
    below σ? → revert, proceed to B (B does not depend on A landing)

Phase B (§6 paintStaffLines batching):
  Add fillRectBatched + flushRectBatch + paintBackground-end flush
  Migrate LineBarRenderer:167, :175 only
  A/B n=64:
    ★ ≤ -2.7 ms? → land as major refactor
    below σ? → revert Phase B (keep Phase A if landed), falsify per §13
  Vitest visual diffs?
    Class A/B/C/D? → revert
    Class E (improvement)? → user-inspect, user-confirm, accept reference

NEVER:
  - test-accept-reference without user confirmation
  - generalize beyond paintStaffLines (Class S/G/C stay unchanged)
  - flush from cycle-firing lifecycle hooks (DR-1 §18.5 lesson)
  - change <rect> element kind on flush (EW-5 lesson)
  - commit Phase A and Phase B together
```

---

## 15. Supporting evidence

- Source: `packages/alphatab/src/platform/svg/SvgCanvas.ts:52` — single emission site.
- Caller inventory grep: `grep -rn "canvas.fillRect" packages/alphatab/src --include="*.ts"`. Live sites enumerated in §3.1.
- Pre-DR-1 paint-surface analysis: `packages/bench/analysis/2026-06-14-resize-drag/subagent-paint.md`.
- DR-1 plan and lessons: `packages/bench/analysis/2026-06-14-resize-drag/DR-1-BROKER-LIFECYCLE-PLAN.md` §11, §18.5.
- Post-DR-1 baseline: `packages/bench/baselines/DR1-final.json`.
- Post-DR-1 single-trial profile captured for this plan: `packages/bench/runs/EW10-postDR1/canon-resize-drag/` (cpu.cpuprofile + REPORT.md).
- EW-4 prior abandonment (intra-function tweaks below σ on pre-DR-1 profile): observation 17137.
- EW-5 prior abandonment (`<path>`-batch rasteriser physics): HOTSPOTS.md "Demoted at this site".
- Z-order anchor: `BarRendererBase.ts:804-827` (paintContent emission order).
- Group anchor: `BeatContainerGlyph.ts:313, 326` (beginGroup/endGroup pair around all per-beat fillRect-bearing paints).
- ElementStyleHelper style scope: `LineBarRenderer.ts:132` (paintStaffLines using `_ = ElementStyleHelper.bar(...)`); `ScoreBarRenderer.ts:420` (paintBeamingStem using `_ = ElementStyleHelper.beat(...)`).

---

## 16. Estimated effort

| Phase | Wall-clock estimate | Notes |
|---|---|---|
| 0 | 30-60 min | Empirical probes, instrumentation, no source change |
| 1 | done | §2 profile already captured |
| A | 30-60 min | Single-file diff + A/B + vitest |
| A→B | 5-10 min | Decision and revert if applicable |
| B | 90-150 min | Multi-file diff (SvgCanvas + ICanvas + BarRendererBase + LineBarRenderer); flush plumbing across all emission methods is mechanical but easy to miss a site |
| B A/B + vitest | 10-20 min | Same shape as DR-1 plan §7 |
| B visual triage | 0-60 min | Expected baseline 0-3 failures; Class E inspection if any |
| Cross-scenario neutrality (each landed phase) | 10-15 min build + 5-8 min run | |
| Total | **2-4 hours** if Phase A and/or B land cleanly; up to **6-8 hours** if Phase B has visual triage iteration | |

---

## 17. The two non-negotiable rules

1. **Phase 0 §8.3 z-order trace MUST be re-verified by the executor at Phase B start.** The paint-content emission order is the load-bearing fact of §6's flush-boundary choice. If the codebase has shifted, the entire batching strategy may be wrong.

2. **The §11 anti-revert directives MUST be obeyed.** Especially: no `test-accept-reference` without user-confirmed Class E classification; do NOT generalize to all fillRect callers; do NOT hook the flush into cycle-firing lifecycle hooks.

If either rule is broken, the executor has departed from the plan. Stop, re-read this document, and resume from the section where the deviation occurred.

---

## 18. Execution outcome — Phase A landed `244c8e0b`, Phase B falsified 2026-06-14

**Status**: Phase A landed (scale=1 fast path). Phase B (paintStaffLines batching) attempted twice, both below σ — batching-buffer overhead eats the per-call savings on this workload. EW-10 ships under "Easy wins — landed" as Phase A only; the structural §6 design does not ship.

### 18.1 Phase 0 — empirical probes (commit `daa5c2c6`)

Probe instrumentation patched onto `SvgCanvas.fillRect` (reverted before commit; reproducible via `packages/bench/scripts/phase0-fillrect-count.mjs`).

Key findings — several **invalidated** §3 / §5 plan assumptions:

| Plan assumption | Actual measurement | Impact |
|---|---|---|
| 18-39k fillRect calls / iter (§5.2) | **114,307 calls / iter** (3-6× higher) | Phase A's per-call savings are 3-6× more valuable than estimated |
| 500-1100 ns per call (§5.2) | **~171 ns** | Phase A's intra-function tweaks have less absolute room than estimated, but call count compensates |
| paintStaffLines ~60-75 % of volume (§3.4) | **44.8 %** | Class Z dominance smaller than thought; Phase B's potential ceiling is lower |
| ledger lines ~5-10 % of volume (§3.4) | **26.6 %** | Class G is much bigger than thought; if anything went wrong with stems-style identity, more fixtures would have caught it |
| stems ~15-25 % | 16.3 % | matches |
| `scale=1 → integer coords` (§5.1 T1 assumption) | **0 % integer post-`*scale`** — even at scale=1, all coords are fractional float values | T1 reduced to "skip 4 multiplies" only (no integer-emission optimisation possible) |
| `Color.rgba` is a getter that might recompute | Plain cached field | T2 dropped from Phase A — no measurable savings available |
| paintBackground is z-pinned before all glyphs (§3.1) | **Confirmed at HEAD**: emitted first in `paintBar`, before pre-beat glyphs / voice container / post-beat | Phase B's `paintBackground`-flush design preserves z-order as planned |
| BeatContainerGlyph is the only beginGroup wrapper of fillRect-bearing paint | **Confirmed** | Class G is a single site, not multiple |

### 18.2 Phase A — scale=1 fast path with manual concat (committed `244c8e0b`)

Implementation per §5.3 T1+T3 (T2 dropped per Phase 0):

```ts
const s = this.scale;
if (s === 1) {
    this.buffer += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + this.color.rgba + '" />\n';
} else {
    this.buffer += `<rect x="${x*s}" y="${y*s}" width="${w*s}" height="${h*s}" fill="${this.color.rgba}" />\n`;
}
```

A/B at n=64 paired vs `be8b724b` (pre-EW-10):

| Scenario | Δ ms | Δ % | sig |
|---|---:|---:|:---:|
| canon-resize-drag | **-4.14** | **-2.7 %** | **★** |

Above the 2σ floor (2.7 ms), `★` significance (sign-test z=2.75, 43/64 wins, CI [-6.12, -2.26]). vitest: **1599/1599 — no visual diffs at all**. Output is byte-identical to the prior code because `${x}` and `'"' + x` both produce `Number.prototype.toString` output.

### 18.3 Phase B — paintStaffLines batching (falsified)

Per §6.4, implemented `fillRectBatched(x, y, w, h)` on `ICanvas` (default forwards to `fillRect`; `SvgCanvas` overrides with a buffered path). Added a `_rectBuffer` + flush plumbing per §6.2-§6.3. Migrated `LineBarRenderer.paintStaffLines:167` and `:175` to call `fillRectBatched`. Flush hook at the end of `BarRendererBase.paintBackground` and at every non-batched emission method.

| Run | A | B | Δ vs A | sig |
|---|---|---|---|---|
| probe-EW10-B-vs-A (initial) | Phase A | Phase B v1 | **+1.80 ms / +1.2 %** | `·` (sign z=-1.25) |
| probe-EW10-B2-vs-A (refined) | Phase A | Phase B v2 (flush inlined, color-table shrunk) | **-0.07 ms / 0.0 %** | `·` |
| probe-EW10-B-vs-baseline | be8b724b | Phase B v1 | **+0.11 ms / +0.1 %** | `·` |

Phase B v1 is **slower** than Phase A. The plan §6 estimated a 30× per-call win on the batched path; that holds in microbench. But the **per-flush amortisation cost** (walking the buffer + emitting concatenated strings + the indirect call overhead at every emission method's guarded `_flushRectBatchIfPending`) eats the savings.

vitest: 1599/1599 on both Phase B v1 and v2 — **no visual diffs**, confirming the batching machinery is correctness-clean. The §4 Class Z safety analysis was vindicated (paintBackground-end flush DID preserve z-order; no fixture broke).

### 18.4 Why the §6 design didn't pay off as estimated

The §6.6 estimate was "~12 ms saving on canon-resize-drag" assuming N batched-record-pushes cost ~30 ns each vs ~500-1100 ns per template-literal call. Two facts overrode that arithmetic:

1. **Per-call cost was ~171 ns, not 500-1100 ns** (Phase A's measured number after Phase A landed; pre-Phase-A it was ~300-500 ns including the template literal). The "30×" win compresses to ~6-10× per call.
2. **Flush cost is non-trivial**: walking the buffer + emitting a concatenated `<rect ... />` per record, plus the guarded `_flushRectBatchIfPending` check at every emission method, adds ~50-80 ns of overhead per emission method call (~10-20 such calls per iter per bar). At canon-resize-drag's bar count, that's ~1-2 ms of flush-guard overhead per iter.

Net: ~3-5 ms of per-call savings, minus ~3-5 ms of flush+guard overhead. The bench sees ~0 ± 1 ms.

### 18.5 Phase B is not retried with a different shape

The plan §10.3 lists no fallback after Phase B because Phase A already cleared σ. Phase B's failure is acceptable: the win we shipped is the win that mattered.

The phase B v2 narrowing (inlining the flush, shrinking the color table) showed that the buffer-batching mechanism's overhead is **fundamental** at this call rate, not a particular implementation choice. A third batching shape (e.g. pure `Array.join` flush, custom integer-to-string lookup table) might pay off but the marginal expected delta is below σ given Phase A is already at the floor.

### 18.6 Plan corrections needed for future similar gates

- **Plan §5.2 / §5.3 cost estimates were 3-6× off.** Future plans should bound their assumed per-call cost from existing microbench data, not from per-op estimation. The Phase 0 probe pattern (instrument the function, measure call count + per-call ns, commit findings) should be elevated from optional to mandatory for ALL hotspot candidates with rate > 50k calls / iter.
- **Plan §6 batching designs should include a "guard overhead floor" estimate.** Any flush-on-emit-boundary pattern has an N×M overhead component (N emission methods × M flushes per iter) that wasn't quantified. The plan's §6 estimate would have been more honest if it'd written "expected savings if flush amortises ≥ 50× per-call cost, otherwise wash".
- **Class Z safety analysis was correct.** Phase B's vitest pass with zero diffs vindicates §4 Class Z and the §6.3 `paintBackground`-end flush boundary. This is reusable infrastructure: if some future hotspot is identified that can use buffered emission, the §4 / §6.3 framework can be cited as established-safe.
- **No revert needed on visual diffs.** The user's anti-revert framing held: Phase B had zero diffs, so the question never came up. But the executor was prepped to surface diffs to the user rather than auto-classify, which is the right default regardless of whether they appear.

### 18.7 Cite-by-commit timeline

- `daa5c2c6` — Phase 0 empirical probes (committed; instrumentation patch reverted before commit).
- `244c8e0b` — **Phase A landed**: scale=1 fast path. Stays.
- Phase B implementations were in working tree only; both reverted before commit per §10 fall-out protocol (acceptable outcome — Phase A's win is the EW-10 ship).
- This commit (docs) — HOTSPOTS.md update + this postscript.

### 18.8 Final HEAD

`244c8e0b` (Phase A landed) + docs commit completing the HOTSPOTS.md and §18 paperwork.

vitest: 1599/1599. A/B paired n=64: canon-resize-drag `★` Δ -4.14 ms. No `★` regression elsewhere.

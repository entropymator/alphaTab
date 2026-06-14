# Paint surface — canon-resize-drag analysis

Scenario: 235.30 ms / iter; σ ±3.48 ms; 1 % = 2.35 ms.
Paint group (fillRect + _fillMusicFontSymbolText + fillText + lineTo) = **13.7 % CPU ≈ 32.2 ms/iter**. DR-3 territory.

## Per-symbol classification

| Symbol | CPU % | ms/iter | Class | Notes |
| --- | ---: | ---: | --- | --- |
| `fillRect` (SvgCanvas:52) | 7.80 | 18.20 | **S** / partial **A** | Single emission site; cost is string concat + 4 number-to-string + 1 `\n`. |
| `_fillMusicFontSymbolText` (CssFontSvgCanvas:39) | 2.49 | 5.83 | S (DR-3) | Per-symbol `<text>` emission. |
| `paintBar` (LineBarRenderer:709) | 2.35 | 5.51 | I | Beat-iteration scaffold; cost is downstream `fillRect`/lineTo. |
| `paintBackground` (LineBarRenderer:118) | 2.25 | 5.30 | I (parent of paintStaffLines) | `BarLayoutingInfo.paint` is no-op; cost ≈ paintStaffLines + paintSimileMark + ElementStyleHelper. |
| `fillText` (SvgCanvas:151) | 2.02 | 4.75 | S (DR-3) | Per-text `<text>` element. EW-8 already optimised the escape path. |
| `paintStaffLines` (LineBarRenderer:131) | 1.65 | 3.88 | **A**/S | 5 lines × (bars × spaces+1) `fillRect`s; 1 per gap. EW-5 demoted `<path>` batching. |
| `lineTo` (SvgCanvas:83) | 1.39 | 3.27 | I | Mostly beam/tie path edges. |
| `_paintNormal` (BeatGlyphBase:64) | 1.37 | 3.22 | I | Forwarding loop. |
| `_emitGroupOverflows` (BarRendererBase:683) | 1.00 | 2.35 | (out of scope — overflow not paint) | Width-invariant; DR-1 territory. |

## fillRect inventory (Q1)

SvgCanvas:52 is the **sole** emission site — 18.2 ms/iter all comes from one function body. The 3 frames in older canon-resize were V8 sample-bucket aggregations (HOTSPOTS confirms); here they consolidate to one frame because drag adds enough iterations to flatten the bucketing. Callers (live, not commented): BarLineGlyph ×4, ChordDiagramGlyph ×4, ScoreNoteChordGlyphBase ×2, SustainPedalGlyph ×3, ScoreBarRenderer/SlashBarRenderer/TabBarRenderer stems ×3, LineRangedGlyph ×4, LineBarRenderer.paintStaffLines ×2, StaffSystem ×2 (accolade/barlines), NumberedDashBeatContainerGlyph ×1, DummyEffectGlyph ×1, TripletFeelGlyph ×3, TabBarRenderer hole ×1. **`paintStaffLines` dominates volume**: 5 lines × (≥1 segment per bar) = ~5N rects per system; canon has dozens of bars per width.

**Per-call cost source**: template literal in fillRect emits 5 number-to-strings (`x*scale`, `y*scale`, `w*scale`, `h*scale`) + 1 color-string getter (`this.color.rgba`). At scale=1 (default) all four multiplies are wasted. The string concat appends ~120 chars to a buffer that, by end of render, holds ~hundreds of KB — V8's `+=` cons-rope optimisation should handle this, but each `${}` interpolation forces conversion. Per-call cost ≈ 1.5–2 µs (18.2 ms / ~10k calls/iter is a reasonable order).

**Why intra-function tweaks lose (EW-4 confirmed)**: the per-call work is fundamentally string serialisation; you cannot remove 5 number-to-strings without changing the output shape. The win has to be call-count reduction or batching.

## paintBackground (Q2)

`BarLayoutingInfo.paint` at line 331 is a no-op stub (commented-out debug). Real cost: `paintStaffLines` (1.65 %) + `paintSimileMark` + `super.paintBackground` overhead + `ElementStyleHelper.bar` allocation (the `using _` line 132). Per-bar overhead = (5.30 − 3.88) ≈ 1.42 ms / iter on the framing alone. **(I)** — function-frame cost; not a fix target.

## paintStaffLines as `<line>` (Q3)

Currently emits one `<rect>` per gap-segment of each of 5 lines (3.88 ms/iter). Switching to `<line>` strokes would: (a) cut emitted bytes (`<line x1=".." y1=".." x2=".." y2=".." stroke-width=".."/>` ≈ same byte count as `<rect ... height="thin"/>`); (b) same number of elements per gap — **no surface reduction**. EW-5's `<path>` per-bar lost +2.0 % because SVG rasterisers special-case `<rect>`. `<line>` stroking has the same general-rasteriser pitfall. **Upper bound on saving: ≤ 1.5 ms — not worth the regression risk.** Classify **(D)** — variant of EW-5.

The actual lever in paintStaffLines is call-count: 5 lines per bar, where 4 of them are nearly identical horizontal segments with only `y` differing. A "**vertical broadcast**" primitive — `canvas.fillRects(x, [y1..y5], w, h)` writing a single buffer chunk that emits 5 rects in one concat — would cut JS-side string-concat overhead. Estimated saving: ~30 % of paintStaffLines = ~1.2 ms. **Below σ. (D)-adjacent.**

## DR-3 path-batching credibility (Q4)

**Credible — but a specific shape**. EW-5 failed because it batched rects whose existing element kind (`<rect>`) is fast in the rasteriser. DR-3 has to target elements where:
1. The current emission is **already a `<path>`** (so the rasteriser cost is invariant), AND
2. Multiple primitives share style state.

Candidates:
- **Beam bars in `paintBar`** (LineBarRenderer:709, 2.35 % CPU). Each beam segment is a `fillMusicFontSymbols` or `paintSingleBar` path; per-beat there can be 2–4 separate `<path>` fills. Batching all beams within a single `paintBeams` invocation into one `<path d="M.. L.. z M.. L.. z">` is a real reduction (N×3 elements → 1). Estimated: ~30 % of paintBar = **~1.6 ms**.
- **Noteheads via `fillMusicFontSymbol`**: each notehead is currently one `<text>` (CssFontSvgCanvas). Batching not directly available because each glyph needs its own `<text>` position. **No win here** without a structural shift to a path-based font (out of scope).
- **Tie/slur curves** (`bezierCurveTo` → `<path>`): already path-emitted, but each tie calls `stroke()` which terminates the path. Coalescing all ties in a bar into one stroked path: saves ~N stroke-call overhead. Magnitude small.

**Realistic DR-3 ceiling on canon-resize-drag**: ~3–4 ms (1.3–1.7 %), well above σ. But the API contract change (deferred flush, style-grouped path accumulation) is non-trivial — closer to DR-3's stated 10–20 % only if it also collapses `fillRect`'s string concat, which means changing `fillRect` to push to a typed buffer flushed once. That is the structural shape.

**Lowest-hanging structural win**: batched-`fillRect` byte buffer (push 5 numbers + color hash into a flat array, serialise once in `endRender`). Removes per-call template-literal cost while keeping `<rect>` element kind. Estimated **2–4 ms / iter on canon-resize-drag** if `endRender` cost stays sub-linear. **(S)**, low-medium risk, fundamentally different shape from EW-4/EW-5.

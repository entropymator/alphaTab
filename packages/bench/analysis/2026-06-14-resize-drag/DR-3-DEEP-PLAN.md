# DR-3 — SvgCanvas paint API: deeper research

**Status**: planning round, deeper research.  Not started.
**Branch / HEAD**: `feature/perf` at `2b742569` (docs-only since EW-11 paint bundle landed at `e01ba2a2`).
**Scenario**: `canon-resize-drag`.
**Authoritative σ baseline**: `baselines/post-EW11.json` — `232.26 ± 1.67 ms (0.72 % σ)`.
**Resolution gates**: 1 % floor = **2.32 ms**, 2σ = **3.34 ms** (the `★` cutoff in this round).
**TOP30 anchor**: `packages/bench/runs/post-EW11/canon-resize-drag/TOP30.md`.

This is a **deeper-research** plan beyond EW-10 Phase A / Phase B and
EW-11.  The user's three explicit research directions define the scope:

1. **Template→concat completeness** — finish the audit started by EW-10 / EW-11.
2. **Centralized scale / viewBox** — move `* scale` work out of the per-emission hot path entirely.
3. **State-of-the-art SVG string-building** — survey JS SVG generators, V8 internals, and DOM-direct approaches.

The plan investigates ALL THREE.  It ranks them, recommends a primary,
and lays out a phased migration.  **No code edits, no source touch** —
this round is investigation + plan + research only.

---

## 1. Goal & framing (plain English)

### 1.1 Where the surface actually is

Post-EW-11, the SvgCanvas paint primitives are still collectively the
single largest CPU surface on `canon-resize-drag`.  From
`packages/bench/runs/post-EW11/canon-resize-drag/TOP30.md`:

| # | % CPU | Self ms / iter | Function | Status |
|---:|---:|---:|---|---|
| 1 | 8.49 % | 165.89 / trial → ~20.7 ms / iter | `fillRect` | EW-10 Phase A scale=1 fast path landed |
| 4 | 3.22 % | 62.98 / trial → ~7.9 ms / iter | `fillText` | EW-11 scale=1 fast path landed |
| 7 | 2.72 % | 53.26 / trial → ~6.7 ms / iter | `_fillMusicFontSymbolText` | EW-11 scale=1 fast path landed |
| 8 | 2.35 % | 45.96 / trial → ~5.7 ms / iter | `lineTo` | EW-11 scale=1 fast path landed |
| 9 | 2.34 % | 45.80 / trial → ~5.7 ms / iter | `paintBackground` | wraps fillRect — `BarRendererBase.paintBackground` |
| 14 | 1.50 % | 29.41 / trial → ~3.7 ms / iter | `paintBar` | DR-3-adjacent |
| 19 | 1.23 % | 24.01 / trial → ~3.0 ms / iter | `moveTo` | EW-11 scale=1 fast path landed |

Numbers above are summed across 5 trials in TOP30; divided by 5 trials × 8 iterations per trial = 40 (TOP30 records the cumulative profile across the whole run loop). The relative ranking is the load-bearing fact.

Combined SvgCanvas emission surface ≈ **21 % of canon-resize-drag CPU
= ~49 ms / iter** (232 ms × 0.21).  Even with the EW-10 / EW-11 fast
paths landed, this is the largest single shape left.

### 1.2 The user's three directions

The user wrote:

> 1. String Templates are known to be slower than concatenation in V8.
>    Previous refactorings showed significant improvement, and we still
>    have quite some areas where we interpolate instead of concatenate.
> 2. Scale handling in SVG could maybe be centralized with a central
>    scale/viewbox scaling mechanism?
> 3. Research possibilities to efficiently compute such complex SVGs.
>    This is likely a known challenge in the market.  StringBuilders are
>    common in C#/Java, and likely in JavaScript engines this is a common
>    performance hotspot.

These are three distinct directions:

- **Direction 1** (§2) — finish the template→concat audit.  Tactical;
  small per-call Δ; large aggregate Δ if every remaining site bundles.
- **Direction 2** (§3) — centralized scale via root-`<svg>` transform /
  `viewBox`.  Architectural; eliminates **all** per-emission `*scale`
  work; risk surface is correctness (stroke widths, font sizes,
  BoundsLookup contract).
- **Direction 3** (§4) — state-of-the-art SVG string-building research.
  External survey; may surface a structurally different approach that
  subsumes Direction 1 / 2.

### 1.3 What this plan deliberately is NOT

- **Not** a "just do all three" plan.  The directions interact; doing
  them out of order pessimises the others (e.g. Direction 1 spends
  effort on `*scale` branch overhead that Direction 2 deletes
  entirely).  §5 documents the interaction matrix.
- **Not** a Goodhart trap.  Per the user's prior rejection (DR-1 next
  slice → Phase 0 falsification at `2b742569`), every option in §6
  carries a `Goodhart-honesty` assessment — would the change help in
  production, or only in the bench?
- **Not** a complete commit of the recommended primary.  The plan
  ends at "Phase 0 empirical probes done, recommendation ratified or
  falsified, single-commit pilot landed; full migration phased."

### 1.4 A/B reference anchor

A/B baseline is `2b742569` — the current `feature/perf` HEAD, docs-only
since EW-11 landed at `e01ba2a2`.  This includes:
- EW-10 Phase A `fillRect` fast path (`244c8e0b`).
- EW-11 paint bundle `fillText` + `moveTo` + `lineTo` +
  `_fillMusicFontSymbolText` (`e01ba2a2`).
- EW-7 `_escapeText` short-circuit (`2251590d`).
- EW-3 tab-number gap cache (`4f89adda`).
- DR-1 broker-lifecycle (`eddf9bc1`).

DR-3 is layered **on top** of all of these.  σ floor for `★` is **≥ 3.34 ms**.

---

## 2. Direction 1 — Template-literal completeness audit

### 2.1 The pattern, refined

EW-10 Phase A (`244c8e0b`) and EW-11 (`e01ba2a2`) established the
shape: when `this.scale === 1`, emit with manual `'+'` concat;
otherwise emit with the existing template literal.  Two mechanisms:

1. **Eliminate the `*scale` multiplies** at scale=1.
2. **Swap template literal for `+` concat**.  Both call
   `Number.prototype.toString` for numeric interpolands, so the output
   is byte-identical (§5.3 of EW-11 plan), but template literals carry
   a V8 IC and slice/cons-rope overhead that `+`-concat does not on
   this hot path.

The combined Δ on the four EW-11 methods at n=128 paired was -2.45 ms.
The fillRect-alone Δ was -4.14 ms at n=64.

### 2.2 Remaining emission methods in scope

EW-11 §2.4 audited every emission method in `SvgCanvas.ts` and
classified them.  Below is the same audit re-grounded against the
**post-EW-11** profile (the TOP30 above).  Status column reflects what
has landed.

| Method | File:line | Body shape | Scale=1 helps? | Status | Estimated calls/iter | Est. Δ from completeness audit |
|---|---|---|---|---|---:|---:|
| `fillRect` | `SvgCanvas.ts:52` | Template; 4 `* scale` | YES | **LANDED (EW-10 Phase A)** | 114,307 | 0 (already done) |
| `strokeRect` | `SvgCanvas.ts:81` | Template; 4 `* scale` + conditional `stroke-width` | YES | **OPEN** | unknown — Phase 0 needed; EW-11 estimate was "L" (TimerGlyph?) | 0.1-0.4 ms |
| `moveTo` | `SvgCanvas.ts:100` | Template; 2 `* scale` | YES | **LANDED (EW-11)** | 19,383 | 0 |
| `lineTo` | `SvgCanvas.ts:113` | Template; 2 `* scale` | YES | **LANDED (EW-11)** | 46,034 | 0 |
| `quadraticCurveTo` | `SvgCanvas.ts:124` | Template; 4 `* scale` | YES | **OPEN** | Phase 0 needed; TieGlyph + LineRangedGlyph callers | 0.2-0.5 ms |
| `bezierCurveTo` | `SvgCanvas.ts:129` | Template; 6 `* scale` | YES | **OPEN** | Phase 0 needed; TieGlyph primary caller | 0.2-0.5 ms |
| `fillCircle` | `SvgCanvas.ts:136` | Mutates params (`x *= this.scale`), then path concat | YES | **OPEN** | BarLineGlyph dotted barlines only — likely low | 0.05-0.15 ms |
| `strokeCircle` | `SvgCanvas.ts:149` | Same as fillCircle | YES | **OPEN** | Tab-note circle markers — low volume | 0.05-0.15 ms |
| `fill` | `SvgCanvas.ts:162` | Conditional template literal; **no `*scale`** in body | NO | **OPEN** | Once per path-build; volume = number of `fill()` calls per iter | 0.1-0.3 ms (template→concat only) |
| `stroke` | `SvgCanvas.ts:174` | Conditional template; `lineWidth * scale` | YES (when `lineWidth !== 1 || scale !== 1`) | **OPEN** | Once per stroked path; bench leans heavily on fill, not stroke | 0.05-0.2 ms |
| `fillText` | `SvgCanvas.ts:187` | Template; conditional fragments | YES | **LANDED (EW-11)** | 26,673 | 0 |
| `beginRotate` | `SvgCanvas.ts:303` | Template; 2 `* scale` | YES | **OPEN** | Rotated text in StaffSystem labels — low volume | 0.02-0.10 ms |
| `beginGroup` | `SvgCanvas.ts:39` | One template, 1 interp, no `* scale` | NO | **OPEN** | M — Phase 0 to count | 0.05-0.15 ms (template→concat only) |
| `endGroup` / `endRender` / `closePath` | various | Literal append | n/a | n/a | n/a | 0 |
| `_fillMusicFontSymbolText` | `CssFontSvgCanvas.ts:38` | See §4.4 of EW-11 plan | YES | **LANDED (EW-11)** | 34,471 | 0 |

**Remaining surface estimate** (sum of "Est. Δ" column, open rows):

| Tier | Est. Δ / iter |
|---|---:|
| `quadraticCurveTo` + `bezierCurveTo` + `strokeRect` | 0.5-1.4 ms |
| `fill` + `stroke` template→concat (no scale gain) | 0.15-0.5 ms |
| `fillCircle` + `strokeCircle` + `beginRotate` + `beginGroup` | 0.17-0.55 ms |
| **Sum** | **0.82 - 2.45 ms** |

The sum is **below the σ floor** (2.32 ms 1 %, 3.34 ms 2σ) — in the
best case it might just clear 1 %, in the realistic case it's solidly
sub-σ.  The honest assessment: **Direction 1 is reaching the bottom of
the well**.  Each remaining site is below σ standalone; even the bundle
of all of them likely doesn't clear 2σ.

### 2.3 What Phase 0 needs to instrument

To ratify or falsify the "0.82-2.45 ms" estimate:

1. Wrap each open method with `process.hrtime.bigint()` counters
   identical to EW-11 Phase 0 (`packages/bench/scripts/phase0-ew11-probe.mjs`).
2. Add: `strokeRect`, `quadraticCurveTo`, `bezierCurveTo`,
   `fillCircle`, `strokeCircle`, `fill`, `stroke`, `beginRotate`,
   `beginGroup`.
3. Run `node dist/run.mjs --only canon-resize-drag --trials 1
   --label phase0-DR3-direction1`.
4. Report calls/iter, ns/call, total ms/iter, scale=1 hit rate per
   method.

### 2.4 Phase-A2-bundle sketch (if Phase 0 ratifies)

If Phase 0 finds the open-method sum is **≥ 2 ms** (cleared by n=128
A/B), bundle the highest-volume subset (`strokeRect`,
`quadraticCurveTo`, `bezierCurveTo`, plus `fill`+`stroke` template→
concat) into a single commit.  Same shape as EW-11.

If Phase 0 finds the open-method sum is **< 1.5 ms**, **falsify
Direction 1** and shift weight to Direction 2 / 3.

### 2.5 Direction 1 Goodhart-honesty assessment

- **Production?** Marginal.  The fast paths help any user with
  `display.scale === 1` AND `Environment.highDpiFactor === 1` — i.e.,
  pixel-ratio-1 desktop browsers at default zoom.  HiDPI users
  (Retina, 125 % Windows scaling) hit the slow path and get no benefit.
  This is a real population, but is also the bench's population.
- **Bench-honest?** Yes — same shape as landed EW-10 / EW-11.  No
  Goodhart trap because the output is byte-identical and the gain is
  arithmetic-real (skipped multiplies + skipped template-literal IC),
  not "rasteriser gets less work."

### 2.6 Direction 1 verdict

**Cap, but don't reject**.  Phase 0 instrumentation is cheap (~30
min); if the bundle clears ~2 ms in aggregate, ship it as DR-3.A.  If
not, formally close the EW-template-completeness sub-thread and shift
to Direction 2.

---

## 3. Direction 2 — Centralized scale / viewBox

### 3.1 The architectural shape

Instead of multiplying every coordinate by `this.scale` at emission
time:

```ts
this.buffer += `<rect x="${x * s}" ...`;
```

place the scale **once** at the root `<svg>`:

**Option 2a — viewBox**:
```
<svg viewBox="0 0 W H" width="${W * s}" height="${H * s}" ...>
  <rect x="${x}" y="${y}" .../>
</svg>
```

**Option 2b — root `<g transform="scale(s)">`**:
```
<svg width="${W * s}" height="${H * s}" ...>
  <g transform="scale(${s})">
    <rect x="${x}" y="${y}" .../>
  </g>
</svg>
```

Both push the scale out of every emission method.  The per-call work
collapses from `<rect x="${x*s}" ...>` (4 multiplies + 4 template
interpolations) to `<rect x="${x}" ...>` (0 multiplies + 4 template
interpolations) — and the scale=1 fast paths from EW-10 / EW-11
become **identity** because there is no longer any difference between
scale=1 and scale!=1 at the emission site.

### 3.2 The full surface eliminated

Every `* this.scale` in `SvgCanvas.ts` (29 occurrences in 14 method
bodies, per the §2.2 grep) collapses to a no-op.  The scale=1
short-circuit branches (EW-10 / EW-11) collapse to single-form
emission.  The `lineWidth * this.scale` in `strokeRect` / `stroke`
collapses to `lineWidth` alone (under transform-scale, strokes scale
automatically — see §3.4.2).

**Per-iter Δ ceiling** (very rough — Phase 0 will sharpen):

| Source | Estimated Δ |
|---|---:|
| Eliminate `*scale` multiplies × 29 sites × ~30k aggregate calls × ~3 ns | 1.5-3 ms |
| Eliminate `if (s === 1) { fastpath } else { slowpath }` branch overhead | 0.3-0.8 ms |
| Eliminate `font.toCssString(scale)` call (always `scale=1` now, single cache slot) | 0.1-0.3 ms |
| Eliminate `relativeScale` second-level scale in `_fillMusicFontSymbolText` (98.8 % of calls were already `relativeScale === 1`; the remaining 1.2 % can still emit a font-size attr) | 0.1-0.3 ms |
| **Sum** | **2.0 - 4.4 ms** |

**Plus code-clarity gain**: 14 method bodies simplify dramatically.
The post-EW-11 `fillRect` body shrinks from a 30-line dual-path block
to a one-line single template, with no behavioural change at scale=1.
That's a non-perf benefit worth weighing — but cannot be the sole
justification.

### 3.3 What changes in the emitted SVG output

**Before** (current, `display.scale = 1.0`, `Environment.highDpiFactor = 1`):

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="970px" height="800px" class="at-surface-svg">
  <rect x="100" y="50" width="200" height="60" fill="#000000" />
  ...
</svg>
```

**Before** (current, `display.scale = 1.5`, `Environment.highDpiFactor = 2`):

The bench sets `scale = settings.display.scale` so for `display.scale =
1.5` the emitted output is:

```xml
<svg width="1455px" height="1200px" class="at-surface-svg">
  <rect x="150" y="75" width="300" height="90" fill="#000000" />
  ...
</svg>
```

(coords pre-multiplied by 1.5; the layout layer pre-multiplied
`width/height` per `ScoreLayout.ts:148`).  Note that
`Environment.highDpiFactor=2` is a **separate** scale applied at the
device level — Html5Canvas does both (`this._context.scale(highDpiFactor * scale, ...)`).
SvgCanvas currently ignores highDpiFactor because the browser handles
DPR on SVG nodes automatically through CSS pixel scaling.

**After** (Option 2a, `display.scale = 1.5`):

```xml
<svg viewBox="0 0 970 800" width="1455px" height="1200px" class="at-surface-svg">
  <rect x="100" y="50" width="200" height="60" fill="#000000" />
</svg>
```

The viewBox maps the logical 970×800 coordinate space to the rendered
1455×1200 pixel box, applying the 1.5× scale at rasterise time.

**After** (Option 2b, `display.scale = 1.5`):

```xml
<svg width="1455px" height="1200px" class="at-surface-svg">
  <g transform="scale(1.5)">
    <rect x="100" y="50" width="200" height="60" fill="#000000" />
  </g>
</svg>
```

### 3.4 The risk surface

#### 3.4.1 BoundsLookup pixel-coord contract

**This is the biggest risk.**

`ScoreRenderer.ts:226` calls `this.boundsLookup?.finish(this.settings.display.scale)`.
That walks the bounds tree and multiplies every `realBounds` /
`visualBounds` / `lineAlignedBounds` / `noteHeadBounds` by the scale
(`BeatBounds.ts:82-92`, `MasterBarBounds.ts:87-110`,
`StaffSystemBounds.ts:47-56`, `NoteBounds.ts:28-31`).  After `finish`,
the boundsLookup returns **pixel-scaled** coordinates so cursor
overlays, mouse-hit tests, and `api.uiFacade.scrollToY` can position
DOM elements at the correct on-screen pixel.

**Consumers** (grep-confirmed via §intro):
- `AlphaTabApiBase.ts:1020-1101` — public docs explicitly tell users
  to read `bounds.visualBounds` / `realBounds` and pass those to
  `scrollToY` (pixel coords).
- `AlphaTabApiBase.ts:2404-2454` — cursor positioning uses
  `barBoundings.visualBounds` directly to set cursor `.style.left/top`.
- `AlphaTabApiBase.ts:3275-3297` — selection-range rendering uses
  `realBounds.x` / `realBounds.w` for the selection wrapper element
  size.
- External: documented `public` API surface (BoundsLookup is `@public`
  on `BoundsLookup.ts:14`).  Customers consume these as pixel coords.

**The constraint**: BoundsLookup pixel-scaled output **must remain
pixel-scaled** for API compat.  But the SVG painted output is now
logical (un-multiplied).  These two coordinate spaces will diverge
unless one of the following holds:

(a) The browser's SVG rasteriser applies the root transform / viewBox
    such that **on-screen pixels** at logical coord `(x,y)` land at
    DOM pixel `(x*scale, y*scale)`.  This is correct for both Option
    2a and 2b — the browser maps logical viewBox coords to the CSS
    width/height pixel box.  **So BoundsLookup pixel coords still
    point to the right on-screen pixel**, even though the SVG
    internally uses logical coords.

(b) Cursor overlay positioning continues to use
    `placeholder.style.left = ${renderResult.x}px` (`BrowserUiFacade.ts:685`).
    Since `renderResult` dims are scaled (`ScoreLayout.ts:148`:
    `args.width *= scale`) and the placeholder is sized in pixel
    coordinates, the cursor lands at the right pixel.

**Conclusion**: the BoundsLookup contract is **preserved** under
either Option 2a or 2b because the BoundsLookup is the bridge between
the renderer's logical coord space and the DOM's pixel coord space —
and both halves of the bridge stay intact.  The SVG just maps the
logical space onto the pixel space via the root transform instead of
pre-multiplying.

**BUT** — vitest does pixel-diff on the rendered PNG, and the
**rendered** PNG is the rasterised SVG.  If the rasteriser produces
even subpixel differences between "coords pre-multiplied" and
"coords + root-scale-transform" outputs, vitest will flag them.  This
is the **load-bearing test** for Direction 2's correctness.

#### 3.4.2 Stroke widths

Under SVG `transform="scale(s)"`, stroke widths scale proportionally.
At `display.scale = 1.5`, a `stroke-width="1"` becomes a 1.5-pixel
visible stroke.

Current SvgCanvas emissions (`SvgCanvas.ts:87`, `:178`) do
`lineWidth * this.scale` to pre-multiply the stroke width.  If we
centralize via Option 2b (`<g transform="scale(s)">`), we'd want to
**remove** the `* this.scale` from these — otherwise we'd double-scale
(emitted `lineWidth * s` × transform `s` = `lineWidth * s²`).

For Option 2a (viewBox), it depends: `viewBox` without an explicit
`vector-effect="non-scaling-stroke"` also scales stroke widths.  So
the same removal applies.

**Verification step**: emit a fixture with `stroke-width="1"` and
`scale=1.5`, render via Skia (vitest harness), confirm the stroke
visually matches the current (pre-multiplied) output's appearance.

**Escape hatch**: `vector-effect="non-scaling-stroke"` (an SVG
attribute supported on `<rect>`, `<line>`, `<path>`, etc.) prevents
the stroke from scaling.  Could be applied selectively if some sites
need pixel-precise strokes regardless of scale.  Probably not needed
for alphaTab — the current code already scales strokes with display
scale, so the new behaviour matches.

#### 3.4.3 Font sizes — the dangerous double-scale

`Font.toCssString(scale)` at `Font.ts:482-498` bakes the scale **into
the font-size string** (`buf += this.size * scale`).  So a 10-pixel
font at `display.scale = 1.5` currently emits CSS `15px sans-serif`.

Under Option 2b root-transform-scale, the CSS `15px` would then be
scaled AGAIN by the transform — final rendered size 22.5 px.  **This
is wrong.**

**Fix**: under centralized scale, `fillText` should call
`this.font.toCssString(1)` (or `toCssString()` with default arg) —
emitting `10px sans-serif` — and the root transform applies the 1.5×
scale for a final 15-pixel rendered size.  Equivalent visual output.

`_fillMusicFontSymbolText` (`CssFontSvgCanvas.ts:57-59`) emits an
explicit `style="font-size: ${scale * 100}%"` for the music-font
symbols.  Under centralized scale, that whole branch goes away —
just emit `style="stroke:none"` and let the root transform handle
the symbol scaling.  This is actually a code simplification (the
98.8 % `relativeScale=1` fast path collapses to the only path).

For `relativeScale !== 1` (the 1.2 % case — multi-bar rests, grace
notes), `font-size: ${relativeScale * 100}%` is still emitted.  The
root transform applies `display.scale` on top.  Final visual size:
`base_size × relativeScale × display.scale`.  Same as today.

**Audit needed**: confirm `Font.toCssString` is the **only** place
that bakes scale into a CSS string.  Grep for `* scale` patterns in
font and CSS-emission paths.

#### 3.4.4 Sub-pixel anti-aliasing and hinting

Browser SVG rasterisers apply sub-pixel anti-aliasing per
device-pixel grid.  At `display.scale = 1`, current SvgCanvas emits
integer pixel coordinates (e.g. `<rect x="100" y="50" ...>`); the
rasteriser aligns these to integer device pixels and the AA is sharp.

Under Option 2a (viewBox), the user-space coords go through a
transformation matrix.  At `scale = 1`, the matrix is identity — no
change.  At `scale = 1.5`, current code emits `x="150"` directly;
new code emits `x="100"` plus viewBox `scale(1.5)`.  The browser's
matrix produces `100 * 1.5 = 150` as the final device-pixel coord.
**Mathematically identical**.

**Risk**: floating-point matrix arithmetic vs integer pre-multiply.
At irrational scales (e.g. 1.333 from a 3-pt zoom level) the matrix
result may differ from the pre-multiplied result in the last bit.
This is a sub-pixel difference, not a logical one.  vitest's pixel
diff at threshold > 0 tolerates it.

**At `scale = 1`** (the bench workload, 100 % of canon-resize-drag),
**no AA difference can occur** because the matrix is identity.  This
is the strongest argument that vitest at scale=1 will produce zero
diffs.

**At scale != 1** (HiDPI / user-zoom paths), there may be subpixel
diffs.  These need a per-fixture audit in Phase 0 — render the same
score at scale=1.5 with both code paths and compare PNG.

#### 3.4.5 Browser SVG rasteriser behaviour

The bench is Node-side string-building only.  It does NOT measure
the browser's rasterise cost.  Question: **does adding a root
transform make the browser's rasterise pass slower?**

Likely answer: no, or negligibly.  Browsers compile the root
transform into the rasteriser's matrix once per `<svg>` element.
The per-rect rasterise cost is dominated by tessellation + fill,
not transform multiplication.  But this is unverified by the
Node-side bench.  Production users would see the rasterise change.

**Mitigation**: include a vitest run on the recommended option.
vitest renders via Skia, not the browser SVG engine, but Skia is
representative for "SVG fed through a matrix transform" cost.

#### 3.4.6 Caller-side dependencies on absolute pixel coords

Grep from §intro showed ~30 sites with `* settings.display.scale` or
`* scale` patterns in the rendering layer.  These are mostly
**inside** rendering glyphs that already compute in logical
coordinates and pass logical coordinates to the canvas (which then
multiplies by scale).  Under Direction 2, those inner computations
stay unchanged — they continue to use logical coords.  Only the
**canvas emission** drops the `*scale` step.

Sites that genuinely depend on pixel coords:
- `ScoreLayout.ts:63` — `Math.round(this.width / this.renderer.settings.display.scale)`.
  Converts pixel width back to logical width.  Unaffected.
- `ScoreLayout.ts:148` — `args.width *= scale`.  Publishes pixel-scaled
  width on `RenderFinishedEventArgs`.  Unaffected; the SVG `width=`
  attribute still uses the scaled value (just at the root, not on
  every rect inside).
- `VerticalLayoutBase.ts:59/135/163/395` — `(y + pagePadding) * scale`
  for the total page height.  Same as above: publishes pixel value
  externally, internal coords stay logical.  Unaffected.
- `Html5Canvas.ts:50-59` — does `_context.scale(highDpiFactor * scale, ...)`.
  Already uses the centralized-scale pattern!  This is **prior art
  inside the same codebase** for Direction 2.

**The Html5Canvas precedent is load-bearing**: Direction 2 brings
SvgCanvas in line with the already-shipped Html5Canvas pattern.  If
Html5Canvas works correctly (and the bench harness uses
Html5Canvas-equivalent rendering in some tests), then the centralized-
scale approach is known-good for alphaTab's coordinate system.

#### 3.4.7 The Skia / vitest harness

vitest visual tests use the Skia rendering path
(`SkiaCanvas.ts`), not SvgCanvas, for pixel-diff verification.  This
is a **mismatch**: vitest cannot directly catch SVG-rasteriser
differences between centralized-scale and per-emission-scale modes.

What vitest **can** catch:
- Logical coordinates wrong (a glyph at the wrong x/y).
- Stroke width wrong (a 1px line becoming a 2px line).
- Font size wrong (text larger or smaller than reference).
- Color / alpha wrong.

What vitest **cannot** catch:
- Sub-pixel SVG rasterisation differences specific to the browser
  engine.
- viewBox vs explicit dims interpretation diffs.

**This argues for a supplementary Phase 0 probe**: write a tiny
HTML fixture, load both code paths in a headless browser
(Puppeteer / Playwright), pixel-diff the rendered output across
several browser engines (Chromium, Firefox).  This is more work
than the standard vitest gate, but it's the **only** way to catch
browser-specific regression.

If that's too much work for Phase 0, the alternative is to **only
test at `scale === 1`** in vitest and ship Direction 2 with a
caveat: "HiDPI / user-zoom regression possible; manual browser-side
audit required before lifting the scale=1 limitation."  Less
principled but tractable.

### 3.5 Direction 2 Goodhart-honesty assessment

- **Production?** YES, broadly.  Every user — scale=1 desktop, HiDPI
  desktop, mobile, embedded — sees the same Δ.  The per-emission
  multiplies are pure waste under root-transform semantics.  This is
  **not** a bench-only win.
- **Bench-honest?** YES.  The Node-side string-building cost drops
  for the reasons in §3.2.  No measurement gimmick.
- **Caveat**: the browser-side rasterise cost is **unmeasured** by
  the bench.  Production users may see a slight increase in
  rasterise cost if the browser's transform-matrix application is
  more expensive than no-transform.  Vanishingly likely to outweigh
  the Node-side savings, but cannot be claimed without a browser
  bench.

### 3.6 Phase 0 mandate for Direction 2

This is the **load-bearing Phase 0**.  Direction 2 cannot ship
without it.

1. **Build a one-fixture proof**: write a tiny score (1 bar, 1
   beat, 1 note) and render it twice:
   - via SvgCanvas at HEAD `2b742569` with `display.scale = 1.0`.
   - via SvgCanvas with a hand-applied Direction-2 patch (root
     transform-scale + emissions stripped of `*scale`) at
     `display.scale = 1.0`.
2. **Compare SVG text byte-for-byte**: the two outputs will differ
   structurally (root transform present vs not), but at scale=1, all
   coordinate values inside should be identical.  Diff and confirm.
3. **Compare Skia-rendered PNG**: feed both SVG strings to a Skia
   rasteriser via the existing vitest harness, pixel-diff.  Expect
   zero diffs at `scale === 1` (root transform is identity).
4. **Repeat at `scale = 1.5`**: now the two outputs diverge
   structurally AND in numeric coordinate values (one has
   pre-multiplied coords, one has logical coords + transform).  The
   final rendered PNGs should still match within the vitest pixel
   tolerance.
5. **Repeat at `scale = 2.0`** (integer scale, easier on FP
   arithmetic) and `scale = 1.333` (non-trivial fractional).
6. **Audit `Font.toCssString` consumers**: confirm passing `scale=1`
   under Direction 2 produces correct visual output.  This is part
   of step 2-3 above but worth calling out as a checklist item.
7. **Browser-side smoke test** (optional, if time): render the same
   fixture in headless Chromium with both code paths.  Pixel-diff.

**Decision gate after Phase 0**:

| Outcome | Action |
|---|---|
| All four scale variants pass pixel-diff at vitest tolerance | Proceed to Phase 1 (single-method pilot — `fillRect`). |
| Scale=1 passes, but scale!=1 produces diffs | Investigate.  If sub-pixel-only and within tolerance, OK.  If logical-coord-wrong, falsify. |
| `vector-effect` needed on some sites to preserve stroke width | Add as a per-site decoration in Phase 1; not a blocker. |
| Skia rasteriser produces visible diffs even at scale=1 | **Falsify Direction 2**.  Move to Direction 3 / 1. |
| BoundsLookup pixel-coord assertion (cursor lands at logical coord) breaks | Falsify.  Either the model is wrong or there's a hidden consumer outside the §3.4.1 list. |

### 3.7 Direction 2 phased migration sketch

If Phase 0 ratifies, the migration is **not** a single commit.  Too
many emission methods change at once; visual-test class-A regressions
would be hard to bisect.

**Phase 1 — pilot, `fillRect` only**: add the root transform-scale to
`SvgCanvas.beginRender`; drop the `*scale` from `fillRect`.  Leave
all other methods at the EW-10/EW-11 form (which now correctly emit
logical coords because their `*scale` happens to be a no-op at
`scale=1`, but emit doubled coords at `scale!=1`).  This means
**Phase 1 breaks scale!=1 for every non-fillRect method**.

To avoid breakage, Phase 1 is **not** a pilot — it's a flag-day
migration of all methods simultaneously, because root-transform
applies globally.  Therefore:

**Phase 1 — convert ALL methods simultaneously**.  Drop `*scale` from
every method body; update `font.toCssString(scale)` → `toCssString(1)`
in `fillText`; remove the `font-size: ${scale*100}%` from
`_fillMusicFontSymbolText`; remove `stroke-width="${lineWidth * scale}"` from
`stroke` / `strokeRect`; add the root transform in `beginRender`.

One commit. Touches `SvgCanvas.ts` and `CssFontSvgCanvas.ts`.

**Phase 2 — A/B at n=64**: paired against `2b742569`.  Expected Δ:
2-4 ms.  Decision: ≤ -3.34 ms = `★`, ship.  Marginal? n=128.

**Phase 3 — full vitest pass**.  1599/1599 expected.

**Phase 4 — cross-scenario A/B at n=32, no `--only`**.  Confirm no
regression on canon-render, nightwish-render, tiny-render,
fade-to-black-resize.

**Phase 5 — HiDPI manual smoke test**.  Render at scale=1.5 and
scale=2.0 in a real browser; visually compare against a HEAD
screenshot.

**Phase 6 — land + docs update**.  Move EW-10 / EW-11 entries in
HOTSPOTS.md to "Subsumed by DR-3"; add DR-3 entry under "Major
refactors — landed".

### 3.8 Direction 2 erosion budget

EW-10 / EW-11 spent the per-call branch-overhead budget already.  If
Direction 2 lands, the EW-10 / EW-11 scale=1 branches become dead
code (the slow path no longer exists because there is no slow path —
everything emits logical coords).  The simplification is part of the
Direction 2 commit; the result is shorter than the post-EW-11 source.

---

## 4. Direction 3 — State-of-the-art SVG string-building research

### 4.1 What the user is asking

> Research possibilities to efficiently compute such complex SVGs.
> This is likely a known challenge in the market.  StringBuilders are
> common in C#/Java, and likely in JavaScript engines this is a
> common performance hotspot.

The user wants a survey of **how other libraries solve this**, not
just code-level micro-optimisation.  This section is intentionally
the longest because it's the research-shaped half of the round.

### 4.2 V8 internals — string concatenation cost model

Before surveying libraries, ground the V8 cost model:

**Cons strings (rope strings)**: V8 represents `a + b` (or `'' + a +
b`) lazily as a `ConsString` — a tree node with pointers to the two
operands.  No copy.  Building `s += x` repeatedly creates a tree of
ConsStrings.

**Flattening**: when the string is read (e.g., used in a regex, dumped
to console, passed to a JSON serializer), V8 walks the cons-tree and
flattens to a single contiguous string.  This is O(total length).

**Template literals**: V8 historically compiled template literals to
`String.prototype.concat` or an internal `_Concat` builtin.  Modern
V8 (since ~node 18) optimises constant-tag template literals to a
specialised concat path.  For numeric interpolations, the path is:
`ToString(x)` + concat into the accumulator.

**Key V8 fact for this surface**: when the buffer grows to ~100k
chars (typical alphaTab SVG output is hundreds of kilobytes), the
cons-tree walk to flatten on the final `innerHTML =` assignment is a
real cost.  But that cost is **constant per-iter** regardless of
whether the accumulation used `+` or template literals — both produce
ConsString trees.

**The actual V8 win from `+` over template literal in EW-10 / EW-11**
is the **IC overhead per emission site**: a template literal expression
goes through `JSEvaluateTemplate` which dispatches via an inline
cache; for numeric interpolations the IC has to type-check `x` (is it
a Smi? a HeapNumber? something else?) on every call.  Manual `+`
concat with known-numeric operands sticks to the fast TurboFan path.

**Refs** (from training knowledge):
- V8 blog post "Faster string concatenation" (~2018) on cons-rope
  flattening.
- Mathias Bynens / Benedikt Meurer talks on template-literal codegen
  in TurboFan (Node Collab Summit ~2019).
- The Chromium codebase's `src/objects/string.cc` documents the
  ConsString flattening invariants.

### 4.3 Survey: JS SVG generation libraries

#### 4.3.1 D3.js (`d3-selection`, `d3-shape`)

D3 emits SVG via direct DOM construction
(`document.createElementNS('http://www.w3.org/2000/svg', 'rect')`)
plus `setAttribute(key, value)` calls.  No string building.

**Why**: D3's mental model is data-driven DOM manipulation.  The
selection API (`selection.attr('x', d => d.x)`) walks the DOM and
updates attributes.  D3 never builds a string; it manipulates the
DOM tree directly.

**Performance characteristic**: each `setAttribute` is a real DOM
call with cross-realm overhead.  For ~30k attribute writes per
frame (the alphaTab volume) this would be **slower** than string
building, in the browser, because every setAttribute crosses the
JS↔Web-IDL boundary.

**Applicability to alphaTab**: NOT applicable in current form.  But
see §4.3.6 (D3 alternative emission).

#### 4.3.2 Snap.svg

Snap.svg is the spiritual successor to Raphael (which targeted IE
VML + SVG).  Snap uses direct DOM construction like D3.  Same
per-attribute IPC cost.

**Snap-specific optimisation**: Snap caches `createElementNS` results
via `Snap._.$.element` factory — a thin wrapper.  No fundamental
change to the model.

**Applicability to alphaTab**: NOT applicable.

#### 4.3.3 Konva

Konva is a 2D canvas library (not SVG primarily), but it has an SVG
export path.  The export uses a single string-building pass, similar
to alphaTab — building `'<svg>...'` chunks and concatenating.

**Konva's string-build path**: `Konva.Shape#toSVG()` accumulates
fragments via `'<' + tag + ...'`.  Manual `+` concat (not template
literals).  This **matches** the EW-10 / EW-11 pattern alphaTab is
moving toward.

**Source ref**: Konva GitHub `konvajs/konva`, `src/shapes/*.ts` —
each shape has a `toSVG()` method.  The patterns there are
`'<rect x="' + x + '"...'`.

**Applicability to alphaTab**: VALIDATES the EW-10 / EW-11
direction.  Konva ships at scale with this exact pattern.

#### 4.3.4 Fabric.js

Fabric uses a hybrid: canvas-first rendering with optional SVG export
via `toSVG()`.  The SVG export builds strings.

**Fabric's pattern**: `fabric.Object#toSVG` returns strings; the
caller concatenates them.  Per-shape it uses `[fragments].join('')`
rather than `+=` accumulation.

**Why the `.join`?** For a known-finite array, V8 can pre-size the
result buffer.  This avoids the cons-tree intermediate for moderately-
sized arrays (~10-100 fragments).  For very large arrays the cost is
comparable to `+`.

**Applicability to alphaTab**: alphaTab builds one giant accumulator
per render; the Fabric per-shape join wouldn't help directly.  But
the **pattern** — collect fragments into an array per render, join
once at `endRender` — is exactly EW-10 Phase B that was falsified.
§4.3.4 cross-ref: Phase B failed because the per-method push cost
exceeded the join savings on canon-resize-drag's volume.

#### 4.3.5 two.js

two.js is a render-agnostic 2D drawing library; SVG is one of three
backends.  The SVG backend uses **direct DOM construction** (like
D3) with **lazy attribute updates** — only setAttribute when the
property changed.  This is faster than naive setAttribute-every-frame
when the scene mostly doesn't change.

**Applicability to alphaTab**: alphaTab re-paints the entire surface
on every layout change, so the "only if changed" optimisation doesn't
help.  But the **incremental DOM** pattern (§4.3.6) is related.

#### 4.3.6 Incremental DOM / lit-html

lit-html (and Google's older incremental-dom) take a template-driven
approach: declare a template with placeholders, bind data, and the
library diffs against the existing DOM to update only changed
attributes/nodes.

**For SVG specifically**: lit-html's `svg` template tag works the
same way — declarative SVG fragments compile to efficient diff
updates.

**Applicability to alphaTab**: very high in theory, very low in
practice.  alphaTab's SVG content is largely re-emitted per render
because layout changes are width-driven (every iteration changes the
bar packing).  An incremental-dom approach would diff and find ~70 %
of attributes changed, plus the overhead of maintaining a virtual
DOM.  Probably not a win.

**BUT** — there's a different shape: **incremental string emission
with structural sharing**.  Emit fragments that are KNOWN to be
identical across renders (e.g., the `<svg xmlns=...>` header, the
`<g class="..."` group openers, the `</g></svg>` closers) as
**pre-built constant strings** rather than re-template-building them.
This is what EW-10 Phase A / EW-11 already do implicitly when they
swap `${this.color.rgba}` (a string field, no formatting) for
`+ this.color.rgba` — the field is read once, no IC.

#### 4.3.7 Servo's / Blink's internal SVG emission

Browser engines themselves serialise SVG (for `XMLSerializer.serializeToString`
on an SVG element).  Both Servo and Blink use a recursive-descent
emitter with a single `WTF::StringBuilder` (Blink) or `String` (Servo)
accumulator.  The accumulator is **buffer-pre-sized** when the engine
can estimate the output size; otherwise it grows geometrically (×2).

**Applicability to alphaTab**: V8 String doesn't have an
explicit `StringBuilder` with pre-allocated capacity exposed to JS.
The closest equivalents are:
- `Array.prototype.join` on a fragment array.
- Manual `'' + a + b + c` chain (cons-rope tree).
- Modern: `String.prototype.concat(...args)` rarely used.

There is no equivalent of `WTF::StringBuilder.reserve(n)` for JS
strings.  The user's intuition that "StringBuilders are common in
C#/Java" is correct; V8 does NOT expose one.  **This is a real gap**.

#### 4.3.8 SAXON / XSLT-style template caching

Some XML emitters (XSLT processors, SAX serializers) pre-compile
templates with slot positions.  E.g., the template
`<rect x="@1" y="@2" width="@3" height="@4" fill="@5" />` is parsed
once into a `[const_prefix, slot_1, const_after, slot_2, ...]` array;
at emit-time, only the slot values are formatted and joined.

**Applicability to alphaTab**: This is **DR-3.E** in the option
matrix below.  It's a stronger version of Direction 1 — captures the
template-literal IC cost more completely by pre-computing the
constant chunks.  Modern V8 JITs may already be doing this implicitly
for constant-tagged template literals; testing whether explicit slot
emission beats template literals would be a microbench.

#### 4.3.9 The C#/Java StringBuilder reference

In C#, `StringBuilder` is a mutable buffer with `Append(int)`,
`Append(string)`, and `ToString()`.  Internally it's a linked list
of `char[]` chunks; `Append` writes into the current chunk, allocates
a new chunk on overflow, and `ToString` flattens.

Java's `StringBuilder` is similar but uses a single growable `char[]`.

**JS equivalent**: closest is `Array<string>` + `Array.join` at the
end.  Functional equivalent, but:
- `array.push(fragment)` has the per-push overhead (a real function
  call, IC, capacity check).
- `array.join('')` walks the array, computes total length, allocates
  one final string, copies all fragments.  This is O(total) and is
  what `WTF::StringBuilder` does in Blink.

EW-10 Phase B tried exactly this (typed-array buffer with single
flush at endRender) and **falsified** on canon-resize-drag's
workload: the per-method `array.push` cost exceeded the savings from
single-allocation flush.

**Why did Phase B fail?** Three hypotheses:
- Hypothesis A: the per-push cost is real (function call + IC).
- Hypothesis B: the `+=` accumulator in V8 is faster than expected
  because of cons-rope laziness — V8 doesn't actually allocate until
  flush.
- Hypothesis C: the savings expected from "single flush" were illusory
  because V8 already does cons-rope flattening once at the
  `innerHTML = buffer` boundary.

Combining B + C is the likely explanation.  V8's cons-rope means
`s += x` is effectively a `array.push` already, internally, with
amortised O(1) cost.  Phase B added an explicit JS-level array.push
on top, doubling the work.

**Implication for Direction 3**: typed-array-buffer + single-flush
is **not** a winning shape for alphaTab.  V8 already does the
moral equivalent under the hood.

### 4.4 Direct DOM construction — the radical alternative

Instead of building strings and then `innerHTML = buffer`, construct
DOM nodes directly:

```ts
const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
rect.setAttribute('x', x);
rect.setAttribute('y', y);
// ...
svgElement.appendChild(rect);
```

**Pros**:
- No string-building cost at all.
- No `innerHTML` parsing cost (which is non-trivial for ~500 KB SVG).
- Incremental updates possible (touch only changed attributes).

**Cons**:
- ~30k DOM calls per iter × ~100 ns per setAttribute = 3 ms minimum
  (browser-side; Node-side is irrelevant since there's no DOM).
- Cross-realm IPC overhead in Chrome (each Web-IDL call is a
  V8↔Blink hop).
- Memory: each Node is ~200 bytes vs ~50 bytes of string data per rect.

**The Node-bench vs browser asymmetry**: the bench measures
Node-side string-building.  In Node, `innerHTML` doesn't exist;
the SVG string is just passed through.  Switching to DOM
construction would make the bench essentially free (no string
work) and the browser potentially slower (DOM IPC).  **This is the
canonical Goodhart trap**: the bench would show a massive win that
production wouldn't see.

**Applicability**: **REJECT** as a primary direction unless we add
a browser-side bench harness.

### 4.5 Pre-rendered fragment templates with slot substitution

A hybrid of Direction 1 and Direction 3.8:

```ts
// Pre-built at module load (once):
const RECT_PRE = '<rect x="';
const RECT_Y = '" y="';
const RECT_W = '" width="';
const RECT_H = '" height="';
const RECT_FILL = '" fill="';
const RECT_END = '" />\n';

public fillRect(x, y, w, h): void {
    if (w > 0) {
        const s = this.scale;
        if (s === 1) {
            this.buffer += RECT_PRE + x + RECT_Y + y + RECT_W + w + RECT_H + h + RECT_FILL + this.color.rgba + RECT_END;
        } else {
            // slow path
        }
    }
}
```

**Theory**: V8 can intern the string literals once; the per-call
work is just the numeric ToString + concat.  No template-literal IC.

**EW-10 Phase A practice**: this is **already what the landed code
does** — inline string literals get interned by V8 automatically, so
the `'<rect x="'` literal in the body becomes a single interned
string after the first JIT pass.  No additional optimisation
available by externalising the constants.

**Verdict**: not actionable.  V8 already does this implicitly.

### 4.6 Compile-time SVG specialisation (Vite plugin)

The alphatab build chain has a Vite plugin (`packages/tooling/src/`)
that already does AST-level transforms (e.g., `elementStyleUsingPlugin`
mentioned in EW-7 / EW-8 commits).  A more aggressive plugin could:

1. Recognise SvgCanvas emission methods at build time.
2. Compile a **specialised version per scale value**:
   `fillRect_scale1` (no multiplies, hardcoded format) vs
   `fillRect_scaleN` (templated).
3. Dispatch at `beginRender` based on `this.scale`.

This trades **run-time work for build-time + code-size**.  The
specialised methods would be ~30 lines each; with ~14 emission
methods × ~3 scale variants typical (1.0, 1.5, 2.0), the build output
grows by maybe 1-2 KB minified.  Not catastrophic.

**Δ expectation**: marginal beyond what EW-11 already extracts.  The
specialised method dispatches on instance-property read (`this.scale`)
once at the call site; the body is then monomorphic.  V8's IC may
already produce this effect via inline-cache speculation.

**Verdict**: high implementation cost, marginal incremental benefit
over EW-10 / EW-11 + Direction 2.  **REJECT** as a primary; revisit
if Direction 2 falsifies.

### 4.7 Off-thread paint (WebWorker)

Build the SVG string on a worker thread.  Main thread does layout +
posts geometry; worker emits string; main thread does
`innerHTML = string`.

**Pros**: removes string-building from the main thread (TTI win).
**Cons**:
- Cross-thread transfer of geometry (postMessage serialisation).
- Doesn't reduce **total** CPU, just shifts it.
- alphaTab's data model (Beats, Bars, Glyphs) is not Transferable;
  would need a structured-clone or a parallel data representation.

**Verdict**: out of scope for DR-3.  Plausibly a separate research
direction.

### 4.8 SVG path coalescing

A weaker form of Direction 3 / EW-10 Phase B: instead of every
`<rect>` being its own element, coalesce multiple rects into a single
`<path>` element with `M ... L ... L ... Z` segments.

This was the EW-5 idea (paintStaffLines batches all rect segments
into one path/fill, per observation 17123).  It has merits but is
per-caller-site optimisation, not a paint-API change.

**Verdict**: orthogonal to DR-3.  Track separately if not landed yet.

### 4.9 Direction 3 verdict

The state-of-the-art survey produces:

| Technique | Verdict |
|---|---|
| Direct DOM construction (D3, Snap) | REJECT (Goodhart trap on Node bench) |
| Manual `+` concat (Konva) | VALIDATES Direction 1 |
| Pre-built template constants | Already done implicitly by V8 |
| `Array.join` once (Fabric) | Falsified by EW-10 Phase B |
| Incremental DOM (lit-html) | Not applicable (full re-render per layout change) |
| Slot-substitution templates | Equivalent to Direction 1 |
| Compile-time specialisation | High cost, marginal benefit |
| Off-thread paint | Out of scope |

**No structurally novel approach surfaces from the survey**.  The
state-of-the-art for performance JS SVG emission is **exactly the
pattern EW-10 / EW-11 / DR-3.B (Direction 2) describe**: manual
concat, centralised transform at the root.  This is mildly
disappointing as a research output but is the honest finding.

**Direction 3's contribution to the plan**: rule out the alternative
architectures.  Without this survey, "typed-array buffer" or
"DOM construction" might look attractive.  They are not.

---

## 5. Direction interaction matrix

The three directions interact:

### 5.1 If Direction 2 (centralized scale) lands

| EW-10 / EW-11 status | After Direction 2 |
|---|---|
| `fillRect` scale=1 fast path | **OBSOLETE** — no `*scale` to skip; single path |
| `fillText` scale=1 fast path | **OBSOLETE** |
| `lineTo` / `moveTo` scale=1 fast path | **OBSOLETE** |
| `_fillMusicFontSymbolText` scale=1 + relativeScale=1 nested fast path | **PARTIALLY OBSOLETE** — outer scale gone, inner relativeScale stays |

The EW-10 / EW-11 commits are NOT reverted — their `+`-concat (vs
template literal) wins remain because the manual-concat is still
faster than template-literal even at scale=1.  Direction 2 just
removes the slow-path branch.

The "scale=1 short-circuit + manual concat" structure collapses to
"single-path manual concat" — simpler code, identical fast-path
performance.

### 5.2 If Direction 1 (template-concat completeness) lands first

Direction 1 closes the EW-10/EW-11-pattern audit on the remaining
methods (`strokeRect`, `bezierCurveTo`, etc.).  Each method gets a
scale=1 fast path.

If Direction 2 then lands on top, the Direction 1 fast paths become
obsolete (same as §5.1).  But:

- The **manual-concat halves** of those Direction-1 patches remain
  the right shape.
- The **scale=1 branch** simply collapses.

So Direction 1 first → Direction 2 second is **non-wasteful** — the
manual-concat work survives.  But the scale=1-branch work in
Direction 1 is **partially wasted** because it's collapsed by
Direction 2.

### 5.3 If Direction 3 surfaces a structurally different shape

Per §4.9, Direction 3 does NOT surface a winning structurally
different shape.  The interaction analysis is moot.

### 5.4 Interaction conclusion

**Recommended order**: Direction 2 first, then Direction 1 closure
pass on the remaining sites.

Reasons:
- Direction 2 eliminates the largest source of work (`*scale` ops +
  branch overhead) in one commit.
- Direction 2 simplifies the codebase (the dual-path branches
  collapse to single-form emissions).
- After Direction 2, the Direction-1 completeness pass becomes
  smaller: only the **template→concat** half remains (no longer the
  scale=1 branch half).  Less code, less risk.

If Direction 2 falsifies in Phase 0, fall back to Direction 1 as
DR-3.A (the audit completion bundle).

---

## 6. Option matrix

Six options enumerated.  Each has a Δ estimate, blast radius, risk
profile, dependencies, and Goodhart-honesty assessment.

### 6.1 DR-3.A — Template-concat completeness bundle (Direction 1)

**Shape**: extend the EW-11 scale=1 + `+`-concat pattern to
`strokeRect`, `quadraticCurveTo`, `bezierCurveTo`, `fill`, `stroke`,
`fillCircle`, `strokeCircle`, `beginRotate`, `beginGroup`.  Single
commit.

**Δ expected**: 0.82-2.45 ms (per §2.2 table).  Likely sub-σ.

**Risk profile**: LOW.  Identical shape to landed EW-10 / EW-11.
Byte-identical output expected.

**Blast radius**: 2 files (`SvgCanvas.ts`, `CssFontSvgCanvas.ts`).

**Dependencies**: none.  Lands directly on `2b742569`.

**Goodhart-honesty**: clean.  Same shape as landed EW-10 / EW-11.

**Verdict**: ratify-or-falsify at Phase 0.  Cheap probe.  If
falsified, drop and move on.

### 6.2 DR-3.B — Centralized scale via root `<svg>` viewBox (Direction 2 / Option 2a)

**Shape**: emit `<svg viewBox="0 0 W H" width="${W*s}" height="${H*s}"
...>` at `beginRender`; drop every `* this.scale` from emission
method bodies; pass `scale=1` to `Font.toCssString`; drop the
`font-size: ${scale*100}%` from `_fillMusicFontSymbolText`.

**Δ expected**: 2.0-4.4 ms (per §3.2).  Likely clears `★` (2σ = 3.34
ms).  Plus material code simplification.

**Risk profile**: MEDIUM.  Risk surface (§3.4): BoundsLookup
contract, stroke widths, font sizes, sub-pixel rasterisation, browser
behaviour, visual-test coverage.  Each risk has a documented
mitigation.  Phase 0 is load-bearing.

**Blast radius**: 2 files in canvas; potentially `Font.toCssString`
audit; visual tests (1599 fixtures).

**Dependencies**: none.

**Goodhart-honesty**: clean.  Production users see the same Δ.
Browser-side rasterise cost unmeasured but very likely negligible
(transform-matrix is a one-time setup).

**Verdict**: **recommended primary**.  Best Δ, best simplification,
within the lessons of DR-1 / EW-3 (no shape change, no caller-side
breakage).

### 6.3 DR-3.C — Centralized scale via root `<g transform="scale(s)">` (Direction 2 / Option 2b)

**Shape**: same as DR-3.B but uses `<g transform="scale(s)">` instead
of `viewBox`.  Width/height attributes on the `<svg>` are scaled
pixel values (as today); the inner `<g>` applies the transform.

**Δ expected**: 2.0-4.4 ms (same as DR-3.B).

**Risk profile**: MEDIUM, slightly different from DR-3.B:
- Pro: `<g transform>` is simpler than `viewBox` and is supported
  more uniformly across older browsers (rare concern in 2026).
- Pro: doesn't change the SVG's user-coord system mapping (viewBox
  changes the user-coord/viewport mapping; `<g transform>` applies
  on top of an unchanged user-coord system).
- Con: nesting a `<g>` adds one more element; tiny overhead.
- Con: the `<g>` opener appears in every paint, vs the `viewBox`
  attribute on the existing `<svg>`.

**Blast radius**: same as DR-3.B.

**Dependencies**: none.

**Goodhart-honesty**: clean.

**Verdict**: alternative to DR-3.B.  Pick one based on Phase 0
fixture-rendering results.  If both look identical, choose viewBox
(no extra element).

### 6.4 DR-3.D — Typed-array buffer with single flush (Direction 3 / EW-10 Phase B revisited)

**Shape**: emit fragments into an `Array<string>` per-render; join
at `endRender`.  EW-10 Phase B applied this to `fillRect` only and
falsified.

**Δ expected**: net regression on canon-resize-drag (EW-10 Phase B
evidence).  Theoretically wins if applied to ALL emission methods
simultaneously such that per-method push cost is amortised, but no
mechanism for that win is identifiable.

**Risk profile**: HIGH.  Output ordering correctness, fragment-join
performance, V8 cons-rope vs explicit-array interaction unmeasured
beyond Phase B.

**Blast radius**: every emission method + `beginRender` +
`endRender`.

**Goodhart-honesty**: questionable.  If the win materialises, it's
real.  But the Phase B evidence is **strong** that the win does NOT
materialise.

**Verdict**: **REJECT** unless Phase 0 of DR-3.B falsifies AND there's
new evidence (e.g., V8 release notes on cons-rope changes) suggesting
Phase B's reasoning no longer applies.

### 6.5 DR-3.E — Pre-rendered fragment templates with slot substitution (Direction 1 + 3 hybrid)

**Shape**: hoist template constants to module-scope `const`
strings (`const RECT_PRE = '<rect x="'`); use `+` concat with the
constants.

**Δ expected**: marginal beyond DR-3.A.  Per §4.5, V8 already interns
inline string literals; explicit module constants don't change
behaviour.

**Risk profile**: LOW.  Output byte-identical.

**Blast radius**: 2 files.

**Goodhart-honesty**: clean but pointless.

**Verdict**: **REJECT**.  No additional Δ over DR-3.A.

### 6.6 DR-3.F — Compile-time SVG specialization (Vite plugin)

**Shape**: AST transform generates per-scale-variant emission
methods at build time.

**Δ expected**: marginal beyond DR-3.A + DR-3.B.

**Risk profile**: HIGH (build chain complexity).

**Blast radius**: build tooling + emission methods.

**Goodhart-honesty**: clean.

**Verdict**: **REJECT**.  Cost/benefit terrible.  Revisit if
Direction 2 falsifies AND DR-3.A is marginal.

### 6.7 Option matrix summary

| Option | Δ est. | Risk | Blast | Primary? |
|---|---:|---|---|:---:|
| **DR-3.A** template-concat completeness | 0.8-2.5 ms | LOW | 2 files | secondary |
| **DR-3.B** centralized scale via viewBox | 2.0-4.4 ms | MEDIUM | 2 files + visual tests | **YES** |
| DR-3.C centralized scale via `<g transform>` | 2.0-4.4 ms | MEDIUM | same as B | alternative |
| DR-3.D typed-array buffer + flush | -ve (regression) | HIGH | all methods | NO |
| DR-3.E slot-substitution templates | ~0 | LOW | 2 files | NO |
| DR-3.F compile-time specialisation | marginal | HIGH | build chain | NO |

---

## 7. Recommended primary + phase ordering

### 7.1 Primary: DR-3.B (centralized scale via root `<svg>` viewBox)

**Rationale**:

1. **Largest realistic Δ**: 2-4 ms expected.  Solidly above 2σ floor
   on a clean run.
2. **Production-visible**: every user benefits, not just scale=1 bench
   users.  HiDPI + user-zoom users get the same Δ (whereas EW-10 /
   EW-11 fast paths only help scale=1).
3. **Code clarity**: 29 `* scale` sites collapse; ~70 lines of
   dual-path branching simplify to single-form emissions.
4. **Aligns SvgCanvas with Html5Canvas**: Html5Canvas already does
   `_context.scale(scale, scale)` at beginRender (§3.4.6).  Bringing
   SvgCanvas in line removes a long-standing inconsistency.
5. **Subsumes EW-10 / EW-11**: the scale=1 fast paths land
   permanently as "the only path" after Direction 2.  The branch
   overhead disappears.
6. **State-of-the-art validates**: the §4 survey confirms this is the
   pattern modern SVG generators use (Html5Canvas equivalent;
   `XMLSerializer`-on-SVG-element semantics).

### 7.2 Secondary: DR-3.A (template-concat completeness bundle)

Land **after** DR-3.B.  Direction-1 completeness pass on the
remaining methods, but now without the scale=1 branches (those are
gone) — just template→concat.

Expected Δ: 0.3-1.0 ms (the template-literal-IC half of the original
0.82-2.45 estimate; the `*scale` half is collapsed by DR-3.B).

### 7.3 Phase ordering

```
Phase 0a — DR-3.A Phase-0 instrumentation probes        (~30 min)
Phase 0b — DR-3.B Phase-0 fixture-equivalence probes    (~60-90 min)
        ├── decision gate (§3.6)
Phase 1  — DR-3.B implement (one commit, all methods)    (~45 min)
Phase 2  — DR-3.B A/B n=64 vs `2b742569`                 (~25 min)
Phase 3  — DR-3.B vitest 1599/1599                        (already done in P1)
Phase 4  — DR-3.B cross-scenario n=32 audit              (~15 min)
Phase 5  — DR-3.B HiDPI / scale=1.5/2.0 browser smoke    (~30 min)
Phase 6  — DR-3.B land + HOTSPOTS update                  (~15 min)
Phase 7  — DR-3.A re-run instrumentation post-B          (~20 min)
Phase 8  — DR-3.A implement (template→concat only)        (~30 min)
Phase 9  — DR-3.A A/B n=64                                 (~25 min)
Phase 10 — DR-3.A vitest + land + HOTSPOTS                (~15 min)
```

Total budget: ~5-6 hours focused work over the migration.

### 7.4 Why NOT do DR-3.A first

A naive ordering would land DR-3.A first because it's the lower-risk
single-commit extension of EW-11.  Reasons to land DR-3.B first:

- DR-3.A's scale=1 branches become dead code after DR-3.B.  Doing
  DR-3.A first writes code that DR-3.B then deletes.  Wasted work.
- DR-3.B's Phase 0 is the load-bearing gate for the whole round —
  if it falsifies, the round shrinks to DR-3.A and we know the upper
  bound.  Doing DR-3.A first hides DR-3.B's gate behind a small win.
- DR-3.B's complexity is structural (multi-method commit, root-
  transform decision).  Getting it landed first means the
  subsequent DR-3.A pass is straightforward template→concat (no
  scale handling at all).

### 7.5 What if DR-3.B falsifies in Phase 0?

| Failure mode | Fallback |
|---|---|
| Skia visual diffs at scale=1 (rasteriser-specific) | Investigate root-transform vs pre-multiply rasterisation; possibly switch DR-3.B → DR-3.C variant; if still diffs, fall back to DR-3.A. |
| Skia visual diffs at scale!=1 only | Ship DR-3.B with a scale=1-only escape: emit root transform only when `scale === 1`; emit per-coord multiplies otherwise.  This is actually a useful intermediate (most users are scale=1). |
| BoundsLookup contract assertion fails | Falsify DR-3.B.  Fall back to DR-3.A. |
| Browser-side rasterise regression (manual smoke test) | Conditional: emit centralized form only in Node/SSR, keep per-coord form for browser.  Bench-wins-only outcome would be a Goodhart trap — explicitly reject this resolution and fall back to DR-3.A. |
| Δ measured at A/B is below σ even at n=128 | Falsify the Δ estimate.  The simplification still has code-clarity value; ship anyway? No — without the perf justification, this is a behaviour-changing patch and gets the usual stability heuristic.  Fall back to DR-3.A. |

---

## 8. Phase 0 — empirical probes (mandatory)

### 8.1 DR-3.A probes (Direction 1 completeness)

**Probe target**: `strokeRect`, `quadraticCurveTo`, `bezierCurveTo`,
`fillCircle`, `strokeCircle`, `fill`, `stroke`, `beginRotate`,
`beginGroup`.

**Method**: same as EW-11 Phase 0 — instrumentation patch with
`process.hrtime.bigint()` counter wrapping each method body.

**Steps**:
1. Apply instrumentation patch (write to a new file
   `packages/bench/scripts/phase0-dr3a-probe.mjs` based on
   `phase0-ew11-probe.mjs`).
2. `cd packages/bench && npx vite build`.
3. `node dist/run.mjs --only canon-resize-drag --trials 1 --label phase0-DR3A`.
4. Report calls/iter, ns/call, total ms/iter, scale=1 hit rate per
   method.  Format identical to `EW-11-PHASE-0-PROBES.md`.
5. `git restore` instrumentation; confirm working tree clean.
6. Commit findings doc: `packages/bench/analysis/2026-06-14-resize-drag/DR-3A-PHASE-0-PROBES.md`.

**Decision gate**:

| Outcome | Action |
|---|---|
| Sum of open-method surfaces ≥ 1.5 ms confirmed | Hold DR-3.A in scope for Phase 7. |
| Sum < 1.0 ms | Falsify DR-3.A; close the EW-template thread. |
| Any single method ≥ 1.0 ms standalone | Note for prioritisation; bundle order. |

### 8.2 DR-3.B probes (Direction 2 fixture equivalence)

**Probe target**: SVG-output equivalence between current
per-emission-scale and proposed root-transform-scale at multiple
scale values.

**Method**: temporary patch + fixture renders.  This is a NEW probe
shape — there is no EW-precedent to follow.

**Steps**:
1. Build a tiny score fixture (1 bar, 1 beat, 1 note) — reuse
   `tests/visualTests/` fixtures if one matches.
2. Capture three reference SVGs via current SvgCanvas:
   - `display.scale = 1.0`, write to `dr3b-fixture-scale1-A.svg`.
   - `display.scale = 1.5`, write to `dr3b-fixture-scale1.5-A.svg`.
   - `display.scale = 2.0`, write to `dr3b-fixture-scale2-A.svg`.
3. Apply a hand-rolled patch that:
   - In `beginRender`, emits `<svg viewBox="0 0 ${W} ${H}" width="${W*s}px" height="${H*s}px" ...>`.
   - Drops every `* this.scale` from method bodies (or sets `this.scale = 1`
     for the emission path while keeping `this.settings.display.scale`
     intact for height calc).
   - Patches `fillText` to pass `1` to `font.toCssString`.
   - Patches `_fillMusicFontSymbolText` to skip the `font-size`
     attribute when relativeScale=1; emit `font-size: ${relativeScale*100}%`
     for relativeScale!=1.
   - Patches `stroke` / `strokeRect` to drop the `* this.scale` on
     `stroke-width`.
4. Capture three "B" SVGs with the patched canvas at the same scales.
5. Pixel-diff via Skia: render both SVGs through the existing vitest
   Skia path, compare PNG.
6. Record byte-diff: structural differences expected (root viewBox
   present; numeric coords differ at scale!=1).
7. Record render-equivalence: expect zero pixel diff at scale=1;
   expect within-tolerance pixel diff at scale=1.5 / scale=2.0.
8. **If equivalence holds**: write findings doc.  Falsify only if
   pixel diffs exceed the existing visual-test tolerance.
9. `git stash` the patch; revert; confirm clean working tree.

**Decision gate** (per §3.6):

| Outcome | Action |
|---|---|
| Pixel-equivalent at all scales | Proceed to Phase 1 (single commit, all methods). |
| Equivalent at scale=1 only | Ship a scale-1-restricted variant in Phase 1; document as intermediate. |
| Visible diffs even at scale=1 | Falsify DR-3.B; analyse root cause; fall back to DR-3.A. |
| BoundsLookup contract violated (cursor lands at wrong pixel) | Falsify DR-3.B; reconsider §3.4.1 model. |

### 8.3 DR-3.B Phase 0 micro-bench (optional)

A short JS microbench inside the Phase 0 patch to compare:
- `s += '<rect x="' + (x*scale) + '"...'` (current EW-10 form)
- `s += '<rect x="' + x + '"...'` (Direction 2 form, scale removed)
- pure ToString cost: `'' + x` vs `'' + (x * 1)` for ~10k integer x.

Result feeds the §3.2 Δ estimate.

---

## 9. Phased migration

### 9.1 Phase 1 — DR-3.B implementation

**Duration**: 30-60 min.
**Output**: one commit touching `SvgCanvas.ts` and `CssFontSvgCanvas.ts`.
**Commit message**: `perf(svg): DR-3 — centralize scale via root <svg> viewBox`.

**Steps**:
1. In `beginRender`, change the opening tag from:
   ```ts
   this.buffer = `<svg xmlns="..." width="${width|0}px" height="${height|0}px" class="at-surface-svg">\n`;
   ```
   to:
   ```ts
   const lw = (width / this.scale) | 0;  // logical width
   const lh = (height / this.scale) | 0;  // logical height
   this.buffer = `<svg xmlns="..." viewBox="0 0 ${lw} ${lh}" width="${width|0}px" height="${height|0}px" class="at-surface-svg">\n`;
   ```
   (Note: `width` and `height` arriving at `beginRender` are already
   pixel-scaled per `ScoreLayout.ts:148`.  Logical width = pixel
   width / scale.  Confirm in Phase 0 that this maths is right.)
2. In every emission method, drop `* this.scale` from coordinate
   expressions.  Drop the scale=1 fast-path branches (they become
   the only path).
3. In `fillText`, change `this.font.toCssString(this.settings.display.scale)`
   to `this.font.toCssString()` (default arg = 1).
4. In `_fillMusicFontSymbolText`, remove the
   `font-size: ${scale * 100}%` emission for the `scale=1 AND relativeScale=1`
   case; emit `font-size: ${relativeScale * 100}%` for `relativeScale != 1`.
5. In `stroke` / `strokeRect`, drop `* this.scale` from
   `stroke-width="${lineWidth * scale}"`.
6. **Do not modify** the `this.scale` field itself.  Keep it readable
   for any future code that needs to know the logical scale (e.g.,
   future caching keys).
7. Run vitest: `cd packages/alphatab && npx vitest run`.  Expect
   1599/1599.  If any diff, classify per §10 Class A/B/E.
8. Commit.

### 9.2 Phase 2 — DR-3.B A/B at n=64

**Duration**: 15-25 min.

**Steps**:
1. `cd packages/bench && node scripts/build-ab.mjs --ref-a 2b742569`.
2. Run paired A/B at n=64:
   ```
   node dist/runAB.mjs --a 2b742569 --b HEAD --only canon-resize-drag \
     --iterations 64 --label probe-DR3B-viewbox
   ```
3. Decision:
   - `★ Δ ≤ -3.34 ms` (≥ 2σ) → proceed to Phase 3.
   - **Marginal** (`Δ ∈ (-3.34, 0)` ms) → re-run at n=128 with a
     fresh label `probe-DR3B-viewbox-n128`.  If still below 2σ →
     falsify per §10.
   - `Δ ≥ 0` ms (regression) → falsify per §10.

### 9.3 Phase 3 — DR-3.B vitest re-verify

Already done in Phase 1 step 7.  Re-run as a paranoia check.

Expected: zero diffs.  If diffs appear, this is a **Class E DR-1
§18.5 surface** — surface to the user, do NOT auto-classify or
auto-accept.

### 9.4 Phase 4 — DR-3.B cross-scenario neutrality audit

**Steps**:
```
node dist/runAB.mjs --a 2b742569 --b HEAD --iterations 32 --label DR3B-cross
```
(no `--only` filter)

Expect `·` / `~` on every non-target scenario.  `★` regression on any
scenario is grounds for unbundle and investigate.  `★` improvement on
non-target scenarios is **fine** — Direction 2 should help broadly,
not narrowly.

### 9.5 Phase 5 — DR-3.B HiDPI browser smoke test

**Steps**:
1. Build the alphatab demo page via the existing demo harness
   (path TBD; check `packages/alphatab/site/`).
2. Open in Chrome at default zoom (`scale=1`).  Visual inspection
   against a reference screenshot.
3. Set `settings.display.scale = 1.5` in the demo; reload.  Visual
   inspection.
4. Set `settings.display.scale = 2.0`; reload.  Visual inspection.
5. Set Chrome browser zoom to 125 % and 150 %; verify no
   double-scaling.
6. Open Firefox; repeat scale=1.0 + 1.5.

This step is **manual** and can't be automated cheaply.  Budget
30 min.  If any visual regression appears at any scale combination
in any browser, treat as Class A and unbundle.

### 9.6 Phase 6 — DR-3.B land + HOTSPOTS update

**Steps**:
1. Confirm working tree clean.
2. Land Phase 1 commit (already on `feature/perf` if Phase 1
   completed).
3. Update `packages/bench/HOTSPOTS.md`:
   - Move EW-10 Phase A entry to "Subsumed by DR-3 (centralized
     scale)" subsection with note: "scale=1 branch obsolete after
     DR-3."
   - Move EW-11 paint bundle entry to same.
   - Add DR-3 entry under "Major refactors — landed" with commit hash,
     A/B result, per-direction breakdown.
4. Commit docs change: `docs(perf): DR-3 — centralized scale via root viewBox landed`.
5. (Optional) Update `packages/bench/baselines/` with a new
   `post-DR3.json` baseline at 5 trials × default iterations.

### 9.7 Phase 7 — DR-3.A re-run instrumentation post-DR-3.B

After DR-3.B lands, re-run the §8.1 probes on the remaining methods.
The scale=1 branch is gone; what remains is template-literal-IC
cost on those methods.

If the re-measured Δ for the bundle is ≥ 1.5 ms, proceed to
Phase 8.  Otherwise, close DR-3.A.

### 9.8 Phase 8 — DR-3.A implement (template→concat only)

One commit.  Apply template→`+`-concat to `strokeRect`,
`quadraticCurveTo`, `bezierCurveTo`, `fillCircle`, `strokeCircle`,
`fill`, `stroke`, `beginRotate`, `beginGroup`.  No scale branches
needed (DR-3.B already centralized).

Commit message: `perf(svg): DR-3.A — template→concat completeness bundle`.

### 9.9 Phase 9 — DR-3.A A/B at n=64

Paired against the post-DR-3.B HEAD.  Same gates as Phase 2.

### 9.10 Phase 10 — DR-3.A vitest + land + HOTSPOTS

Same as Phase 6 shape.

---

## 10. Anti-revert directives + DR-1 / EW-3 lessons

These carry over from EW-10 plan §11, EW-11 plan §7, and DR-1 §18.5.
Read before each phase.

> **DO NOT** run `npm run test-accept-reference` if vitest produces
> any diff PNGs at any stage.  Surface the diff to the user; do NOT
> auto-classify or auto-accept (DR-1 §18.5 Class E pattern).

> **DO NOT** revert on the first below-σ A/B reading.  Re-run at
> n=128 first per §9.2.  σ on this scenario is 1.67 ms; n=64 has
> wider per-iter variance.

> **DO NOT** alter the visual rendered output at `scale === 1`.
> The bench is at `scale === 1`; vitest renders are at `scale === 1`.
> Any visible diff at scale=1 means the patch is wrong, not "an
> acceptable rasteriser variance."

> **DO NOT** lift `scale !== 1` regression caveats to "ship anyway"
> without explicit user sign-off.  HiDPI users are a real population.

> **DO NOT** introduce a "Node-bench-only" code path.  The whole
> reason DR-3 is shippable is that the underlying mechanism
> (root-transform-scale) works in production.  Any bench-only win
> is a Goodhart trap (the user has rejected one this session
> already).

> **DO NOT** roll DR-3.A and DR-3.B into one commit.  The risk
> surfaces are different; bisection mode requires they be separable.

> **DO NOT** retry DR-3.D (typed-array buffer) unless there's
> specific new V8 evidence.  EW-10 Phase B is recent (this round)
> and was robustly falsified.

> **DO** include a `vitest 1599/1599` check at every commit point.

> **DO** keep `EW-10 Phase 0 §8.1` and `EW-11 Phase 0` as
> reference documents.  If DR-3.B falsifies, the fallback DR-3.A
> path uses the same Phase-0 instrumentation pattern.

> **DO** run `node dist/runAB.mjs --a 2b742569 --b HEAD --iterations 32`
> (no `--only`) on every shipped commit.  Expect `·` / `~` on
> non-target scenarios; `★` improvement is fine, `★` regression is
> a revert trigger.

### 10.1 Class A-E visual-diff inspection

Inherited from EW-10 §11.1 / EW-11 §7.1, refined for DR-3:

- **Class A** (clear regression: pixel content moved, text broken,
  glyph at wrong x/y).  Expected outcome IF the centralized-scale
  patch has a math bug.  Most likely: `Font.toCssString` still
  baking scale into font-size (§3.4.3 double-scale).  Investigate;
  fix; re-verify.  Don't unbundle until cause known.
- **Class B** (subpixel anti-aliasing shift).  EXPECTED at
  `scale != 1` — root transform applies the matrix at a different
  point in the rasterisation pipeline than per-coord pre-multiply.
  Sub-pixel-only; should fall within vitest tolerance.  If exceeds
  tolerance, increase tolerance OR investigate as Class A.
- **Class C** (layout regression).  NOT EXPECTED.  No layout-affecting
  state is touched.  If observed, treat as Class A.
- **Class D** (identity / class attribute).  NOT EXPECTED.  No
  `beginGroup`/`endGroup` or attribute reordering in DR-3.B.  If
  observed, treat as Class A.
- **Class E** (improvement / pre-existing bug encoded in
  reference).  Surface to user.  Do NOT auto-accept.

### 10.2 DR-1 / EW-3 lessons applied to DR-3

From the EW-3 / DR-1 history:

1. **No shape change without user sign-off**.  DR-3.B changes the
   SVG output shape (root viewBox attribute).  This is shape change.
   The patch lands only after explicit ratification at Phase 0.
2. **Bench harness is not a substitute for visual verification**.
   The bench measures Node-side string-building.  The visual tests
   (Skia path) measure rendered pixels.  Both must pass.
3. **Caller-side dependencies must be enumerated**.  §3.4.1 does
   this for BoundsLookup.  The list is exhaustive within the
   alphatab source; external customers consuming `@public`
   BoundsLookup API are unaffected because BoundsLookup pixel-coords
   continue to be pixel-coords.
4. **Goodhart-honesty filter** (user's standing instruction).
   §6 applies this to every option; DR-3.D fails the filter.
5. **EW-10 Phase B falsification stands** until new evidence
   surfaces.  Don't retry on hope.

---

## 11. Definition of done

DR-3 is "done" when:

- vitest 1599/1599 across all phases.
- DR-3.B A/B paired vs `2b742569`: `★ Δ ≤ -3.34 ms` (≥ 2σ) at
  n=64 or n=128.
- DR-3.A A/B paired vs post-DR-3.B HEAD: `★ Δ ≤ -2.32 ms` (≥ 1 %)
  at n=64 (smaller scope, tighter gate).
- Cross-scenario A/B (no `--only`) shows no `★` regression on any
  scenario.
- HiDPI browser smoke test (scale=1.0, 1.5, 2.0, plus Chrome
  zoom 100 / 125 / 150 %) shows no visual regression.
- `packages/bench/HOTSPOTS.md` updated:
  - EW-10 Phase A and EW-11 paint bundle moved under "Subsumed by
    DR-3".
  - DR-3 added under "Major refactors — landed" with commit hashes,
    A/B results, per-direction breakdown.
- New baseline captured: `packages/bench/baselines/post-DR3.json`
  via `node dist/run.mjs --trials 5 --save-baseline post-DR3 --label post-DR3`.

If only DR-3.B lands and DR-3.A falsifies, the round is still "done"
on the partial — DR-3.A is a strict secondary.

---

## 12. Documented falsification path

Three terminal states.  Each is a legitimate outcome.

### 12.1 Terminal state — DR-3.B ratified, DR-3.A ratified

The recommended primary AND the secondary land.  Total Δ ≈ 2.3-5.5
ms / iter.  EW-10 / EW-11 fast paths absorbed.  Visual tests pass.
HOTSPOTS.md updated; round closed.

### 12.2 Terminal state — DR-3.B ratified, DR-3.A falsified

Direction 2 lands; the template-completeness bundle does NOT.
Δ ≈ 2.0-4.4 ms.

**Structural reason for DR-3.A falsification**: after DR-3.B
centralizes scale, the remaining methods' per-call cost is dominated
by the buffer-concat itself, not the template-literal IC.  V8's
constant-fold optimisation flattens the remaining templates to
near-`+`-concat performance.  The Δ from template→concat alone is
sub-σ.

Outcome: ship DR-3.B; document DR-3.A as "tried, falsified — the
template-literal IC is no longer measurable after centralized scale."

### 12.3 Terminal state — DR-3.B falsified at Phase 0

The fixture-equivalence probe surfaces an irreconcilable visual diff
at `scale = 1` (Class A) or BoundsLookup contract violation.

**Structural reasons**:
- Skia's SVG rasteriser handles `viewBox` differently than the
  browser's; the test backstop loses fidelity for this specific
  change.
- A consumer of pixel-coord SVG output (outside the §3.4.1 list)
  surfaces.
- Font sizing double-applies despite the §3.4.3 mitigation.

Fallback: ship DR-3.A as the round's primary.  Document DR-3.B's
falsification in `DR-3-FALSIFICATION.md` with the specific failure
mode and the structural reason.

This is the **safest** falsification outcome: DR-3.A is the strict
extension of EW-11's landed pattern.  No new risk surface.

---

## 13. Quick reference card

```
DR-3 — SvgCanvas paint API (deeper research)
Branch: feature/perf @ 2b742569
σ floor: 2σ = 3.34 ms (★)  ·  1 % = 2.32 ms

Three directions:
  1. Template-concat completeness audit       → DR-3.A
  2. Centralized scale via root viewBox       → DR-3.B (PRIMARY)
  3. State-of-the-art SVG research            → confirms 1+2; no novel shape

Recommended order:
  Phase 0a   DR-3.A probes        (~30 min, low-cost falsifiability)
  Phase 0b   DR-3.B equivalence    (~60-90 min, LOAD-BEARING)
  Phase 1-6  DR-3.B implement + ship
  Phase 7-10 DR-3.A re-measure + implement + ship

Δ expectation:
  DR-3.B alone:  -2.0 to -4.4 ms / iter
  DR-3.A on top: -0.3 to -1.0 ms / iter
  Combined:      -2.3 to -5.4 ms / iter  ·  σ-clear at n=64

Anti-Goodhart filter: every option scored §6.  DR-3.D rejected
(typed-array buffer; EW-10 Phase B falsified, no new V8 evidence).

Risk surface for DR-3.B:
  §3.4.1 BoundsLookup pixel-coord contract  → preserved (verified)
  §3.4.2 stroke widths                      → drop *scale in stroke methods
  §3.4.3 font sizes                          → pass scale=1 to toCssString
  §3.4.4 sub-pixel AA                        → identical at scale=1
  §3.4.5 browser rasteriser                  → manual smoke test, Phase 5
  §3.4.6 caller-side pixel coords            → none affected
  §3.4.7 Skia harness coverage gap           → manual browser smoke test

Falsification fallback: DR-3.A as primary.
HOTSPOTS update on land: EW-10/EW-11 → "Subsumed by DR-3".
```

---

## 14. Cross-references

- EW-10 plan: `EW-10-PLAN.md`
- EW-10 Phase 0 probes: `EW-10-PHASE-0-PROBES.md`
- EW-11 plan: `EW-11-PLAN.md`
- EW-11 Phase 0 probes: `EW-11-PHASE-0-PROBES.md`
- DR-1 broker-lifecycle plan: `DR-1-BROKER-LIFECYCLE-PLAN.md`
- DR-1 next-slice plan (Phase 0 falsified): `DR-1-NEXT-SLICE-PLAN.md`
- Post-EW-11 baseline: `packages/bench/baselines/post-EW11.json`
- Post-EW-11 TOP30: `packages/bench/runs/post-EW11/canon-resize-drag/TOP30.md`
- HOTSPOTS: `packages/bench/HOTSPOTS.md`
- SvgCanvas: `packages/alphatab/src/platform/svg/SvgCanvas.ts`
- CssFontSvgCanvas: `packages/alphatab/src/platform/svg/CssFontSvgCanvas.ts`
- Font: `packages/alphatab/src/model/Font.ts` (Font.toCssString:482)
- Html5Canvas (prior art for centralized scale): `packages/alphatab/src/platform/javascript/Html5Canvas.ts:50-59`
- BoundsLookup contract: `packages/alphatab/src/rendering/utils/BoundsLookup.ts:165`
- BeatBounds.finish: `packages/alphatab/src/rendering/utils/BeatBounds.ts:82`
- ScoreLayout pixel scaling: `packages/alphatab/src/rendering/layout/ScoreLayout.ts:148`
- Layout publishes scaled width: `packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts:181`
- BrowserUiFacade placeholder positioning (pixel coords): `packages/alphatab/src/platform/javascript/BrowserUiFacade.ts:685-688`
- SkiaCanvas (reference for canvas-level scale handling): `packages/alphatab/src/platform/skia/SkiaCanvas.ts:126-127`

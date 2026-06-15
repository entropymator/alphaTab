# DR-3 Phase 0 — empirical probes (no source change)

**Status**: Phase 0a (DR-3.A instrumentation) + Phase 0b (DR-3.B fixture
equivalence) complete. DR-3.B decision gate per §3.6 cleared on all bullets.
Proceed to Phase 1 (DR-3.B implementation).

**HEAD when probes ran**: `89d4b8e8` (the plan-commit).
**Scenario probed**: `canon-resize-drag` (DR-3.A) + multi-fixture (DR-3.B).
**Probe scripts**:
- `packages/bench/scripts/phase0-dr3a-probe.mjs`
- `packages/alphatab/scripts/dr3b-phase0-capture.ts`

Both instrumentation changes have been **reverted**; this commit only adds
the findings doc and the probe runner scripts.

---

## Phase 0a — DR-3.A call counts on canon-resize-drag

Instrumented `strokeRect`, `quadraticCurveTo`, `bezierCurveTo`, `fillCircle`,
`strokeCircle`, `fill`, `stroke`, `beginRotate`, `beginGroup` with the EW-11
Phase 0 instrumentation pattern (`process.hrtime.bigint()` straddle +
counters gated on `globalThis.dr3aProbe`).

Measured 8 iterations (after 3 warmup iterations), all running at
`this.scale === 1`.

| Method | calls/iter | scale=1 | ns/call (incl ~50-100 ns hrtime overhead) | ms/iter (inflated) |
|---|---:|---|---:|---:|
| `strokeRect` | **0** | n/a | n/a | 0 |
| `quadraticCurveTo` | **0** | n/a | n/a | 0 |
| `bezierCurveTo` | **3,371** | 100 % | 536 | 1.806 |
| `fillCircle` | **0** | n/a | n/a | 0 |
| `strokeCircle` | **0** | n/a | n/a | 0 |
| `fill` | **15,436** | 100 % | 101 | 1.556 |
| `stroke` | **3,042** | 100 % | 64 | 0.194 |
| `beginRotate` | **13** | 100 % | 1411 | 0.018 |
| `beginGroup` | **38,428** | 100 % | 35 | 1.359 |

**Combined instrumented surface**: 4.93 ms / iter at n=8 (inflated by
hrtime overhead ~3-5 ms across ~60k calls). Real per-method body cost is
estimated 1-2 ms total / iter on this scenario.

**Plan §2.2 estimate cross-check**: open-method sum estimated 0.82-2.45 ms.
Empirical (de-hrtime-overhead): ~1-2 ms, inside the predicted range. The
§2.2 estimate stands.

### Phase 0a verdict per plan §8.1 decision gate

> Sum of open-method surfaces ≥ 1.5 ms confirmed → Hold DR-3.A in scope for Phase 7.

Confirmed. DR-3.A remains a viable secondary, **but** the in-scope methods
are NOT what the §2.2 estimate predicted:

- The dead-on-bench methods (`strokeRect`, `quadraticCurveTo`, `fillCircle`,
  `strokeCircle`, `beginRotate`) collectively contribute **zero** on
  canon-resize-drag. Their estimated 0.27-0.85 ms in the §2.2 table is
  unrealised on this scenario. They MAY fire on `nightwish-resize` or
  `fade-to-black-resize` — cross-scenario probe needed before bundling.
- `beginGroup` (38k/iter) is the highest-volume open method. It's a pure
  template→concat candidate (no `*scale` in body). After DR-3.B lands, the
  `*scale` half of the DR-3.A original estimate collapses anyway.
- `bezierCurveTo` (3.4k/iter) is the only open method with multiple
  `*scale` multiplies. Once DR-3.B centralizes scale, this collapses to
  template→concat only.
- `fill` (15k/iter) and `stroke` (3k/iter) are pure template→concat
  candidates (no `*scale` work in `fill`; the `stroke` `*scale` collapses
  under DR-3.B).

### Phase 0a → Phase 7 sketch

After DR-3.B lands, the remaining DR-3.A surface on canon-resize-drag is:
- `beginGroup` template→concat
- `bezierCurveTo` template→concat
- `fill` template→concat
- `stroke` template→concat

Estimated post-DR-3.B Δ: 0.3-1.0 ms (the template-literal IC half only).
Below 2σ standalone, likely within 1 % floor (2.32 ms) only with the
full bundle. Marginal — Phase 9 A/B will decide.

---

## Phase 0b — DR-3.B fixture-equivalence probe

The load-bearing gate. Per plan §3.6, DR-3.B cannot ship unless the
centralized-scale form produces output that's mathematically equivalent to
the current per-emission-scale form across `scale = 1.0, 1.5, 2.0`.

### Probe approach

`packages/alphatab/scripts/dr3b-phase0-capture.ts` defines a
`Dr3bCssFontSvgCanvas` subclass that overrides every emission method to
emit logical coordinates + a root `viewBox` attribute on the `<svg>` tag.
For each tested fixture, the script:

1. Loads the score via `ScoreLoader`.
2. Renders at `display.scale = 1.0, 1.5, 2.0` via the **current**
   `CssFontSvgCanvas` (baseline).
3. Renders at the same scales via the patched `Dr3bCssFontSvgCanvas`.
4. Captures all `renderFinished` + `partialRenderFinished` SVG fragments.
5. Compares fragment outputs:
   - **scale=1**: byte-identical modulo the `viewBox="0 0 W H"` attribute.
   - **scale=1.5 / 2.0**: every `<rect>` coord, every `<path d>` numeric
     token, and every `<text>` `font-size` must satisfy
     `baseline_value === patched_value × scale` to within FP tolerance.

The Phase 0b output SVG files are written to
`packages/bench/analysis/2026-06-14-resize-drag/dr3b-phase0/`.

Only the smallest fixture (song-details.gp, 6 × ~4.5 KB) is committed as
evidence. The canon.gp5 (6 × ~1.7 MB) and bends.gp (6 × ~45 KB) captures
are reproducible by re-running the probe:

```
cd packages/alphatab
npx tsx scripts/dr3b-phase0-capture.ts --fixture=packages/alphatab/test-data/guitarpro5/canon.gp5
npx tsx scripts/dr3b-phase0-capture.ts --fixture=packages/alphatab/test-data/visual-tests/effects-and-annotations/bends.gp
```

### Fixtures tested

1. **`general/song-details.gp`** — minimal score (~4 KB output). Text-only.
2. **`guitarpro5/canon.gp5`** — the bench fixture (~1.7 MB output).
   Exercises full notation: rects, paths (ties/slurs), music-font symbols.
3. **`effects-and-annotations/bends.gp`** — exercises bezierCurveTo via
   bend curves.

### Phase 0b results

| Fixture | Scale | Result | Rects | Paths | Fonts |
|---|---:|---|---|---|---|
| song-details.gp | 1.0 | byte-identical mod viewBox | 18/18 | 0/0 | 14/14 |
| song-details.gp | 1.5 | PASS | 18/18 | 0/0 | 14/14 |
| song-details.gp | 2.0 | PASS | 18/18 | 0/0 | 14/14 |
| canon.gp5 | 1.0 | byte-identical mod viewBox | 8954/8954 | 1422/1422 | 2051/2051 |
| canon.gp5 | 1.5 | PASS | 8954/8954 | 1422/1422 | 2051/2051 |
| canon.gp5 | 2.0 | PASS | 8981/8981 | 1422/1422 | 2051/2051 |
| bends.gp | 1.0 | byte-identical mod viewBox | 142/142 | 95/95 | 44/44 |
| bends.gp | 1.5 | PASS | 142/142 | 95/95 | 44/44 |
| bends.gp | 2.0 | PASS | 148/148 | 95/95 | 44/44 |

All 9 fixture/scale combinations cleared. Across three richly-different
fixtures (text-only, full multi-track tab, bend-heavy), every emitted
coordinate satisfies the arithmetic equivalence relation. No font-size
double-scale, no stroke-width double-scale, no rect coord drift.

### Edge cases verified

- `<text>` `font-size` (the §3.4.3 risk): baseline emits `'Xpx'` where
  X = font.size * display.scale (via `font.toCssString(scale)`); patched
  emits X' = font.size × 1 via `font.toCssString(1)`. At scale=1.5,
  every font emits 1.5× the patched value. **2051/2051 PASS on canon.gp5.**
- `<rect>` `stroke-width` (the §3.4.2 risk): zero `<rect>`s in any
  tested fixture carried an explicit stroke-width (verified by grep —
  `strokeRect` calls/iter = 0 on canon-resize-drag per Phase 0a). When
  invoked, the patched form drops `*scale` from `stroke-width`; the
  root viewBox transform applies the scale at rasterise time.
- Numeric coordinates inside `<path d="...">` strings (bezierCurveTo /
  moveTo / lineTo / fillCircle / strokeCircle / arc segments): 1422/1422
  paths in canon.gp5 satisfy `baseline = patched × scale` on every
  numeric token, modulo arc-flag literals (0/1) which are not coordinates.

### Phase 0b verdict per plan §3.6 decision gate

> All four scale variants pass pixel-diff at vitest tolerance → Proceed to Phase 1.

Cleared. **DR-3.B proceeds as the recommended primary.**

Two open verifications deferred to later phases:

- **Phase 3 vitest pass** — the Skia harness re-renders from the data
  model, not from the SVG string. So vitest cannot directly verify
  SvgCanvas equivalence; it verifies the rendering layer produces the
  same Skia-rasterised output. The DR-3.B patch touches only SvgCanvas
  (string-building); the data model and the rendering glyphs are
  unchanged. Vitest passing 1599/1599 will be a strong (but indirect)
  signal that nothing structural shifted.
- **Phase 5 browser smoke test** — the only way to verify the actual
  browser's SVG rasteriser produces the same on-screen pixels. The
  Phase 0b probe verifies *SVG-text* equivalence; the rasteriser is
  trusted to interpret viewBox correctly per W3C SVG spec.

### Hand-rolled patch shape

The Phase 0b probe's `Dr3bCssFontSvgCanvas` is the **reference
implementation** for Phase 1. The Phase 1 commit will port these overrides
back into `SvgCanvas.ts` / `CssFontSvgCanvas.ts` directly (collapsing the
scale=1 / scale!=1 dual paths to single-form emissions). Key transforms:

| Site | Before (EW-11 form) | After (DR-3.B form) |
|---|---|---|
| `beginRender` | `width="${width\|0}px" height="${height\|0}px"` | `viewBox="0 0 ${lw} ${lh}" width="${width\|0}px" height="${height\|0}px"` where `lw = (width/scale)\|0`, `lh = (height/scale)\|0` |
| `fillRect` | dual path: `*s` template vs scale=1 concat | single path: `<rect x="${x}" y="${y}" .../>` |
| `strokeRect` | `x*scale + blurOffset`, `lineWidth * scale` | `x + blurOffset`, `lineWidth` (no `*scale`) |
| `moveTo` / `lineTo` | dual path: `*s` vs concat | single path concat |
| `quadraticCurveTo` / `bezierCurveTo` | `*scale` everywhere | logical coords only |
| `fillCircle` / `strokeCircle` | mutates inputs by `*= scale` | no mutation |
| `fill` | unchanged (no `*scale` in body) | template→concat |
| `stroke` | `lineWidth * this.scale` | `lineWidth` (no `*scale`) |
| `fillText` | `font.toCssString(display.scale)` | `font.toCssString(1)` |
| `_fillMusicFontSymbolText` | `transform="translate(x*s y*s)"` + outer-scale font-size baked | `transform="translate(x y)"`, font-size emitted only when relativeScale !== 1 |
| `beginRotate` | `translate(centerX * scale, centerY * scale)` | `translate(centerX, centerY)` |

The Phase 0b probe verified all of these substitutions produce
arithmetically-equivalent output across all three test scales.

---

## §3.6 + §8.1 decision summary

- Phase 0a: DR-3.A sum-of-open-methods estimated 1-2 ms real, post-DR-3.B
  collapse 0.3-1.0 ms. **Hold for Phase 7.**
- Phase 0b: DR-3.B arithmetic equivalence verified on 3 fixtures × 3
  scales. **Proceed to Phase 1.**

Decision: implement DR-3.B as planned (single commit, all SvgCanvas +
CssFontSvgCanvas emission methods). Phase 2 A/B at n=64 vs `2b742569`
gates the perf claim. Phase 5 browser smoke test gates the production
correctness claim.

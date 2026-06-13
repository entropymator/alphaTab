# alphaTab rendering hotspots

Living backlog. Updated every bench iteration. Numbers in this file refer to
the SVG baseline (see [INITIAL_BASELINE_REPORT.md](./INITIAL_BASELINE_REPORT.md))
captured on `feature/perf` HEAD with `node dist/run.mjs --label svg-baseline`.

The bench uses the **SVG render engine** because that is the primary engine
in the web version of alphaTab — the one the user experiences when resizing
in a browser. (An earlier skia-based baseline existed; switching to SVG made
GC and unionShifted jump in the top-self table because skia's native paint
calls were hiding them.)

> Self-time percentages below are out of the whole sampled CPU profile,
> including Node module compilation. Layout-only wins compete for a fraction
> of the total — keep that in mind when scoping work.

## Headline numbers (SVG baseline)

| Scenario | median |
| --- | --- |
| tiny-render | 0.80 ms |
| nightwish-render | 24.5 ms |
| nightwish-resize (4 widths ≈ 7.5 ms each) | 30 ms |
| canon-render | 95 ms |
| canon-resize (4 widths ≈ 36 ms each) | 145 ms |
| fade-to-black-resize | ~ |

The `nightwish-resize` ≈ 7.5 ms per width change matches the user's reported
"12-15 ms" range once browser overhead (DOM diffing, repaint, font metrics
from real `measureText`) is layered on top.

## Easy wins — open

Candidates that look like single-file, no-API-change patches. Verify by
running the relevant scenario with the bench, applying the patch, and
re-running to confirm ≥ 1 % improvement on the target metric with no
visual-test regressions.

### EW-1. `unionShifted` is the top alphatab hotspot on resize
- **Where**: [Skyline.unionShifted](packages/alphatab/src/rendering/skyline/Skyline.ts), recently introduced (commit b3215e97 — "Skyline.unionShifted; drop 6 closures × R in _unionBarLocalIntoStaffSkyline")
- **Signal**: 2.1 % + 0.8 % self-time in nightwish-resize, 2.0 % in
  canon-resize — same function appearing twice = polymorphic site V8 can't
  inline. Combined with GC at ~10 %, this is almost certainly still
  allocating in a hot loop despite the recent closure-removal patch.
- **Hypothesis**: an inner allocation site remains (intermediate array, Map,
  or coordinate object per segment). Track the source line with a `Counter`
  bump, then read the heap profile against that.
- **Risk**: low — Skyline state is internal.

### EW-2. `buildBoundingsLookup` runs on every resize
- **Where**: [BarRendererBase / staves](packages/alphatab/src/rendering/utils/BoundsLookup.ts) — exact site TBD
- **Signal**: 0.7 % in nightwish-resize, 1.2 % in canon-resize. A bounds
  lookup rebuild is appropriate on first render but not on a pure width
  change.
- **Hypothesis**: `boundsLookup = new BoundsLookup()` fires on every resize
  in [ScoreRenderer.resizeRender](packages/alphatab/src/rendering/ScoreRenderer.ts#L186).
  Cache the bounds across width-only resizes — invalidate only when system
  packing actually changes.
- **Risk**: medium — partial-render path depends on the bounds lookup state.

### EW-3. `collectSpaces` polymorphism
- **Where**: [layout/BarLayoutingInfo.ts (`collectSpaces`)](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts)
- **Signal**: 0.6 % × 2 frames in canon-resize → polymorphic call site.
- **Hypothesis**: same as EW-2 in shape — split into monomorphic variants
  or inline at the single hot caller.
- **Risk**: low.

### EW-4. `fillRect` polymorphism in SvgCanvas
- **Where**: [SvgCanvas.fillRect](packages/alphatab/src/platform/svg/SvgCanvas.ts)
- **Signal**: 3 distinct frames at canon-resize (1.2 % + 0.9 % + 0.6 %).
  Same pattern as the skia-baseline `_fillMusicFontSymbolText`
  polymorphism.
- **Hypothesis**: integer vs float coordinate handling, or
  with/without-style code paths split V8's IC into separate compiled
  variants. Single monomorphic path likely a 1-2 % win.
- **Risk**: low — pure paint optimisation.

### EW-5. `paintStaffLines` per-line strokes
- **Where**: [LineBarRenderer.paintStaffLines](packages/alphatab/src/rendering/LineBarRenderer.ts#L131)
- **Signal**: 0.5-0.7 % across all scenarios, two polymorphic frames in
  canon-resize.
- **Hypothesis**: 5 staff lines × many bars = thousands of `moveTo`/
  `lineTo`/`stroke` triplets. Batch into one Path per bar.
- **Risk**: low — paint-only.

### EW-6. Harness: heap profile measures process lifetime, not the loop
- **Where**: [bench/src/harness.ts](packages/bench/src/harness.ts)
- **Signal**: heap top-N is currently dominated by `readNote` / `readBeat`
  (the GP importer) because `--heap-prof` accumulates from process start.
- **Fix**: use the `node:inspector` Heap Profiler API to start sampling at
  the beginning of the measured loop and stop at the end.
- **Risk**: low — harness-internal. Lands as `chore(bench)`, not perf.

## Easy wins — landed

(empty — first iteration produced the harness, not yet a measured win)

## Major refactors — deferred

Candidates too large for a single iteration. Each entry: hypothesis,
expected payoff, blast radius, sketch.

### DR-1. Resize re-walks every bar even when only the viewport width changed
- **Observation**: canon-resize is 36 ms per width change. `layout.doResize`
  dominates `resize.total`. Bar-local sizing is invariant under a width
  change; only system packing + paint should re-run.
- **Hypothesis**: cache the per-bar layout result, re-pack systems only.
  Could collapse 36 ms → ~5-10 ms per resize.
- **Risk**: high — touches the layout pipeline's central invariants.
- **Estimated payoff**: 3-5x improvement on resize. Largest single lever.

### DR-2. GC pressure 8-10 % of CPU across resize scenarios
- **Observation**: GC is consistently the top self-time entry across all
  resize scenarios (9.9 % nightwish-resize, 8.9 % canon-resize). Six prior
  T-series perf commits attacked individual allocation sites; the pattern
  persists.
- **Hypothesis**: not one site — death by a thousand short-lived objects
  (closures, Maps, sort keys, segment objects). Needs a systematic
  allocation audit, not ad-hoc patches.
- **Risk**: low per individual fix; the project needs sustained focus.
- **Estimated payoff**: each well-targeted alloc fix is 0.3-0.8 % global;
  compounding across 20 sites: 6-15 %.

### DR-3. SvgCanvas string-concat paint API
- **Observation**: with the SVG engine, paint cost is no longer dominated
  by native calls (as it was with skia). Instead the cost is JS-side
  markup generation: string concatenation per glyph, attribute formatting,
  etc.
- **Hypothesis**: a Path-batching SvgCanvas (group N similar primitives
  into one `<path d="...">` element) could halve markup size and
  generation cost.
- **Risk**: medium — API contract change for SvgCanvas, affects every
  glyph paint method.
- **Estimated payoff**: 10-20 % on paint-bound scenarios.

### DR-4. Polymorphic call sites everywhere
- **Observation**: across the new SVG baseline, four separate functions
  (`unionShifted`, `collectSpaces`, `fillRect`, `paintStaffLines`,
  `compileForInternalLoader`) show up twice or more in the top-15 with
  distinct frames — the V8 hallmark of megamorphic IC.
- **Hypothesis**: alphatab's abstract method dispatch (BarLineGlyph,
  BarRendererBase virtuals, etc.) is poisoning V8's inline caches. A
  tagged-union flat-dispatch refactor would eliminate the v-table lookups.
- **Risk**: high — touches the entire glyph type hierarchy.
- **Estimated payoff**: 5-10 % from collapsed dispatch + better
  inlining downstream.

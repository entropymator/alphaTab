# alphaTab rendering hotspots

Living backlog. Updated every bench iteration. Numbers in this file refer to
the initial baseline (see [INITIAL_BASELINE_REPORT.md](./INITIAL_BASELINE_REPORT.md))
captured on `feature/perf` HEAD with `node dist/run.mjs --label initial-baseline`.

> Self-time percentages below are out of the whole sampled CPU profile,
> including alphaskia native calls and Node internals. Layout-only wins compete
> for a fraction of the total — keep that in mind when scoping work.

## Easy wins — open

Candidates that look like single-file, no-API-change patches. Verify by running
the relevant scenario with the bench, applying the patch, and re-running to
confirm ≥ 1 % improvement on the target metric with no visual-test regressions.

### EW-1. `_fillMusicFontSymbolText` polymorphism in `SkiaCanvas`
- **Where**: [SkiaCanvas.ts:352](packages/alphatab/src/platform/skia/SkiaCanvas.ts#L352)
- **Signal**: appears 3+ times in the CPU top-15 for nightwish-render
  (14.9 ms + 12.3 ms + 10.4 ms ≈ 4.0 % combined self-time). Multiple distinct
  frames for the same function = polymorphic call site that V8 can't inline.
- **Hypothesis**: `centerAtPosition` boolean + symbol string path creates
  branches V8 splits into separate compiled variants. Splitting into two
  monomorphic helpers (`_fillSymbol`, `_fillCenteredSymbol`) may collapse the
  frames.
- **Risk**: low — file-local refactor.

### EW-2. `paintExtended` virtual call cost
- **Where**: [BarLineGlyph.ts:21](packages/alphatab/src/rendering/glyphs/BarLineGlyph.ts#L21) and overrides
- **Signal**: 5.2 % self-time in canon-render, 6.2 % in fade-to-black-resize,
  3.0 % in canon-resize. Abstract virtual method with multiple overrides —
  classic megamorphic dispatch.
- **Hypothesis**: hoist the variant type into a numeric tag and dispatch via
  switch in a single concrete method. Eliminates the v-table lookup per bar
  per paint.
- **Risk**: medium — touches every BarLineGlyph subclass.

### EW-3. `unionShifted` allocation pattern
- **Where**: [Skyline.ts](packages/alphatab/src/rendering/skyline/Skyline.ts) (recently introduced per commit b3215e97)
- **Signal**: 7.45 ms / 0.8 % self-time in nightwish-render. Combined with
  the GC at 7 %, this is a near-certain allocation hotspot.
- **Hypothesis**: the helper still allocates intermediate arrays or builds
  short-lived objects per iteration. Reusable scratch buffer.
- **Risk**: low if scoped to internal Skyline state.

### EW-4. `paintStaffLines` per-line strokes
- **Where**: [LineBarRenderer.ts:131](packages/alphatab/src/rendering/LineBarRenderer.ts#L131)
- **Signal**: 1.9 – 3.1 % self-time across canon/nightwish. Five staff lines
  per bar × many bars = thousands of `moveTo`/`lineTo`/`stroke` triplets.
- **Hypothesis**: batch all five staff lines into one Path then stroke once
  per bar. Reduces skia native crossings by ~5x.
- **Risk**: low — purely paint optimisation, no layout impact.

### EW-5. `Map` allocation churn in canon-render
- **Where**: needs tracing — `Map` native frames account for 2.2 MB+ of
  sampled allocations across canon scenarios.
- **Signal**: see "Heap allocation hotspots / canon-render" — three separate
  Map allocation entries totalling > 1 MB.
- **Hypothesis**: per-bar or per-beat scratch Maps that could be reused.
  Pattern matches the wins already landed in T4 batch A (ca1895b4).
- **Risk**: low if call sites are isolated.
- **Next step**: enable `--enable-source-maps` in the bench child and resolve
  the Map allocation frames to source files (currently they show as `<native>`).

### EW-6. Heap profile measures process lifetime, not the measured loop
- **Where**: [harness.ts](packages/bench/src/harness.ts)
- **Signal**: heap top-N is currently dominated by `readNote` / `readBeat`
  (the GP importer) because `--heap-prof` accumulates from process start.
- **Fix**: use the `node:inspector` Heap Profiler API to start sampling at
  the beginning of the measured loop and stop at the end. The CPU profile
  has the same issue but is more diluted by sample volume.
- **Risk**: low — harness-internal change. Lands as `chore(bench)`, not perf.

## Easy wins — landed

(empty — first iteration produced the harness, not yet a measured win)

## Major refactors — deferred

Candidates too large for a single iteration. Each entry: hypothesis,
expected payoff, blast radius, sketch.

### DR-1. Resize path re-walks the whole score even when only viewport width changed
- **Observation**: nightwish-resize median is 102 ms across 4 width changes
  (~25 ms each). Canon resize is 138 ms per width change. resize.layoutResize
  dominates: 99 % of resize.total.
- **Hypothesis**: a width change reuses no per-bar layout state across calls.
  Per-bar sizing is invariant under width changes; only system packing and
  paint should re-run. Caching bar-local widths and just re-running the
  packer could collapse 25 ms → ~5 ms per resize.
- **Risk**: high — touches the layout pipeline's central invariants.
  Affects partial render and lazy loading paths.
- **Estimated payoff**: 3–5x improvement on resize scenarios, addressing the
  user's primary reported pain point directly.

### DR-2. Paint contributes more to "resize" cost than layout
- **Observation**: in canon-resize, layout.finalizeSystem + finalizeStaff
  totals 318 ms out of 4350 ms of resize.layoutResize (~7 %). The remaining
  93 % is in `doResize` outside our instrumented layout stages — almost
  entirely paint and skia ops.
- **Hypothesis**: today's `resize()` re-paints everything. A real fix is
  layout-only resize that defers paint, similar to browser layout/paint
  separation.
- **Risk**: high — public API contract change for `resizeRender`. Could
  break consumers that expect paint to be done by the time the event fires.
- **Estimated payoff**: order-of-magnitude on resize wall time. Biggest
  single lever available.

### DR-3. SkiaCanvas wrapper overhead
- **Observation**: skia native frames (fillText, fillRect, beginRender,
  measureText) account for 15-25 % combined self-time in resize scenarios,
  with multiple stack frames per native call indicating wrapper churn.
- **Hypothesis**: SkiaCanvas adds ~1-2 µs of wrapper logic per glyph paint.
  Across ~10k glyphs per resize, that's 10-20 ms of pure overhead.
- **Risk**: medium — wrapper exists for cross-engine compatibility (Skia /
  HTML5 / SVG).
- **Estimated payoff**: 5-10 % on heavy paint scenarios.

### DR-4. GC pressure 2.4 – 7.2 % of CPU time
- **Observation**: garbage collector consistently ranks in top-5 self-time
  across all scenarios. 7.2 % in nightwish-render is the worst.
- **Hypothesis**: not one site — death by a thousand short-lived objects
  (closures captured in `.map`/`.filter`, Maps recreated per call, etc.).
  Already 6+ T-series perf commits have addressed individual sites; the
  pattern is endemic.
- **Risk**: low per individual fix, but the project needs a sustained
  allocation audit rather than ad-hoc patches.
- **Estimated payoff**: each well-targeted alloc fix is ~0.3-0.8 % global.
  Compounding across 20 sites: 6-15 %.

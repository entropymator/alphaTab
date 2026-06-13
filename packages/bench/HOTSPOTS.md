# alphaTab rendering hotspots

Living backlog. Updated every bench iteration. Numbers in this file refer to
the SVG baseline captured on `feature/perf` HEAD with
`node dist/run.mjs --label svg-baseline-3trials --trials 3 --save-baseline feature-perf`.
See [INITIAL_BASELINE_REPORT.md](./INITIAL_BASELINE_REPORT.md) for the full
report.

The bench uses the **SVG render engine** because that is the primary engine
in the web version of alphaTab. CPU and heap profiles are scoped to the
measured loop only (via `node:inspector`), so they do not contain module
load or score-importer noise.

## Headline numbers (SVG baseline, 3 trials × N iterations)

| Scenario | median* | ± cross-trial σ |
| --- | --- | --- |
| tiny-render | 0.76 ms | ± 0.01 ms |
| nightwish-render | 24.46 ms | ± 0.51 ms |
| nightwish-resize (4 widths) | 31.44 ms | ± 1.24 ms (~7.9 ms/resize) |
| canon-render | 98.96 ms | ± 5.02 ms |
| canon-resize (4 widths) | 130.38 ms | ± 0.46 ms (~32.6 ms/resize) |
| fade-to-black-resize | 72.58 ms | ± 1.98 ms |

`median*` is the median of per-trial medians. The cross-trial σ is the noise
floor for cross-run comparison — a candidate run is only convincingly faster
when its median is ≥ 2σ below the baseline median.

The `nightwish-resize` ≈ 7.9 ms per width change matches the user's reported
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
- **Tried (2026-06-13)**: instance-owned `_scratchSegs` reuse + `.length =` /
  indexed overwrite in the swap-in step regressed canon-resize +6-14 %.
  V8 prefers the fresh short-lived `[]` (packed SMI elements kind, young-gen
  cheap to collect); the `pop()`/`push()` loops on `_segments` were already
  on a fast path that `.length =` + indexed assignment lost. Next: skip the
  array entirely by folding into staff-skyline finalisation, or pool by the
  6-call paired-renderer shape instead of per-instance.
- **Tried (2026-06-13 round 2)**: call-site fold — agent commit `dfacffd9` on
  `worktree-agent-a588fa4918ff7dae6` added `Skyline.unionShifted3(o1, dx1,
  o2, dx2, o3, dx3)` (4-way pair-merge) and collapsed the 6 calls in
  `RenderStaff._unionBarLocalIntoStaffSkyline` down to 2. Algorithmically
  correct — `newSegs` stays a fresh `[]` per call, total merges drop 3×.
  vitest 1599/1599 green. Agent's worktree measurement (3 trials,
  CPU-pinned) showed canon-resize -10.1 % ★, nightwish-resize -9.2 % ★.
  Host re-verification at 3 trials (hot cores, immediately after worktree
  probes): canon-resize +1.2 % `·`. Cooled cores: +1.9 % `~`. Fair 5/5
  re-baseline: canon-resize -1.8 % `·` (0.61σ pooled), fade-to-black-resize
  -4.2 % `~`, all six scenarios directionally faster, no regressions. Per
  strict matrix (target canon-resize `·`) the cherry-pick was dropped.
  **Diagnostic**: the 5-trial baseline included a 34.23 ms first-trial
  outlier on nightwish-resize (vs 17.82-18.64 on trials 2-5) → first-trial
  V8 warmup is sometimes insufficient even with CPU pinning. The patch is
  almost certainly a real ~2 % win but is below the noise floor on
  canon-resize specifically. Reviving it requires either (a) the
  same-process A/B harness already on the determinism roadmap, or (b)
  re-targeting fade-to-black-resize (where `~` was clear) and re-running
  with the warmup beefed up.

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
- **Where**: actually [LineBarRenderer.collectSpaces](packages/alphatab/src/rendering/LineBarRenderer.ts) (no-op stub) overridden in [TabBarRenderer.collectSpaces](packages/alphatab/src/rendering/TabBarRenderer.ts). Path in the HOTSPOTS entry below is wrong — the symbol lives on the renderer hierarchy, not BarLayoutingInfo.
- **Signal**: 0.6 % × 2 frames in canon-resize → polymorphic call site. 4 concrete receiver classes flow through (Score / Slash / Numbered / Tab) — classic 4-way megamorphic IC.
- **Hypothesis**: split into monomorphic variants or inline the no-op stub away.
- **Risk**: low.
- **Tried (2026-06-13)**: eliminated the virtual `collectSpaces` hook by
  extracting a module-level `paintStaffLineRects` helper, having
  `LineBarRenderer.paintStaffLines` pass `null`, and overriding
  `paintStaffLines` directly in `TabBarRenderer`. Refactor compiled clean
  and biome-passed, but the session noise floor on canon-resize had drifted
  to ~10 % wall-clock (reverted-tree control re-run produced +10.5 %
  against the same baseline), which swamps any plausible sub-1 ms / 0.6 %
  × 2-frame win. Next: re-measure round-start fresh, target canon-render
  instead (same hotspot, no resize-loop multiplier), or batch with a
  larger paint-path refactor whose expected delta clears noise.

### EW-4. `fillRect` polymorphism in SvgCanvas
- **Where**: [SvgCanvas.fillRect](packages/alphatab/src/platform/svg/SvgCanvas.ts)
- **Signal**: 3 distinct frames at canon-resize (1.2 % + 0.9 % + 0.6 %).
  Same pattern as the skia-baseline `_fillMusicFontSymbolText`
  polymorphism.
- **Hypothesis**: integer vs float coordinate handling, or
  with/without-style code paths split V8's IC into separate compiled
  variants. Single monomorphic path likely a 1-2 % win.
- **Risk**: low — pure paint optimisation.
- **Tried (2026-06-13)**: the 3 frames are NOT polymorphic IC fan-out —
  they're sample-bucket aggregations of V8-inlined copies at multiple
  callers (paintStaffLines, paintBar, paintBeams, etc.) all pointing at the
  same source line (`runOne.mjs:49856`). Re-baselining with 5/5 then 10/10
  trials showed -2.7 % → +0.5 % depending on noise; intra-function tweaks
  (`scale` local cache, manual `+` chain vs template literal, early-return
  guard) cannot move past noise. Real fix would be reducing call volume
  from a hot caller (see what EW-5 did for staff lines) or batching into
  a fragment list joined once at endRender — both lean toward DR-3.

### EW-5. `paintStaffLines` per-line strokes
- **Where**: [LineBarRenderer.paintStaffLines](packages/alphatab/src/rendering/LineBarRenderer.ts#L131)
- **Signal**: 0.5-0.7 % across all scenarios, two polymorphic frames in
  canon-resize.
- **Hypothesis**: 5 staff lines × many bars = thousands of `moveTo`/
  `lineTo`/`stroke` triplets. Batch into one Path per bar.
- **Risk**: low — paint-only.
- **Tried (2026-06-13)**: agent-worktree patch (commit 60bad13c on
  `worktree-agent-a28e6b018e119d331`) batched the per-bar rects into one
  filled `<path>` per bar. In-isolation `--only canon-resize` measurement
  showed -7.7 % ★ with vitest 1599/1599 green. Host cherry-pick at 3
  trials: canon-resize -1.8 % `·`. At 5 trials: canon-resize -2.7 % `~`,
  nightwish-resize -11.3 % ★. Dropped per strict matrix, then revived
  with nightwish-resize as the target. On a **fair 5/5 trial re-baseline**
  the win evaporated: round-start nightwish-resize median was 20.64 ± 1.14
  (3 trials, biased high) → 18.35 ± 0.40 (5 trials), and the patched
  candidate ran 18.81 (+2.5 % `·`). Canon-resize +2.2 % `~`,
  fade-to-black-resize +4.7 % `~` — directionally worse, not better.
  **Conclusion**: the apparent wins were 3-trial baseline noise; batching
  per-bar rects into one filled `<path>` is NOT faster than emitting 5
  separate `<rect>` elements in this SVG canvas. Likely cause: SVG
  rasterisers special-case `<rect>` (axis-aligned, cheap fill) while a
  `<path>` with rectangular subpaths goes through the general path
  rasteriser. Don't retry this exact shape. If staff-line paint is
  attacked again, do it as `<line>` stroking (closer to the visual
  intent and avoids fill rasterisation) or batch ALL per-bar
  paint elements into one path — not just the rects.

## Easy wins — landed

| ID | Commit | Scenario | Δ ms | Date | Notes |
| --- | --- | --- | ---: | --- | --- |
| EW-6 | `74c133ea` | (harness) | n/a | 2026-06-13 | Heap profile scoped to the measured loop via `node:inspector` Heap Profiler API; ships as `feat(bench)`, not `perf`. |

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

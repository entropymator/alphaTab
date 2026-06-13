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

## Headline numbers (SVG baseline, 5 trials × N iterations — 2026-06-14 post-EW-1)

| Scenario | median* | ± cross-trial σ |
| --- | --- | --- |
| tiny-render | 0.49 ms | ± 0.02 ms |
| nightwish-render | 16.58 ms | ± 1.74 ms |
| nightwish-resize (4 widths) | 20.34 ms | ± 0.47 ms (~5.1 ms/resize) |
| canon-render | 67.01 ms | ± 3.45 ms |
| canon-resize (4 widths) | 90.69 ms | ± 1.29 ms (~22.7 ms/resize) |
| fade-to-black-resize | 46.17 ms | ± 1.04 ms |

Baseline: `node dist/run.mjs --trials 5 --save-baseline analysis-start --label
analysis-start-1781388785` on `feature/perf` `fbff8993`.

`median*` is the median of per-trial medians. The cross-trial σ is the noise
floor for cross-run comparison — a candidate run is only convincingly faster
when its median is ≥ 2σ below the baseline median.

The prior table (canon-resize 130 ms, nightwish-resize 31 ms, etc.) was
captured before EW-1 `f2a44866` landed; the four-way Skyline merge dropped
canon-resize by ~30 % and the σ floor tightened in tandem. Use the table
above for sizing new candidates.

## Easy wins — open

Candidates that look like single-file, no-API-change patches. Verify by
running the relevant scenario with the bench, applying the patch, and
re-running to confirm ≥ 1 % improvement on the target metric with no
visual-test regressions.

### EW-7. Ternary `ElementStyleHelper` `using` sites fall through `elementStyleUsingPlugin` matcher → heavy `_usingCtx` lowering
- **Where**: 3 sites with a ternary initializer:
  - [packages/alphatab/src/rendering/glyphs/BeatGlyphBase.ts:70-77](packages/alphatab/src/rendering/glyphs/BeatGlyphBase.ts#L70-L77)
    — on the canon / nightwish / fade-to-black hot path.
  - [packages/alphatab/src/rendering/glyphs/NumberedNoteHeadGlyph.ts:48](packages/alphatab/src/rendering/glyphs/NumberedNoteHeadGlyph.ts#L48)
    — numbered-notation only, not in bench corpus.
  - [packages/alphatab/src/rendering/glyphs/SlashNoteHeadGlyph.ts:29](packages/alphatab/src/rendering/glyphs/SlashNoteHeadGlyph.ts#L29)
    — slash-notation only, not in bench corpus.
  Hot-path body:
  ```ts
  private _paintEffects(cx: number, cy: number, canvas: ICanvas) {
      using _ = this.effectElement
          ? ElementStyleHelper.beat(canvas, this.effectElement!, this.container.beat)
          : undefined;
      for (const g of this._effectGlyphs) {
          g.paint(cx + this.x, cy + this.y, canvas);
      }
  }
  ```
- **Signal**: bundle frame `_usingCtx` self-time is 15.43 ms / 2.0 %
  canon-resize, 3.17 ms / 1.4 % nightwish-resize, 4.48 ms / 1.1 %
  fade-to-black-resize, ~3 ms canon-render. There are exactly **4**
  `_usingCtx()` call sites in the entire bundle — the 3 above plus
  `SkiaCanvas.measureText` (irrelevant for the SVG bench corpus).
- **Why it allocates so heavily**: the project already ships a custom
  Vite plugin
  [`elementStyleUsingPlugin`](packages/tooling/src/vite.plugin.transform.ts)
  that lowers `using x = ElementStyleHelper.foo(...)` to the cheap
  `const x = ...; try { ... } finally { x?.[Symbol.dispose]?.(); }`
  form — that's what the ~30 other `using` sites in the rendering
  package look like in the bundle, and none of them appear in
  `_usingCtx` self-time. The plugin's matcher `isElementStyleHelperUsing`
  requires `init.type === 'CallExpression'`, but the 3 sites above use
  a **`ConditionalExpression`** initializer, so the matcher rejects them
  and OXC's stock `using` lowering takes over: a wrapper
  `try { var _u = _usingCtx(); _u.u(...); ... } catch (_) { _u.e = _; } finally { _u.d(); }`.
  The `_usingCtx()` factory allocates `{e, u, a, d}`, two
  `using.bind(null, ...)` bound functions, and a fresh `n = []` array
  per call; then `u(...)` pushes a wrapper object into `n`, and `d()`
  runs a `next()` loop. That's 5+ short-lived allocations per
  `_paintEffects` invocation, sustained at the per-beat-container
  call count.
- **Hypothesis (concrete) — two options**:
  - **(a) Source-level fix**: refactor each call site to match the
    plugin's existing `CallExpression` shape. Two equivalent rewrites
    both work — `if (this.effectElement === undefined) { /* loop */;
    return; } using _ = ElementStyleHelper.beat(canvas,
    this.effectElement, this.container.beat); /* loop */`, or a
    method split that pulls the loop into a helper. ~5 lines per
    site, no plugin change.
  - **(b) Plugin-level fix**: extend
    [`isElementStyleHelperUsing`](packages/tooling/src/vite.plugin.transform.ts)
    to accept a `ConditionalExpression` initializer when one branch
    is the `ElementStyleHelper.X(...)` call and the other is
    `undefined` / `void 0` / a sibling `ElementStyleHelper.Y(...)` —
    emit `const _ = (cond ? ElementStyleHelper.X(...) : undefined);
    try { ... } finally { _?.[Symbol.dispose]?.(); }`. Single point
    of fix; covers all 3 sites + future ternary writers.
  Both options eliminate the `_usingCtx` factory entirely from these
  3 sites.
- **Estimated payoff**: -5 to -10 ms canon-resize (-5 to -11 %), -2 to
  -3 ms nightwish-resize, -2 to -4 ms fade-to-black-resize. Even the
  conservative end of each range is ≥ 4× the cross-trial σ floor on
  the named scenario, so a real win should be decisive at
  `--trials 5`. A full attribution of `_usingCtx`'s 15.43 ms
  (canon-resize) ≈ 17 % is the theoretical upper bound; the
  wrapper-dispatch frames around it add a few ms more. The
  Slash / Numbered sites don't show in the bench corpus but the
  plugin-level fix protects them for free.
- **Risk**: low for option (a) — pure source-level refactor, no
  semantic change, mirrors the cheap-form pattern that every other
  `ElementStyleHelper` `using` site already uses. Slightly higher for
  option (b) because it expands the plugin's accepted grammar; mitigated
  by adding a unit test that the rewritten code parses + disposes
  in both branches.
- **Why this isn't EW-2(b)-shaped**: the EW-2(b) lesson was that
  replacing `new T()` with `pool.acquire()` is net-neutral or worse
  because V8's young-gen bump allocator is already fast and the pool's
  bookkeeping has its own cost. This candidate is the opposite shape:
  it **removes** a transpiler-emitted allocation site (the `_usingCtx`
  factory) without introducing any new bookkeeping — the replacement
  is fewer instructions, fewer allocations, and one fewer try/catch
  boundary. The codebase already runs this same transformation on the
  ~30 simple `using` sites; EW-7 just covers the 3 ternary sites that
  slipped through.

### EW-8. `SvgCanvas._escapeText` runs 5 unconditional regex passes
- **Where**: [packages/alphatab/src/platform/svg/SvgCanvas.ts](packages/alphatab/src/platform/svg/SvgCanvas.ts) —
  static `_escapeText` (bundle line 49927):
  ```js
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  ```
- **Signal**: `_escapeText` self-time 16.26 ms / 2.1 % canon-resize,
  9.49 ms / 2.2 % fade-to-black-resize, 3.32 ms / 1.5 % nightwish-resize,
  3.97 ms / 0.7 % canon-render. Called from `SvgCanvas.fillText` on
  every text element painted.
- **Why it costs**: each `.replace(/regex/g, "...")` activates the
  regex engine and scans the full string. On no-match the engine still
  pays the activation + scan cost; only the allocation of a new result
  is skipped. The bench corpus renders mostly numeric text (bar numbers,
  time signatures, fret numbers, tuplet labels, tempo labels) which
  contain no `&<>"'` — the no-match path is the common case, plausibly
  ≥ 80 % of calls.
- **Hypothesis (concrete)**: front-load with a single character-class
  test and early-return the input unchanged on no-match:
  ```js
  static _escapeText(text) {
      if (!/[&<>"']/.test(text)) return text;
      return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  ```
  Per no-match call: 1 regex test instead of 5 full regex+replace
  passes. Per with-match call: same 5 replaces + one extra `test()`
  (~free).
- **Estimated payoff**: assume 80 % of calls are no-match and 4-of-5
  regex engine activations are removed on that path → ~64 % of
  `_escapeText`'s self-time saved. -10 ms canon-resize (-11 %), -6 ms
  fade-to-black-resize (-13 %), -2 ms nightwish-resize (-10 %). The
  conservative half-of-that bound is -5 ms canon-resize ≈ 4× σ — still
  decisive.
- **Risk**: low at the patch level (single file, semantically
  identical), **medium for actually clearing the noise floor**. EW-4
  established that intra-`SvgCanvas` "early-return guards" and similar
  micro-tweaks on `fillRect` couldn't move past noise even at 5/5 and
  10/10 trials. EW-8 differs in mechanism (skipping 4 of 5 regex engine
  activations is a coarser saving than scale-local caching), but the
  family-level lesson is real: verify with the paired A/B harness at
  n=64 before declaring a win, not the multi-process diff which lost
  EW-1 the first time around.

### EW-2. `StaffSystem.buildBoundingsLookup` per-system paint-time work
- **Where**: [packages/alphatab/src/rendering/staves/StaffSystem.ts:1118](packages/alphatab/src/rendering/staves/StaffSystem.ts#L1118) — invoked from `VerticalLayoutBase._paintSystem:383` and `HorizontalScreenLayout:139` once per system during every layout / resize paint.
- **Signal**: 0.7 % nightwish-resize, 1.2 % canon-resize self-time.
- **What it actually is**: builds pixel-coordinate `BarBounds` /
  `BeatBounds` / `NoteBounds` for hit-testing. Coordinates derive from
  `renderer.x`, `renderer.width`, `system.x/y/width/height`, `staff.y` —
  all width-dependent because system packing changes with width.
- **Original EW-2 hypothesis** ("cache the BoundsLookup across width-only
  resizes") is unviable: the bench scenarios cycle widths `[970, 1400,
  800, 1200]`, every iteration changes packing, so any cache signature
  would miss 100 % of the time, and even if it hit the coordinates would
  be wrong.
- **Real sub-opportunities** if this stays a hotspot:
  - **(a)** skip bounds construction entirely when there's no consumer
    of the lookup (no API contract beyond hit-testing requires it after
    every resize — could be lazily built on first
    `findBeat`/`getBeatAtPos` query). Risk medium (changes hit-test
    latency profile; need to ensure `boundsLookup.finish()` is no
    longer eagerly required).
  - **(b)** reduce per-bounds allocation churn — each system creates
    O(bars × beats × notes) small `Bounds` objects per resize. Room
    for object pooling or flat-array storage. **Tried, reverted — see below.**
  - **(c)** collapse the `MasterBarBounds → BarBounds → BeatBounds →
    NoteBounds` tree where staves overlap (currently each visible staff
    reconstructs masterbar entries via the `masterBarBoundsLookup` Map).
    Risk medium.
- **Investigated 2026-06-13 round 3** (worktree `agent-ad88e27bb5b046f2c`):
  no patch attempted; original hypothesis falsified.
- **EW-2(b) object pooling tried 2026-06-13 round 3** (commit
  `2d7a4de3`, reverted as `79beda40`): full bump-allocator design —
  six concrete `ObjectPool<T>` instances on `ScoreRenderer` (one per
  Bounds subclass), `releaseAll()` is O(1) cursor reset, pool
  ownership at the renderer level so backing arrays persist across
  resizes. The cost model said this should clear the ~1.8 MB/iter
  young-gen pressure for ~1.5-2.5 % win on canon-resize. A/B at n=64
  measured **★ +3.0 % canon-resize regression** instead (CI
  [0.79, 2.26], z=-3.50) even after eliminating the megamorphic
  `obj.reset()` call inside `acquire()` and inlining resets at
  concrete call sites. Initial naive version (auto-reset in pool)
  was ★ +5.4 %. nightwish-resize +8 %, canon-render +2 % `·`,
  fade-to-black-resize -1 % `·`. vitest 1599/1599 in both arms.
  **Conclusion**: V8's young-gen bump allocator for `new` is
  competitive (~equal or faster) than even a pool's `_items[cursor++]`
  steady-state acquire, when both are amortised over the actual
  workload. The pool's overhead — property-access chain
  (`renderer.scoreRenderer.boundsPool.acquire()`), the `_recycled`
  empty-check on every acquire, and per-type `reset()` calls — adds
  more cycles than the GC saves. Predicted "8-15 % GC × 20 % alloc
  share = 2 % CPU" doesn't materialise because the GC cost is
  amortised across short-lived objects V8 already collects cheaply.
  The {@link ObjectPool} abstraction from commit `3c0deea4`
  (refactor of `SkylineSegmentPool`) is kept — it's neutral on
  Skyline (where releases are paired and the pool is already
  long-lived) and a reusable shape for any future
  one-pair-many-releases pattern. **Demote**: pooling-style
  allocation reduction on the Bounds tree empirically loses; do not
  retry without a fundamentally different cost model.

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
- **A/B-confirmed below noise floor (2026-06-13 round 3)**: same shape
  re-applied (override `paintStaffLines` on `TabBarRenderer`,
  monomorphic-per-subclass dispatch instead of the 4-way megamorphic
  `collectSpaces`) and verified with the paired A/B harness at n=64.
  Result: canon-resize -0.1 % `·`, canon-render +1.4 % `·`, all six
  scenarios within ±0.5 ms of zero (none clear `★` or even `~`). The
  polymorphic dispatch the profiler flagged is real but its absolute
  cost (~0.3 ms across both frames) is in the same range as
  iteration-to-iteration variance of canon-resize (A/B CI half-width
  ≈ 0.8 ms at n=64). vitest 1599/1599 passed in both runs. This is the
  first time we have decisive evidence that the win simply doesn't
  exist at a measurable scale — not noise, not measurement failure,
  just too small. **Demote**: bundle with a larger paint-path refactor
  only if one materialises for unrelated reasons; standalone the
  candidate cannot clear the σ floor.

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
- **A/B confirmation (2026-06-13 round 3)**: re-measured commit `60bad13c`
  with the paired-sample harness at n=64. canon-resize **`★` +2.0 % /
  +1.05 ms regression** (CI [0.23, 1.79], z=-2.50). canon-render +2.2 %,
  nightwish-resize +1.7 %, nightwish-render +2.7 % — all directionally
  worse, none other than canon-resize clears `★`. Confirms the
  rectangular `<path>` is strictly worse than `<rect>` on this SVG
  canvas. Do not retry this shape.

## Easy wins — landed

| ID | Commit | Scenario | Δ ms | Date | Notes |
| --- | --- | --- | ---: | --- | --- |
| EW-1 | `f2a44866` | canon-resize | -1.55 ms (-3.0 % ★); canon-render -0.60 ms (-2.1 % ★) | 2026-06-13 | Fuse 6 `Skyline.unionShifted` calls into 2 four-way merges via new `unionShifted3`. Revived after the A/B paired harness landed (commit `da928b26`); the multi-process diff couldn't resolve the ~1.5 ms effect because its σ floor exceeded it. A/B at n=64 paired iterations: canon-resize `★`, canon-render `★`, nightwish-resize / fade-to-black-resize directionally faster (`·` trending). vitest 1599/1599. |
| EW-6 | `74c133ea` | (harness) | n/a | 2026-06-13 | Heap profile scoped to the measured loop via `node:inspector` Heap Profiler API; ships as `feat(bench)`, not `perf`. |

## Major refactors — deferred

Candidates too large for a single iteration. Each entry: hypothesis,
expected payoff, blast radius, sketch.

**2026-06-14 analysis-start re-confirms** that the five DR entries
below remain the principal structural levers. Specifically:

- **DR-1** is the largest single lever — the fresh profile shows
  `registerLayoutingInfo` (18.76 ms canon-resize, across two IC
  buckets), `_scaleToForce` (12.92 ms), `scaleToWidth` (6.67 ms), and
  `_emitGroupOverflows` (4.48 ms fade-to-black-resize) all re-running
  per width change despite being bar-local invariant.
- **DR-2**'s GC pressure (canon-render 18.2 %, nightwish-resize
  13.6 %) is now dominated by `unionShifted3`'s 10.6 MB / iter
  allocation footprint (canon-resize), not the Bounds tree. EW-2(b)
  established that pool-style allocation reduction loses against V8's
  young-gen bump allocator, so the next-action under DR-2 is
  **algorithmic call-count reduction** of `unionShifted3` (already
  fused 6→2 by EW-1; further reduction would require either skipping
  union work when offsets unchanged, which folds back into DR-1, or
  reducing the segment list size per union, which requires a
  structural change in how bar-local skylines are emitted).
- **DR-3**'s SvgCanvas paint surface (`_escapeText`, `fillRect`,
  `fillText`, `_fillMusicFontSymbolText`) jointly accounts for
  ~10–12 % of canon-resize CPU. EW-8 attacks the smallest sub-piece
  (`_escapeText`) with a per-call early-return; the rest of the
  surface still sits under DR-3's path-batching banner.
- **DR-4** has been narrowed by three negative results (EW-3, EW-5
  rectangular-path, DR-5 micro-devirt) into a "system-wide refactor
  only" deferred slot — single-symbol devirtualisation is empirically
  below the σ floor.
- **DR-5** still holds; `calculateOverflows` (7.30 ms canon-resize)
  and `getBoundingBoxTop` (6.88 ms canon-resize, multiple frames) are
  still the same chained virtual-call surface, blocked on a layout-
  lifecycle hook.

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

### DR-5. `getBoundingBoxTop` polymorphism — needs lifecycle support
- **Where**: `Glyph.getBoundingBoxTop` (base, returns `this.y`) + 16
  overrides across [packages/alphatab/src/rendering/glyphs/](packages/alphatab/src/rendering/glyphs/).
  Hot callers: [BarRendererBase.calculateOverflows](packages/alphatab/src/rendering/BarRendererBase.ts) (3 call sites) and
  `_finalizeTies`, both reached on every `reLayout` via the resize path.
- **Signal** (post-determinism baseline): 3.3 % self-time on
  fade-to-black-resize (12.30 ms), 2.2 % on nightwish-resize (4.97 ms),
  1.3 % on canon-resize, plus the same source symbol shows up at
  distinct call sites — classic megamorphic dispatch fan-out.
- **Why naive caching is unsafe**: the "invariant after layout" claim
  fails. `TieGlyph.doLayout` sets `this.y` and reruns via
  `_finalizeTies` after layout shifts. `ScoreNoteChordGlyph` mutates
  child `effect.y` during voice-container `applyLayoutingInfo` re-layout.
  `MultiVoiceContainerGlyph._scaleToForce` triggers downstream
  `scaleToWidth` chains. Container glyphs (`GlyphGroup`,
  `MultiVoiceContainerGlyph`) recurse over children whose `.y` can
  change during their own `doLayout` reruns — a parent's cached value
  goes silently stale when a child is re-laid out. There is no
  existing "all-layout-done" flag (`isFinalized` is set at the START
  of `finalizeRenderer`, not the end of the final `applyLayoutingInfo`).
- **Why naive dispatch table is unsafe**: pre/post-beat glyphs are
  populated with at least 8 distinct subtypes flowing through the hot
  loop; a monomorphic-dispatch table would need 8+ `instanceof` branches
  and likely be net-neutral vs the IC miss it tries to avoid.
- **Path forward**: introduce an end-of-finalize lifecycle hook that
  fires after `applyLayoutingInfo` has run on every renderer in the
  staff, letting each glyph populate a stable
  bounding-box-top/bottom field. The hot loop then reads two numeric
  fields per glyph and no virtual is needed. ~3-4 touchpoints in
  `BarRendererBase` / `StaffSystem` / `ScoreLayout`.
- **Alternative**: skip caching entirely; instead lift the hot
  per-glyph loop out of `calculateOverflows` by maintaining a running
  min/max y at `addPreBeatGlyph` time (push-based skyline).
- **Risk**: high — lifecycle hook touches the layout pipeline contract.
- **Estimated payoff**: 12-15 ms saved per resize-heavy scenario at
  the lifecycle-hook variant; possibly less at the push-skyline variant.
- **Investigated 2026-06-13 round 3** (worktree `agent-a8b7633e1140de83c`):
  identified the lifecycle gap above; no patch applied.
- **Micro-devirt also doesn't help (2026-06-13 round 3 follow-up)**: the
  base `Glyph.getBoundingBoxBottom` does `return this.getBoundingBoxTop()
  + this.height` — a self-virtual call. Tried inlining it to
  `this.y + this.height` (with explicit overrides on the two MusicFont*
  classes that need offset semantics). A/B at n=64 showed canon-resize
  -1.2 % `·` (z=1.75, CI just touching 0); at n=128 the effect dropped
  to -0.9 % `·` (z=1.24). Below the harness's resolution floor.
  **Implication**: the 12.3 ms self-time on `getBoundingBoxTop` is
  dominated by the function bodies (smuflMetrics lookups, recursion in
  GlyphGroup), not by dispatch overhead per se. Removing virtual calls
  one at a time will not move the needle on this hotspot — the win has
  to come from restructuring (push-based skyline, full lifecycle hook)
  or from DR-4-shape system-wide polymorphism collapse. Reverted.

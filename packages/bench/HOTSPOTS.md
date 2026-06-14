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

## Headline numbers (SVG baseline, 5 trials × N iterations — 2026-06-14 post-EW-8 + resize-drag)

| Scenario | median* | ± cross-trial σ |
| --- | --- | --- |
| tiny-render | 0.44 ms | ± 0.01 ms (1.43 %) |
| nightwish-render | 13.70 ms | ± 1.20 ms (8.79 %) |
| nightwish-resize (4 widths) | 18.41 ms | ± 1.45 ms (7.86 %, ~4.6 ms/resize) |
| canon-render | 60.77 ms | ± 3.01 ms (4.96 %) |
| canon-resize (4 widths) | 76.92 ms | ± 1.97 ms (2.56 %, ~19.2 ms/resize) |
| fade-to-black-resize | 41.16 ms | ± 3.04 ms (7.39 %) |
| **canon-resize-drag (12 widths)** | **235.30 ms** | **± 3.48 ms (1.48 %, ~19.6 ms/resize)** |

Baseline: `node dist/run.mjs --trials 5 --save-baseline resize-drag --label
resize-drag-1781434957` on `feature/perf` `39e5232e`. `canon-resize-drag` was added
in this commit to amplify the resize path for analysis — it cycles widths in a
sustained browser-drag pattern (1400→600→850), driving 12 resizes per `driveOnce`
so the CPU profile is ~3× more densely sampled per resize than canon-resize.

The `1 % σ-floor for candidates` is the smallest delta a scenario can resolve:
- canon-resize-drag: **2.35 ms** (1 % of 235 ms); σ at 3.48 ms means a ≥ 2σ
  candidate needs ≥ 7 ms. Both thresholds quoted per candidate below.
- canon-resize: 0.77 ms; ≥ 2σ needs ≥ 3.94 ms.

`median*` is the median of per-trial medians. The cross-trial σ is the noise
floor for cross-run comparison — a candidate run is only convincingly faster
when its median is ≥ 2σ below the baseline median.

The pre-EW-1 table (canon-resize 130 ms, nightwish-resize 31 ms, etc.) was
captured before `f2a44866` landed; the four-way Skyline merge dropped
canon-resize by ~30 % and the σ floor tightened in tandem. The numbers above
reflect HEAD with EW-1, EW-7, EW-8 landed. Use this table for sizing new
candidates.

## Easy wins — open

Candidates that look like single-file, no-API-change patches. Verify by
running the relevant scenario with the bench, applying the patch, and
re-running to confirm ≥ 1 % improvement on the target metric with no
visual-test regressions.

### EW-9. Skip bar-local `reLayout` work on width-only resize
- **Where**: [BarRendererBase.reLayout](packages/alphatab/src/rendering/BarRendererBase.ts) (`_registerLayoutingInfo` + `calculateOverflows` + `_emitGroupOverflows` body); the gate goes on the `BarRendererBase` itself.
- **Signal (canon-resize-drag, 2026-06-14 5-trial baseline)**:
  - `MultiVoiceContainerGlyph.registerLayoutingInfo` — 2.99 % CPU (~7.0 ms/iter)
  - `BarRendererBase.calculateOverflows` — 1.33 % (~3.1 ms/iter)
  - `_emitGroupOverflows` — 1.00 % (~2.4 ms/iter)
  - **`LineBarRenderer._computeBeamingBounds`** — 1.22 % (~2.9 ms/iter) — invariant in stem-local coords, only post-spring X resolves differently
  - Combined upper bound on canon-resize-drag: **~12-16 ms / iter (5-7 %, clears σ at ≥3×)**.
- **Hypothesis**: the bar-local broker state (`BarLayoutingInfo` pre/postBeatSize/onTimeX) and the pre/post-beat local skylines are functions of bar content only — they don't change when system width changes. `reLayout` re-emits both every width change. Add a `_layoutVersion`-style guard on `BarRendererBase`: when bar content hasn't changed since last `reLayout`, skip the `_registerLayoutingInfo()` + `calculateOverflows()` rebuild and only run `updateSizes()` + the downstream `_scaleToWidth` chain (which IS width-dependent and must re-run). Beam endpoint computation (`_computeBeamingBounds`) folds into the same gate because beam-group composition is model-derived.
- **Risk**: medium. The `BarLayoutingInfo` broker is shared across staves of the same `MasterBarsRenderers`; cross-stave invalidation needs verification. `applyLayoutingInfo` post-layout mutates child `.y` (see DR-5 lifecycle note) so the cache must invalidate on tie-finalize / voice-merge events.
- **First slice of DR-1**: this is the smallest patch shape that materialises DR-1's "width-only resize re-walking" thesis with a single guard. Larger sliver (skip `_scaleToForce` when `actualBarWidth` collides via `force` bucketing) is documented under DR-1.
- **Investigated 2026-06-14**: 5-trial baseline + 6-subagent profile cross-check (layout-walk + beam agents converged on identical width-invariance verdict). No patch attempted. ≥ 2σ requires ≥ 7 ms improvement on canon-resize-drag — comfortably inside the 12-16 ms upper bound.

### EW-10. Batched-fillRect typed buffer in SvgCanvas
- **Where**: [SvgCanvas.fillRect](packages/alphatab/src/platform/svg/SvgCanvas.ts#L52) — sole emission site for all rect output.
- **Signal (canon-resize-drag)**: `fillRect` is the **#1 CPU hotspot at 7.80 % (18.2 ms/iter)**; dominant caller is `paintStaffLines` (~5 rects × N bars × M segments per system). Per-call cost is template-literal serialisation (5 number-to-strings + 1 color getter + buffer concat).
- **Hypothesis**: defer string serialisation. Push `(x, y, w, h, colorHash)` into a flat numeric buffer per call; flush the buffer to a `<rect>`-per-record string in `endRender`. Keeps the `<rect>` element kind (avoids EW-5's general-rasteriser trap), but removes the per-call template-literal cost — typed-array store dominates over interpolation when call count > ~10k/iter.
- **Estimated payoff**: **2-4 ms / iter on canon-resize-drag**; >σ floor (3.48 ms 2σ ≈ 7 ms requires a stretch).
- **Risk**: medium. SvgCanvas API contract change (deferred flush); needs to maintain ordering when interleaved with other primitives (`fillText`, `stroke`). One-area refactor; doesn't touch alphatab callers.
- **Fundamentally-different shape vs demoted**: EW-4 was intra-function tweaks (5 number-to-strings are still present per call); EW-5 swapped `<rect>` for rectangular `<path>` (different element kind, lost to rasteriser). EW-10 keeps `<rect>` and removes per-call interpolation by deferring serialisation. New shape.
- **Investigated 2026-06-14**: paint subagent identified call-volume (10k+ calls/iter from `paintStaffLines` + chord/stem/sustain glyphs) and emission shape (single function body, no polymorphic fan-out). No patch attempted.

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
| EW-7 | `ac8606e7` | canon-resize | -2.92 ms (-5.4 % ★); fade-to-black-resize -2.10 ms (-9.8 % `·`); nightwish-resize -0.20 ms (-2.4 % `·`); canon-render -0.40 ms (-1.4 % `·`); nightwish-render -0.12 ms (-2.7 % `·`) | 2026-06-14 | Extend `elementStyleUsingPlugin` matcher to also lower `using x = cond ? ElementStyleHelper.X(...) : undefined` (and chained variants) to the cheap `const x = ...; try { ... } finally { x?.[Symbol.dispose]?.(); }` form. Three ternary sites — `BeatGlyphBase._paintEffects` (hot path), `NumberedNoteHeadGlyph.paint`, `SlashNoteHeadGlyph.paint` — previously fell through the matcher's `CallExpression`-only check and got OXC's stock `_usingCtx()` runtime (5+ allocations per call). Bundle `_usingCtx()` references: 5 → 2 (only `SkiaCanvas.measureText` remains, intentionally out of plugin scope). A/B at n=64 (`probe-EW-7`): canon-resize `★` CI [-3.41, -2.65] z=6.75; every other scenario directionally faster, no `★` regressions. vitest 1599/1599. |
| EW-8 | `2251590d` | canon-resize | microbench: -90.9 % (107.0 → 9.7 ns/call); scenario: directional only (`·` at 5/5 trials) | 2026-06-14 | Short-circuit `SvgCanvas._escapeText` with a single character-class `test()` when the input has no `& < > " '`. Bench corpus is mostly numeric text → V8 returns the input ref on no-match. **Note on the ship decision** (see `scripts/escape-microbench.mjs` + `scripts/escape-matrix.mjs` for the full evidence): the original ship was based on a single n=64 paired A/B that landed `★ -0.69 ms`. A subsequent 11-variant × 7-trial microbench confirmed the function-level win is real and large (V1 = current shipped is 11× faster than V0 = pre-EW-8 in isolation, 9.7 vs 107 ns/call). But the scenario-level effect is below the multi-process diff's σ floor at 5 trials — repeated 3× n=64 A/B trials showed sign-flipping with `★` significance, and the 5/5 multi-process diff against the V0 baseline showed canon-resize -5.7 % / canon-render -8.5 % / fade-to-black -7.8 % but all `·` (no scenario clears `★`). V1 is kept because the change is microbench-justified, directionally positive on the heavy scenarios, simpler than V7 (charCodeAt single-pass — microbench fastest at 7.6 ns/call but scenario-indistinguishable from V1), and free of regressions. Faithful application of AGENT_WORKFLOW.md's `★ required` rule at single-trial n=64 was the wrong methodology here — at this Δ-ms range the bench needs cross-trial sampling. vitest 1599/1599. |

## Major refactors — deferred

Candidates too large for a single iteration. Each entry: hypothesis,
expected payoff, blast radius, sketch.

**2026-06-14 canon-resize-drag baseline re-confirms** that the DR entries
below remain the principal structural levers, with quantified upper bounds:

- **DR-1** is the largest single lever — width-only re-walking on
  canon-resize-drag costs ~14 ms / iter truly invariant
  (`registerLayoutingInfo` 7.0 + `calculateOverflows` 3.1 +
  `_emitGroupOverflows` 2.4 + `_computeBeamingBounds` 2.9). `EW-9` is
  the smallest patch shape that captures this slice; full
  content-version cache is 12-30 ms total.
- **DR-2**'s GC pressure (canon-render 18.2 %, nightwish-resize
  13.6 %, canon-resize-drag 5.1 %) is dominated by `unionShifted3`'s
  5.4 MB / iter footprint (84 % of canon-resize-drag heap). EW-2(b)
  established pool-style replacement regresses; 2026-06-14 GC subagent
  established `newSegs[]` write-cursor reduction is also sub-σ wall
  (V8 young-gen amortises near-zero). Path forward is **structural
  reduction of the union-call count** (DR-1 folds union skips into
  itself), not single-site alloc surgery.
- **DR-3**'s SvgCanvas paint surface jointly accounts for ~13.7 % of
  canon-resize-drag CPU (32.2 ms / iter). EW-8 attacks the smallest
  sub-piece; `EW-10` (batched-fillRect typed buffer) is the next
  concrete shape — fundamentally different from demoted EW-4/EW-5 by
  deferring serialisation while keeping `<rect>` element kind.
- **DR-4** narrowed by three negative results (EW-3, EW-5 rect-path,
  DR-5 micro-devirt) to a "system-wide refactor only" deferred slot —
  single-symbol devirtualisation is empirically below the σ floor.
- **DR-5** re-scoped — `getBoundingBoxTop` now totals 3.77 % CPU /
  9 ms / iter across ≥ 8 frames on canon-resize-drag, called from a
  third caller class (`_emitTies`); a unified end-of-finalize
  lifecycle hook now pays back across overflows + tie-emit + the
  bounds tree (with DR-6).
- **DR-6 (new)** push-based bounds tree — analogue of DR-5's
  push-skyline for `buildBoundingsLookup` (7.4 % CPU / 17.4 ms / iter
  across three call sites). Eliminates the *pull-shaped* per-bar
  allocation pattern that pool-style EW-2(b) lost to. 5-8 ms / iter
  payoff, ~1.18 MB / iter heap drop.

### DR-1. Resize re-walks every bar even when only the viewport width changed
- **Observation**: canon-resize-drag is 19.6 ms per width change × 12 widths.
  `layout.doResize` dominates `resize.total`. Bar-local sizing is invariant
  under a width change; only system packing + paint should re-run.
- **Hypothesis**: cache the per-bar layout result, re-pack systems only.
  Could collapse 19.6 ms → ~10-12 ms per resize.
- **Risk**: high — touches the layout pipeline's central invariants.
- **Estimated payoff**: ~40 % of canon-resize-drag wall-clock is in the
  layout pipeline; DR-1 with full bar-content-version caching could
  realistically save 12-30 ms / iter (5-13 %). Largest single lever.
- **Quantified 2026-06-14 (drag baseline + 4 subagent cross-check)**:
  - **Truly width-invariant** (re-runs every resize for no reason): ~14 ms /
    iter (`registerLayoutingInfo` 7.0 + `calculateOverflows` 3.1 +
    `_emitGroupOverflows` 2.4 + `_computeBeamingBounds` 2.9 — `EW-9`
    captures this).
  - **Width-bucket-memoisable** (`force`-keyed): `_scaleToForce` (34 ms /
    iter); `force = spaceToForce(width)` bucketing may collide across
    nearby drag widths, lifting 20-30 % hit-rate × 34 ms ≈ 3-5 ms / iter.
  - **System-packing-stable cases** (drag widths that pack identically):
    skip `_systems = []; createEmptyStaffSystem(...); addBarRenderer(...)`
    rebuild — 5-10 ms / iter when membership stable, indeterminate
    fraction across 12 drag widths.
  - **Genuinely width-dependent (intrinsic)**: Skyline union shift,
    `_scaleToWidth` body, paint markup generation — ~85 % of wall-clock.
- **EW-9 is the smallest patch shape** that delivers a slice of DR-1; the
  full content-version cache is the structural endgame.

### DR-2. GC pressure 8-10 % of CPU across resize scenarios
- **Observation**: GC is consistently the top self-time entry across all
  resize scenarios (9.9 % nightwish-resize, 8.9 % canon-resize, 5.1 %
  canon-resize-drag). Six prior T-series perf commits attacked individual
  allocation sites; the pattern persists.
- **Hypothesis**: not one site — death by a thousand short-lived objects
  (closures, Maps, sort keys, segment objects). Needs a systematic
  allocation audit, not ad-hoc patches.
- **Risk**: low per individual fix; the project needs sustained focus.
- **Estimated payoff**: each well-targeted alloc fix is 0.3-0.8 % global;
  compounding across 20 sites: 6-15 %.
- **2026-06-14 audit findings (drag baseline + GC subagent)**: heap on
  canon-resize-drag is 6.4 MB / iter; **`unionShifted3` is 84 %** of it
  (5.4 MB / iter, ~5,672 calls), dominated by the per-call `newSegs:
  SkylineSegment[] = []` scratch array + its push-grown backing store +
  the final transfer into `this._segments`. The only algorithmically-
  distinct shape is a **write-cursor refactor** (write directly into
  `this._segments` with `.length = newLen` truncation, eliminating
  `newSegs` entirely) — pool-style is empirically demoted by EW-2(b).
  Cost-honest upper bound: **0-2 ms / iter (0-0.85 %, below σ)** because
  V8 young-gen amortises short-lived alloc near-zero, as EW-2(b)
  established. **Conclusion**: the GC self-time on this codebase is
  *not* recoverable by reducing the alloc share of any single site —
  pool-style and write-cursor approaches both lose to V8's bump
  allocator. The remaining DR-2 lever is **structural reduction of the
  union-call count itself** (DR-1's "skip union work when offsets
  unchanged" angle), not single-site alloc surgery.
- **Demoted at this site (do not retry standalone)**: `unionShifted3`
  `newSegs[]` write-cursor (≤ 0.85 % wall); `_raiseRange` splice-array
  trim (~0.6 ms cap); `Skyline.reset()` keep-sentinels (sub-σ on CPU);
  staff-level `unionShiftedAll` fuse (0.5-1 ms upside, (S) with medium
  risk). Bundle these with a DR-1 layout-cache landing only — none are
  worth the risk alone.

### DR-3. SvgCanvas string-concat paint API
- **Observation**: with the SVG engine, paint cost is no longer dominated
  by native calls (as it was with skia). Instead the cost is JS-side
  markup generation: string concatenation per glyph, attribute formatting,
  etc. **canon-resize-drag profile**: paint surface (`fillRect` 7.80 % +
  `_fillMusicFontSymbolText` 2.49 % + `fillText` 2.02 % + `lineTo` 1.39 %)
  = **13.7 % CPU / 32.2 ms / iter**.
- **Concrete sketches** (2026-06-14 paint subagent):
  1. **Batched-fillRect typed buffer** — push `(x, y, w, h, color)` to a
     flat array, serialise once in `endRender`. Removes per-call
     template-literal cost while keeping `<rect>` element kind (avoids
     EW-5 trap). 2-4 ms / iter on canon-resize-drag. Captured as `EW-10`.
  2. **Beam-bar path coalescing** — `paintBar` already emits `<path>`s
     for beam segments (N×3 paths per bar collapsing to one `<path>`).
     ~1.6 ms / iter (below σ standalone; bundles with the above).
  3. **Vertical-broadcast `paintStaffLines`** — single primitive emits
     5 rects at the same x,w with different y values; ~1.2 ms saved.
     Below σ standalone.
- **Risk**: medium — API contract change for SvgCanvas, affects every
  glyph paint method that participates.
- **Estimated payoff**: 3-5 ms / iter on canon-resize-drag (1.3-2.1 %) for
  the buffer-batched fillRect alone; 10-20 % is plausible only if the
  paint API moves entirely to deferred-flush across rect + path + text.

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
- **Surface broadened (2026-06-14 drag baseline)**: `getBoundingBoxTop`
  now aggregates **3.77 % CPU self / 9 ms / iter** across ≥ 8 distinct
  frames in canon-resize-drag, and it's called from a **third caller
  class** beyond `calculateOverflows`/`_finalizeTies` — namely
  `BarRendererBase._emitTies` (the on-resize tie cleanup path). A unified
  end-of-finalize lifecycle hook now pays back across three caller
  classes (overflows, tie emission, and — if combined with DR-6 — the
  bounds tree), keeping the 12-15 ms payoff estimate consistent.
  Recommend re-scope DR-5 from "calculateOverflows + getBoundingBoxTop"
  to "all glyph-tree min/max-y walks (overflows + tie emit + bounds
  tree)".

### DR-6. Push-based bounds tree (analogue of DR-5's push-skyline)
- **Where**: [BarRendererBase.buildBoundingsLookup](packages/alphatab/src/rendering/BarRendererBase.ts#L784), [RenderStaff.buildBoundingsLookup](packages/alphatab/src/rendering/staves/RenderStaff.ts), [StaffSystem.buildBoundingsLookup](packages/alphatab/src/rendering/staves/StaffSystem.ts#L1200), + downstream `BarBounds`/`BeatBounds`/`NoteBounds` constructors.
- **Signal (canon-resize-drag)**: three call sites sum to **7.4 % CPU
  (~17.4 ms / iter)** + 1.93 % heap. Currently *pull-shaped* — at paint
  time the system walks every renderer asking "what is your bounds?",
  recursively allocating a fresh `BarBounds` / `BeatBounds` / `NoteBounds`
  tree off coordinates that layout already computed.
- **Hypothesis**: when layout finalises `staff.y`, `renderer.x/width/height`
  it writes the same numbers into bounds slots already attached to the
  renderer / voice-container / note. `buildBoundingsLookup` becomes
  pointer-shuffling into the lookup's flat lists — no tree recursion, no
  per-bar allocation. **This is NOT caching across resizes** (which EW-2
  demoted because packing changes) — it's eliminating duplicate
  computation within a single resize.
- **Why this is fundamentally different from EW-2(b) pooling**: EW-2(b)
  kept the pull-shaped allocation pattern and tried to replace `new` with
  pool acquire. The pool's overhead (property chain, recycled-array
  check, per-type reset) was net-negative vs V8's young-gen bump. DR-6
  removes the allocation pattern entirely by piggy-backing on layout-
  time data the renderer already has — no pool, no fresh constructions.
- **Risk**: high — every `buildBoundingsLookup` override along the chain
  plus the `BoundsLookup.finish()` shape would need to grow
  `addBarBoundsRef(barBounds)`-style indirection. Cross-cutting refactor.
- **Estimated payoff**: 5-8 ms / iter (2-3 %) on canon-resize-drag; alloc
  drop ~1.18 MB / iter. Stacks with DR-5 (shared "end-of-finalize"
  lifecycle hook) and with the "lazy build on first findBeat query"
  variant from EW-2(a).

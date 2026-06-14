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

## Headline numbers (SVG baseline, 5 trials × N iterations — 2026-06-14 post-DR-1 broker-lifecycle)

| Scenario | median* | ± cross-trial σ |
| --- | --- | --- |
| tiny-render | 0.42 ms | ± 0.01 ms (3.41 %) |
| nightwish-render | 12.72 ms | ± 0.24 ms (1.86 %) |
| nightwish-resize (4 widths) | 15.73 ms | ± 0.11 ms (0.72 %, ~3.9 ms/resize) |
| canon-render | 57.62 ms | ± 2.28 ms (3.96 %) |
| canon-resize (4 widths) | 71.29 ms | ± 1.26 ms (1.77 %, ~17.8 ms/resize) |
| fade-to-black-resize | 38.52 ms | ± 1.29 ms (3.34 %) |
| **canon-resize-drag (12 widths)** | **217.80 ms** | **± 1.34 ms (0.62 %, ~18.2 ms/resize)** |

Baseline: `node dist/run.mjs --trials 5 --save-baseline DR1-final --label DR1-final`
on `feature/perf` `06658555`. The DR-1 broker-lifecycle landing (`eddf9bc1`)
moved every scenario; multi-process diff against the pre-DR-1 baseline shows
canon-resize-drag -17.50 ms (-7.4 %) ★, canon-resize -5.63 ms (-7.3 %) ★, and
every other scenario directionally faster (none `★` regressing). The σ floor
on canon-resize-drag tightened from 1.48 % to 0.62 % as a side effect — less
variance from the formerly-repeated voice-container walk. `canon-resize-drag`
was added in `dd530e65` to amplify the resize path for analysis — it cycles
widths in a sustained browser-drag pattern (1400→600→850), driving 12 resizes
per `driveOnce` so the CPU profile is ~3× more densely sampled per resize
than canon-resize.

The `1 % σ-floor for candidates` is the smallest delta a scenario can resolve:
- canon-resize-drag: **2.18 ms** (1 % of 218 ms); σ at 1.34 ms means a ≥ 2σ
  candidate needs ≥ 2.7 ms. Both thresholds quoted per candidate below.
- canon-resize: 0.71 ms; ≥ 2σ needs ≥ 2.52 ms.

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

### EW-3. `collectSpaces` polymorphism — LANDED 2026-06-14 (Option A: layout-time gap cache)
See "Easy wins — landed" table below. Original 2026-06-13 round-1/round-3 narrative kept in the plan postscript at
`packages/bench/analysis/2026-06-14-resize-drag/EW-3-PLAN.md` §13.
The 2026-06-13 attempts shipped **monomorphisation only** (Option B in
the plan §4 matrix), which moved ~0.3 ms / 0.6 % — below σ. The 2026-06-14
ship is **Option A** (per the plan §4 / §8): layout-time gap descriptor
cache (`stringIndex`, `relativeX`, `width`, `BeatContainerGlyphBase` ref),
bucketed per staff-line at layout, paint-time projects absolute x via
`beatGlyphsStart + bg.x + relativeX` and emits `fillRect` directly from
the cache. Skips both the per-paint `Float32Array[][]` allocation and the
per-gap `Float32Array(2)` allocation that the legacy `collectSpaces`
shape carried.

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
| EW-9 (Variant B) | `63e1afef` + `bfcd943f` | canon-resize-drag | -9.69 ms (-5.9 % ★) at n=64 paired A/B | 2026-06-14 | Gate `calculateOverflows` (+ its `_emitGroupOverflows` + `ScoreBarRenderer.calculateBeamingOverflows` chain) behind a per-renderer `_layoutInvariantCached` flag set at the tail of `doLayout`. The plan (`packages/bench/analysis/2026-06-14-resize-drag/EW-9-PLAN.md`) opened with a max-skip that ALSO short-circuited `_registerLayoutingInfo` — Phase 3 vitest exposed 7 visual regressions, all explained by `StaffSystem.addMasterBarRenderers:293` explicitly resetting `renderers.layoutingInfo.preBeatSize = 0` at the head of every resize. With the broker reset un-mitigated, the skipped `_registerLayoutingInfo` left `preBeatSize=0` and bars stacked at x=0 (visible diff: multi-system-slur-scale-up 23 bars on top of each other). The plan §3.4 broker-persistence assumption is falsified by this reset; Variant B (per §8.2) demotes the gate to `calculateOverflows`-only and keeps `_registerLayoutingInfo` always-on. Cache invalidated by `recreatePreBeatGlyphs` and `invalidateLayoutCache` (Phase 4 hook); survives `afterReverted` (the whole point of the optimisation). A/B paired at n=64 against `bb8ad4fb`: canon-resize-drag `★` Δ=-9.69 ms CI [-12.06, -4.91] z=6.50 58/64 wins. Multi-process diff at 5/5 trials shows -4.53 ms on canon-resize-drag (`·` — the paired A/B is the authoritative measurement for sub-5 % shifts). No `★` regression on any other scenario. vitest 1599/1599. The naive max-skip (`63e1afef`) is the first commit, kept as a bisect anchor; the narrowing (`bfcd943f`) is the shipped form. |
| EW-10 (Phase A only) | `244c8e0b` | canon-resize-drag | -4.14 ms (-2.7 % ★) at n=64 paired A/B vs `be8b724b` | 2026-06-14 | `SvgCanvas.fillRect` scale=1 fast path with manual `+` concat replacing the template literal. Per Phase 0 §8.1 instrumentation (114,307 fillRect calls / iter on canon-resize-drag, ~171 ns each, 100 % at scale=1 in the bench workload), eliminating the 4 `*scale` multiplies plus avoiding the template literal's number-formatting overhead clears 2σ. The scale!=1 branch keeps the original template literal so HiDPI rendering is unchanged. Phase B (`fillRectBatched` + `paintBackground`-end flush + paintStaffLines migration) was attempted in the executor's working tree and falsified — full record in `analysis/2026-06-14-resize-drag/EW-10-PLAN.md` §18. Phase B vs Phase A measured `·` Δ +1.80 ms (n=64 paired) and `·` Δ -0.07 ms at a v2 implementation — batching-buffer overhead eats the per-call savings on this workload. n=64 paired A/B (Phase A only): canon-resize-drag `★` Δ=-4.14 ms CI [-6.12, -2.26] z=2.75 43/64 wins. vitest 1599/1599. |
| EW-3 (Option A) | `4f89adda` | canon-resize-drag | -4.09 ms (-2.5 % ★) at n=64 paired; -4.34 ms (-2.7 % ★) at n=128 paired vs `05ec1dbb` | 2026-06-14 | Layout-time gap descriptor cache + paint-time projection per plan §4 Option A. `TabBarRenderer.doLayout` builds packed per-bar arrays (`Uint32Array` bucket-end offsets, `Float32Array(2N)` for `relativeX`+`width`, `BeatContainerGlyphBase[]` for live `bg.x` lookup) bucketed by staff-line index. `paintStaffLines` is overridden in `TabBarRenderer` and reads the cache directly — skips the legacy virtual dispatch, the per-paint `Float32Array[][]` outer alloc, the per-gap `Float32Array(2)` alloc, AND the per-line `line.sort()` (gaps are already in beat-iteration / x-ascending order; rare grace-beat inversions take a slow path with insertion sort on a tiny segment). Phase 0 §6.2 verified Outcome B (widths and intra-bar offsets layout-stable; only `bg.x` shifts per resize) — algebraic foundation of the projection cache. Phase 0 §6.4 found `paintStaffLines` emit cost is 92.5 % of its self-time; Option A removed the remaining 14.8 % collectSpaces + 7.5 % pre-emit sort. Bundles plan options B (drop the no-op virtual stub: kept the override but the consumer no longer routes through it on the hot path), G (TabBarRenderer's `paintStaffLines` override is a `instanceof`-equivalent short-circuit at the V8 dispatch level), I (packed buffers replace `Float32Array[][]`). Cache invalidation follows the `_voiceWalkDone` lifecycle precedent — survives `afterReverted` (DR-1 §18 anti-pattern avoided), invalidated by `recreatePreBeatGlyphs` and `invalidateLayoutCache`. n=64 paired A/B vs `05ec1dbb`: canon-resize-drag `★` Δ=-4.09 ms CI [-5.93, -1.37] z=2.50 42/64 wins. n=128 confirmation: `★` Δ=-4.34 ms CI [-5.37, -3.02] z=4.95 92/128 wins. 5-trial session-paired multi-process diff: canon-resize-drag -2.94 ms (-1.3 % `·`), no `★` regression on any scenario. vitest 1599/1599. Full plan + Phase 0 probe findings + execution outcome in `analysis/2026-06-14-resize-drag/EW-3-PLAN.md` §13 and `EW-3-PHASE0-PROBES.md`. |

## Major refactors — landed

Structural changes that crossed the "Easy win" boundary (multi-file or
semantic contract change) and shipped.

### DR-1 broker-lifecycle — `_registerLayoutingInfo` walk-skip
- **Commit**: `eddf9bc1` (2026-06-14)
- **Scope**: single file (`BarRendererBase.ts`, ~25 lines) + 9 reference PNGs.
  Semantic change: `MultiVoiceContainerGlyph.registerLayoutingInfo` (and
  `topEffects`/`bottomEffects` registration) now run only once per renderer
  lifetime instead of every resize cycle.
- **Mechanism**: split `BarRendererBase._registerLayoutingInfo` into two
  slices. The cheap pair (`info.preBeatSize`/`postBeatSize` max-of writes)
  runs every cycle — required because `StaffSystem.addMasterBarRenderers:293`
  resets `preBeatSize = 0` at every resize entry. The expensive
  voice-container walk runs only when the `_voiceWalkDone` flag is false.
  The walk's broker outputs (`springs`, `_beatSizes`, `_timeSortedSprings`,
  `allGraceRods`, `_minDuration`, `postBeatSize`) have no external reset
  path, so subsequent calls would just re-write identical values via the
  `max-of` accumulators. Skipping them is a pure throughput win.
- **Phase 1 instrumentation** (~60 000 byte-identity comparisons across
  canon-resize-drag) verified zero broker drift on stable bars.
- **Critical lifecycle detail**: `_voiceWalkDone` survives `afterReverted`.
  The plan's first sketch (v1) invalidated it there, but `afterReverted`
  fires on every renderer on every resize cycle via `_resizeAndRenderScore`,
  which defeated the optimisation entirely. v2 removes that invalidation;
  the flag persists across resize cycles. Phase 1 verifies this is safe.
- **A/B paired at n=64 against pre-DR-1 baseline** (`022d8c9a`):
  canon-resize-drag `★` Δ=-6.08 ms (-4.0 %), CI [-7.62, -3.66], z=4.25,
  49/64 wins.
- **5-trial multi-process diff** against pre-DR-1 baseline (host-drift
  warning, so paired A/B remains authoritative):
  - canon-resize-drag: -17.50 ms / -7.4 % `★`
  - canon-resize (4 widths): -5.63 ms / -7.3 % `★`
  - nightwish-resize: -2.68 ms / -14.6 % `~`
  - canon-render: -3.15 ms / -5.2 % `·`
  - fade-to-black-resize: -2.64 ms / -6.4 % `·`
  - nightwish-render: -0.98 ms / -7.1 % `·`
  - tiny-render: -0.02 ms / -4.7 % `~`
  - No `★` regression anywhere; every scenario directionally faster.
- **Bonus bug fixed**: 9 visual fixtures had their leading padding shrink.
  Before DR-1, the per-bar broker accumulators (per-beat `preBeatSize`,
  springs etc) re-walked every resize and grew via `max-of` across width
  transitions — never shrinking when a bar's wrap state changed back. This
  caused excess padding between leading glyphs and the first beat (most
  visibly the second-system gap in `MozartPianoSonata`). The new code walks
  once at initial layout and locks the per-beat values to that layout's
  max — correct because those values describe glyph metrics, not
  width-dependent state. Reference PNGs accepted after manual inspection
  confirmed every diff is an improvement.
- **Path lesson**: the executor's first vitest run hit 6 failures and the
  agent demoted §4 primary to falsified per plan §10.2 protocol. The user
  caught the demotion as premature — the 6 diffs were inspected and turned
  out to be bug-fixes, not regressions. The plan §11 anti-revert directives
  were correct in intent ("don't revert on first red"), but the agent's
  diagnostic step ("would the targeted invalidation cost more than the
  Phase 3 win?") was speculation, not measurement. Future plans should
  require the executor to attempt the invalidation before claiming it
  would erode the win, AND explicitly inspect visual diffs for "old
  behavior was wrong" before classifying them as regressions.
- **DR-1 remainder**: the broker-lifecycle slice is captured. The
  cross-bar content-version cache and system-skyline incremental update
  sub-slices remain open under DR-1's deferred entry below.
- **Plan + evidence**: `packages/bench/analysis/2026-06-14-resize-drag/DR-1-BROKER-LIFECYCLE-PLAN.md` (see §15 execution outcome).
- vitest: 1599/1599.

## Major refactors — deferred

Candidates too large for a single iteration. Each entry: hypothesis,
expected payoff, blast radius, sketch.

**2026-06-14 canon-resize-drag baseline re-confirms** that the DR entries
below remain the principal structural levers, with quantified upper bounds:

- **DR-1** is the largest lever — width-only re-walking on
  canon-resize-drag previously cost ~14 ms / iter truly invariant
  (`registerLayoutingInfo` 7.0 + `calculateOverflows` 3.1 +
  `_emitGroupOverflows` 2.4 + `_computeBeamingBounds` 2.9). `EW-9`
  Variant B (`bfcd943f`) captured the `calculateOverflows` +
  beam-overflow slice (~9.7 ms paired). The broker-lifecycle slice
  capturing `registerLayoutingInfo` (~6-7 ms paired, +bonus bug-fix on
  9 visual fixtures) landed as `eddf9bc1` (see "Major refactors —
  landed" above). Remaining DR-1 open work: the cross-bar
  content-version cache (skip full system re-pack when bar membership
  is stable) and the system-skyline incremental update sub-slice.
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
    `_emitGroupOverflows` 2.4 + `_computeBeamingBounds` 2.9). `EW-9`
    Variant B captures the overflow slice (~5.5-9.7 ms); the
    broker-lifecycle slice (`eddf9bc1`, see "Major refactors — landed"
    above) captures the `registerLayoutingInfo` 7.0 ms portion by
    splitting the call into cheap (always-run) + expensive (walk-skip
    after first call), keeping the reset in place. **All of this
    truly-invariant ~14 ms surface is now captured.**
  - **Width-bucket-memoisable** (`force`-keyed): `_scaleToForce` (34 ms /
    iter); `force = spaceToForce(width)` bucketing may collide across
    nearby drag widths, lifting 20-30 % hit-rate × 34 ms ≈ 3-5 ms / iter.
  - **System-packing-stable cases** (drag widths that pack identically):
    skip `_systems = []; createEmptyStaffSystem(...); addBarRenderer(...)`
    rebuild — 5-10 ms / iter when membership stable, indeterminate
    fraction across 12 drag widths.
  - **Genuinely width-dependent (intrinsic)**: Skyline union shift,
    `_scaleToWidth` body, paint markup generation — ~85 % of wall-clock.
- **EW-9 Variant B** (landed `bfcd943f`) is the smallest patch shape that
  delivered a slice of DR-1. The naive max-skip (`63e1afef`) bundled
  `registerLayoutingInfo` into the gate and broke 7 visuals because
  `addMasterBarRenderers` resets `preBeatSize=0`; Variant B narrows to
  `calculateOverflows`-only and keeps the broker write always-on. Full
  content-version cache is the structural endgame.

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

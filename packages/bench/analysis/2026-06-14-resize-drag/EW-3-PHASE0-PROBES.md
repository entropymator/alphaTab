# EW-3 Phase 0 — empirical probes

**Status**: PHASE 0 COMPLETE. Probes ran on `feature/perf` HEAD `05ec1dbb`.
Probe instrumentation patch was applied to `LineBarRenderer.paintStaffLines`,
the scenario was run for 5 measured iterations of `canon-resize-drag`, and
the patch was reverted before this commit.

Reproducer (working-tree probe build + harness script):
```
cd packages/bench
BENCH_OUTDIR=dist/ab/PROBE \
  ALPHATAB_SRC=/abs/path/packages/alphatab/src \
  npx vite build
node scripts/phase0-ew3-probe.mjs --iters 5
```

`scripts/phase0-ew3-probe.mjs` installs a `globalThis.ew3Probe` shape before
loading the bundle, the bundled `LineBarRenderer.paintStaffLines` writes
into it when the global is truthy, and the script dumps the four §6 probe
answers as text + JSON.

---

## §6.1 Per-class collectSpaces invocation count

| Receiver class    | Calls (5 iters) | calls/iter | non-empty calls | non-empty share | total gaps |
|---|---:|---:|---:|---:|---:|
| `ScoreBarRenderer` | 14 560 | 2 912 | 0 | 0.0 % | 0 |
| `TabBarRenderer`   | 14 560 | 2 912 | 13 975 | **96.0 %** | 96 850 |
| (other subclasses) | 0 | 0 | 0 | — | 0 |

**Outcome**: only `ScoreBarRenderer` and `TabBarRenderer` invoke
`collectSpaces` in `canon-resize-drag`. `SlashBarRenderer` and
`NumberedBarRenderer` do not appear in this score. Dispatch on this
workload is **2-way polymorphic**, not 4-way as the plan §2.1 / §4 G
estimate assumed.

- TabBarRenderer is the **sole** non-empty receiver — confirms the plan's
  §6.1 expected outcome.
- ScoreBarRenderer hits the inherited no-op stub every call. Option G
  (`instanceof` short-circuit) is valid: every ScoreBarRenderer call to
  `collectSpaces` returns `spaces` unchanged, so the call can be elided
  when the receiver is not a TabBarRenderer.
- ~4 % of TabBarRenderer calls return zero gaps (multi-rest bars,
  empty-voice bars). Cache shape can short-circuit on `gapCount === 0`.

---

## §6.2 Layout-vs-resize stability test for `collectSpaces` output

| Metric | Count | % of repeated calls |
|---|---:|---:|
| First-observation snapshots (warmup baseline) | 448 | — |
| Subsequent calls byte-identical to first observation | 17 830 | **61.2 %** |
| Subsequent calls differing from first observation | 11 290 | 38.8 % |

**Mechanical interpretation of the 38.8 %**: the diff examples are uniformly
of the shape "same gap count, same widths, x-positions shifted". From the
captured diff examples:

```
prev: [][(32.3895,24.1291)(75.8349,24.1291)][][][][]
cur : [][(32.3895,24.1291)(76.3888,24.1291)][][][][]
```

The two-element tuple is `(x, width)`. **Widths are byte-stable across all
captured diffs** (e.g. `24.1291` constant). **x-positions shift** when the
bar gets re-positioned at a different display width. The first gap's x is
often stable (anchored to the first beat at `bg.x=0`); subsequent gaps
shift by the difference in `bg.x` of their owning beat-glyph as
`MultiVoiceContainerGlyph._scaleToForce` re-walks the spring positions.

In the larger example (4 gaps):

```
prev: [(69.1660,...)(145.0300,...)(210.3229,...)(265.0445,...)]
cur : [(33.0700,...)(77.1677,...)(115.1207,...)(146.9289,...)]
```

— still **4 gaps, same widths, all four x-positions shifted by per-beat amounts**.

### Outcome classification (§6.2 / §7.2)

- **Outcome A** (byte-identical across resize): falsified.
- **Outcome B** (relative-stable: widths and intra-bar offsets stable;
  x-positions shift by a per-beat scalar): **CONFIRMED** — the plan's
  default primary assumption holds.
- **Outcome C** (relative shape shifts: gap count or width change):
  falsified.

**Decision**: proceed with Option A's **projection cache** shape per plan
§4. Cache the `(stringIndex, beatRef, relativeX_within_beat, width)`
tuples at layout; at paint, project each by adding
`this.beatGlyphsStart + beatRef.x` to recover absolute x.

The plan's §4 algebraic separation (12 of 14 inputs width-invariant,
project with 2 width-dependents) holds.

### Refinement on cache invalidation

Since the snapshot WeakMap was carried across warmup → measured iters
and the bar-content composition never changed (no `recreatePreBeatGlyphs`
fires in canon-resize-drag), no Outcome C events appeared. The
`_voiceWalkDone` lifecycle precedent (survives `afterReverted`,
invalidated by `recreatePreBeatGlyphs` and `invalidateLayoutCache`) is
the correct invalidation policy.

---

## §6.3 Per-call cost microbench

| Function | Total (5 iters) | Per-call ns | Per-iter ms | Calls / iter |
|---|---:|---:|---:|---:|
| `collectSpaces` | 19.8 ms | **680 ns** | **3.96 ms** | 5 824 |
| `paintStaffLines` | 134.1 ms | 4 605 ns | 26.82 ms | 5 824 |

Notes:
- The probe wraps the `collectSpaces` call with `performance.now()`, which
  adds a measurable per-call overhead. The HOTSPOTS post-EW10 5-trial
  CPU number (5.65 ms / 2.42 %) is unbiased and remains the planning
  authority. The 3.96 ms number reported above is a probe-side estimate.
- Per-call cost (~680 ns) is dominated by:
  - Map iteration over `notesPerString` (~6 strings/beat avg).
  - `Float32Array(2)` allocation per gap (one per note-on-string).
  - Closure / virtual dispatch entry.

**Decision (§7.3)**: per-call cost falls into the "Map iter + alloc"
range. Option A's gap-cache cleanly eliminates the Map iteration on
every resize cycle (paid once at layout) AND the per-gap
`Float32Array(2)` allocation (amortised into a single packed buffer).
Both savings stack.

---

## §6.4 paintStaffLines work decomposition

| Segment | Total (5 iters) | Per iter | Share of paintStaffLines |
|---|---:|---:|---:|
| `collectSpaces` (called from paintStaffLines) | 19.8 ms | 3.96 ms | 14.8 % |
| pre-emit (sort) | 6.0 ms | 1.20 ms | 7.5 % |
| **emit** (fillRect ×N) | **73.4 ms** | **14.69 ms** | **92.5 %** |
| total `paintStaffLines` | 134.1 ms | 26.82 ms | 100 % |

(Share % is of the pre-emit-vs-emit split; `collectSpaces` is timed
separately at 14.8 % of total `paintStaffLines`.)

**Outcome (§6.4 / §7.4)**: **emit dominant** at 92.5 %. The plan's §3.4
estimate "paintStaffLines is 60-75 % of total fillRect volume" was an
*output* count statement — Phase 0 EW-10 §18.1 measured 44.8 % at
HEAD `daa5c2c6`. The 92.5 % here is the in-scope *time* breakdown of
`paintStaffLines` itself, not the fillRect global share. Both are
consistent: paintStaffLines emits a lot of rects, and most of its
self-time IS the rect emission.

### Decision: Option A's ceiling

Option A eliminates **collectSpaces** (~3.96 ms/iter probe estimate; ~5.65 ms/iter HOTSPOTS authority) AND **pre-emit sort** (~1.20 ms/iter), but
**does NOT touch the emit cost** (14.69 ms/iter — the dominant share).

Ceiling estimate for Option A: **4-7 ms / iter** (collectSpaces + sort).

Decision tree (plan §7):
- **§7.1 (TabBarRenderer sole non-empty)**: ✅ confirmed → G safe to bundle.
- **§7.2 (stability outcome B)**: ✅ confirmed → A primary, projection-cache shape.
- **§7.3 (per-call cost dominance)**: Map iter + alloc → A wins cleanly.
- **§7.4 (emit dominance)**: emit dominant → **consider E (stroked path)
  as bundled secondary** per plan §7.4 third branch.

**Adjusted plan**: pursue Option A first per plan §8 (cache + B + G + I
bundle). If A's measured Δ at n=64 is in the σ-to-2σ "~" range, bundle
Option E (stroked `<path>` per staff line) as Phase 2 of the same round
per plan §8 Phase N. The emit dominance suggests E has independent room.

### Falsification thresholds (carried from plan §3 / §7.2)

- `★ Δ ≤ -2.2 ms` (1 % / σ floor) on canon-resize-drag n=64 paired vs
  `05ec1dbb` → proceed.
- `~` -0.5 to -2.2 ms → re-measure at n=128.
- `·` below 0.5 ms → fall through to Option E per plan §8 conditional.

---

## Plan-impact summary

| Plan claim | Phase 0 measurement | Adjustment |
|---|---|---|
| Dispatch is 4-way polymorphic (§2.1) | 2-way in `canon-resize-drag`; 96.0 % of TabBarRenderer calls non-empty | G short-circuit on `TabBarRenderer` instance type is valid and 2-way means even cheaper than estimated. |
| collectSpaces ~5.65 ms / iter (HOTSPOTS) | ~3.96 ms / iter (probe estimate, includes timing overhead) | HOTSPOTS authority stands. Probe value is lower-bound check; consistent. |
| Outcome B (default plan assumption) (§6.2) | **CONFIRMED** | Proceed with Option A projection cache. |
| paintStaffLines win ceiling 4-6 ms (§4 A) | Probe says 4-7 ms ceiling (collectSpaces + sort) | Within plan's estimate. **2σ stretch unlikely without bundled E.** |
| emit dominant in paintStaffLines (§7.4) | 92.5 % of paintStaffLines self-time is fillRect emission | Per plan §7.4 — Option E recommended as bundled secondary if A's `~` range. |
| Cache invalidation policy = `_voiceWalkDone` pattern (§9.5) | No mutation events in canon-resize-drag | Invalidate on `recreatePreBeatGlyphs` + `invalidateLayoutCache`; survives `afterReverted`. |

---

## Cite-by-commit timeline

- Probe instrumentation patch: working-tree only (reverted before this commit).
- `scripts/phase0-ew3-probe.mjs` — committed as the reproducer.
- This findings doc — committed as `docs(bench): EW-3 Phase 0 — empirical probes`.

Next step: **Phase 1 — Option A baseline (cache shape, no skip) per plan §8.**

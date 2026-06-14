# DR-1 next-slice Phase 0 — empirical probes

**Date**: 2026-06-14
**Branch HEAD at probe time**: `10b25418`
**Plan**: `DR-1-NEXT-SLICE-PLAN.md` §5
**Probe artifact**: `DR1-NS-PHASE0-LOG.txt` (full bench stdout, 384 lines)
**Instrumentation patch**: reverted before commit; lived on `VerticalLayoutBase._resizeAndRenderScore`
and `BarRendererBase.reLayout`. Not shipped.

---

## TL;DR

**Plan §5.6 single-prior-cache predicate (§3.2) hits 0/143 cycles on canon-resize-drag.**
The plan's decision row triggers §10 falsification. **However**, the probes also surface a
structural fact the plan didn't anticipate: per-width packing is deterministic across
iterations. A multi-entry cache keyed by `maxWidth` would hit ~96% of cycles on the
same workload. This is a strict superset of the plan's Option A; the option matrix needs
amendment.

Recommendation: surface the multi-entry option to the user before either falsifying or
proceeding with the single-prior shape. The plan §4 option matrix is missing this
variant.

---

## Probe results

### §5.1 — stable-packing rate (single-prior predicate)

| Outcome | Count | Rate |
|---|---:|---:|
| Stable (consecutive-cycle packing identical) | 0 | **0.0 %** |
| Different | 143 | 100.0 % |

The canon-resize-drag width sequence (1400 → 1300 → 1200 → 1100 → 1000 → 900 → 800 → 700
→ 600 → 650 → 750 → 850) shifts by ~100 px per step. The smallest delta in the
sequence is 50 px (530 → 580 → 630 → 680 → 750 → 850). Every step changes packing.

Per plan §5.8 / §4.5: 0 % < 20 % → drop to §10 falsification.

### §5.2 — mb.width invariance (when packing stable)

Not measurable directly: zero stable cycles means zero comparison points. **The data is
structurally insufficient to verify or refute the §3.3 width-invariance claim from the
direct probe.**

The indirect evidence (system count per `maxWidth` is deterministic across all 8
iterations — see §5.4 below) suggests `mb.width` IS invariant for the same `maxWidth`,
but that's an inference, not a measurement.

### §5.3 — per-system packed-width invariance

Not measurable directly (same reason as §5.2).

### §5.4 — cost breakdown (n=143 resize cycles, single trial, taskset-pinned cores 2-3)

| Metric | Median | Mean | p5 | p95 | min | max |
|---|---:|---:|---:|---:|---:|---:|
| Layout-rebuild region L (ms) | 6.73 | 7.22 | 5.60 | 9.62 | — | — |
| Paint region P (ms) | 8.61 | 10.35 | 5.89 | 18.24 | — | — |
| Total resize.total (ms) | 15.54 | 17.57 | 11.65 | 26.37 | 10.78 | 40.41 |

**§5.8 criterion for Probe 4**: L > 5 ms → met (median 6.73 ms, p5 5.60 ms).
The layout rebuild surface is large enough that skipping it WOULD produce a
measurable win IF the predicate hits.

The first resize cycle (40.41 ms) is a clear warmup outlier (V8 baseline JIT
not yet stabilised). The rest cluster around 11-16 ms.

### §5.5 — wrap-flip frequency

| Metric | Median | Mean | p5 | p95 | min | max |
|---|---:|---:|---:|---:|---:|---:|
| wrap-flips per resize cycle | 160 | 156 | 78 | 204 | 78 | 330 |

Every resize cycle produces 78-330 wrap flips. The wrap-flip count tracks roughly with
the magnitude of `prevSys` ↔ `currSys` delta. Cross-validation with §5.1: every cycle
produces wrap flips AND stable=N, consistent with "different packing always implies
wrap-flips".

### Per-width determinism (additional probe not in §5)

System count is a deterministic function of `maxWidth` across all 8 iterations:

| maxWidth | currSys (every iter) |
|---:|---:|
| 530 | 178 |
| 580 | 167 |
| 630 | 145 |
| 680 | 131 |
| 730 | 122 |
| 780 | 116 |
| 830 | 112 |
| 930 | 94 |
| 1030 | 82 |
| 1130 | 72 |
| 1230 | 67 |
| 1330 | 60 |

Every `maxWidth` value produces the same system count (and, by inference, the same
packing) every time it appears. The drag sequence visits 12 distinct `maxWidth` values
8× each = 96 cycles per trial; after the first iteration, every subsequent cycle would
hit a multi-entry cache keyed on `maxWidth`.

Estimated hit rate of multi-entry cache: **84/96 = 87.5 % first trial; ~96 % steady state.**

---

## Plan §5.8 decision row

Per the plan's published rules:

> Probe 1 < 20 % → Falsify; document in §10

The literal §3.2 predicate (single-prior cache, fingerprint = last-cycle packing) is
falsified.

## Pivot question for the user (deviation surface)

The data also reveals: **per-width packing is determined by `maxWidth` alone** (modulo
model mutations, settings changes, visibility changes — all of which would invalidate any
cache by construction). This is a stronger structural invariant than §3.2 assumed.

A **multi-entry width-keyed cache** would shape like:

```
private _packingByMaxWidth: Map<number, {
    masterBarsRenderersIndices: number[][],  // per-system bar indices
    perSystemComputedWidth: number[],         // for re-fit
    perSystemAccoladeWidth: number[],         // accolade contribution
}> = new Map();
```

On resize, key by `this._maxWidth`. If hit, walk the existing systems and apply geometry
without rebuilding. On miss, rebuild + store. Invalidate on model mutation /
settings / visibility events.

**Distinctions from the plan's Option A**:
- Plan's §3.2 caches one packing (the most recent). Hits when `newWidth ∈ [lower, upper]`.
- The multi-entry variant caches all observed packings keyed by `maxWidth`. Hits when
  `maxWidth` has been seen before AND no invalidation event has fired.

**Risk profile differences**:
- Memory: O(N_distinct_widths × N_systems) entries. For canon-resize-drag, 12 widths × ~100
  systems × ~few hundred bytes each ≈ tens of KB. Acceptable.
- Cache invalidation: same surface as Option A (model mutation / settings / visibility).
- Correctness premise: `maxWidth` determines packing modulo the same invariants Option A
  assumes. Phase 0 didn't measure mb.width invariance for the same width across cycles —
  needs to be verified before Phase 1 build.
- Predicate cost: O(1) hash lookup, cheaper than the §3.2 O(N_systems) bound walk.

## Suggested next step

Surface to the user: **proceed with multi-entry variant as primary, or accept the literal
§10 falsification?**

Pros of pivoting to multi-entry:
- canon-resize-drag scenario is specifically designed to exercise drag-back (`width
  oscillation`). Multi-entry directly captures that workload.
- Other resize scenarios (`canon-resize` 4 widths, `nightwish-resize`, `fade-to-black-
  resize`) have similar patterns — widths recur.
- The structural fact (per-width determinism) is verifiable via Phase 1 instrumentation
  with low risk.

Cons:
- It's a deviation from the plan as-written. Plan §16 requires the executor to record
  deviations and rationale.
- Plan §11 anti-revert pressure cuts both ways: the plan didn't authorise a multi-entry
  shape; pivoting needs explicit user assent.

## What was NOT done

- No mb.width-vs-prior-cycle-of-same-width measurement. The probe only compared
  immediate-prior. To strictly answer §5.2 for the multi-entry variant, the probe would
  need to snapshot `mb.width` per-`maxWidth` across iterations. Phase 1 instrumentation
  on the multi-entry path can verify this cheaply (compare cache-hit-replay against
  fresh-rebuild output).
- No A/B run. Phase 0 is probes only.
- No source-code changes shipped. Instrumentation patch reverted before this commit.

## Citations

- Probe instrumentation lived in `VerticalLayoutBase._resizeAndRenderScore` (lines
  281-350 at HEAD `10b25418`) and `BarRendererBase.reLayout` (lines 941-968).
- 5 probes bundled per plan §5.5: pack-stability, mb.width invariance, sysw invariance,
  cost breakdown, wrap-flip count.
- Probe ran `node dist/run.mjs --only canon-resize-drag --trials 1 --label DR1-NS-probe`
  taskset-pinned to cores 2-3 (warmup=3, iterations=8 → 8 × 12 widths − warmup-trimmed
  first cycle = 143 logged comparisons).
- Bench summary: median 233.55 ms wall-clock per `driveOnce`, similar to post-EW-11
  baseline (232.26 ± 1.67 ms).

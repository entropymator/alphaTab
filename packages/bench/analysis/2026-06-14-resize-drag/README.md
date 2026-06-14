# 2026-06-14 — canon-resize-drag round

Round purpose: a focused multi-angle analysis of the resize path on alphaTab
using a new `canon-resize-drag` scenario that amplifies sampling density vs
canon-resize by ~3×. The output is two new "Easy wins — open" candidates
(`EW-9`, `EW-10`) and refined deferred-refactor sketches (`DR-1`, `DR-2`,
`DR-3`, `DR-5`, new `DR-6`) recorded in [HOTSPOTS.md](../../HOTSPOTS.md).

**Branch state at round close**: `feature/perf` HEAD `dd530e65`, baselined
from `39e5232e`.

## Scenario

`canon-resize-drag` cycles 12 widths in a sustained browser-drag pattern
(1400 → 600 → 850), 8 iterations per `driveOnce`. Median **235.30 ms ±
3.48 ms (1.48 % σ)**, well under the 5 % calibration target so it
resolves ≥ 1 % candidates (≥ 2.35 ms) cleanly.

Defined in [scenarios.ts](../../src/scenarios.ts). Added by `dd530e65`.

## Methodology

1. Added `canon-resize-drag`; smoke-tested wall-clock landed in target
   200-300 ms range.
2. Captured 5-trial baseline: `node dist/run.mjs --trials 5 --label
   resize-drag-1781434957 --save-baseline resize-drag`.
3. Aggregated top-30 CPU (`hitCount × sampleInterval`) and self-heap
   across all 5 trials with [`scripts/aggregate-top30.mjs`](../../scripts/aggregate-top30.mjs).
   See [`canon-resize-drag/TOP30.md`](canon-resize-drag/TOP30.md) and
   [`canon-resize/TOP30.md`](canon-resize/TOP30.md).
4. Resolved bench-dist line numbers → alphatab source files via
   [`SOURCE_MAP.md`](SOURCE_MAP.md) (V8 sourcemap walk).
5. Dispatched 6 parallel sub-agents, one per analytical angle. Each
   received the same baseline, the same rubric (classify entries as
   Algorithmic / Structural / Intrinsic / Demoted, estimate Δ ms upper
   bounds derived from call count × per-op cost, cross-check against
   HOTSPOTS.md's demoted list). Reports:

| Angle | File | Headline |
| --- | --- | --- |
| Layout walk + width-only DR-1 | [`subagent-layout-walk.md`](subagent-layout-walk.md) | ~14 ms / iter truly width-invariant work in `reLayout`; `EW-9` captures it |
| Skyline + overflow | [`subagent-skyline.md`](subagent-skyline.md) | EW-1 fuse is the algorithmic ceiling; 4 follow-ups bounded ≤ σ |
| Paint surface (SvgCanvas, DR-3) | [`subagent-paint.md`](subagent-paint.md) | `fillRect` 18.2 ms = #1 hotspot; deferred-flush typed buffer = `EW-10` |
| Tie + cross-system + bounds | [`subagent-tie-bounds.md`](subagent-tie-bounds.md) | Tie re-layout ~5 ms; push-based bounds tree = new `DR-6` |
| GC + allocation | [`subagent-gc.md`](subagent-gc.md) | `unionShifted3` 84 % of heap but write-cursor = 0-2 ms (sub-σ); pool-style demoted |
| Beam + beat container | [`subagent-beam.md`](subagent-beam.md) | `BeamingHelper` width-invariant; `_computeBeamingBounds` 24 ms folds into DR-1 |

6. Synthesised candidates into HOTSPOTS.md; committed as `dd530e65`.

## What's archived here

- `subagent-*.md` — the 6 analytical reports (~500 words each).
- `SOURCE_MAP.md` — bench-dist line → alphatab source mapping for the
  hotspots referenced in TOP30s.
- `canon-resize-drag/` — TOP30 aggregation (summed across 5 trials) +
  trial-0's raw `cpu.cpuprofile` (~470 KB) and `heap.heapprofile`
  (~150 KB) + `result.json`. Load the profiles into Chrome DevTools
  Performance / Memory tab for interactive flame-graph inspection.
- `canon-resize/` — same shape, for cross-reference. canon-resize-drag
  is the same physics × 3 sample density.

The full 5-trial run (all 7 scenarios × 5 trials, ~11 MB) lives under
`runs/resize-drag-1781434957/` and is `.gitignore`d. This archive
captures the trial-0 subset that is sufficient to reproduce every
finding in the sub-agent reports. To re-run from source:

```bash
cd packages/bench
node dist/run.mjs --trials 5 --label resize-drag-repro \
    --save-baseline resize-drag-repro --only canon-resize-drag
node scripts/aggregate-top30.mjs runs/resize-drag-repro/canon-resize-drag
```

## Open candidates from this round

See [HOTSPOTS.md](../../HOTSPOTS.md) for the canonical list; the round
produced:

- **`EW-9`** — skip bar-local `reLayout` work on width-only resize.
  Upper bound 12-16 ms / iter (5-7 %); clears σ at ≥ 3×. First slice
  of DR-1. **Recommended next-session target.**
- **`EW-10`** — batched-fillRect typed buffer in SvgCanvas. 2-4 ms /
  iter; fundamentally different shape from demoted EW-4 (intra-function
  tweaks) and EW-5 (`<rect>` → `<path>` element-kind swap).

Both have ≥ 2σ upper bounds well above the canon-resize-drag σ floor
(±3.48 ms × 2 ≈ 7 ms), so a paired A/B at n=64 should resolve them
decisively.

## Negative results recorded against the demoted list

The sub-agents cross-checked every ≥ 0.5 % candidate against the
demoted entries in HOTSPOTS.md before listing. Items found to repeat a
demoted shape (and thus not promoted to EW status):

- `paintStaffLines` as `<line>` stroking — same general-rasteriser
  pitfall as EW-5.
- `_emitTies` skip-on-unchanged — invariant signature is
  width-dependent (system packing changes invalidate every iter).
- Pool-style allocation reduction at `unionShifted3`, `_raiseRange`,
  `_initBaseline`, or the Bounds tree — EW-2(b) precedent.
- `unionShifted3` `newSegs[]` write-cursor — 0-2 ms predicted, sub-σ.
- Staff-level `unionShiftedAll` fuse — 0.5-1 ms upside, (S) with
  medium risk; bundle only with a DR-1 layout-cache landing.
- `_raiseRange` single-pass insert — 2.5-3.5 ms borderline σ; not
  worth standalone risk.
- Single-symbol micro-devirt (any caller of `getBoundingBoxTop`,
  `collectSpaces`, `fillRect`, `paintStaffLines`) — EW-3 / DR-5
  micro-devirt precedent.

Each is logged in the relevant sub-agent report's classification
table; full evidence for each negative result lives in the per-angle
markdown plus the linked HOTSPOTS.md entry.

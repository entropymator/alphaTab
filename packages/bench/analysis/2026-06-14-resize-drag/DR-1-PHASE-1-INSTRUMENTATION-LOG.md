# DR-1 Phase 1 instrumentation log

**Run**: 2026-06-14, branch `feature/perf`, working from `9140963b`.
**Scenario**: `canon-resize-drag` (8 iterations × 12 widths × ~30 masterbars × 2 staves).
**Status**: PASS — zero mismatches over 60 000+ comparisons. §4 primary viable.

## What was instrumented (reverted before Phase 2)

Two surgical edits, neither shipped:

1. `BarLayoutingInfo.ts` — added a `dr1WalkSnapshot(): string` helper that
   serializes the walk-output fields the §4 primary plan would skip
   re-writing:
   - `postBeatSize`
   - `_beatSizes` (count + Σ(preBeatSize+onBeatSize))
   - `springs` (count + Σ(postSpringWidth+preBeatWidth+graceBeatWidth+smallestDuration+longestDuration) + Σ(timePosition))
   - `_timeSortedSprings` length
   - `allGraceRods` (count + Σ(postSpringWidth+preBeatWidth))
   - `_minDuration`
   The full `Spring` content is checksummed, not just the obvious
   `postSpringWidth` — that is what caught a hidden write path in the
   first pass (see §"Two false-positive sources" below).

2. `BarRendererBase._registerLayoutingInfo` — at end of each call,
   snapshot `info.dr1WalkSnapshot()` into a per-renderer field; at start
   of each subsequent call, compare against the stored snapshot, log a
   `[DR1-mismatch]` line on any diff (capped at 50).

## Two false-positive sources that needed gating out

The first instrumentation attempt produced 50 mismatches (hit the cap).
Diagnostic revealed two structural false positives, neither of which
contradict the §4 primary's correctness premise:

### FP1 — cross-stave broker accumulation order

The broker is shared across all staves of a `MasterBarsRenderers`. The
score stave's `_registerLayoutingInfo` writes first, the tab stave's
writes second. Each write is max-of, so the broker grows monotonically
within a single layout cycle.

Snapshot taken at end of the score stave's first call therefore captures
"score-only" broker state. Next time the score stave is called (a later
layout/resize cycle), the broker already contains the tab stave's
contributions (which never went away), so the start-of-call comparison
trips.

This is not a real "broker mutation between cycles" — it is the
expected max-of accumulation across staves of the same cycle. Confirmed
empirically: the actual values matched the tab stave's snapshot exactly.

### FP2 — `_calculateSpringConstant` mutates `spring.smallestDuration` lazily

`BarLayoutingInfo._calculateSpringConstant` (line 376):

```
if (spring.smallestDuration === 0) {
    spring.smallestDuration = duration;
}
```

This means `spring.smallestDuration` starts at 0 (Spring's default) and
is lazily initialized inside `_calculateSpringConstants`, which is
called by `finish()` — which runs at the end of `StaffSystem.addBars`
(initial layout) and `recomputeSpringConstants` (system-wide
reconciliation). After `finish()`, every `spring.smallestDuration` is
nonzero.

So the first end-of-`_registerLayoutingInfo` snapshot (taken during
initial layout, BEFORE the same broker's `finish()` ran) saw zeros for
`smallestDuration`. The subsequent comparison saw the post-`finish()`
values. False positive: the mutation is part of initial-layout
finalization, not a resize-cycle mutation.

Critically, `addMasterBarRenderers` (the resize path) does NOT call
`finish()`. It calls `_trackSystemMinDuration` → optionally
`recomputeSpringConstants`, which only updates `springConstant` /
`minStretchForce` / `totalSpringConstant`. Those fields are not in the
"walk-output" set that §4 would skip — they are explicitly rewritten in
`_calculateSpringConstants` and explicitly OUT of scope per §2.2 (rows
`minStretchForce`, `totalSpringConstant`).

### Gating

Solved by snapshotting / comparing ONLY when
`info.computedWithMinDuration !== 0`, i.e. after `finish()` ran at
least once for that broker. This gates out both FPs:

- FP1: by the time `finish()` has run on a cycle's broker, every stave
  of that cycle has already written → snapshots capture the
  fully-accumulated state.
- FP2: gating after `finish()` excludes the one-time `smallestDuration`
  initialization.

## Results

```
[DR1-running] compares=60000 mismatches=0 snapshots=60448
```

Final log lines from `packages/bench/runs/DR1-instrument-v3.log`. The
canon-resize-drag scenario produced ~60 000 settled comparisons across
the warmup+iteration set, zero mismatches.

Far exceeds the §5.6 minimum (≥ 288 tuple comparisons).

## §5.5 decision: Zero mismatches → §4 primary viable, proceed to §6

The plan's §4 primary correctness premise is empirically verified for
canon-resize-drag: the walk's outputs (`springs`, `_beatSizes`,
`_timeSortedSprings`, `allGraceRods`, `_minDuration`, `postBeatSize`)
are byte-identical at the start of every resize iteration to what the
previous cycle settled.

## Files reverted

Phase 1 instrumentation was a temporary patch and has been reverted in
full. `git status` shows no remaining instrumentation diff under
`packages/alphatab/src/rendering/`. Only the unrelated
`packages/alphatab/src/platform/svg/SvgCanvas.ts` comment trim remains
in the working tree from before Phase 1 began.

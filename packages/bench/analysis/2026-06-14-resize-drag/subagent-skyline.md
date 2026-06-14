# Skyline + overflow — canon-resize-drag analysis (235 ms / iter)

Per-iter counts (trial-0, 8 iters): `finalizeStaff` 2836, `finalizeSystem` 1418, `doResize` 13.
Each `finalizeStaff` runs `_unionBarLocalIntoStaffSkyline` per renderer = **2 `unionShifted3` per bar
renderer per finalize**. With ~22 visible bar renderers per staff × 2836/22 ≈ 130 staves × ~22 bars,
this is ~5,672 `unionShifted3` calls / iter (top+bottom). 5.4 MB / 5,672 ≈ **950 B / call** (≈ 20
pooled `SkylineSegment`s emitted per merge — sounds right for canon's beat density).

## Classifications

### unionShifted3 — 2.37 % CPU, 84.4 % heap (5.4 MB/iter) — **(I) with one (A) sub-opportunity**

The 4-way merge body itself is optimal (single linear sweep, coalescing inline, pool reuse for
inputs). Heap is dominated by the **emitted segment list**, not bookkeeping — every emitted
`SkylineSegment` is pooled, but the pool's free-list and the `newSegs: SkylineSegment[]` scratch
array are themselves allocated, and `this._segments.push()` after the swap reallocates the inline
storage of the system skyline. EW-2(b) falsified pooling; the lesson generalises here too — the
SegmentPool already exists and the heap stays high because **the scratch `newSegs[]` is allocated
fresh per call** (Skyline.ts:117, 269). The list grows to ~20+ elements then gets GC'd. Algorithmic
fix: reuse a single class-field scratch array (`this._scratch.length = 0` is transpile-safe and
mirrors EffectSystemPlacement's `splice(0, length)` precedent), or — better — *merge in place*
without an intermediate list by writing into a 2nd persistent buffer and swapping references.
Expected payoff is **allocation-only** (~3-4 MB/iter); against EW-2(b)'s falsification of the GC-vs-
alloc cost model, the wall-clock win is uncertain (1 % = 2.35 ms is the σ floor). Classify as
**(I)** for CPU, **(A)** for heap with **payoff bounded below σ**.

### Q1 — Second-order fuse?

No useful second-order fuse exists. `unionShifted3` is already the per-staff/per-renderer fuse.
The natural next-level fuse would be "union *all bars in the staff* in one pass" — i.e. a
`unionShiftedN` over 3N inputs. That would amortise the result-list rebuild from N times to 1, but
the inputs are *not available simultaneously*: `_unionBarLocalIntoStaffSkyline` is called inside
the `for (renderer of this.barRenderers)` loop in `finalizeStaff` (RenderStaff.ts:288-301) *after*
`renderer.refreshSizes()` may have mutated the bar's local skyline. Restructuring to a two-phase
loop (collect-all then merge-once) is **(S)** with medium risk and a real ~1-2 ms upside: rebuilding
the staff `_segments` array once instead of `barRenderers.length` times would eliminate ~95 % of
the `newSegs[]` allocation pressure. The merge sweep itself is still O(total breakpoints) either
way. **Sketch**: `RenderStaff.finalizeStaff` collects `{bar, pre, post, baseX, postBaseX}` tuples
in a class-field array, then calls `sky.upSky.unionShiftedAll(tuples, 'up')`. Payoff: alloc drop
~4-5 MB/iter, CPU drop bounded by σ but plausibly 0.5-1 ms.

### Q2 — Per-call cost / fewer-smaller unions

Per-call size: ~950 B = ~20 segments emitted. Reducing this requires reducing the input segment
counts in `bar.upSky`, `pre.upSky`, `post.upSky`. The pre/post-beat skylines are re-emitted from
scratch each `calculateOverflows` (BarRendererBase.ts:648-649). The **bar-local skyline** is also
reset on every `scaleToWidth` (BarRendererBase.ts:368). On a **width-only resize** where bar-local
glyph layout is invariant (canon-resize-drag with the same score), the pre/post-beat skylines
should be *identical* across resize iterations — but they get reset and re-emitted anyway. This is
DR-1 territory: a "scale-only" path could skip the `calculateOverflows` re-emit entirely and only
the staff-skyline union needs to re-run (because `postBaseX` shifts). Payoff bounded by
`calculateOverflows` (1.33 %) + `_emitGroupOverflows` (1.00 %) ≈ 5.5 ms/iter saved on the heavy
canon-resize-drag, well above σ.

### Q3 — _raiseRange (3.42 % CPU, 5.42 % heap, line 483)

Three suboptimalities: (1) `_splitAt` does a binary search but each split is followed by
`_segments.splice()` which is O(n) — so two splits + a merge sweep on a 20-segment skyline is
O(n) anyway. (2) The merge sweep at the tail (loop at line 517) does **one `splice(mergeIdx+1, 1)`
per fused pair** — repeated middle-of-array splices are quadratic. (3) `_splitAt` allocates a fresh
`SkylineSegment` from the pool every time it splits — driven by `_raiseRange` × ~10 ranges per
band × hundreds of bands. Allocation could be eliminated for the common "x already a breakpoint"
case (already short-circuited at line 558) but not for the general case.

Realistic algorithmic fix: a **single-pass insert** that walks segments, splits at `lo` and `hi`,
raises in-between heights and coalesces in one O(n) sweep with **at most 2 list edits**
(splice-insert + splice-remove for fused tail). Current code does 2 splits → up to 2 inserts → N
removes. Estimated payoff: 1-1.5 % CPU (≈ 2.5-3.5 ms/iter), borderline σ.

### Q4 — _initBaseline (1.90 % heap = 968 kB/iter)

Allocates 2 segments per `new Skyline` and per `reset()`. Counted per iter: `systemSkyline.reset()`
fires once per staff finalize (2836 / iter), plus pre/post bar-skyline resets in
`calculateOverflows` and `scaleToWidth`. With 2 segments × ~24 B effective = ~48 B × 20,000 resets
= ~960 kB. Fits.

The only structural avoidance is to **not call reset → re-init**: keep the sentinel pair in place
and only release intermediate segments. **(A)** — change `Skyline.reset()` to pop down to length-2
and reuse the existing sentinel/baseline in place. Payoff ~1 MB/iter alloc, below σ on CPU. Cheap
to implement, no API change.

## Summary

The CPU surface is mostly **(I)** — the algorithm is already near-optimal post-EW-1. The heap
surface is real but EW-2(b) prohibits pooling-shaped fixes. The two strongest **algorithmic**
levers are:

1. **(S)** Staff-level union (collect-all + merge-once in `finalizeStaff`) — ~4 MB/iter alloc drop,
   ~1 ms CPU upside, medium risk.
2. **(A)** Reuse Skyline's `newSegs[]` scratch across `unionShifted/unionShifted3` calls — ~3 MB/iter
   alloc drop, CPU effect below σ but free to implement.
3. **(A)** `_raiseRange` single-pass insert (fuse the 2 splits + N-step coalesce into one sweep) —
   1-1.5 % CPU win, borderline σ.
4. **(A)** `Skyline.reset()` keep-sentinels-in-place — ~1 MB/iter alloc, below σ on CPU.

The DR-1 angle (skip `calculateOverflows` on width-only resize) dwarfs all of the above — same
analysis as Q2: 2.3 % CPU saved (≈ 5.4 ms/iter), but it's **(S)** under DR-1, not in scope here.

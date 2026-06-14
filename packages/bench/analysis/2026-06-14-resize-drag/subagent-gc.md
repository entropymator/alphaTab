# GC + allocation — canon-resize-drag (255.5 MB / 5 trials = 51 MB / trial = ~6.4 MB / iter)

## Allocation classification (≥ 50 kB heap)

| % heap | site | source | class | notes |
| ---: | --- | --- | :---: | --- |
| 84.44 % | `unionShifted3` | Skyline.ts:217 | **(A)** | working array + push-grow churn (see Q1) |
| 5.42 % | `_raiseRange` | Skyline.ts:483 | **(I)** | pool-managed; allocation = `Array.splice` return + pool growth (see Q2) |
| 1.90 % | `_initBaseline` | Skyline.ts:448 | **(I)** | pool growth on cold-cache Skyline ctors |
| 1.87 % | `buildBoundingsLookup` (BarRendererBase:784) | line 784 | **(D)** | new BarBounds + 2× new Bounds — EW-2(b) territory |
| 0.50 % | `finish` (BoundsLookup) | n/a | **(D)** | Bounds tree finalize |
| 0.28 % | `buildBoundingsLookup` (RenderStaff) | StaffSystem cohort | **(D)** | same surface |
| 0.28 % | anonymous closure | runOne.mjs:57457 | **(S)** | callback shape inside RenderStaff layout |
| 0.18 % | `createPreBeatGlyphs` | LineBarRenderer:650 | **(I)** | layout-once glyph construction |
| 0.18 % | `GlyphGroup` ctor | GlyphGroup.ts:10 | **(I)** | glyph tree build |
| 0.16 % | `get effectPlacement` | RenderStaff:215 | **(A/S)** | repeated getter allocating intermediate; ≤ 84 kB so cap is tiny |
| 0.16 % | `buildBoundingsLookup` (StaffSystem:1200) | | **(D)** | same surface |

Combined Bounds-tree (lines 44723 + 55536 + 58846 + finish) = **2.43 % heap, ~156 kB / iter** — empirically demoted by EW-2(b) `2d7a4de3` → `79beda40` (`★ +3.0 %` regression with full bump allocator). Do not retry.

## Per-question answers

**Q1. `unionShifted3` 84 % (43 MB / trial = ~5.4 MB / iter).** Looking at Skyline.ts:269 — `const newSegs: SkylineSegment[] = []` is the principal alloc. The `SkylineSegment` objects themselves come from `this._pool.acquire()` and only allocate on growth. The dominant cost is therefore (a) the fresh `newSegs` Array per call, (b) backing-store doubling as `newSegs.push` grows it from 0 → segment-count, and (c) the final transfer loop `this._segments.push(newSegs[k])` which also grows the *destination* array. Both arrays are sized proportional to merged-segment count per bar (1× per bar-side per layout). The call count is fixed by `_unionBarLocalIntoStaffSkyline` (already fused 6→2 by EW-1) — call-count reduction is exhausted absent a structural skyline-shape change (DR-2 next-action). **Per-call array size IS reducible**: write directly into `this._segments` with a write-cursor and `this._segments.length = newLen` truncation, eliminating the `newSegs` array entirely. That's a (A)-class single-array fix, not a pool. Estimated heap drop: ~40-50 % of the 5.4 MB / iter (newSegs + its backing store removed; remaining is `this._segments` growth).

**Q2. `_raiseRange` 5.42 % (~550 kB / iter).** Skyline.ts:522 `this._segments.splice(mergeIdx + 1, 1)[0]` allocates a fresh 1-element Array per merge (V8 splice returns an Array even when length === 1). Also `_splitAt` at line 564 does `this._segments.splice(lo + 1, 0, newSeg)` — splice insert reshuffles backing store but doesn't allocate; the heap charge here is the **removed-elements array** from line 522, allocated once per merge step. Pool-managed segments themselves don't show because acquire only allocates on growth. **(I)** in current shape; a switch from `splice(...,1)[0]` to manual shift would reclaim it but the absolute size is ~5 % of GC, capped at ~0.6 ms of the 12 ms.

**Q3. `_initBaseline` 1.90 % (~200 kB / iter).** Skyline.ts:448-457 — two `pool.acquire()` + two `this._segments.push()`. The pool is long-lived across the scenario, so the only heap charge is the `_segments: SkylineSegment[]` instance attached to each freshly-constructed Skyline (one per bar × layout), plus pool growth on first encounter of a higher segment-count workload. Allocation surface is unavoidable absent reusing `Skyline` instances across resize iterations — which is a DR-1 layout-cache concern, not a GC one. **(I)**.

**Q4. `buildBoundingsLookup` cohort (3 sites = 1.93 % heap).** Confirmed same surface — BarRendererBase.ts:784 visibly does `new BarBounds()` + 2× `new Bounds()` per bar; StaffSystem:1200 and RenderStaff equivalents are sibling constructors in the same tree. **All three reclassify as (D)** — EW-2(b) tried pool-replacing this exact tree (6 concrete `ObjectPool<T>` instances on `ScoreRenderer`, O(1) `releaseAll`) and produced `★ +3.0 %` canon-resize regression. Pool overhead at this allocator > GC savings.

**Q5. GC budget arithmetic.** GC self-time = 5.10 % = 12 ms / iter. `unionShifted3` is 84 % of heap = ~10.1 ms of the GC time *if young-gen cost were strictly proportional to allocation share*. Collapsing 50 % of its 5.4 MB / iter alloc via the `newSegs`-removal path above would reclaim at best 50 % × 84 % × 12 ms = **~5 ms / iter** — but the EW-2(b) evidence (CLAUDE notes lines 84-100) shows the predicted "alloc-share × GC = saved CPU" model **does not hold** because V8's young-gen bump allocator is amortised near-zero for short-lived objects: the actual realised CPU saving in EW-2(b) was *negative* despite eliminating ~1.8 MB / iter, because the elimination machinery added more cycles than the GC was burning. Realistic projection here: **0-2 ms recoverable (0-0.85 % wall)**, not 5 ms — and only if the fix is a single-array write-cursor (no pool, no dispatch overhead, no abstraction). Anything heavier loses by the EW-2(b) cost model.

## Bottom line

- `unionShifted3` allocation share is real but its **CPU mapping is non-linear** — V8 young-gen amortisation means heap-share is NOT a proxy for GC-CPU-share.
- One algorithmic shape is unprosecuted: the `newSegs` working array. Single-array, no pool, no virtual dispatch. ≤ 0.85 % wall.
- All Bounds-tree allocators (1.93 % heap combined) are **(D)** by EW-2(b) precedent — do not retry pool-style replacement.
- `_raiseRange` splice-array charge (~550 kB / iter, **(I)** mostly) is too small to clear the σ floor independently.
- The remaining 8 % of heap is scattered across glyph construction (layout-once, not resize-hot, not actionable for resize-drag).

**Single actionable algorithmic candidate**: `unionShifted3` write-cursor refactor — eliminate `newSegs` by writing directly into `this._segments` with cursor + final `length =` truncation. Quantified upper bound 0.85 % wall, below σ floor (1.48 %). Likely below noise.

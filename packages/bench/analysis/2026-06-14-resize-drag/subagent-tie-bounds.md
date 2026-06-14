# canon-resize-drag — tie / cross-system slur / bounds (subagent)

Trial total self CPU = 1975 ms (sum 5 trials = 9937 ms). 1 % = 2.35 ms / iter.
Per-trial = 8 iterations; per-iter cost = (sum-total trial-1) / 8.

## Quantified tie / slur re-layout cost

| symbol | self ms / trial | total ms / trial | per-iter total | % of trial | classification |
|---|---:|---:|---:|---:|---|
| `_emitTies` (BarRendererBase.ts:535) | 3.5 | 40.8 | 5.1 ms | 2.06 % | A — bounded |
| `finalizeOwnedTies` (BarRendererBase.ts:528) | 3.5 | 44.3 | 5.5 ms | 2.24 % | A — bounded |
| `registerMultiSystemSlurs` (BRB.ts:501) | 1.66 | 7.56 | 0.95 ms | 0.38 % | I — small |
| `_calculateActualTieHeightFromCps` (TieGlyph.ts:428) | 0.98 | — | 0.12 ms | 0.05 % | I |
| `finalizeStaff` inclusive (RenderStaff.ts:273) | 2.22 | 182 | 22.7 ms | 9.20 % | mostly bounds+overflows, not ties |

**Answer to Q1**: the tie/slur re-layout proper on canon-resize-drag is **~2.2 % CPU / ~5 ms/iter** (`finalizeOwnedTies` + `registerMultiSystemSlurs`). It is *real* but it is **not** the dominant cost inside `finalizeStaff`. The 9 % `finalizeStaff` inclusive figure is paid by `_unionBarLocalIntoStaffSkyline` → `unionShifted3` (~5 % alone in the heap top) + `_emitGroupOverflows` (0.79 %) + `getBoundingBoxTop` overhead inside `_emitTies`, not by tie geometry itself.

Upper bound for an "elide-tie-rework when nothing relevant moved" patch: ~5 ms/iter, i.e. **~2 %**. That clears σ. Sketch: skip `_emitTies` on a per-renderer basis when the `tieGrowsOverflow` invariant has not changed (same `x`, same `width`, same `topOverflow/bottomOverflow`, same neighbouring renderer `y`). All four are width-dependent in canon-resize-drag because system packing changes every iteration → most renderers DO change → expected hit rate is small. **Demote** unless a stricter signature can be designed.

## buildBoundingsLookup — three call sites (Q2)

Per-iter inclusive breakdown (sum-total / 8):

| site | per-iter total | role |
|---|---:|---|
| BRB.ts:784 (per-bar leaf) | 4.4 ms | builds BarBounds → VoiceContainer recursion |
| StaffSystem.ts:1200 (system-level) | 7.5 ms | builds StaffSystemBounds + MasterBarBounds Map |
| dist:53771 → MultiVoiceContainerGlyph.buildBoundingsLookup | 5.5 ms | recursion into beat containers |

Sum of inclusive = 17.4 ms/iter, ~7.4 % CPU. EW-2 demoted caching across width changes (packing invalidates 100 %). EW-2(b) demoted object pooling (V8 bump-allocator wins).

**Push-based-bounds angle (Q2 fundamental redirect, analogous to DR-5's push-skyline)**: the current pipeline is *pull* — at paint time the system walks every renderer asking "what is your bounds?" and re-allocates a `BarBounds`/`BeatBounds`/`NoteBounds` tree off coordinates already computed during layout. The push variant: when layout finalises `staff.y`, `renderer.x/width/height` it writes the *same numbers* into bounds slots already attached to the renderer/voice-container/note. Then `buildBoundingsLookup` becomes pointer-shuffling into the lookup's flat lists — no allocation, no tree recursion. This is *not* caching across resizes; it's eliminating the duplicate computation within a single resize. Allocation footprint vanishes (953 kB/trial of `buildBoundingsLookup` at BRB:784 + 144 kB/trial at BRB:55536 + 83 kB/trial at SS:1200 ≈ 1.18 MB/iter heap saved), and the recursion cost drops because each glyph already has `x/y/width/height`. Estimated payoff: 5-8 ms/iter, **2-3 %**. Risk: structural (S) — every `buildBoundingsLookup` override along the chain plus the `BoundsLookup.finish()` shape would need to grow `addBarBoundsRef(barBounds)` etc. Not an easy win; document as new DR.

A complementary lazy variant (build only on first `findBeat` query, see EW-2(a)) is still on the table and orthogonal — the push refactor enables it cheaply because the slots stay valid between resizes.

## DR-5 surface evolution (Q3)

The drag profile shows `getBoundingBoxTop` aggregating **74.4 ms self / trial (3.77 %)** across at least 8 distinct frames. Top frames per-iter:
- dist:64403 (`ScoreBeatContainerGlyph.getBoundingBoxTop`) — 2.7 ms self/iter, 1.09 % CPU
- dist:51634 (`GlyphGroup.getBoundingBoxTop` recursion) — 2.3 ms self/iter, 0.94 %
- dist:53618 (`MultiVoiceContainerGlyph.getBoundingBoxTop`) — 0.5 ms self/iter
- dist:44648 (base `Glyph.getBoundingBoxTop`) — 1.25 ms self/iter
- dist:51370, dist:62382, dist:63293, dist:60313, dist:63740, dist:61921 (further overrides)

**DR-5 remains credible** as a lifecycle-hook lever. The 2026-06-13 micro-devirt attempt failed because dispatch-cost-per-call is *not* the bottleneck — the function bodies are. A push-skyline that maintains running min/max at `addPreBeatGlyph` / `addGlyph` time would eliminate the chained recursion in `calculateOverflows` AND inside `_emitTies` (which itself calls `getBoundingBoxTop` on each tie). Note `_emitTies` is now the third caller of `getBoundingBoxTop` in the drag profile, so a unified end-of-finalize hook now pays back across overflows, tie emission, and (via the push-bounds idea above) the bounds tree. Expected payoff per DR-5 estimate (12-15 ms) is consistent with the drag profile: getBoundingBoxTop accounts for ~9 ms/iter alone; container recursion `_paintNormal` (1.37 %) and `paint`/`buildBoundingsLookup` calls into the same trees add another ~5-8 ms.

Recommend updating HOTSPOTS DR-5 to broaden scope from "calculateOverflows + getBoundingBoxTop" to "all glyph-tree min/max-y walks (overflows + tie emit + bounds tree)" so it captures the now-visible cross-cutting nature in the drag profile.

## Files referenced (absolute)

- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/BarRendererBase.ts (`_emitTies`, `buildBoundingsLookup`, `finalizeOwnedTies`)
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/staves/RenderStaff.ts (`finalizeStaff`, `registerMultiSystemSlurs` call site)
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/staves/StaffSystem.ts (`buildBoundingsLookup` system-level, line 1200)
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/glyphs/TieGlyph.ts (`_calculateActualTieHeightFromCps`, line 428)
- /home/daniel/dev/alphaTab2/packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts (`_paintSystem`:389 calls `system.buildBoundingsLookup`)

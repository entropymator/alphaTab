# Skyline emission architecture v4 — review

## Verdict

**Ready to implement, with one tight contract gap to close as part of Step 1c and one signature gap to close as part of Step 16.** v4 is a real improvement on v3: §D.2's split rows for `barLocalSkyline` (content vs tie overlay) close v3-Critical 1 substantively, §D.6's four-substep table for SystemFinalize closes v3-Critical 3, §B.25's mechanism rewrite is correct against [GroupedEffectGlyph.ts:20-25](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L20), and Step 11 explicitly enumerates `_preBeatGlyphs` plus a "survives vs reassigned" matrix. The §J checklist is mostly honest.

The remaining issues are narrow. The most load-bearing is that Step 1c retires `_accoladeSpacingCalculated` and promises "recompute at CoordinateAssemble close" without engaging with the fact that the current `_calculateAccoladeSpacing` body **mutates `system.width` and `system.computedWidth` via `+= accoladeWidth`** ([StaffSystem.ts:689-690](packages/alphatab/src/rendering/staves/StaffSystem.ts#L689)); naive recomputation accumulates. Second: §D.3's `populateSkyline?` signature passes a `SkylineTarget`, but Step 16 needs the hook to publish into the `EffectBand` (`band.publishSpanRange`), not into `barLocalSkyline` — the signature and the use case don't match. Both are fixable in step text without restructuring the plan.

Counts: 2 critical, 4 significant, 3 minor, 2 missed.

## What v4 fixed cleanly from v3

- §D.2 row split for `barLocalSkyline` (content vs tie overlay) closes the v3-review Critical 1 contradiction substantively, not by gesture.
- §D.6's four-substep SystemFinalize table pins the load-bearing ordering and explains *why* (i) and (ii) must be separated (the chain-walk in (ii) needs every renderer's `isFinalized=true`, which only (i) guarantees).
- §B.25's mechanism rewrite is exactly right against [GroupedEffectGlyph.ts:20-25, :31-37, :69-79](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L20) — `getBoundingBoxRight` reads `this.beat`/`this.renderer`, the chain walk uses `isLinkedWithNext` + `nextGlyph`, `calculateEndX` is the canonical formula.
- Step 11's scope explicitly includes `_preBeatGlyphs` with a conditional-discard contract; the "survives vs reassigned" matrix (Step 11 body) names `voiceContainer`, `helpers`, `_postBeatGlyphs`, `_multiSystemSlurs`, model refs as survivors.
- DAG sequences Step 11 *after* Step 8b explicitly (closes v3-review Sig #10).
- Step 1 split into 1a/1b/1c with three distinct deliverables and three distinct test corpora.
- B.26–B.31 (six newly inventoried fields, all per v3-review's M-list) — file:line claims spot-checked against code and correct.

## Critical findings

### 1. Step 1c — retiring `_accoladeSpacingCalculated` without unwinding `system.width += accoladeWidth`

- **Where in v4.** [§E Step 1c](.docs/skyline-emission-architecture-v4.md), §D.8a, §H Step 1c invariant ("grep `_accoladeSpacingCalculated`: zero occurrences").
- **The claim.** Recompute accolade spacing at CoordinateAssemble close on every `addBars` and `revertLastBar`; "the body of `_calculateAccoladeSpacing` is dominated by `canvas.measureText` calls that can be cached on the system once-per-bar-set."
- **Why it's wrong.** The body of `_calculateAccoladeSpacing` is NOT dominated by `measureText`. The load-bearing side effects are at [StaffSystem.ts:673-690](packages/alphatab/src/rendering/staves/StaffSystem.ts#L673):
  ```ts
  let currentY: number = 0;
  for (const staff of this.allStaves) {
      staff.y = currentY;
      staff.calculateHeightForAccolade();
      currentY += staff.height;
  }
  // ... bracket finalize ...
  this.accoladeWidth += braceWidth;
  this.width += this.accoladeWidth;
  this.computedWidth += this.accoladeWidth;
  ```
  Removing the `_accoladeSpacingCalculated` gate and calling this on every `addBars` causes `system.width` and `system.computedWidth` to grow by `accoladeWidth` on every call. Worse, `this.accoladeWidth += braceWidth` is also incremental against `this.accoladeWidth` — so the brace contribution itself drifts.
- **File:line evidence.** [StaffSystem.ts:584-690](packages/alphatab/src/rendering/staves/StaffSystem.ts#L584). The else branch [:691-696](packages/alphatab/src/rendering/staves/StaffSystem.ts#L691) re-runs `b.updateCanPaint(); b.finalizeBracket(...)` on subsequent calls but specifically does NOT re-touch `this.width` / `this.computedWidth` / `this.accoladeWidth` — which is precisely how the gate makes the function safe to call multiple times today.
- **Impact if shipped.** Step 1c lands; first `addBars` writes correct widths; second `addBars` re-adds accoladeWidth; after N bars, the system width is `actual + (N-1) * accoladeWidth`. `_applyLayoutAndUpdateWidth`'s `systemIsFull` estimator at [VerticalLayoutBase.ts:503](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L503) makes wrap-point decisions against the inflated width → every multi-bar system wraps too early. Visual regressions catch this, but the doc reads as if the design is "just remove the gate."
- **Fix.** Step 1c's scope must either (a) **rewrite `_calculateAccoladeSpacing` to be idempotent** — assign rather than `+=` for `accoladeWidth`, and unwind any prior contribution to `system.width` / `system.computedWidth` before re-applying; or (b) introduce a sibling `_recalculateAccoladeSpacing` that wraps the recompute in unwind+reapply. The doc must state this. The current "cache `measureText`" framing misidentifies the cost center *and* leaves the actual problem (accumulating side effects on `system.width`) un-described. §D.8a should also note: `staff.y` is written by this method via `currentY` accumulation, so the staff-y-assignment is also part of the idempotency contract.

### 2. `populateSkyline?` signature does not match Step 16's actual write target

- **Where in v4.** §D.3 ("Two dispatch points"), Step 16 ("published into the band via a `band.publishSpanRange(this, startX, trueEndX)` call").
- **The claim.** §D.3's signature is `populateSkyline?(target: SkylineTarget, ctx: SkylineCtx)` with `target ∈ {BarLocalSkyline, StaffSystemSkyline}`. The SystemFinalize dispatch loop in §D.3 invokes:
  ```ts
  g.populateSkyline!(renderer.barLocalSkyline, { phase: 'systemFinalize', renderer });
  ```
  Step 16 then asks `GroupedEffectGlyph.populateSkyline?` to publish via `band.publishSpanRange(this, startX, trueEndX)` — which writes to `EffectBand`, not to the skyline target the dispatcher passed.
- **Why it's wrong.** The hook signature contract says "you receive a skyline and write into it." Step 16's usage receives a skyline and writes into a band. These are two different APIs glued together by the implementer ignoring the `target` parameter. That makes the hook contract incoherent: a future reader sees `populateSkyline(target, ctx)` and reasonably assumes `target` is where the writes go. For BarTempoGlyph (the Phase-3 use case) the contract works: writes go to `target = barLocalSkyline` via `insertSkylineTop`. For GroupedEffectGlyph the contract is "ignore `target`, navigate to `ctx.renderer.someBand` and call a different method."
- **File:line evidence.** §D.3 pseudocode in [`.docs/skyline-emission-architecture-v4.md`](./.docs/skyline-emission-architecture-v4.md) (line ~384-389); Step 16 text (line ~755) for `band.publishSpanRange`. `EffectBand.computeLocalXRange` at [EffectBand.ts:251-294](packages/alphatab/src/rendering/EffectBand.ts#L251) is what reads back the publish; the publish target is `EffectBand`, not `barLocalSkyline`.
- **Impact if shipped.** Step 16 implementer either (a) renames the hook to two separate hooks (`populateBarLocalSkyline?` vs `publishSpanRange?`), bloating §D.3's "one mechanism" framing into two; or (b) implements §D.3's signature literally and ignores `target` for the systemFinalize case, leaving the API misleading. Either way §D.3's "two dispatch points, one hook" narrative breaks.
- **Fix.** Pick one of: (a) split into two hooks — `populateBarLocalSkyline?(target: BarLocalSkyline, ctx)` fired in Phase 3, and `publishSystemFinalizeRanges?(ctx)` fired in SystemFinalize substep (ii), whose body navigates to whatever container it needs (band, slur registry, etc.); (b) keep one hook but change the signature to `populateSkyline?(ctx)` and let the implementer pull the right target from `ctx.renderer`. §D.3 needs the chosen shape spelled out; Step 16 then references the chosen API. The current text reads as two incompatible APIs sharing a name.

## Significant findings

### 3. `BarLayoutingInfo.version` is also bumped from `finish()`, not only `addSpring` and `recomputeSpringConstants`

- **Where in v4.** Step 8a scope ("stop bumping `BarLayoutingInfo.version` from `addSpring`; version moves only via `recomputeSpringConstants`"); §H Step 8a invariant ("grep `version++` in `BarLayoutingInfo.ts`: only in `recomputeSpringConstants`").
- **Why it's wrong.** [BarLayoutingInfo.ts:261](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts#L261) inside `finish()` also has `this.version++;` ([:259-262](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts#L259)). The three bump sites are `addSpring` ([:136](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts#L136)), `finish()` ([:261](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts#L261)), and `recomputeSpringConstants` ([:277](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts#L277)). §B.19 cites only :136. §H Step 8a's grep would fail today against three matches, not the one v4 implies.
- **Fix.** Step 8a should specify the post-step shape: "version bumped at LOCAL seal (`finish()`) and at `recomputeSpringConstants`, NOT in `addSpring`." That's still consistent with the cookie's role (a downstream consumer sees a new version when either the local bar finished or system reconcile retroactively changed spring constants). §H Step 8a's grep then becomes "grep `version++`: exactly 2 occurrences, in `finish` and `recomputeSpringConstants`."

### 4. Step 11's "per-staff substate" misses `system._accoladeSpacingCalculated` and the system-level rollback contract

- **Where in v4.** Step 11 per-staff `StaffLayoutCycle` scope; §D.8 revert rollback set (lists `system._accoladeSpacingCalculated`).
- **Why it's incomplete.** §D.8 explicitly names `system._accoladeSpacingCalculated` as a field that revert must reset — but Step 1c retires that field entirely. After Step 1c, the rollback bullet is dead text. More substantively: Step 11's substate model is per-renderer + per-staff. But several fields v4 cares about are **per-system**, not per-staff: `system.width`, `system.computedWidth`, `system.totalFixedOverhead`, `system.totalContentWidth`, `system.totalBarDisplayScale`, `system.firstVisibleStaff`, `system.minDuration`, `system.isMinDurationDirty`, `system.accoladeWidth`. These are mutated by `_applyLayoutAndUpdateWidth` at [StaffSystem.ts:575-579](packages/alphatab/src/rendering/staves/StaffSystem.ts#L575) and unwound by `revertLastBar` at [:535-539](packages/alphatab/src/rendering/staves/StaffSystem.ts#L535). v4's Step 11 has no per-system substate object.
- **Impact.** Resize re-entry (§D.8) is described as "discard substate per renderer + per staff." But on resize, the per-system accumulators (`system.width`, `totalFixedOverhead`, etc.) are also stale — and there's no `SystemLayoutCycle` substate object to swap. Today [VerticalLayoutBase.ts:288](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L288) handles this for barsPerRow-active resize by `system.width = system.computedWidth` (reset to the natural width); for free-wrap resize ([:301](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L301)) `_systems = []` discards the whole system. v4's "phase-symmetric resize" model doesn't engage with the per-system reset.
- **Fix.** Step 11 needs a third tier: per-system `SystemLayoutCycle` substate, with `width`, `computedWidth`, `totalFixedOverhead`, `totalContentWidth`, `totalBarDisplayScale`, `accoladeWidth`, `firstVisibleStaff`, `minDuration`, `isMinDurationDirty`. The §D.8 revert rollback bullet for `_accoladeSpacingCalculated` should be replaced with "atomic reassign of `SystemLayoutCycle`." Without this, the §D.8 rollback set is per-staff/per-renderer and the per-system accumulators are managed by ad-hoc `revertLastBar` and `_resizeAndRenderScore` branches — i.e. the C-6 anti-pattern survives at system scope.

### 5. §D.2 phase row for `renderer.y` says "(=0)" through Phase 2 but Phase 2 actually writes it

- **Where in v4.** §D.2 row `renderer.y`: `(=0)` through Phase 0 / 1 / CoordinateAssemble / CoordinateReconcile / Phase 2 / Phase 3, then "**final after sub-step (iv)**" at SystemFinalize.
- **Why it's wrong.** [VerticalLayoutBase.ts:462](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L462) inside `_scaleToWidth` (the Phase-2 driver under v4's mapping in §D.9) assigns `renderer.y = s.topPadding + s.topOverflow` for every renderer. Then `finalizeStaff` at [RenderStaff.ts:331](packages/alphatab/src/rendering/staves/RenderStaff.ts#L331) writes it again post-`placeAndApply`. So `renderer.y` has at least two writers — one in Phase 2, one in SystemFinalize sub-step (iv). The §D.2 row is asymmetric: it should either show Phase 2 writing a provisional value (later overwritten) or v4 should formally retire the Phase-2 write. Today the Phase-2 write is dead because the Phase-3 / SystemFinalize write always supersedes it, but as a *contract* the row reads wrong.
- **Impact.** A Step 13 implementer reading the row designs `spacedLayout()` without writing `renderer.y`. Today's code writes it; if Phase 2 stops writing it but anything between Phase 2 and SystemFinalize reads it (paint extents during `populateSkyline?` for example), the read sees 0 from `(=0)`. Fix is easy: either drop the dead `renderer.y =` in `_scaleToWidth` as part of Step 9/Step 13, or annotate the row "(provisional in Phase 2, final after SystemFinalize sub-step (iv))."

### 6. Step 1a's pre-pass is described as recomputing `firstVisibleStaff` per `addBars` / `revertLastBar` but the today-pattern already does this incrementally

- **Where in v4.** Step 1a scope.
- **Why it's incomplete.** [StaffSystem.ts:344-395](packages/alphatab/src/rendering/staves/StaffSystem.ts#L344) already recomputes `firstVisibleStaff` on every `addBars` (lines 344, 381-393, 395). [StaffSystem.ts:504-533](packages/alphatab/src/rendering/staves/StaffSystem.ts#L504) recomputes it on `revertLastBar`. The B.5 anti-pattern is not "firstVisibleStaff is computed late" — it's "firstVisibleStaff is computed *during* per-bar `addBar` calls instead of from the bar set as a whole, which means the very first `_calculateAccoladeSpacing` call (gated to first `addBars`) sees a possibly-wrong `firstVisibleStaff`." Step 1a's "recompute per addBars" is what today already does. The substantive change v4 promises — "decidable from the model alone, pre-pass" — would mean walking the master bar set once score-globally to decide visibility per system, not per-bar mutation.
- **Impact.** Step 1a as written is a near-no-op refactor. Its acceptance gate (`VisualTests.GhostStaffVisibility`) passes against today's code. If Step 1a doesn't substantively change the data flow, the §H invariant ("`system.firstVisibleStaff` final before any renderer's `doLayout` reads it") is not a new property — today's `addBars` sets `firstVisibleStaff` AFTER all `addBar` (and thus all `doLayout`) calls; that's the actual bug, and it's not addressed by "recompute on every addBars."
- **Fix.** Step 1a needs to be either (a) "decide `staff.isVisible` per master bar in a Phase-0 pre-pass that walks the model and sets `staff.isVisible` from the bars-it-will-eventually-contain" (the real fix); or (b) "move `firstVisibleStaff` reads in `_calculateAccoladeSpacing` to a point after all `addBar` calls have settled" — which intersects with Step 1c. v4 currently reads as (b) without the intersection.

## Minor findings

### 7. §H Step 0 invariant grep is wrong

§H Step 0: "`_scaleToForce(` ... count = 2 (one per file)." `_scaleToForce` is a private method on `MultiVoiceContainerGlyph` ([MultiVoiceContainerGlyph.ts:160-167](packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts#L160)). It's not called from `BarRendererBase.ts`. The grep target as written would yield occurrences only in `MultiVoiceContainerGlyph.ts`. Step 0 hoists the call out of the per-voice loop body but keeps the method on the same class. Adjust the invariant: "in `MultiVoiceContainerGlyph.ts`, `_scaleToForce(` appears once at the call site (outside the per-voice loop) and once at the method declaration."

### 8. §D.2 `RenderStaff._sharedLayoutData` row column for "Phase 1 (Intrinsic)" is misleading

The row says "(read by per-band `onAlignGlyphs` callbacks if any)." But `onAlignGlyphs` is invoked from `EffectBandContainer.alignGlyphs`, which is called in Phase 1's `doLayout` ([BarRendererBase.ts:697](packages/alphatab/src/rendering/BarRendererBase.ts#L697)) — so `_sharedLayoutData` may be **written** in Phase 1, not just read. `TabWhammyEffectInfo.onAlignGlyphs` ([TabWhammyEffectInfo.ts:44-60](packages/alphatab/src/rendering/effects/TabWhammyEffectInfo.ts#L44)) does `setSharedLayoutData`. v4 needs to mark the Phase-1 cell as "written by `onAlignGlyphs`" too, or note that Phase 1 reads-and-writes the bag (which is C-7-shaped — Phase 1 is supposed to "publish into the broker" only).

### 9. §H Step 13 grep invariant assumes a renamed `spacedLayout()` exists

The §H Step 13 row says "grep `barLocalSkyline.insert\|insertSkylineTop\|insertSkylineBottom` reachable from `spacedLayout`: zero." `spacedLayout` is a proposed new method name not yet in code. Until Step 13 renames the method, the invariant is unverifiable. Reword: "the file that contains `spacedLayout()` (the Phase-2 entry point) contains zero `barLocalSkyline.insert*` reachable from that method's call graph." Or specify the file/method shape Step 13 produces — e.g. the body of the renamed method ends before the first `insert*` site.

## Items v4 missed

### M11. `MasterBarsRenderers.layoutingInfo` is the BarLayoutingInfo owner, not `StaffSystem`

§B.16 cites "[StaffSystem.ts:340](packages/alphatab/src/rendering/staves/StaffSystem.ts#L340)" for `BarLayoutingInfo` ownership. That line is `result.layoutingInfo = new BarLayoutingInfo();` inside `addBars`, where `result` is the freshly-created `MasterBarsRenderers` ([MasterBarsRenderers.ts:39](packages/alphatab/src/rendering/staves/MasterBarsRenderers.ts#L39)). The owner is `MasterBarsRenderers`, not `StaffSystem` — `StaffSystem` only iterates `masterBarsRenderers[].layoutingInfo` via `_trackSystemMinDuration` and `reconcileMinDurationIfDirty`. v4's prose at §D.4 says "remains a cross-bar broker on `MasterBarsRenderers`" (correct) but §B.16 and §A.2 occasionally read as if `StaffSystem` owns it. Minor but worth tightening because the v4-G.1 deferred refactor ("push to `MasterBarLayout`") is about moving ownership AWAY from `MasterBarsRenderers` — the reader needs to know where it lives today.

### M12. `EffectBand.finalizeBand` mutation site has no phase row

[EffectSystemPlacement.ts:78-83](packages/alphatab/src/rendering/EffectSystemPlacement.ts#L78) calls `b.finalizeBand()` for each band before placement. That's a mutation that runs in SystemFinalize sub-step (iv), affecting band `height` (for dynamic-height effects like TabWhammy). §D.2 doesn't have a row for `EffectBand.height` or `EffectBand.finalizeBand`'s effect. The row is implicit in "topEffects.height / bottomEffects.height — final after sub-step (iv)" but a separate row for the band-level state would close the C-7 / C-6 traceability gap for TabWhammy. (Step 5's audit deliverable covers this for `onAlignGlyphs` but not for `finalizeBand`.)

## Verification of v4's §J sign-off checklist

| Review condition | v4 claim | Actually addressed? | Evidence |
| --- | --- | --- | --- |
| C1 — skyline emission phase contradiction | §D.2 row split + §D.7 + §H Step 13 | **Yes** | §D.2 has two cells: `(reset, empty)` after Phase 2; `emitted, final` after Phase 3; tie overlay row separate. §D.9 splits `scaleToWidth` body into "positions → Phase 2" and "emit → Phase 3." |
| C2 — Step 11 omits `_preBeatGlyphs` | Step 11 includes it (conditional discard) | **Yes** | §E Step 11 scope explicitly lists `_preBeatGlyphs` (line ~682) with the conditional-discard rule. |
| C3 — SystemFinalize sub-phase ordering | §D.6 four-substep table | **Yes** | §D.6 table is explicit; the (i)/(ii) split is justified by `isFinalized=true` precondition for the chain walk. |
| C4 — Step 1 vs accolade interaction | Step 1a/1b/1c split | **Partial** | Three distinct sub-steps with three distinct corpora exist. But Step 1c's *body* hand-waves the `system.width += accoladeWidth` accumulation problem (see Critical 1 above). The split is real; the contract inside 1c is not. |
| C5 — §B.25 mechanism wrong | §B.25 rewritten | **Yes** | §B.25 prose now correctly cites `this.renderer.getBeatX(this.beat, this.endPosition)` + `nextGlyph` + `isLinkedWithNext`. Matches [GroupedEffectGlyph.ts:20-25, :31-37, :69-79](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L20). |
| S6 — `populateSkyline?` lifecycle | §D.3 two-dispatch design | **Partial** | Two dispatch points are spelled out. Hook signature does not match Step 16's use case (see Critical 2 above). |
| S7 — BarTempoGlyph hook justification | §D.3 "emission timing not bbox stability" paragraph | **Yes** | The "barLocalSkyline.reset() at Phase 3 start would wipe earlier emissions" justification is correct. |
| S8 — Step 0 unit test gate | Acceptance includes per-voice equality test | **Yes** | Step 0 acceptance is concrete. |
| S9 — Route B eager-populate predicate | §D.5 pseudocode with `getTupletBeamDirection !== getBeamDirection` | **Yes** | Pseudocode is in §D.5. |
| S10 — Step 11 after Step 8b | DAG sequences this | **Yes** | DAG and §E Step 11 ordering note are explicit. |
| S11 — Step 5a enumerate-and-classify | Step 5a deliverable | **Yes** | Step 5a names the deliverable; today's audit result documented (TabWhammy = max-of-idempotent, no others). |
| S12 — v3 §13-§18 hand-waved | §I per-Minor table | **Yes** | §I has one row per Minor. |
| M1-M10 | §B.26-B.31 + §D.2 rows | **Mostly** | All ten rows have substantive closures. M3 (MultiBarRest paint extent) is the weakest — §D.2 row is generic, not multi-bar-rest-specific. |

## Sign-off conditions for v5

1. **Step 1c body must address `system.width += accoladeWidth` accumulation.** State whether `_calculateAccoladeSpacing` is rewritten to be idempotent (assign rather than `+=`), or wrapped in unwind+reapply. Mention `staff.y` accumulation via `currentY` in the same paragraph.
2. **Resolve the `populateSkyline?` signature inconsistency with Step 16.** Either split into two hooks (Phase-3 / SystemFinalize) with different signatures, or change the single-hook signature to drop the `target` parameter and let the implementer pull the right write target from `ctx`. Then make §D.3 and Step 16 reference the same shape.
3. **Step 8a invariant: acknowledge `finish()` bumps version too.** Update §H Step 8a's grep to "exactly 2 sites, in `finish` and `recomputeSpringConstants`."
4. **Add a per-system substate tier to Step 11.** `system.width / computedWidth / totalFixedOverhead / totalContentWidth / totalBarDisplayScale / accoladeWidth / firstVisibleStaff / minDuration / isMinDurationDirty` need to be in a `SystemLayoutCycle` and atomically reassigned on resize. The §D.8 `_accoladeSpacingCalculated` bullet becomes "SystemLayoutCycle reassign."
5. **§D.2 row for `renderer.y` must reflect the Phase-2 write or Step 13 must retire it.** Otherwise the row's contract reads false against the code Step 13 inherits.
6. **Step 1a's pre-pass deliverable must be sharper than "recompute on addBars/revertLastBar."** Today's code already does that; the substantive fix is "decide visibility per master bar in a model-only pre-pass so `_calculateAccoladeSpacing`'s first call sees the final answer, not the first-bar-only answer."

Items 1, 2, and 4 are load-bearing for implementation. Items 3, 5, 6 are contract tightening (the doc reads false against code without them but the implementer can route around the gap). All six are paragraph-scale fixes inside existing §E steps — no structural rework.

If 1, 2, 4 land, v5 is implementable. Items 3, 5, 6 should land in the same pass for cleanliness.

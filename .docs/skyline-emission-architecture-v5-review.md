# Skyline emission architecture v5 — review

## Verdict

**Ready to implement; address two narrow inconsistencies inline during Step 3 and Step 0 implementation.** v5 has converged. The two v4 Critical findings are closed substantively: §D.8a now spells out the idempotency contract for `_calculateAccoladeSpacing` with file-line edits at [StaffSystem.ts:687, :689, :690](packages/alphatab/src/rendering/staves/StaffSystem.ts#L687) and a write-then-read sentinel test; §D.3 drops the `target` parameter and justifies the asymmetry between `BarTempoGlyph` (writes `barLocalSkyline`) and `GroupedEffectGlyph` (writes `EffectBand` via the new `publishSpanRange`) with a phase-segregated registration model. The v4 Significant findings (S3 `BarLayoutingInfo.version` site count, S4 `SystemLayoutCycle` tier, S5 `renderer.y` Phase-2 write, S6 Step 1a → 1c fold) are all closed with substantive prose edits that match current code. Items v4 missed (M11 ownership, M12 `finalizeBand`) are addressed at §A.2 / §B.16 / §B.32 / §D.2.

Remaining issues: (1) §D.7 pseudocode (line 492) still passes a `target` argument to `populateSkyline!`, contradicting §D.3's redesigned ctx-only signature — this is a single-line doc inconsistency the Step 3 implementer must not propagate. (2) §H Step 0's grep target "exactly 2 lines" ignores the existing `_scaleToForce` call in `MultiVoiceContainerGlyph.scaleToWidth` at [MultiVoiceContainerGlyph.ts:58](packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts#L58) — the post-Step-0 count is 3 (declaration + two distinct call sites), not 2. Both are paragraph-scale fixes. The macro architecture and DAG are sound.

Counts: 0 critical, 2 significant, 3 minor, 1 missed.

## What v5 fixed cleanly from v4

- §D.8a now describes the load-bearing accumulation problem in code-cited prose and gives a 5-step idempotency recipe; the `system.width` sentinel test in §H Step 1c is concrete and implementable.
- §D.3 ctx-only signature with the `_populateSkyline_finalized` / `_populateSkyline_systemFinalize` two-list dispatch model is internally coherent; the `publishSpanRange` write target is justified.
- §E Step 11 third tier `SystemLayoutCycle` enumerates 9 per-system fields with file:line citations; §D.8 revert rollback table maps every today-`-=` to the substate recompute.
- §B.19 acknowledges all three `version++` sites at [BarLayoutingInfo.ts:136, :261, :277](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts#L136) and pins the post-step shape to 2 sites.
- §D.2 `renderer.y` row marks the Phase-2 write at [VerticalLayoutBase.ts:462](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L462) as "provisional, retired by Step 13" — the row reads true against today's code.
- §A.2 / §B.16 / §D.4 / appendix consistently locate `BarLayoutingInfo` ownership at [MasterBarsRenderers.ts:39](packages/alphatab/src/rendering/staves/MasterBarsRenderers.ts#L39).
- v4's no-op Step 1a folded into Step 1c with a clear explanation of why the v4 framing was a no-op.

## Critical findings

None. The v4 Critical findings are substantively closed.

## Significant findings

### S1. §D.7 pseudocode still passes a `target` argument; contradicts §D.3's ctx-only signature

- **Where.** §D.7 line 492 in [skyline-emission-architecture-v5.md](.docs/skyline-emission-architecture-v5.md):
  ```ts
  for (const g of this._populateSkyline_finalized) {
    g.populateSkyline!(this.barLocalSkyline, { phase: 'finalized', renderer: this });
  }
  ```
- **Why it matters.** §D.3 explicitly redesigns the hook to `populateSkyline(ctx)` (one arg) — see §D.3 line 373 and the dispatcher pseudocode at line 396 (`g.populateSkyline!({ phase: 'finalized', renderer: this });`). §D.7's two-arg invocation contradicts §D.3 and contradicts §H Step 3's grep invariant ("grep `populateSkyline\?\(target` in `Glyph.ts`: zero occurrences"). A Step 13 implementer following §D.7's "exact code shape" verbatim would write the wrong signature.
- **Fix.** Update §D.7 line 492 to single-arg: `g.populateSkyline!({ phase: 'finalized', renderer: this });`. One-line edit, no structural impact. The v4 review caught the v4 mismatch between §D.3 and Step 16; v5 fixed §D.3 and Step 16 but left §D.7 unchanged.

### S2. `EffectBand.publishSpanRange` and `renderer.bandOf(this)` are both new APIs but the glyph→band reverse map doesn't exist today

- **Where.** §D.3 line 387 / Step 16 line 852 in v5.
- **Why it matters.** §D.3 says "The band is the one this glyph belongs to; the renderer locates it via the existing band-of-glyph map." Step 16 step 4 says `const band = ctx.renderer.bandOf(this);`. But no glyph→band reverse map exists today — [EffectBand.ts:17-18](packages/alphatab/src/rendering/EffectBand.ts#L17) stores `_uniqueEffectGlyphs: EffectGlyph[][]` and `_effectGlyphs: Map<number, EffectGlyph>[]` (per-voice maps from beat-index to glyph), but the reverse (glyph → band) is not maintained. The phrasing "existing band-of-glyph map" is misleading; the map needs to be built or replaced with another resolution strategy (the band stores the glyph during registration in `EffectBandContainer.createGlyph` paths — the simplest implementation is for the registration site to remember which band it pushed into).
- **Fix.** Step 16 scope should add an explicit bullet: "build the glyph→band reverse map at glyph-registration time in `EffectBandContainer.createGlyph` (or store the band on the glyph itself when it's created)." Alternatively, Step 16 can scan `renderer.topEffects.bands` and `renderer.bottomEffects.bands` for the one that contains `this` — O(bands) per cross-renderer glyph, acceptable. Either way the doc should not claim the map "exists" — it does not. This is implementable but the implementer reading "existing" will look for code that isn't there.

## Minor findings

### Min1. §H Step 0 grep count is still wrong after the v4-review §Min7 rewording

- **Where.** §H Step 0: "in `MultiVoiceContainerGlyph.ts`, `_scaleToForce(` appears exactly 2 lines — one call site and one method declaration."
- **Why.** Today the file has 3 `_scaleToForce(` occurrences: declaration at [MultiVoiceContainerGlyph.ts:61](packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts#L61), a call from `scaleToWidth` at :58, and the per-voice-loop call at :165. Step 0 hoists the :165 call outside the per-voice loop (still in `applyLayoutingInfo`), but :58's `scaleToWidth → _scaleToForce` path is untouched. Post-Step-0 the count is 3, not 2 (declaration + two distinct call sites). v4-review §Min7 caught the wrong "per file" claim; v5 fixed the file-targeting but not the count.
- **Fix.** Reword to "in `MultiVoiceContainerGlyph.ts`, `_scaleToForce(` appears exactly 3 lines — one method declaration and two call sites (in `scaleToWidth` and `applyLayoutingInfo`, the latter hoisted outside the per-voice loop)." Or: pick a more specific invariant such as "no `_scaleToForce` call is reachable from inside a `for (... of this.beatGlyphs.values())` loop body" — that's the property Step 0 actually establishes.

### Min2. §D.8a doesn't enumerate the `accoladeWidth += systemLabelPaddingLeft/Right` pair at [StaffSystem.ts:653, :655](packages/alphatab/src/rendering/staves/StaffSystem.ts#L653)

- **Where.** §D.8a names three `+=` sites: [:687, :689, :690]. But the function body at [:653, :655](packages/alphatab/src/rendering/staves/StaffSystem.ts#L653) also has `this.accoladeWidth += systemLabelPaddingLeft` and `this.accoladeWidth += systemLabelPaddingRight` (conditional).
- **Why it's minor.** These two `+=` ARE safe under idempotent recompute because `accoladeWidth` is reset to 0 at function entry (line :589), so the padding accumulates the running computation within a single call — they're not cross-call accumulators. v5's recipe step 3 (reset `accoladeWidth = 0` at entry) already handles this implicitly.
- **Fix.** §D.8a could add one sentence: "The `+= systemLabelPaddingLeft/Right` pair at [:653, :655] accumulates *within* a single invocation onto the freshly-zeroed `accoladeWidth`; it is not a cross-call accumulator and does not need rewriting." Reader confidence only.

### Min3. `_calculateAccoladeSpacing` needs `tracks` on the revert path; v5 doesn't address the parameter threading

- **Where.** §E Step 1c step 5: "Call `_calculateAccoladeSpacing(tracks)` at CoordinateAssemble close on every `addBars` AND on every `revertLastBar`."
- **Why.** [StaffSystem.revertLastBar:497-543](packages/alphatab/src/rendering/staves/StaffSystem.ts#L497) takes no `tracks` parameter. Either the signature must change (propagate from callers at [VerticalLayoutBase.ts:509, :513, :324](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L509)), or `revertLastBar` fetches tracks from `this.layout.renderer.tracks!`. Both are trivial; v5 should pick one.
- **Fix.** One-line note in Step 1c: "use `this.layout.renderer.tracks!` inside `revertLastBar` for the recompute call."

## Items v5 missed

### M13. Per-system `_contentHeight`, `isFull`, `isLast` are not in `SystemLayoutCycle`

[StaffSystem.ts:161 (`_contentHeight`), :179 (`isFull`), :250 (`isLast`)](packages/alphatab/src/rendering/staves/StaffSystem.ts#L161) are per-cycle fields that v5's 9-field SystemLayoutCycle enumeration misses. `_contentHeight` is set at finalize ([:1113](packages/alphatab/src/rendering/staves/StaffSystem.ts#L1113)) and read at paint via the height getter ([:753](packages/alphatab/src/rendering/staves/StaffSystem.ts#L753)); `isFull` is set during system close in `VerticalLayoutBase`; `isLast` flips at the last system. None of these are routinely mutated by `addBars` or `revertLastBar`, so the omission is not load-bearing for resize rollback — but the §J §S4 closure ("nine per-system fields") reads as exhaustive when it isn't.

**Fix.** Either expand the SystemLayoutCycle list to 12 with a note that the last three are "set-once-at-system-close" rather than per-bar accumulators, or add a one-line note in §E Step 11 acknowledging the omission and arguing why these three don't need substate reassign.

## Verification of v5's §J sign-off checklist

| v4-review item | v5 claim | Actually addressed? | Evidence |
| --- | --- | --- | --- |
| C1 — `system.width += accoladeWidth` accumulation | §D.8a 5-step recipe + §E Step 1c 5 concrete edits + §H Step 1c sentinel | **Yes** | §D.8a lines 583-595 of v5 spell out unwind+reapply; §E Step 1c §"Scope (the load-bearing detail per §D.8a)" enumerates the rewrites at [:687, :689, :690]; §H Step 1c sentinel "drive 5 addBars and assert `system.width` matches single-call baseline" is mechanically verifiable. |
| C2 — `populateSkyline?` signature vs Step 16 write target | §D.3 drops `target`, Step 16 uses `publishSpanRange` | **Yes** (with the §D.7 leftover flagged in S1) | §D.3 lines 373-389 and dispatcher pseudocode at 395-409 use single-arg `populateSkyline(ctx)`. Step 16 lines 847-857 spell out `EffectBand.publishSpanRange`. The §D.7 inconsistency is doc-level only and doesn't undo the closure. |
| S3 — `version++` from `finish()` also | §B.19 + §H Step 8a both list 2 post-step sites | **Yes** | §B.19 lines 132 enumerates three sites including [:261]; §H Step 8a invariant explicitly says "exactly 2 occurrences (in `finish` and `recomputeSpringConstants`)". Verifiable against [BarLayoutingInfo.ts:136, :261, :277](packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts#L136). |
| S4 — `SystemLayoutCycle` tier | §E Step 11 third tier with 9 fields | **Yes** (with M13 caveat) | §E Step 11 lines 767-777 enumerate `width`/`computedWidth`/`totalFixedOverhead`/`totalContentWidth`/`totalBarDisplayScale`/`accoladeWidth`/`firstVisibleStaff`/`minDuration`/`isMinDurationDirty` with file:line citations; §D.8 revert rollback table at lines 537-549 maps each to a substate mechanism; §H Step 11 invariant cites the [:288](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L288) sentinel-line replacement. |
| S5 — `renderer.y` Phase-2 write row | §D.2 row reflects [VerticalLayoutBase.ts:462](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L462) | **Yes** | §D.2 row reads "provisional: written by Phase-2 driver to `s.topPadding + s.topOverflow`; Step 13 retires this write." |
| S6 — Step 1a no-op | Folded into Step 1c | **Yes** | §E Step 1 explicitly drops the 1a sub-step; §D.8a §"Step 1c also subsumes v4's Step 1a" justifies; DAG updated; §J §S6 row substantive. |
| Min7 — §H Step 0 grep wrong | §H Step 0 reworded | **Partial** | The "per file" claim is fixed but the "exactly 2 lines" count still misses the [MultiVoiceContainerGlyph.ts:58](packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts#L58) call site. See Min1 above. |
| Min8 — `_sharedLayoutData` Phase-1 read/write | §D.2 row updated | **Yes** | §D.2 row at line 335 marks "read by `EffectBandContainer.alignGlyphs` if invoked; pre-Step-5 this fires in Phase 1" and Phase-2 "written by `onAlignGlyphs` in the single `alignGlyphs` call". |
| Min9 — §H Step 13 grep | Reframed as method-body bounded grep | **Yes** | §H Step 13 invariant at line 984 bounds the grep by `spacedLayout()` method body; pre-step equivalent stated. |
| M11 — `BarLayoutingInfo` owner | §A.2 / §B.16 / §D.4 / §G.1 / appendix all align | **Yes** | Multiple sections cite [MasterBarsRenderers.ts:39](packages/alphatab/src/rendering/staves/MasterBarsRenderers.ts#L39); appendix line 1110 explicitly names `MasterBarsRenderers` as owner. |
| M12 — `EffectBand.finalizeBand` | §B.32 + §D.2 row for `EffectBand.height` | **Yes** | §B.32 lines 173-174 document the sub-step (iv) mutation with [EffectSystemPlacement.ts:78-83](packages/alphatab/src/rendering/EffectSystemPlacement.ts#L78); §D.2 row at line 336 marks "final after `finalizeBand` loop in sub-step (iv)". |

## Sign-off conditions for v6 (if any)

**None blocking — proceed to implementation.** The two Significant findings (S1, S2) are inline fixes during Step 3 / Step 16 implementation:

1. **S1 (§D.7 stale signature).** When the implementer codes Step 13, treat §D.3's single-arg signature as authoritative; the §D.7 line 492 two-arg invocation is a leftover from v4. A future copy-edit pass can fix the doc; the implementation contract is unambiguous after reading §D.3.
2. **S2 (`bandOf` map doesn't exist).** Step 16 must construct the glyph→band map (or pick another resolution strategy) as part of its implementation. The simplest mechanism is to store the band reference on `GroupedEffectGlyph` at the time `EffectBandContainer.createGlyph` registers it; the existing registration paths at [EffectBand.ts:141, :168](packages/alphatab/src/rendering/EffectBand.ts#L141) are the place. Document this in the Step 16 PR description.

The Minor findings (Min1-Min3) and missed item (M13) are doc-level polish; address them when next touching v5 or in PR descriptions, not in a v6 review cycle.

The macro architecture (5 phases + 4-substep SystemFinalize + 2-step Coordinate), the DAG, the §B inventory, the §D.2 phase contract table, and the §H invariants are all sound. v5 has converged. Ship it.

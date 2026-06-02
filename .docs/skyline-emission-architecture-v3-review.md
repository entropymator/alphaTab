# Skyline emission architecture v3 — review

## Verdict

**Ready after fixing the five Critical findings below.** v3 is a substantive improvement on v2: the Coordinate two-step is the right answer to the late-arriving-minDuration problem, the §J sign-off table is honest about most of v2's conditions, and the §D.2 immutability table is the single most useful artifact in the whole series. But v3 still ships with at least three load-bearing mis-statements about the actual code (Critical #1, #2, #5), one phase-contract row that contradicts code that v3 doesn't propose to move (Critical #3), and a missing step in the migration that v3 doesn't acknowledge (Critical #4). These are not nitpicks — Critical #1 in particular means a reader of v3's §D.2 will design the wrong APIs for Phase 2/Phase 3.

The §J checklist also overstates closure on conditions 4, 7, and 10: each is "named in v3" but the substantive content (Step 1's accolade interaction, Step 16's `populateSkyline?` cross-renderer mechanism, the §D.6 seal-vs-post-tie-finalize sub-phase) is hand-waved. v4 needs ~5 fixes, not a rewrite.

## What v3 fixed cleanly from v2

- §D.2 immutability table is a real artifact: a reader can now point at a field and a phase and know what's legal.
- Critical 1 (single Spaced phase): Step 0 hoist is correct mechanically and the byte-identical-PNG argument in `scale-to-force-multi-call.md` is sound; the fix is one method.
- Critical 2 (version cookie): Step 8a/8b split is the right shape; pinning cookie deletion to 8b is correct.
- Critical 3 (tie writes contradict seal): §D.6's choice (a) is the right call — preserving per-bar writes preserves the `EffectSystemPlacement.placeAndApply` per-renderer attribution mechanic.
- §D.6 explicitly preserves the before/after `contentTop`/`contentBottom` sampling as attribution mechanic, retiring only `needsSecondPass`. Closes review §6 substantively.
- §D.5 Route B is the correct architectural call: it kills the C-1 anti-pattern at the beam cache instead of papering over it.
- B.9b, B.19–B.25, and C-6 are real additions to the inventory; the file:line claims for each spot-check correctly against code.
- The dependency-graph DAG and parallelizable clusters retire v2's linear-list confusion.

## Critical findings

### 1. The §D.2 phase contract for `barLocalSkyline` does not match v3's own Step 13 or current code

- **Where in v3.** §D.2 table row `barLocalSkyline, preBeatLocalSkyline, postBeatLocalSkyline`: `(reset only)` through Phase 2, `emitted, final` after Phase 3. §D.7 reinforces: "Skyline emission is one point, end of Phase 3."
- **The claim.** Phase 2 only resets bar-local skylines; emission is end of Phase 3.
- **Why it's wrong.** Today's `scaleToWidth` ([BarRendererBase.ts:357](packages/alphatab/src/rendering/BarRendererBase.ts#L357)) resets `barLocalSkyline` AND emits into it via the per-beat callback at [:373-403](packages/alphatab/src/rendering/BarRendererBase.ts#L373) (beat container overflow, pending beat effects, `emitBeatSkyline`), the beam-helper loop at [:405-410](packages/alphatab/src/rendering/BarRendererBase.ts#L405), `_emitDynamicSkylineGlyphs` at [:418](packages/alphatab/src/rendering/BarRendererBase.ts#L418), and `emitSubclassBarLocalSkyline` at [:419](packages/alphatab/src/rendering/BarRendererBase.ts#L419). v3 lists `BarRendererBase.scaleToWidth body` → Phase 2 in §D.9, and lists `finalizeRenderer` → Phase 3. So v3 places the existing skyline-emission code into Phase 2 *by way of `scaleToWidth → Phase 2`* — and then claims in §D.2 / §D.7 that Phase 2 only resets and Phase 3 emits. The two statements directly contradict each other.
- **file:line evidence.** [BarRendererBase.ts:357](packages/alphatab/src/rendering/BarRendererBase.ts#L357), [:373-403](packages/alphatab/src/rendering/BarRendererBase.ts#L373), [:405-410](packages/alphatab/src/rendering/BarRendererBase.ts#L405), [:418-419](packages/alphatab/src/rendering/BarRendererBase.ts#L418); v3 §D.2 row 12 vs §D.9 row "scaleToWidth body".
- **Impact if shipped.** Step 13's "rewrite into intrinsicLayout/spacedLayout/finalize" splits `scaleToWidth` body across two phases without a documented contract for *which lines move where*. A reader implementing Step 13 will either (a) leave emission in Phase 2 and call §D.2 wrong, or (b) move emission to Phase 3 and silently break the `barLocalSkyline.reset() + emit` ordering invariant that today protects against accumulation across multiple `scaleToWidth` invocations on resize.
- **Fix.** §D.9 must split `scaleToWidth body` into two rows: "compute positions (preBeat/postBeat x, voiceContainer.x, beam drawingInfos) → Phase 2" and "emit barLocalSkyline (per-beat skyline, beam-helper skyline, subclass emit, dynamic-glyph emit) → Phase 3." Then §D.2 row 12 is consistent. Add a §H invariant: Phase 2 leaves `barLocalSkyline` empty/reset; only Phase 3 inserts.

### 2. The §J sign-off for Critical 4 (Step 10 prereqs) says "corrected to {1, 8, 11}", but Step 10's prereq is the substate-discard pattern, not just Step 11 — and v3 doesn't deliver that pattern as a contract Step 10 can rely on

- **Where in v3.** §J row 4, §E Step 10's "Prereq (CORRECTED): Steps 1, 8, 11", §E Step 11's scope list.
- **The claim.** Step 10 retires `wasFirstOfStaff`/`recreatePreBeatGlyphs` because Step 11 has lifted the substate concept; on resize, pre-beat glyphs live in the discardable substate and `isFirstOfStaff` is re-evaluated cleanly.
- **Why it's incomplete.** Step 11's scope list at §E Step 11 enumerates the per-renderer fields it lifts (`_barLocalSkyline`, `_preBeatLocalSkyline`, `_postBeatLocalSkyline`, `_pendingBeatEffectsByBeat`, `_ties`, `_dynamicSkylineGlyphs`, `_contentTopOverflow`, `_contentBottomOverflow`, `_appliedLayoutingInfo`, `beatEffectsMinY`, `beatEffectsMaxY`). It does NOT include `_preBeatGlyphs`. But `_preBeatGlyphs` ([BarRendererBase.ts:91](packages/alphatab/src/rendering/BarRendererBase.ts#L91)) is precisely the field Step 10 needs to discard-and-recreate. v3 review §Critical 4 explicitly said "discard the pre-beat glyphs and rebuild them with the current `isFirstOfStaff`," and v3 acknowledges this in the prereq correction — but Step 11's scope doesn't include the pre-beat group glyphs. The current `recreatePreBeatGlyphs` ([BarRendererBase.ts:983-994](packages/alphatab/src/rendering/BarRendererBase.ts#L983)) does `this._preBeatGlyphs = new LeftToRightLayoutingGlyphGroup()` — i.e., reassigns. For Step 10 to use Step 11's substate, that group has to live inside the substate object.
- **file:line evidence.** [BarRendererBase.ts:91](packages/alphatab/src/rendering/BarRendererBase.ts#L91), [:983-994](packages/alphatab/src/rendering/BarRendererBase.ts#L983); v3 §E Step 11 scope list omits `_preBeatGlyphs`; §E Step 10 description omits the substate field it requires.
- **Impact if shipped.** Step 10 lands without `_preBeatGlyphs` being part of the substate; it falls back to the same wholesale-reassignment pattern as today, and the "no per-renderer flag" invariant in §H row 10 is not achieved. Worse, `_postBeatGlyphs`, `voiceContainer`, and `helpers` are also outside Step 11's scope yet are all created at construction time — if Phase 1 is a no-op on resize (per §F.2), these must survive resize, which means the substate boundary is "ephemeral state only" — but that contradicts Step 10 needing pre-beat glyphs to be discardable.
- **Fix.** Either (a) add `_preBeatGlyphs` to Step 11's scope explicitly, with a note that it's discarded only when `isFirstOfStaff` actually changes (so non-discarding resize paths are still cheap); or (b) add a sub-step 10a "introduce per-cycle pre-beat group container that lives in the LayoutCycle substate" with a precise contract for when it discards. Without one of these, Step 10's prereq chain is a name-drop, not a real dependency.

### 3. Step 12 keeps the seal lie: §D.2 says `barLocalSkyline` is "final" after Phase 3, but `_finalizeTies` writes into other renderers' bar-local skylines at SystemFinalize

- **Where in v3.** §D.2 row 12 (`barLocalSkyline ... emitted, final` after Phase 3), §D.6 ("v3 chooses (a). ... `_finalizeTies` runs after every renderer's Phase 3 has finished"), §F.4 same choice. §D.2's same row also has a final-column note "(final; system also receives tie writes)" for SystemFinalize.
- **The claim.** Bar-local skyline is final after Phase 3 except for cross-renderer tie writes that arrive at SystemFinalize. v3 frames this as a documented exception, not a contradiction.
- **Why it's a problem.** The §D.2 row's "Phase 3: final" cell is what every Step-13 implementer will read. The footnote in the SystemFinalize column ("system also receives tie writes") is in the same row but encodes the opposite contract for one specific writer. That's not "final after Phase 3" — that's "final after Phase 3 except for cross-renderer ties." `placeAndApply` reads `sky.upSky.maxHeightInRange(r.x, r.x + r.width)` after `_unionBarLocalIntoStaffSkyline` ([RenderStaff.ts:236-249](packages/alphatab/src/rendering/staves/RenderStaff.ts#L236), [EffectSystemPlacement.ts:63-64](packages/alphatab/src/rendering/EffectSystemPlacement.ts#L63)) — meaning the staff skyline must include tie writes by the time placement runs. Step 12 says ties run "after every renderer's Phase 3 has finished" but `placeAndApply` is already in SystemFinalize. Order matters: ties must run before `_unionBarLocalIntoStaffSkyline + placeAndApply`, but after each renderer's `finalizeRenderer` (which today is where `_finalizeTies` lives). v3 doesn't pin the relative order inside SystemFinalize.
- **file:line evidence.** [RenderStaff.ts:308-355](packages/alphatab/src/rendering/staves/RenderStaff.ts#L308) — current `finalizeStaff` calls `renderer.finalizeRenderer()` (which calls `_finalizeTies`), THEN `_unionBarLocalIntoStaffSkyline(renderer)`, THEN `placeAndApply`. So today ties are written before placement queries. v3 Step 12 moves `_finalizeTies` "to SystemFinalize" but doesn't say whether it runs before or after `_unionBarLocalIntoStaffSkyline`.
- **Impact if shipped.** Step 12 implementer reads "ties hoist to SystemFinalize" and puts them after `placeAndApply` (the most natural reading of "after every renderer's Phase 3"). Result: ties' contribution doesn't feed effect-band placement attribution. Multi-bar tied-note arcs that overflow above the staff cause `topEffects.height` mis-attribution — exactly the failure mode v2 Critical 3 warned about.
- **Fix.** §D.2 row 12 split into two cells: "barLocalSkyline content (non-tie) → emitted, final after Phase 3"; "barLocalSkyline tie-overlay writes → final after SystemFinalize pre-placement sub-phase." §D.6 / Step 12 needs an explicit ordering contract for SystemFinalize: (i) `finalizeRenderer` minus tie writes, then (ii) tie writes per renderer (touching this renderer + spanned renderers' bar-local skylines), then (iii) `_unionBarLocalIntoStaffSkyline` per renderer, then (iv) `placeAndApply`. Today's order partly matches this; v3 must spell it out so Step 12 doesn't accidentally invert (ii) and (iv).

### 4. Step 1 ("pre-pass `firstVisibleStaff` from model") is incompatible with `_calculateAccoladeSpacing` running on the *first* `addBars` call

- **Where in v3.** §E Step 1, §B.23 ("Step 1's pre-pass restructuring can destabilize this — Step 1 includes an explicit invariant for accolade height"), §J row 9.
- **The claim.** Pre-pass the model to settle `firstVisibleStaff` before any renderer doLayout, with an "explicit invariant for accolade height."
- **Why it's wrong.** `_calculateAccoladeSpacing` is called from inside `addBars` at [StaffSystem.ts:397](packages/alphatab/src/rendering/staves/StaffSystem.ts#L397) and from `addMasterBarRenderers` at [:323](packages/alphatab/src/rendering/staves/StaffSystem.ts#L323), gated by `_accoladeSpacingCalculated` ([StaffSystem.ts:586](packages/alphatab/src/rendering/staves/StaffSystem.ts#L586)). It runs on the *first* `addBars` call — when only one bar has been seen — and calls `staff.calculateHeightForAccolade()` ([StaffSystem.ts:676](packages/alphatab/src/rendering/staves/StaffSystem.ts#L676)) which reads `this.barRenderers[0].height`. The accolade height contract is "first bar's intrinsic height ≈ system height" — and the model-only pre-pass for `firstVisibleStaff` is decided per-master-bar against a set of master bars that hasn't been determined yet (the system only knows which bars fit after `_fitSystem` runs at line break time). The "pre-pass" in Step 1 can compute model-level `isVisible` per staff for a *given* set of bars, but the set of bars in the system isn't known until system close. v3 §J row 9 names `VisualTests.GhostStaffVisibility` as the test but doesn't describe how the pre-pass interacts with the iterative `addBars` → `revertLastBar` loop in `_createStaffSystem` ([VerticalLayoutBase.ts:476-534](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L476)).
- **file:line evidence.** [StaffSystem.ts:397](packages/alphatab/src/rendering/staves/StaffSystem.ts#L397), [:586-690](packages/alphatab/src/rendering/staves/StaffSystem.ts#L586), [RenderStaff.ts:290-298](packages/alphatab/src/rendering/staves/RenderStaff.ts#L290); [VerticalLayoutBase.ts:476-534](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L476) for the revert loop.
- **Impact if shipped.** Step 1 lands as "model-pre-pass at score level" but the per-system `firstVisibleStaff` decision needs to incorporate which bars survived `revertLastBar`. After `revertLastBar`, the system has fewer bars, and the `_emptyBarCount` per staff is decremented — so visibility may flip. If Step 1's pre-pass is computed once score-globally, it gets the post-fit visibility wrong for systems with reverts. v3's §J names a test (`GhostStaffVisibility`) but doesn't specify the pre-pass scope. Worse: `_calculateAccoladeSpacing` is `_accoladeSpacingCalculated`-gated, so even if a revert flips visibility, the accolade was already sized against the wrong assumption.
- **Fix.** §E Step 1 needs three explicit deliverables: (a) the pre-pass scope (per-system, recomputed on every `addBars` and `revertLastBar`); (b) the accolade-spacing relationship — either reset `_accoladeSpacingCalculated` on revert, or move accolade sizing to a CoordinateAssemble sub-step that runs after each `addBars`; (c) what `RenderStaff.calculateHeightForAccolade` reads when `firstVisibleStaff` is now known model-only but `barRenderers[0].height` is still incremental. The "explicit invariant for accolade height" promise in §B.23 needs to be a numbered sub-step with a contract, not a wave.

### 5. The §B.25 mechanism description for `GroupedEffectGlyph.getBoundingBoxRight` is wrong

- **Where in v3.** §B.25 ("`GroupedEffectGlyph.getBoundingBoxRight` → `renderer.getBeatX(endBeat, endPosition)`. For Span-category effects that cross a renderer, `endBeat` lives in a different renderer's voiceContainer and `getBeatX` returns 0"), §D.6 closing paragraph, Step 16 scope.
- **The claim.** `getBoundingBoxRight` reads `endBeat` from a foreign renderer, which returns 0, hence `computeLocalXRange` under-reports.
- **Why it's wrong.** `GroupedEffectGlyph.getBoundingBoxRight` ([GroupedEffectGlyph.ts:20-25](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L20)) reads `this.renderer.getBeatX(this.beat, this.endPosition)` — `this.beat` is the *start* beat (this glyph's own beat), on `this.renderer`. It does NOT read `endBeat`. The actual under-reporting mechanism is different: the bbox-right returns the start beat's end-position-x (probably `BeatXPosition.EndBeat` or similar), not the *linked-chain's last glyph's* end-X. The painted end-X is computed in `paint`/`calculateEndX` ([:69-79](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L69)) by walking `nextGlyph` chain to the last linked glyph, then using `endBeatRenderer.x + endBeatRenderer.getBeatX(endBeat, endPosition)`. So the right mechanism is "bbox uses local start-beat end-x; paint uses staff-absolute last-linked-renderer end-x." v3 has the symptom right and the file right but mis-describes the mechanism.
- **file:line evidence.** [GroupedEffectGlyph.ts:20-25, :60-79](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L20).
- **Impact if shipped.** Step 16 ("the cross-renderer end-X for Span-category effects is computed at this point via the populated linked-glyph chain — `GroupedEffectGlyph.populateSkyline?` walks to the end renderer to get the real end-X") proposes a fix based on the wrong mechanism. The fix happens to work for the actual bug (walk the chain at SystemFinalize), but the §B.25 mis-description means whoever implements Step 16 will look for an `endBeat` field on `GroupedEffectGlyph` (there isn't one — the linked-chain `nextGlyph` is the end discovery mechanism) and waste time. The §D.6 "populateSkyline? on GroupedEffectGlyph: at SystemFinalize time, the glyph knows the staff's full renderer chain and can compute its true end-X" is also imprecise about which API is used — `nextGlyph` traversal, `isLinkedWithNext`, etc.
- **Fix.** Rewrite §B.25 to: "`GroupedEffectGlyph.getBoundingBoxRight` returns `this.renderer.getBeatX(this.beat, this.endPosition)` — the START-beat's end-x in the local renderer. For Span-category effects linked across renderers, the painted end-X (computed in `calculateEndX` by walking `nextGlyph` to the last linked glyph) is further right than the bbox-right. `computeLocalXRange` only sees the local extent, so cross-renderer span effects under-report by (end-renderer end-X − start-renderer start-X − start-renderer.width)." Step 16 should reference the `nextGlyph`/`isLinkedWithNext` API as the traversal mechanism.

## Significant findings

### 6. Step 3 / `populateSkyline?` lifecycle is under-specified

§D.3 declares the hook stays, signs it as `(target: BarLocalSkyline | StaffSystemSkyline, renderer: BarRendererBase)`, and §D.7's pseudocode invokes it inside `BarRendererBase.finalize()` against `barLocalSkyline`. But §D.6 also says GroupedEffectGlyph uses `populateSkyline?` "at SystemFinalize time" against the system skyline. These are two different lifecycles with one hook name. v3 needs to say: hook fires once per phase per glyph, OR hook is dispatched twice (Phase 3 with `BarLocalSkyline`, SystemFinalize with `StaffSystemSkyline`). Currently §D.7 only fires it from `finalize()` (Phase 3); a Step 16-era GroupedEffectGlyph would need a second invocation point that §D.7 doesn't show.

Fix: §D.3 needs two hooks or one hook with a phase enum. §E Step 16 should add the SystemFinalize invocation point explicitly.

### 7. The "BarTempoGlyph stays on `populateSkyline?`" justification doesn't survive Step 9

§D.3 names BarTempoGlyph as a legitimate hook user because its bbox depends on `getRatioPositionX` ([BarTempoGlyph.ts:59, :75](packages/alphatab/src/rendering/glyphs/BarTempoGlyph.ts#L59)) which uses `voiceContainer.x` and `_postBeatGlyphs.x`. But Step 9 single-writes `_postBeatGlyphs.x` at end of Phase 2 ([§H row 9](../skyline-emission-architecture-v3.md)). After Step 9, the bbox IS stable from end of Phase 2 — meaning BarTempoGlyph's case is no longer "legitimately late." §D.3 says hook stays for BarTempoGlyph as the canonical example; that's only true if Phase 3 hook = Phase 2's bbox. So either BarTempoGlyph drops the hook in Step 9 (and only GroupedEffectGlyph's cross-renderer case remains), or §D.3's justification is post-hoc.

Fix: §H Step 9 invariant should explicitly state "BarTempoGlyph bbox is stable after Phase 2; hook usage retires in Step 9" — leaving GroupedEffectGlyph as the sole non-trivial hook user, gated on Step 16.

### 8. The "byte-identical PNGs" assertion for Step 0 has one untested subclass surface

`scale-to-force-multi-call.md` §3 walks every `BeatContainerGlyphBase.applyLayoutingInfo` subclass override (`BeatContainerGlyph`, `MultiBarRestBeatContainerGlyph`, `NumberedDashBeatContainerGlyph`) and confirms none touches `BarLayoutingInfo` or cross-voice state. But the investigation also notes ([§"Breakage risk"](../investigations/scale-to-force-multi-call.md)) that a custom subclass that mutates shared state would surface as a diff. v3 takes this as "low risk" without naming any acceptance gate beyond visual regression. There's no test that asserts the per-voice loop and the hoisted loop produce identical `_scaleToForce` inputs — just visual PNGs. If the visual fixtures happen not to exercise a corner case (e.g., a voice K whose `applyLayoutingInfo` somehow grows voice K-1's beat width), the regression slips through.

Fix: add a unit test for `MultiVoiceContainerGlyph.applyLayoutingInfo` that captures positions per-voice before and after the hoist and asserts equality. ~50 lines of test, deterministic.

### 9. v3 says `BeamingHelper.alignWithBeats` is "in practice a `drawingInfos.clear()`" — but the load-bearing effect on Route B differs from Route A

§B.11 reframes `alignWithBeats` as "in practice a `drawingInfos.clear()`," and Route B "deletes `alignWithBeats` entirely along with the loop." Fine. But Route B also says paint reads `drawingInfos` direct (`ensureBeamDrawingInfo` DELETED in callers per §D.13 table). Today's `paintBar` at [LineBarRenderer.ts:635](packages/alphatab/src/rendering/LineBarRenderer.ts#L635) reaches `calculateBeamYWithDirection` → `ensureBeamDrawingInfo` ([LineBarRenderer.ts:215](packages/alphatab/src/rendering/LineBarRenderer.ts#L215)). `paintTuplets` at [:299-302](packages/alphatab/src/rendering/LineBarRenderer.ts#L299) does the same with `tupletDirection`. If paint must populate the tuplet-direction entry only when it differs from the canonical direction — and Phase 2 pre-populates both eagerly — then paint never needs `ensureBeamDrawingInfo`. But the pre-population must happen at Phase 2 entry for every helper, including the tuplet-direction case, and the predicate is `getTupletBeamDirection(h) !== getBeamDirection(h)`. §D.5 mentions this; §D.13's table row says "eagerly populate both directions when needed" but doesn't specify the predicate.

Fix: §D.5 pseudocode for the Phase 2 eager-populate path needs to be in the doc — specifically that the populate is guarded by `getTupletBeamDirection !== getBeamDirection` to avoid the cost of pointlessly populating an identical direction.

### 10. §D.8 resize "Phase 1 is a no-op" doesn't address `_appliedLayoutingInfo` carry-over

§F.2 / §D.8: resize = same code path, Phase 1 is no-op'd. §H Step 11's invariant: per-cycle substate atomically reassigned. But `_appliedLayoutingInfo` is in Step 11's scope list — meaning the substate reassign zeros it. On a resize that doesn't actually change spring constants, the version cookie's protection (post-8b deletion is fine, pre-8b it matters) gets bypassed. If Step 11 lands before Step 8b — which the DAG allows (Cluster δ includes Step 11 but 8a/8b are in Cluster γ before it) — then Step 11 effectively forces re-application of `applyLayoutingInfo` on resize even when the info is unchanged. That's the "value-idempotent so no harm" case per `reconcile-min-duration.md` §3, but it's a perf regression to re-run on every renderer for every resize.

Fix: explicitly sequence Step 11 *after* Step 8b in the DAG, OR document that Step 11 preserves `_appliedLayoutingInfo` across cycles when the substate is being "re-used" rather than discarded. v3 §H row 11 says "no manual reset list survives" but doesn't engage with the perf consequence.

### 11. Step 5 audit deliverables are vague

§E Step 5 lists 5a/5b/5c sub-steps but does not name the deliverable for 5a. The review v2 §8 said: "confirm `onAlignGlyphs` is idempotent across removed call sites; confirm the reset of `_sharedLayoutData` happens at the right point." v3 5a says "audit `onAlignGlyphs` for max-of semantics — currently true for whammy" — that's the audit *result*, not the *audit deliverable*. If there are other `EffectInfo.onAlignGlyphs` implementations, are they each max-of? v3 doesn't enumerate.

Fix: Step 5a deliverable = "list every `EffectInfo.onAlignGlyphs` implementation, classify as max-of-idempotent or stateful." Today the only stateful one is `TabWhammyEffectInfo`; confirm no others.

### 12. §I (significant findings disposition) for §13–§18 minor findings is hand-waved

§I closes review §6-§12 individually but rolls "Review §13–§18 (Minor): all folded into §B inventory entries or §G research backlog" into one line. Minor 14 specifically (the §F.5 / `GroupedEffectGlyph` cross-renderer end-X) is named as B.25 + Step 16 — fine. But Minor 13 (`_appliedLayoutingInfo` rate-as-cache wording), Minor 15 (alignGlyphs count error), Minor 16 (cookie-mismatch framing), Minor 17 (`additionalMultiBarsRestBars`), Minor 18 (v1 dismissal) are not individually mapped. §I is supposed to be the traceability matrix; rolling 6 items into "all folded" defeats the purpose.

Fix: extend §I table with rows for §13–§18, each pointing to the §B entry or §G item that addresses it. Even a one-line row per minor.

## Minor findings

### 13. §A.1 table row for `alignGlyphs` says "(#4 on resize)" but doesn't say where v3's claimed-single call site lives

The table row reads "called (#1) | called (#2) | called (#3); also called from `reLayout` (#4 on resize)." Step 5's goal is one call. The single-call placement isn't specified — Phase 2 end? Phase 3 entry? Today `topEffects.alignGlyphs` is called in `doLayout` ([:697](packages/alphatab/src/rendering/BarRendererBase.ts#L697)), `applyLayoutingInfo` ([:546](packages/alphatab/src/rendering/BarRendererBase.ts#L546)), `scaleToWidth` ([:415](packages/alphatab/src/rendering/BarRendererBase.ts#L415)), `reLayout` ([:968](packages/alphatab/src/rendering/BarRendererBase.ts#L968)). §H row 5 says "`onAlignGlyphs` runs exactly once per cycle" — but Phase 2's eager-populate of beam drawingInfos happens *before* `scaleToWidth`'s emit (today: scaleToWidth body); is alignGlyphs after positions are sealed or before? Spell out.

### 14. `B.9` reset list says `_appliedLayoutingInfo` survives revert — that's true today but Step 11 will eventually subsume it; reset table is misleading

v3 lists `_appliedLayoutingInfo` in B.9's "silently surviving" list. Step 11 puts it in substate. Step 8b deletes it. The B.9 list is a snapshot; it should be annotated "retired in Step 8b" to avoid v4 readers wondering if it persists.

### 15. §D.4's "perf-only confirmed" claim oversimplifies `reconcile-min-duration.md` §5

`reconcile-min-duration.md` §5 says: with the guard removed, the loop "becomes correct but wasteful." That's "the guard is perf-only" only after the "should I re-apply" predicate has been moved into the reconcile loop. v3 §D.4 packages this correctly into Step 8b — but the §D.4 prose says "perf-only, confirmed" without the precondition. A casual reader sees "perf-only, delete" and skips Step 8b's predicate-hoist.

### 16. The §H invariants for Step 13 ("three-phase contract holds") and Step 17 ("drawingInfos populated exactly once") are mutually testable only if the §D.2 row 11 / 12 contradiction (Critical 1 above) is resolved

§H Step 13 row says "every state field is final after a single named phase." §D.2 row 12 says barLocalSkyline is final after Phase 3 except tie writes (SystemFinalize). That's two phases for one field. The "single named phase" promise is only literally true if the row's split per Critical 3 is implemented.

### 17. §J row 9 names test corpora as Step 1/10 gates but they don't exist today (per §G.5/G.6)

§J: "Revert+resize test corpus named — Step 1 (`GhostStaffVisibility`), Step 10 (`ResizeWrapPointPreBeat`)." §G.5/G.6 honestly say the tests don't exist and must be created. So §J row 9 is closed in *naming* the gate, not in *delivering* the corpus. v4 should clarify: gates are NEW test corpora authored as part of the Step, not pre-existing.

## Items v3 missed

### M1. `additionalMultiRestBars` is set by `addBar` before `doLayout` runs — but v3's Phase 1 contract says Phase 1 has no sibling reads

`renderer.additionalMultiRestBars` is set in `addBar` at [RenderStaff.ts:161](packages/alphatab/src/rendering/staves/RenderStaff.ts#L161) before `renderer.doLayout()` at [:165](packages/alphatab/src/rendering/staves/RenderStaff.ts#L165). Phase 1 reads it via `createBeatGlyphs` at [BarRendererBase.ts:903](packages/alphatab/src/rendering/BarRendererBase.ts#L903). This is fine today, but `additionalMultiRestBars` is set FROM the master-bar-rest-info computed at score layout time, by the *layout*, not the model — so it's a layout decision read in Phase 1. v3's §D.2 contract says Phase 1 "no reads of sibling renderers or staff state." `additionalMultiRestBars` is a staff-level layout decision; the contract needs to either categorize it as "input to Phase 1 set by Phase 0 / Build" or flag it as a controlled exception. §B doesn't list it.

### M2. `Bar.simileMark === SecondOfDouble` flip is in `doLayout` ([BarRendererBase.ts:686-688](packages/alphatab/src/rendering/BarRendererBase.ts#L686)) but v3 §B.21 says move to CoordinateAssemble — without retiring the doLayout-time write

§B.21 says "Decidable from the model alone — moves to CoordinateAssemble." Step 1 closes B.5 but doesn't explicitly close B.21. There's no step in §E that retires the `if (this.bar.simileMark === SimileMark.SecondOfDouble) { this.canWrap = false; }` line. v3 closes B.21 by gesture without a migration step. Add to Step 1 or split off.

### M3. `MultiBarRestGlyph` paint extent

`MultiBarRestBeatContainerGlyph` has `beatId === -1` (B.20, retired by Step 4). But the *paint extent* of multi-bar-rest spans many master bars worth of width — and that width is settled in `_scaleToForce` based on the synthetic container width. §D.2's voiceContainer / beat-container x rows don't differentiate multi-bar-rest from normal bars. If Step 4 inlines the pending-effect flush, the multi-bar-rest case still has no effects (today), but the bbox extent claims need to be re-stated.

### M4. `isLinkedToPrevious` renderer field — `addBars` reads it after `doLayout` runs

`renderer.isLinkedToPrevious` ([BarRendererBase.ts:240](packages/alphatab/src/rendering/BarRendererBase.ts#L240)) is set in Phase 1's `createBeatGlyphs` at [:914-916](packages/alphatab/src/rendering/BarRendererBase.ts#L914). It is read by `StaffSystem.addBars` at [:372-374](packages/alphatab/src/rendering/staves/StaffSystem.ts#L372) to set `result.isLinkedToPrevious`. v3 doesn't list this in §D.2; it's a Phase-1 output consumed by CoordinateAssemble. Add a row.

### M5. `computedWidth` vs `width` divergence

v3's §D.2 row 5 has both fields in one cell ("renderer.width, renderer.computedWidth"). But the resize path at [VerticalLayoutBase.ts:288](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L288) does `system.width = system.computedWidth` — i.e., computedWidth is the "natural" width and width is the "fitted" width. They diverge after `_scaleToWidth`. The §D.2 row needs them as separate rows: `computedWidth` final after CoordinateReconcile; `width` final after Phase 2 (it's the fitted-to-width result of `scaleToWidth`).

### M6. `MasterBarBounds` / `BarBounds` final-geometry recording

`buildBoundingsLookup` at [BarRendererBase.ts:875-892](packages/alphatab/src/rendering/BarRendererBase.ts#L875) records `x`, `y`, `width`, `height` into `MasterBarBounds`. It's called after SystemFinalize (paint time, from `paint`). v3's §D.2 doesn't include `MasterBarBounds` / `BarBounds`. These read final renderer geometry; their validity phase is "Paint" or "after SystemFinalize." Pin it down to prevent a future contributor reading bounds mid-cycle.

### M7. The `addBars`-`systemIsFull`-`revertLastBar` loop in `_createStaffSystem` is not a CoordinateAssemble step in v3's model

§D.1 has CoordinateAssemble run "per master bar" and CoordinateReconcile at system close. The `systemIsFull` check at [VerticalLayoutBase.ts:501-518](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L501) consumes per-bar widths (`system.width` updated incrementally by `_applyLayoutAndUpdateWidth`). If CoordinateAssemble owns the "publish width" step, then the systemFull check is a CoordinateAssemble output consumer. v3 mentions this in §G.2 (research backlog) but doesn't pin the contract for v3 itself. The `revertLastBar` path also re-fires CoordinateAssemble (B.5 / B.9b reset on revert) — but v3 §E Step 1 doesn't enumerate revert as a CoordinateAssemble trigger.

### M8. Multi-track scores — BarLayoutingInfo is per-master-bar; v3's broker seal holds across tracks but staff-level state doesn't

`BarLayoutingInfo` is owned by `MasterBarsRenderers` ([StaffSystem.ts:340](packages/alphatab/src/rendering/staves/StaffSystem.ts#L340)) — i.e., one per master bar, shared across tracks. v3's broker-seal contract holds. BUT `_sharedLayoutData` is per-`RenderStaff` ([RenderStaff.ts:24](packages/alphatab/src/rendering/staves/RenderStaff.ts#L24)), meaning each track has its own. v3 §C-6 lists `_sharedLayoutData` as staff-scoped, which is correct, but doesn't engage with the cross-track invariants: are there `_sharedLayoutData` entries that should be system-scoped because they describe master-bar-level layout (e.g., whammy offset for the *master bar*'s tab staff vs. the music staff)? Spot-check: `TabWhammyEffectInfo.onAlignGlyphs` writes to a tab-staff-specific entry. So it's correctly staff-scoped today. No bug, but the invariant deserves an explicit "per-staff broker is OK because no cross-track-staff effect exists" note in §C-6.

### M9. The §D.6 "(a) chosen" decision doesn't seal the placement-vs-tie ordering inside `placeAndApply`

Today `placeAndApply` does: (1) sample `contentTop`/`contentBottom` per renderer (line 63-64), (2) iterate bands, (3) re-sample post-placement. Ties have already written into `barLocalSkyline` *before* this method runs because `_finalizeTies` is called from `finalizeRenderer` ([BarRendererBase.ts:647](packages/alphatab/src/rendering/BarRendererBase.ts#L647)), which runs before `_unionBarLocalIntoStaffSkyline` ([RenderStaff.ts:320-324](packages/alphatab/src/rendering/staves/RenderStaff.ts#L320)). v3 §D.6 says ties hoist to SystemFinalize but preserves the inner sampling. The new order needs to be: (1) all renderers finalize (without tie writes), (2) all ties run (write into bar-local skylines), (3) union into staff skyline, (4) `placeAndApply`. Step 12 doesn't spell this out. (Same as Critical 3 — flagged twice because it's worth emphasizing the sub-step ordering is the load-bearing contract here.)

### M10. `isFinalized` flag survives across cycles unless `afterReverted` resets it

[BarRendererBase.ts:512-516](packages/alphatab/src/rendering/BarRendererBase.ts#L512) resets `isFinalized = false` in `afterReverted`. But the resize path's `_resizeAndRenderScore` at [VerticalLayoutBase.ts:295-298](packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L295) DOES call `afterReverted` per renderer when `barsPerRowActive` is false. When `barsPerRowActive` is true (line 285-291), it does NOT — it just calls `_fitSystem`. That means on barsPerRow-active resize, `isFinalized = true` carries over, and `finalizeRenderer` (in Step 12 → SystemFinalize) needs to be idempotent OR `isFinalized` needs to be a per-cycle field. §B / §C-5 don't list `isFinalized` explicitly. Add.

## Verification of v3's §J sign-off checklist

| Review condition | v3 claim | Actually addressed? | Evidence |
| --- | --- | --- | --- |
| Critical 1 — single Spaced phase | "Step 0 hoists; §D.2 makes 'single-write Phase 2' explicit" | **Mostly** — Step 0 is correct, but §D.2 contradicts itself on bar-local skyline emission (Critical 1 in this review) | [BarRendererBase.ts:357-419](packages/alphatab/src/rendering/BarRendererBase.ts#L357); v3 §D.2 row 12 vs §D.7 |
| Critical 2 — version cookie | "Step 8a/8b explicit; deletion pinned to 8b" | **Yes** | Step 8a/8b sub-steps named with files touched; `reconcile-min-duration.md` §5 reasoning is sound |
| Critical 3 — tie writes contradict seal | "§D.6 commits to per-bar tie writes; only invocation hoists" | **Mostly** — direction chosen, but sub-phase ordering inside SystemFinalize is hand-waved (Critical 3 in this review) | [RenderStaff.ts:308-355](packages/alphatab/src/rendering/staves/RenderStaff.ts#L308); v3 Step 12 lacks ordering contract |
| Critical 4 — Step 10 prereq | "Prereq corrected to {1, 8, 11}" | **Naming only** — Step 11's scope omits `_preBeatGlyphs`, the field Step 10 needs (Critical 2 in this review) | v3 §E Step 11 scope list; [BarRendererBase.ts:983-994](packages/alphatab/src/rendering/BarRendererBase.ts#L983) |
| Critical 5 — staff overflow accumulators | "B.9b added; C-6 new cluster; Step 11 lifts substate to staff" | **Yes** — B.9b, C-6, Step 11 scope include `topOverflow/bottomOverflow/staffTop/staffBottom` | v3 §B.9b, §C-6, §E Step 11 |
| Significant 7 — `alignWithBeats` | "Route B; Step 17 retires" | **Yes** — clear architectural choice; cost estimate reasonable | `beam-helper-drawinginfos.md` §6; v3 §D.5, §E Step 17 |
| §F decisions made | "F.1–F.5 each have concrete answer" | **Yes**, with the asterisk that F.5's mechanism description is wrong (Critical 5 in this review) | v3 §F.1–F.5 |
| §E dependency DAG | "Added inline" | **Yes** — explicit DAG, clusters labeled | v3 §E "Dependency graph" |
| Revert+resize test corpus named | "Step 1 (`GhostStaffVisibility`), Step 10 (`ResizeWrapPointPreBeat`)" | **Named only** — both must be authored as part of the Step (§G.5/G.6 admits this) | v3 §J row 9, §G.5–G.6 |
| Decide-document gaps (F.5 / B.25) | "Resolved via Step 16's `populateSkyline?`" | **Mostly** — direction correct; B.25 mechanism description wrong (Critical 5 in this review) | [GroupedEffectGlyph.ts:20-25](packages/alphatab/src/rendering/glyphs/GroupedEffectGlyph.ts#L20) |

## Sign-off conditions for v4

1. **Resolve the §D.2 row 12 / §D.7 / §D.9 contradiction.** Split `scaleToWidth body` in §D.9 into "compute positions → Phase 2" and "emit bar-local skyline → Phase 3." Reflect in §D.2 row 12. Add §H invariant: Phase 2 leaves bar-local skylines empty/reset; only Phase 3 inserts.
2. **Make Step 10's substate-discard pattern explicit.** Add `_preBeatGlyphs` to Step 11's scope, with a contract for when the substate is discarded vs. reused. State the contract for `_postBeatGlyphs`, `voiceContainer`, `helpers` — what survives resize, what doesn't.
3. **Sub-phase ordering inside SystemFinalize.** §D.6 / Step 12 must specify the four-step order (renderer-finalize minus ties → tie writes → union → place) with explicit "tie writes happen after each renderer's other finalize work but before union."
4. **Step 1's accolade-spacing interaction.** Sub-steps for: (a) per-system pre-pass scope (not score-global); (b) what happens to `_accoladeSpacingCalculated` on revert; (c) what `calculateHeightForAccolade` reads now.
5. **Rewrite §B.25's mechanism description** to match `GroupedEffectGlyph.getBoundingBoxRight` actual code (reads `this.beat` / `this.renderer`, not foreign `endBeat`/renderer). Step 16 should reference `nextGlyph`/`isLinkedWithNext` traversal explicitly.
6. **Decide BarTempoGlyph's hook lifecycle.** After Step 9, BarTempoGlyph bbox is stable post-Phase 2. §D.3's "BarTempoGlyph is canonical hook user" needs to be either retired in Step 9's invariant or justified more carefully (e.g., the bbox is stable but emission needs to wait for Phase 3's full-skyline picture).
7. **Add the missing §I rows for Minor §13–§18** so traceability is item-by-item.
8. **Add `isFinalized`, `additionalMultiRestBars`, `isLinkedToPrevious`, `computedWidth` (separately), `MasterBarBounds`** to §B / §D.2 as appropriate (items v3 missed; M1, M4, M5, M6, M10 in this review).
9. **Step 11 ordering relative to Step 8b.** Pin Step 11 *after* Step 8b in the DAG (or document the cookie-bypass perf consequence).
10. **Step 5a explicit deliverable**: enumerate every `EffectInfo.onAlignGlyphs` implementation and classify max-of-idempotent vs. stateful, not just "currently true for whammy."

If items 1–5 land cleanly in v4, the migration is implementable as written. Items 6–10 are polish; the doc is shippable without them but they cost ~1 page total.

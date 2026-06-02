# Skyline emission architecture — review of v2

## Verdict

**Don't ship as written.** The framing is right and the direction is right, but v2 has at least four concrete holes that will turn the migration plan into a death march: (1) Phase 2 isn't actually "single" — `MultiVoiceContainerGlyph.applyLayoutingInfo` already calls `_scaleToForce` once per voice and `scaleToWidth` does it again, all under what v2 declares to be one Spaced phase; (2) the §B.10/B.16 sealing story relies on Coordinate running once per master bar, but `_trackSystemMinDuration` flips bars retroactively dirty *after* assembly, and `reconcileMinDurationIfDirty` re-runs `applyLayoutingInfo` on every renderer — the version cookie this seals over isn't lazy, it's actively load-bearing; (3) the §D.6 SystemFinalize tie-pass replaces a documented mechanism that today writes cross-renderer skylines AFTER the renderers themselves are sealed — v2 says "tie geometry depends on positions" but never proves the geometry can be moved without re-introducing an inner second pass for effect-band feedback into staff overflow; (4) several state-reset gaps in resize (`_ties[]`, `_contentTopOverflow/Bottom`, `topOverflow/bottomOverflow` on `RenderStaff`, `_sharedLayoutData` for `TabWhammyEffectInfo`) aren't in B.9 and aren't in the migration steps.

The doc is also too confident about §G — v1 wasn't merely narrower; v1's path D produced a 50-line removal, and that's mostly orthogonal to the lifecycle refactor. v2 keeps wanting to delete `populateBarSkyline` (§A.7) while also re-introducing it as `populateSkyline?` (§D.3). The contract decision is unsettled in the doc itself.

## What v2 gets right

- The 18-entry inventory in §B is largely accurate and is the doc's main value. The mapping `B.6/B.7 → C-2` (out-of-order phase dependency) is the correct diagnosis: skyline emission is a *symptom*.
- The diagnosis at §C-3 (BarLayoutingInfo as shared mutable broker without a "done writing" boundary) is the actual structural defect.
- §C-4 framing — "bbox as side-channel for renderer state" — is the precise vocabulary the next contributor needs.
- The migration's prioritization of Step 1 (precompute `firstVisibleStaff`) and Step 6 (drop `height += layoutingInfo.height`) as low-risk wins is correct — both are surgical and visible.
- The observation that resize structurally enters at "Phase 2" (§D.2) is the right invariant. Today's `afterReverted` + `reLayout` is a manual reset list; making it a substate swap (§D.7 + Step 11) is the correct end state.

## Critical findings

### 1. "Single Spaced phase" is contradicted by the existing code paths v2 claims to fold into it

- **Where in v2**: §D.1 ("Phase 2: Spaced"), §D.8 ("`BarRendererBase.applyLayoutingInfo` body → Phase 2", "`BarRendererBase.scaleToWidth` body → Phase 2 (called at the bar's final width — once)").
- **The claim**: Phase 2 is a single pass that computes every position once with no further x/width mutation.
- **Why it's wrong**: `MultiVoiceContainerGlyph.applyLayoutingInfo` calls `_scaleToForce` inside the per-voice loop ([MultiVoiceContainerGlyph.ts:160-167](../packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts#L160)):

  ```ts
  public applyLayoutingInfo(info: BarLayoutingInfo): void {
      for (const beatGlyphs of this.beatGlyphs.values()) {
          for (const b of beatGlyphs) {
              b.applyLayoutingInfo(info);
          }
          this._scaleToForce(Math.max(this.renderer.settings.display.stretchForce, info.minStretchForce));
      }
  }
  ```

  For a 3-voice bar that's 3 calls to `_scaleToForce` inside `applyLayoutingInfo`, *each of which rewrites every beat container's x*. Then `scaleToWidth` calls it again. Today this is plausibly correct (max-of semantics) but it directly contradicts §D.1's "no further x/width mutation after this phase." Either Phase 2 has internal sub-iterations and that needs to be in the contract, or the loop in `applyLayoutingInfo` is a bug and needs explicit retirement.

- **File:line evidence**: [MultiVoiceContainerGlyph.ts:160-167](../packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts#L160), [BarRendererBase.ts:538](../packages/alphatab/src/rendering/BarRendererBase.ts#L538), [BarRendererBase.ts:366](../packages/alphatab/src/rendering/BarRendererBase.ts#L366).
- **Impact if shipped**: Step 9 ("Single-write `_postBeatGlyphs.x`") assumes the post-beat x is computed from final beat positions — which means relying on `_scaleToForce` to have settled the beat container width. If `applyLayoutingInfo`'s internal `_scaleToForce` loop runs against `info.minStretchForce` and `scaleToWidth` runs against `spaceToForce(containerWidth)`, the two yield different positions — multi-voice bars under Page Automatic layout will visually drift.
- **Fix**: Make the contract explicit: Phase 2 is "compute final positions at the bar's *final* width once, using the spring force derived from that width." Drop the `_scaleToForce(minStretchForce)` call from `applyLayoutingInfo` (it's only there because `applyLayoutingInfo` runs without knowing the final width). Add a doc-level invariant: `MultiVoiceContainerGlyph` only calls `_scaleToForce` from Phase 2's single entry point. Add this as an explicit step in §E between Step 8 and Step 9.

### 2. The version cookie `_appliedLayoutingInfo` is not "lazy cross-bar coordination" — `reconcileMinDurationIfDirty` actively depends on it

- **Where in v2**: §B.3, §C-3 ("§B.3 is the symptom — 'did the info change since we last looked'"), §D.4 ("No version cookie"), Step 8.
- **The claim**: The version cookie exists only because `applyLayoutingInfo` is called from multiple paths, and once Coordinate seals the info, the cookie becomes obsolete.
- **Why it's wrong**: `StaffSystem.reconcileMinDurationIfDirty` ([StaffSystem.ts:446-491](../packages/alphatab/src/rendering/staves/StaffSystem.ts#L446)) iterates every renderer and calls `r.applyLayoutingInfo()` after bumping the info's version via `recomputeSpringConstants`. The version mismatch IS what enables this re-application to be correct — without it, the cookie guard would short-circuit and the renderers would keep stale springs. This is not "lazy" — it's the actual coordination mechanism for the late-arriving shorter min-duration case. Today, `_trackSystemMinDuration` flags `isMinDurationDirty` when a bar added *late* in the system has a shorter duration than the system's existing minimum ([StaffSystem.ts:427-429](../packages/alphatab/src/rendering/staves/StaffSystem.ts#L427)). The dirty flag is consumed at `_fitSystem` ([VerticalLayoutBase.ts:411](../packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L411)), which is well past the Coordinate window v2 proposes.
- **File:line evidence**: [StaffSystem.ts:446-491](../packages/alphatab/src/rendering/staves/StaffSystem.ts#L446), [VerticalLayoutBase.ts:407-411](../packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L407), [BarLayoutingInfo.ts:274-278](../packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts#L274).
- **Impact if shipped**: Step 8 ("Move `BarLayoutingInfo.finish` + `reconcileMinDurationIfDirty` into a single Coordinate call per master bar") proposes folding the dirty-bar reconcile into Coordinate — but Coordinate runs once *per master bar*, before subsequent master bars have been added to the system. The dirty flag specifically triggers on the (N+M)th master bar invalidating the 1..(N+M-1)th bars. Coordinate-per-master-bar cannot see future bars. Removing the version cookie + late reconcile path breaks every score whose first bar in a system has a longer minimum duration than a later bar in that same system. That's any score with an eighth-note pickup followed by sixteenths.
- **Fix**: Coordinate needs a two-tier shape. (a) A per-master-bar publish-and-seal-local-info step. (b) A per-system "reconcile against system min" step that runs once the system is closed (`isFull` settled). Step 8 should be split: 8a removes the in-doLayout/in-applyLayoutingInfo redundancy, 8b moves the dirty-reconcile into the system close. The version cookie can then be deleted only when both 8a and 8b have landed. Until then, `_appliedLayoutingInfo` is correctness-critical, not perf-defensive.

### 3. Cross-renderer tie writes contradict "Finalized seals the skyline"

- **Where in v2**: §A.1 (lists `_finalizeTies` writes into other renderers' barLocalSkyline at finalize time), §D.6 (proposes hoisting to SystemFinalize), §F.4.
- **The claim**: After Phase 3, "nothing mutates that downstream paint reads." Ties are placed in a system-level pass that "writes to a system skyline directly."
- **Why it's wrong**: `_finalizeTies` today writes into the spanned renderer's *bar-local* skyline ([BarRendererBase.ts:625-635](../packages/alphatab/src/rendering/BarRendererBase.ts#L625)) — not into the system skyline. The reason: bar-local skylines are what feed `_unionBarLocalIntoStaffSkyline`, which is what `EffectSystemPlacement.placeAndApply` then queries via `sky.upSky.maxHeightInRange(r.x, r.x + r.width)`. The bar-local skyline is the contract surface for staff-level effect placement to see the spanned tie. v2's "write directly to system skyline" skips the per-renderer x-windowed bar-local skyline that placement uses to compute `topEffects.height` per renderer. If you bypass the bar-local skyline, `EffectSystemPlacement.placeAndApply` ([EffectSystemPlacement.ts:92-101](../packages/alphatab/src/rendering/EffectSystemPlacement.ts#L92)) will compute `r.topEffects.height` against a system skyline that has the tie's contribution but no way to attribute it to the renderer it spans.
- **File:line evidence**: [BarRendererBase.ts:600-637](../packages/alphatab/src/rendering/BarRendererBase.ts#L600), [EffectSystemPlacement.ts:60-75, 92-101](../packages/alphatab/src/rendering/EffectSystemPlacement.ts#L60), [RenderStaff.ts:236-276](../packages/alphatab/src/rendering/staves/RenderStaff.ts#L236).
- **Impact if shipped**: Step 12 would break multi-bar tied notes that overflow above the staff in a way that causes `topEffects.height` to be misattributed. Tests with cross-system slurs and bend-up arcs are most likely to surface this.
- **Fix**: Either (a) keep ties writing per-bar (just hoist *invocation* to after every renderer's finalize), preserving the bar-local skyline contract; or (b) refactor `EffectSystemPlacement.placeAndApply` to query the system skyline directly with `r.x`-windowed max queries — that's already what it does ([EffectSystemPlacement.ts:63-64, 94-97](../packages/alphatab/src/rendering/EffectSystemPlacement.ts#L63)), so the migration is "stop populating bar-local skylines after finalize" rather than "write to system skyline." v2 §D.6 needs to make this explicit.

### 4. The §E.10 prereq chain is broken — Steps 1 and 8 alone don't make Step 10 safe; missing prereq on Step 11

- **Where in v2**: §E.10 ("Replace `wasFirstOfStaff` / `recreatePreBeatGlyphs`"), Prereq listed as "Steps 1, 8."
- **The claim**: With firstVisibleStaff settled in Coordinate (Step 1) and `BarLayoutingInfo` sealed (Step 8), the resize-time "I'm now first/not-first" recreate goes away.
- **Why it's wrong**: `recreatePreBeatGlyphs` is invoked when `wasFirstOfStaff !== isFirstOfStaff` ([BarRendererBase.ts:974](../packages/alphatab/src/rendering/BarRendererBase.ts#L974)). The "first-of-staff" question is independent of "first-visible-staff-in-system" — `isFirstOfStaff` is `this.index === 0` ([BarRendererBase.ts:481](../packages/alphatab/src/rendering/BarRendererBase.ts#L481)), i.e. is this renderer the first bar of its line. That depends on system assembly placing this bar at index 0 of the staff. The dependency Step 10 needs to retire is not "first visible staff" but "first bar of staff line" — pre-beat glyph content differs because the first bar of a line gets clef/key-sig/time-sig, mid-line bars don't. Step 1 doesn't touch this; Step 8 doesn't touch this. The actual prereq is **Step 11 + the `LayoutCycle` substate** — because the resize answer is "discard the pre-beat glyphs and rebuild them with the current `isFirstOfStaff`," which only works cleanly if pre-beat is in the disposable substate.
- **File:line evidence**: [BarRendererBase.ts:478-482](../packages/alphatab/src/rendering/BarRendererBase.ts#L478), [BarRendererBase.ts:974-977](../packages/alphatab/src/rendering/BarRendererBase.ts#L974), [BarRendererBase.ts:983-994](../packages/alphatab/src/rendering/BarRendererBase.ts#L983).
- **Impact if shipped**: Step 10 lands per the doc's prereqs (1 + 8), tests don't immediately fail (resize tests don't always exercise wrap-point changes), then on a real `triggerResize` that flips a bar's line-index, pre-beat glyphs are wrong (clef missing or appearing where it shouldn't). Visual regressions in any score that wraps across systems.
- **Fix**: Reorder: 11 → 10, with explicit substate-discard logic for pre-beat group during resize when `isFirstOfStaff` changes. Or split Step 10 into "10a: factor out the recreate condition; 10b: drop the cached `wasFirstOfStaff` once 11 is in." Update the §E "Parallelization" section accordingly.

### 5. `topOverflow`/`bottomOverflow` on `RenderStaff` accumulate across resize cycles without reset

- **Where in v2**: §B.9 lists the manual reset fields on resize but does not include `RenderStaff.topOverflow / RenderStaff.bottomOverflow`. §A.2 lists `afterReverted` and `afterStaffBarReverted` resets but does not point out the staff-level overflow is only reset on `revertLastBar`.
- **The claim** (implicit): The current resize-reset list is incomplete but documented; the §D.7 "atomic substate" replaces it.
- **Why it's wrong**: `RenderStaff.topOverflow` / `RenderStaff.bottomOverflow` are max-of accumulators ([RenderStaff.ts:198-210](../packages/alphatab/src/rendering/staves/RenderStaff.ts#L198)). They are reset in `revertLastBar` ([RenderStaff.ts:180-181](../packages/alphatab/src/rendering/staves/RenderStaff.ts#L180)) but NOT in `finalizeStaff` or before `_resizeAndRenderScore`. On the resize path, `afterReverted` is called per-renderer but it doesn't touch the staff overflow. So if any renderer's overflow shrinks on resize (e.g. a tie that was overhanging in the old wrap is no longer the tallest), the staff retains the old maximum forever. Similarly `RenderStaff.staffTop` / `RenderStaff.staffBottom` are max-of and not reset.
- **File:line evidence**: [RenderStaff.ts:120-129](../packages/alphatab/src/rendering/staves/RenderStaff.ts#L120), [RenderStaff.ts:198-210](../packages/alphatab/src/rendering/staves/RenderStaff.ts#L198), [RenderStaff.ts:175-189](../packages/alphatab/src/rendering/staves/RenderStaff.ts#L175). No equivalent reset before `_resizeAndRenderScore` in [VerticalLayoutBase.ts:281-351](../packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L281).
- **Impact if shipped**: Step 11 (`LayoutCycle` substate) is scoped to `BarRendererBase` per §E.11. It explicitly does *not* include `RenderStaff`-level state. A clean per-cycle reset for the renderer doesn't fix the latent staff-overflow accumulation. Resize-driven shrink scenarios will leave staves taller than needed; over many resizes the score "puffs up."
- **Fix**: Add an explicit §B.9b entry covering `RenderStaff.topOverflow / .bottomOverflow / .staffTop / .staffBottom`, and either (a) reset them at the start of `finalizeStaff`, or (b) include them in the substate from Step 11 by lifting the substate concept to a per-(staff, cycle) object. (a) is cheaper. The §B inventory is incomplete and the migration plan should reflect the fix.

## Significant findings

### 6. `EffectSystemPlacement.placeAndApply` two-pass diffing is not addressed

- **Where in v2**: §A.1 (mentions before/after sampling), §D.5 ("No reset, no version, no pending queue"), §B.14 (proposes deleting the reset).
- **The mechanic**: `placeAndApply` samples `contentTop[i] / contentBottom[i]` before `_placeSide` runs, then re-samples after to compute `r.topEffects.height` ([EffectSystemPlacement.ts:60-75, 92-101](../packages/alphatab/src/rendering/EffectSystemPlacement.ts#L60)). This isn't "validation" — it's how the placement quantifies how much taller the staff got because of effect band placement. v2's "one pass" goal would need to either (a) preserve the diff (acceptable, but say so), or (b) replace it with a different attribution mechanism.
- **Fix**: Add an explicit clarification in §D.5: the before/after sampling stays as an internal mechanic of `placeAndApply`; what gets removed is the `needsSecondPass` outer loop, not the inner sampling. Otherwise Step 12 + Step 14 readers will assume the diff is part of what they should kill.

### 7. `BeamingHelper.alignWithBeats` clears `drawingInfos` inside its iteration loop

- **Where in v2**: §B.11 ("`finish()` initializes drawingInfo with the current beat X. `alignWithBeats()` rewrites startX/endX with the post-scale beat X. Y is initialized once and never refreshed").
- **The claim**: `alignWithBeats` rewrites x; y is stable from `finish()`.
- **The reality**: `alignWithBeats` does:

  ```ts
  for (const v of this.drawingInfos.values()) {
      v.startX = this._renderer.getBeatX(v.startBeat!, BeatXPosition.Stem);
      v.endX = this._renderer.getBeatX(v.endBeat!, BeatXPosition.Stem);
      this.drawingInfos.clear();
  }
  ```

  ([BeamingHelper.ts:109-115](../packages/alphatab/src/rendering/utils/BeamingHelper.ts#L109)). The `clear()` is *inside* the loop iterating the same map. After the first iteration the map is empty and the loop exits. The startX/endX assignment only happens to the first direction's drawing info, then the entries are *all* discarded. Whoever paints next has to re-derive the drawing info from scratch via `ensureBeamDrawingInfo`. So v2's "rewrite x" is actually "rewrite x for one entry, then throw all entries away."

  This means the assertion "Y is initialized once and never refreshed" is also misleading — Y is *re-derived* on every paint by `initializeBeamDrawingInfo` ([LineBarRenderer.ts:1017-1072](../packages/alphatab/src/rendering/LineBarRenderer.ts#L1017)), because the drawingInfos cache is invalidated by `alignWithBeats`.
- **Impact**: Either this is a bug (writing values that get immediately discarded) or it's a deliberate cache-invalidation that v2 misread as "rewrite." The §D.1 contract "beam drawingInfos (start/end X+Y, FINAL)" cannot land until this is clarified. If the cache is intentionally invalidated, then beam Y must be stable when re-derived later (which is plausible, since `initializeBeamDrawingInfo` only reads beat positions); if not, this is a bug that's been hiding behind successful tests.
- **Fix**: Add a §B.11 footnote pointing out the clear-in-iteration behaviour and decide whether to (a) remove the `clear()` and let drawingInfos be authoritative through paint, or (b) drop the `startX/endX` assignment and just `clear()` so paint re-derives.

### 8. §E Step 5 ("Single `alignGlyphs` call point") misses the `_sharedLayoutData` interaction

- **Where in v2**: §E.5.
- **The claim**: "If no consumer of pre-scaleToWidth band geometry exists, this is a pure simplification."
- **Why it's incomplete**: `EffectBand.alignGlyphs` calls `this.info.onAlignGlyphs(this)` ([EffectBand.ts:242](../packages/alphatab/src/rendering/EffectBand.ts#L242)), which for `TabWhammyEffectInfo` writes to the staff's `_sharedLayoutData` ([TabWhammyEffectInfo.ts:44-60](../packages/alphatab/src/rendering/effects/TabWhammyEffectInfo.ts#L44)). The shared data is reset per staff in `_scaleToWidth` / `_alignRenderers` ([VerticalLayoutBase.ts:455](../packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts#L455), [HorizontalScreenLayout.ts:221](../packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts#L221)) — *not* before the doLayout-time `alignGlyphs` call or the applyLayoutingInfo-time one. That means the doLayout-time `onAlignGlyphs` calls write to data that's stale from the previous render or accumulates incorrectly across the 3 alignment invocations. The whammy offset (the only field there today) is max-of, so it's coincidentally robust to multi-call.
- **Fix**: Step 5 should land *after* the shared-layout-data lifecycle is documented. Add an explicit "(a) confirm `onAlignGlyphs` is idempotent across removed call sites; (b) confirm the reset of `_sharedLayoutData` happens at the right point in the cycle" as sub-steps. Step 15 (typed staff-state container) is the right longer-term fix but is listed as a low-risk parallel step — actually it has a hidden dependency on Step 5 ordering.

### 9. The `BarTempoGlyph` "move off bbox" plan in v1 has been replaced in v2 with `populateSkyline?`, but v2's Step 3 is still ambiguous

- **Where in v2**: §D.3 (`populateSkyline?`), §E.3 ("replace `_dynamicSkylineGlyphs` emit with a hook-driven walk"), §A.7 ("the two dynamic-bbox glyphs and the `_dynamicSkylineGlyphs` registry … disappear once Spaced is genuinely final"), §G ("v2 doc treats the lifecycle as the unit of work").
- **The contradiction**: §A.7 says the registry disappears because Spaced is final. §E.3 introduces `populateSkyline?` to replace the registry. §F.1 calls `populateSkyline?` the canonical seam. So which is it: the registry goes away because bbox becomes stable (no hook needed), or the registry is replaced by a hook? Step 3 is supposed to land *before* Step 13 (the three-phase split), so at Step 3 time, Spaced is not yet "final" in the v2 sense.
- **Fix**: Reorder the migration: Step 3 lands the hook as a non-architectural seam (replacing the existing registry one-for-one). After Step 13 lands, an audit step decides whether the hook is still needed for `BarTempoGlyph`. Either (a) Step 3 stays and Step 13 documents that the hook is retained for the few glyphs that genuinely have late skyline contributions; or (b) Step 3 is rewritten to "delete `_dynamicSkylineGlyphs`, `BarTempoGlyph` moves to beat-anchored emission" (v1's recommendation), and Step 13 then has zero glyph-level work. The doc should pick one.

### 10. `revertLastBar` interaction with §B.5 / Step 1 is acknowledged in §H but not addressed in the plan

- **Where in v2**: §H ("revertLastBar's interaction with `firstVisibleStaff` … Easy to forget").
- **Why it's significant**: `StaffSystem.revertLastBar` calls `s.revertLastBar()` per staff ([StaffSystem.ts:510](../packages/alphatab/src/rendering/staves/StaffSystem.ts#L510)), which decrements `_emptyBarCount` and calls `_updateVisibility` ([RenderStaff.ts:175-192](../packages/alphatab/src/rendering/staves/RenderStaff.ts#L175)). The post-revert visibility may flip `firstVisibleStaff`. v2's Step 1 pre-computes `firstVisibleStaff` from the *model* before any renderer runs; revert then *removes* a renderer from the staff. The model-based pre-pass needs to handle the case where the pre-pass said "staff X is first visible because it has bar at index 5" but bar 5 just got reverted out of the system. v2's "Easy to forget" downplays this — it's a correctness requirement of Step 1.
- **Fix**: Add to Step 1 explicitly: "must re-run on `revertLastBar`." Add a test case (revert mid-system in a `hideEmptyStaves`-enabled multi-staff score). This is a Step 1 acceptance criterion, not a footnote.

### 11. Step 13 ("Three-phase BarRendererBase API split") under-scopes subclass impact

- **Where in v2**: §E.13 ("All `BarRenderer*` subclasses overriding any of the old method names need adjustment").
- **Why it's incomplete**: The override surface is larger than "the old method names" — `LineBarRenderer` (and its subclasses) implements `emitHelperSkyline`, `emitBeatSkyline`, `emitSubclassBarLocalSkyline`, `completeBeamingHelper`, `initializeBeamDrawingInfo`, `calculateBeamingOverflows`. Each of these has implicit phase requirements: `calculateBeamingOverflows` runs in `doLayout` today and needs beam helpers ready ([LineBarRenderer.ts:983-996](../packages/alphatab/src/rendering/LineBarRenderer.ts#L983)). Splitting `doLayout` into Intrinsic/Spaced means each of these overrides has to be relocated to the right phase. The "200-400 lines" estimate is for `BarRendererBase` itself; subclass relocation is on top.
- **Fix**: Step 13 needs a sub-checklist of every subclass method that runs as part of the renderer lifecycle, with explicit phase assignment. Add this to the §E.13 description before estimating cost.

### 12. `HorizontalScreenLayout` doesn't run `finalizeStaff` per the staff loop in v2's mental model

- **Where in v2**: §D.5–D.6 propose tie finalization in `SystemFinalize`; §H mentions HorizontalScreenLayout.
- **Why it matters**: `HorizontalScreenLayout._finalizeStaffSystem` calls `_alignRenderers` then `_system.finalizeSystem()` ([HorizontalScreenLayout.ts:212-215](../packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts#L212)). `_alignRenderers` calls `renderer.scaleToWidth(renderer.width)` for the *second* time per renderer (the first was during `_scaleBars` at [HorizontalScreenLayout.ts:180](../packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts#L180)). v2's "Spaced runs once at final width" cannot land for HorizontalScreenLayout without restructuring `_finalizeStaffSystem` — Step 7 acknowledges this but understates it ("verify nothing it computed gets dropped").
- **Fix**: Step 7 must be a precondition to Step 13 in the dependency graph, not parallel. The "20-40 lines" estimate is plausible but the visual regen across the HorizontalScreenLayout tests is significant.

## Minor findings

### 13. §B.10 "rate as cache" overstates `_appliedLayoutingInfo`'s role

§B.10 entry says "applyLayoutingInfo re-runs against the final aggregate post-hoc." Per the existing code, only the *last* renderer's applyLayoutingInfo runs after the system loop ([StaffSystem.ts:552-553](../packages/alphatab/src/rendering/staves/StaffSystem.ts#L552)), not every renderer. Earlier renderers' positions are stale until either resize or the dirty-reconcile path. v2 implies the patching is universal; it's selective.

### 14. §F.5's "no code change needed" claim is shaky

§F.5 says effect-band glyph bbox is "officially dynamic" and "no code change needed" once positions are sealed. But `EffectBand.computeLocalXRange` ([EffectBand.ts:251-294](../packages/alphatab/src/rendering/EffectBand.ts#L251)) calls `g.getBoundingBoxLeft()` / `Right` — and for `GroupedEffectGlyph` that goes through `this.renderer.getBeatX(this.beat, this.endPosition)`. If the band crosses a renderer (Span-category effects), `this.renderer` is the start renderer, and `getBeatX` for an `endBeat` that lives in a *different* renderer returns 0 (the beat container doesn't exist in this renderer's voiceContainer). The actual end-X is computed in `paint` via the linked-glyph chain. So `computeLocalXRange` may under-report Span-category effect ranges. v2 should at least flag this in §F.5 — the contract is fine but the consumer isn't generic.

### 15. §A.1 timeline table miscounts `topEffects.alignGlyphs` calls

The table at §A.1 lists "effectBand glyph x" mutated in doLayout, applyLayoutingInfo, scaleToWidth — three times — but `reLayout` also calls `alignGlyphs` ([BarRendererBase.ts:968-969](../packages/alphatab/src/rendering/BarRendererBase.ts#L968)). On the resize path that's *four* calls total before the bar is painted. Minor count error; doesn't change conclusions.

### 16. §A.2 "_appliedLayoutingInfo: version cookie that will mismatch" is not always true

`_appliedLayoutingInfo` mismatches the new info only if the new info's version differs from the recorded one. On a pure-fit resize where `recomputeSpringConstants` was NOT called, the recorded version equals the current version, and `applyLayoutingInfo` short-circuits. That's not a bug — it's the cookie working as intended. v2's framing as "forcing re-run" overstates how often this actually happens.

### 17. §H "additionalMultiBarsRestBars" question is answerable now

`createBeatGlyphs` short-circuits to a `MultiBarRestBeatContainerGlyph` ([BarRendererBase.ts:902-910](../packages/alphatab/src/rendering/BarRendererBase.ts#L902)) and `voiceContainer.doLayout` still runs (just on the single container). `_registerLayoutingInfo` then runs through `voiceContainer.registerLayoutingInfo` which iterates the single container — likely contributes a zero-width spring. This is fine but should be confirmed by a regression test; mentioning it under §H without resolving is technical debt.

### 18. §G's dismissal of v1 is too strong

§G says "v1 was a correct answer to its own question. The owner reframed the question." But v1's path D delivers a real, shippable cleanup of `_dynamicSkylineGlyphs` for ~80 lines of churn. v2's path is ~2 weeks. Reality is: ship v1 path D as Steps 1-3, then evaluate whether v2's lifecycle refactor is still worth the effort. The doc should say so.

## Items v2 missed

### M1. `BarLayoutingInfo.version` is bumped inside `addSpring`

[BarLayoutingInfo.ts:136](../packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts#L136) increments `version` on every spring add. `_registerLayoutingInfo` is called from Phase 1, so during a single renderer's doLayout, the version bumps many times before `applyLayoutingInfo` ever checks it. The version cookie therefore tracks "any spring change since last apply," not "any post-finalize change." v2 §B.3 misses this: the cookie isn't just lazy cross-bar coordination, it's also intra-bar protection against partial-state reads.

### M2. `MultiBarRestBeatContainerGlyph.beatId === -1` interacts with `_pendingBeatEffectsByBeat`

In `scaleToWidth`'s per-beat callback, the pending-effect flush is guarded by `if (beatId >= 0)` ([BarRendererBase.ts:386](../packages/alphatab/src/rendering/BarRendererBase.ts#L386)). For multi-bar-rest bars, beat-effect glyphs (e.g. a tempo automation landing inside the rest) would skip the flush. Today this doesn't manifest because effect glyphs aren't created on the synthetic container, but it's a latent landmine for any future "decorate a multi-bar-rest with an effect glyph" feature. The skyline emission migration is the right time to delete this special case (or document it explicitly).

### M3. `Bar.simileMark === SimileMark.SecondOfDouble` flipping `canWrap` is a doLayout-time effect on Coordinate-phase decisions

[BarRendererBase.ts:686-688](../packages/alphatab/src/rendering/BarRendererBase.ts#L686) sets `this.canWrap = false` inside `doLayout`. This canWrap is consumed during system assembly to decide whether to keep this bar on the same line as the previous ([StaffSystem.ts:375-377](../packages/alphatab/src/rendering/staves/StaffSystem.ts#L375)). v2's Coordinate phase says "compute firstVisibleStaff from model state" — but `canWrap`'s SimileMark.SecondOfDouble check is also a model-only condition. v2 should fold this into Coordinate (or earlier — `addBars` could compute `canWrap` from the model). Currently the dependency is: Phase 1 sets a value that Coordinate (in v2's model) doesn't formally read but the system-assembly loop does.

### M4. `_sharedLayoutData` reset point bleeds across renders on the resize path

`_sharedLayoutData` resets in `_scaleToWidth` / `_alignRenderers` per staff per fit. But on resize, `_alignRenderers` is called from `_finalizeStaffSystem` (Horizontal) and `_scaleToWidth` is called from `_fitSystem` (Vertical). The reset point is mid-cycle — *after* `doLayout`'s alignGlyphs has already written to it on the initial render but *before* the resize's alignGlyphs. The keyed bag isn't versioned, so doLayout-time reads on resize get prior-cycle values. Step 15 ("typed container") doesn't fix this; the substate-per-cycle pattern from Step 11 needs to extend to staff-level state.

### M5. `revertLastBar` re-running per staff doesn't reset `_emptyBarCount` for the new MasterBarsRenderers

After `revertLastBar`, the bar renderers get attached to a new system via `addMasterBarRenderers`. The new staff (a different `RenderStaff` instance in a new `StaffSystem`) starts with `_emptyBarCount = 0`, and each `addBarRenderer` increments if the bar is empty. But the *renderer instances* survive — their `bar.isEmpty / bar.isRestOnly` doesn't change. So visibility recomputes correctly in the new system. This is fine for the current code but worth noting: v2's "Coordinate runs again on the new system" needs to explicitly produce a fresh visibility decision.

### M6. `RenderStaff.height` accumulation across `finalizeStaff` calls

`finalizeStaff` sets `this.height = 0` ([RenderStaff.ts:311](../packages/alphatab/src/rendering/staves/RenderStaff.ts#L311)) then does max-of with renderer heights — that's clean. But `calculateHeightForAccolade` ([RenderStaff.ts:290-298](../packages/alphatab/src/rendering/staves/RenderStaff.ts#L290)) sets height based on `this.barRenderers[0].height`. If `calculateHeightForAccolade` runs before all renderers are added (it's called from `_calculateAccoladeSpacing` which runs during `addBars`/`addMasterBarRenderers`), the height computed at accolade time doesn't reflect later-added renderers. v2 doesn't discuss this and Step 1 (which touches the same loop in `addBars`/`addMasterBarRenderers`) could destabilize the accolade calculation.

### M7. `_postBeatGlyphs.doLayout()` in `recreatePreBeatGlyphs` is a no-op

[BarRendererBase.ts:976](../packages/alphatab/src/rendering/BarRendererBase.ts#L976) calls `this._postBeatGlyphs.doLayout()` after recreating pre-beat glyphs. `LeftToRightLayoutingGlyphGroup.doLayout` is explicitly empty ([LeftToRightLayoutingGlyphGroup.ts:15-17](../packages/alphatab/src/rendering/glyphs/LeftToRightLayoutingGlyphGroup.ts#L15)). Dead code that suggests the author thought it would re-layout the post-beat glyphs. Step 10 is the right time to delete this line.

### M8. Skyline content sampling in `EffectSystemPlacement` uses `r.x + r.width` (post-scale) — fine on initial render, but on resize the `r.x` was reassigned in `_scaleToWidth` before `_fitSystem` calls `finalizeSystem`

The contentTop/contentBottom sampling at [EffectSystemPlacement.ts:63-64](../packages/alphatab/src/rendering/EffectSystemPlacement.ts#L63) queries `sky.upSky.maxHeightInRange(r.x, r.x + r.width)` — but at this point the bar-local skyline has already been unioned into `sky` using `baseX = renderer.x` ([RenderStaff.ts:238](../packages/alphatab/src/rendering/staves/RenderStaff.ts#L238)). The two `r.x` values match, so it's correct. But if Step 12 hoists ties to write to `sky` directly using staff-absolute x, and step 13's Phase 3 doesn't keep `r.x` invariant, this becomes an off-by-renderer bug. Flag for Step 12 acceptance.

## Recommendations on the migration plan

1. **Split Step 8.** 8a: drop the `applyLayoutingInfo` calls from `doLayout` (move the relevant work into a real Coordinate step that runs after every staff's doLayout in the same `addBars` invocation). 8b: keep the `reconcileMinDurationIfDirty` as a *system-close* step until v2 has a story for late-arriving shorter minimums. Only after 8b lands do we delete the version cookie.

2. **Reorder: 11 before 10.** The substate refactor is the prereq for cleanly handling pre-beat recreation. Currently the plan says "1, 8" for Step 10 — should be "1, 8, 11."

3. **Add a Step 0.** Audit and document every per-cycle state field on `BarRendererBase` and `RenderStaff`. The §B.9 list is incomplete; before any field migrates to a substate, the full surface needs to be on paper. ~1 day of audit, prevents Step 11 from missing fields.

4. **Promote Step 7 to a hard prereq for Step 13.** HorizontalScreenLayout's double `scaleToWidth` violates Phase 2 monotonicity. Step 13 cannot land while HorizontalScreenLayout still does this.

5. **Add a Step 5b**: audit `EffectInfo.onAlignGlyphs` consumers and their `_sharedLayoutData` lifecycle before reducing alignment call sites. Without this, Step 5 lands silently broken for whammys.

6. **Keep `populateSkyline?` even after Step 13.** §A.7's "the registry vanishes" assumes every dynamic glyph can be retired by bbox stability. GroupedEffectGlyph end-of-bar dynamic case (§F.5) won't be — keep the hook. Document this in §D.3.

7. **Delete Step 14 ("strictly geometric bbox audit") as a separate step, fold into Step 13.** The bbox audit is the test for Step 13's Phase 2-final invariant. Doing them in separate PRs is overhead with no value.

8. **Add an explicit `revertLastBar` test corpus to Step 1's acceptance.** A 2-staff score with `hideEmptyStaves`, where reverting flips visibility, exercises B.5 / Step 1's edge case.

## §F decision points — your independent recommendations

### F.1 Is `Glyph.getBoundingBox*` permitted to be dynamic?

**Strict.** v2 already leans this way and the case for lenient is weaker than v2 admits. `populateSkyline?` should be the only seam for layout-state-dependent contribution. The cost of "one extra method per dynamic glyph" is overstated — there are 2-3 dynamic glyphs total in the current codebase, and any future contributor would otherwise reinvent the registry by accident.

### F.2 Is the resize path structurally identical to initial layout?

**Identical, but with a twist.** Discard Phase 2+ state; re-run Phase 2+3+SystemFinalize. Don't re-run Phase 1. v2's "identical" recommendation conflates "same code path" with "same work" — Phase 1 is the expensive part, and skipping it is what makes resize cheap. Be explicit: resize = same code path, but Phase 1 is no-op'd because state from initial-layout's Phase 1 survives.

### F.3 Where does `BarLayoutingInfo` live?

**Push to a `MasterBarLayout` owned by `StaffSystem`.** v2 says it has "no strong preference"; I do. The current shape — shared mutable broker — is a pure C-3 anti-pattern. A `MasterBarLayout` owns the springs and is the single object renderers `publishIntrinsic` into. The renderer no longer holds a reference to the broker after Coordinate seals. This costs more refactor but eliminates the temptation to mutate post-Coordinate.

### F.4 What's the contract for cross-bar glyphs (ties, multi-system slurs)?

**(a) for now.** Hoist finalization to system-level. Move ownership to a system-level registry *later*, not as part of this migration. The cost of (b) is "rewrite every tie consumer"; the value is "ownership clarity" — pay it after the rest of v2 lands.

### F.5 What's the contract for `EffectBand.computeLocalXRange` reading bbox?

**Document it as "valid after Phase 2; called once per cycle from SystemFinalize."** The `GroupedEffectGlyph` cross-renderer end-X issue (Minor 14) means `computeLocalXRange` is *not* a closed-form function of "Phase 2 is sealed" — it depends on the *staff's* placement being closed. So the validity phase is SystemFinalize, not Spaced. Update §F.5 to say so.

## Sign-off conditions

The doc would be ready to ship as a directive when:

1. **Critical 1 is resolved**: `MultiVoiceContainerGlyph.applyLayoutingInfo`'s internal `_scaleToForce` loop is either retired or explicitly carved into the Phase 2 contract. The "single pass" assertion in §D.1 must match the code.

2. **Critical 2 is resolved**: §B.3 and §C-3 acknowledge `_appliedLayoutingInfo` as correctness-critical for the system-min-duration reconcile path. Step 8 is split into 8a (in-doLayout cleanup) and 8b (system-close reconcile), with the version-cookie removal pinned to 8b.

3. **Critical 3 is resolved**: §D.6 explicitly states whether SystemFinalize writes to bar-local skylines per renderer (keep the contract) or to the system skyline (and how EffectSystemPlacement re-attributes per-renderer overflow). The current text is ambiguous.

4. **Critical 4 is resolved**: §E reorders so Step 11 is a prereq for Step 10. The §E.10 "Prereq: Steps 1, 8" is wrong; the real prereq is 11.

5. **Critical 5 is resolved**: §B grows an entry for `RenderStaff.topOverflow / .bottomOverflow / .staffTop / .staffBottom`. The substate concept (Step 11) is either scoped to include staff-level state or a separate reset is added to `finalizeStaff`.

6. **Significant 7 is resolved**: `BeamingHelper.alignWithBeats`'s `clear()`-in-iteration is investigated. The §D.1 "beam drawingInfos sealed in Phase 2" contract is verified against actual behaviour.

7. **§F decisions are made and recorded.** Each §F entry has an owner-chosen answer (not "the author leans X"). The decisions are then propagated into §D and §E — e.g. F.3 = MasterBarLayout means §D.4 and Step 8 are bigger than currently scoped.

8. **§E gets a dependency DAG, not a numbered list.** Step 7 is a hard prereq for Step 13. Step 11 is a hard prereq for Step 10. Step 5 is gated on the alignGlyphs `onAlignGlyphs` audit. A real DAG (with cross-edges) prevents the kind of false "self-contained step" claims §E currently makes.

9. **A "revert + resize" test corpus is named** in §E.1's acceptance and §E.10's acceptance. The doc references `triggerResize` in §H but doesn't pin down which existing test corpus exercises the regress-prone scenarios.

10. **The two "decide and document" gaps** — F.5 SystemFinalize validity for `computeLocalXRange` (Minor 14), and `GroupedEffectGlyph`'s cross-renderer end-X — get concrete contracts in §D rather than handwaves in §H.

Until all 10 land in v3, this is a research artifact, not an engineering directive.

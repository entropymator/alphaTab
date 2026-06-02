# `StaffSystem.reconcileMinDurationIfDirty` and the `_appliedLayoutingInfo` version guard

Branch: `feature/skyline-effects`. Working tree clean at `cfb80602`.

## TL;DR (5-line verdict)

1. The reconcile path **does** mutate `BarLayoutingInfo.version` (via `recomputeSpringConstants`), and the second pass of `applyLayoutingInfo` produces **different** values *for the renderers of bars that were actually re-derived* (their `voiceContainer.width`, `postBeatGlyphs.x`, `width`, `computedWidth` change). For renderers whose info was not re-derived the second pass is **value-identical** (`preBeatSize` / `postBeatSize` / `minStretchForce` / `totalSpringConstant` unchanged → `_scaleToForce` same → same positions; overflow registrations are max-only / idempotent).
2. Therefore the `_appliedLayoutingInfo >= layoutingInfo.version` guard in `BarRendererBase.applyLayoutingInfo` (`packages/alphatab/src/rendering/BarRendererBase.ts:526`) is **not correctness-critical** for the reconcile path itself — it is a per-renderer perf short-circuit. The architecture review's "correctness-critical" framing is overstated; the guard is correctness-load-bearing only in the sense that downstream paths assume **at-most-once** application of any *given* version (see §5 for the one real wrinkle: `topOverflow`/`bottomOverflow` are monotonic and so are tolerant, but they accumulate across versions on resize).
3. Concrete trigger condition: any system in which a bar added **after** the first introduces a shorter `BarLayoutingInfo.localMinDuration` than the running system minimum. The `shared-min-duration-aligns-same-duration-notes` / `…-reconciles-on-resize` / `…-multiple-short-arrivals` / `…-page-automatic` fixtures all hit this. The `…-shorter-note-first` fixture exercises the *eager-recompute* branch (no dirty flag, no reconcile).
4. v2 §E Step 8 split into 8a (intra-doLayout renderer-local idempotency) + 8b (system-close re-apply) is **sufficient** for this code path. There is no third "Coordinate never sees a late `minDuration`" path with the current incremental-add algorithm — `addBars` doesn't know whether a *future* bar will introduce a shorter note, so the dirty flag (or its equivalent) is unavoidable unless layout becomes two-pass per system (collect all bars → finalize → register/apply).
5. The "Coordinate phase as single seal point" claim in v2 §E **does not hold** for vertical layouts as written. `_fitSystem` runs `reconcileMinDurationIfDirty` *after* `_applyLayoutAndUpdateWidth` already ran `applyLayoutingInfo` once per added bar. v2 needs an explicit "re-seal Coordinate after reconciliation" step, OR the system-assembly loop has to defer all `applyLayoutingInfo` calls to a single post-assembly Coordinate firing (which would let `_applyLayoutAndUpdateWidth` no longer compute widths incrementally — a non-trivial restructure).

---

## Background: spring constants and `minDuration` in 60 seconds

`BarLayoutingInfo` (`packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts:25`) implements Gourlay's spring model for horizontal bar spacing. Every beat becomes a `Spring` with a `springConstant` derived from

```
phi = 1 + 0.85 * log2(duration / minDuration)
springConstant = (smallestDuration / duration) * (1 / (phi * minDurationWidth))
```

(`BarLayoutingInfo.ts:383-385`). `minDuration` is the **shortest note duration anywhere on the spring chain**. The constant `phi` grows with `log2(duration/minDuration)`, so a 1/4 note's spring constant depends on the **system-wide** minimum, not the bar-local one. If two bars in the same system used different `minDuration` references, identical quarter notes in the two bars would receive different spring constants → unequal x-positions → quarters that visibly don't column-align. The `shared-min-duration-aligns-same-duration-notes` test is the smoking-gun for this.

The system tracks the running minimum on `StaffSystem.minDuration` (`StaffSystem.ts:230`). Each time a bar is added, `_trackSystemMinDuration` (`StaffSystem.ts:420`) is called with the bar's `localMinDuration`:

- If the new bar's local min equals the existing system min → nothing to do.
- If the new bar's local min is **larger** than the system min → recompute *this bar*'s spring constants against the system reference immediately (`StaffSystem.ts:432-436`), eager branch.
- If the new bar's local min is **shorter** than the system min and there are already-added bars → the **already-added** bars' spring constants are now stale; set `isMinDurationDirty = true` (`StaffSystem.ts:427-429`) and update `minDuration`. The actual recompute is deferred to `reconcileMinDurationIfDirty` so we don't iterate the whole system on every appended bar.

`reconcileMinDurationIfDirty` (`StaffSystem.ts:446`) is invoked from `VerticalLayoutBase._fitSystem` (`packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts:411`) — the only call site — once the system has finished assembling and just before `_scaleToWidth` distributes the available staff width.

---

## 1. Precise trigger conditions

Walk through `_createStaffSystem` (`VerticalLayoutBase.ts:476-534`):

1. For each `barIndex`, call `system.addBars(...)` (`StaffSystem.ts:333`). This:
   - Builds renderers (`s.addBar(...)`).
   - Calls `barLayoutingInfo.finish()` (`StaffSystem.ts:399`) which computes spring constants at the bar's own `localMinDuration` and bumps `version` (`BarLayoutingInfo.ts:262`).
   - Calls `_trackSystemMinDuration(barLayoutingInfo)` (`StaffSystem.ts:405`).
     - **First bar added:** `this.minDuration === -1`, so the bar's local min is adopted as the system min (`StaffSystem.ts:425`). `isMinDurationDirty` stays `false` because the guard `this.masterBarsRenderers.length > 1` is not met (`StaffSystem.ts:427`).
     - **Subsequent bar with shorter local min than system min:** `isMinDurationDirty := true`, `minDuration` lowered. **The previously-added bars are now stale.**
     - **Subsequent bar with longer local min than system min:** the bar's own `recomputeSpringConstants(systemMin)` runs immediately (`StaffSystem.ts:434-435`), no dirty flag. Eager recompute branch.
   - Calls `_applyLayoutAndUpdateWidth` (`StaffSystem.ts:408`) which calls `applyLayoutingInfo` on the just-added renderer of every staff and updates system width totals.

2. Loop continues until `systemIsFull` (line break, page width hit, or `barsPerRow` cap). Then `_fitSystem(system)`:
   - `system.reconcileMinDurationIfDirty()` (`VerticalLayoutBase.ts:411`). If dirty → recompute spring constants for every bar whose `computedWithMinDuration > minDuration` AND re-run `applyLayoutingInfo` on every renderer.
   - `_scaleToWidth(system, ...)` distributes the now-correct widths.

**Score patterns that produce the dirty flag (and thus require reconcile):**

- A pickup bar of quarters/eighths followed by a bar containing a 16th/32nd/64th/128th/triplet rest. Bar 1's local min is ≥30 ticks; Bar 2 drops it to ≤20 ticks. Dirty.
- Any multi-bar system in which the bar with the shortest note is **not** the first one.
- Tuplet-rich sections where successive bars keep introducing shorter values (`shared-min-duration-multiple-short-arrivals` exercises this with two distinct shortenings 30→20→15 ticks).

Score patterns that **don't** produce the dirty flag:

- All bars have the same local min (e.g., uniform 8ths everywhere).
- The very first bar already has the shortest note. Eager-recompute branch handles every subsequent bar in place (`…-shorter-note-first` fixture).
- `LayoutMode.Horizontal`. `HorizontalScreenLayout.ts:76` sets `shareMinDurationAcrossBars = false`, so `_trackSystemMinDuration` is a no-op (`StaffSystem.ts:421-423`) and the dirty flag never gets set. The whole reconcile path is dead code in horizontal mode.

---

## 2. What `reconcileMinDurationIfDirty` actually does

Method body at `StaffSystem.ts:446-491`:

```
if (!isMinDurationDirty) return;

for each masterBarRenderers mb in masterBarsRenderers:
    if mb.layoutingInfo.computedWithMinDuration > this.minDuration:
        mb.layoutingInfo.recomputeSpringConstants(this.minDuration)
        // ↑ updates spring.springConstant on every Spring, recomputes
        //   totalSpringConstant and minStretchForce, bumps info.version

    for each renderer r in mb.renderers:
        r.applyLayoutingInfo()        // re-runs because version was bumped
        // accumulate maxFixedOverhead, maxContentWidth, realWidth across staves

    mb.maxFixedOverhead = …
    mb.maxContentWidth = …
    mb.width = realWidth
    systemWidth += realWidth

this.width = systemWidth
this.computedWidth = systemWidth
this.totalFixedOverhead = totalFixedOverhead
this.totalContentWidth = totalContentWidth
this.isMinDurationDirty = false
```

Two distinct sub-tasks bundled:

(a) **Per-bar:** for stale bars, recompute spring constants and re-apply on every staff's renderer.

(b) **System-wide:** rebuild the cached width totals (`width`, `computedWidth`, `totalFixedOverhead`, `totalContentWidth`) from the refreshed per-bar widths. These totals are otherwise maintained incrementally in `_applyLayoutAndUpdateWidth` / `revertLastBar` and consumed by `_scaleToWidth` (`VerticalLayoutBase.ts:450-451`). Without the rebuild, distribution would weight bars against pre-reconcile widths and the result would be wrong even for layouts that don't share spring references — so this sub-task **must** run when (a) ran, regardless of whether (a)'s per-renderer apply was redundant.

---

## 3. What happens if the version guard is removed

The guard is `if (this._appliedLayoutingInfo >= this.layoutingInfo.version) return false;` at `BarRendererBase.ts:526-528`. Trace each field touched in `applyLayoutingInfo` for a hypothetical second call where `version` did not actually change:

| Field | First call sets to | Second call (same version) sets to | Diff? |
|---|---|---|---|
| `_preBeatGlyphs.width` | `layoutingInfo.preBeatSize` | same `preBeatSize` (only written via `_registerLayoutingInfo`, monotone max) | no |
| `voiceContainer.x` | `_preBeatGlyphs.x + _preBeatGlyphs.width` | same (both inputs unchanged) | no |
| `voiceContainer.applyLayoutingInfo(info)` → `_scaleToForce(force)` | positions beats at force = `max(stretchForce, info.minStretchForce)` | same force, `buildOnTimePositions` is cached by force (`BarLayoutingInfo.ts:419-421`), `calculateVoiceWidth` deterministic in force | no |
| `_postBeatGlyphs.x` | `floor(container.x + container.width)` | same | no |
| `_postBeatGlyphs.width` | `layoutingInfo.postBeatSize` | same | no |
| `width` / `computedWidth` | derived | same | no |
| `topEffects.alignGlyphs()` / `bottomEffects.alignGlyphs()` | re-positions effect glyphs by current state | re-positions to the same state | no (idempotent re-positioning) |
| `_registerStaffOverflow()` | `staff.registerOverflowTop/Bottom(...)` which only **grow** the staff's contentTop/Bottom overflow (`BarRendererBase.ts:292-308`) | same values → `>` test fails → no-op | no |
| (ScoreBarRenderer override) `registerOverflowTop/Bottom` from multi-voice min/max | same monotone grow | same → no-op | no |

So in the *no-version-change* case, a second call is **value-equivalent** to a no-op. Removing the guard means redundant CPU work but not different output.

Where it matters in the **reconcile** path: bars whose `computedWithMinDuration > minDuration` get their `version` bumped by `recomputeSpringConstants` and their `applyLayoutingInfo` must re-execute — these renderers produce **different** values (`voiceContainer.width` and downstream layout fields change because `totalSpringConstant` and `minStretchForce` changed). The guard correctly lets these through (`_appliedLayoutingInfo < new version`).

**Verdict:** the guard is a perf short-circuit, not a correctness barrier. The single case worth a closer look — `_registerStaffOverflow` — is safe because of the max-only semantics; it would *accumulate* errors only if `topOverflow`/`bottomOverflow` could ever shrink, which they can't via this path. (Resize-path overflow shrinking is handled by `RenderStaff.resetSharedLayoutData` / `afterStaffBarReverted`, not by `applyLayoutingInfo`.)

---

## 4. Worked example

Synthetic score (matches `shared-min-duration-aligns-same-duration-notes`):

```
\ts 4 4
:4 c4 c4 c4 c4 |                                        // bar 1: four quarters, localMin = 30 (default)
:4 c4 c4 c4 :128 {tu 3} r r r :8 r :16 r :32 r :64 r   // bar 2: three quarters + 128th-triplet rests; localMin = 20
```

Layout mode `Parchment`, `defaultSystemsLayout 2` (both bars on one system).

**During `addBars` for bar 1:**
- `barLayoutingInfo.finish()` computes spring constants at local min = 30. `computedWithMinDuration = 30`. `version → 1`.
- `_trackSystemMinDuration`: `system.minDuration = -1` → adopt 30. `isMinDurationDirty = false`.
- `_applyLayoutAndUpdateWidth` → `bar1.applyLayoutingInfo()`. Bar 1's renderer records `_appliedLayoutingInfo = 1`. Its quarter springs use `phi = 1 + 0.85 * log2(960/30) = 1 + 0.85 * 5 = 5.25`, so `springConstant ≈ (960/960) * (1/(5.25 * 7)) ≈ 0.0272`.
- `system.width` increases by bar 1's computed width.

**During `addBars` for bar 2:**
- `barLayoutingInfo.finish()` at local min = 20. `computedWithMinDuration = 20`. `version → 1` for *bar 2's* info (independent).
- `_trackSystemMinDuration`: `localMin = 20 < system.minDuration = 30` AND `masterBarsRenderers.length > 1`. **Set `isMinDurationDirty = true`. `system.minDuration = 20`.** Bar 2's own info has `computedWithMinDuration = 20 == system.minDuration`, so no immediate recompute on bar 2.
- `_applyLayoutAndUpdateWidth` → `bar2.applyLayoutingInfo()`. Bar 2's quarter springs use `phi = 1 + 0.85 * log2(960/20) = 1 + 0.85 * ~5.585 = 5.747`, `springConstant ≈ 0.0249`. Bar 2 renders with its quarters slightly wider per unit force than bar 1.
- Bar 1's info is now stale: it still has `computedWithMinDuration = 30`, but the system min is 20.

**Inside `_fitSystem(system)`:**
- `reconcileMinDurationIfDirty()` is dirty. Iterate `masterBarsRenderers`:
  - bar 1: `computedWithMinDuration = 30 > 20`. Call `bar1.layoutingInfo.recomputeSpringConstants(20)`. Now bar 1's quarter springs use the same `phi = 5.747`, `springConstant ≈ 0.0249`. `version → 2`.
  - `bar1Renderer.applyLayoutingInfo()`. Version guard: `_appliedLayoutingInfo = 1 < 2`. **Runs.**
    - `_scaleToForce(max(stretchForce, info.minStretchForce))` — `minStretchForce` changed (because spring constants changed), so different force, different per-beat positions, different `voiceContainer.width`.
    - `_postBeatGlyphs.x` shifted right.
    - `this.width` and `this.computedWidth` increase to match bar 2's spacing.
  - bar 2: `computedWithMinDuration = 20 == 20`, no recompute. `applyLayoutingInfo` still runs in the reconcile loop, but `version` unchanged → version guard short-circuits → fast no-op.
- After the loop, `system.width / computedWidth / totalFixedOverhead / totalContentWidth` rebuilt from refreshed bar widths.

**Before reconcile** (what would render without it): bar 1's quarters at ~30-tick-derived springConstant, narrower; bar 1 visually shorter than bar 2; same-duration notes between bars do not column-align. After reconcile: both bars use the same `phi`, quarters align.

**If we remove the version guard entirely:** identical visual output, because bar 2's redundant `applyLayoutingInfo` call still produces the same values. The guard's only effect is to skip the redundant work on bar 2 (and on any other staff renderer of bar 2).

---

## 5. Architectural implications for v2 §E Step 8

v2 §E proposes eliminating the version guard by ensuring `applyLayoutingInfo` is called exactly once per renderer per stable `BarLayoutingInfo`. Two requirements emerge:

**8a — intra-`doLayout` renderer-local idempotency.** During system assembly, `_applyLayoutAndUpdateWidth` calls `applyLayoutingInfo` on each staff's last bar (`StaffSystem.ts:553`). With the guard removed, this still works because `applyLayoutingInfo` is value-idempotent (§3). The 8a requirement is satisfied by current code — no changes needed beyond removing the guard.

**8b — system-close re-application after reconcile.** This is the hard one. `reconcileMinDurationIfDirty` must:
- (i) re-derive spring constants for bars whose `computedWithMinDuration` is stale, and
- (ii) re-run `applyLayoutingInfo` on every renderer of those bars (because their info-derived widths changed).

The current implementation re-runs `applyLayoutingInfo` on *all* renderers in the loop and relies on the version guard to skip clean ones (`StaffSystem.ts:463-464`). Without the guard, the same loop becomes correct but wasteful. **The cleanup**: have `reconcileMinDurationIfDirty` check the per-info `computedWithMinDuration > minDuration` condition *before* deciding to re-apply, and only re-apply on the bars it actually re-derived:

```
for mb in masterBarsRenderers:
    if mb.layoutingInfo.computedWithMinDuration > this.minDuration:
        mb.layoutingInfo.recomputeSpringConstants(this.minDuration)
        for r in mb.renderers:
            r.applyLayoutingInfo()
    // width accumulation must still happen for all bars
    ...
```

This removes the dependency on the version guard cleanly. Verdict: **8a + 8b as proposed are sufficient**, with the small refinement that 8b must move the "should I re-apply?" predicate out of `applyLayoutingInfo` (where the guard lived) into the reconcile loop itself.

**Is there a third path?** A two-pass-per-system model — collect all bars, then call `finish` + `applyLayoutingInfo` exactly once per renderer after the system is closed — would eliminate the dirty flag entirely. But it would also force `addBars` to defer width computation (it currently feeds `system.width >= maxWidth` in the system-full check at `VerticalLayoutBase.ts:503`). The incremental width feedback during assembly is load-bearing for the "did this bar push us over the page width?" decision; a two-pass model would need a different way to estimate "would this bar fit?" before the final `applyLayoutingInfo`. This is a larger refactor than 8a/8b and not justified just to kill the guard. **Recommendation: stick with 8a + 8b.**

---

## 6. The "Coordinate phase as single seal point" claim

v2 wants Coordinate to be the sole sealing point for cross-bar state. In current code, the sequence inside `_fitSystem` is:

1. (`addBars` × N during assembly) — for each bar, `_applyLayoutAndUpdateWidth` already called `applyLayoutingInfo` on the bar's renderers using whatever spring constants the info had at that moment.
2. `system.reconcileMinDurationIfDirty()` — may bump info versions and re-apply.
3. `_scaleToWidth(system, ...)` — distribute width.
4. `system.finalizeSystem()` — staff bracket positions, etc.

**The seal happens after the first round of `applyLayoutingInfo` calls.** If v2's Coordinate phase fires only once per system, it has to fire *after* step 2 (so that re-derived spring constants are in effect) — i.e., Coordinate must be downstream of reconcile, not upstream. That's fine in principle, but Coordinate-phase consumers that need per-bar widths during system assembly (e.g., the systemFull check) cannot wait for it.

**Concrete recommendation for v2:** Coordinate cannot be a "single firing at end of doLayout" if it owns the spring/min-duration reconcile. Either:

- (A) Split into two Coordinate sub-phases: `Coordinate.preFit` (runs after each `addBars` to feed the `systemFull` check) + `Coordinate.postFit` (runs once after reconcile, owns final widths). This is essentially what the current code does, just renamed.
- (B) Keep `applyLayoutingInfo` callable mid-doLayout but treat it as a renderer-local utility (idempotent on stable info), with Coordinate firing exactly once after reconcile. The current incremental width totals (`_applyLayoutAndUpdateWidth`) survive as a Coordinate-internal helper rather than as a user-facing seal.

Either way, **v2 needs an explicit "re-seal after reconciliation" step**, or it needs to admit that the seal is two-phase (assembly seal + post-reconcile seal). The single-seal claim in v2 §E as currently written is too strong.

---

## 7. Test fixtures that exercise the path

All in `packages/alphatab/test/visualTests/features/SystemSpacing.test.ts`, using alphaTex inline strings (no `.gp` files needed):

| Fixture | Exercises | Hits `isMinDurationDirty = true` path? |
|---|---|---|
| `shared-min-duration-aligns-same-duration-notes` (`SystemSpacing.test.ts:41`) | bar 1 quarters then bar 2 with 128th-triplet — the core dirty-flag case | yes |
| `shared-min-duration-reconciles-on-resize` (`SystemSpacing.test.ts:63`) | same content, narrower canvas — guards reconcile under resize | yes |
| `shared-min-duration-shorter-note-first` (`SystemSpacing.test.ts:87`) | shortest note in bar 1 — eager-recompute path | **no** (dirty flag never set) |
| `shared-min-duration-multiple-short-arrivals` (`SystemSpacing.test.ts:110`) | two successive shortenings 30→20→15 ticks across four bars | yes (and re-asserted) |
| `shared-min-duration-per-system-isolation` (`SystemSpacing.test.ts:149`) | two two-bar systems, only the second triggers dirty | yes (one of two systems) |
| `shared-min-duration-page-automatic` (`SystemSpacing.test.ts:172`) | same content under `LayoutMode.Page` Automatic | yes |
| `shared-min-duration-horizontal-preserves-local` (`SystemSpacing.test.ts:193`) | Horizontal layout opts out via `shareMinDurationAcrossBars = false` | **no** (dirty flag path is dead in horizontal) |
| `stretch-formula-duration-spacing` (`SystemSpacing.test.ts:214`) | single bar, three durations — pins the formula coefficient | **no** |

There is no unit test that directly asserts on `isMinDurationDirty` or `reconcileMinDurationIfDirty` — only the visual fixtures above. Removing the version guard should produce **byte-identical** PNGs for all of these (because `applyLayoutingInfo` is value-idempotent in the no-version-change branch).

---

## File-line index

- `packages/alphatab/src/rendering/staves/StaffSystem.ts:230` — `minDuration` field
- `packages/alphatab/src/rendering/staves/StaffSystem.ts:238` — `isMinDurationDirty` field
- `packages/alphatab/src/rendering/staves/StaffSystem.ts:248` — `shareMinDurationAcrossBars` flag
- `packages/alphatab/src/rendering/staves/StaffSystem.ts:420-437` — `_trackSystemMinDuration` (where dirty flag is set)
- `packages/alphatab/src/rendering/staves/StaffSystem.ts:446-491` — `reconcileMinDurationIfDirty`
- `packages/alphatab/src/rendering/staves/StaffSystem.ts:553` — `_applyLayoutAndUpdateWidth`'s `applyLayoutingInfo` call (intra-assembly)
- `packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts:42` — `version` field
- `packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts:65` — `computedWithMinDuration`
- `packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts:240-262` — `finish()`
- `packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts:274-278` — `recomputeSpringConstants`
- `packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts:372-385` — `_calculateSpringConstant` (the Gourlay formula)
- `packages/alphatab/src/rendering/BarRendererBase.ts:510` — `_appliedLayoutingInfo` field
- `packages/alphatab/src/rendering/BarRendererBase.ts:525-551` — `applyLayoutingInfo` and the version guard
- `packages/alphatab/src/rendering/ScoreBarRenderer.ts:151-166` — override (extra multi-voice overflow registration)
- `packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts:407-419` — `_fitSystem` (only caller of `reconcileMinDurationIfDirty`)
- `packages/alphatab/src/rendering/layout/HorizontalScreenLayout.ts:76` — opt-out switch
- `packages/alphatab/test/visualTests/features/SystemSpacing.test.ts:40-234` — every fixture that exercises (or deliberately avoids) the path

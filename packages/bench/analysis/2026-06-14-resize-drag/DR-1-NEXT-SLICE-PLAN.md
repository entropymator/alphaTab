# DR-1 next slice — stable-packing system-pack skip

**Status**: open, not started.
**Target**: `feature/perf` HEAD `1a4238cb`.
**Scenario**: `canon-resize-drag` (post-EW-11 baseline 232.26 ± 1.67 ms — σ = 0.72 %).
**Authoritative σ baseline**: `packages/bench/baselines/post-EW11.json`.
**Aggregated top-30**: `packages/bench/runs/post-EW11/canon-resize-drag/TOP30.md`.
**Decision floor**: ★ Δ ≤ -3.34 ms paired A/B at n=64 (≥ 2σ).
**Author rule**: read top-to-bottom before touching code. The Phase 0 instrumentation in §5 is the single load-bearing input for option choice — do NOT skip it. The anti-revert directives in §8 are not optional.

---

## 1. Goal & framing (plain English)

### 1.1 What we're trying to do

**Goal**: on resize cycles where the bar-to-system packing decision would land identically to the previous resize, skip the system-rebuild loop entirely. Reuse the existing `_systems[]` tree, walk it once to update per-system widths and per-renderer x positions, and repaint. Avoid the `RenderStaff` construction, the `addBarRenderer × N` cascade (which fires `reLayout` and broker writes), the `_scaleToForce` per-renderer work, and the per-system `placeAndApply` rebuild.

The `canon-resize-drag` drag sequence (widths `1400 → 1300 → 1200 → 1100 → 1000 → 900 → 800 → 700 → 600 → 650 → 750 → 850`) cycles through multiple **stable-packing zones** — width ranges where the same bars land in the same systems. Within a stable-packing zone, only width-derived per-bar geometry needs to update (`actualBarWidth = mb.maxFixedOverhead + weight * contentShare`). Everything structural is invariant.

### 1.2 Where this fits in DR-1

DR-1 (`HOTSPOTS.md:265`) is "Resize re-walks every bar even when only the viewport width changed". It is being progressively captured in three sub-slices:

| Sub-slice | Status | Commit | Paired A/B Δ |
|---|---|---|---|
| Overflow / `calculateOverflows` skip | landed (EW-9 Variant B) | `bfcd943f` | -9.69 ms |
| Broker-lifecycle / `_voiceWalkDone` walk-skip | landed (DR-1 v2) | `eddf9bc1` | -6.08 ms |
| **Stable-packing system-pack skip (THIS PLAN)** | **open** | — | **5-10 ms estimated** |

This is the third and largest remaining slice of DR-1. EW-9 Variant B captured the bar-local overflow re-walk; DR-1 broker-lifecycle captured the cross-stave broker re-walk; the stable-packing slice captures the **system-rebuild layer** that sits above both.

### 1.3 Why this is NOT an EW candidate

Per `AGENT_WORKFLOW.md`: "Easy win = single file, no public API change, no semantic change." This work fails all three checks:

- **Multi-file**: touches `VerticalLayoutBase.ts` (the rebuild loop), almost certainly `ScoreLayout.ts` (caching surface for prior packing decisions), possibly `StaffSystem.ts` (a per-system "width was assigned, don't re-pack" path), and reaches into `BarRendererBase.ts` for the per-renderer x/width update path.
- **Semantic change**: the resize contract changes — `doResize` no longer rebuilds `_systems[]` unconditionally. Any future caller relying on the rebuild (e.g. assuming `addMasterBarRenderers` fires once per cycle) breaks.
- **Public API risk**: `StaffSystem` is `@internal` but reaches through `system.masterBarsRenderers`, `system.width`, `system.computedWidth`, and per-renderer `x`/`width` — every consumer that observes those during paint is implicitly part of the contract.

Lands under HOTSPOTS.md "**Major refactors — landed**" (the section the DR-1 broker-lifecycle slice opened at `eddf9bc1`).

### 1.4 Numerical envelope

| Quantity | ms/iter | Source |
|---|---:|---|
| Post-EW-11 baseline median | 232.26 | `baselines/post-EW11.json` (5-trial, host-clean) |
| Cross-trial σ | ±1.67 (0.72 %) | same |
| 2σ ≈ `★` resolution threshold | 3.34 | derived |
| 1 % CPU floor | 2.32 | derived |
| `_scaleToForce` (per-renderer) | 7.86 (#6, 2.82 %) | TOP30 |
| `applyLayoutingInfo` (per-renderer) | 4.60 (#12, 1.65 %) | TOP30 |
| `scaleToWidth` (per-renderer) | 3.59 (#17, 1.29 %) | TOP30 |
| `placeAndApply` (per-system) | 3.11 (#21, 1.11 %) | TOP30 |
| `getBeatX` | 3.14 (#20, 1.12 %) | TOP30 (only partially in the rebuild path) |
| Combined system-rebuild surface | ~23 ms | sum of above × system count factor |
| **Stable-packing slice target** | **≥ -3.34 ms paired (`★`)** | ≥ 2σ floor |

The per-renderer hotspots (`_scaleToForce`, `applyLayoutingInfo`, `scaleToWidth`) all fire **inside** the `addMasterBarRenderers`→`reLayout`→broker chain that the system-rebuild loop triggers. Skipping the rebuild deletes all three calls per renderer per cycle within stable-packing zones.

### 1.5 Acknowledged outcome possibilities

This plan may **not** land. Documented falsification is an acceptable outcome:

- Phase 0 may surface low stable-packing rates on the `canon-resize-drag` width sequence, capping the optimisation below σ.
- The repack-detection predicate may be more expensive than the savings it enables.
- The interaction with the three already-landed caches (`_layoutInvariantCached` from EW-9 Variant B, `_voiceWalkDone` from DR-1 broker-lifecycle, `_accoladeVisibilityFingerprint` on `StaffSystem`) may surface visual fixture failures that resist tightening.

§10 documents the falsification path. The 0-output round outcome is "DR-1 stable-packing slice attempted; [Phase 0 / option matrix] surfaced [structural fact X] that caps the slice below ≥ 2σ at this codebase shape".

---

## 2. Architectural map

### 2.1 Resize entry point

`ScoreRenderer.resizeRender()` → `ScoreLayout.resize()` → `VerticalLayoutBase.doResize()` (`VerticalLayoutBase.ts:140`).

`doResize` is short: it walks the page top-to-bottom (`_layoutAndRenderScoreInfo` → `_layoutAndRenderTunings` → `_layoutAndRenderChordDiagrams` → `_resizeAndRenderScore` → bottom info → annotation) and re-emits everything. Only **`_resizeAndRenderScore` is in scope for this plan** — the score-info / tunings / annotation calls are O(1) per resize.

### 2.2 The system-pack rebuild loop

`VerticalLayoutBase._resizeAndRenderScore` (`VerticalLayoutBase.ts:281-350`). Two branches:

```
281: private _resizeAndRenderScore(y, oldHeight): number {
283:     const barsPerRowActive = this.getBarsPerSystem(0) > 0;
284:     this._systemPartialIds = [];
285:     if (barsPerRowActive) {
286:         // FIXED-BARS BRANCH: refit existing systems in place.
287:         for (let i = 0; i < this._systems.length; i++) {
288:             const system = this._systems[i];
289:             system.width = system.computedWidth;
290:             this._fitSystem(system);
291:             y += this._paintSystem(system, oldHeight);
292:         }
293:     } else {
294:         // PACKING BRANCH: rebuild every system from scratch.
295:         for (const r of this._allMasterBarRenderers) {
296:             for (const b of r.renderers) {
297:                 b.afterReverted();
298:             }
299:         }
300:
301:         this._systems = [];
302:         ... [rebuild loop: see below] ...
348:     }
349:     return y;
350: }
```

**The fixed-bars branch already implements approximately what we want** — it reuses `_systems[]` and re-fits each system at `system.computedWidth`. The packing branch is the one that needs the stable-packing skip.

Inside the packing-branch rebuild loop (lines 302-347):

```
302:     let currentIndex = 0;
303:     const maxWidth = this._maxWidth;
304:     let system = this.createEmptyStaffSystem(this._systems.length);
305:     system.x = pagePadding[0];
306:     system.y = y;
307:     while (currentIndex < this._allMasterBarRenderers.length) {
308:         let renderers = this._allMasterBarRenderers[currentIndex];
309:         if (system.width + renderers.width <= maxWidth || system.masterBarsRenderers.length === 0) {
310:             system.addMasterBarRenderers(this.renderer.tracks!, renderers!);
311:             currentIndex++;
312:             if (this._needsLineBreak(currentIndex)) system.isFull = true;
313:         } else {
314:             while (renderers && !renderers.canWrap && system.masterBarsRenderers.length > 1) {
315:                 renderers = system.revertLastBar();
316:                 currentIndex--;
317:             }
318:             system.isFull = true;
319:         }
320:         if (system.isFull) {
321:             system.isLast = this.lastBarIndex === system.lastBarIndex;
322:             this._systems.push(system);
323:             this._fitSystem(system);
324:             y += this._paintSystem(system, oldHeight);
325:             system = this.createEmptyStaffSystem(this._systems.length);
326:             system.x = pagePadding[0];
327:             system.y = y;
328:         }
329:     }
330:     if (system.masterBarsRenderers.length > 0) {
331:         system.isLast = this.lastBarIndex === system.lastBarIndex;
332:         this._systems.push(system);
333:         this._fitSystem(system);
334:         y += this._paintSystem(system, oldHeight);
335:     }
```

Per-iteration cost components:

- **`afterReverted` for every renderer** (line 297): clears `staff`, `isFinalized`. Cheap.
- **`createEmptyStaffSystem`** (line 304, ~per-system): allocates `StaffSystem` + `StaffTrackGroup` per track + `RenderStaff × N`. ~0.087 kB/system × ~6 systems = small heap; constructor cost is `addStaff × N`.
- **`addMasterBarRenderers`** (line 310): the hot path. Per call:
  - Resets `info.preBeatSize = 0` (the load-bearing reset DR-1 broker-lifecycle navigates).
  - Walks every stave's renderer via `s.addBarRenderer(renderer)` → `renderer.reLayout()`.
  - Calls `_calculateAccoladeSpacing(tracks)`.
  - Calls `_trackSystemMinDuration(renderers.layoutingInfo)`.
  - Calls `_applyLayoutAndUpdateWidth()` which runs `applyLayoutingInfo` on every stave's last renderer.
- **`_fitSystem`** (lines 323/333, 1×/system): runs `reconcileMinDurationIfDirty` + `_scaleToWidth(system, maxWidth or system.width)` + `system.finalizeSystem()`.
- **`_paintSystem`** (lines 324/334, 1×/system): runs `system.buildBoundingsLookup(0,0)` and registers the paint partial.

### 2.3 What's hot inside the loop

From `TOP30.md` (5-trial aggregate):

| # | Self ms/trial | Function | Per-resize cycle (12 widths × 8 iter / 5 trials = factor ≈ 19) |
|---:|---:|---|---:|
| 6 | 55.05 ms | `_scaleToForce` (MultiVoiceContainerGlyph) | ≈ 2.9 ms / resize-cycle |
| 12 | 32.19 ms | `applyLayoutingInfo` (MultiVoiceContainerGlyph or similar) | ≈ 1.7 ms / cycle |
| 17 | 25.12 ms | `scaleToWidth` (BarRendererBase) | ≈ 1.3 ms / cycle |
| 21 | 21.79 ms | `placeAndApply` (EffectSystemPlacement) | ≈ 1.1 ms / cycle |
| 11 | 38.30 ms | `buildBoundingsLookup` | ≈ 2.0 ms / cycle (paint-time, NOT skipped) |
| 23 | 21.35 ms | `_computeBeamingBounds` (LineBarRenderer) | ≈ 1.1 ms / cycle |

The four red rows (`_scaleToForce`, `applyLayoutingInfo`, `scaleToWidth`, `placeAndApply`) fire inside the `addMasterBarRenderers → reLayout` → `_fitSystem._scaleToWidth → renderer.scaleToWidth → voiceContainer.scaleToWidth → _scaleToForce` chain. Each is per-renderer or per-system, multiplied by the system count.

Within a stable-packing zone, these chains still need to re-run **because width changes** — `actualBarWidth` is width-derived, so per-bar geometry must update. But the **structural skeleton** (which bars belong to which system, the system count, the system-to-y mapping) is invariant. The optimisation skips the structural rebuild and keeps the geometry refresh.

### 2.4 Interaction with the three already-landed caches

The DR-1 stable-packing slice sits on top of three caches that ALREADY survive per-resize work:

#### 2.4.1 `_layoutInvariantCached` (EW-9 Variant B, `bfcd943f`)

Located on `BarRendererBase` (`BarRendererBase.ts:557`). Gates the `calculateOverflows` re-walk. Cleared by `recreatePreBeatGlyphs` (wrap-flip) and `invalidateLayoutCache` (Phase 4 hook). Survives `afterReverted` (the entire point).

Interaction with stable-packing: orthogonal. The cache lives on the renderer, not the system. Even if we skip the system-rebuild, individual renderers still consult this flag inside their own `reLayout` chain — but we wouldn't call `reLayout` on a stable-packing skip. So the flag stays untouched.

#### 2.4.2 `_voiceWalkDone` (DR-1 broker-lifecycle, `eddf9bc1`)

Located on `BarRendererBase` (`BarRendererBase.ts:465`). Gates the expensive voice-container walk inside `_registerLayoutingInfo`. Cleared by no explicit invalidation event today (intentionally — `afterReverted` fires every cycle and would defeat the optimisation).

Interaction with stable-packing: orthogonal but related. Both attack DR-1 but at different layers:
- `_voiceWalkDone` skips the broker write walk inside `_registerLayoutingInfo` IF `reLayout` is called.
- Stable-packing skips the `reLayout` call entirely (and therefore the broker write, the cheap pre/postBeatSize pair, and the `addMasterBarRenderers` cascade).

If stable-packing skips the cycle, `_voiceWalkDone` is not consulted that cycle. Cache coherence is preserved by construction.

#### 2.4.3 `_accoladeVisibilityFingerprint` (StaffSystem, no-commit reference)

Located on `StaffSystem` (`StaffSystem.ts:171`). Gates the expensive `_calculateAccoladeSpacing` (track-name `measureText`, brace scale recomputation). Triggered by visibility changes.

Interaction with stable-packing: friendly. Visibility doesn't change on width-only resize, so the fingerprint already short-circuits — but `addMasterBarRenderers` still runs its per-stave loop to get to the fingerprint check. Skipping the rebuild deletes the per-stave loop entirely.

### 2.5 The width-projection step (what survives the skip)

If we skip the system-rebuild, **the things that still need to update per resize**:

1. **Per-system width**: `system.width` must move to reflect the new available width (or stay at `system.computedWidth` if it's a partial-last system that doesn't justify).
2. **Per-bar `actualBarWidth`**: `mb.maxFixedOverhead + weight * contentShare` is width-derived (`weight * contentShare` changes when `staffWidth` changes).
3. **Per-renderer x within the system**: walks left-to-right summing `actualBarWidth`. Width-derived.
4. **Per-renderer `_scaleToForce`**: spring distribution changes with force, which changes with available staff width.
5. **`finalizeSystem`**: per-system bracket/brace re-finalize. The accolade-visibility cache already protects this; need to verify it stays correct.
6. **`placeAndApply`** (effect bands): currently runs per system inside `finalizeStaff`. Effect band y-positions depend on the staff skyline which depends on per-bar widths. Likely still needs to run — but the per-renderer scratch buffers may amortise better.
7. **`_paintSystem`**: bounding-box rebuild from absolute pixel coordinates. **Width changes invalidate every BoundsLookup entry** (per prior observation 17370). Paint must re-run.

What CAN be skipped:

- `createEmptyStaffSystem` (no system allocation).
- `addMasterBarRenderers` loop (the per-stave `addBarRenderer` cascade and the broker-reset → broker-write chain — already partly captured by DR-1 broker-lifecycle but the cascade itself is still skipped).
- `_calculateAccoladeSpacing` (the fingerprint check survives but the call itself is skipped on visibility-stable systems).
- `_trackSystemMinDuration` and `reconcileMinDurationIfDirty` (per-system min-duration tracking — already cached but invocation is skipped).
- Per-renderer `applyLayoutingInfo` reads from the broker — these still run if we re-call `scaleToWidth` per renderer. But the broker writes are skipped.

The cleanest way to think about the saving: **for each existing system, replace the `addMasterBarRenderers × N + _fitSystem` chain with just `system.width = newWidth; _scaleToWidth(system, newWidth); finalizeSystem()`.** The existing `system.allStaves[].barRenderers[]` and `system.masterBarsRenderers[]` arrays are reused as-is.

### 2.6 Why the fixed-bars branch is the proof of concept

The `barsPerRowActive` branch (lines 286-292) already does almost exactly this:

```
for (let i = 0; i < this._systems.length; i++) {
    const system = this._systems[i];
    system.width = system.computedWidth;
    this._fitSystem(system);
    y += this._paintSystem(system, oldHeight);
}
```

This branch fires only when the user has set a fixed bars-per-row (`barsPerRowActive === true`). The packing is structurally identical across widths because every system has the same N bars regardless of width. The branch:

- Does NOT call `afterReverted` (the `_systems[]` are kept intact).
- Does NOT call `addMasterBarRenderers` (existing bars stay in existing systems).
- DOES re-fit each system at its `computedWidth` (line 289 — assigns the original layout width, then `_fitSystem` calls `_scaleToWidth(system, this._maxWidth)` if `system.width > maxWidth` or `justifyLastSystem`, else `_scaleToWidth(system, system.width)`).
- DOES re-paint (line 291 — `_paintSystem` runs `buildBoundingsLookup` and registers the partial).

**Open question Phase 0 must answer**: does `_fitSystem` in this branch correctly redistribute per-bar widths for the new viewport width? Reading the code: line 289 sets `system.width = system.computedWidth` (the original packed width), and `_fitSystem` then calls `_scaleToWidth(system, this._maxWidth)` IF `system.width > this._maxWidth` OR `justifyLastSystem`. Otherwise it scales to `system.width = computedWidth` (no re-stretch).

This is suspicious. If the user is on a wider viewport than `computedWidth`, the branch doesn't stretch the system unless `justifyLastSystem` is true. Phase 0 needs to verify whether this is correct behavior or a latent bug — the answer affects whether we can lift this branch's skeleton directly into the packing branch.

### 2.7 Wrap-flip and other invalidation events

The set of events that must invalidate any stable-packing cache:

1. **Width crosses a packing-decision threshold.** When width drops below the threshold where a bar wraps from system_i to system_{i+1}, packing changes.
2. **Model mutation.** Any `Bar.voices[].beats[]` change → fresh `doLayout` chain → new renderer instances. Existing `_systems[]` are stale.
3. **`updateForBars` partial relayout.** Already takes the `_layoutAndRenderScore` (non-resize) path which rebuilds. Stable-packing cache should be invalidated on entry.
4. **Visibility change (`hideEmptyStaves`).** Could affect accolade width, which affects available staff width, which affects packing thresholds.
5. **Settings change.** Stretch force, justification, etc.
6. **Lazy-loading partial visibility.** When `enableLazyLoading` toggles a system's visibility, the system tree is mutated.

The cache invalidator's primary trigger is "width crosses a packing threshold". The other five are model/configuration mutations and are detected at their source.

---

## 3. The stable-packing fingerprint

### 3.1 What makes two packings identical?

The packing loop at lines 307-329 walks bars in order. Decision per bar:

- If `system.width + renderers.width <= maxWidth` (the running system has room) → add to current system.
- Else → mark current system full, start new system.

Two width values produce the **same** packing decisions iff at every bar boundary, the decision (`fit-in-current-system` vs `start-new-system`) is the same.

**Critical fact**: `renderers.width` is **NOT** width-invariant. Each `MasterBarsRenderers.width` reflects the bar's natural content width as computed inside `addMasterBarRenderers` → `_applyLayoutAndUpdateWidth`, which calls `applyLayoutingInfo` (broker-derived).

But the broker outputs (springs, `_beatSizes`, `_minDuration`, etc.) are width-invariant. So `renderers.width` is width-invariant **modulo** the brokered values.

This means the packing-decision predicate is:

> for each system_i in the prior packing:
>   `sum(renderers[j].width for j in system_i.bars) + accoladeWidth <= newMaxWidth`?
>   AND
>   the bar AFTER system_i's last bar does NOT fit in system_i (else packing changes).

If both hold for every i, the same packing emerges.

### 3.2 The cheap predicate

For each existing system_i:

- `lower_i = sum_of_natural_bar_widths + accoladeWidth` (would system_i still fit at this width?).
- `upper_i = lower_i + next_bar_natural_width - epsilon` (would the next bar still NOT fit at this width?).

If `newWidth ∈ [lower_i, upper_i)` for every system i, packing is stable.

For the last system, `upper` is `+∞` (no next bar to push out).

**Predicate cost**: O(N_systems) per resize — a single walk summing per-system widths, comparing two numbers per system. Cheap.

**Predicate correctness**: depends on `renderers.width` being width-invariant. Per §3.1, this is true MODULO the broker. Phase 0 verifies this empirically.

### 3.3 Open question: does `renderers.width` actually stay stable?

`renderers.width` is set in two places:
- `_applyLayoutAndUpdateWidth` (`StaffSystem.ts:604`): `this.width += realWidth;` where `realWidth` is the max `last.computedWidth` across staves.
- `revertLastBar` (`StaffSystem.ts:555`): decremented when a bar moves back.

`last.computedWidth` is set inside `applyLayoutingInfo` (`BarRendererBase.ts:532`): `this.computedWidth = this.width;` where `this.width` is the post-`scaleToWidth` width (line 386).

`scaleToWidth(width)` accepts a width parameter. So `computedWidth` reflects the width the renderer was last scaled to.

**This is the open question Phase 0 must close**: when `addMasterBarRenderers` is called at resize, what width does `applyLayoutingInfo` produce? Reading the call chain:

1. `addMasterBarRenderers` (line 288) is called from `_resizeAndRenderScore` (line 310).
2. It calls `s.addBarRenderer(renderer)` → `renderer.reLayout()`.
3. Then it calls `_applyLayoutAndUpdateWidth()` which calls `last.applyLayoutingInfo()`.
4. `applyLayoutingInfo` (line 517) computes width from the broker:
   - `_preBeatGlyphs.width = info.preBeatSize`
   - `container.applyLayoutingInfo(info)` — which calls `_scaleToForce(info.minStretchForce, false)` — which calls `calculateVoiceWidth(force)` (broker-derived).
   - `_postBeatGlyphs.width = info.postBeatSize`
   - `this.width = ceil(postBeatX + _postBeatGlyphs.width)`
   - `this.computedWidth = this.width`

So `applyLayoutingInfo` produces a width that depends on `info.minStretchForce` (a broker constant), the broker's pre/postBeatSize, and the spring-derived `calculateVoiceWidth(minStretchForce)`. **All broker-derived inputs are width-invariant.** Therefore `renderers.width` after `applyLayoutingInfo` is width-invariant.

**But there's a subtlety**: `renderers.width` is then INCREMENTED by `_applyLayoutAndUpdateWidth` into `system.width` (and into `mb.width`). The per-bar `mb.width` is stable across resizes IFF the broker is stable. The DR-1 broker-lifecycle slice already verified the broker IS stable.

**Phase 0 must verify this is empirically true**: instrument `_applyLayoutAndUpdateWidth` to log `mb.width` per masterbar per resize cycle; expect every value to be byte-identical to the value from initial layout.

### 3.4 What changes when wrap-flip happens

When a bar moves from mid-line to line-leading or vice versa:
- `recreatePreBeatGlyphs` fires → `_preBeatGlyphs.width` changes (clef, key sig, etc. appear or disappear).
- `info.preBeatSize` is recomputed by `_registerLayoutingInfo` (the cheap pair).
- `applyLayoutingInfo` reads the new `info.preBeatSize` → new `renderer.width` → new `mb.width`.

**Wrap-flip is THE invalidation event for stable-packing**. When any bar's `isFirstOfStaff` changes, packing has flipped — by definition. The fingerprint check (§3.2) catches this: if the bar that was line-leading is now mid-line, its `mb.width` shrinks, the per-system sum changes, the predicate fails, and we fall through to the full rebuild.

The predicate handles wrap-flip detection structurally. We don't need an explicit `wasFirstOfStaff` check.

### 3.5 The force-bucket alternative

Alternative predicate: "if the force value computed by `spaceToForce(newStaffWidth)` falls in the same bucket as the previous force, packing is stable."

Why this might work: force determines per-bar width via `calculateVoiceWidth(force)`. If force is in the same bucket, per-bar widths are approximately the same, so the packing decision is the same.

Why it likely doesn't: force is **per-system**, not global. Each system has its own `BarLayoutingInfo` brokers with its own `totalSpringConstant`. So bucketing force isn't straightforward — we'd need a per-system bucket, which converges to §3.2's predicate.

§3.2 is more direct and avoids the bucketing abstraction.

### 3.6 Membership-only repack (Option C — §4)

A third option: re-run the packing loop on each resize, but only mutate `_systems[]` when membership changes. Reuse existing `RenderStaff` instances when packing is stable; rebuild when membership differs.

Pros: handles all the edge cases automatically (the packing loop IS the ground truth).
Cons: still pays the packing-loop O(bars) cost every cycle. The predicate in §3.2 short-circuits before the loop runs.

§3.2 is the primary; §3.6 is a fallback if §3.2 has correctness issues.

---

## 4. Option matrix

### 4.1 Option A — width-range cache (§3.2 predicate)

**Shape**: After every full system rebuild, compute and cache `[lower_i, upper_i]` per system. On resize, check `newWidth ∈ ⋂_i [lower_i, upper_i]`. If yes, skip rebuild; just walk existing systems and call `_fitSystem` + `_paintSystem` for each.

**Risk profile**:
- Correctness: depends on `mb.width` being byte-identical across width changes (Phase 0 verifies).
- Cache invalidation: must invalidate on model mutation, settings change, visibility change.
- Cache invariance under EW-9/DR-1 broker-lifecycle: orthogonal — those gate per-renderer work, this gates system-level work.

**Blast radius**: `VerticalLayoutBase.ts` (rebuild loop + cache fields + predicate). Possibly `ScoreLayout.ts` (cache invalidation hooks for partial-layout entry points).

**Estimated Δ**: 5-10 ms paired A/B, IF stable-packing rate is ≥ 50 % on the drag sequence. Phase 0 measures this rate.

**Dependencies**: EW-9 Variant B + DR-1 broker-lifecycle landed (used to deduplicate cache flag responsibilities).

### 4.2 Option B — force-bucket cache (§3.5)

**Shape**: per-system bucket on `floor(spaceToForce(newStaffWidth) / bucketSize)`. Skip rebuild if bucket matches.

**Risk profile**: Bucket size tuning is fragile. If bucket too small, hit rate too low; if too large, false positives → visual regressions.

**Blast radius**: similar to A.

**Estimated Δ**: similar to A.

**Why deferred**: bucketing is an indirect predicate; §3.2's direct width-range is cleaner.

### 4.3 Option C — repack-but-don't-rebuild (§3.6)

**Shape**: re-run the packing loop on each resize, comparing bar-to-system membership against existing `_systems[]`. If membership identical, reuse existing `RenderStaff` instances (just call `_fitSystem` + `_paintSystem`). Else, fall through to full rebuild.

**Risk profile**:
- Correctness: the packing loop IS the ground truth, so this is robust.
- Cost: still pays O(bars) packing loop on every resize, which Phase 0 must measure to confirm it's not larger than the savings.

**Blast radius**: similar to A.

**Estimated Δ**: lower than A (still pays packing-loop cost), but more robust to edge cases.

**Why fallback**: Phase 0 may surface cases where the §3.2 predicate is fragile (e.g. `mb.width` not byte-identical for some bars due to a hidden write path). Option C absorbs those cases at the cost of the packing-loop O(bars).

### 4.4 Option D — per-system width-projection (no rebuild path)

**Shape**: drop the rebuild branch entirely; always assume packing is stable and re-project widths. Fall back to full rebuild only when an explicit invalidator fires (wrap-flip detected, model mutation, etc.).

**Risk profile**:
- The §3.2 predicate handles wrap-flip detection structurally. If we drop the predicate, we need an explicit invalidator — which doesn't exist for the "packing threshold crossed" case (there's no single event; it's a structural function of bar widths and viewport).
- Without the predicate, we'd over-skip and get visual regressions on packing-change cycles.

**Why deferred**: Option A's predicate is the natural fit; Option D is Option A with the predicate removed and replaced by guess-and-correct logic.

### 4.5 Decision matrix

| Predicate hit rate (Phase 0) | Primary | Fallback |
|---|---|---|
| > 50 % | Option A (width-range) | Option C (repack-detect) |
| 20-50 % | Option A still viable but marginal | Option C primary |
| < 20 % | Falsify and stop | — |

---

## 5. Phase 0 — empirical probes

**Non-negotiable.** No source change before this completes. Phase 0 outcome chooses the primary option and the decision floor.

### 5.1 What we need to know

1. **Stable-packing rate** on `canon-resize-drag`. For the 12 consecutive resize widths (1400 → 1300 → 1200 → 1100 → 1000 → 900 → 800 → 700 → 600 → 650 → 750 → 850), what fraction of consecutive width pairs produce identical bar-to-system packing? Upper bound on the optimisation.
2. **`mb.width` invariance under width change.** When packing IS stable, is `mb.width` byte-identical across consecutive widths? This is the §3.2 predicate's correctness premise.
3. **Per-system width contributions.** Compute per system: `sum(mb.width for mb in system) + accoladeWidth` ("packed width"); record at each width. If this is width-invariant when packing is stable, the predicate is robust.
4. **Layout-time vs paint-time cost breakdown.** What fraction of resize wall-clock is in the system-pack rebuild (the loop body at lines 302-347) vs `_paintSystem.buildBoundingsLookup`? The optimisation can only attack the former.
5. **Wrap-flip frequency.** For each bar across the 12 widths, how often does `isFirstOfStaff` flip? Each flip = packing change → predicate-miss event.

### 5.2 Probe 1 — packing fingerprint per resize

Instrument `_resizeAndRenderScore`:
- BEFORE the rebuild branch executes, snapshot `[system_i_first_bar_index, system_i_last_bar_index]` for every existing system in `_systems[]`.
- AFTER the rebuild completes, snapshot the same pair for every NEW system.
- Compare: if the two arrays are identical, this resize was stable-packing. Log: `[DR1-NS-pack] width=X stable=Y`.

**Pass criterion**: log shows the rate. Target ≥ 50 % stable for Option A primary.

### 5.3 Probe 2 — `mb.width` invariance

Same instrumentation hook. ALSO snapshot `mb.width` per masterbar per resize cycle. Compare against the previous resize's value:
- If packing was stable (Probe 1 logged `stable=Y`), `mb.width` MUST be byte-identical for every mb.
- If packing changed, `mb.width` MAY differ.

Log: `[DR1-NS-mbw] mb_index=I prev=W1 curr=W2 stable_packing=Y` (only emit when packing was stable AND values differ).

**Pass criterion**: zero `[DR1-NS-mbw]` mismatch lines when packing is stable. If non-zero, the §3.2 predicate has a hidden width-dependent write path; investigate before continuing.

### 5.4 Probe 3 — per-system packed-width invariance

Same hook. Snapshot `sum(mb.width for mb in system) + accoladeWidth` per system per resize.

Log mismatches: `[DR1-NS-sysw] sys_index=I prev=W1 curr=W2 stable_packing=Y`.

**Pass criterion**: zero mismatches when packing is stable.

### 5.5 Probe 4 — cost breakdown

In `_resizeAndRenderScore`, bracket the two regions:
- Region L (layout-rebuild): from line 302 to the end of the last `_fitSystem` call.
- Region P (paint): each `_paintSystem` call (separately summed).

Use `performance.now()` and accumulate. Log per resize: `[DR1-NS-cost] width=X L=L_ms P=P_ms`.

**Pass criterion**: if L is below 5 ms per resize, the optimisation upside is limited regardless of stable-packing rate. Document and reconsider.

### 5.6 Probe 5 — wrap-flip frequency

In `BarRendererBase.reLayout` (line 941), log when `wasFirstOfStaff !== isFirstOfStaff`:
- `[DR1-NS-wflip] bar_index=I width=X prev=P curr=C`

Aggregate at end of run: count of flips per bar across the 12 widths, and number of widths where ANY bar flipped.

**Pass criterion**: useful sanity check — flipping widths should align with packing-change widths from Probe 1. If they don't, the §3.2 predicate has an additional invariant we're missing.

### 5.7 Bench protocol

```bash
cd packages/bench
# Build with all 5 probes inlined into the alphatab sources (NOT committed).
npx vite build
# Single trial — drag scenario is 8 iterations × 12 widths = 96 resize cycles.
node dist/run.mjs --only canon-resize-drag --trials 1 --label DR1-NS-probe-2026XXXX \
  2>&1 | tee runs/DR1-NS-probe-2026XXXX.log
grep -E '^\[DR1-NS-' runs/DR1-NS-probe-2026XXXX.log > runs/DR1-NS-probe-2026XXXX.csv
```

Analyse the CSV:
- Stable-packing rate = `count(stable=Y) / count(*)` over the 12 widths × 8 iter run.
- Per-bar wrap-flip count = aggregate from Probe 5.
- L/P cost breakdown = average from Probe 4.

### 5.8 Decision rule

Read the CSV. Apply §4.5 decision matrix.

| Outcome | Action |
|---|---|
| Probe 1 stable-packing rate > 50 % AND Probe 2/3 zero mismatches AND Probe 4 L > 5 ms | Option A primary; proceed to §6 |
| Probe 1 in 20-50 % AND Probe 2/3 zero mismatches | Option C primary; proceed to §6 (re-shape sketch around Option C) |
| Probe 1 < 20 % | Falsify; document in §10 |
| Probe 2 OR Probe 3 non-zero mismatches when packing stable | Investigate hidden width-dependent path; predicate may need a tighter invariant or Option C as primary |
| Probe 4 L < 5 ms | Falsify or re-target: the rebuild loop is cheaper than expected |

### 5.9 Phase 0 exit checklist

- [ ] Instrumentation patch produced a log at `packages/bench/runs/DR1-NS-probe-*/log`
- [ ] Probe 1 stable-packing rate captured
- [ ] Probe 2/3 mismatches verified zero (or documented if not)
- [ ] Probe 4 L/P breakdown captured
- [ ] Probe 5 wrap-flip frequency captured and cross-validated against Probe 1
- [ ] Decision row chosen and rationale recorded
- [ ] Instrumentation patch REVERTED (do not ship)
- [ ] WIP doc commit allowed: `docs(bench): DR-1 next-slice Phase 0 — empirical probes`

---

## 6. Phase 1 — build the cache (no skip)

**Hard rule**: Phase 1 is correctness-only. The skip is OFF.

### 6.1 Goal

Implement the predicate's data structures and the cache-population code path on every full rebuild. Verify it produces a deterministic, replayable fingerprint per resize. The skip itself is Phase 2.

### 6.2 Shape sketch (Option A primary)

In `VerticalLayoutBase.ts`:

```
private _lastPackingFingerprint: { systemId: number, mbIndices: number[], packedWidth: number }[] | null = null;
private _lastResizeMaxWidth: number = -1;

private _capturePackingFingerprint(): void {
    const fp: { ...; }[] = [];
    for (let i = 0; i < this._systems.length; i++) {
        const sys = this._systems[i];
        const mbIndices: number[] = [];
        let packedWidth = sys.accoladeWidth;
        for (const mb of sys.masterBarsRenderers) {
            mbIndices.push(mb.masterBar.index);
            packedWidth += mb.width;
        }
        fp.push({ systemId: i, mbIndices, packedWidth });
    }
    this._lastPackingFingerprint = fp;
    this._lastResizeMaxWidth = this._maxWidth;
}

private _isPackingStableAt(newMaxWidth: number): boolean {
    if (!this._lastPackingFingerprint) return false;
    for (let i = 0; i < this._lastPackingFingerprint.length; i++) {
        const fp = this._lastPackingFingerprint[i];
        const lower = fp.packedWidth;
        const upper = i + 1 < this._lastPackingFingerprint.length
            ? lower + this._lastPackingFingerprint[i + 1].mbIndices[0].width  // approx
            : Number.POSITIVE_INFINITY;
        if (newMaxWidth < lower || newMaxWidth >= upper) return false;
    }
    return true;
}
```

(The exact bounds derivation needs care — `upper_i` should be "the width at which system i+1's first bar would fit in system i", which requires the next bar's `mb.width`. Implementation detail in §6.4.)

At the end of `_resizeAndRenderScore`'s rebuild branch (after line 347), call `this._capturePackingFingerprint()` unconditionally.

### 6.3 What does NOT change in Phase 1

- The rebuild loop body (lines 302-347) runs EVERY cycle.
- The fingerprint is captured but never consulted (skip is OFF).
- This phase exists to verify the fingerprint is correctly populated and stable across cycles where packing IS stable.

### 6.4 Pitfalls to verify

- **Boundary at system_N (last system)**: upper bound is +∞; lower bound is `packedWidth`. Be careful with the empty-systems case.
- **`accoladeWidth` participation**: `system.accoladeWidth` is included in `packedWidth` per the existing `_scaleToWidth` formula. Verify the same formula is used in the predicate.
- **`justifyLastSystem` interaction**: if true, the last system stretches to `maxWidth`. The lower bound is still `packedWidth` (the system fits), but the upper bound is the same as non-last systems.
- **`_maxWidth` getter**: `scaledWidth - pagePadding[0] - pagePadding[2]`. Stable across resizes within a session.
- **Single-system case**: lower = packedWidth, upper = +∞. The predicate degenerates to `newMaxWidth >= packedWidth`. Correct.

### 6.5 Phase 1 exit checklist

- [ ] Fingerprint captured at end of rebuild branch
- [ ] Fingerprint structure consulted via debug logger to verify population
- [ ] `cd packages/bench && npx vite build` succeeds
- [ ] `cd packages/alphatab && npx tsc --noEmit` clean
- [ ] WIP commit: `perf(layout): DR-1 stable-packing fingerprint (Phase 1, skip OFF)`

---

## 7. Phase 2 — turn on the skip

Phase 1's fingerprint is now consulted. The skip path runs the §2.5 width-projection step instead of the full rebuild.

### 7.1 Shape sketch

In `_resizeAndRenderScore`, BEFORE the packing-branch rebuild loop:

```
if (this._isPackingStableAt(this._maxWidth)) {
    // STABLE-PACKING FAST PATH: reuse existing _systems[]
    this._systemPartialIds = [];
    for (let i = 0; i < this._systems.length; i++) {
        const system = this._systems[i];
        system.width = system.computedWidth;  // re-fit picks this up; mirrors barsPerRowActive branch
        this._fitSystem(system);
        y += this._paintSystem(system, oldHeight);
    }
    this._capturePackingFingerprint();  // re-emit (the fingerprint values may change if accoladeWidth recomputes)
    return y;
}
// FALL-THROUGH: full rebuild loop (existing code, unchanged)
```

This mirrors the `barsPerRowActive` branch (lines 286-292), which is the existence proof that the width-projection path works in some cases.

### 7.2 Re-fit invariants to verify

`_fitSystem` is the key call. Its behavior:
1. `reconcileMinDurationIfDirty` — no-op on stable systems (`isMinDurationDirty` is false after initial layout).
2. If `system.isFull || system.width > maxWidth || justifyLastSystem` → `_scaleToWidth(system, maxWidth)`. Else → `_scaleToWidth(system, system.width)`.
3. `system.finalizeSystem()` — runs per-bracket `finalizeBracket` (brace scaling), staff `finalizeStaff`. Re-runs `placeAndApply` per staff (the #21 hotspot).

`_scaleToWidth` (line 429) iterates `system.allStaves[].barRenderers[]` and calls `renderer.scaleToWidth(actualBarWidth)` for each. This is the per-renderer call we want — it re-runs `_scaleToForce` per renderer, but does NOT re-run the broker walk (which is skipped by `_voiceWalkDone` already).

**Phase 2 correctness depends on `_fitSystem` being safe to call against existing systems with no per-system structural mutation.** The `barsPerRowActive` branch proves this for the fixed-bars case; Phase 2 extends the same trust to the stable-packing case.

### 7.3 Force/per-bar-width refresh path

After `_scaleToWidth`:
- Per-renderer `actualBarWidth` is recomputed.
- Per-renderer `_scaleToForce` re-runs (force changes with width).
- Per-system `placeAndApply` re-runs (effect band positions depend on per-bar widths).

The skip does NOT skip these. It skips the system-level structural work (system-construction, `addMasterBarRenderers` cascade, broker re-writes — most of which is ALREADY skipped by `_voiceWalkDone`).

### 7.4 What if `system.width = system.computedWidth` is wrong?

§2.6 flagged this concern: the `barsPerRowActive` branch sets `system.width = system.computedWidth` and `_fitSystem` then decides whether to stretch. If `computedWidth < maxWidth` and `!justifyLastSystem`, the system stays at `computedWidth` even though there's room.

This is the existing branch's behavior — Phase 2 inherits it. If Phase 4 vitest surfaces visual regressions caused by this, we have two options:
- Always force `system.width = maxWidth` before `_fitSystem` so the stretch decision is made by `_scaleToWidth`'s "wasFull or oversize" check. (More aggressive; verify against fixed-bars branch.)
- Treat the regression as a pre-existing fixed-bars-branch latent issue and tighten the stretch logic. (Class E-style outcome.)

### 7.5 Phase 2 exit checklist

- [ ] Skip path added in `_resizeAndRenderScore`
- [ ] Fall-through to full rebuild on `!isPackingStable`
- [ ] Cache invalidation hooks added (model mutation, settings change, visibility change — track down each call site)
- [ ] WIP commit: `perf(layout): DR-1 stable-packing fast path (Phase 2, skip ON)`

---

## 8. Phase 3 — A/B verify

### 8.1 The A/B run

```bash
cd packages/bench
node scripts/build-ab.mjs --ref-a 1a4238cb   # post-EW-11 baseline
node dist/runAB.mjs --a dist/ab/A/runOneCore.mjs \
                    --b dist/ab/B/runOneCore.mjs \
                    --only canon-resize-drag \
                    --iterations 64 \
                    --label probe-DR1-NS
```

### 8.2 Decision rule

Read `runs/probe-DR1-NS/REPORT.md`.

| Condition | Action |
|---|---|
| **`★` AND median Δ ≤ -3.34 ms (≥ 2σ post-EW-11)** | PROCEED to Phase 4 visual triage. |
| `★` but median Δ in `(-3.34, -2.32) ms` | Marginal; re-run at n=96; if still marginal, consider Option C primary |
| `~` (CI overlaps 0) | Re-run at n=128; if still `~`, drop to Option C |
| `·` | Falsify; drop to Option C if probes were favourable, else §10 |
| `★` regression in any OTHER scenario | Investigate (likely `nightwish-resize` or `fade-to-black-resize` — verify their scenario keeps a single-system layout where the fast path doesn't apply, OR has stable-packing rate too low to trigger) |

### 8.3 Anti-revert moment #1

If A/B shows `★` ≥ 3.34 ms improvement, the win is real and is **not erased by Phase 4 visual failures**. Per DR-1 broker-lifecycle §18 postscript, the user has now caught two premature reverts where the executor classified Class E failures (reference PNG encodes pre-existing bug) as Class B (gate too loose). See §9 for the correct classification protocol.

### 8.4 Phase 3 exit checklist

- [ ] A/B report saved at `runs/probe-DR1-NS/REPORT.md`
- [ ] Median delta on canon-resize-drag documented
- [ ] No `★` regression on any other scenario
- [ ] Decision recorded in WIP commit message

---

## 9. Phase 4 — visual triage + Phase 5 fix loop

### 9.1 Run vitest

```bash
cd packages/alphatab && npx vitest run
```

### 9.2 Expected baseline

Both EW-9 Variant B and DR-1 broker-lifecycle accepted reference-PNG diffs as Class E improvements (old reference encoded a pre-existing bug). The stable-packing skip is a structural change to the resize pipeline — expect 0-10 visual diffs.

**MANDATORY before classifying any diff**: open the PNG. Compare old reference vs new output side-by-side. Look for:
- Bar widths shrunk where they were previously oversized (Class E candidate — accumulated max-of finally settles).
- Bar positions correct but spacing changed slightly (Class A/E candidate — re-fit produces slightly different fractional widths).
- Bars stacked at x=0 or other "obviously broken" symptoms (Class B — gate too loose).
- Effect band positions off (Class C — `placeAndApply` skipped where it shouldn't be).

### 9.3 Class taxonomy

#### Class A — `mb.width` drift between cycles

**Symptoms**: per-bar widths slightly off; positions correct but spacing wrong.
**Root cause**: a hidden width-dependent write path that Phase 0 Probe 2 didn't catch. The cached fingerprint says packing is stable but per-bar widths actually do shift.
**Fix**: identify the path; add it to the invariance check; either tighten the fingerprint OR drop to Option C (repack-detect).

#### Class B — gate too loose (catastrophic)

**Symptoms**: bars stacked at x=0; entire system at wrong y; obvious visible breakage.
**Root cause**: the fingerprint matched a width at which packing actually differs. The §3.2 predicate's bounds are wrong.
**Fix**: re-derive `[lower_i, upper_i]` from first principles; verify the case the gate missed.

#### Class C — `finalizeSystem` / `placeAndApply` skipped where needed

**Symptoms**: effect band positions wrong (text under bar instead of above, etc.).
**Root cause**: the skip path's `_fitSystem` → `finalizeSystem` → `placeAndApply` chain is missing a per-system reset that the rebuild path always does.
**Fix**: trace which reset is missing; lift it into the skip path.

#### Class D — interaction with EW-9 / DR-1 broker-lifecycle caches

**Symptoms**: per-renderer state stale (skylines off, beam endpoints off).
**Root cause**: skipping the `addMasterBarRenderers` cascade also skips some implicit reset that one of the prior caches assumed would run.
**Fix**: identify the assumption; either explicit-reset on skip path entry OR invalidate the prior cache via the skip's invalidation hook.

#### Class E — old reference encoded a pre-existing bug

**Symptoms**: diff PNG shows new behaviour LOOKS BETTER. Bars sit closer to natural width; padding accumulators finally settle.
**Root cause**: the rebuild path's `max-of` accumulation across resizes had a latent bug (the same one DR-1 broker-lifecycle's v2 fixed). Stable-packing skip happens to fix it further.
**Fix**: accept the new reference with documented rationale. Add to "bonus bug fixes" in the landing commit.

### 9.4 Fix loop

Per the EW-9 / DR-1 / EW-3 pattern:

1. Classify each red test per §9.3.
2. **Open the diff PNG before classifying.** This is the lesson from DR-1 broker-lifecycle §18.5.
3. Apply the class's fix (targeted invalidation for A/B/C/D; reference accept for E).
4. Re-run single test: `npx vitest run -t "<test name fragment>"`.
5. Re-run A/B every 3-5 fixes to confirm the win hasn't eroded.
6. Per-class commit with class label.

### 9.5 Iteration cap

10 iterations. If still red OR A/B has fallen below σ:
- STOP per-test loop.
- Drop to Option C primary (re-do Phases 1-3 with §3.6 sketch).
- If Option C also fails: §10 falsification.

### 9.6 Perf erosion budget

| Phase 3 win | Erosion limit (30 %) | Stop threshold |
|---|---|---|
| -3.34 ms | -1.00 ms | win drops below -2.34 ms → Option C |
| -5 ms | -1.50 ms | drops below -3.50 ms → Option C |
| -7 ms | -2.10 ms | drops below -4.90 ms → Option C |

### 9.7 Phase 5 exit checklist

- [ ] vitest 1599/1599
- [ ] A/B re-measured at n=64 still shows `★ ≥ -3.34 ms`
- [ ] No other scenario shows `★` regression in multi-process diff
- [ ] Each fix committed separately with class label
- [ ] Plan postscript (§16) updated with execution outcome

---

## 10. Falsification path

If both Option A and Option C fall through (Phase 5 caps or Phase 3 A/B is `·`):

### 10.1 What to record in HOTSPOTS.md

Demote DR-1 stable-packing slice to "Demoted at this site" with falsification entry:

> **DR-1 stable-packing slice** — attempted via Option A (width-range predicate, `★` Δ=...), Option C (repack-detect, `★` Δ=...) at SHAs ..., .... Both either below ≥ 2σ floor OR introduced visual regressions Phase 5 couldn't resolve within iteration cap. The system-pack rebuild is structurally blocked at this codebase shape: [Phase 0 surfaced stable-packing rate of X% — too low for the predicate to amortise; OR per-bar widths fluctuate via [hidden path] requiring full re-walk; OR the prior caches' invalidation contract is incompatible with skipping `addMasterBarRenderers`]. Capturing this slice would require [structural change Y — e.g. a content-versioned cache spanning per-system geometry, or a re-architecture of the system tree to decouple geometry from packing].

### 10.2 Update DR-1 in HOTSPOTS.md

Mark the stable-packing slice as "structurally blocked at this codebase shape" alongside EW-9 Variant B (landed) and DR-1 broker-lifecycle (landed). The DR-1 entry under "Major refactors — landed" gets a partial-shipment note.

### 10.3 Acceptable-outcome framing

This is **not failure**. Documented structural blocks are successful round outcomes — they tell future work where the codebase's limits are. The stable-packing slice goes from "open" to "structurally blocked".

---

## 11. Anti-revert directives — read this twice

**The user has now caught two premature reverts: DR-1 broker-lifecycle (v2 was reverted, then un-reverted after user inspection) and EW-3 (sub-agent demotion was caught and corrected).** Both followed the same pattern: agent ran a successful patch, saw vitest red, classified failures without inspecting diffs, and reverted.

The corrective rules:

> **DO NOT** `npm run test-accept-reference` to accept all diffs. Always inspect each diff PNG individually before classifying.

> **DO NOT** revert Phase 2 on the first red vitest. Expect 0-10 visual failures initially. They are diagnostic information.

> **DO NOT** classify a Class E failure as Class B without opening the diff PNG. The DR-1 broker-lifecycle round had 6 Class E failures (improvements) initially classified as regressions and reverted.

> **DO NOT** invoke "fall-through to next option" on the basis of speculation about cost. Per DR-1 broker-lifecycle §18.5: "speculation about cost without measurement is NOT a §10-style demotion trigger". The demotion trigger is "Phase 5 iteration cap hit OR A/B re-measure shows erosion > 30 %".

> **DO NOT** add invalidation hooks that fire every resize cycle (e.g. via `afterReverted`). The DR-1 broker-lifecycle round's v1 did this and fell below σ. `afterReverted` is the canonical anti-pattern.

> **DO NOT** widen the gate's scope to fix a Class D failure. Class D's recipe is targeted invalidation, not broader gating.

> **DO NOT** mix Option A and Option C infrastructure in the same commit series. If A fails, reset cleanly per §10's protocol before starting C.

> **DO** open every diff PNG before classifying. Specifically: look for "leading padding shrunk" / "bar widths settled" patterns — these are Class E improvements, NOT regressions.

> **DO** commit work-in-progress at each successful fix step with class label. Bisect-friendly.

> **DO** re-run A/B at n=64 every 3-5 fixes.

> **DO** surface visual diffs to the user before classifying when in doubt. The user has corrected two such classifications already.

> **DO** record falsification per §10 if both Option A and Option C fail.

---

## 12. Definition of done

DR-1 stable-packing is shippable when **all four** hold simultaneously:

### 12.1 vitest

- vitest 1599/1599 in `packages/alphatab`
- Zero diff PNGs (or all accepted as Class E with user verification per §11)
- Zero `npm run test-accept-reference` invocations in this work's history

### 12.2 Perf

- A/B `★` on canon-resize-drag at n=64, median Δ ≤ -3.34 ms (≥ 2σ post-EW-11)
- The paired A/B is the authoritative measurement

### 12.3 Cross-scenario neutrality

- No `★` regression in 5-trial multi-process diff against `1a4238cb`:
  ```bash
  cd packages/bench
  node dist/run.mjs --trials 5 --label DR1-NS-post --save-baseline DR1-NS-post
  node dist/cli.mjs diff baselines/post-EW11.json baselines/DR1-NS-post.json
  ```
- Every non-target scenario must be `·` / `~` / `★ improvement`.

### 12.4 HOTSPOTS.md updated

- The DR-1 stable-packing slice lands under "**Major refactors — landed**" alongside DR-1 broker-lifecycle.
- Entry includes: median Δ, commit SHA, one-line description of the contract change ("skip system-rebuild on stable-packing widths"), cross-reference to this plan.
- The "Major refactors — deferred" DR-1 entry is updated to reflect full shipment of the three sub-slices.

---

## 13. Estimated effort

| Phase | Wall-clock estimate | Notes |
|---|---|---|
| 0 | 60-90 min | 5 probes + analysis. Largest phase. |
| 1 | 30-45 min | Fingerprint structure + capture call. Skip OFF. |
| 2 | 15-30 min | Wire up skip path. Mirror barsPerRowActive branch. |
| 3 | 10-15 min build + 5-8 min A/B run | Same shape as EW-9 / EW-10 / EW-11 Phase 3. |
| 4 | 30-60 min | Visual triage + DIFF INSPECTION (mandatory). Expected 0-10 failures. |
| 5 | 0 or 60-180 min | Per-class fix loop. Only if Phase 4 surfaced any. |
| 6 (fallback to Option C) | 0 or +90-240 min | Only if Phase 5 caps. |
| Total | **3-6 hours** if Option A lands; up to **12-18 hours** if all fallbacks + falsification | Single session viable for the primary. |

---

## 14. Supporting evidence (cite, don't quote)

- `packages/bench/HOTSPOTS.md:265-296` — DR-1 quantification, post-EW-11 status, sub-slice tracking.
- `packages/bench/baselines/post-EW11.json` — authoritative σ baseline (5-trial, host-clean, HEAD `323b4133`).
- `packages/bench/runs/post-EW11/canon-resize-drag/TOP30.md` — aggregated CPU top-30; sources for §1.4 cost figures.
- `packages/bench/analysis/2026-06-14-resize-drag/DR-1-BROKER-LIFECYCLE-PLAN.md` — prior DR-1 sub-slice plan. §18 postscript is the load-bearing lesson set.
- `packages/bench/analysis/2026-06-14-resize-drag/EW-9-PLAN.md` — prior DR-1 sub-slice plan. §3.4 falsification is the prior-art for "broker reset is load-bearing".
- `packages/bench/analysis/2026-06-14-resize-drag/EW-3-PLAN.md` — recent multi-phase plan with empirical-probes-first shape, used as the structural reference for §5.
- `packages/bench/analysis/2026-06-14-resize-drag/EW-10-PLAN.md` — recent batching plan with anti-revert directives, used as the structural reference for §11.
- `packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts:140-164` — `doResize` entry point.
- `packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts:281-350` — `_resizeAndRenderScore` (THE function this plan modifies).
- `packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts:286-292` — `barsPerRowActive` branch, the existence proof for the skip pattern.
- `packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts:406-418` — `_fitSystem` (re-invoked from skip path).
- `packages/alphatab/src/rendering/layout/VerticalLayoutBase.ts:429-470` — `_scaleToWidth` (per-renderer width distribution; per-system geometry refresh).
- `packages/alphatab/src/rendering/staves/StaffSystem.ts:288-345` — `addMasterBarRenderers` (THE call the skip path bypasses).
- `packages/alphatab/src/rendering/staves/StaffSystem.ts:571-608` — `_applyLayoutAndUpdateWidth` (where `mb.width` is established; key for §3.3 invariance).
- `packages/alphatab/src/rendering/staves/StaffSystem.ts:610-754` — `_calculateAccoladeSpacing` (visibility fingerprint already in place).
- `packages/alphatab/src/rendering/staves/StaffSystem.ts:1080-1116` — `finalizeSystem` (re-invoked from skip path).
- `packages/alphatab/src/rendering/staves/RenderStaff.ts:132-142` — `addBarRenderer` (THE per-stave cascade the skip bypasses).
- `packages/alphatab/src/rendering/BarRendererBase.ts:362-408` — `scaleToWidth` (per-renderer width assignment).
- `packages/alphatab/src/rendering/BarRendererBase.ts:467-486` — `_registerLayoutingInfo` (with `_voiceWalkDone` split).
- `packages/alphatab/src/rendering/BarRendererBase.ts:517-535` — `applyLayoutingInfo` (where `computedWidth` is set; §3.3 source).
- `packages/alphatab/src/rendering/BarRendererBase.ts:557` — `_layoutInvariantCached` (EW-9 Variant B cache).
- `packages/alphatab/src/rendering/BarRendererBase.ts:465` — `_voiceWalkDone` (DR-1 broker-lifecycle cache).
- `packages/alphatab/src/rendering/BarRendererBase.ts:941-967` — `reLayout` (per-renderer entry point, gated by the two prior caches).
- `packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts:58-153` — `scaleToWidth` and `_scaleToForce` (force-derived per-beat positioning, the #6 hotspot).
- `packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts:387-396` — `spaceToForce` (force derivation from staff width).
- `packages/alphatab/src/rendering/staves/BarLayoutingInfo.ts:398-413` — `calculateVoiceWidth` (broker-derived per-bar width).
- `packages/alphatab/src/rendering/EffectSystemPlacement.ts:28-100` — `placeAndApply` (the #21 hotspot; per-system effect band placement).
- `packages/bench/src/scenarios.ts:106-113` — `canon-resize-drag` scenario definition (width sequence).

---

## 15. Quick reference card

For the executor mid-Phase-5 who needs the decision tree in one screen:

```
Phase 0 probes (MANDATORY, 5 probes):
  Stable-packing rate on canon-resize-drag 12-width sequence?
    > 50% AND mb.width invariant AND L > 5 ms → Option A primary, Phase 1
    20-50% AND mb.width invariant            → Option C primary
    < 20%                                     → §10 falsification
    mb.width NOT invariant when stable        → investigate, possibly Option C

Phase 1 (single file VerticalLayoutBase.ts, ~50 lines):
  Add `_lastPackingFingerprint` field on VerticalLayoutBase.
  Capture fingerprint at end of every rebuild (skip OFF).
  Verify fingerprint structure populates correctly.

Phase 2 (skip ON):
  In _resizeAndRenderScore, BEFORE the rebuild branch:
    if (this._isPackingStableAt(this._maxWidth)) {
        // mirror barsPerRowActive branch:
        for (each system) {
          system.width = system.computedWidth;
          this._fitSystem(system);
          y += this._paintSystem(system, oldHeight);
        }
        return y;
    }
    // existing rebuild loop

Phase 3 A/B at n=64:
  ★ ≤ -3.34 ms? → Phase 4
  ★ in (-3.34, -2.32)? → re-run n=96
  ~ → re-run n=128, then Option C
  · → Option C

Phase 4 visual triage:
  OPEN EVERY DIFF PNG BEFORE CLASSIFYING.
  Class A (mb.width drift): tighten predicate or Option C.
  Class B (gate too loose, bars stacked): re-derive bounds.
  Class C (placeAndApply skipped where needed): lift reset into skip path.
  Class D (interaction with prior caches): targeted invalidation.
  Class E (old reference was buggy): accept with documented rationale.

Phase 5 fix loop:
  Each fix is a separate commit with class label.
  Re-run A/B every 3-5 fixes; budget ≤ 30 % erosion.
  10 iteration cap → Option C (Phase 6).

Phase 6 fallback to Option C:
  Reset to pre-Phase-1 SHA; re-implement with repack-detect sketch.
  Re-run Phases 1-5 in full.

Never:
  - npm run test-accept-reference
  - Revert Phase 2 on first red vitest
  - Classify Class E as Class B without diff inspection
  - afterReverted-style every-cycle invalidation
  - Widen the gate's scope to fix a Class D
  - Speculate cost erosion without measuring
```

---

## 16. Execution outcome — falsified at Phase 0, 2026-06-15

**Status**: closed at Phase 0. No source change shipped. Plan §10 falsification path taken per user verdict.

**Final HEAD when the round closed**: `2f5acb7f` (Phase 0 probe doc only).

### 16.1 Phase 0 probe results

Executor ran the 5 §5 probes against canon-resize-drag on a host-clean session. Full data in `DR1-NS-PHASE0-PROBES.md` and `DR1-NS-PHASE0-LOG.txt`.

| Probe | Result | §5.8 threshold |
| --- | --- | --- |
| §5.1 stable-packing rate (single-prior predicate) | **0 / 143 cycles = 0.0 %** | < 20 % → §10 falsification |
| §5.2 `mb.width` invariance under stable packing | NO DATA — no cycles were stable | n/a |
| §5.3 per-system packed-width invariance | NO DATA — same reason | n/a |
| §5.4 layout-rebuild cost (region L) | median 6.73 ms / iter | > 5 ms → upside is real if predicate hits |
| §5.5 wrap-flips / cycle | median 160 (range 78-330) | high but inherent to drag scenario |

The literal §3.2 single-prior predicate hits 0 / 143. The plan's §5.8 / §4.5 decision rule triggers §10 falsification.

### 16.2 Side discovery — multi-entry width-keyed cache

Phase 0 surfaced a structural fact the plan did not anticipate: **per-width packing is deterministic across the 8 iterations**. Each of the 12 distinct `maxWidth` values produces the same system count every time it appears (60, 67, 72, 82, 94, 112, 122, 145, 178, 167, 131, 116).

A multi-entry `Map<maxWidth, packingFingerprint>` cache would hit ~96 % steady-state on canon-resize-drag. The executor surfaced this as an unauthorised Option A' variant.

**The user rejected Option A' as Goodhart-bait.** Reasoning:

- The 96 % hit rate is a bench artifact. canon-resize-drag cycles 12 exact widths × 8 iterations; after iteration 1, every width is a repeat.
- In a real browser drag (monotonic pixel-by-pixel, e.g. 1400 → 1399 → 1398), widths don't repeat. Cache hit rate ≈ 0 %.
- Multi-entry exact-width caching would help only on snap-resize / drag-back / panel-toggle — partial production value at best, with the bench number wildly inflated.
- Shipping it would set a precedent for bench-fitting future rounds. Strong recommend against.

### 16.3 Why the plan's premise didn't fit the bench corpus

The plan §3.2 width-range predicate (`newWidth ∈ [lower_i, upper_i]` per system) IS production-honest — it generalises to continuous drag because it catches "this width happens to land in the same packing range as the previous one". But canon-resize-drag is **intentionally designed** to exercise the resize path with packing-changing transitions — the 12 widths span the full system-count range maximally. So the scenario has 0 % stable transitions by construction.

The optimization is potentially valuable in production but **structurally unvalidatable on the current bench corpus**.

### 16.4 Open paths NOT taken

For future reference if the resize path becomes a priority again:

- **Option B — add a new bench scenario** (`canon-resize-monotonic-fine`?) with widths in stable-packing zones (e.g. width sequence 1400, 1395, 1390, ... that produces many same-packing transitions). Then ship the §3.2 width-range predicate against the new scenario's baseline. ~30 lines of work in `scenarios.ts` to set up; the optimisation itself is the original plan.
- **Option C — repack-but-don't-rebuild** (plan §4.3): re-runs the packer every cycle, reuses `RenderStaff` objects when membership matches. Bench-honest because it doesn't depend on width repetition. Smaller bench win (~1-2 ms) but generalises.

Neither was attempted in this round.

### 16.5 What's closed and what's still open in DR-1

DR-1 as originally scoped (`Resize re-walks every bar even when only the viewport width changed`) had three sub-slices identified across rounds:

| DR-1 sub-slice | Status | Commit |
| --- | --- | --- |
| Overflow / `calculateOverflows` skip | landed | `bfcd943f` (EW-9 Variant B) |
| Broker-lifecycle / `_registerLayoutingInfo` walk-skip | landed | `eddf9bc1` |
| **Stable-packing system-pack skip** | **closed (falsified)** | n/a |

Total DR-1 paired A/B: -9.69 ms + -6.08 ms = **-15.77 ms / iter on canon-resize-drag** before this round; unchanged after.

The ~7 ms estimated payoff of the stable-packing slice is structurally inaccessible at the current bench scope. The 14 ms "truly width-invariant" surface (`registerLayoutingInfo` 7.0 + `calculateOverflows` 3.1 + `_emitGroupOverflows` 2.4 + `_computeBeamingBounds` 2.9) is fully captured by the two landed slices.

### 16.6 Process lesson (cite for future plans)

- The executor halted correctly at the deviation moment per §11 / §17 protocol. The Phase 0 finding made the literal plan unviable, AND the agent recognised the alternative (multi-entry cache) was unauthorised. Surfacing the choice to the user instead of unilaterally swapping shapes was the right call.
- The Goodhart-trap pattern (bench shows big win, production wouldn't see it) is a real risk for any cache-based optimisation against a scenario with structural artifacts (repeating widths, cycling iterations, fixed corpus). Future plans should explicitly call out cache-hit-rate-in-production vs cache-hit-rate-in-bench as separate quantities, and require both to clear the bar.
- "Falsification is an acceptable outcome" was tested for the first time in this session. The session has shipped 4 landed rounds (DR-1 broker-lifecycle, EW-3, EW-10 Phase A, EW-11) and now one falsified one. That ratio is healthy — perf work where every round lands is suspicious.

---

## 17. The three non-negotiable rules

1. **Phase 0 probes MUST run before any source change.** Their outcome chooses the primary option AND validates the predicate's correctness premise. Skipping Phase 0 means guessing.

2. **Visual diff PNG inspection is mandatory before classifying any vitest failure.** The DR-1 broker-lifecycle round demoted Class E (improvements) as Class B (regressions) and reverted a successful patch. Inspect before classifying.

3. **§11 anti-revert directives are not optional.** The natural reaction to a red vitest after Phase 2 is to revert. That reaction has been wrong twice in this session. The third time, surface the diffs to the user before deciding.

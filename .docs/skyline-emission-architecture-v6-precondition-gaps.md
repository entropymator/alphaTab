# v5 → v6: skip Steps 2, 8a, and 14

## Status

Eight v5 steps landed (1b, 1c, 6, 4, 5a, 5b, 5c, 7 — 1187 unit + 404 visual byte-identical except Step 1c's plan-correct §G.7 fix). Two β-cluster steps failed on first attempt: Step 2 regressed 79+9 fixtures, Step 8a regressed 89+24. Sub-agent investigation confirmed the failures are real, but **the right v6 amendment is to drop the failing steps, not patch around them**. They were tier-3 dogmatic cleanups in a plan with three quality tiers.

## The three tiers of v5 steps

| Tier | What they do | Examples |
|---|---|---|
| 1. **Architectural** | Close anti-patterns; replace error-prone mechanisms | 1c, 4, 5b/5c, 7, 13, 16, 17 |
| 2. **Cleanups** | Small wins at low cost | 1b, 6, 8b, 9, 10, 11, 12, 15 |
| 3. **Dogmatic** | Enforce purity for its own sake; no empirical payoff | **2, 8a, 14** |

Tier 1 and 2 deliver the architecture's actual value (lifecycle phase separation, single-write skyline emission, immutability contracts). Tier 3 chases purity targets — "bbox is a strictly pure function of glyph fields", "version bumps only at seal events" — that aren't load-bearing for the architecture and have real costs to enforce.

Five rounds of review missed this because each round verified the plan's internal consistency rather than asking "is this step worth doing?"

## Step 2 — drop

### What v5 says

`BarNumberGlyph.getBoundingBoxLeft`/`Right` collapse to `(this.x, this.x)` on non-first staves. v5 §B.7 calls this a §C-4 anti-pattern ("bbox as side-channel for renderer state") that becomes "obsolete" once Step 1c lands.

### The actual situation

The override is a 4-line accommodation for a real music-engraving fact: bar numbers paint once per system, on the first visible staff. The glyph still lives in every staff's pre-beat group (for x-alignment via the broker's max-of `preBeatSize`); the override prevents non-first staves from contributing the glyph's x-range to the skyline. That's the whole mechanism. It's small, self-contained, and reflects semantics — not a side-channel hack.

The naive attempt to delete the override regresses 79+9 fixtures because the visibility-suppression role is **structural** (independent of any timing bug). No amount of Step 1c-style timing fixes makes it go away.

### Why drop

The "anti-pattern" framing is dogma. We're inventing a problem (single-glyph §C-4 violation) and proposing infrastructure (`populateSkyline?` migration, three-tenant hook) to solve it. The override does its job; no consumer is harmed; no architectural goal requires removing it.

Step 3 still happens — `populateSkyline?` is genuinely useful for `BarTempoGlyph` (post-Phase-2 contribution) and `GroupedEffectGlyph` (cross-renderer chain-walk). Those are real cross-cycle-state dependencies. `BarNumberGlyph` doesn't belong with them; it just looks similar because it also reads renderer state at bbox time.

§F.1 weakens from "bbox is a pure function of glyph fields" to "bbox is a pure function of glyph fields, modulo documented per-glyph exceptions with rationale." Step 14 (the audit) verifies each exception is justified rather than abolishes them.

### v6 amendment

- Drop Step 2.
- `BarNumberGlyph` keeps both its bbox override (visibility suppression) and its `registerDynamicSkylineGlyph` call (staleness compensation for the first-bar-of-first-system window when `firstVisibleStaff === undefined`). Both are small and load-bearing.
- `_dynamicSkylineGlyphs` does NOT retire. After Step 3 migrates `BarTempoGlyph` and Step 16 migrates `GroupedEffectGlyph`, `BarNumberGlyph` is the sole remaining tenant. §H Step 3's grep changes from "zero `_dynamicSkylineGlyphs` occurrences" to "`BarNumberGlyph` is the only remaining producer / consumer." The registry is acceptable as a permanent mechanism for one tenant.
- Step 14 audits `BarNumberGlyph.getBoundingBox*` as the documented exception. Add to the audit deliverable: justification text + lint to prevent silent new exceptions.

## Step 8a — drop

### What v5 says

§E Step 8a: "stop bumping `BarLayoutingInfo.version` from `addSpring`. After Step 8a removes intra-`doLayout` `applyLayoutingInfo`, the `addSpring` bump becomes redundant and is deleted."

### The actual situation

The premise — "Step 8a removes intra-`doLayout` `applyLayoutingInfo`" — **doesn't hold against today's code**. `applyLayoutingInfo` isn't called from `doLayout`. The §H Step 8a grep "zero in doLayout" is already satisfied; there's nothing to remove.

The `addSpring` bump isn't redundant. It's the broker-write-site signal that downstream `applyLayoutingInfo` consumers (especially through `addMasterBarRenderers`, which re-runs `_registerLayoutingInfo` without calling `finish()`) rely on. Removing it regresses 89+24 fixtures.

### Why drop

The bump is correct. A spring add IS a broker mutation; bumping the version on mutation is exactly right. The plan's "redundant" claim was based on a precondition that no longer holds — likely a stale reading of older code where `doLayout` did call `applyLayoutingInfo`.

Step 8b (the actual cleanup: hoist "should I re-apply?" predicate into `reconcileMinDurationIfDirty`, delete `_appliedLayoutingInfo` cookie) is independent of Step 8a and still worth doing. Once 8b lands, the version field's main consumer is gone and the question of "where should bumps happen" becomes moot.

### v6 amendment

- Drop Step 8a.
- §B.19's three bump sites (`addSpring`, `finish`, `recomputeSpringConstants`) stay as-is. The narrative becomes "version bumps on every broker mutation; downstream consumers compare against their last-seen version." Clean.
- Step 8b proceeds as v5 specifies. After 8b, the cookie is gone; the version field becomes informational for future consumers or can be retired separately.

## Step 14 — narrow scope

§E Step 14: "Audit `Glyph.getBoundingBox*` for strict-geometric purity." Per §F.1 "strict", every override must be a pure function of glyph fields or fail the audit.

With Step 2 dropped, the audit's scope changes: instead of "abolish every renderer-state read in bbox," it becomes "enumerate every renderer-state read, justify it as a documented exception, and add a lint to prevent silent new ones." The audit still has value (catches accidental side-channels in new glyphs) but isn't a purity crusade.

## What to do next

The implementation order, with the three tier-3 steps removed:

```
Done:        0, 1b, 1c, 6, 4, 5a, 5b, 5c, 7
Skip:        2, 8a, 14 (kept narrowed)
Next:        3 (populateSkyline? for BarTempoGlyph + GroupedEffectGlyph)
Then:        8b → 11 → 9 → 10 → 12 → 13 → 15 → 16 → 17
```

The DAG simplifies. Step 3 no longer needs to coordinate with Step 2 (BarNumberGlyph isn't a tenant). Step 8b no longer has Step 8a as a prereq (it stands alone). Steps 9/10/12/13/15/16/17 chain off as v5 specifies.

## Lesson for v6 and future plans

The review process verified internal consistency but not value-per-step. Future plans should add a per-step "what breaks if we skip this?" column. If the answer is "nothing measurable; we just like the cleaner shape," consider whether the step is dogma in disguise. The architecture's value is in closing real anti-patterns and replacing error-prone mechanisms — purity-for-purity's-sake earns its keep only when the impurity actually causes bugs.

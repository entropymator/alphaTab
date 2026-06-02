# BeamingHelper.alignWithBeats — bug or load-bearing cache invalidation?

## Verdict (TL;DR)

**Both** — the clear is *intended* as a cache-invalidation step (so that downstream
`ensureBeamDrawingInfo` recomputes after `scaleToWidth` has settled beat X
positions), **and** its current implementation contains a latent bug: with the
`.clear()` placed *inside* the iterator loop, only the FIRST direction's
`startX`/`endX` is ever rewritten — any second direction (e.g. tuplet-bracket
direction that disagrees with beam direction) keeps the *pre-scale* X values
until the next `ensureBeamDrawingInfo` cache-miss rebuilds it from scratch.

The bug does not currently manifest visibly because:

1. The very next thing that touches a (now mostly-empty) `drawingInfos` is
   `emitHelperSkyline` → `_computeBeamingBounds`, which for the
   `beats.length > 1` branch calls `ensureBeamDrawingInfo` again. Since the map
   is empty, that's a clean rebuild against post-`scaleToWidth` X positions.
2. So in practice the "X realignment" is actually performed by the rebuild,
   not by the in-place `startX = …; endX = …` assignment in `alignWithBeats`.
   The first-iteration assignment is dead work; the `clear()` is the only
   load-bearing line in the body.

A correct, clearer implementation would be `this.drawingInfos.clear();` —
nothing else. The `for`-loop is misleading and was a transcription artifact of
the previous (Map-of-beat-keyed) implementation (see §appendix).

---

## 1. Mechanical truth of `alignWithBeats()`

`packages/alphatab/src/rendering/utils/BeamingHelper.ts:109-115`:

```ts
public alignWithBeats() {
    for (const v of this.drawingInfos.values()) {
        v.startX = this._renderer.getBeatX(v.startBeat!, BeatXPosition.Stem);
        v.endX = this._renderer.getBeatX(v.endBeat!, BeatXPosition.Stem);
        this.drawingInfos.clear();
    }
}
```

Mutating a `Map` while iterating its live `.values()` iterator follows the
ES spec: `Map.prototype.clear()` removes all entries and the iterator
immediately signals `done: true` on its next `next()` call. Empirically
confirmed:

```text
Map with two entries -> seen 1 -> total iterations: 1, size after: 0
```

Sequence per call:

- If `drawingInfos.size === 0`: loop body never runs; `clear()` never runs.
  No-op. (BeamingHelper.ts:110)
- If `drawingInfos.size >= 1`: enters body once with the FIRST inserted
  entry; rewrites its `startX`/`endX` via `getBeatX(…, BeatXPosition.Stem)`
  (BeamingHelper.ts:111–112); then `drawingInfos.clear()` empties the map
  (BeamingHelper.ts:113); iterator terminates; second/third entries (if
  any) are dropped without their `startX`/`endX` being touched.

So: **the clear happens inside the iteration; the realignment writes are
applied to at most one entry (the first one inserted), then the map empties
and the loop exits.** Subsequent entries are simply discarded.

## 2. What `drawingInfos` stores per direction

Definition: `packages/alphatab/src/rendering/utils/BeamingHelper.ts:19-42` and
the map itself at `BeamingHelper.ts:315`. Five fields:

- `startBeat`, `endBeat` — first/last beat of the helper
- `startX`, `endX` — `getBeatX(beat, BeatXPosition.Stem)` (depends on
  voice-container spring positioning, i.e. only stable after `scaleToWidth`)
- `startY`, `endY` — `getFlagTopY` / `getFlagBottomY` (direction-dependent)
  plus the max-slope clamp, plus middle-element/min-line shifts applied in
  `ensureBeamDrawingInfo` after the initial fill.

Population path:
`LineBarRenderer.initializeBeamDrawingInfo` (LineBarRenderer.ts:1017–1072)
fills startBeat/startX/startY/endBeat/endX/endY and clamps slope.
`LineBarRenderer.ensureBeamDrawingInfo` (LineBarRenderer.ts:1081–1163) then
applies the bar-shift and per-beat min/max shifts. The whole struct is
direction-keyed: a Down-direction info has different startY/endY than the
Up-direction info for the same helper.

Readers (every site that pulls from `drawingInfos`):
- `LineBarRenderer.calculateBeamYWithDirection` — `LineBarRenderer.ts:215-218`
  (used by `calculateBeamY`/paint stems/paint tuplets)
- `LineBarRenderer._computeBeamingBounds` — `LineBarRenderer.ts:941-975`
  (shared by `calculateBeamingOverflows` and `emitHelperSkyline`)
- `LineBarRenderer.ensureBeamDrawingInfo` itself — `LineBarRenderer.ts:1082`
  (cache-existence check) and `:1093` (cache write)
- `NumberedBarRenderer.calculateBeamYWithDirection` —
  `NumberedBarRenderer.ts:391-398`

So `drawingInfos` is "purely derived" from `(beat positions, beam direction,
stem/flag Y of those beats, helper-internal shortest-duration / min-line
shift state)". It does not depend on any external paint state. Re-running
`ensureBeamDrawingInfo` from scratch after the map is cleared is sound — it
will produce identical Y values and updated X values that match the latest
spring positioning.

## 3. Can a single helper hold drawingInfos for both directions?

Yes — and this is the case where the bug bites.

Each helper has *one* canonical beam direction, returned by
`ScoreBarRenderer.getBeamDirection` (ScoreBarRenderer.ts:129) /
`_calculateBeamDirection` (ScoreBarRenderer.ts:354-397). Most callsites pass
this canonical direction, so the map ends up with exactly one entry.

However, `calculateBeamYWithDirection(helper, x, direction)` takes an
arbitrary direction, and tuplet-bracket painting uses
`getTupletBeamDirection(helper)` which can differ:

- `LineBarRenderer.paintTuplets` at LineBarRenderer.ts:299-302 calls
  `calculateBeamYWithDirection(beamingHelper, tupletX, tupletDirection)`.
- `_computeBeamingBounds` at LineBarRenderer.ts:944-972 first
  `ensureBeamDrawingInfo(h, getBeamDirection(h))` (the canonical direction)
  and then reads `drawingInfo` from the canonical direction. The
  tuplet-direction read goes through `getFlagTopY/BottomY` directly, not
  through `drawingInfos`, so it does NOT add a tuplet-direction entry here.

So the second-direction entry appears specifically when a tuplet bracket
points opposite to the beam (`getTupletBeamDirection` overridden, e.g.
NumberedBarRenderer.ts:251) and `paintTuplets` runs — at paint time,
*after* `alignWithBeats` has already run, so the bug's "drop subsequent
entries" effect is harmless for paint (the entries are repopulated on
demand). The bug would only matter if some code between
`alignWithBeats` and the next `ensureBeamDrawingInfo`-miss tried to read
the dropped entry — currently nothing does.

## 4. Lifecycle: `finish()` vs `alignWithBeats()`

`finish()` body — `BeamingHelper.ts:117-119`:

```ts
public finish(): void {
    this._renderer.completeBeamingHelper(this);
}
```

`completeBeamingHelper` is empty in `BarRendererBase`
(BarRendererBase.ts:1032-1034) and in `ScoreBarRenderer` it just caches the
chosen `BeamDirection` into `_beamDirections` (ScoreBarRenderer.ts:349-352).
**`finish()` does NOT populate `drawingInfos`.**

Callers:
- `BarHelpers.ts:60,68,84,87,178` — called from helper construction when a
  helper closes (during `BarRendererBase.helpers.initialize()`, which runs
  inside `doLayout`).
- `BarRendererBase.doLayout` at `:702-707` calls `h.finish()` on every helper
  at the end of layout, after `createBeatGlyphs` / `updateSizes`.

So `finish()` runs during `doLayout()`. Right after that,
`doLayout()` runs `calculateOverflows(0, this.height)`
(BarRendererBase.ts:711). The subclass `calculateOverflows` (e.g.
ScoreBarRenderer.ts:95) calls `calculateBeamingOverflows` which iterates
`helpers.beamHelpers` and runs `_computeBeamingBounds` →
`ensureBeamDrawingInfo` — **this is the first place that actually populates
`drawingInfos`**, using `getBeatX` values that reflect the *pre-spring* /
initial container layout.

`alignWithBeats()` is invoked exclusively from
`BarRendererBase.scaleToWidth` (BarRendererBase.ts:405-410):

```ts
for (const v of this.helpers.beamHelpers) {
    for (const h of v) {
        h.alignWithBeats();
        this.emitHelperSkyline(h);
    }
}
```

`scaleToWidth` runs the voice-container spring positioning first
(BarRendererBase.ts:366-403), which changes every beat's X. So by the time
`alignWithBeats` runs:

- `drawingInfos` may already hold one or more entries from the
  `calculateBeamingOverflows` pass in `doLayout`.
- Those entries' `startX`/`endX` are stale (computed against the
  pre-spring container width).
- The Y values are still correct (they don't depend on container width).

**Why `alignWithBeats` needs the clear:** the immediately-following
`emitHelperSkyline(h)` call (BarRendererBase.ts:408) goes through
`LineBarRenderer.emitHelperSkyline` (LineBarRenderer.ts:998) →
`_computeBeamingBounds` → `ensureBeamDrawingInfo`. The cache-existence guard
at LineBarRenderer.ts:1082 (`if (h.drawingInfos.has(direction)) return;`)
would short-circuit and reuse the stale X values, polluting the skyline.
Clearing forces a rebuild against post-spring X. *That* is the load-bearing
behavior. The in-place `v.startX = … ; v.endX = …` rewrite for the first
entry is redundant given the clear-and-rebuild that immediately follows.

Note also that `scaleToWidth` is called multiple times during layout
(alignRenderers re-runs), and on every call the spring positions change.
A persistent cache would compound the staleness; the clear is exactly
the invalidation step.

## 5. Bug-or-invalidation verdict

**Load-bearing cache invalidation with a latent first-N-1 bug.** Detailed:

**Load-bearing:** removing `this.drawingInfos.clear()` would leave
post-`doLayout` entries cached with pre-`scaleToWidth` X values; the next
`emitHelperSkyline` cache-hit would emit skyline segments shifted off from
where the beams will actually paint. (Beam paint uses
`getBeatX(beat, BeatXPosition.Stem)` directly in `paintBar`
at LineBarRenderer.ts:714, then `calculateBeamY(h, stemX)` for Y. The X is
fresh per-paint, but the Y comes from `drawingInfos` via `calcY` which
depends on `startX`/`endX`/`startY`/`endY`. Stale `startX`/`endX` ⇒ wrong
slope ⇒ wrong Y at every intermediate beat ⇒ visibly tilted beams whose
endpoints still land on the right stems but middle stems are mis-attached.)

**Latent bug:** the `clear()` is inside the iterator, so when
`drawingInfos.size > 1` the second-through-Nth entries are dropped without
their `startX`/`endX` being patched. This is a no-op for visible output
*today* because:

- The only consumer of `drawingInfos` between `alignWithBeats` and the next
  `ensureBeamDrawingInfo` cache-rebuild is `emitHelperSkyline` →
  `_computeBeamingBounds`, which calls `ensureBeamDrawingInfo` itself and
  cache-misses on an empty map (any rebuild is fine here).
- For the canonical direction it would also be a no-op if there were only
  ever one entry — but second-direction entries get inserted later (paint
  time / tuplet paint) and never co-exist with `alignWithBeats`-time state.

No test reproduces a visible defect from this. The bug is purely a "this
isn't doing what it looks like" landmine: a future change that adds a
second `drawingInfos` entry *before* `alignWithBeats` (e.g. populating both
directions during `calculateBeamingOverflows`) would silently lose the
second-direction's X realignment opportunity — but since the very next
op is a clear-and-rebuild anyway, even that future change would still
work correctly by accident.

The cleanest equivalent is:

```ts
public alignWithBeats() {
    this.drawingInfos.clear();
}
```

The `startX = …; endX = …` lines are vestigial; they made sense in the
pre-#2427 implementation where the loop walked a *different* map
(`_beatLineXPositions`, beat-keyed) and patched entries by beat identity
without clearing.

## 6. Implications for the v2 architecture

`drawingInfos` cannot be sealed at the end of a single "Spaced" phase as it
stands today, because:

1. It is first populated by `calculateBeamingOverflows` during `doLayout`
   (pre-spring), then must be invalidated and rebuilt after
   `scaleToWidth`'s spring positioning, then may be further mutated by
   paint-time `calculateBeamYWithDirection` calls that add new direction
   entries (e.g. tuplet-direction).
2. `scaleToWidth` itself can be invoked multiple times during layout
   (alignRenderers re-runs); each invocation invalidates the prior X
   positions.

Minimum phases that must touch `drawingInfos`:

- Phase A — **Overflow probe** (`doLayout` → `calculateOverflows`): may
  populate canonical-direction entries to compute stem/beam Y extents for
  pre-spring skyline. Optional — could be skipped if the overflow probe
  was rewritten to use direct Y computations without caching.
- Phase B — **Post-spring rebuild** (`scaleToWidth` → `alignWithBeats` +
  `emitHelperSkyline`): MUST invalidate or fully refill. Required for
  every spring-positioning result.
- Phase C — **Paint** (`paintBar`, `paintTuplets`): cache-misses fill in
  any missing direction entries (e.g. tuplet's opposite direction).

If Phase A is dropped (or rewritten to not touch `drawingInfos`), then
`drawingInfos` could be sealed inside `scaleToWidth` (final spring positions
known) *modulo* tuplet-direction inserts at paint time. Sealing after
"Spaced" would require either:

- pre-computing both directions inside Phase B (so paint is read-only), or
- accepting two phases (Spaced + Paint) that mutate the cache.

The simplest, cleanest v2 layout:

- Drop the Phase-A population (overflow probe uses direct Y queries, no
  caching).
- In Phase B (post-spring), eagerly populate `drawingInfos` for the
  canonical direction *and* the tuplet direction (if different), then
  freeze.
- Phase C reads only; never mutates.

That collapses the lifecycle to a single mutating phase and makes the
clear-and-rebuild dance unnecessary; the seal happens naturally at the end
of Phase B.

---

## §Appendix — adjacent code smells

1. **`alignWithBeats` is misleadingly written.** As noted in §5, the
   per-entry `startX`/`endX` rewrites inside the loop are unreachable for
   all but the first entry (and even the first entry's rewrite is
   immediately discarded by the `clear()` and rebuilt on the next
   `ensureBeamDrawingInfo` miss). The function should be either:
   `this.drawingInfos.clear();` (current de-facto behavior), or — if the
   intent was truly in-place patch without invalidation — move the
   `clear()` *outside* the loop *and* delete the `clear()` call entirely.
   The two interpretations are mutually exclusive; the code does both.
   File:line — `BeamingHelper.ts:109-115`.

2. **`finish()` is a one-line passthrough.** `BeamingHelper.ts:117-119`
   just calls `this._renderer.completeBeamingHelper(this)`. In
   `BarRendererBase` (`:1032-1034`) it's empty; in `ScoreBarRenderer`
   (`:349-352`) it does a single direction calculation and caches it. The
   helper itself has no completion state. Could be inlined at call sites
   (`BarRendererBase.ts:705`, `BarHelpers.ts:60/68/84/87/178`) — current
   indirection adds a virtual dispatch with no abstraction value.

3. **`isFullBarJoin` still on `BeamingHelper` static.** Pure beat-geometry
   utility (`BeamingHelper.ts:303-305`); no helper state used. Belongs in
   `ModelUtils` or a beaming-geometry module — leaving it on
   `BeamingHelper` couples renderers to the helper class for no reason.

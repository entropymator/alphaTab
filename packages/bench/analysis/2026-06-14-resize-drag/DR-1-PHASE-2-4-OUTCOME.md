# DR-1 Phase 2-4 outcome — §4 primary falsified, fall through to §4.5 Fallback B

**Phase 2 commit**: `373c3c6b` (will be reverted per §10.2)
**Phase 3 A/B**: PASS — `★ Δ = −5.33 ms`, CI [−6.64, −1.39], z = 3.50, n=64
**Phase 4 visual**: FAIL — 6 failures, including EW-9's `resize-sequence`
**Decision**: §10.2 fallback protocol — revert the §4 primary and proceed to §4.5 Fallback B.

## Phase 3 — A/B verified the perf gain

After fixing one mistake in Phase 2 (initially invalidating
`_voiceWalkDone` inside `afterReverted` — which the resize loop calls
on EVERY renderer EVERY cycle, defeating the optimisation entirely),
the §4 primary cleared the §1.6 / §7.2 decision floor decisively:

| n | median A | median B | Δ ms | Δ % | 95% CI | sign z | sig |
|---|---|---|---|---|---|---|---|
| 64 | 151.72 | 149.16 | **−5.33** | −3.5% | [−6.64, −1.39] | 3.50 | **★** |

The walk-skip is a real ~5 ms / iter improvement on canon-resize-drag
when no other invalidations fire — confirming §4.4's expected payoff
(albeit at the low end of the predicted ~6.8 ms walk-cost).

## Phase 4 — six visual failures

```
FAIL  MusicXmlImporterSamples > MozartPianoSonata           (slur position drift)
FAIL  NotationLegend > full-smufl-petaluma
FAIL  NotationLegend > full-default-small
FAIL  NotationLegend > full-default-large
FAIL  NotationLegend > resize-sequence                       (multiple widths, size mismatches)
FAIL  SpecialNotes > grace-alignment                         (grace ornament alignment)
```

Per §8.3 the `resize-sequence` failure means the cheap pair "isn't
running on the right code path". But that diagnostic is for the
EW-9-Phase-1-shape failure where preBeatSize stays 0. Here the cheap
pair clearly IS running (Phase 1 instrumentation verified, and the
preBeatSize wouldn't be 0 — the renderer's own write fires every
cycle).

The actual root cause traces to:

### Per-cycle mutation of renderer state that feeds the broker walk

`BeatContainerGlyph.registerLayoutingInfo` (`BeatContainerGlyph.ts:187`)
computes `postBeatStretch` as:

```
let postBeatStretch = this.postBeatStretch;       // = onNotes.computedWidth + _tieWidth - onNotes.onTimeX
for (const tie of this._ties) {
    postBeatStretch += (tie as Glyph).width;
}
layoutings.addBeatSpring(this, preBeatStretch, postBeatStretch);
```

The `tie.width` values are **mutable** — they depend on tie geometry,
which itself depends on whether the tie crosses a system break, which
itself depends on the wrap pattern at the current width. When wrap
pattern changes between resize cycles, tie widths change, and the
broker contributions would differ.

But the §4 primary's skip means the broker keeps the cycle-1 tie
widths forever — and at a different width where the tie is now
internal vs. crossing, the cached values are wrong.

Equivalent reasoning applies to grace rods (`allGraceRods` map
populated by `addBeatSpring`'s grace branch) — grace rod widths can
drift with grace-group layout state across cycles.

### Why Phase 1 didn't catch this

Phase 1 instrumentation tested whether the broker's state is stable
**at the start of each call** vs. **what the previous call left
there**. It did NOT test whether the CURRENT call WOULD have written
different values had it been allowed to run.

On `canon-resize-drag` (a simple monophonic piece with few ties / no
grace notes that drift), the answer to both questions is yes — so
Phase 1 passed AND the optimisation works. On NotationLegend / Mozart
slurs / grace-alignment fixtures the broker state IS stable per-call
(no mismatches would have appeared on Phase 1's metric), but the
would-be writes on subsequent cycles differ from cycle 1's writes.

This is the test gap that Phase 1 had. It's not a bug in the §4
primary's logic per se — it's that "skip the walk" is only correct
when the renderer's WRITE INPUTS don't drift across cycles.
Width-invariance of the renderer's musical content is not enough; the
glyph state must also be invariant.

### One narrowing attempt (ungate effect bands)

Tried: keep `topEffects/bottomEffects.registerLayoutingInfo` running
every cycle, only gate the voice-container walk. Hypothesis: maybe
effect bands' bounding boxes mutate per-cycle and the per-beat
tie/grace stuff is fine.

Result: still 6 / 6 failures. The mutation is in the voice-container
path itself (ties and grace rods), not in effect-band contributions.

## Per §9 Phase 5 — do not pursue here

Per §9.1 + §11, Class B (beat-level broker stale) gets ONE of:

- Add targeted `_voiceWalkDone = false` invalidation at the mutation
  site, OR
- Drop to §4.5 Fallback B.

The "mutation site" for tie / slur width changes is the layout pass
itself — every resize cycle mutates these. A targeted invalidation
there is equivalent to invalidating every cycle, which restores the
full walk cost and erodes the entire Phase 3 win. Per §9.3 erosion
budget that's an immediate fail.

Therefore the surgical primary is structurally insufficient for
fixtures with ties / grace continuations. Fallback B (cache+replay
broker writes) is robust to this case by construction — the cached
writes are re-emitted to the broker every cycle, so any per-cycle
input drift is captured.

## Decision: §10.2 fallback protocol

1. `git revert 373c3c6b` (clean revert — keep history, do not
   `git reset --hard` since Phase 1 doc and Phase 2-4 outcome docs
   should remain in the log).
2. Implement §4.5 Fallback B from scratch per the plan's sketch:
   each renderer caches the (key, value) tuples its walk would write;
   subsequent cycles replay them after the broker reset rather than
   re-walking.
3. Re-run Phases 3-5.

## Files left in the working tree after the Phase 4 attempt

- Visual diff `.new.png` artifacts under
  `packages/alphatab/test-data/visual-tests/notation-legend/`,
  `.../special-notes/`, and `musicxml-samples/`. These are debug
  artifacts and will be cleaned up after the Fallback B work lands.

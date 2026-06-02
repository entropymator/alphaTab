# `MultiVoiceContainerGlyph.applyLayoutingInfo` — per-voice `_scaleToForce` multi-call

**Verdict (short):** Accidental. The per-voice rescale was a refactoring artifact when `VoiceContainerGlyph` (single voice, flat `beatGlyphs: BeatContainerGlyph[]`) was merged into `MultiVoiceContainerGlyph` (multi-voice, nested `beatGlyphs: Map<number, BeatContainerGlyph[]>`). Iterations 2..N are pure no-ops: they re-derive identical `force`, `width`, `positions` from an unchanged `BarLayoutingInfo`, and rewrite every voice's beat container x to the same value it already had.

---

## 1. Exact code path

`packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts:160`:

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

For a bar with N voices, `_scaleToForce` runs **N times** (line 165, inside the outer `for (const beatGlyphs of this.beatGlyphs.values())` loop at line 161).

The single-voice predecessor in pre-rename `VoiceContainerGlyph.ts` (commit `6cdd7783^`) called it **once**, after the only beat loop:

```ts
public applyLayoutingInfo(info: BarLayoutingInfo): void {
    const beatGlyphs: BeatContainerGlyph[] = this.beatGlyphs;
    for (const b of beatGlyphs) {
        b.applyLayoutingInfo(info);
    }
    this._scaleToForce(Math.max(this.renderer.settings.display.stretchForce, info.minStretchForce));
}
```

The multi-call pattern was introduced by commit `db84080d` ("feat: displaced note heads for multiple voices (#2430)", 2025-12-15). That commit replaced the file wholesale; the diff shows `_scaleToForce` placement was simply lifted with the new outer `for ... of this.beatGlyphs.values()` wrapped around the entire body, leaving the call site inside that wrapper. No commit message text, code comment, or PR title explains a deliberate per-voice rescale dependency.

## 2. Does each invocation produce different beat positions?

No.

Between invocation K and K+1, the only state mutated is whatever `b.applyLayoutingInfo(info)` writes for voice K's beats. Walking every `applyLayoutingInfo` implementation on `BeatContainerGlyphBase` subclasses:

- `BeatContainerGlyph.applyLayoutingInfo` (`packages/alphatab/src/rendering/glyphs/BeatContainerGlyph.ts:186-188`) — just calls `this.updateWidth()`. `updateWidth` (line 214-226) only writes `this._tieWidth` and `this.width` on the beat container itself.
- `MultiBarRestBeatContainerGlyph.applyLayoutingInfo` (`packages/alphatab/src/rendering/MultiBarRestBeatContainerGlyph.ts:130`) — empty body.
- `NumberedDashBeatContainerGlyph.applyLayoutingInfo` (`packages/alphatab/src/rendering/glyphs/NumberedDashBeatContainerGlyph.ts:180`) — empty body.

None of them touches `BarLayoutingInfo`. None of them touches another beat container's `x`. The single observable side-effect is that the beats of voice K now have a fresh `width` (max of preNotes + onNotes + tieWidth — finalized after ties resolved upstream).

## 3. What state does `_scaleToForce` read?

`_scaleToForce` (lines 61-150):

```ts
private _scaleToForce(force: number, onBeatSettled?: ...): void {
    this.width = this.renderer.layoutingInfo.calculateVoiceWidth(force);
    const positions = this.renderer.layoutingInfo.buildOnTimePositions(force);
    for (const beatGlyphs of this.beatGlyphs.values()) {
        for (let i = 0, j = beatGlyphs.length; i < j; i++) {
            // ... sets currentBeatGlyph.x from positions / graceSprings / prev beat's x+width
            // ... if (i>0) previous.scaleToWidth(currentX - previousX)
            // ... if (i===j-1) currentBeatGlyph.scaleToWidth(this.width - lastBeat.x)
        }
    }
}
```

Reads from `BarLayoutingInfo`:
- `spaceToForce(width)` — pure function of springs (already finalized by `_calculateSpringConstants` at `BarLayoutingInfo.ts:280`).
- `calculateVoiceWidth(force)` — pure function of `totalSpringConstant`, `_timeSortedSprings[0].preSpringWidth`, `_incompleteGraceRodsWidth`. All set at finish/recompute time.
- `buildOnTimePositions(force)` — **memoized on `force`** (`BarLayoutingInfo.ts:419-421`); returns the cached `Map` if `force` matches the previous call.
- `allGraceRods`, `incompleteGraceRods`, `getPreBeatSize(...)` — set during `finish()` / spring calculation, not during `applyLayoutingInfo`.

Reads from sibling beat containers:
- `beatGlyphs[i-1].x + beatGlyphs[i-1].width` — only for incomplete grace placement (lines 113, 118). `x` is set by `_scaleToForce` itself within the same call. `width` is read for the prior same-voice beat after it was width-updated either by `updateWidth()` (inner loop call) or by `scaleToWidth` (within `_scaleToForce` itself).

`force` is `Math.max(stretchForce, info.minStretchForce)`. `stretchForce` is a settings value (unchanged between voice iterations). `minStretchForce` is set inside `_calculateSpringConstants` (lines 303-326) and not touched by any `applyLayoutingInfo` call site.

Therefore: across the N invocations within one `applyLayoutingInfo` call, `force` is identical, `positions` is the same cached `Map`, `this.width` is overwritten to the same value, and **every** beat container x is recomputed identically to the prior pass. Because `_scaleToForce` iterates `this.beatGlyphs.values()` over ALL voices (not just the current one in the outer loop), each invocation re-positions every voice from scratch using the same inputs.

Invocations 2..N are no-ops on the resulting geometry. They differ from the single-call only in CPU cost.

## 4. The "rest displacement" workaround (`_doMultiVoiceLayout`)

`_doMultiVoiceLayout` is invoked from `doLayout` at `MultiVoiceContainerGlyph.ts:289-291`:

```ts
public override doLayout(): void {
    for (const v of this.beatGlyphs.values()) { /* ... b.doLayout(); ... */ }
    if (this.renderer.bar.isMultiVoice) {
        this._doMultiVoiceLayout();
    }
    this.voiceDrawOrder = Array.from(this.beatGlyphs.keys());
    Environment.sortDescending(this.voiceDrawOrder);
}
```

It runs strictly during `doLayout`, BEFORE `applyLayoutingInfo` is called by `BarRendererBase.applyLayoutingInfo` (`packages/alphatab/src/rendering/BarRendererBase.ts:525`). It does **not** run between voice iterations inside `applyLayoutingInfo` — there is no code path interleaving it.

So `_doMultiVoiceLayout` cannot justify the per-voice rescale. The multi-voice rest displacement is a `doLayout`-time concern only.

## 5. Voice draw order

`voiceDrawOrder` (line 25) is populated at `MultiVoiceContainerGlyph.ts:294-295` (descending sort of voice indices) and read only in three paint sites:

- `MultiVoiceContainerGlyph.paint` (line 316) — paint order.
- `LineBarRenderer.paintTuplets` (line 194) — paint order.
- `LineBarRenderer.paintBeams` (line 457) — paint order.

It is paint-only. It does not influence `applyLayoutingInfo`. `applyLayoutingInfo` simply iterates `this.beatGlyphs.values()` (insertion order from `addGlyph`).

## 6. Verdict and v2 implication

**Verdict: Accidental — refactoring artifact from `db84080d`.**

The pre-rename single-voice `VoiceContainerGlyph` (existed from commit `a1568068` "AlphaTab based on TypeScript (#356)" — the initial TypeScript port — through commit `6cdd7783`) had a `beatGlyphs: BeatContainerGlyph[]` flat array. Its `applyLayoutingInfo` ran one inner loop + one `_scaleToForce` call. The merge to multi-voice in `db84080d` wrapped the body of `_scaleToForce` and the body of `applyLayoutingInfo`'s beat loop in `for (const beatGlyphs of this.beatGlyphs.values())`. In `_scaleToForce` that outer iteration is needed (each voice's array gets sequential i/j cursor logic). In `applyLayoutingInfo` the outer loop only needs to wrap `b.applyLayoutingInfo(info)` — the `_scaleToForce` call should sit outside the outer loop, exactly as in the single-voice predecessor.

There is no PR text, code comment, regression test, or follow-up commit suggesting the per-voice rescale was deliberate.

### Fix

Move `_scaleToForce` out of the outer loop:

```ts
public applyLayoutingInfo(info: BarLayoutingInfo): void {
    for (const beatGlyphs of this.beatGlyphs.values()) {
        for (const b of beatGlyphs) {
            b.applyLayoutingInfo(info);
        }
    }
    this._scaleToForce(Math.max(this.renderer.settings.display.stretchForce, info.minStretchForce));
}
```

Runs once. Saves (N-1) full `beatGlyphs.values()` walks per bar per layout cycle, plus (N-1) calls to `calculateVoiceWidth`, plus (N-1) lookups of the memoized `buildOnTimePositions` map.

### Visual / behavioural impact

Pixel-identical for any bar with one voice (the loop body runs once anyway). For multi-voice bars: pixel-identical too, because the inner `applyLayoutingInfo` only mutates per-beat `width`/`_tieWidth` and `_scaleToForce` reads only `BarLayoutingInfo` plus same-voice sibling `x`/`width` (set by `_scaleToForce` itself within the call). The order of `b.applyLayoutingInfo` calls across voices does not change which `width` value voice K's beats have when `_scaleToForce` finally runs — they will all have their fresh widths from the inner loop.

One caveat to confirm with a visual diff run: the `previous.scaleToWidth(beatWidth)` call inside `_scaleToForce` (line 135) writes `previous.width = beatWidth`, overwriting whatever `updateWidth()` produced. In the current code, voice 0's beats get this `scaleToWidth` overwrite N times (once per outer iteration); after the fix they get it once. Result is identical because all N invocations write the same value.

### Breakage risk / tests to run

- `packages/alphatab/test/visualTests/features/MultiVoice.test.ts` — 730 lines covering multi-voice scenarios (added/expanded by `db84080d` itself).
- `packages/alphatab/test-data/visual-tests/layout/multi-voice.png` — reference baseline (regenerated in `db84080d`).
- Any visual reference with multi-voice + grace + tuplets (search visual-tests/ for multi-voice grace combinations).

Risk: low. The two calls produce identical x-positions by construction; pixel diff should be byte-identical. If it isn't, the difference reveals an unintended dependency in some subclass override not surveyed here (e.g. a custom `BeatContainerGlyphBase` subclass whose `applyLayoutingInfo` does mutate shared state), which would itself be a latent bug worth surfacing.

If a visual diff after the fix is non-empty, the next step is: bisect which voice ordering produces the diff, and check whether some `b.applyLayoutingInfo` implementation reads or writes another voice's x/width — at which point the answer flips to "architectural smell" and that cross-voice coupling is the upstream bug.

### v2 implication

The v2 doc (`/home/daniel/dev/alphaTab2/.docs/skyline-emission-architecture.md`) frames Spaced as "produces final positions" given a known force. The current per-voice call does not violate that contract semantically (each call produces the same final positions); it just wastes work. After the fix, the Spaced phase for `MultiVoiceContainerGlyph` is straightforwardly "one `_scaleToForce(force)` call, walks all voices once." No new sub-phase needed; the existing 3-phase model holds.

Phase ordering note for v2: `_doMultiVoiceLayout` (rest displacement) needs to run after intrinsic widths are known but before Spaced positions are written. Today it sits at the end of `doLayout` (Intrinsic phase). That placement is correct under v2 and is independent of the fix described here.

---

## File:line summary

- `MultiVoiceContainerGlyph.ts:160-167` — `applyLayoutingInfo` body with the misplaced loop.
- `MultiVoiceContainerGlyph.ts:61-150` — `_scaleToForce`, iterates all voices internally.
- `MultiVoiceContainerGlyph.ts:289-296` — `doLayout` invokes `_doMultiVoiceLayout` (not in the rescale path).
- `BeatContainerGlyph.ts:186-188` — base `applyLayoutingInfo` calls `updateWidth()`, no `BarLayoutingInfo` mutation.
- `BeatContainerGlyph.ts:214-226` — `updateWidth` is local.
- `BarLayoutingInfo.ts:415-435` — `buildOnTimePositions` memoized on `force`.
- `BarLayoutingInfo.ts:303-326` — `minStretchForce` set in `_calculateSpringConstants`, not in `applyLayoutingInfo`.
- `LineBarRenderer.ts:194, 457` and `MultiVoiceContainerGlyph.ts:316` — only sites reading `voiceDrawOrder` (all paint-time).
- Commit `db84080d` ("feat: displaced note heads for multiple voices (#2430)", 2025-12-15) — introduced the file `MultiVoiceContainerGlyph.ts` with the misplaced loop.
- Pre-rename `VoiceContainerGlyph.ts` (at `6cdd7783^`) — single call, outside the loop.

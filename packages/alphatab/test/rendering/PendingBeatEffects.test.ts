/**
 * §E Step 4 acceptance — `_pendingBeatEffectsByBeat` folded into the beat walk.
 *
 * Per-beat effect overflow ranges are now stored directly on each
 * `BeatContainerGlyphBase` (`pendingEffectOverflows`) and consumed in
 * `BarRendererBase.scaleToWidth`'s per-beat callback by reading the
 * container's own array. This retires the renderer-level
 * `_pendingBeatEffectsByBeat: Map<beatId, …>` (B.6) and removes the
 * `if (beatId >= 0)` defensive guard against `MultiBarRestBeatContainerGlyph.beatId === -1`
 * (B.20).
 *
 * The acceptance contract:
 *   - `pendingEffectOverflows` is declared on the abstract base class, so
 *     every subclass (including `MultiBarRestBeatContainerGlyph`) inherits an
 *     initially-empty array — the per-beat callback no longer needs a
 *     synthetic-id guard because the multi-bar-rest container's array is
 *     simply empty.
 *   - A fresh container starts with `[]`.
 *   - The per-beat callback in `scaleToWidth` can iterate the array directly;
 *     for empty arrays this is a no-op.
 */

import { describe, expect, it } from 'vitest';
import { MultiBarRestBeatContainerGlyph } from '@coderline/alphatab/rendering/MultiBarRestBeatContainerGlyph';

describe('PendingBeatEffects', () => {
    it('MultiBarRestBeatContainerGlyph inherits pendingEffectOverflows as an empty array (B.20)', () => {
        const c = new MultiBarRestBeatContainerGlyph();
        expect(Array.isArray(c.pendingEffectOverflows)).toBe(true);
        expect(c.pendingEffectOverflows.length).toBe(0);
        // beatId is still -1 for the multi-bar-rest synthetic container, but it
        // is no longer consulted by `BarRendererBase.scaleToWidth`'s per-beat
        // callback — the empty array makes the iteration a no-op without any
        // `beatId >= 0` guard.
        expect(c.beatId).toBe(-1);
    });

    it('pendingEffectOverflows accepts push and preserves insertion order', () => {
        const c = new MultiBarRestBeatContainerGlyph();
        c.pendingEffectOverflows.push({ minY: -10, maxY: 5 });
        c.pendingEffectOverflows.push({ minY: -3, maxY: 12 });
        expect(c.pendingEffectOverflows).toEqual([
            { minY: -10, maxY: 5 },
            { minY: -3, maxY: 12 }
        ]);
    });
});

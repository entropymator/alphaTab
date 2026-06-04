/**
 * Per-beat effect overflow ranges live on each BeatContainerGlyphBase as
 * `pendingEffectOverflows`.
 */
import type { BeatEffectOverflow } from '@coderline/alphatab/rendering/glyphs/BeatContainerGlyph';
import { MultiBarRestBeatContainerGlyph } from '@coderline/alphatab/rendering/MultiBarRestBeatContainerGlyph';
import { describe, expect, it } from 'vitest';

describe('PendingBeatEffects', () => {
    it('MultiBarRestBeatContainerGlyph inherits pendingEffectOverflows as an empty array', () => {
        const c = new MultiBarRestBeatContainerGlyph();
        expect(c.pendingEffectOverflows.length).toBe(0);
        expect(c.beatId).toBe(-1);
    });

    it('pendingEffectOverflows accepts push and preserves insertion order', () => {
        const c = new MultiBarRestBeatContainerGlyph();
        const first: BeatEffectOverflow = { minY: -10, maxY: 5 };
        const second: BeatEffectOverflow = { minY: -3, maxY: 12 };
        c.pendingEffectOverflows.push(first);
        c.pendingEffectOverflows.push(second);

        expect(c.pendingEffectOverflows.length).toBe(2);
        expect(c.pendingEffectOverflows[0].minY).toBe(-10);
        expect(c.pendingEffectOverflows[0].maxY).toBe(5);
        expect(c.pendingEffectOverflows[1].minY).toBe(-3);
        expect(c.pendingEffectOverflows[1].maxY).toBe(12);
    });
});

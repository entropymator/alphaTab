import type { ICanvas } from '@coderline/alphatab/platform/ICanvas';
import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';

/**
 * Phase tag for {@link Glyph.populateSkyline} dispatch.
 *
 * - `'finalized'` — Phase 3, dispatched at the end of `BarRendererBase.scaleToWidth`
 *   when all renderer-local positions are settled. Use for glyphs whose skyline
 *   contribution depends on bar-final layout state (e.g. `BarTempoGlyph`'s
 *   `getRatioPositionX` reads `voiceContainer.x` / `_postBeatGlyphs.x`).
 * - `'systemFinalize'` — SystemFinalize sub-step (ii), dispatched after every
 *   renderer in the staff has `isFinalized = true`. Use for glyphs whose skyline
 *   contribution depends on cross-renderer chain state (e.g. `GroupedEffectGlyph`'s
 *   end-X via `nextGlyph`/`isLinkedWithNext` walk in Step 16).
 *
 * @internal
 */
export type SkylinePhase = 'finalized' | 'systemFinalize';

/**
 * Context passed to {@link Glyph.populateSkyline}. The implementer pulls its
 * write destination from `ctx.renderer` (e.g. `ctx.renderer.insertSkylineTop`,
 * or `ctx.renderer.barLocalSkyline`).
 *
 * @internal
 */
export interface SkylineCtx {
    phase: SkylinePhase;
    renderer: BarRendererBase;
}

/**
 * A glyph is a single symbol which can be added to a GlyphBarRenderer for automated
 * layouting and drawing of stacked symbols.
 * @internal
 */
export class Glyph {
    public x: number;
    public y: number;
    public width: number = 0;
    public height: number = 0;
    public renderer!: BarRendererBase;

    public constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
    }

    public getBoundingBoxTop() {
        return this.y;
    }

    public getBoundingBoxBottom() {
        return this.getBoundingBoxTop() + this.height;
    }

    /**
     * Paint extent — distinct from the rhythmic-spacing extent (`x`, `x + width`).
     * Override on zero-width "no-rod" glyphs so the bar-local skyline still sees them.
     */
    public getBoundingBoxLeft(): number {
        return this.x;
    }

    public getBoundingBoxRight(): number {
        return this.x + this.width;
    }

    public doLayout(): void {
        // to be implemented in subclass
    }

    /**
     * Optional Phase 3 / SystemFinalize-substep-(ii) skyline contribution. Glyphs
     * whose skyline contribution depends on layout state that is only final after
     * Phase 1 (e.g. post-beat group offset, cross-renderer chain x-end) opt in by
     * (a) calling `renderer.registerPopulateSkyline(this, phase)` from their
     * `doLayout`, and (b) implementing this method to emit into the renderer's
     * appropriate skyline. The dispatch fires once per cycle in the registered
     * phase. See {@link SkylinePhase}.
     */
    public populateSkyline?(ctx: SkylineCtx): void;

    public paint(_cx: number, _cy: number, _canvas: ICanvas): void {
        // to be implemented in subclass
    }
}

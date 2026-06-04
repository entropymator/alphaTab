import type { ICanvas } from '@coderline/alphatab/platform/ICanvas';
import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';

/**
 * Phase tag for {@link Glyph.populateSkyline} dispatch.
 *
 * - `'finalized'` fires at the end of {@link BarRendererBase.scaleToWidth},
 *   when renderer-local positions are settled. Use when the glyph's skyline
 *   contribution depends on bar-final layout state.
 * - `'systemFinalize'` fires after every renderer in the staff has
 *   `isFinalized = true`. Use when the contribution depends on cross-renderer
 *   chain state.
 *
 * @internal
 */
export type SkylinePhase = 'finalized' | 'systemFinalize';

/**
 * Context passed to {@link Glyph.populateSkyline}. The implementer pulls its
 * write destination from `ctx.renderer`.
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
     * Optional skyline contribution for glyphs whose bbox is only final after
     * the bar (or staff) is laid out. Opt in by calling
     * `renderer.registerPopulateSkyline(this, phase)` from `doLayout`. Fires
     * once per cycle in the registered {@link SkylinePhase}.
     */
    public populateSkyline?(ctx: SkylineCtx): void;

    public paint(_cx: number, _cy: number, _canvas: ICanvas): void {
        // to be implemented in subclass
    }
}

import type { ICanvas } from '@coderline/alphatab/platform/ICanvas';
import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';

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
     * Left/right edges of the glyph's **paint extent** — distinct from
     * `x`/`x + width` which describe the **rhythmic-spacing extent** (the
     * "rod" used by the layouting info to compute bar widths). Many glyphs
     * intentionally set `width = 0` to opt out of rhythmic spacing while
     * still painting over a real horizontal range (ties / slurs, tempo
     * marks, multi-bar rest labels, ...).
     *
     * Every skyline-insert call site reads from these two accessors so
     * zero-width "no-rod" glyphs still contribute to the bar-local
     * skyline. Default mirrors the rhythmic-spacing extent; subclasses
     * with a wider paint extent override.
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

    public paint(_cx: number, _cy: number, _canvas: ICanvas): void {
        // to be implemented in subclass
    }
}

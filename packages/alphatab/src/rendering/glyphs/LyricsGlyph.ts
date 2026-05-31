import type { Font } from '@coderline/alphatab/model/Font';
import { type ICanvas, TextAlign } from '@coderline/alphatab/platform/ICanvas';
import { EffectGlyph } from '@coderline/alphatab/rendering/glyphs/EffectGlyph';

/**
 * @internal
 */
export class LyricsGlyph extends EffectGlyph {
    private _lines: string[];
    private _linePositions: number[] = [];
    private _maxLineWidth: number = 0;

    public font: Font;
    public textAlign: TextAlign;

    public constructor(x: number, y: number, lines: string[], font: Font, textAlign: TextAlign = TextAlign.Center) {
        super(x, y);
        this._lines = lines;
        this.font = font;
        this.textAlign = textAlign;
    }

    public override doLayout(): void {
        super.doLayout();

        const lineSpacing = this.renderer.settings.display.lyricLinesPaddingBetween;

        const canvas = this.renderer.scoreRenderer.canvas!;
        canvas.font = this.font;
        let y = 0;
        let maxWidth = 0;
        for (const line of this._lines) {
            this._linePositions.push(y);
            const size = canvas.measureText(line.length > 0 ? line : ' ');
            y += size.height + lineSpacing;
            if (size.width > maxWidth) {
                maxWidth = size.width;
            }
        }
        y -= lineSpacing;

        this.height = y;
        this._maxLineWidth = maxWidth;
    }

    /**
     * Lyrics intentionally keep `this.width = 0` to stay out of the bar's
     * rhythmic-spacing calculation (lyric horizontal extent is reserved
     * separately via the overlay-rod system). The default `Glyph` bbox
     * accessors would therefore return a zero-width range `(x, x)` and
     * the per-x skyline would never see the lyric — breaking
     * `bottomEffects.height` and the canvas's vertical allocation.
     *
     * Override to return the actual painted extent, accounting for
     * `textAlign`: the longest line's measured width sets the bbox span,
     * anchored relative to `this.x` according to the alignment.
     */
    public override getBoundingBoxLeft(): number {
        switch (this.textAlign) {
            case TextAlign.Center:
                return this.x - this._maxLineWidth / 2;
            case TextAlign.Right:
                return this.x - this._maxLineWidth;
            default:
                return this.x;
        }
    }

    public override getBoundingBoxRight(): number {
        switch (this.textAlign) {
            case TextAlign.Center:
                return this.x + this._maxLineWidth / 2;
            case TextAlign.Right:
                return this.x;
            default:
                return this.x + this._maxLineWidth;
        }
    }

    public override paint(cx: number, cy: number, canvas: ICanvas): void {
        canvas.font = this.font;
        const old = canvas.textAlign;
        canvas.textAlign = this.textAlign;
        for (let i: number = 0; i < this._lines.length; i++) {
            if (this._lines[i]) {
                canvas.fillText(this._lines[i], cx + this.x, cy + this.y + this._linePositions[i]);
            }
        }
        canvas.textAlign = old;
    }
}

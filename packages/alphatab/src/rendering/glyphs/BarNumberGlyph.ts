import { TextBaseline, type ICanvas } from '@coderline/alphatab/platform/ICanvas';
import type { RenderingResources } from '@coderline/alphatab/RenderingResources';
import { Glyph } from '@coderline/alphatab/rendering/glyphs/Glyph';
import type { LineBarRenderer } from '@coderline/alphatab/rendering/LineBarRenderer';
import { ElementStyleHelper } from '@coderline/alphatab/rendering/utils/ElementStyleHelper';
import { NotationElement } from '@coderline/alphatab/NotationSettings';

/**
 * @internal
 */
export class BarNumberGlyph extends Glyph {
    private _number: string;

    public constructor(x: number, y: number, num: number) {
        super(x, y);
        this._number = `${num}  `;
    }

    public override doLayout(): void {
        this.renderer.scoreRenderer.canvas!.font = this.renderer.resources.elementFonts.get(NotationElement.BarNumber)!;
        const size = this.renderer.scoreRenderer.canvas!.measureText(this._number);
        this.width = size.width;
        this.height = size.height;
        this.y -= this.height;
    }

    /**
     * `paint` is a no-op on non-first staves (the bar number is drawn
     * only once per system, on the top staff). On those staves the
     * un-painted bar number still has to reserve vertical space — so
     * lower staves with a short clef (tabs, bass) keep their grand-staff
     * gap above — but it must NOT register as a horizontal obstacle in
     * the skyline (otherwise centered effect glyphs at the bar's left
     * edge get pushed up to clear an invisible label).
     *
     * Solution: collapse the **horizontal** bbox to a degenerate range
     * (`Left == Right`). `Skyline._raiseRange` returns early when
     * `lo >= hi`, so `populateBarLocalSkyline.insertSkylineTop` becomes
     * a no-op. The **vertical** bbox stays at its natural extent so
     * `calculateOverflows` still calls `registerOverflowTop(height)` —
     * and since that's a `max`, the bar number only contributes when
     * the staff's clef / pre-beat content doesn't already exceed it.
     * Net effect: treble clefs absorb the bar number's vertical extent
     * (no extra padding), tab/bass staves get exactly the bar-number-
     * sized reservation.
     */
    public override getBoundingBoxLeft(): number {
        if (!this.renderer.staff!.isFirstInSystem) {
            return this.x;
        }
        return super.getBoundingBoxLeft();
    }

    public override getBoundingBoxRight(): number {
        if (!this.renderer.staff!.isFirstInSystem) {
            return this.x;
        }
        return super.getBoundingBoxRight();
    }

    public override paint(cx: number, cy: number, canvas: ICanvas): void {
        if (!this.renderer.staff!.isFirstInSystem) {
            return;
        }

        using _ = ElementStyleHelper.bar(
            canvas,
            (this.renderer as LineBarRenderer).barNumberBarSubElement,
            this.renderer.bar,
            true
        );

        const res: RenderingResources = this.renderer.resources;
        const baseline = canvas.textBaseline;
        canvas.font = res.elementFonts.get(NotationElement.BarNumber)!;
        canvas.textBaseline = TextBaseline.Top;
        canvas.fillText(this._number, cx + this.x, cy + this.y);
        canvas.textBaseline = baseline;
    }
}

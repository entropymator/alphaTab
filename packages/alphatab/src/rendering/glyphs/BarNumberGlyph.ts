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
        // bbox depends on `staff.system.firstVisibleStaff` which is assigned
        // by `StaffSystem.addBars` only after every `RenderStaff.addBar` (and
        // hence every renderer's `doLayout`) has returned. The dynamic-skyline
        // emit is therefore deferred to `BarRendererBase.scaleToWidth`, the
        // first cycle seam at which that field is stable; do not hoist it
        // earlier.
        this.renderer.registerDynamicSkylineGlyph(this);
    }

    /**
     * Non-first staves don't paint the bar number, but still reserve its
     * vertical space via the scalar overflow. Collapse the horizontal
     * bbox so the per-x skyline doesn't see a phantom obstacle.
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

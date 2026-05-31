import type { Beat } from '@coderline/alphatab/model/Beat';
import type { ICanvas } from '@coderline/alphatab/platform/ICanvas';
import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';
import type { BeatXPosition } from '@coderline/alphatab/rendering/BeatXPosition';
import { EffectGlyph } from '@coderline/alphatab/rendering/glyphs/EffectGlyph';

/**
 * @internal
 */
export abstract class GroupedEffectGlyph extends EffectGlyph {
    protected endPosition: BeatXPosition;
    protected forceGroupedRendering: boolean = false;
    protected endOnBarLine: boolean = false;

    protected constructor(endPosition: BeatXPosition) {
        super();
        this.endPosition = endPosition;
    }

    /**
     * Right edge of the paint extent. GroupedEffectGlyphs all paint
     * from their anchor `this.x` to `endX = renderer.getBeatX(beat,
     * endPosition)` — the beat's end position in renderer-local x.
     * The bbox default would otherwise return `this.x + width = this.x`
     * (zero width), and `EffectBand.computeLocalXRange` would collapse
     * to a degenerate point so the per-x skyline can't see the
     * effect's actual horizontal range.
     *
     * Subclasses that paint to the LEFT of `this.x` (centered SMuFL
     * symbols — {@link OttavaGlyph}, {@link TrillGlyph}) override
     * `getBoundingBoxLeft` to reflect the symbol's left edge; the
     * right edge defined here stays correct because their wavy line /
     * dashed line still terminates at `endX`.
     */
    public override getBoundingBoxRight(): number {
        if (!this.beat) {
            return super.getBoundingBoxRight();
        }
        return this.renderer.getBeatX(this.beat, this.endPosition);
    }

    public get isLinkedWithPrevious(): boolean {
        return !!this.previousGlyph && this.previousGlyph.renderer.staff?.system === this.renderer.staff!.system;
    }

    public get isLinkedWithNext(): boolean {
        return (
            !!this.nextGlyph &&
            this.nextGlyph.renderer.isFinalized &&
            this.nextGlyph.renderer.staff?.system === this.renderer.staff!.system
        );
    }

    public override paint(cx: number, cy: number, canvas: ICanvas): void {
        // if we are linked with the previous, the first glyph of the group will also render this one.
        if (this.isLinkedWithPrevious) {
            return;
        }
        // we are not linked with any glyph therefore no expansion is required, we render a simple glyph.
        if (!this.isLinkedWithNext && !this.forceGroupedRendering) {
            this.paintNonGrouped(cx, cy, canvas);
            return;
        }
        // find last linked glyph that can be
        let lastLinkedGlyph: GroupedEffectGlyph;
        if (!this.isLinkedWithNext && this.forceGroupedRendering) {
            lastLinkedGlyph = this;
        } else {
            lastLinkedGlyph = this.nextGlyph as GroupedEffectGlyph;
            while (lastLinkedGlyph.isLinkedWithNext) {
                lastLinkedGlyph = lastLinkedGlyph.nextGlyph as GroupedEffectGlyph;
            }
        }
        // use start position of next beat when possible
        const endBeatRenderer: BarRendererBase = lastLinkedGlyph.renderer;
        const endBeat: Beat = lastLinkedGlyph.beat!;
        const position: BeatXPosition = this.endPosition;
        // calculate end X-position
        const cxRenderer: number = cx - this.renderer.x;
        const endX: number = this.calculateEndX(endBeatRenderer, endBeat, cxRenderer, position);
        this.paintGrouped(cx, cy, endX, canvas);
    }

    protected calculateEndX(
        endBeatRenderer: BarRendererBase,
        endBeat: Beat | null,
        cx: number,
        endPosition: BeatXPosition
    ): number {
        if (!endBeat) {
            return cx + endBeatRenderer.x + this.x + this.width;
        }
        return cx + endBeatRenderer.x + endBeatRenderer.getBeatX(endBeat, endPosition);
    }

    protected paintNonGrouped(cx: number, cy: number, canvas: ICanvas): void {
        const cxRenderer: number = cx - this.renderer.x;
        const endX: number = this.calculateEndX(this.renderer, this.beat, cxRenderer, this.endPosition);
        this.paintGrouped(cx, cy, endX, canvas);
    }

    protected abstract paintGrouped(cx: number, cy: number, endX: number, canvas: ICanvas): void;
}

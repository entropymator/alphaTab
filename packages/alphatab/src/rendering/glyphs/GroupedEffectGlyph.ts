import type { Beat } from '@coderline/alphatab/model/Beat';
import type { ICanvas } from '@coderline/alphatab/platform/ICanvas';
import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';
import type { BeatXPosition } from '@coderline/alphatab/rendering/BeatXPosition';
import { EffectGlyph } from '@coderline/alphatab/rendering/glyphs/EffectGlyph';
import type { SkylineCtx } from '@coderline/alphatab/rendering/glyphs/Glyph';

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

    public override getBoundingBoxRight(): number {
        if (!this.beat) {
            return super.getBoundingBoxRight();
        }
        return this.renderer.getBeatX(this.beat, this.endPosition);
    }

    /**
     * Publishes the chain's true cross-renderer painted xEnd to the owning
     * {@link EffectBand} so {@link EffectBand.computeLocalXRange} covers
     * intermediate columns between the chain head's local bbox and the chain
     * tail's renderer. Only the chain head registers (see {@link EffectBand}).
     */
    public override populateSkyline(_ctx: SkylineCtx): void {
        if (this.isLinkedWithPrevious) {
            return;
        }
        if (!this.isLinkedWithNext) {
            // Chain head with no `isLinkedWithNext` paints within its local
            // renderer; the band's per-glyph bbox loop already covers it.
            return;
        }
        let last: GroupedEffectGlyph = this.nextGlyph as GroupedEffectGlyph;
        while (last.isLinkedWithNext) {
            last = last.nextGlyph as GroupedEffectGlyph;
        }
        // Mirror `paint`'s endX calculation: tail-renderer's beatX of the tail
        // beat at the chain's `endPosition`.
        const trueEndXStaff = last.renderer.x + last.renderer.getBeatX(last.beat!, this.endPosition);
        const trueEndXLocal = trueEndXStaff - this.renderer.x;
        const xStart = this.getBoundingBoxLeft();
        if (trueEndXLocal <= xStart) {
            return;
        }
        this.band?.publishSpanRange(xStart, trueEndXLocal);
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

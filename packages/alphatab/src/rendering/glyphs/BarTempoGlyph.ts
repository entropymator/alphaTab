import type { Automation } from '@coderline/alphatab/model/Automation';
import { MusicFontSymbol } from '@coderline/alphatab/model/MusicFontSymbol';
import { NotationElement } from '@coderline/alphatab/NotationSettings';
import { CanvasHelper, TextBaseline, type ICanvas } from '@coderline/alphatab/platform/ICanvas';
import { EffectGlyph } from '@coderline/alphatab/rendering/glyphs/EffectGlyph';

/**
 * This glyph renders tempo annotations for tempo automations
 * where the drawing position is determined more dynamically while rendering.
 * @internal
 */
export class BarTempoGlyph extends EffectGlyph {
    private _tempoAutomations: Automation[];

    /**
     * Sum of every automation's rendered width (text + quarter-note
     * symbol + ` = NNN` text). The glyph keeps `width = 0` so it doesn't
     * stretch the bar's rhythmic-spacing rod, but the paint extent is
     * exposed via {@link getBoundingBoxLeft} / {@link getBoundingBoxRight}
     * so the skyline integration (and EffectSystemPlacement's
     * `computeLocalXRange`) see a real x-range instead of a degenerate
     * point.
     */
    private _paintWidth: number = 0;

    public constructor(tempoAutomations: Automation[]) {
        super(0, 0);
        this._tempoAutomations = tempoAutomations;
    }

    public override doLayout(): void {
        super.doLayout();
        const res = this.renderer.resources;
        const scale = res.engravingSettings.tempoNoteScale;
        const symbolWidth =
            this.renderer.smuflMetrics.glyphWidths.get(MusicFontSymbol.MetNoteQuarterUp)! * scale;
        this.height =
            this.renderer.smuflMetrics.glyphHeights.get(MusicFontSymbol.MetNoteQuarterUp)! * scale;

        const canvas = this.renderer.scoreRenderer.canvas!;
        canvas.font = res.elementFonts.get(NotationElement.EffectMarker)!;
        let total = 0;
        for (const automation of this._tempoAutomations) {
            let segment = symbolWidth;
            if (automation.text) {
                segment += canvas.measureText(`${automation.text} `).width;
            }
            segment += canvas.measureText(` = ${automation.value.toString()}`).width;
            total += segment;
        }
        this._paintWidth = total;
    }

    public override getBoundingBoxLeft(): number {
        return this.x;
    }

    public override getBoundingBoxRight(): number {
        return this.x + this._paintWidth;
    }

    public override paint(cx: number, cy: number, canvas: ICanvas): void {
        for (const automation of this._tempoAutomations) {
            let x = cx + this.renderer.getRatioPositionX(automation.ratioPosition);

            const res = this.renderer.resources;
            canvas.font = res.elementFonts.get(NotationElement.EffectMarker)!;

            const notePosY =
                cy +
                this.y +
                this.height +
                this.renderer.smuflMetrics.glyphBottom.get(MusicFontSymbol.MetNoteQuarterUp)! *
                    res.engravingSettings.tempoNoteScale;

            const b = canvas.textBaseline;
            canvas.textBaseline = TextBaseline.Alphabetic;
            if (automation.text) {
                const text = `${automation.text} `; // additional space
                const size = canvas.measureText(text);
                canvas.fillText(text, x, notePosY);
                x += size.width;
            } else {
                x -= res.engravingSettings.glyphWidths.get(MusicFontSymbol.MetNoteQuarterUp)! / 2;
            }

            CanvasHelper.fillMusicFontSymbolSafe(
                canvas,
                x,
                notePosY,
                res.engravingSettings.tempoNoteScale,
                MusicFontSymbol.MetNoteQuarterUp
            );
            x +=
                this.renderer.smuflMetrics.glyphWidths.get(MusicFontSymbol.MetNoteQuarterUp)! *
                res.engravingSettings.tempoNoteScale;

            canvas.fillText(` = ${automation.value.toString()}`, x, notePosY);
            canvas.textBaseline = b;

            x += canvas.measureText(` = ${automation.value.toString()}`).width;
        }
    }
}

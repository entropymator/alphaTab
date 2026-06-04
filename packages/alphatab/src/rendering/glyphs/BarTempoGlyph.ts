import type { Automation } from '@coderline/alphatab/model/Automation';
import { MusicFontSymbol } from '@coderline/alphatab/model/MusicFontSymbol';
import { NotationElement } from '@coderline/alphatab/NotationSettings';
import { CanvasHelper, type ICanvas, TextBaseline } from '@coderline/alphatab/platform/ICanvas';
import { EffectGlyph } from '@coderline/alphatab/rendering/glyphs/EffectGlyph';
import { type SkylineCtx, SkylinePhase } from '@coderline/alphatab/rendering/glyphs/Glyph';

/**
 * @record
 * @internal
 */
interface TempoAutomationLayout {
    textWidth: number;
    valueWidth: number;
}

/**
 * This glyph renders tempo annotations for tempo automations
 * where the drawing position is determined more dynamically while rendering.
 * @internal
 */
export class BarTempoGlyph extends EffectGlyph {
    private _tempoAutomations: Automation[];

    private _automationLayouts: TempoAutomationLayout[] = [];
    private _symbolWidth: number = 0;
    private _noteShift: number = 0;

    public constructor(tempoAutomations: Automation[]) {
        super(0, 0);
        this._tempoAutomations = tempoAutomations;
    }

    public override doLayout(): void {
        super.doLayout();
        // bbox depends on `getRatioPositionX`, which reads voiceContainer.x /
        // _postBeatGlyphs.x — both only final at scaleToWidth time.
        this.renderer.registerPopulateSkyline(this, SkylinePhase.Finalized);
        const res = this.renderer.resources;
        const scale = res.engravingSettings.tempoNoteScale;
        this._symbolWidth = this.renderer.smuflMetrics.glyphWidths.get(MusicFontSymbol.MetNoteQuarterUp)! * scale;
        // Mirrors the text-less branch in `paint`: engraving-settings width, not smufl metric.
        this._noteShift = res.engravingSettings.glyphWidths.get(MusicFontSymbol.MetNoteQuarterUp)! / 2;
        this.height = this.renderer.smuflMetrics.glyphHeights.get(MusicFontSymbol.MetNoteQuarterUp)! * scale;

        const canvas = this.renderer.scoreRenderer.canvas!;
        canvas.font = res.elementFonts.get(NotationElement.EffectMarker)!;
        this._automationLayouts = [];
        for (const automation of this._tempoAutomations) {
            const textWidth = automation.text ? canvas.measureText(`${automation.text} `).width : 0;
            const valueWidth = canvas.measureText(` = ${automation.value.toString()}`).width;
            this._automationLayouts.push({ textWidth, valueWidth });
        }
    }

    public override getBoundingBoxLeft(): number {
        let min = 0;
        let found = false;
        for (const a of this._tempoAutomations) {
            let startX = this.renderer.getRatioPositionX(a.ratioPosition);
            if (!a.text) {
                startX -= this._noteShift;
            }
            if (!found || startX < min) {
                min = startX;
                found = true;
            }
        }
        return found ? min : this.x;
    }

    public override getBoundingBoxRight(): number {
        let max = 0;
        let found = false;
        for (let i = 0; i < this._tempoAutomations.length; i++) {
            const a = this._tempoAutomations[i];
            const layout = this._automationLayouts[i];
            let startX = this.renderer.getRatioPositionX(a.ratioPosition);
            if (!a.text) {
                startX -= this._noteShift;
            }
            const rightX = startX + layout.textWidth + this._symbolWidth + layout.valueWidth;
            if (!found || rightX > max) {
                max = rightX;
                found = true;
            }
        }
        return found ? max : this.x;
    }

    public override populateSkyline(ctx: SkylineCtx): void {
        // Emit the now-final bbox extent into the renderer's bar-local skyline.
        const rendererBottom = ctx.renderer.height;
        const topY = this.getBoundingBoxTop();
        const bottomY = this.getBoundingBoxBottom();
        const xL = this.getBoundingBoxLeft();
        const xR = this.getBoundingBoxRight();
        if (xR <= xL) {
            return;
        }
        if (topY < 0) {
            ctx.renderer.insertSkylineTop(xL, xR, topY * -1);
        }
        if (bottomY > rendererBottom) {
            ctx.renderer.insertSkylineBottom(xL, xR, bottomY - rendererBottom);
        }
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

import type { Beat } from '@coderline/alphatab/model/Beat';
import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';
import { EffectBarGlyphSizing } from '@coderline/alphatab/rendering/EffectBarGlyphSizing';
import type { EffectGlyph } from '@coderline/alphatab/rendering/glyphs/EffectGlyph';
import { FermataGlyph } from '@coderline/alphatab/rendering/glyphs/FermataGlyph';
import { EffectInfo } from '@coderline/alphatab/rendering/EffectInfo';
import type { Settings } from '@coderline/alphatab/Settings';
import { NotationElement } from '@coderline/alphatab/NotationSettings';

/**
 * @internal
 */
export class FermataEffectInfo extends EffectInfo {
    public get notationElement(): NotationElement {
        return NotationElement.EffectFermata;
    }

    public get hideOnMultiTrack(): boolean {
        return false;
    }

    public get sizingMode(): EffectBarGlyphSizing {
        return EffectBarGlyphSizing.SingleOnBeat;
    }

    public shouldCreateGlyph(_settings: Settings, beat: Beat): boolean {
        return beat.voice.index === 0 && !!beat.fermata;
    }

    public createNewGlyph(_renderer: BarRendererBase, beat: Beat): EffectGlyph {
        return new FermataGlyph(0, 0, beat.fermata!.type);
    }

    public canExpand(_from: Beat, _to: Beat): boolean {
        return true;
    }

    /**
     * {@link FermataGlyph} paints center-aligned around the beat's
     * `onTimeX` (half-width to the left, half-width to the right).
     * Without feeding that into the bar's rhythmic spacing, beats that
     * sit next to a tight pre-beat element (bar number, barline) end up
     * with the fermata's left half overlapping it visually. Enabling
     * this flag asks {@link EffectBand.registerLayoutingInfo} to push
     * the fermata's paint extent into the beat's spring so the layout
     * solver reserves the half-width clearance.
     */
    public override get contributesToBeatSpacing(): boolean {
        return true;
    }
}

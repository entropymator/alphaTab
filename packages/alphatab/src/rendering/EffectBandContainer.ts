import type { Voice } from '@coderline/alphatab/model/Voice';
import type { ICanvas } from '@coderline/alphatab/platform/ICanvas';
import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';
import type { EffectBandInfo } from '@coderline/alphatab/rendering/BarRendererFactory';
import { EffectBand } from '@coderline/alphatab/rendering/EffectBand';

/**
 * Holds the per-(voice × effect) {@link EffectBand} list for one side
 * (above- or below-staff) of a bar renderer. Layout/placement is delegated
 * to {@link EffectSystemPlacement}; this class only owns band lifecycle,
 * per-band glyph alignment and painting.
 * @internal
 */
export class EffectBandContainer {
    private _bands: EffectBand[] = [];
    private _bandLookup: Map<string, EffectBand> = new Map();
    public height: number = 0;

    public infos!: EffectBandInfo[];
    private _renderer: BarRendererBase;
    private _isTopContainer: boolean;

    public get bands(): readonly EffectBand[] {
        return this._bands;
    }

    public get isTopContainer(): boolean {
        return this._isTopContainer;
    }

    public alignGlyphs() {
        for (const effectBand of this._bands) {
            effectBand.resetHeight();
            effectBand.alignGlyphs();
        }
    }

    public get previousContainer(): EffectBandContainer | undefined {
        return this._renderer.index === 0
            ? undefined
            : this._isTopContainer
              ? this._renderer.previousRenderer!.topEffects
              : this._renderer.previousRenderer!.bottomEffects;
    }

    public get isLinkedToPreviousRenderer() {
        return this._bands.some(b => b.isLinkedToPrevious);
    }

    public constructor(renderer: BarRendererBase, isTopContainer: boolean) {
        this._renderer = renderer;
        this._isTopContainer = isTopContainer;
    }

    public createVoiceGlyphs(voice: Voice) {
        const renderer = this._renderer;
        const notationSettings = renderer.settings.notation;
        for (const info of this.infos) {
            if (!notationSettings.isNotationElementVisible(info.effect.notationElement)) {
                continue;
            }

            let band: EffectBand | undefined = undefined;

            for (const b of voice.beats) {
                // lazy create band to avoid creating and managing bands for all events
                // even if only a few exist
                if (!band && EffectBand.shouldCreateGlyph(b, info.effect, renderer)) {
                    band = new EffectBand(voice, info.effect, this);
                    band.renderer = this._renderer;
                    band.doLayout();
                    this._bands.push(band);
                    this._bandLookup.set(`${voice.index}.${info.effect.effectId}`, band);
                }

                if (band !== undefined) {
                    band.createGlyph(b);
                }
            }
        }
    }

    public doLayout() {
        this._bands = [];
        this._bandLookup = new Map<string, EffectBand>();
        this.height = 0;
    }

    public paint(cx: number, cy: number, canvas: ICanvas) {
        const resources = this._renderer.resources;
        for (const effectBand of this._bands) {
            canvas.color = effectBand.voice.index === 0 ? resources.mainGlyphColor : resources.secondaryGlyphColor;
            if (!effectBand.isEmpty) {
                effectBand.paint(cx, cy, canvas);
            }
        }
    }

    public getBand(voice: Voice, effectId: string): EffectBand | null {
        const id: string = `${voice.index}.${effectId}`;
        if (this._bandLookup.has(id)) {
            return this._bandLookup.get(id)!;
        }
        return null;
    }
}

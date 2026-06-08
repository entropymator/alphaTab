import type { Voice } from '@coderline/alphatab/model/Voice';
import type { ICanvas } from '@coderline/alphatab/platform/ICanvas';
import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';
import type { EffectBandInfo } from '@coderline/alphatab/rendering/BarRendererFactory';
import { EffectBand } from '@coderline/alphatab/rendering/EffectBand';
import type { BarLayoutingInfo } from '@coderline/alphatab/rendering/staves/BarLayoutingInfo';

/**
 * Per-(voice × effect) {@link EffectBand} list for one side of a bar
 * renderer. Owns band lifecycle, glyph alignment, painting. Placement
 * is delegated to {@link EffectSystemPlacement}.
 * @internal
 */
export class EffectBandContainer {
    private _bands: EffectBand[] = [];
    // Per-voice (effectId → band) lookup; avoids string-key allocation in the hot
    // `_createOrResizeGlyph` path called once per beat per Grouped/FullBar effect.
    private _bandLookup: Map<number, Map<string, EffectBand>> = new Map();
    public height: number = 0;

    public infos!: EffectBandInfo[];
    private _renderer: BarRendererBase;
    private _isTopContainer: boolean;

    public get bands(): EffectBand[] {
        return this._bands;
    }

    public get isTopContainer(): boolean {
        return this._isTopContainer;
    }

    // alignGlyphs runs once per cycle at Phase-2 entry. Every
    // `EffectInfo.onAlignGlyphs` implementation must be max-of-idempotent so
    // the single invocation produces a stable result.
    public alignGlyphs() {
        for (const effectBand of this._bands) {
            effectBand.resetHeight();
            effectBand.alignGlyphs();
        }
    }

    public registerLayoutingInfo(layoutings: BarLayoutingInfo): void {
        for (const band of this._bands) {
            band.registerLayoutingInfo(layoutings);
        }
    }

    public finalizeChainSpans(): void {
        for (const band of this._bands) {
            band.finalizeChainSpans();
        }
    }

    /** Dispatches {@link EffectBand.populateSkyline} on every band. */
    public populateSkyline(): void {
        for (const band of this._bands) {
            band.populateSkyline();
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
        // Plain loop avoids the per-call closure allocation that
        // `Array.some(b => ...)` pays.
        for (let i = 0, n = this._bands.length; i < n; i++) {
            if (this._bands[i].isLinkedToPrevious) {
                return true;
            }
        }
        return false;
    }

    public constructor(renderer: BarRendererBase, isTopContainer: boolean) {
        this._renderer = renderer;
        this._isTopContainer = isTopContainer;
    }

    public createVoiceGlyphs(voice: Voice) {
        const renderer = this._renderer;
        const notationSettings = renderer.settings.notation;
        for (let i = 0; i < this.infos.length; i++) {
            const info = this.infos[i];
            if (!notationSettings.isNotationElementVisible(info.effect.notationElement)) {
                continue;
            }

            // Sort-key `order` matches the legacy `_buildOrderMap` semantics:
            // `EffectBandInfo.order ?? i`, where `i` is the effect's declaration
            // index in the staff's top/bottom infos list (same list used here).
            const order = info.order ?? i;

            let band: EffectBand | undefined = undefined;

            for (const b of voice.beats) {
                // lazy create band to avoid creating and managing bands for all events
                // even if only a few exist
                if (!band && EffectBand.shouldCreateGlyph(b, info.effect, renderer)) {
                    band = new EffectBand(voice, info.effect, this, this._renderer, order);
                    band.doLayout();
                    this._bands.push(band);
                    let perVoice = this._bandLookup.get(voice.index);
                    if (!perVoice) {
                        perVoice = new Map<string, EffectBand>();
                        this._bandLookup.set(voice.index, perVoice);
                    }
                    perVoice.set(info.effect.effectId, band);
                }

                if (band !== undefined) {
                    band.createGlyph(b);
                }
            }
        }
    }

    public doLayout() {
        // Reuse the existing collections instead of allocating fresh ones
        // each layout pass. `splice(0, length)` is the transpile-safe array
        // clear (per SYNTAX.md, `length = 0` emits a read-only assignment in
        // C#). The outer Map's `.clear()` drops every per-voice nested Map
        // with it, so no separate inner clear is needed.
        this._bands.splice(0, this._bands.length);
        this._bandLookup.clear();
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
        const perVoice = this._bandLookup.get(voice.index);
        if (!perVoice) {
            return null;
        }
        return perVoice.get(effectId) ?? null;
    }
}

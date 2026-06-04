import { type Beat, BeatSubElement } from '@coderline/alphatab/model/Beat';
import type { Voice } from '@coderline/alphatab/model/Voice';
import type { ICanvas } from '@coderline/alphatab/platform/ICanvas';
import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';
import type { EffectBandContainer } from '@coderline/alphatab/rendering/EffectBandContainer';
import type { BarLayoutingInfo } from '@coderline/alphatab/rendering/staves/BarLayoutingInfo';
import { EffectBarGlyphSizing } from '@coderline/alphatab/rendering/EffectBarGlyphSizing';
import type { EffectInfo } from '@coderline/alphatab/rendering/EffectInfo';
import type { EffectGlyph } from '@coderline/alphatab/rendering/glyphs/EffectGlyph';
import { Glyph } from '@coderline/alphatab/rendering/glyphs/Glyph';
import { ElementStyleHelper } from '@coderline/alphatab/rendering/utils/ElementStyleHelper';

/**
 * @internal
 */
export class EffectBand extends Glyph {
    private _uniqueEffectGlyphs: EffectGlyph[][] = [];
    private _effectGlyphs: Map<number, EffectGlyph>[] = [];
    private _container: EffectBandContainer;
    public isEmpty: boolean = true;

    public isLinkedToPrevious: boolean = false;
    public firstBeat: Beat | null = null;
    public lastBeat: Beat | null = null;
    public override height: number = 0;
    public originalHeight: number = 0;
    public voice: Voice;
    public info: EffectInfo;

    public placedMagnitude: number = 0;

    /**
     * Cross-renderer span ranges published by {@link GroupedEffectGlyph}'s
     * `populateSkyline?` at SystemFinalize sub-step (ii). The chain head
     * publishes its true painted xEnd (which may exceed `this.renderer.width`)
     * so {@link computeLocalXRange} reflects the chain's full painted span at
     * placement time. Cleared per cycle by {@link clearPublishedSpans}.
     */
    private _publishedSpans: { xStart: number; xEnd: number }[] = [];

    public get container(): EffectBandContainer {
        return this._container;
    }

    public publishSpanRange(xStart: number, xEnd: number): void {
        this._publishedSpans.push({ xStart, xEnd });
    }

    public clearPublishedSpans(): void {
        this._publishedSpans.length = 0;
    }

    public constructor(voice: Voice, info: EffectInfo, container: EffectBandContainer) {
        super(0, 0);
        this.voice = voice;
        this.info = info;
        this._container = container;
    }

    public *iterateAllGlyphs() {
        for (const v of this._effectGlyphs) {
            for (const g of v.values()) {
                yield g;
            }
        }
    }

    public finalizeBand() {
        this.info.finalizeBand(this);
    }

    public registerLayoutingInfo(layoutings: BarLayoutingInfo): void {
        if (!this.info.contributesToBeatSpacing) {
            return;
        }
        for (let v = 0; v < this._effectGlyphs.length; v++) {
            const voiceBeats = this.renderer.bar.voices[v]?.beats;
            if (!voiceBeats) {
                continue;
            }
            for (const [beatIndex, glyph] of this._effectGlyphs[v]) {
                const beat = voiceBeats[beatIndex];
                if (!beat) {
                    continue;
                }
                const container = this.renderer.getBeatContainer(beat);
                if (!container) {
                    continue;
                }
                // glyph.x is still 0 at this lifecycle stage (set later by `_alignGlyph`).
                const preBeat = Math.max(0, -glyph.getBoundingBoxLeft());
                const postBeat = Math.max(0, glyph.getBoundingBoxRight());
                if (preBeat > 0 || postBeat > 0) {
                    layoutings.addBeatSpring(container, preBeat, postBeat);
                }
            }
        }
    }

    public override doLayout(): void {
        super.doLayout();
        for (let i: number = 0; i < this.renderer.bar.voices.length; i++) {
            this._effectGlyphs.push(new Map<number, EffectGlyph>());
            this._uniqueEffectGlyphs.push([]);
        }
    }

    public static shouldCreateGlyph(beat: Beat, info: EffectInfo, renderer: BarRendererBase) {
        return (
            info.shouldCreateGlyph(renderer.settings, beat) &&
            (!info.hideOnMultiTrack || renderer.staff!.trackIndex === 0)
        );
    }

    public createGlyph(beat: Beat): void {
        if (beat.voice !== this.voice) {
            return;
        }
        // NOTE: the track order will never change. even if the staff behind the renderer changes, the trackIndex will not.
        // so it's okay to access the staff here while creating the glyphs.
        if (EffectBand.shouldCreateGlyph(beat, this.info, this.renderer)) {
            this.isEmpty = false;
            if (!this.firstBeat || beat.isBefore(this.firstBeat)) {
                this.firstBeat = beat;
            }
            if (!this.lastBeat || beat.isAfter(this.lastBeat)) {
                this.lastBeat = beat;
                // for "toEnd" sizing occupy until next follow-up-beat
                switch (this.info.sizingMode) {
                    case EffectBarGlyphSizing.SingleOnBeatToEnd:
                    case EffectBarGlyphSizing.GroupedOnBeatToEnd:
                        if (this.lastBeat.nextBeat) {
                            this.lastBeat = this.lastBeat.nextBeat;
                        }
                        break;
                }
            }
            const glyph: EffectGlyph = this._createOrResizeGlyph(this.info.sizingMode, beat);
            if (glyph.height > this.height) {
                this.height = glyph.height;
                this.originalHeight = glyph.height;
            }
        }
    }

    public resetHeight() {
        this.height = this.originalHeight;
    }

    private _createOrResizeGlyph(sizing: EffectBarGlyphSizing, b: Beat): EffectGlyph {
        let g: EffectGlyph;
        switch (sizing) {
            case EffectBarGlyphSizing.FullBar:
                g = this.info.createNewGlyph(this.renderer, b);
                g.renderer = this.renderer;
                g.beat = b;
                g.band = this;
                g.doLayout();
                this._effectGlyphs[b.voice.index].set(b.index, g);
                this._uniqueEffectGlyphs[b.voice.index].push(g);
                // FullBar chain link across renderers so EffectSystemPlacement keeps
                // continuation bars at one magnitude.
                if (this.renderer.index > 0 && b.index === 0) {
                    const previousContainer = this._container.previousContainer;
                    const previousBand = previousContainer?.getBand(b.voice, this.info.effectId);
                    if (previousBand && !previousBand.isEmpty) {
                        const prevBar = b.voice.bar.previousBar;
                        const prevVoice = prevBar?.voices[b.voice.index];
                        const prevLastBeat =
                            prevVoice && prevVoice.beats.length > 0
                                ? prevVoice.beats[prevVoice.beats.length - 1]
                                : null;
                        if (prevLastBeat && this.info.canExpand(prevLastBeat, b)) {
                            this.isLinkedToPrevious = true;
                        }
                    }
                }
                return g;
            case EffectBarGlyphSizing.SinglePreBeat:
            case EffectBarGlyphSizing.SingleOnBeat:
            case EffectBarGlyphSizing.SingleOnBeatToEnd:
                g = this.info.createNewGlyph(this.renderer, b);
                g.renderer = this.renderer;
                g.beat = b;
                g.band = this;
                g.doLayout();
                this._effectGlyphs[b.voice.index].set(b.index, g);
                this._uniqueEffectGlyphs[b.voice.index].push(g);
                return g;
            case EffectBarGlyphSizing.GroupedOnBeat:
            case EffectBarGlyphSizing.GroupedOnBeatToEnd:
                const singleSizing: EffectBarGlyphSizing =
                    sizing === EffectBarGlyphSizing.GroupedOnBeat
                        ? EffectBarGlyphSizing.SingleOnBeat
                        : EffectBarGlyphSizing.SingleOnBeatToEnd;
                if (b.index > 0 || this.renderer.index > 0) {
                    // check if the previous beat also had this effect
                    const prevBeat = b.previousBeat!;
                    if (this.info.shouldCreateGlyph(this.renderer.settings, prevBeat)) {
                        // first load the effect bar renderer and glyph
                        let prevEffect: EffectGlyph | null = null;
                        if (b.index > 0 && this._effectGlyphs[b.voice.index].has(prevBeat.index)) {
                            // load effect from previous beat in the same renderer
                            prevEffect = this._effectGlyphs[b.voice.index].get(prevBeat.index)!;
                        } else if (this.renderer.index > 0) {
                            // load the effect from the previous renderer if possible.
                            const previousContainer = this._container.previousContainer!;
                            const previousBand = previousContainer.getBand(prevBeat.voice, this.info.effectId);
                            // it can happen that we have an empty voice and then we don't have an effect band
                            if (previousBand) {
                                const voiceGlyphs: Map<number, EffectGlyph> =
                                    previousBand._effectGlyphs[prevBeat.voice.index];
                                if (voiceGlyphs.has(prevBeat.index)) {
                                    prevEffect = voiceGlyphs.get(prevBeat.index)!;
                                }
                            }
                        }
                        // if the effect cannot be expanded, create a new glyph
                        // in case of expansion also create a new glyph, but also link the glyphs together
                        // so for rendering it might be expanded.
                        const newGlyph: EffectGlyph = this._createOrResizeGlyph(singleSizing, b);
                        if (prevEffect && this.info.canExpand(prevBeat, b)) {
                            // link glyphs
                            prevEffect.nextGlyph = newGlyph;
                            newGlyph.previousGlyph = prevEffect;
                            // mark renderers as linked for consideration when layouting the renderers (line breaking, partial breaking)
                            this.isLinkedToPrevious = true;
                            // On the 1->2 transition, register the chain head
                            // for the SystemFinalize skyline dispatch. The head
                            // publishes the chain's cross-renderer painted xEnd
                            // once every renderer is finalized (sub-step (ii)).
                            if (prevEffect.previousGlyph === null) {
                                prevEffect.renderer.registerPopulateSkyline(prevEffect, 'systemFinalize');
                            }
                        }
                        return newGlyph;
                    }
                    // in case the previous beat did not have the same effect, we simply create a new glyph
                    return this._createOrResizeGlyph(singleSizing, b);
                }
                // in case of the very first beat, we simply create the glyph.
                return this._createOrResizeGlyph(singleSizing, b);
            default:
                return this._createOrResizeGlyph(EffectBarGlyphSizing.SingleOnBeat, b);
        }
    }

    public override paint(cx: number, cy: number, canvas: ICanvas): void {
        super.paint(cx, cy, canvas);

        for (let i: number = 0, j: number = this._uniqueEffectGlyphs.length; i < j; i++) {
            const v: EffectGlyph[] = this._uniqueEffectGlyphs[i];
            for (let k: number = 0, l: number = v.length; k < l; k++) {
                const g: EffectGlyph = v[k];
                using _ = ElementStyleHelper.beat(canvas, BeatSubElement.Effects, g.beat!, false);
                g.paint(cx + this.x, cy + this.y, canvas);
            }
        }
    }

    public alignGlyphs(): void {
        for (let v: number = 0; v < this._effectGlyphs.length; v++) {
            for (const beatIndex of this._effectGlyphs[v].keys()) {
                const g = this.renderer.bar.voices[v].beats[beatIndex];
                this._alignGlyph(this.info.sizingMode, g);
            }
        }
        this.info.onAlignGlyphs(this);
    }

    /**
     * Writes the renderer-local x range used by {@link EffectSystemPlacement}
     * into `out`. Unions glyph paint extents (not `x`/`width` — many effect
     * glyphs keep `width = 0`). Returns `false` when the band has no usable
     * range (empty or every glyph reports a degenerate paint extent).
     */
    public computeLocalXRange(out: { xStart: number; xEnd: number }): boolean {
        if (this.isEmpty) {
            return false;
        }
        if (this.info.sizingMode === EffectBarGlyphSizing.FullBar) {
            let xStart = 0;
            let xEnd = this.renderer.width;
            for (const v of this._uniqueEffectGlyphs) {
                for (const g of v) {
                    const left = g.getBoundingBoxLeft();
                    if (left < xStart) {
                        xStart = left;
                    }
                    const right = g.getBoundingBoxRight();
                    if (right > xEnd) {
                        xEnd = right;
                    }
                }
            }
            for (const span of this._publishedSpans) {
                if (span.xStart < xStart) {
                    xStart = span.xStart;
                }
                if (span.xEnd > xEnd) {
                    xEnd = span.xEnd;
                }
            }
            out.xStart = xStart;
            out.xEnd = xEnd;
            return true;
        }
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (const v of this._uniqueEffectGlyphs) {
            for (const g of v) {
                const left = g.getBoundingBoxLeft();
                if (left < min) {
                    min = left;
                }
                const right = g.getBoundingBoxRight();
                if (right > max) {
                    max = right;
                }
            }
        }
        // §E Step 16 — fold cross-renderer chain spans (published by
        // `GroupedEffectGlyph.populateSkyline?` at SystemFinalize sub-step (ii))
        // into the band's placement xRange. The chain head's published xEnd may
        // exceed `this.renderer.width`; placement composes the absolute window
        // as `renderer.x + xEnd`, which is what closes B.25 — subsequent bands
        // querying intermediate renderer columns see the chain's painted area.
        for (const span of this._publishedSpans) {
            if (span.xStart < min) {
                min = span.xStart;
            }
            if (span.xEnd > max) {
                max = span.xEnd;
            }
        }
        if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
            return false;
        }
        out.xStart = min;
        out.xEnd = max;
        return true;
    }

    private _alignGlyph(sizing: EffectBarGlyphSizing, beat: Beat): void {
        const g: EffectGlyph = this._effectGlyphs[beat.voice.index].get(beat.index)!;
        const container = this.renderer.getBeatContainer(beat)!;

        switch (sizing) {
            case EffectBarGlyphSizing.SinglePreBeat:
                const offsetToBegin = this.renderer.layoutingInfo.getPreBeatSize(beat);
                g.x = this.renderer.beatGlyphsStart + container.x + container.onTimeX - offsetToBegin;
                break;
            case EffectBarGlyphSizing.SingleOnBeat:
            case EffectBarGlyphSizing.GroupedOnBeat:
                g.x = this.renderer.beatGlyphsStart + container.x + container.onTimeX;
                break;
            case EffectBarGlyphSizing.SingleOnBeatToEnd:
            case EffectBarGlyphSizing.GroupedOnBeatToEnd:
                g.x = this.renderer.beatGlyphsStart + container.x + container.onTimeX;
                if (container.isLastOfVoice) {
                    g.width = this.renderer.width - g.x;
                } else {
                    // shift to the start using the biggest post-beat size of the respective beat
                    const offsetToEnd = this.renderer.layoutingInfo.getPostBeatSize(beat);
                    g.width = offsetToEnd;
                }
                break;
            case EffectBarGlyphSizing.FullBar:
                g.width = this.renderer.width;
                break;
        }
    }
}

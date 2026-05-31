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

    public previousBand: EffectBand | null = null;
    public isLinkedToPrevious: boolean = false;
    public firstBeat: Beat | null = null;
    public lastBeat: Beat | null = null;
    public override height: number = 0;
    public originalHeight: number = 0;
    public voice: Voice;
    public info: EffectInfo;

    /**
     * Magnitude of the band's inner edge from the staff reference, set by
     * {@link EffectSystemPlacement} during the staff finalize pass. Drives the
     * conversion from skyline magnitude to renderer-local `band.y` and is the
     * only piece of placement state the band carries between place + apply.
     */
    public placedMagnitude: number = 0;

    public get container(): EffectBandContainer {
        return this._container;
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

    /**
     * Feeds the band's per-beat glyph extents into the bar's
     * {@link BarLayoutingInfo} when the underlying effect has
     * {@link EffectInfo.contributesToBeatSpacing} enabled. Each beat's
     * spring is widened by the glyph's actual paint extent so the
     * layout solver reserves room for effects that paint outside the
     * beat's notation column (e.g. center-aligned fermata needs
     * half-width clearance on each side of `onTimeX`).
     *
     * No-op for the default `contributesToBeatSpacing = false` so
     * existing layouts that don't opt in are unaffected.
     */
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
                // glyph.x is still 0 at this lifecycle stage (set later
                // by `_alignGlyph`), so getBoundingBoxLeft/Right return
                // the extent relative to the glyph's anchor.
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
                g.doLayout();
                this._effectGlyphs[b.voice.index].set(b.index, g);
                this._uniqueEffectGlyphs[b.voice.index].push(g);
                // FullBar effects (sustain pedal, alternate endings, …)
                // can also span multiple renderers when the same effect
                // continues on the next bar. The Grouped* path tracks
                // this via per-beat `canExpand`; for FullBar the unit is
                // the bar itself, so a non-empty same-effect band in the
                // previous renderer (whose last beat satisfies
                // `canExpand`) is the bar-level equivalent. Marking the
                // chain via {@link isLinkedToPrevious} lets
                // {@link EffectSystemPlacement} treat the run as one
                // block — otherwise each band's pad-widened skyline
                // query overlaps the previous band's inserted rect and
                // they stair-step up at every barline.
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
     * The band's renderer-local x range, used by
     * {@link EffectSystemPlacement} to query the staff skyline. Spans the
     * union of every per-voice {@link EffectGlyph}'s `(x, x+width)` rect, or
     * the renderer's full width for {@link EffectBarGlyphSizing.FullBar}.
     *
     * Result is `null` when the band is empty.
     */
    public computeLocalXRange(): { xStart: number; xEnd: number } | null {
        if (this.isEmpty) {
            return null;
        }
        if (this.info.sizingMode === EffectBarGlyphSizing.FullBar) {
            // The bar itself anchors the band, but the painted content
            // may extend past either edge — e.g. right-aligned
            // end-of-bar direction labels (`D.C. al Coda`) on a narrow
            // bar overflow leftward. Union with each glyph's bbox so
            // the skyline can detect that overflow and stack adjacent
            // bars' bands vertically instead of overlapping them.
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
            return { xStart, xEnd };
        }
        // Use each glyph's paint extent (`getBoundingBoxLeft/Right`), not
        // its rhythmic-spacing extent (`x` / `x + width`). Effect glyphs
        // such as `BarTempoGlyph` keep `width = 0` to stay out of the
        // bar's rod calculation but still paint a real text/symbol
        // string — without this their band would collapse to a
        // degenerate point and the skyline never sees them.
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
        // Defensive: `max < min` (strict) so that a degenerate point range
        // (= every glyph in the band reported a zero-width paint extent)
        // is still accepted. Any glyph that paints over a real range
        // should override `getBoundingBoxLeft/Right` so the band yields a
        // proper rectangle; the strict comparison just keeps unfamiliar
        // future zero-width effect glyphs working with the placement
        // (`placeAbove` widens by `pad` so a degenerate range still gets
        // a small skyline column).
        if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
            return null;
        }
        return { xStart: min, xEnd: max };
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

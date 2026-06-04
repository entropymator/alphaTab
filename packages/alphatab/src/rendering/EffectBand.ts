import { type Beat, BeatSubElement } from '@coderline/alphatab/model/Beat';
import type { Voice } from '@coderline/alphatab/model/Voice';
import type { ICanvas } from '@coderline/alphatab/platform/ICanvas';
import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';
import type { EffectBandContainer } from '@coderline/alphatab/rendering/EffectBandContainer';
import type { BarLayoutingInfo } from '@coderline/alphatab/rendering/staves/BarLayoutingInfo';
import { EffectBarGlyphSizing } from '@coderline/alphatab/rendering/EffectBarGlyphSizing';
import type { EffectInfo } from '@coderline/alphatab/rendering/EffectInfo';
import type { EffectGlyph } from '@coderline/alphatab/rendering/glyphs/EffectGlyph';
import { Glyph, SkylinePhase } from '@coderline/alphatab/rendering/glyphs/Glyph';
import { ElementStyleHelper } from '@coderline/alphatab/rendering/utils/ElementStyleHelper';

/**
 * Renderer-local x-range used by {@link EffectBand.computeLocalXRange} and
 * {@link EffectSystemPlacement} to query and insert into the staff skyline.
 *
 * @record
 * @internal
 */
export interface EffectBandXRange {
    xStart: number;
    xEnd: number;
}

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
     * Stable prefix of the {@link EffectSystemPlacement} sort key — the three
     * fields that never change after band construction. The final 4-key sort
     * is reproduced exactly by `_stableSortKey + renderer.index` because the
     * low 20 bits of the key are reserved for renderer.index.
     *
     * Computed once in the constructor:
     *   placementCategory * 2^40   (3 bits used; 0..15 reserved)
     * + (0xFFFF - order)   * 2^24  (16 bits; higher `order` → smaller term → first)
     * + voice.index        * 2^20  (4 bits; 0..15)
     *
     * renderer.index is NOT baked in: a renderer can be moved between staves
     * during system formation (see `RenderStaff.addBarRenderer`) and have its
     * `index` reassigned long after the band was created. It is added back at
     * sort time (see {@link sortKey}).
     *
     * Max final key ≈ 3*2^40 + 0xFFFF*2^24 + 15*2^20 + ~maxBars ≈ 3.6e12,
     * well within JS safe integer range (2^53).
     */
    private _stableSortKey: number = 0;

    /**
     * Full lexicographic sort key matching the legacy 4-key comparator
     * (placementCategory asc, order desc, voice.index asc, renderer.index asc).
     */
    public get sortKey(): number {
        return this._stableSortKey + this.renderer.index;
    }

    /**
     * Cached renderer-local x-range used by {@link computeLocalXRange}.
     *
     * The base snapshot (`_xRangeBase*`) is computed lazily on the first
     * `computeLocalXRange` call after {@link alignGlyphs}, unioning every
     * glyph's paint extent (and, for FullBar, the `(0, renderer.width)`
     * baseline). The live fields (`_xRange*`) start each cycle equal to the
     * base snapshot and are widened incrementally by {@link publishSpanRange}
     * when {@link GroupedEffectGlyph} publishes cross-renderer span ranges
     * during SystemFinalize. {@link clearPublishedSpans} resets the live
     * fields back to the snapshot.
     */
    private _xRangeMin: number = 0;
    private _xRangeMax: number = 0;
    private _xRangeFound: boolean = false;
    private _xRangeBaseMin: number = 0;
    private _xRangeBaseMax: number = 0;
    private _xRangeBaseFound: boolean = false;
    private _xRangeBaseDirty: boolean = true;

    public get container(): EffectBandContainer {
        return this._container;
    }

    public publishSpanRange(xStart: number, xEnd: number): void {
        // Ensure live fields reflect the band's own glyph extents before
        // widening them with the published span.
        if (this._xRangeBaseDirty) {
            this._refreshXRangeBase();
        }
        if (this._xRangeFound) {
            if (xStart < this._xRangeMin) {
                this._xRangeMin = xStart;
            }
            if (xEnd > this._xRangeMax) {
                this._xRangeMax = xEnd;
            }
        } else {
            this._xRangeMin = xStart;
            this._xRangeMax = xEnd;
            this._xRangeFound = true;
        }
    }

    public clearPublishedSpans(): void {
        // Reset live to base. If the base is stale (alignGlyphs invalidated
        // it), defer recomputation to the next read/publish.
        if (this._xRangeBaseDirty) {
            this._xRangeMin = 0;
            this._xRangeMax = 0;
            this._xRangeFound = false;
        } else {
            this._xRangeMin = this._xRangeBaseMin;
            this._xRangeMax = this._xRangeBaseMax;
            this._xRangeFound = this._xRangeBaseFound;
        }
    }

    private _refreshXRangeBase(): void {
        let min = 0;
        let max = 0;
        let found = false;
        if (this.info.sizingMode === EffectBarGlyphSizing.FullBar) {
            // FullBar bands always cover at least `[0, renderer.width)`.
            min = 0;
            max = this.renderer.width;
            found = true;
        }
        for (const v of this._uniqueEffectGlyphs) {
            for (const g of v) {
                const left = g.getBoundingBoxLeft();
                const right = g.getBoundingBoxRight();
                if (!found) {
                    min = left;
                    max = right;
                    found = true;
                } else {
                    if (left < min) {
                        min = left;
                    }
                    if (right > max) {
                        max = right;
                    }
                }
            }
        }
        this._xRangeBaseMin = min;
        this._xRangeBaseMax = max;
        this._xRangeBaseFound = found;
        this._xRangeMin = min;
        this._xRangeMax = max;
        this._xRangeFound = found;
        this._xRangeBaseDirty = false;
    }

    public constructor(
        voice: Voice,
        info: EffectInfo,
        container: EffectBandContainer,
        renderer: BarRendererBase,
        order: number
    ) {
        super(0, 0);
        this.voice = voice;
        this.info = info;
        this._container = container;
        this.renderer = renderer;
        // See `_stableSortKey` field doc for the bit layout. Order is inverted
        // via (0xFFFF - order) so higher `order` sorts first (closer to staff,
        // e.g. voltas at order=1000). `renderer.index` is added back at sort
        // time because it can change after construction.
        const clampedOrder = order < 0 ? 0 : order > 0xffff ? 0xffff : order;
        this._stableSortKey =
            info.placementCategory * 1099511627776 + // 2^40
            (0xffff - clampedOrder) * 16777216 + // 2^24
            voice.index * 1048576; // 2^20
    }

    /**
     * Per-voice insertion-ordered view of every glyph the band owns.
     * Consumers iterate two nested arrays directly — no generator state
     * machine, no Map iterator allocation. Treat as read-only; the band
     * owns lifetime. Typed `EffectGlyph[][]` (not `readonly (readonly
     * EffectGlyph[])[]`) because the transpiler cannot synthesise nested
     * `IReadOnlyList` properties cleanly.
     */
    public get glyphsByVoice(): EffectGlyph[][] {
        return this._uniqueEffectGlyphs;
    }

    public finalizeBand() {
        this.info.finalizeBand(this);
    }

    public registerLayoutingInfo(layoutings: BarLayoutingInfo): void {
        if (!this.info.contributesToBeatSpacing) {
            return;
        }
        // Iterate `_uniqueEffectGlyphs` to avoid the per-iteration tuple
        // destructure that `for (const [beatIndex, glyph] of map)` allocates,
        // and to read `g.beat` directly instead of going through
        // `voices[v].beats[beatIndex]`. Matches alignGlyphs.
        for (let v = 0; v < this._uniqueEffectGlyphs.length; v++) {
            const voiceGlyphs = this._uniqueEffectGlyphs[v];
            for (let i = 0, n = voiceGlyphs.length; i < n; i++) {
                const glyph = voiceGlyphs[i];
                const beat = glyph.beat;
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
                            // On the 1->2 transition, register the chain head for the
                            // SystemFinalize dispatch so it publishes the chain's
                            // cross-renderer painted xEnd once every renderer in the
                            // staff is finalized.
                            if (prevEffect.previousGlyph === null) {
                                prevEffect.renderer.registerPopulateSkyline(prevEffect, SkylinePhase.SystemFinalize);
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
        // Invalidate the cached x-range; it will be lazily rebuilt on the next
        // computeLocalXRange/publishSpanRange call after glyph extents have
        // fully settled.
        this._xRangeBaseDirty = true;
        this._xRangeMin = 0;
        this._xRangeMax = 0;
        this._xRangeFound = false;

        // Iterate `_uniqueEffectGlyphs` (insertion-ordered, holds the
        // glyphs directly with `g.beat` available) instead of
        // `_effectGlyphs[v].keys()` + voice/beat lookup. Same set; one fewer
        // map probe per glyph.
        for (let v: number = 0; v < this._uniqueEffectGlyphs.length; v++) {
            const voiceGlyphs = this._uniqueEffectGlyphs[v];
            for (let i = 0, n = voiceGlyphs.length; i < n; i++) {
                this._alignGlyph(this.info.sizingMode, voiceGlyphs[i].beat!);
            }
        }
        this.info.onAlignGlyphs(this);
    }

    /**
     * Writes the renderer-local x range used by {@link EffectSystemPlacement}
     * into `out`. Unions glyph paint extents (not `x`/`width` — many effect
     * glyphs keep `width = 0`) with any cross-renderer spans published via
     * {@link publishSpanRange}. Returns `false` when the band has no usable
     * range (empty or every glyph reports a degenerate paint extent).
     *
     * O(1) after the cache is built. The first call after {@link alignGlyphs}
     * lazily walks `_uniqueEffectGlyphs` once; subsequent calls and incremental
     * widening from {@link publishSpanRange} are O(1).
     */
    public computeLocalXRange(out: EffectBandXRange): boolean {
        if (this.isEmpty) {
            return false;
        }
        if (this._xRangeBaseDirty) {
            this._refreshXRangeBase();
        }
        if (!this._xRangeFound || this._xRangeMax < this._xRangeMin) {
            return false;
        }
        out.xStart = this._xRangeMin;
        out.xEnd = this._xRangeMax;
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

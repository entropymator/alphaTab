import type { Bar } from '@coderline/alphatab/model/Bar';
import type { Beat } from '@coderline/alphatab/model/Beat';
import { MusicFontSymbol } from '@coderline/alphatab/model/MusicFontSymbol';
import type { Note } from '@coderline/alphatab/model/Note';
import { SimileMark } from '@coderline/alphatab/model/SimileMark';
import { type Voice, VoiceSubElement } from '@coderline/alphatab/model/Voice';
import { CanvasHelper, type ICanvas } from '@coderline/alphatab/platform/ICanvas';
import type { RenderingResources } from '@coderline/alphatab/RenderingResources';
import { BeatXPosition } from '@coderline/alphatab/rendering/BeatXPosition';
import { EffectBandContainer } from '@coderline/alphatab/rendering/EffectBandContainer';
import {
    BeatContainerGlyph,
    type BeatContainerGlyphBase,
    type BeatEffectOverflow
} from '@coderline/alphatab/rendering/glyphs/BeatContainerGlyph';
import type { Glyph } from '@coderline/alphatab/rendering/glyphs/Glyph';
import { LeftToRightLayoutingGlyphGroup } from '@coderline/alphatab/rendering/glyphs/LeftToRightLayoutingGlyphGroup';
import { MultiVoiceContainerGlyph } from '@coderline/alphatab/rendering/glyphs/MultiVoiceContainerGlyph';
import { ContinuationTieGlyph, type ITieGlyph, type TieGlyph } from '@coderline/alphatab/rendering/glyphs/TieGlyph';
import { MultiBarRestBeatContainerGlyph } from '@coderline/alphatab/rendering/MultiBarRestBeatContainerGlyph';
import type { ScoreRenderer } from '@coderline/alphatab/rendering/ScoreRenderer';
import { BarLocalSkyline, StaffSide } from '@coderline/alphatab/rendering/skyline/BarLocalSkyline';
import type { BarLayoutingInfo } from '@coderline/alphatab/rendering/staves/BarLayoutingInfo';
import type { RenderStaff } from '@coderline/alphatab/rendering/staves/RenderStaff';
import { BarBounds } from '@coderline/alphatab/rendering/utils/BarBounds';
import { BarHelpers } from '@coderline/alphatab/rendering/utils/BarHelpers';
import type { BeamingHelper } from '@coderline/alphatab/rendering/utils/BeamingHelper';
import { Bounds } from '@coderline/alphatab/rendering/utils/Bounds';
import { ElementStyleHelper } from '@coderline/alphatab/rendering/utils/ElementStyleHelper';
import type { MasterBarBounds } from '@coderline/alphatab/rendering/utils/MasterBarBounds';
import type { Settings } from '@coderline/alphatab/Settings';

/**
 * Lists the different position modes for {@link BarRendererBase.getNoteY}
 * @internal
 */
export enum NoteYPosition {
    /**
     * Gets the note y-position on top of the note stem or tab number.
     */
    TopWithStem = 0,
    /**
     * Gets the note y-position on top of the note head or tab number.
     */
    Top = 1,
    /**
     * Gets the note y-position on the center of the note head or tab number.
     */
    Center = 2,
    /**
     * Gets the note y-position on the bottom of the note head or tab number.
     */
    Bottom = 3,
    /**
     * Gets the note y-position on the bottom of the note stem or tab number.
     */
    BottomWithStem = 4,
    /**
     * The position where the upwards stem should be placed.
     */
    StemUp = 5,
    /**
     * The position where the downwards stem should be placed.
     */
    StemDown = 6
}

/**
 * Lists the different position modes for {@link BarRendererBase.getNoteX}
 * @internal
 */
export enum NoteXPosition {
    /**
     * Gets the note x-position on left of the note head or tab number.
     */
    Left = 0,
    /**
     * Gets the note x-position on the center of the note head or tab number.
     */
    Center = 1,
    /**
     * Gets the note x-position on the right of the note head or tab number.
     */
    Right = 2
}

/**
 * This is the base public class for creating blocks which can render bars.
 * @internal
 */
export class BarRendererBase {
    private _preBeatGlyphs = new LeftToRightLayoutingGlyphGroup();
    protected readonly voiceContainer = new MultiVoiceContainerGlyph();
    private readonly _postBeatGlyphs = new LeftToRightLayoutingGlyphGroup();

    private _ties: ITieGlyph[] = [];

    private _multiSystemSlurs?: ContinuationTieGlyph[];

    /**
     * Set during {@link RenderStaff.finalizeStaff} sub-step (ii) when a tie
     * write grew this renderer's `_contentTopOverflow` / `_contentBottomOverflow`.
     * The staff orchestrator consumes and clears it within the same
     * `finalizeStaff` invocation, so the flag never crosses cycles.
     */
    private _tiesDirty: boolean = false;

    /** Ties whose start beat lives on this renderer. */
    public get ties(): ITieGlyph[] {
        return this._ties;
    }

    /**
     * Marker flipped by {@link RenderStaff._finalizeRendererTies} when a tie
     * write grew this renderer's overflow. Replaces a per-finalizeStaff
     * `Set<BarRendererBase>` allocation.
     */
    public markTiesDirty(): void {
        this._tiesDirty = true;
    }

    public get tiesDirty(): boolean {
        return this._tiesDirty;
    }

    public clearTiesDirty(): void {
        this._tiesDirty = false;
    }

    /**
     * Multi-system slur continuations attached to this renderer. Only populated
     * on the first renderer of a staff; undefined elsewhere.
     */
    public get multiSystemSlurs(): ContinuationTieGlyph[] | undefined {
        return this._multiSystemSlurs;
    }

    public topEffects: EffectBandContainer;
    public bottomEffects: EffectBandContainer;

    public get nextRenderer(): BarRendererBase | null {
        if (!this.bar || !this.bar.nextBar) {
            return null;
        }
        return this.scoreRenderer.layout!.getRendererForBar(this.staff!.staffId, this.bar.nextBar);
    }

    public get previousRenderer(): BarRendererBase | null {
        if (!this.bar || !this.bar.previousBar) {
            return null;
        }
        return this.scoreRenderer.layout!.getRendererForBar(this.staff!.staffId, this.bar.previousBar);
    }

    public scoreRenderer: ScoreRenderer;
    public staff?: RenderStaff;
    public layoutingInfo!: BarLayoutingInfo;
    public bar: Bar;
    public additionalMultiRestBars: Bar[] | null = null;

    public get lastBar(): Bar {
        if (this.additionalMultiRestBars) {
            return this.additionalMultiRestBars[this.additionalMultiRestBars.length - 1];
        }
        return this.bar;
    }

    public x: number = 0;
    public y: number = 0;
    public width: number = 0;
    public computedWidth: number = 0;
    public height: number = 0;
    public index: number = 0;
    private _contentTopOverflow: number = 0;
    private _contentBottomOverflow: number = 0;

    public beatEffectsMinY = Number.NaN;
    public beatEffectsMaxY = Number.NaN;

    private _barLocalSkyline: BarLocalSkyline | null = null;
    private _preBeatLocalSkyline: BarLocalSkyline | null = null;
    private _postBeatLocalSkyline: BarLocalSkyline | null = null;

    /**
     * Per-bar local skyline of every non-effect-band glyph's above/below-staff
     * envelope (renderer-local x).
     */
    public get barLocalSkyline(): BarLocalSkyline {
        if (!this._barLocalSkyline) {
            this._barLocalSkyline = new BarLocalSkyline(
                0,
                Number.MAX_SAFE_INTEGER,
                this.scoreRenderer.layout!.skylinePool
            );
        }
        return this._barLocalSkyline;
    }

    /**
     * Pre-beat glyphs' skyline contribution. Emitted from
     * {@link calculateOverflows}; kept separate from {@link barLocalSkyline} so
     * the latter's per-cycle reset doesn't wipe it.
     */
    public get preBeatLocalSkyline(): BarLocalSkyline {
        if (!this._preBeatLocalSkyline) {
            this._preBeatLocalSkyline = new BarLocalSkyline(
                0,
                Number.MAX_SAFE_INTEGER,
                this.scoreRenderer.layout!.skylinePool
            );
        }
        return this._preBeatLocalSkyline;
    }

    /**
     * Post-beat glyphs' skyline contribution in post-beat-group-local x
     * coordinates. Shifted by {@link postBeatGroupOffset} (final only after
     * {@link scaleToWidth}) when unioned into the staff skyline.
     */
    public get postBeatLocalSkyline(): BarLocalSkyline {
        if (!this._postBeatLocalSkyline) {
            this._postBeatLocalSkyline = new BarLocalSkyline(
                0,
                Number.MAX_SAFE_INTEGER,
                this.scoreRenderer.layout!.skylinePool
            );
        }
        return this._postBeatLocalSkyline;
    }

    public get postBeatGroupOffset(): number {
        return this._postBeatGlyphs.x;
    }

    /** Atomic per-cycle reset of skylines and ties. Called from {@link doLayout} entry; not from {@link reLayout}. */
    public resetCycleState(): void {
        this._barLocalSkyline?.reset();
        this._preBeatLocalSkyline?.reset();
        this._postBeatLocalSkyline?.reset();
        this._ties = [];
        this.beatEffectsMinY = Number.NaN;
        this.beatEffectsMaxY = Number.NaN;
    }

    /**
     * Emits a glyph's current bbox into {@link barLocalSkyline}. Used as the
     * body of {@link Glyph.populateSkyline} for glyphs that just want their
     * final bbox in the skyline (BarNumberGlyph, BarTempoGlyph).
     */
    public insertSkylineFromBbox(glyph: Glyph): void {
        const xL = glyph.getBoundingBoxLeft();
        const xR = glyph.getBoundingBoxRight();
        if (xR <= xL) {
            return;
        }
        const topY = glyph.getBoundingBoxTop();
        if (topY < 0) {
            this.insertSkylineTop(xL, xR, -topY);
        }
        const bottomY = glyph.getBoundingBoxBottom();
        if (bottomY > this.height) {
            this.insertSkylineBottom(xL, xR, bottomY - this.height);
        }
    }

    public get topOverflow() {
        return this._contentTopOverflow + this.topEffects.height;
    }

    public get bottomOverflow() {
        return this._contentBottomOverflow + this.bottomEffects.height;
    }

    protected helpers!: BarHelpers;

    public get collisionHelper() {
        return this.helpers.collisionHelper;
    }

    /**
     * Gets or sets whether this renderer is linked to the next one
     * by some glyphs like a vibrato effect
     */
    public isLinkedToPrevious: boolean = false;

    public get showMultiBarRest(): boolean {
        return true;
    }

    public constructor(renderer: ScoreRenderer, bar: Bar) {
        this.scoreRenderer = renderer;
        this.bar = bar;
        this.helpers = new BarHelpers(this);
        this.topEffects = new EffectBandContainer(this, true);
        this.bottomEffects = new EffectBandContainer(this, false);
    }

    public registerTie(tie: ITieGlyph) {
        this._ties.push(tie);
    }

    public get middleYPosition(): number {
        return 0;
    }

    public registerBeatEffectOverflows(beatEffectsMinY: number, beatEffectsMaxY: number) {
        const currentBeatEffectsMinY = this.beatEffectsMinY;
        if (Number.isNaN(currentBeatEffectsMinY) || beatEffectsMinY < currentBeatEffectsMinY) {
            this.beatEffectsMinY = beatEffectsMinY;
        }

        const currentBeatEffectsMaxY = this.beatEffectsMaxY;
        if (Number.isNaN(currentBeatEffectsMaxY) || beatEffectsMaxY > currentBeatEffectsMaxY) {
            this.beatEffectsMaxY = beatEffectsMaxY;
        }
    }

    public registerBeatEffectOverflowsForBeat(beat: Beat, minY: number, maxY: number): void {
        this.registerBeatEffectOverflows(minY, maxY);
        const container = this.getBeatContainer(beat);
        if (container) {
            const entry: BeatEffectOverflow = { minY, maxY };
            container.pendingEffectOverflows.push(entry);
        }
    }

    public registerOverflowTop(topOverflow: number): boolean {
        topOverflow = Math.ceil(topOverflow);
        if (topOverflow > this._contentTopOverflow) {
            this._contentTopOverflow = topOverflow;
            return true;
        }
        return false;
    }

    public registerOverflowBottom(bottomOverflow: number): boolean {
        bottomOverflow = Math.ceil(bottomOverflow);
        if (bottomOverflow > this._contentBottomOverflow) {
            this._contentBottomOverflow = bottomOverflow;
            return true;
        }
        return false;
    }

    /** Post-{@link scaleToWidth} only: also inserts into the bar-local skyline. */
    public registerOverflowRangeTop(xStart: number, xEnd: number, topHeight: number): boolean {
        const changed = this.registerOverflowTop(topHeight);
        if (topHeight > 0 && xEnd > xStart) {
            this.barLocalSkyline.insertPlaced(StaffSide.Top, xStart, xEnd, topHeight, 0);
        }
        return changed;
    }

    public registerOverflowRangeBottom(xStart: number, xEnd: number, bottomHeight: number): boolean {
        const changed = this.registerOverflowBottom(bottomHeight);
        if (bottomHeight > 0 && xEnd > xStart) {
            this.barLocalSkyline.insertPlaced(StaffSide.Bottom, xStart, xEnd, bottomHeight, 0);
        }
        return changed;
    }

    /**
     * Emit a top-skyline segment into {@link barLocalSkyline}. Public so
     * {@link Glyph.populateSkyline} tenants can contribute from outside this
     * class.
     */
    public insertSkylineTop(xStart: number, xEnd: number, topHeight: number): void {
        if (topHeight > 0 && xEnd > xStart) {
            this.barLocalSkyline.insertPlaced(StaffSide.Top, xStart, xEnd, topHeight, 0);
        }
    }

    /** Emit a bottom-skyline segment into {@link barLocalSkyline}. See {@link insertSkylineTop}. */
    public insertSkylineBottom(xStart: number, xEnd: number, bottomHeight: number): void {
        if (bottomHeight > 0 && xEnd > xStart) {
            this.barLocalSkyline.insertPlaced(StaffSide.Bottom, xStart, xEnd, bottomHeight, 0);
        }
    }

    /**
     * The fixed-overhead width of this renderer: glyphs that do not stretch when
     * the bar is scaled (clef, key signature, time signature, barlines, courtesy
     * accidentals, etc). Treated as a fixed allocation by the system-level layout
     * before distributing remaining width across bars by {@link Bar.displayScale}.
     */
    public get fixedOverhead(): number {
        return this._preBeatGlyphs.width + this._postBeatGlyphs.width;
    }

    public scaleToWidth(width: number): void {
        // preBeat and postBeat glyphs do not get resized
        const containerWidth: number = width - this._preBeatGlyphs.width - this._postBeatGlyphs.width;

        // Reset bar-local skyline before re-emitting scale-dependent segments
        // (voiceContainer beats, beam helpers, pending effect ranges,
        // dynamic-bbox glyphs). pre/postBeatLocalSkyline are managed by
        // calculateOverflows and stay untouched here.
        this.barLocalSkyline.reset();

        // Canonical per-cycle invalidator for beam drawing-info caches: the
        // spring-X is about to be re-laid-out by the voice container below,
        // making every cached `BeamingHelperDrawInfo` stale. Invalidating
        // once here (rather than per-helper in the emit loop) lets
        // `ensureBeamDrawingInfo`'s cache-existence check serve the later
        // `calculateBeamingOverflows` pass (Phase 2.5) as cache hits against
        // the entries `emitHelperSkyline` (Phase 2) populated.
        for (const v of this.helpers.beamHelpers) {
            for (const h of v) {
                h.invalidateDrawingInfos();
            }
        }

        // The voice container owns the beat walk and emits per-beat skyline
        // contributions (container overflow, pendingEffectOverflows,
        // `emitBeatSkyline` subclass hook) in the same pass.
        this.voiceContainer.scaleToWidth(containerWidth);

        for (const v of this.helpers.beamHelpers) {
            for (const h of v) {
                this.emitHelperSkyline(h);
            }
        }

        this._postBeatGlyphs.x = this._preBeatGlyphs.x + this._preBeatGlyphs.width + containerWidth;
        this.width = width;

        // Every `EffectInfo.onAlignGlyphs` override must be max-of-idempotent;
        // the cross-bar `_sharedLayoutData` they feed is reset once per system
        // by `StaffSystem.resetAllStavesSharedLayoutData`.
        this.topEffects.alignGlyphs();
        this.bottomEffects.alignGlyphs();

        // Per-glyph deferred-skyline pass — default `Glyph.populateSkyline` is
        // a no-op; subclasses (BarNumberGlyph, BarTempoGlyph) emit their final
        // bbox into the bar-local skyline.
        const preBeatGlyphs = this._preBeatGlyphs.glyphs;
        if (preBeatGlyphs) {
            for (const g of preBeatGlyphs) {
                g.populateSkyline();
            }
        }
        this.topEffects.populateSkyline();
        this.bottomEffects.populateSkyline();

        this.emitSubclassBarLocalSkyline();
    }

    protected emitHelperSkyline(_h: BeamingHelper): void {}

    public emitBeatSkyline(_beatContainer: BeatContainerGlyphBase): void {}

    protected emitSubclassBarLocalSkyline(): void {}

    public get resources(): RenderingResources {
        return this.settings.display.resources;
    }

    public get smuflMetrics() {
        return this.resources.engravingSettings;
    }

    public get settings(): Settings {
        return this.scoreRenderer.settings;
    }

    protected wasFirstOfStaff: boolean = false;

    public get isFirstOfStaff(): boolean {
        return this.index === 0;
    }

    public get isLastOfStaff(): boolean {
        return this.index === this.staff!.barRenderers.length - 1;
    }

    public get isLast(): boolean {
        return !this.bar || this.bar.index === this.scoreRenderer.layout!.lastBarIndex;
    }

    public _registerLayoutingInfo(): void {
        const info: BarLayoutingInfo = this.layoutingInfo;
        const preSize: number = this._preBeatGlyphs.width;
        if (info.preBeatSize < preSize) {
            info.preBeatSize = preSize;
        }
        const container = this.voiceContainer;
        container.registerLayoutingInfo(info);

        this.topEffects.registerLayoutingInfo(info);
        this.bottomEffects.registerLayoutingInfo(info);

        const postSize: number = this._postBeatGlyphs.width;
        if (info.postBeatSize < postSize) {
            info.postBeatSize = postSize;
        }
    }

    public afterReverted() {
        this.staff = undefined;
        this.registerMultiSystemSlurs(undefined);
        this.isFinalized = false;
    }

    public afterStaffBarReverted() {
        // Bar-local skylines stay — remaining bars' content is unchanged.
        // Per-band internals (`placedMagnitude`, `y`, `publishedSpans`)
        // are NOT reset here. Invariant: after `revertLastBar`, the layout
        // proceeds to add bars to the next system and ultimately calls
        // `StaffSystem.finalizeSystem` → `RenderStaff.finalizeStaff`,
        // which transits through both `dispatchSystemFinalizeSkyline`
        // (clears each band's publishedSpans) and
        // `effectPlacement.placeAndApply` (recomputes placedMagnitude/y).
        // So any stale per-band state from the reverted cycle is
        // overwritten before the next paint reads it.
        this.topEffects.height = 0;
        this.bottomEffects.height = 0;
        this._registerStaffOverflow();
    }

    /**
     * Pull the current {@link BarLayoutingInfo} broker state into this
     * renderer's positions (pre-beat width, voice-container x, post-beat
     * x/width, total width). Value-idempotent on a stable broker; callers
     * wanting to skip work for unchanged bars must gate the call themselves
     * (see {@link StaffSystem.reconcileMinDurationIfDirty}).
     */
    public applyLayoutingInfo(): void {
        // if we need additional space in the preBeat group we simply
        // add a new spacer
        this._preBeatGlyphs.width = this.layoutingInfo.preBeatSize;

        // on beat glyphs we apply the glyph spacing
        const container = this.voiceContainer;
        container.x = this._preBeatGlyphs.x + this._preBeatGlyphs.width;
        container.applyLayoutingInfo(this.layoutingInfo);

        // `_postBeatGlyphs.x` is single-write at end of Phase 2
        // ({@link scaleToWidth}); compute postBeatX locally here without
        // touching the field.
        this._postBeatGlyphs.width = this.layoutingInfo.postBeatSize;
        const postBeatX = Math.floor(container.x + container.width);
        this.width = Math.ceil(postBeatX + this._postBeatGlyphs.width);
        this.computedWidth = this.width;

        this._registerStaffOverflow();
    }

    public isFinalized: boolean = false;

    public registerMultiSystemSlurs(startedTies: Generator<TieGlyph> | undefined) {
        if (!startedTies) {
            this._multiSystemSlurs = undefined;
            return;
        }

        let ties: ContinuationTieGlyph[] | undefined = undefined;
        for (const g of startedTies) {
            const continuation = new ContinuationTieGlyph(g);
            continuation.renderer = this;
            continuation.tieDirection = g.tieDirection;

            if (!ties) {
                ties = [];
            }
            ties.push(continuation);
        }

        this._multiSystemSlurs = ties;
    }

    /**
     * Marks this renderer as finalized so cross-renderer chain walks can rely
     * on every renderer in the staff being finalized before tie writes run.
     */
    public finalizeRendererMinusTies(): void {
        this.isFinalized = true;
    }

    /**
     * Drives each effect band to republish its cross-renderer chain spans now
     * that every renderer in the staff is finalized.
     */
    public finalizeEffectBandSpans(): void {
        this.topEffects.finalizeChainSpans();
        this.bottomEffects.finalizeChainSpans();
    }

    private _registerStaffOverflow() {
        this.staff!.registerOverflowTop(this.topOverflow);
        this.staff!.registerOverflowBottom(this.bottomOverflow);
    }

    /**
     * Public wrapper for `_registerStaffOverflow`. Kept as a one-line
     * passthrough (instead of making the underlying method public) so the
     * naming-by-visibility convention (`_`-prefixed = `private`/`protected`)
     * stays consistent with the rest of the file and any subclass that
     * later needs to wrap the call has a public seam to override.
     */
    public registerStaffOverflows(): void {
        this._registerStaffOverflow();
    }

    /**
     * Public entry point for `updateSizes`. Called by the staff after tie
     * writes mutate a renderer's overflow, to recompute width/height before
     * the staff-skyline union runs.
     *
     * Kept as a wrapper (not folded into `updateSizes` made public)
     * because `LineBarRenderer.updateSizes` is a `protected override` —
     * widening the base to `public` would require widening every override
     * in the subclass chain, and the transpiler's visibility rewrites
     * don't track that consistently across class hierarchies. The wrapper
     * is one indirection per renderer per finalizeStaff dirty cycle.
     */
    public refreshSizes(): void {
        this.updateSizes();
    }

    public doLayout(): void {
        if (!this.bar) {
            return;
        }
        this.helpers.initialize();
        this._preBeatGlyphs.renderer = this;
        this.voiceContainer.renderer = this;
        this._postBeatGlyphs.renderer = this;
        this.topEffects.doLayout();
        this.bottomEffects.doLayout();
        this.resetCycleState();

        this.createPreBeatGlyphs();
        this.createBeatGlyphs();
        this.createPostBeatGlyphs();

        this._registerLayoutingInfo();

        this.updateSizes();

        // finish up all helpers
        for (const v of this.helpers.beamHelpers) {
            for (const h of v) {
                h.finish();
            }
        }

        this.computedWidth = this.width;

        this.calculateOverflows(0, this.height);
    }

    protected calculateOverflows(_rendererTop: number, rendererBottom: number) {
        // Re-emit pre/post-beat skylines from scratch each pass (called from
        // both doLayout and reLayout). barLocalSkyline is reset separately in
        // scaleToWidth.
        this.preBeatLocalSkyline.reset();
        this.postBeatLocalSkyline.reset();

        // Pre- and post-beat groups both emit in group-local glyph x
        // (`getBoundingBoxLeft/Right` return parent-relative x). `_preBeatGlyphs.x`
        // is invariant (= 0), so pre-beat group-local x equals bar-local x;
        // `_postBeatGlyphs.x` is not final until scaleToWidth, so the staff-skyline
        // union shifts post-beat by the final offset. The per-glyph overflow shape
        // is identical between the two — see `_emitGroupOverflows`.
        const preBeatGlyphs = this._preBeatGlyphs.glyphs;
        if (preBeatGlyphs) {
            this._emitGroupOverflows(preBeatGlyphs, this.preBeatLocalSkyline, rendererBottom);
        }
        const postBeatGlyphs = this._postBeatGlyphs.glyphs;
        if (postBeatGlyphs) {
            this._emitGroupOverflows(postBeatGlyphs, this.postBeatLocalSkyline, rendererBottom);
        }

        const v = this.voiceContainer;
        const contentMinY = v.getBoundingBoxTop();
        if (contentMinY < 0) {
            this.registerOverflowTop(contentMinY * -1);
        }

        const contentMaxY = v.getBoundingBoxBottom();
        if (contentMaxY > rendererBottom) {
            this.registerOverflowBottom(contentMaxY - rendererBottom);
        }

        const beatEffectsMinY = this.beatEffectsMinY;
        if (!Number.isNaN(beatEffectsMinY) && beatEffectsMinY < 0) {
            this.registerOverflowTop(beatEffectsMinY * -1);
        }

        const beatEffectsMaxY = this.beatEffectsMaxY;
        if (!Number.isNaN(beatEffectsMaxY) && beatEffectsMaxY > rendererBottom) {
            this.registerOverflowBottom(beatEffectsMaxY - rendererBottom);
        }
    }

    /**
     * Emit per-glyph overflow into the given group skyline. Used by
     * {@link calculateOverflows} for both pre- and post-beat groups: the loop
     * bodies were structurally identical, so they share one implementation
     * here. Each glyph's xL/xR is read once per glyph (instead of up to twice
     * each when both top and bottom branches fired), trimming redundant
     * bounding-box recompute work on dynamic-bbox glyphs.
     */
    private _emitGroupOverflows(glyphs: Glyph[], skyline: BarLocalSkyline, rendererBottom: number): void {
        for (const g of glyphs) {
            const topY = g.getBoundingBoxTop();
            const bottomY = g.getBoundingBoxBottom();
            const topOver = topY < 0;
            const bottomOver = bottomY > rendererBottom;
            if (!topOver && !bottomOver) {
                continue;
            }
            const xL = g.getBoundingBoxLeft();
            const xR = g.getBoundingBoxRight();
            const hasExtent = xR > xL;
            if (topOver) {
                this.registerOverflowTop(topY * -1);
                if (hasExtent) {
                    skyline.insertPlaced(StaffSide.Top, xL, xR, topY * -1, 0);
                }
            }
            if (bottomOver) {
                this.registerOverflowBottom(bottomY - rendererBottom);
                if (hasExtent) {
                    skyline.insertPlaced(StaffSide.Bottom, xL, xR, bottomY - rendererBottom, 0);
                }
            }
        }
    }

    protected updateSizes(): void {
        this.staff!.registerStaffTop(0);

        this.voiceContainer.x = this._preBeatGlyphs.x + this._preBeatGlyphs.width;
        this._postBeatGlyphs.x = Math.floor(this.voiceContainer.x + this.voiceContainer.width);

        this.width = Math.ceil(this._postBeatGlyphs.x + this._postBeatGlyphs.width);

        this.height = Math.ceil(this.height);

        this.staff!.registerStaffBottom(this.height);
    }

    protected addPreBeatGlyph(g: Glyph): void {
        g.renderer = this;
        this._preBeatGlyphs.addGlyph(g);
    }

    protected addBeatGlyph(g: BeatContainerGlyphBase): void {
        g.renderer = this;
        this.voiceContainer.addGlyph(g);
    }

    public getBeatContainer(beat: Beat): BeatContainerGlyphBase | undefined {
        return this.voiceContainer.getBeatContainer(beat);
    }

    public paint(cx: number, cy: number, canvas: ICanvas): void {
        // canvas.color = Color.random();
        // canvas.fillRect(cx + this.x, cy + this.y, this.width, this.height);

        this.paintContent(cx, cy, canvas);

        const topEffectBandY = cy + this.y - this.staff!.topOverflow;
        this.topEffects.paint(cx + this.x, topEffectBandY, canvas);

        const bottomEffectBandY = cy + this.y + this.height + this.staff!.bottomOverflow - this.bottomEffects.height;
        this.bottomEffects.paint(cx + this.x, bottomEffectBandY, canvas);
    }

    protected paintContent(cx: number, cy: number, canvas: ICanvas): void {
        this.paintBackground(cx, cy, canvas);

        canvas.color = this.resources.mainGlyphColor;
        this._preBeatGlyphs.paint(cx + this.x, cy + this.y, canvas);
        this.voiceContainer.paint(cx + this.x, cy + this.y, canvas);
        canvas.color = this.resources.mainGlyphColor;
        this._postBeatGlyphs.paint(cx + this.x, cy + this.y, canvas);

        this._paintMultiSystemSlurs(cx, cy, canvas);
    }

    private _paintMultiSystemSlurs(cx: number, cy: number, canvas: ICanvas) {
        const multiSystemSlurs = this._multiSystemSlurs;
        if (!multiSystemSlurs) {
            return;
        }

        for (const slur of multiSystemSlurs) {
            slur.paint(cx, cy, canvas);
        }
    }

    protected paintBackground(cx: number, cy: number, canvas: ICanvas): void {
        this.layoutingInfo.paint(
            cx + this.x + this._preBeatGlyphs.x + this._preBeatGlyphs.width,
            cy + this.y + this.height,
            canvas
        );
        // canvas.color = Color.random();
        // canvas.fillRect(cx + this.x, cy + this.y, this.width, this.height);
        // canvas.strokeRect(cx + this.x, cy + this.y - this.topOverflow, this.width, this.height + this.topOverflow + this.bottomOverflow);
    }

    public buildBoundingsLookup(masterBarBounds: MasterBarBounds, cx: number, cy: number): void {
        const barBounds: BarBounds = new BarBounds();
        barBounds.bar = this.bar;
        barBounds.visualBounds = new Bounds();
        barBounds.visualBounds.x = cx + this.x;
        barBounds.visualBounds.y = cy + this.y;
        barBounds.visualBounds.w = this.width;
        barBounds.visualBounds.h = this.height;

        barBounds.realBounds = new Bounds();
        barBounds.realBounds.x = cx + this.x;
        barBounds.realBounds.y = cy + this.y;
        barBounds.realBounds.w = this.width;
        barBounds.realBounds.h = this.height;

        masterBarBounds.addBar(barBounds);
        this.voiceContainer.buildBoundingsLookup(barBounds, cx + this.x, cy + this.y);
    }

    protected addPostBeatGlyph(g: Glyph): void {
        this._postBeatGlyphs.addGlyph(g);
    }

    protected createPreBeatGlyphs(): void {
        this.wasFirstOfStaff = this.isFirstOfStaff;
    }

    protected createBeatGlyphs(): void {
        if (this.additionalMultiRestBars) {
            const container = new MultiBarRestBeatContainerGlyph();
            this.addBeatGlyph(container);
        } else {
            for (const index of this.bar.filledVoices) {
                this.createVoiceGlyphs(this.bar.voices[index]);
            }
        }

        this.voiceContainer.doLayout();

        if (this.topEffects.isLinkedToPreviousRenderer || this.bottomEffects.isLinkedToPreviousRenderer) {
            this.isLinkedToPrevious = true;
        }
    }

    protected createVoiceGlyphs(voice: Voice): void {
        this.topEffects.createVoiceGlyphs(voice);
        this.bottomEffects.createVoiceGlyphs(voice);
    }

    protected createPostBeatGlyphs(): void {
        // filled in subclasses
    }

    public get beatGlyphsStart(): number {
        return this.voiceContainer.x;
    }

    public get postBeatGlyphsStart(): number {
        return this._postBeatGlyphs.x;
    }

    public getBeatX(
        beat: Beat,
        requestedPosition: BeatXPosition = BeatXPosition.PreNotes,
        useSharedSizes: boolean = false
    ): number {
        return this.beatGlyphsStart + this.voiceContainer.getBeatX(beat, requestedPosition, useSharedSizes);
    }

    public getRatioPositionX(ratio: number): number {
        const firstOnNoteX = this.bar.isEmpty
            ? this.beatGlyphsStart
            : this.getBeatX(this.bar.voices[0].beats[0], BeatXPosition.MiddleNotes);
        const x = firstOnNoteX;
        const w = this.postBeatGlyphsStart - firstOnNoteX;
        return x + w * ratio;
    }

    public getNoteX(note: Note, requestedPosition: NoteXPosition): number {
        return this.beatGlyphsStart + this.voiceContainer.getNoteX(note, requestedPosition);
    }

    public getNoteY(note: Note, requestedPosition: NoteYPosition): number {
        return this.voiceContainer.y + +this.voiceContainer.getNoteY(note, requestedPosition);
    }

    public getRestY(beat: Beat, requestedPosition: NoteYPosition): number {
        return this.voiceContainer.y + +this.voiceContainer.getRestY(beat, requestedPosition);
    }

    public reLayout(): void {
        this.topEffects.height = 0;
        this.bottomEffects.height = 0;
        this.updateSizes();

        // there are some glyphs which are shown only for renderers at the line start, so we simply recreate them
        // but we only need to recreate them for the renderers that were the first of the line or are now the first of the line
        if ((this.wasFirstOfStaff && !this.isFirstOfStaff) || (!this.wasFirstOfStaff && this.isFirstOfStaff)) {
            this.recreatePreBeatGlyphs();
        }

        this._registerLayoutingInfo();
        this.calculateOverflows(0, this.height);
    }

    protected recreatePreBeatGlyphs() {
        this._preBeatGlyphs = new LeftToRightLayoutingGlyphGroup();
        this._preBeatGlyphs.renderer = this;
        // Previously-registered pre-beat glyphs in `_deferredSkylineGlyphs`
        // remain referenced, but their bbox collapses to width 0 when the
        // staff is no longer first-in-system, so a stale emit is a no-op.
        // New pre-beat glyphs re-register through createPreBeatGlyphs.
        this.createPreBeatGlyphs();
    }

    protected paintSimileMark(cx: number, cy: number, canvas: ICanvas): void {
        using _ = ElementStyleHelper.voice(canvas, VoiceSubElement.Glyphs, this.bar.voices[0], true);

        switch (this.bar.simileMark) {
            case SimileMark.Simple:
                canvas.beginGroup(BeatContainerGlyph.getGroupId(this.bar.voices[0].beats[0]));
                CanvasHelper.fillMusicFontSymbolSafe(
                    canvas,
                    cx + this.x + this.width / 2,
                    cy + this.y + this.height / 2,
                    1,
                    MusicFontSymbol.Repeat1Bar,
                    true
                );
                canvas.endGroup();
                break;
            case SimileMark.SecondOfDouble:
                canvas.beginGroup(BeatContainerGlyph.getGroupId(this.bar.voices[0].beats[0]));
                canvas.beginGroup(BeatContainerGlyph.getGroupId(this.bar.previousBar!.voices[0].beats[0]));

                CanvasHelper.fillMusicFontSymbolSafe(
                    canvas,
                    cx + this.x,
                    cy + this.y + this.height / 2,
                    1,
                    MusicFontSymbol.Repeat2Bars,
                    true
                );

                canvas.endGroup();
                canvas.endGroup();

                break;
        }
    }

    public completeBeamingHelper(_helper: BeamingHelper) {
        // nothing by default
    }
}

import type { Bar } from '@coderline/alphatab/model/Bar';
import type { Beat } from '@coderline/alphatab/model/Beat';
import { MusicFontSymbol } from '@coderline/alphatab/model/MusicFontSymbol';
import type { Note } from '@coderline/alphatab/model/Note';
import { SimileMark } from '@coderline/alphatab/model/SimileMark';
import { type Voice, VoiceSubElement } from '@coderline/alphatab/model/Voice';
import { CanvasHelper, type ICanvas } from '@coderline/alphatab/platform/ICanvas';
import { BeatXPosition } from '@coderline/alphatab/rendering/BeatXPosition';
import { EffectBandContainer } from '@coderline/alphatab/rendering/EffectBandContainer';
import {
    BeatContainerGlyph,
    type BeatContainerGlyphBase
} from '@coderline/alphatab/rendering/glyphs/BeatContainerGlyph';
import type { Glyph, SkylinePhase } from '@coderline/alphatab/rendering/glyphs/Glyph';
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
import type { RenderingResources } from '@coderline/alphatab/RenderingResources';
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
     * Pre-beat glyphs' skyline contribution. Emitted from {@link calculateOverflows}
     * (stable across scaleToWidth re-runs) and unioned alongside the bar-local
     * skyline at staff-skyline merge time. Kept separate so {@link scaleToWidth}'s
     * reset doesn't wipe it when resize triggers multiple passes.
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
     * Post-beat glyphs' skyline contribution in POST-BEAT-GROUP-LOCAL x
     * coordinates. Shifted by `_postBeatGlyphs.x` (which is final only after
     * scaleToWidth) when unioned into the staff skyline.
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

    /**
     * §E Step 11 (slim) — atomic per-cycle reset for this renderer.
     *
     * Every field listed here is per-cycle state that must be cleared at the
     * start of a fresh layout cycle (doLayout entry). New per-cycle fields
     * added in future work MUST be added to this method to preserve the
     * atomic-reset contract — the field-by-field enumeration is what catches
     * cross-cycle bleed (B.9 / B.31) at refactor time rather than as a latent
     * visual bug.
     *
     * Fields NOT in this method survive across cycles by design:
     *   - `voiceContainer`, `helpers`, `_postBeatGlyphs` — Phase-1 content,
     *     rebuilt only if the bar's model changes.
     *   - `_preBeatGlyphs` — conditionally rebuilt by `recreatePreBeatGlyphs`
     *     when `isFirstOfStaff` flips (B.4; Step 10 future work consolidates
     *     this into a substate-discard pattern).
     *   - `bar`, `staff`, `scoreRenderer`, model refs — owned across cycles.
     *
     * The reLayout path (resize) currently does NOT call this method —
     * skylines and ties carry across cycles on resize, which is B.9 / B.31
     * territory. Step 10's substate-discard would close this; for now Step 11
     * is "slim" — document the contract, consolidate the existing resets,
     * leave the resize-path gap as a known issue.
     */
    public resetCycleState(): void {
        this._barLocalSkyline?.reset();
        this._preBeatLocalSkyline?.reset();
        this._postBeatLocalSkyline?.reset();
        this._dynamicSkylineGlyphs.length = 0;
        this._populateSkylineFinalized.length = 0;
        this._populateSkylineSystemFinalize.length = 0;
        this._ties = [];
    }

    /**
     * Pre/post-beat glyphs whose bbox depends on bar-layout state that's only
     * finalized in scaleToWidth (post-beat group offset, firstVisibleStaff,
     * etc.). Such glyphs register themselves here from their doLayout, and we
     * re-emit their per-x skyline contribution at scaleToWidth time when their
     * bbox returns its final value.
     *
     * §E Step 3 superseded this registry with the phase-typed
     * {@link Glyph.populateSkyline} hook (see {@link _populateSkyline_finalized} /
     * {@link _populateSkyline_systemFinalize} below). `BarTempoGlyph` migrated;
     * `GroupedEffectGlyph` migrates in Step 16. `BarNumberGlyph` remains as the
     * sole surviving tenant per v6 — its bbox override is a documented
     * exception (per-staff visibility suppression) rather than a side-channel
     * for staleness; the registry's deferred-emit covers the first-bar-of-
     * first-system staleness window when `firstVisibleStaff === undefined`.
     */
    private readonly _dynamicSkylineGlyphs: { glyph: Glyph; group: 'pre' | 'post' }[] = [];

    public registerDynamicSkylineGlyph(glyph: Glyph, group: 'pre' | 'post' = 'pre'): void {
        this._dynamicSkylineGlyphs.push({ glyph, group });
    }

    /**
     * §E Step 3 — phase-typed dispatch list for glyphs that opt in via
     * {@link Glyph.populateSkyline}. Phase `'finalized'` fires at the end of
     * `scaleToWidth` (Phase 3). Phase `'systemFinalize'` fires at SystemFinalize
     * sub-step (ii) and is currently unused; Step 16 adds the dispatch site and
     * the first tenant (`GroupedEffectGlyph`).
     */
    private readonly _populateSkylineFinalized: Glyph[] = [];
    private readonly _populateSkylineSystemFinalize: Glyph[] = [];

    public registerPopulateSkyline(glyph: Glyph, phase: SkylinePhase): void {
        if (phase === 'finalized') {
            this._populateSkylineFinalized.push(glyph);
        } else {
            this._populateSkylineSystemFinalize.push(glyph);
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
        container?.pendingEffectOverflows.push({ minY, maxY });
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
     * Emit a top-skyline segment into `barLocalSkyline`. Public to allow
     * {@link Glyph.populateSkyline} tenants to contribute from outside the
     * renderer class (§E Step 3).
     */
    public insertSkylineTop(xStart: number, xEnd: number, topHeight: number): void {
        if (topHeight > 0 && xEnd > xStart) {
            this.barLocalSkyline.insertPlaced(StaffSide.Top, xStart, xEnd, topHeight, 0);
        }
    }

    /**
     * Emit a bottom-skyline segment into `barLocalSkyline`. Public to allow
     * {@link Glyph.populateSkyline} tenants to contribute from outside the
     * renderer class (§E Step 3).
     */
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

        // barLocalSkyline holds scale-dependent emissions (voiceContainer beats,
        // beam helpers, pending effect ranges, dynamic-bbox glyphs). Reset here
        // as a defensive zero point so this method is idempotent under repeated
        // invocation. After §E Step 7, `scaleToWidth` is called exactly once
        // per renderer per cycle (HorizontalScreenLayout's second call site in
        // `_alignRenderers` was deleted); the reset is now strictly defensive.
        // pre/postBeatLocalSkyline stay (managed by calculateOverflows).
        this.barLocalSkyline.reset();

        const rendererBottom = this.height;
        const vc = this.voiceContainer;
        const voiceX = vc.x;
        // Notehead extent (PreNotes..PostNotes), not slot width (which includes spring spacing).
        // The onBeatSettled callback also flushes any beat-effect ranges that
        // landed on this container during effect-glyph doLayout — folded into
        // the positioning walk that's already iterating beat containers.
        vc.scaleToWidth(containerWidth, beatContainer => {
            const containerTop = beatContainer.getBoundingBoxTop();
            const containerBottom = beatContainer.getBoundingBoxBottom();
            const topOver = !Number.isNaN(containerTop) && containerTop < 0;
            const botOver = !Number.isNaN(containerBottom) && containerBottom > rendererBottom;
            const base = voiceX + beatContainer.x;
            if (topOver || botOver) {
                const xStart = base + beatContainer.getBeatX(BeatXPosition.PreNotes, false);
                const xEnd = base + beatContainer.getBeatX(BeatXPosition.PostNotes, false);
                if (xEnd > xStart) {
                    if (topOver) {
                        this.insertSkylineTop(xStart, xEnd, containerTop * -1);
                    }
                    if (botOver) {
                        this.insertSkylineBottom(xStart, xEnd, containerBottom - rendererBottom);
                    }
                }
            }

            const pending = beatContainer.pendingEffectOverflows;
            if (pending.length > 0) {
                const pendingXStart = base;
                const pendingXEnd = base + beatContainer.width;
                for (const r of pending) {
                    if (r.minY < 0) {
                        this.insertSkylineTop(pendingXStart, pendingXEnd, r.minY * -1);
                    }
                    if (r.maxY > rendererBottom) {
                        this.insertSkylineBottom(pendingXStart, pendingXEnd, r.maxY - rendererBottom);
                    }
                }
            }

            this.emitBeatSkyline(beatContainer);
        });

        for (const v of this.helpers.beamHelpers) {
            for (const h of v) {
                h.alignWithBeats();
                this.emitHelperSkyline(h);
            }
        }

        this._postBeatGlyphs.x = this._preBeatGlyphs.x + this._preBeatGlyphs.width + containerWidth;
        this.width = width;

        // §E Step 5c — single Phase-2-entry `alignGlyphs` call. Was previously
        // invoked from doLayout, applyLayoutingInfo, and reLayout as well; per
        // the Step 5a audit (see EffectBandContainer.alignGlyphs doc-comment
        // table) every `EffectInfo.onAlignGlyphs` override is max-of-idempotent,
        // so a single invocation here suffices. The `_sharedLayoutData` reset
        // that feeds these calls is consolidated in Step 5b
        // (`StaffSystem.resetAllStavesSharedLayoutData` invoked just before
        // this method runs in `VerticalLayoutBase._scaleToWidth` /
        // `HorizontalScreenLayout._alignRenderers`).
        this.topEffects.alignGlyphs();
        this.bottomEffects.alignGlyphs();

        this._emitDynamicSkylineGlyphs(rendererBottom);
        // §E Step 3 — Phase 3 `populateSkyline?` dispatch. Glyphs register here
        // from their doLayout; the hook fires once at the end of scaleToWidth
        // when renderer-local positions are settled. Pre-Step-13 this dispatch
        // lives here; Step 13's `finalize` extraction will move it there.
        for (const g of this._populateSkylineFinalized) {
            g.populateSkyline?.({ phase: 'finalized', renderer: this });
        }
        this.emitSubclassBarLocalSkyline();
    }

    private _emitDynamicSkylineGlyphs(rendererBottom: number): void {
        if (this._dynamicSkylineGlyphs.length === 0) {
            return;
        }
        // These glyphs need re-emission each scaleToWidth pass because their
        // bbox depends on layout state (firstVisibleStaff, bar width, ...) that's
        // only final here. Emit into barLocalSkyline (which is reset at every
        // scaleToWidth start) so resize re-runs don't accumulate stale segments.
        // The `group` channel is preserved only for postBeatLocalSkyline-targeted
        // emissions when post-beat coords need group-local shifting at union.
        for (const entry of this._dynamicSkylineGlyphs) {
            const g = entry.glyph;
            const topY = g.getBoundingBoxTop();
            const bottomY = g.getBoundingBoxBottom();
            const xL = g.getBoundingBoxLeft();
            const xR = g.getBoundingBoxRight();
            if (xR <= xL) {
                continue;
            }
            if (entry.group === 'pre') {
                if (topY < 0) {
                    this.insertSkylineTop(xL, xR, topY * -1);
                }
                if (bottomY > rendererBottom) {
                    this.insertSkylineBottom(xL, xR, bottomY - rendererBottom);
                }
            } else {
                const postSky = this.postBeatLocalSkyline;
                if (topY < 0) {
                    postSky.insertPlaced(StaffSide.Top, xL, xR, topY * -1, 0);
                }
                if (bottomY > rendererBottom) {
                    postSky.insertPlaced(StaffSide.Bottom, xL, xR, bottomY - rendererBottom, 0);
                }
            }
        }
    }

    protected emitHelperSkyline(_h: BeamingHelper): void {}

    protected emitBeatSkyline(_beatContainer: BeatContainerGlyphBase): void {}

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
        this.topEffects.height = 0;
        this.bottomEffects.height = 0;
        this._registerStaffOverflow();
    }

    /**
     * Pull the current `BarLayoutingInfo` broker state into this renderer's
     * positions (pre-beat width, voice-container x, post-beat x/width, total
     * width). §E Step 8b deleted the `_appliedLayoutingInfo` version cookie
     * that previously short-circuited this method: every call now runs the
     * body unconditionally. Apply is value-idempotent on a stable broker (see
     * [reconcile-min-duration.md §3](.docs/investigations/reconcile-min-duration.md)),
     * so callers that want to skip work for not-actually-dirty bars must gate
     * the call themselves — see `StaffSystem.reconcileMinDurationIfDirty`'s
     * per-bar `wasRecomputed` predicate.
     */
    public applyLayoutingInfo(): void {
        // if we need additional space in the preBeat group we simply
        // add a new spacer
        this._preBeatGlyphs.width = this.layoutingInfo.preBeatSize;

        // on beat glyphs we apply the glyph spacing
        const container = this.voiceContainer;
        container.x = this._preBeatGlyphs.x + this._preBeatGlyphs.width;
        container.applyLayoutingInfo(this.layoutingInfo);

        // §E Step 9 — `_postBeatGlyphs.x` is single-write at end of Phase 2
        // (`scaleToWidth`). Compute postBeatX locally for the
        // computedWidth/width calculation without writing to the field.
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
     * Cross-bar arcs live on the start beat's renderer but paint across
     * subsequent bars; slice the bezier bbox into each spanned bar's
     * skyline. Tie Y is renderer-local (all renderers share `renderer.y`),
     * X is staff-absolute.
     */
    private _finalizeTies(ties: Iterable<ITieGlyph>): boolean {
        let didChangeOverflows = false;
        const staffRenderers = this.staff ? this.staff.barRenderers : [this];
        for (const t of ties) {
            const tie = t as unknown as Glyph;
            tie.doLayout();

            if (!t.checkForOverflow) {
                continue;
            }

            const tieTop = t.getBoundingBoxTop();
            const tieBottom = t.getBoundingBoxBottom();
            const tieTopOverflow = tieTop < 0 ? -tieTop : 0;

            const tieLeftStaff = t.getBoundingBoxLeft();
            const tieRightStaff = t.getBoundingBoxRight();

            for (const target of staffRenderers) {
                const targetXStart = target.x;
                const targetXEnd = target.x + target.width;
                const xStartStaff = Math.max(targetXStart, tieLeftStaff);
                const xEndStaff = Math.min(targetXEnd, tieRightStaff);
                if (xEndStaff <= xStartStaff) {
                    continue;
                }
                const xStart = xStartStaff - targetXStart;
                const xEnd = xEndStaff - targetXStart;
                const tieBottomOverflow = tieBottom - target.height;

                if (target === this) {
                    if (tieTopOverflow > 0) {
                        if (this.registerOverflowRangeTop(xStart, xEnd, tieTopOverflow)) {
                            didChangeOverflows = true;
                        }
                    }
                    if (tieBottomOverflow > 0) {
                        if (this.registerOverflowRangeBottom(xStart, xEnd, tieBottomOverflow)) {
                            didChangeOverflows = true;
                        }
                    }
                } else {
                    if (tieTopOverflow > 0) {
                        target.barLocalSkyline.insertPlaced(StaffSide.Top, xStart, xEnd, tieTopOverflow, 0);
                    }
                    if (tieBottomOverflow > 0) {
                        target.barLocalSkyline.insertPlaced(
                            StaffSide.Bottom,
                            xStart,
                            xEnd,
                            tieBottomOverflow,
                            0
                        );
                    }
                }
            }
        }
        return didChangeOverflows;
    }

    public finalizeRenderer(): boolean {
        this.isFinalized = true;

        let didChangeOverflows = false;

        if (this._finalizeTies(this._ties)) {
            didChangeOverflows = true;
        }

        const multiSystemSlurs = this._multiSystemSlurs;
        if (multiSystemSlurs && this._finalizeTies(multiSystemSlurs)) {
            didChangeOverflows = true;
        }

        if (didChangeOverflows) {
            this.updateSizes();
            this._registerStaffOverflow();
        }

        return didChangeOverflows;
    }

    private _registerStaffOverflow() {
        this.staff!.registerOverflowTop(this.topOverflow);
        this.staff!.registerOverflowBottom(this.bottomOverflow);
    }

    public registerStaffOverflows(): void {
        this._registerStaffOverflow();
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
        // §E Step 11 (slim) — atomic per-cycle reset; covers _ties too.
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
        // Re-emit pre/post-beat skylines from scratch each pass (doLayout +
        // reLayout both call this). barLocalSkyline is reset in scaleToWidth.
        this.preBeatLocalSkyline.reset();
        this.postBeatLocalSkyline.reset();

        // _preBeatGlyphs.x is invariant (= 0); glyph-local x is bar-local x.
        const preBeatGlyphs = this._preBeatGlyphs.glyphs;
        if (preBeatGlyphs) {
            const preSky = this.preBeatLocalSkyline;
            for (const g of preBeatGlyphs) {
                const topY = g.getBoundingBoxTop();
                if (topY < 0) {
                    this.registerOverflowTop(topY * -1);
                    const xL = g.getBoundingBoxLeft();
                    const xR = g.getBoundingBoxRight();
                    if (xR > xL) {
                        preSky.insertPlaced(StaffSide.Top, xL, xR, topY * -1, 0);
                    }
                }

                const bottomY = g.getBoundingBoxBottom();
                if (bottomY > rendererBottom) {
                    this.registerOverflowBottom(bottomY - rendererBottom);
                    const xL = g.getBoundingBoxLeft();
                    const xR = g.getBoundingBoxRight();
                    if (xR > xL) {
                        preSky.insertPlaced(StaffSide.Bottom, xL, xR, bottomY - rendererBottom, 0);
                    }
                }
            }
        }
        // _postBeatGlyphs.x is not final until scaleToWidth — emit in group-local
        // coords; staff-skyline union shifts by the final group offset.
        const postBeatGlyphs = this._postBeatGlyphs.glyphs;
        if (postBeatGlyphs) {
            const postSky = this.postBeatLocalSkyline;
            for (const g of postBeatGlyphs) {
                const topY = g.getBoundingBoxTop();
                if (topY < 0) {
                    this.registerOverflowTop(topY * -1);
                    postSky.insertPlaced(
                        StaffSide.Top,
                        g.getBoundingBoxLeft(),
                        g.getBoundingBoxRight(),
                        topY * -1,
                        0
                    );
                }

                const bottomY = g.getBoundingBoxBottom();
                if (bottomY > rendererBottom) {
                    this.registerOverflowBottom(bottomY - rendererBottom);
                    postSky.insertPlaced(
                        StaffSide.Bottom,
                        g.getBoundingBoxLeft(),
                        g.getBoundingBoxRight(),
                        bottomY - rendererBottom,
                        0
                    );
                }
            }
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
            this._postBeatGlyphs.doLayout();
        }

        this._registerLayoutingInfo();
        this.calculateOverflows(0, this.height);
    }

    protected recreatePreBeatGlyphs() {
        this._preBeatGlyphs = new LeftToRightLayoutingGlyphGroup();
        this._preBeatGlyphs.renderer = this;
        // Drop any pre-beat entries from the previous glyph set; the new
        // glyphs will re-register themselves via createPreBeatGlyphs.
        for (let i = this._dynamicSkylineGlyphs.length - 1; i >= 0; i--) {
            if (this._dynamicSkylineGlyphs[i].group === 'pre') {
                this._dynamicSkylineGlyphs.splice(i, 1);
            }
        }
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

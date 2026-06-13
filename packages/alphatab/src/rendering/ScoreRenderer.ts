import { Environment } from '@coderline/alphatab/Environment';
import {
    EventEmitter,
    EventEmitterOfT,
    type IEventEmitter,
    type IEventEmitterOfT
} from '@coderline/alphatab/EventEmitter';
import { LayoutMode } from '@coderline/alphatab/LayoutMode';
import { Logger } from '@coderline/alphatab/Logger';
import type { Score } from '@coderline/alphatab/model/Score';
import type { Track } from '@coderline/alphatab/model/Track';
import type { ICanvas } from '@coderline/alphatab/platform/ICanvas';
import { Profiler } from '@coderline/alphatab/profiling/Profiler';
import type { IScoreRenderer, RenderHints } from '@coderline/alphatab/rendering/IScoreRenderer';
import type { ScoreLayout } from '@coderline/alphatab/rendering/layout/ScoreLayout';
import { RenderFinishedEventArgs } from '@coderline/alphatab/rendering/RenderFinishedEventArgs';
import { BarBounds } from '@coderline/alphatab/rendering/utils/BarBounds';
import { BeatBounds } from '@coderline/alphatab/rendering/utils/BeatBounds';
import { Bounds } from '@coderline/alphatab/rendering/utils/Bounds';
import { BoundsLookup } from '@coderline/alphatab/rendering/utils/BoundsLookup';
import { MasterBarBounds } from '@coderline/alphatab/rendering/utils/MasterBarBounds';
import { NoteBounds } from '@coderline/alphatab/rendering/utils/NoteBounds';
import { ObjectPool } from '@coderline/alphatab/rendering/utils/ObjectPool';
import { StaffSystemBounds } from '@coderline/alphatab/rendering/utils/StaffSystemBounds';
import type { Settings } from '@coderline/alphatab/Settings';

/**
 * This is the main wrapper of the rendering engine which
 * can render a single track of a score object into a notation sheet.
 * @public
 */
export class ScoreRenderer implements IScoreRenderer {
    private _currentLayoutMode: LayoutMode = LayoutMode.Page;
    private _currentRenderEngine: string | null = null;
    private _renderedTracks: Track[] | null = null;

    public canvas: ICanvas | null = null;
    public score: Score | null = null;
    public tracks: Track[] | null = null;
    /**
     * @internal
     */
    public layout: ScoreLayout | null = null;
    public settings: Settings;
    public boundsLookup: BoundsLookup | null = null;
    public width: number = 0;

    /**
     * Pools that back the {@link BoundsLookup} tree. Each render reuses slots
     * allocated by previous renders via the bump-allocator pattern: a full
     * render calls {@link _releaseBoundsPools} once before populating the tree,
     * resetting all pool cursors to 0 in O(1).
     * @internal
     */
    public readonly staffSystemBoundsPool: ObjectPool<StaffSystemBounds> = new ObjectPool<StaffSystemBounds>(
        () => new StaffSystemBounds()
    );
    /** @internal */
    public readonly masterBarBoundsPool: ObjectPool<MasterBarBounds> = new ObjectPool<MasterBarBounds>(
        () => new MasterBarBounds()
    );
    /** @internal */
    public readonly barBoundsPool: ObjectPool<BarBounds> = new ObjectPool<BarBounds>(() => new BarBounds());
    /** @internal */
    public readonly beatBoundsPool: ObjectPool<BeatBounds> = new ObjectPool<BeatBounds>(() => new BeatBounds());
    /** @internal */
    public readonly noteBoundsPool: ObjectPool<NoteBounds> = new ObjectPool<NoteBounds>(() => new NoteBounds());
    /** @internal */
    public readonly boundsPool: ObjectPool<Bounds> = new ObjectPool<Bounds>(() => new Bounds());

    /**
     * Initializes a new instance of the {@link ScoreRenderer} class.
     * @param settings The settings to use for rendering.
     */
    public constructor(settings: Settings) {
        this.settings = settings;
        this._recreateCanvas();
        this._recreateLayout();
    }

    public destroy(): void {
        this.score = null;
        this.canvas?.destroy();
        this.canvas = null;
        this.layout = null;
        this.boundsLookup = null;
        this.tracks = null;
    }

    private _recreateCanvas(): boolean {
        if (this._currentRenderEngine !== this.settings.core.engine) {
            this.canvas?.destroy();
            this.canvas = Environment.getRenderEngineFactory(this.settings.core.engine).createCanvas();
            this._currentRenderEngine = this.settings.core.engine;
            return true;
        }
        return false;
    }

    private _recreateLayout(): boolean {
        if (!this.layout || this._currentLayoutMode !== this.settings.display.layoutMode) {
            this.layout = Environment.getLayoutEngineFactory(this.settings.display.layoutMode).createLayout(this);
            this._currentLayoutMode = this.settings.display.layoutMode;
            return true;
        }
        return false;
    }

    public renderScore(score: Score | null, trackIndexes: number[] | null, renderHints?: RenderHints): void {
        try {
            this.score = score;
            let tracks: Track[] | null = null;

            if (score != null && trackIndexes != null) {
                if (!trackIndexes) {
                    tracks = score.tracks.slice(0);
                } else {
                    tracks = [];
                    for (const track of trackIndexes) {
                        if (track >= 0 && track < score.tracks.length) {
                            tracks.push(score.tracks[track]);
                        }
                    }
                }
                if (tracks.length === 0 && score.tracks.length > 0) {
                    tracks.push(score.tracks[0]);
                }
            }

            this.tracks = tracks;
            this.render(renderHints);
        } catch (e) {
            (this.error as EventEmitterOfT<Error>).trigger(e as Error);
        }
    }

    /**
     * Initiates rendering fof the given tracks.
     * @param tracks The tracks to render.
     */
    public renderTracks(tracks: Track[]): void {
        if (tracks.length === 0) {
            this.score = null;
        } else {
            this.score = tracks[0].score;
        }
        this.tracks = tracks;
        this.render();
    }

    public updateSettings(settings: Settings): void {
        this.settings = settings;
    }

    public renderResult(resultId: string): void {
        try {
            const layout = this.layout;
            if (layout) {
                Logger.debug('Rendering', `Request render of lazy partial ${resultId}`);
                layout.renderLazyPartial(resultId);
            } else {
                Logger.warning('Rendering', `Request render of lazy partial ${resultId} ignored, no layout exists`);
            }
        } catch (e) {
            (this.error as EventEmitterOfT<Error>).trigger(e as Error);
        }
    }

    public render(renderHints?: RenderHints): void {
        Profiler.begin('render.total');
        if (this.width === 0) {
            Logger.warning('Rendering', 'AlphaTab skipped rendering because of width=0 (element invisible)', null);
            Profiler.end('render.total');
            return;
        }
        // For partial renders we preserve the existing lookup so bars outside the re-layouted
        // range keep their already-scaled bounds - the layout will clear the changed range
        // before the paint pass re-registers fresh entries for it.
        if (renderHints?.firstChangedMasterBar !== undefined && this.boundsLookup) {
            this.boundsLookup.resetForPartialUpdate();
            // Pool reset is intentionally skipped on the partial-update path:
            // preserved subtree objects still occupy pool slots below the
            // current cursor. New acquires extend past the cursor and the
            // leak gets reclaimed at the next full render.
        } else {
            this._releaseBoundsPools();
            this.boundsLookup = new BoundsLookup();
        }
        this._recreateCanvas();
        this.canvas!.lineWidth = 1;
        this.canvas!.settings = this.settings;

        if (!this.tracks || this.tracks.length === 0 || !this.score) {
            Logger.debug('Rendering', 'Clearing rendered tracks because no score or tracks are set');
            (this.preRender as EventEmitterOfT<boolean>).trigger(false);
            this._renderedTracks = null;
            this._onRenderFinished();
            (this.postRenderFinished as EventEmitter).trigger();
            Logger.debug('Rendering', 'Clearing finished');
        } else {
            Logger.debug('Rendering', `Rendering ${this.tracks.length} tracks`);
            for (let i: number = 0; i < this.tracks.length; i++) {
                const track: Track = this.tracks[i];
                Logger.debug('Rendering', `Track ${i}: ${track.name}`);
            }
            (this.preRender as EventEmitterOfT<boolean>).trigger(false);
            this._recreateLayout();
            this._layoutAndRender(renderHints);
            Logger.debug('Rendering', 'Rendering finished');
        }
        Profiler.end('render.total');
    }

    public resizeRender(): void {
        Profiler.begin('resize.total');
        if (this._recreateLayout() || this._recreateCanvas() || this._renderedTracks !== this.tracks || !this.tracks) {
            Logger.debug('Rendering', 'Starting full rerendering due to layout or canvas change', null);
            this.render();
        } else if (this.layout!.supportsResize) {
            Logger.debug('Rendering', 'Starting optimized rerendering for resize');
            this._releaseBoundsPools();
            this.boundsLookup = new BoundsLookup();
            (this.preRender as EventEmitterOfT<boolean>).trigger(true);
            this.canvas!.settings = this.settings;
            Profiler.begin('resize.layoutResize');
            this.layout!.resize();
            Profiler.end('resize.layoutResize');
            this._onRenderFinished();
            (this.postRenderFinished as EventEmitter).trigger();
        } else {
            Logger.debug('Rendering', 'Current layout does not support dynamic resizing, nothing was done', null);
        }
        Logger.debug('Rendering', 'Resize finished');
        Profiler.end('resize.total');
    }

    private _layoutAndRender(renderHints?: RenderHints): void {
        Logger.debug(
            'Rendering',
            `Rendering at scale ${this.settings.display.scale} with layout ${this.layout!.name}`,
            null
        );
        Profiler.begin('render.layoutAndRender');
        this.layout!.layoutAndRender(renderHints);
        Profiler.end('render.layoutAndRender');
        this._renderedTracks = this.tracks;
        this._onRenderFinished();
        (this.postRenderFinished as EventEmitter).trigger();
    }

    public readonly preRender: IEventEmitterOfT<boolean> = new EventEmitterOfT<boolean>();
    public readonly renderFinished: IEventEmitterOfT<RenderFinishedEventArgs> =
        new EventEmitterOfT<RenderFinishedEventArgs>();
    public readonly partialRenderFinished: IEventEmitterOfT<RenderFinishedEventArgs> =
        new EventEmitterOfT<RenderFinishedEventArgs>();
    public readonly partialLayoutFinished: IEventEmitterOfT<RenderFinishedEventArgs> =
        new EventEmitterOfT<RenderFinishedEventArgs>();
    public readonly postRenderFinished: IEventEmitter = new EventEmitter();
    public readonly error: IEventEmitterOfT<Error> = new EventEmitterOfT<Error>();

    private _onRenderFinished() {
        this.boundsLookup?.finish(this.settings.display.scale);
        const e = new RenderFinishedEventArgs();
        e.totalHeight = this.layout!.height;
        e.totalWidth = this.layout!.width;
        e.renderResult = this.canvas!.onRenderFinished();
        (this.renderFinished as EventEmitterOfT<RenderFinishedEventArgs>).trigger(e);
    }

    private _releaseBoundsPools(): void {
        this.staffSystemBoundsPool.releaseAll();
        this.masterBarBoundsPool.releaseAll();
        this.barBoundsPool.releaseAll();
        this.beatBoundsPool.releaseAll();
        this.noteBoundsPool.releaseAll();
        this.boundsPool.releaseAll();
    }
}

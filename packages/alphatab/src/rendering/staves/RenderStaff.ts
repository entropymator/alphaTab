import type { Bar } from '@coderline/alphatab/model/Bar';
import type { Staff } from '@coderline/alphatab/model/Staff';
import type { ICanvas } from '@coderline/alphatab/platform/ICanvas';
import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';
import {
    type BarRendererFactory,
    type EffectBandInfo,
    EffectBandMode
} from '@coderline/alphatab/rendering/BarRendererFactory';
import { EffectSystemPlacement } from '@coderline/alphatab/rendering/EffectSystemPlacement';
import { StaffSide } from '@coderline/alphatab/rendering/skyline/BarLocalSkyline';
import { StaffSystemSkyline } from '@coderline/alphatab/rendering/skyline/StaffSystemSkyline';
import type { BarLayoutingInfo } from '@coderline/alphatab/rendering/staves/BarLayoutingInfo';
import type { StaffSystem } from '@coderline/alphatab/rendering/staves/StaffSystem';
import type { StaffTrackGroup } from '@coderline/alphatab/rendering/staves/StaffTrackGroup';

/**
 * A Staff represents a single line within a StaffSystem.
 * It stores BarRenderer instances created from a given factory.
 * @internal
 */
export class RenderStaff {
    private _factory: BarRendererFactory;
    private _sharedLayoutData: Map<string, unknown> = new Map();

    public staffTrackGroup!: StaffTrackGroup;
    public system!: StaffSystem;
    public barRenderers: BarRendererBase[] = [];
    public x: number = 0;
    public y: number = 0;
    public height: number = 0;
    public index: number = 0;
    public staffIndex: number = 0;

    public isVisible = false;
    private _emptyBarCount = 0;

    public get isFirstInSystem() {
        return this.system.firstVisibleStaff === this;
    }

    public topEffectInfos: EffectBandInfo[] = [];
    public bottomEffectInfos: EffectBandInfo[] = [];

    /**
     * This is the index of the track being rendered. This is not the index of the track within the model,
     * but the n-th track being rendered. It is the index of the {@link ScoreRenderer.tracks} array defining
     * which tracks should be rendered.
     * For single-track rendering this will always be zero.
     */
    public trackIndex: number = 0;
    public modelStaff: Staff;

    public get staffId(): string {
        return this._factory.staffId;
    }

    /**
     * This is the visual offset from top where the
     * Staff contents actually start. Used for grouping
     * using a accolade
     */
    public staffTop: number = 0;

    public topPadding: number = 0;
    public bottomPadding: number = 0;

    /**
     * This is the visual offset from top where the
     * Staff contents actually ends. Used for grouping
     * using a accolade
     */
    public staffBottom: number = 0;

    public get contentTop() {
        return this.y + this.staffTop + this.topPadding + this.topOverflow;
    }

    public get contentBottom() {
        return this.y + this.topPadding + this.topOverflow + this.staffBottom;
    }

    public constructor(system: StaffSystem, trackIndex: number, staff: Staff, factory: BarRendererFactory) {
        this._factory = factory;
        this.trackIndex = trackIndex;
        this.modelStaff = staff;
        this.system = system;
        for (const b of factory.effectBands) {
            if (b.shouldCreate && !b.shouldCreate!(staff)) {
                continue;
            }

            switch (b.mode) {
                case EffectBandMode.OwnedTop:
                case EffectBandMode.SharedTop:
                    this.topEffectInfos.push(b);
                    break;

                case EffectBandMode.OwnedBottom:
                case EffectBandMode.SharedBottom:
                    this.bottomEffectInfos.push(b);
                    break;
            }
        }

        this._updateVisibility();
    }

    public getSharedLayoutData<T>(key: string, def: T): T {
        if (this._sharedLayoutData.has(key)) {
            return this._sharedLayoutData.get(key) as T;
        }
        return def;
    }

    public setSharedLayoutData<T>(key: string, def: T): void {
        this._sharedLayoutData.set(key, def);
    }

    public registerStaffTop(offset: number): void {
        if (offset > this.staffTop) {
            this.staffTop = offset;
        }
    }

    public registerStaffBottom(offset: number): void {
        if (offset > this.staffBottom) {
            this.staffBottom = offset;
        }
    }

    public addBarRenderer(renderer: BarRendererBase): void {
        renderer.staff = this;
        renderer.index = this.barRenderers.length;
        renderer.reLayout();
        this.barRenderers.push(renderer);
        this.system.layout.registerBarRenderer(this.staffId, renderer);
        if (renderer.bar.isEmpty || renderer.bar.isRestOnly) {
            this._emptyBarCount++;
        }
        this._updateVisibility();
    }

    private _updateVisibility() {
        const stylesheet = this.modelStaff.track.score.stylesheet;
        const canHideEmptyStaves =
            stylesheet.hideEmptyStaves && (stylesheet.hideEmptyStavesInFirstSystem || this.system.index > 0);
        if (canHideEmptyStaves) {
            this.isVisible = this._emptyBarCount < this.barRenderers.length;
        } else {
            this.isVisible = true;
        }
    }

    public addBar(bar: Bar, layoutingInfo: BarLayoutingInfo, additionalMultiBarsRestBars: Bar[] | null): void {
        const renderer = this._factory.create(this.system.layout.renderer, bar);

        renderer.topEffects.infos = this.topEffectInfos;
        renderer.bottomEffects.infos = this.bottomEffectInfos;

        renderer.additionalMultiRestBars = additionalMultiBarsRestBars;
        renderer.staff = this;
        renderer.index = this.barRenderers.length;
        renderer.layoutingInfo = layoutingInfo;
        renderer.doLayout();

        this.barRenderers.push(renderer);
        this.system.layout.registerBarRenderer(this.staffId, renderer);
        if (bar.isEmpty || bar.isRestOnly) {
            this._emptyBarCount++;
        }
        this._updateVisibility();
    }

    public revertLastBar(): BarRendererBase {
        this.resetSharedLayoutData();

        const lastBar: BarRendererBase = this.barRenderers[this.barRenderers.length - 1];
        this.barRenderers.splice(this.barRenderers.length - 1, 1);
        this.topOverflow = 0;
        this.bottomOverflow = 0;
        for (const r of this.barRenderers) {
            r.afterStaffBarReverted();
        }

        if (lastBar.bar.isEmpty || lastBar.bar.isRestOnly) {
            this._emptyBarCount--;
        }
        this._updateVisibility();

        return lastBar;
    }

    public resetSharedLayoutData() {
        this._sharedLayoutData.clear();
    }

    public topOverflow = 0;
    public registerOverflowTop(overflow: number) {
        if (overflow > this.topOverflow) {
            this.topOverflow = overflow;
        }
    }

    public bottomOverflow = 0;
    public registerOverflowBottom(overflow: number) {
        if (overflow > this.bottomOverflow) {
            this.bottomOverflow = overflow;
        }
    }

    private _systemSkyline: StaffSystemSkyline | null = null;
    private _effectPlacement: EffectSystemPlacement | null = null;

    public get effectPlacement(): EffectSystemPlacement {
        if (!this._effectPlacement) {
            this._effectPlacement = new EffectSystemPlacement(this);
        }
        return this._effectPlacement;
    }

    public get systemSkyline(): StaffSystemSkyline {
        if (!this._systemSkyline) {
            const pool = this.system.layout.renderer.layout!.skylinePool;
            this._systemSkyline = new StaffSystemSkyline(
                this.staffIndex,
                this.system.index,
                0,
                Number.MAX_SAFE_INTEGER,
                pool
            );
        }
        return this._systemSkyline;
    }

    private _unionBarLocalIntoStaffSkyline(renderer: BarRendererBase): void {
        const sky = this.systemSkyline;
        const baseX = renderer.x;
        const bar = renderer.barLocalSkyline;
        bar.upSky.forEachSegment((xStart, xEnd, height) => {
            if (height > 0) {
                sky.insertPlaced(StaffSide.Top, baseX + xStart, baseX + xEnd, height, 0);
            }
        });
        bar.downSky.forEachSegment((xStart, xEnd, height) => {
            if (height > 0) {
                sky.insertPlaced(StaffSide.Bottom, baseX + xStart, baseX + xEnd, height, 0);
            }
        });
    }

    public resetSkylines(): void {
        this._systemSkyline?.reset();
        for (const renderer of this.barRenderers) {
            renderer.resetBarLocalSkyline();
        }
    }

    /**
     * Performs an early calculation of the expected staff height for the size calculation in the
     * accolade (e.g. for braces). This typically happens after the first bar renderers were created
     * and we can do an early placement of the render staffs.
     */
    public calculateHeightForAccolade() {
        this._applyStaffPaddings();

        this.height = this.barRenderers.length > 0 ? this.barRenderers[0].height : 0;

        if (this.height > 0) {
            this.height += Math.ceil(this.topPadding + this.topOverflow + this.bottomOverflow + this.bottomPadding);
        }
    }

    private _applyStaffPaddings() {
        const isFirst = this.index === 0;
        const isLast = this.index === this.system.staves.length - 1;
        const settings = this.system.layout.renderer.settings.display;
        this.topPadding = isFirst ? settings.firstNotationStaffPaddingTop : settings.notationStaffPaddingTop;
        this.bottomPadding = isLast ? settings.lastNotationStaffPaddingBottom : settings.notationStaffPaddingBottom;
    }

    public finalizeStaff(): void {
        this._applyStaffPaddings();

        this.height = 0;

        // `_scaleToWidth` has settled each renderer's x/width by now.
        this.systemSkyline.reset();
        this.effectPlacement.reset();

        let needsSecondPass = false;
        for (const renderer of this.barRenderers) {
            renderer.registerMultiSystemSlurs(this.system.layout!.slurRegistry.getAllContinuations(renderer));
            if (renderer.finalizeRenderer()) {
                needsSecondPass = true;
            }
            this.height = Math.max(this.height, renderer.height);
            this._unionBarLocalIntoStaffSkyline(renderer);
        }

        this.effectPlacement.placeAndApply();

        let topOverflow: number = this.topOverflow;
        for (const renderer of this.barRenderers) {
            renderer.y = this.topPadding + topOverflow;
        }

        if (needsSecondPass) {
            this.systemSkyline.reset();
            this.effectPlacement.reset();
            for (const renderer of this.barRenderers) {
                renderer.finalizeRenderer();
                this._unionBarLocalIntoStaffSkyline(renderer);
            }
            this.effectPlacement.placeAndApply();

            topOverflow = this.topOverflow;
            for (const renderer of this.barRenderers) {
                renderer.y = this.topPadding + topOverflow;
            }
        }

        if (this.height > 0) {
            this.height += this.topPadding + topOverflow + this.bottomOverflow + this.bottomPadding;
        }

        this.height = Math.ceil(this.height);

        this._updateVisibility();
    }

    public paint(cx: number, cy: number, canvas: ICanvas, startIndex: number, count: number): void {
        if (this.height === 0 || count === 0) {
            return;
        }

        // canvas.color = Color.random();
        // canvas.fillRect(cx + this.x, cy + this.y, this.system.width - this.x, this.height);

        for (
            let i: number = startIndex, j: number = Math.min(startIndex + count, this.barRenderers.length);
            i < j;
            i++
        ) {
            this.barRenderers[i].paint(cx + this.x, cy + this.y, canvas);
        }
    }
}

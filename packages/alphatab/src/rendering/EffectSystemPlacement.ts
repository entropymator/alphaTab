import type { EffectBand } from '@coderline/alphatab/rendering/EffectBand';
import type { EffectBandInfo } from '@coderline/alphatab/rendering/BarRendererFactory';
import { EffectBandPlacementCategory, type EffectInfo } from '@coderline/alphatab/rendering/EffectInfo';
import type { Skyline } from '@coderline/alphatab/rendering/skyline/Skyline';
import type { RenderStaff } from '@coderline/alphatab/rendering/staves/RenderStaff';

/**
 * Priority-ordered skyline oracle that positions every {@link EffectBand} on
 * a staff line (issue CoderLine/alphaTab#2010). Fires from
 * {@link RenderStaff.finalizeStaff}.
 * @internal
 */
export class EffectSystemPlacement {
    private readonly _staff: RenderStaff;

    // Reusable scratch buffers — same instance is rebuilt on every finalize cycle.
    private readonly _top: EffectBand[] = [];
    private readonly _bottom: EffectBand[] = [];
    private readonly _contentTop: number[] = [];
    private readonly _contentBottom: number[] = [];
    private readonly _orderMap: Map<EffectInfo, number> = new Map();
    private readonly _groupBands: EffectBand[] = [];
    private readonly _groupXStarts: number[] = [];
    private readonly _groupXEnds: number[] = [];
    private readonly _xRangeScratch: { xStart: number; xEnd: number } = { xStart: 0, xEnd: 0 };

    public constructor(staff: RenderStaff) {
        this._staff = staff;
    }

    public reset(): void {
        for (const r of this._staff.barRenderers) {
            r.topEffects.height = 0;
            r.bottomEffects.height = 0;
            for (const b of r.topEffects.bands) {
                b.y = 0;
                b.placedMagnitude = 0;
            }
            for (const b of r.bottomEffects.bands) {
                b.y = 0;
                b.placedMagnitude = 0;
            }
        }
    }

    public placeAndApply(): void {
        const staff = this._staff;
        const sky = staff.systemSkyline;
        const pad = staff.system.layout.renderer.settings.display.effectBandPaddingBottom;

        const top = this._top;
        const bottom = this._bottom;
        const contentTop = this._contentTop;
        const contentBottom = this._contentBottom;
        top.length = 0;
        bottom.length = 0;
        contentTop.length = 0;
        contentBottom.length = 0;

        // container.height = post-placement max - pre-placement max.
        for (let i = 0; i < staff.barRenderers.length; i++) {
            const r = staff.barRenderers[i];
            contentTop.push(sky.upSky.maxHeightInRange(r.x, r.x + r.width));
            contentBottom.push(sky.downSky.maxHeightInRange(r.x, r.x + r.width));
            for (const b of r.topEffects.bands) {
                if (!b.isEmpty) {
                    top.push(b);
                }
            }
            for (const b of r.bottomEffects.bands) {
                if (!b.isEmpty) {
                    bottom.push(b);
                }
            }
        }

        // Settle dynamic-height effects (TabWhammy, ...) before placement.
        for (const b of top) {
            b.finalizeBand();
        }
        for (const b of bottom) {
            b.finalizeBand();
        }

        this._buildOrderMap();
        this._sortByPriority(top);
        this._sortByPriority(bottom);

        this._placeSide(top, sky.upSky, pad, /* isTop */ true);
        this._placeSide(bottom, sky.downSky, pad, /* isTop */ false);

        for (let i = 0; i < staff.barRenderers.length; i++) {
            const r = staff.barRenderers[i];
            const topMax = sky.upSky.maxHeightInRange(r.x, r.x + r.width);
            r.topEffects.height = Math.max(0, Math.ceil(topMax - contentTop[i]));

            const bottomMax = sky.downSky.maxHeightInRange(r.x, r.x + r.width);
            r.bottomEffects.height = Math.max(0, Math.ceil(bottomMax - contentBottom[i]));

            r.registerStaffOverflows();
        }

        const staffTopOverflow = staff.topOverflow;
        const staffBottomOverflow = staff.bottomOverflow;
        for (const band of top) {
            band.y = staffTopOverflow - (band.placedMagnitude + band.height);
        }
        for (const band of bottom) {
            band.y = band.placedMagnitude + band.renderer.bottomEffects.height - staffBottomOverflow;
        }
    }

    private _buildOrderMap(): void {
        this._orderMap.clear();
        EffectSystemPlacement._populateOrder(this._orderMap, this._staff.topEffectInfos);
        EffectSystemPlacement._populateOrder(this._orderMap, this._staff.bottomEffectInfos);
    }

    private static _populateOrder(map: Map<EffectInfo, number>, infos: EffectBandInfo[]): void {
        for (let i = 0; i < infos.length; i++) {
            const info = infos[i];
            if (!map.has(info.effect)) {
                map.set(info.effect, info.order ?? i);
            }
        }
    }

    /**
     * Sort key: (placementCategory asc, order desc, voice asc, renderer asc).
     * Higher `order` placed first → closest to staff (e.g. voltas at `order: 1000`).
     */
    private _sortByPriority(bands: EffectBand[]): void {
        const orderMap = this._orderMap;
        bands.sort((a, b) => {
            const ca = a.info.placementCategory;
            const cb = b.info.placementCategory;
            if (ca !== cb) {
                return ca - cb;
            }
            const oa = orderMap.get(a.info) ?? 0;
            const ob = orderMap.get(b.info) ?? 0;
            if (oa !== ob) {
                return ob - oa;
            }
            const va = a.voice.index;
            const vb = b.voice.index;
            if (va !== vb) {
                return va - vb;
            }
            return a.renderer.index - b.renderer.index;
        });
    }

    private _placeSide(bands: EffectBand[], sky: Skyline, pad: number, isTop: boolean): void {
        const groupBands = this._groupBands;
        const groupXStarts = this._groupXStarts;
        const groupXEnds = this._groupXEnds;
        let i = 0;
        while (i < bands.length) {
            const band = bands[i];

            // Group same-magnitude bands: HorizontalRow row mates or linked-chain continuations.
            let groupEnd = i + 1;
            const groupEffectId = band.info.effectId;
            const groupVoiceIndex = band.voice.index;
            if (band.info.placementCategory === EffectBandPlacementCategory.HorizontalRow) {
                while (
                    groupEnd < bands.length &&
                    bands[groupEnd].info.placementCategory === EffectBandPlacementCategory.HorizontalRow &&
                    bands[groupEnd].info.effectId === groupEffectId &&
                    bands[groupEnd].voice.index === groupVoiceIndex
                ) {
                    groupEnd++;
                }
            } else {
                while (
                    groupEnd < bands.length &&
                    bands[groupEnd].info.effectId === groupEffectId &&
                    bands[groupEnd].voice.index === groupVoiceIndex &&
                    bands[groupEnd].isLinkedToPrevious
                ) {
                    groupEnd++;
                }
            }

            // Two-phase: query without inserting so chain members don't see each other,
            // then commit every member at the group's max magnitude.
            groupBands.length = 0;
            groupXStarts.length = 0;
            groupXEnds.length = 0;
            const xRange = this._xRangeScratch;
            let groupMagnitude = 0;
            for (let k = i; k < groupEnd; k++) {
                const m = bands[k];
                if (!m.computeLocalXRange(xRange)) {
                    continue;
                }
                const xStart = m.renderer.x + xRange.xStart;
                const xEnd = m.renderer.x + xRange.xEnd;
                const mag = isTop
                    ? sky.placeAbove(xStart, xEnd, m.height, pad)
                    : sky.placeBelow(xStart, xEnd, m.height, pad);
                if (mag > groupMagnitude) {
                    groupMagnitude = mag;
                }
                groupBands.push(m);
                groupXStarts.push(xStart);
                groupXEnds.push(xEnd);
            }
            for (let k = 0; k < groupBands.length; k++) {
                const b = groupBands[k];
                b.placedMagnitude = groupMagnitude;
                sky.insert(groupXStarts[k], groupXEnds[k], groupMagnitude + b.height, pad);
            }
            i = groupEnd;
        }
    }
}

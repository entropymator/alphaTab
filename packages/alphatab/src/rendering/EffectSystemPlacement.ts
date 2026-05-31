import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';
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

        // container.height = post-placement max - pre-placement max.
        const contentTop = new Map<BarRendererBase, number>();
        const contentBottom = new Map<BarRendererBase, number>();
        for (const r of staff.barRenderers) {
            contentTop.set(r, sky.upSky.maxHeightInRange(r.x, r.x + r.width));
            contentBottom.set(r, sky.downSky.maxHeightInRange(r.x, r.x + r.width));
        }

        const top: EffectBand[] = [];
        const bottom: EffectBand[] = [];
        for (const r of staff.barRenderers) {
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

        const orderMap = this._buildOrderMap();
        EffectSystemPlacement._sortByPriority(top, orderMap);
        EffectSystemPlacement._sortByPriority(bottom, orderMap);

        EffectSystemPlacement._placeSide(top, sky.upSky, pad, /* isTop */ true);
        EffectSystemPlacement._placeSide(bottom, sky.downSky, pad, /* isTop */ false);

        for (const r of staff.barRenderers) {
            const topMax = sky.upSky.maxHeightInRange(r.x, r.x + r.width);
            const topContent = contentTop.get(r)!;
            r.topEffects.height = Math.max(0, Math.ceil(topMax - topContent));

            const bottomMax = sky.downSky.maxHeightInRange(r.x, r.x + r.width);
            const bottomContent = contentBottom.get(r)!;
            r.bottomEffects.height = Math.max(0, Math.ceil(bottomMax - bottomContent));

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

    private _buildOrderMap(): Map<EffectInfo, number> {
        const m = new Map<EffectInfo, number>();
        EffectSystemPlacement._populateOrder(m, this._staff.topEffectInfos);
        EffectSystemPlacement._populateOrder(m, this._staff.bottomEffectInfos);
        return m;
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
    private static _sortByPriority(bands: EffectBand[], orderMap: Map<EffectInfo, number>): void {
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

    /**
     * Groups bands placed at one magnitude:
     *  - {@link EffectBandPlacementCategory.HorizontalRow}: same `(effectId, voice)`.
     *  - Linked chain: bands flagged via {@link EffectBand.isLinkedToPrevious}.
     *  - Otherwise: single band.
     */
    private static _placeSide(bands: EffectBand[], sky: Skyline, pad: number, isTop: boolean): void {
        let i = 0;
        while (i < bands.length) {
            const band = bands[i];

            let groupEnd = i + 1;
            const groupEffectId = band.info.effectId;
            const groupVoiceIndex = band.voice.index;
            // Extend group through HorizontalRow row mates or linked-chain continuations.
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

            // Query without inserting, then commit every member at the group's max magnitude.
            type GroupEntry = { band: EffectBand; xStart: number; xEnd: number };
            const group: GroupEntry[] = [];
            let groupMagnitude = 0;
            for (let k = i; k < groupEnd; k++) {
                const m = bands[k];
                const r = m.computeLocalXRange();
                if (!r) {
                    continue;
                }
                const xStart = m.renderer.x + r.xStart;
                const xEnd = m.renderer.x + r.xEnd;
                const mag = isTop
                    ? sky.placeAbove(xStart, xEnd, m.height, pad)
                    : sky.placeBelow(xStart, xEnd, m.height, pad);
                if (mag > groupMagnitude) {
                    groupMagnitude = mag;
                }
                group.push({ band: m, xStart, xEnd });
            }
            for (const e of group) {
                e.band.placedMagnitude = groupMagnitude;
                sky.insert(e.xStart, e.xEnd, groupMagnitude + e.band.height, pad);
            }
            i = groupEnd;
        }
    }
}

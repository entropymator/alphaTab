import type { EffectBand, EffectBandXRange } from '@coderline/alphatab/rendering/EffectBand';
import { EffectBandPlacementCategory } from '@coderline/alphatab/rendering/EffectInfo';
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
    private readonly _groupBands: EffectBand[] = [];
    private readonly _groupXStarts: number[] = [];
    private readonly _groupXEnds: number[] = [];
    private readonly _xRangeScratch: EffectBandXRange = { xStart: 0, xEnd: 0 };

    public constructor(staff: RenderStaff) {
        this._staff = staff;
    }

    public placeAndApply(): void {
        const staff = this._staff;
        const sky = staff.systemSkyline;
        const pad = staff.system.layout.renderer.settings.display.effectBandPaddingBottom;

        const top = this._top;
        const bottom = this._bottom;
        const contentTop = this._contentTop;
        const contentBottom = this._contentBottom;
        // `splice(0, length)` is the transpile-safe array clear; `length = 0`
        // emits a read-only `Count = 0` assignment in C#. The splice does
        // allocate a removed-array return value per call (4 here, plus 3 in
        // the per-group loop below), which there is no zero-alloc workaround
        // for at the IList<T> level — documented and accepted.
        top.splice(0, top.length);
        bottom.splice(0, bottom.length);
        contentTop.splice(0, contentTop.length);
        contentBottom.splice(0, contentBottom.length);

        // container.height = post-placement max - pre-placement max.
        // Single R-walk: measure pre-placement skyline + filter non-empty bands +
        // settle dynamic-height effects (TabWhammy, ...) inline. `finalizeBand`
        // has no cross-band dependency — `TabWhammyEffectInfo.finalizeBand`
        // reads from `staff.sharedLayoutData` (populated earlier by
        // `onAlignGlyphs`) and writes only to per-band glyph/height state.
        for (let i = 0; i < staff.barRenderers.length; i++) {
            const r = staff.barRenderers[i];
            contentTop.push(sky.upSky.maxHeightInRange(r.x, r.x + r.width));
            contentBottom.push(sky.downSky.maxHeightInRange(r.x, r.x + r.width));
            for (const b of r.topEffects.bands) {
                if (!b.isEmpty) {
                    // Reset placedMagnitude up front: `_placeSide` only writes it
                    // for bands whose `computeLocalXRange` succeeds, but the
                    // trailing band-y loop reads it for every band in `top`.
                    b.placedMagnitude = 0;
                    b.finalizeBand();
                    top.push(b);
                }
            }
            for (const b of r.bottomEffects.bands) {
                if (!b.isEmpty) {
                    b.placedMagnitude = 0;
                    b.finalizeBand();
                    bottom.push(b);
                }
            }
        }

        EffectSystemPlacement._sortByPriority(top);
        EffectSystemPlacement._sortByPriority(bottom);

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

    /**
     * Sort by precomputed {@link EffectBand.sortKey}. The key is packed at
     * band construction (in {@link EffectBandContainer.createVoiceGlyphs})
     * and is lexicographically equivalent to the legacy 4-key comparator:
     * (placementCategory asc, order desc, voice.index asc, renderer.index asc).
     * Higher `order` placed first → closest to staff (e.g. voltas at
     * `order: 1000`). See {@link EffectBand.sortKey} for the bit layout.
     */
    private static _sortByPriority(bands: EffectBand[]): void {
        bands.sort((a, b) => a.sortKey - b.sortKey);
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
            groupBands.splice(0, groupBands.length);
            groupXStarts.splice(0, groupXStarts.length);
            groupXEnds.splice(0, groupXEnds.length);
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

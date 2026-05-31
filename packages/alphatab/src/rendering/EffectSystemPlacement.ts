import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';
import type { EffectBand } from '@coderline/alphatab/rendering/EffectBand';
import type { EffectBandInfo } from '@coderline/alphatab/rendering/BarRendererFactory';
import { EffectBandPlacementCategory, type EffectInfo } from '@coderline/alphatab/rendering/EffectInfo';
import type { Skyline } from '@coderline/alphatab/rendering/skyline/Skyline';
import type { RenderStaff } from '@coderline/alphatab/rendering/staves/RenderStaff';

/**
 * Per-staff effect-band placement pass: replaces the legacy `EffectBandSlot` /
 * `EffectBandSizingInfo` row allocator with a priority-ordered skyline
 * oracle that resolves issue CoderLine/alphaTab#2010.
 *
 * Lifecycle:
 *  1. Constructed once per {@link RenderStaff}.
 *  2. {@link placeAndApply} fires from {@link RenderStaff.finalizeStaff} after
 *     each renderer's bar-local skyline has been folded into the staff's
 *     {@link RenderStaff.systemSkyline}. It:
 *        a. snapshots the pre-effect content-overflow height per renderer,
 *        b. calls {@link EffectBand.finalizeBand} so dynamic-height effects
 *           (e.g. {@link TabWhammyEffectInfo}) finalise `band.height` before
 *           we query the skyline,
 *        c. sorts bands by (tier, info.order, renderer.index) — tier 1 is
 *           discrete annotations, tier 2 is spans — and places each band
 *           against the staff skyline, inserting the placed rect back so
 *           subsequent bands stack,
 *        d. derives each renderer's `topEffects.height` / `bottomEffects.height`
 *           from the skyline delta,
 *        e. re-registers each renderer's overflow on the staff so
 *           {@link RenderStaff.topOverflow}/{@link RenderStaff.bottomOverflow}
 *           reflect the new band stack, and
 *        f. converts each band's `placedMagnitude` into the container-local
 *           `band.y` consumed by {@link EffectBand.paint}.
 *  3. {@link reset} clears per-band placement state on re-layout paths.
 *
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

        // Snapshot pre-effect content overflow per renderer: the bar-local
        // skylines folded into `sky` already cover every non-effect glyph
        // (preBeat/postBeat, voice content, beat effects, ties, beams, …),
        // so the per-renderer maxHeightInRange BEFORE we place any band is
        // the pure content magnitude. The container.height becomes
        // (post - pre) once the bands are stacked on top.
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

        // Run `finalizeBand` before placement so dynamic-height effects
        // (TabWhammy, ...) settle their final `band.height`.
        for (const b of top) {
            b.finalizeBand();
        }
        for (const b of bottom) {
            b.finalizeBand();
        }

        const orderMap = this._buildOrderMap();
        EffectSystemPlacement._sortByPriority(top, orderMap);
        EffectSystemPlacement._sortByPriority(bottom, orderMap);

        // Per-x placement (default): each band only clears content whose
        // x range actually overlaps the band's own x extent (widened by
        // `pad` for clearance). Bands at non-overlapping x positions
        // naturally settle at the same staff-edge y instead of stacking.
        // This is the Phase 2 skyline benefit — `effectBandPaddingBottom`
        // is the inter-rect clearance (bands ↔ content, bands ↔ bands);
        // it is NOT a bar-wide "annotation row" floor.
        //
        // {@link EffectBandPlacementCategory.HorizontalRow}: bands sharing
        // one effect id are placed at the deepest magnitude needed across
        // the row's combined x-range so the text sits on one baseline
        // across the system (Gould p.300 "parallel to the stave"; see
        // {@link EffectBandPlacementCategory.HorizontalRow} for the
        // rationale).
        EffectSystemPlacement._placeSide(top, sky.upSky, pad, /* isTop */ true);
        EffectSystemPlacement._placeSide(bottom, sky.downSky, pad, /* isTop */ false);

        // Derive each renderer's container heights from the per-renderer
        // skyline delta and re-register the resulting overflow on the staff.
        for (const r of staff.barRenderers) {
            const topMax = sky.upSky.maxHeightInRange(r.x, r.x + r.width);
            const topContent = contentTop.get(r)!;
            r.topEffects.height = Math.max(0, Math.ceil(topMax - topContent));

            const bottomMax = sky.downSky.maxHeightInRange(r.x, r.x + r.width);
            const bottomContent = contentBottom.get(r)!;
            r.bottomEffects.height = Math.max(0, Math.ceil(bottomMax - bottomContent));

            r.registerStaffOverflows();
        }

        // Convert each band's `placedMagnitude` (= inner-edge magnitude
        // outward from the staff reference) into container-local `band.y`
        // (= top-edge in the painted container, which is positioned by
        // `BarRendererBase.paint` against `staff.topOverflow` /
        // `staff.bottomOverflow`). Top container grows upward away from the
        // staff; bottom container grows downward.
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
     * Primary sort key is {@link EffectInfo.placementCategory}: note-attached
     * annotations (articulations, text, dynamics, fingerings, ...) place
     * first against the empty skyline and end up closest to the staff;
     * passage spans (vibrato, let-ring, palm-mute, trill, ...) place
     * after; system markers (tempo, rehearsal, section, alternate
     * endings, ...) place last and end up furthest out. This matches
     * the priority ordering in
     * `docs/engine-design/10-collision/priority-ordering.md §5` and
     * Behind Bars p. 117-184. Within a category, {@link
     * EffectBandInfo.order} stably tiebreaks with the intuitive
     * "visual stack position" reading: a higher `order` sorts first
     * → placed first → ends up closest to the staff, so `order: 0`
     * (the implicit value for factory-index-defaulted entries) is
     * the topmost (furthest from staff) within the category and
     * larger values pull the band back toward the staff. Within an
     * order, renderer index keeps the sort left-to-right.
     */
    private static _sortByPriority(bands: EffectBand[], orderMap: Map<EffectInfo, number>): void {
        bands.sort((a, b) => {
            const ca = a.info.placementCategory;
            const cb = b.info.placementCategory;
            if (ca !== cb) {
                return ca - cb;
            }
            // Higher `order` sorts first → placed first against the
            // empty skyline → closest to the staff. This matches the
            // intuitive reading of `EffectBandInfo.order` as a visual-
            // stack position where `order: 0` is the topmost (furthest
            // from staff) entry and larger values pull the band back
            // toward the staff (e.g. `AlternateEndingsEffectInfo`'s
            // `order: 1000` keeps repeat brackets right next to the
            // staff, per Gould Ch.11).
            const oa = orderMap.get(a.info) ?? 0;
            const ob = orderMap.get(b.info) ?? 0;
            if (oa !== ob) {
                return ob - oa;
            }
            // Voice index before renderer index: keeps each voice's
            // bands contiguous in the sorted list, which lets the
            // {@link _placeSide} horizontal-row sweep group per-voice
            // rows (multi-voice lyrics stack with voice 0 closest to
            // the staff).
            const va = a.voice.index;
            const vb = b.voice.index;
            if (va !== vb) {
                return va - vb;
            }
            return a.renderer.index - b.renderer.index;
        });
    }

    /**
     * Walks a side's already-priority-sorted band list and dispatches to
     * the placement style implied by each band's
     * {@link EffectBandPlacementCategory}:
     *
     * - default (per-x): query the skyline for the band's own x range,
     *   place at the shallowest clearance, insert.
     * - {@link EffectBandPlacementCategory.HorizontalRow}: collect the
     *   contiguous run of same-effect-id bands, query each one's
     *   `placeAbove`/`placeBelow` without inserting, then place every
     *   band in the run at the run's max magnitude and insert all rects
     *   at that aligned magnitude. The sort guarantees same-effect-id
     *   bands are adjacent, and the post-run insert keeps subsequent
     *   bands (other effects, later groups) clear of the whole row.
     */
    private static _placeSide(bands: EffectBand[], sky: Skyline, pad: number, isTop: boolean): void {
        let i = 0;
        while (i < bands.length) {
            const band = bands[i];

            // Determine the placement group ending index (exclusive). Three
            // group shapes exist; all three are resolved by the same
            // "place every member at the group's max magnitude" body further
            // down — only the group selector differs:
            //
            // 1. {@link EffectBandPlacementCategory.HorizontalRow}: all
            //    bands sharing one effect id + voice index (per
            //    {@link _sortByPriority} they are adjacent). Used by
            //    lyrics, voltas, and other "parallel-to-staff" rows.
            //
            // 2. Linked chain: an effect that {@link EffectInfo.canExpand}s
            //    across bars sets {@link EffectBand.isLinkedToPrevious} on
            //    every continuation band. Multi-bar sustain pedal /
            //    crescendo brackets are visually one block, so they must
            //    sit at one magnitude — otherwise each subsequent band
            //    would see its predecessor in the pad-widened skyline
            //    range and stair-step up at every barline.
            //
            // 3. Single band: no chain, not a row member. groupEnd = i + 1
            //    and the group body collapses to a single placeAbove /
            //    placeBelow + insert (the historical per-x behaviour).
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

            // Query each member without inserting first so chain members
            // do not see each other, then place every member at the
            // group's max magnitude and insert. Subsequent groups (other
            // effects, later chains) clear the whole block.
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

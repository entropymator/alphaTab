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
     * EffectBandInfo.order} stably tiebreaks (preserves factory
     * declaration order); within an order, renderer index keeps the
     * sort left-to-right.
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
                return oa - ob;
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
            const range = band.computeLocalXRange();
            if (!range) {
                i++;
                continue;
            }

            if (band.info.placementCategory !== EffectBandPlacementCategory.HorizontalRow) {
                const xStart = band.renderer.x + range.xStart;
                const xEnd = band.renderer.x + range.xEnd;
                const magnitude = isTop
                    ? sky.placeAbove(xStart, xEnd, band.height, pad)
                    : sky.placeBelow(xStart, xEnd, band.height, pad);
                band.placedMagnitude = magnitude;
                sky.insert(xStart, xEnd, magnitude + band.height, pad);
                i++;
                continue;
            }

            // Horizontal-row run: bands sharing one effect id AND voice
            // index are adjacent after the priority sort. Each voice
            // forms its own row (multi-voice lyrics stack: voice 0
            // closest to the staff, voice 1 below it, etc.). Collect
            // each run's x ranges first (without inserting) so the
            // group's max magnitude reflects the whole row's deepest
            // need; then place every band at that max and insert. The
            // insert places voice N's row in the skyline before voice
            // N+1's run queries, so voice N+1 stacks behind it.
            const rowEffectId = band.info.effectId;
            const rowVoiceIndex = band.voice.index;
            type RowEntry = { band: EffectBand; xStart: number; xEnd: number; magnitude: number };
            const row: RowEntry[] = [];
            let rowMagnitude = 0;
            let j = i;
            while (
                j < bands.length &&
                bands[j].info.placementCategory === EffectBandPlacementCategory.HorizontalRow &&
                bands[j].info.effectId === rowEffectId &&
                bands[j].voice.index === rowVoiceIndex
            ) {
                const r = bands[j].computeLocalXRange();
                if (r) {
                    const xStart = bands[j].renderer.x + r.xStart;
                    const xEnd = bands[j].renderer.x + r.xEnd;
                    const magnitude = isTop
                        ? sky.placeAbove(xStart, xEnd, bands[j].height, pad)
                        : sky.placeBelow(xStart, xEnd, bands[j].height, pad);
                    if (magnitude > rowMagnitude) {
                        rowMagnitude = magnitude;
                    }
                    row.push({ band: bands[j], xStart, xEnd, magnitude });
                }
                j++;
            }
            for (const e of row) {
                e.band.placedMagnitude = rowMagnitude;
                sky.insert(e.xStart, e.xEnd, rowMagnitude + e.band.height, pad);
            }
            i = j;
        }
    }
}

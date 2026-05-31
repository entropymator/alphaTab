import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';
import type { EffectBand } from '@coderline/alphatab/rendering/EffectBand';
import type { EffectBandInfo } from '@coderline/alphatab/rendering/BarRendererFactory';
import { EffectBarGlyphSizing } from '@coderline/alphatab/rendering/EffectBarGlyphSizing';
import type { EffectInfo } from '@coderline/alphatab/rendering/EffectInfo';
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

        for (const band of top) {
            const range = band.computeLocalXRange();
            if (!range) {
                continue;
            }
            const xStart = band.renderer.x + range.xStart;
            const xEnd = band.renderer.x + range.xEnd;
            const magnitude = sky.upSky.placeAbove(xStart, xEnd, band.height, pad);
            band.placedMagnitude = magnitude;
            sky.upSky.insert(xStart, xEnd, magnitude + band.height, pad);
        }
        for (const band of bottom) {
            const range = band.computeLocalXRange();
            if (!range) {
                continue;
            }
            const xStart = band.renderer.x + range.xStart;
            const xEnd = band.renderer.x + range.xEnd;
            const magnitude = sky.downSky.placeBelow(xStart, xEnd, band.height, pad);
            band.placedMagnitude = magnitude;
            sky.downSky.insert(xStart, xEnd, magnitude + band.height, pad);
        }

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

    private static _sortByPriority(bands: EffectBand[], orderMap: Map<EffectInfo, number>): void {
        bands.sort((a, b) => {
            const ta = EffectSystemPlacement._tier(a);
            const tb = EffectSystemPlacement._tier(b);
            if (ta !== tb) {
                return ta - tb;
            }
            const oa = orderMap.get(a.info) ?? 0;
            const ob = orderMap.get(b.info) ?? 0;
            if (oa !== ob) {
                return oa - ob;
            }
            return a.renderer.index - b.renderer.index;
        });
    }

    private static _tier(band: EffectBand): number {
        const sm = band.info.sizingMode;
        const single =
            sm === EffectBarGlyphSizing.SinglePreBeat ||
            sm === EffectBarGlyphSizing.SingleOnBeat ||
            sm === EffectBarGlyphSizing.SingleOnBeatToEnd;
        return single && band.firstBeat === band.lastBeat ? 1 : 2;
    }
}

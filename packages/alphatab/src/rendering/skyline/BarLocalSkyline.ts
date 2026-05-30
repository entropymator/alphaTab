import { Skyline } from '@coderline/alphatab/rendering/skyline/Skyline';
import type { SkylineSegmentPool } from '@coderline/alphatab/rendering/skyline/SkylineSegmentPool';

/**
 * Which side of the staff an element is placed on. Drives skyline routing
 * (upSky vs downSky).
 * @internal
 */
export enum StaffSide {
    Top = 0,
    Bottom = 1
}

/**
 * Bar's per-side scalar envelope contribution. Both fields are non-negative
 * magnitudes from the staff's natural top / bottom line outward.
 * @internal
 */
export class BarSkylineScalars {
    public skylineUp: number;
    public skylineDown: number;

    public constructor(skylineUp: number = 0, skylineDown: number = 0) {
        this.skylineUp = skylineUp;
        this.skylineDown = skylineDown;
    }

    public reset(): void {
        this.skylineUp = 0;
        this.skylineDown = 0;
    }
}

/**
 * Bar-local Skyline pair tracking the vertical envelope of every glyph
 * anchored within a single bar.
 *
 * Lifecycle:
 *   1. construct with the bar's renderer-local x-range + segment pool;
 *      both skylines start flat.
 *   2. existing glyph layout sites call `insertPlaced(side, ...)` to
 *      register the placed rect of each non-effect-band glyph.
 *   3. `computeBarScalars()` emits the bar's per-side max heights for
 *      aggregation into the staff skyline.
 *   4. `reset()` returns segments to the pool for reuse on the next
 *      content layout cycle.
 *
 * @internal
 */
export class BarLocalSkyline {
    public readonly upSky: Skyline;
    public readonly downSky: Skyline;

    public constructor(xMin: number, xMax: number, pool: SkylineSegmentPool) {
        this.upSky = new Skyline(xMin, xMax, pool);
        this.downSky = new Skyline(xMin, xMax, pool);
    }

    /**
     * Side-aware placement query. Returns the smallest non-negative outward
     * magnitude at which a (xStart - pad .. xEnd + pad) × (y .. y +
     * intrinsicHeight) rect, with `pad` clearance applied to the returned y,
     * fits in the addressed skyline.
     */
    public place(side: StaffSide, xStart: number, xEnd: number, intrinsicHeight: number, pad: number): number {
        if (side === StaffSide.Top) {
            return this.upSky.placeAbove(xStart, xEnd, intrinsicHeight, pad);
        }
        return this.downSky.placeBelow(xStart, xEnd, intrinsicHeight, pad);
    }

    /**
     * Insert a placed rect into the addressed side.
     * `outerEdgeHeight` is the outer-edge magnitude (top of the rect for
     * upSky; bottom of the rect for downSky), measured from the staff's
     * reference edge.
     */
    public insertPlaced(
        side: StaffSide,
        xStart: number,
        xEnd: number,
        outerEdgeHeight: number,
        pad: number
    ): void {
        if (side === StaffSide.Top) {
            this.upSky.insert(xStart, xEnd, outerEdgeHeight, pad);
        } else {
            this.downSky.insert(xStart, xEnd, outerEdgeHeight, pad);
        }
    }

    /** Compute the bar's per-side scalar envelopes for aggregation. */
    public computeBarScalars(): BarSkylineScalars {
        return new BarSkylineScalars(this.upSky.maxHeight(), this.downSky.maxHeight());
    }

    /** Reset both child Skylines for pool reuse. */
    public reset(): void {
        this.upSky.reset();
        this.downSky.reset();
    }

    /**
     * Release ALL segments (including the baselines) on both child Skylines
     * back to the pool. The wrapper is unusable after this call — discard it.
     */
    public releaseAll(): void {
        this.upSky.releaseAll();
        this.downSky.releaseAll();
    }
}

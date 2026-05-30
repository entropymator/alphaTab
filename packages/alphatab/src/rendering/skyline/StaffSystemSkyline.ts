import { StaffSide } from '@coderline/alphatab/rendering/skyline/BarLocalSkyline';
import { Skyline } from '@coderline/alphatab/rendering/skyline/Skyline';
import type { SkylineSegmentPool } from '@coderline/alphatab/rendering/skyline/SkylineSegmentPool';

/**
 * Per-staff band heights consumed by the layout / inter-staff gap. Both
 * fields are non-negative magnitudes from the staff's top / bottom
 * reference edge outward.
 * @internal
 */
export class StaffSystemBandHeights {
    public topAnnotationBandHeight: number;
    public bottomAnnotationBandHeight: number;

    public constructor(topAnnotationBandHeight: number = 0, bottomAnnotationBandHeight: number = 0) {
        this.topAnnotationBandHeight = topAnnotationBandHeight;
        this.bottomAnnotationBandHeight = bottomAnnotationBandHeight;
    }

    public reset(): void {
        this.topAnnotationBandHeight = 0;
        this.bottomAnnotationBandHeight = 0;
    }
}

/**
 * Per-staff-per-system Skyline pair used for system-level outside-staff
 * placement. Assembled by seeding per-bar envelope scalars (or unioning
 * shifted per-bar local skylines) across all bars on a staff line.
 *
 * Lifecycle:
 *   1. construct with `(staffIndex, systemIndex, xMin, xMax, pool)`.
 *   2. seed from per-bar scalars or via skyline union; both upSky and
 *      downSky start flat and are raised by `insertSeed` / shifted union
 *      from the per-bar local skylines.
 *   3. consumers (effect placement, future cross-staff spacing) call
 *      `place(side, ...)` to obtain a y, then `insertPlaced(side, ...)`
 *      to register the placed rect so subsequent placements stack.
 *   4. `computeBandHeights()` emits the per-side max heights.
 *   5. `releaseAll()` returns all segments back to the pool.
 *
 * @internal
 */
export class StaffSystemSkyline {
    public readonly staffIndex: number;
    public readonly systemIndex: number;
    public readonly upSky: Skyline;
    public readonly downSky: Skyline;

    public constructor(
        staffIndex: number,
        systemIndex: number,
        xMin: number,
        xMax: number,
        pool: SkylineSegmentPool
    ) {
        this.staffIndex = staffIndex;
        this.systemIndex = systemIndex;
        this.upSky = new Skyline(xMin, xMax, pool);
        this.downSky = new Skyline(xMin, xMax, pool);
    }

    /**
     * Seed step: raise upSky and downSky to the per-bar envelopes. Zero
     * magnitudes are skipped to avoid pointless segment churn on empty bars.
     */
    public insertSeed(xStart: number, xEnd: number, seedUp: number, seedDown: number): void {
        if (seedUp > 0) {
            this.upSky.insert(xStart, xEnd, seedUp, 0);
        }
        if (seedDown > 0) {
            this.downSky.insert(xStart, xEnd, seedDown, 0);
        }
    }

    /**
     * Place an element using the side-aware placement oracle. The returned
     * magnitude is non-negative outward; caller translates to the element's
     * local frame.
     */
    public place(side: StaffSide, xStart: number, xEnd: number, intrinsicHeight: number, pad: number): number {
        if (side === StaffSide.Top) {
            return this.upSky.placeAbove(xStart, xEnd, intrinsicHeight, pad);
        }
        return this.downSky.placeBelow(xStart, xEnd, intrinsicHeight, pad);
    }

    /**
     * Insert a placed rect. For point elements: one call. For span elements
     * (slur, hairpin, …): called once per finalised geometry segment so the
     * next element sees the actual span profile, not its bounding rectangle.
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

    /** Emit the band-height scalars. */
    public computeBandHeights(): StaffSystemBandHeights {
        return new StaffSystemBandHeights(this.upSky.maxHeight(), this.downSky.maxHeight());
    }

    /** Reset both child Skylines (keep baseline; segments returned to pool). */
    public reset(): void {
        this.upSky.reset();
        this.downSky.reset();
    }

    /** Release ALL segments (including baselines) back to the pool. */
    public releaseAll(): void {
        this.upSky.releaseAll();
        this.downSky.releaseAll();
    }
}

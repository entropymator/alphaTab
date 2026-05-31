import { StaffSide } from '@coderline/alphatab/rendering/skyline/BarLocalSkyline';
import { Skyline } from '@coderline/alphatab/rendering/skyline/Skyline';
import type { SkylineSegmentPool } from '@coderline/alphatab/rendering/skyline/SkylineSegmentPool';

/** @internal */
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
 * Skyline pair for system-level placement. Assembled by unioning per-bar
 * local skylines shifted by `renderer.x`.
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

    public insertSeed(xStart: number, xEnd: number, seedUp: number, seedDown: number): void {
        if (seedUp > 0) {
            this.upSky.insert(xStart, xEnd, seedUp, 0);
        }
        if (seedDown > 0) {
            this.downSky.insert(xStart, xEnd, seedDown, 0);
        }
    }

    public place(side: StaffSide, xStart: number, xEnd: number, intrinsicHeight: number, pad: number): number {
        if (side === StaffSide.Top) {
            return this.upSky.placeAbove(xStart, xEnd, intrinsicHeight, pad);
        }
        return this.downSky.placeBelow(xStart, xEnd, intrinsicHeight, pad);
    }

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

    public computeBandHeights(): StaffSystemBandHeights {
        return new StaffSystemBandHeights(this.upSky.maxHeight(), this.downSky.maxHeight());
    }

    public reset(): void {
        this.upSky.reset();
        this.downSky.reset();
    }

    public releaseAll(): void {
        this.upSky.releaseAll();
        this.downSky.releaseAll();
    }
}

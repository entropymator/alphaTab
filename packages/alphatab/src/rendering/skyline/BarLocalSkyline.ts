import { Skyline } from '@coderline/alphatab/rendering/skyline/Skyline';
import type { SkylineSegmentPool } from '@coderline/alphatab/rendering/skyline/SkylineSegmentPool';

/** @internal */
export enum StaffSide {
    Top = 0,
    Bottom = 1
}

/** @internal */
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
 * Bar-local Skyline pair (renderer-local x).
 * @internal
 */
export class BarLocalSkyline {
    public readonly upSky: Skyline;
    public readonly downSky: Skyline;

    public constructor(xMin: number, xMax: number, pool: SkylineSegmentPool) {
        this.upSky = new Skyline(xMin, xMax, pool);
        this.downSky = new Skyline(xMin, xMax, pool);
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

    public computeBarScalars(): BarSkylineScalars {
        return new BarSkylineScalars(this.upSky.maxHeight(), this.downSky.maxHeight());
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

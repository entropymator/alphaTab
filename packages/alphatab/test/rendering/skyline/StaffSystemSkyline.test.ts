import { StaffSide } from '@coderline/alphatab/rendering/skyline/BarLocalSkyline';
import { SkylineSegmentPool } from '@coderline/alphatab/rendering/skyline/SkylineSegmentPool';
import { StaffSystemBandHeights, StaffSystemSkyline } from '@coderline/alphatab/rendering/skyline/StaffSystemSkyline';
import { describe, expect, it } from 'vitest';

class SysSkyHandle {
    public readonly sky: StaffSystemSkyline;
    public readonly pool: SkylineSegmentPool;
    public constructor(sky: StaffSystemSkyline, pool: SkylineSegmentPool) {
        this.sky = sky;
        this.pool = pool;
    }
}

class ArcSample {
    public readonly xStart: number;
    public readonly xEnd: number;
    public readonly h: number;
    public constructor(xStart: number, xEnd: number, h: number) {
        this.xStart = xStart;
        this.xEnd = xEnd;
        this.h = h;
    }
}

class StaffSystemSkylineFixtures {
    public static newSysSky(
        staffIndex: number = 0,
        systemIndex: number = 0,
        xMin: number = 0,
        xMax: number = 200
    ): SysSkyHandle {
        const pool: SkylineSegmentPool = new SkylineSegmentPool();
        const sky: StaffSystemSkyline = new StaffSystemSkyline(staffIndex, systemIndex, xMin, xMax, pool);
        return new SysSkyHandle(sky, pool);
    }
}

describe('StaffSystemSkyline — construction', () => {
    it('records staffIndex + systemIndex and starts with flat skylines', () => {
        const h: SysSkyHandle = StaffSystemSkylineFixtures.newSysSky(2, 5, 0, 80);
        const sky: StaffSystemSkyline = h.sky;
        expect(sky.staffIndex).toBe(2);
        expect(sky.systemIndex).toBe(5);
        expect(sky.upSky.xMin).toBe(0);
        expect(sky.upSky.xMax).toBe(80);
        expect(sky.downSky.xMin).toBe(0);
        expect(sky.downSky.xMax).toBe(80);
        expect(sky.upSky.maxHeight()).toBe(0);
        expect(sky.downSky.maxHeight()).toBe(0);
    });
});

describe('StaffSystemSkyline — insertSeed', () => {
    it('raises upSky and downSky to the per-bar envelopes', () => {
        const h: SysSkyHandle = StaffSystemSkylineFixtures.newSysSky();
        const sky: StaffSystemSkyline = h.sky;
        sky.insertSeed(0, 40, 3, 2);
        sky.insertSeed(40, 80, 5, 1);
        sky.insertSeed(80, 120, 1, 4);
        const heights: StaffSystemBandHeights = sky.computeBandHeights();
        expect(heights.topAnnotationBandHeight).toBe(5);
        expect(heights.bottomAnnotationBandHeight).toBe(4);
    });

    it('zero-magnitude seeds do not raise the side', () => {
        const h: SysSkyHandle = StaffSystemSkylineFixtures.newSysSky();
        const sky: StaffSystemSkyline = h.sky;
        const pool: SkylineSegmentPool = h.pool;
        sky.insertSeed(0, 100, 0, 0);
        expect(sky.upSky.maxHeight()).toBe(0);
        expect(sky.downSky.maxHeight()).toBe(0);
        expect(pool.grownCount).toBe(4); // 2 baseline segments per sky
    });

    it('non-zero seeds on only one side leave the other untouched', () => {
        const h: SysSkyHandle = StaffSystemSkylineFixtures.newSysSky();
        const sky: StaffSystemSkyline = h.sky;
        sky.insertSeed(10, 30, 4, 0);
        sky.insertSeed(40, 60, 0, 3);
        expect(sky.upSky.maxHeight()).toBe(4);
        expect(sky.downSky.maxHeight()).toBe(3);
    });
});

describe('StaffSystemSkyline — place + insertPlaced', () => {
    it('places above the seeded envelope (priority stacking via call order)', () => {
        const h: SysSkyHandle = StaffSystemSkylineFixtures.newSysSky(0, 0, 0, 200);
        const sky: StaffSystemSkyline = h.sky;
        sky.insertSeed(0, 100, 3, 2);
        sky.insertSeed(100, 200, 2, 5);
        const slurY: number = sky.place(StaffSide.Top, 20, 180, 1.5, 0.2);
        expect(slurY).toBeCloseTo(3.2);
        sky.insertPlaced(StaffSide.Top, 20, 180, slurY + 1.5, 0);
        const fY: number = sky.place(StaffSide.Bottom, 48, 52, 1.0, 0.3);
        expect(fY).toBeCloseTo(2.3);
    });

    it('span-style per-segment insertPlaced mirrors the arc profile', () => {
        const h: SysSkyHandle = StaffSystemSkylineFixtures.newSysSky();
        const sky: StaffSystemSkyline = h.sky;
        sky.insertSeed(0, 200, 1, 1);
        const baseY: number = sky.place(StaffSide.Top, 20, 180, 1.5, 0);
        expect(baseY).toBe(1);
        const samples: ArcSample[] = [
            new ArcSample(20, 50, baseY + 0.6),
            new ArcSample(50, 80, baseY + 1.2),
            new ArcSample(80, 120, baseY + 1.5),
            new ArcSample(120, 150, baseY + 1.2),
            new ArcSample(150, 180, baseY + 0.6)
        ];
        for (const s of samples) {
            sky.insertPlaced(StaffSide.Top, s.xStart, s.xEnd, s.h, 0);
        }
        const tempoY: number = sky.place(StaffSide.Top, 95, 105, 1.0, 0);
        expect(tempoY).toBeCloseTo(2.5);
        const tempoY2: number = sky.place(StaffSide.Top, 28, 32, 1.0, 0);
        expect(tempoY2).toBeCloseTo(1.6);
    });
});

describe('StaffSystemSkyline — band heights', () => {
    it('emits per-side maxes after seed + place + insertPlaced', () => {
        const h: SysSkyHandle = StaffSystemSkylineFixtures.newSysSky();
        const sky: StaffSystemSkyline = h.sky;
        sky.insertSeed(0, 100, 2, 1);
        sky.insertPlaced(StaffSide.Top, 20, 80, 5, 0);
        sky.insertPlaced(StaffSide.Bottom, 40, 60, 4, 0);
        const bands: StaffSystemBandHeights = sky.computeBandHeights();
        expect(bands.topAnnotationBandHeight).toBe(5);
        expect(bands.bottomAnnotationBandHeight).toBe(4);
    });

    it('StaffSystemBandHeights.reset zeroes both fields', () => {
        const bands: StaffSystemBandHeights = new StaffSystemBandHeights(3, 4);
        bands.reset();
        expect(bands.topAnnotationBandHeight).toBe(0);
        expect(bands.bottomAnnotationBandHeight).toBe(0);
    });
});

describe('StaffSystemSkyline — lifecycle', () => {
    it('reset clears state for reuse', () => {
        const h: SysSkyHandle = StaffSystemSkylineFixtures.newSysSky();
        const sky: StaffSystemSkyline = h.sky;
        sky.insertSeed(0, 100, 3, 2);
        sky.insertPlaced(StaffSide.Top, 20, 40, 6, 0);
        sky.reset();
        expect(sky.upSky.maxHeight()).toBe(0);
        expect(sky.downSky.maxHeight()).toBe(0);
        sky.insertPlaced(StaffSide.Top, 30, 70, 4, 0);
        expect(sky.upSky.maxHeight()).toBe(4);
    });

    it('releaseAll returns all segments including baselines to the pool', () => {
        const h: SysSkyHandle = StaffSystemSkylineFixtures.newSysSky();
        const sky: StaffSystemSkyline = h.sky;
        const pool: SkylineSegmentPool = h.pool;
        sky.insertSeed(0, 100, 3, 2);
        sky.insertPlaced(StaffSide.Top, 20, 40, 6, 0);
        const grownBefore: number = pool.grownCount;
        sky.releaseAll();
        const sky2: StaffSystemSkyline = new StaffSystemSkyline(0, 0, 0, 100, pool);
        sky2.insertSeed(0, 100, 5, 5);
        expect(pool.grownCount).toBe(grownBefore);
        expect(sky2.upSky.maxHeight()).toBe(5);
    });
});

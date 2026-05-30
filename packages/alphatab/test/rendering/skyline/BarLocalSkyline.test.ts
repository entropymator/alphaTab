import { BarLocalSkyline, BarSkylineScalars, StaffSide } from '@coderline/alphatab/rendering/skyline/BarLocalSkyline';
import { SkylineSegmentPool } from '@coderline/alphatab/rendering/skyline/SkylineSegmentPool';
import { describe, expect, it } from 'vitest';

class Wrapper {
    public readonly bar: BarLocalSkyline;
    public readonly pool: SkylineSegmentPool;
    public constructor(xMin: number = 0, xMax: number = 100) {
        this.pool = new SkylineSegmentPool();
        this.bar = new BarLocalSkyline(xMin, xMax, this.pool);
    }
}

class BarLocalSkylineFixtures {
    public static newWrapper(xMin: number = 0, xMax: number = 100): Wrapper {
        return new Wrapper(xMin, xMax);
    }
}

describe('BarLocalSkyline — construction', () => {
    it('builds two flat skylines over the bar x-range', () => {
        const w: Wrapper = BarLocalSkylineFixtures.newWrapper(0, 50);
        expect(w.bar.upSky.xMin).toBe(0);
        expect(w.bar.upSky.xMax).toBe(50);
        expect(w.bar.downSky.xMin).toBe(0);
        expect(w.bar.downSky.xMax).toBe(50);
        expect(w.bar.upSky.maxHeight()).toBe(0);
        expect(w.bar.downSky.maxHeight()).toBe(0);
    });

    it('place on an empty wrapper returns pad clearance only', () => {
        const w: Wrapper = BarLocalSkylineFixtures.newWrapper();
        expect(w.bar.place(StaffSide.Top, 10, 20, 1, 0)).toBe(0);
        expect(w.bar.place(StaffSide.Top, 10, 20, 1, 0.5)).toBe(0.5);
        expect(w.bar.place(StaffSide.Bottom, 10, 20, 1, 0)).toBe(0);
        expect(w.bar.place(StaffSide.Bottom, 10, 20, 1, 0.3)).toBeCloseTo(0.3);
    });
});

describe('BarLocalSkyline — side-aware routing', () => {
    it('insertPlaced(Top) only affects upSky', () => {
        const w: Wrapper = BarLocalSkylineFixtures.newWrapper();
        w.bar.insertPlaced(StaffSide.Top, 10, 30, 5, 0);
        expect(w.bar.upSky.maxHeight()).toBe(5);
        expect(w.bar.downSky.maxHeight()).toBe(0);
    });

    it('insertPlaced(Bottom) only affects downSky', () => {
        const w: Wrapper = BarLocalSkylineFixtures.newWrapper();
        w.bar.insertPlaced(StaffSide.Bottom, 10, 30, 4, 0);
        expect(w.bar.downSky.maxHeight()).toBe(4);
        expect(w.bar.upSky.maxHeight()).toBe(0);
    });

    it('place(Top) reads upSky; place(Bottom) reads downSky', () => {
        const w: Wrapper = BarLocalSkylineFixtures.newWrapper();
        w.bar.insertPlaced(StaffSide.Top, 10, 30, 5, 0);
        w.bar.insertPlaced(StaffSide.Bottom, 50, 70, 3, 0);
        expect(w.bar.place(StaffSide.Top, 15, 25, 1, 0)).toBe(5);
        expect(w.bar.place(StaffSide.Top, 55, 65, 1, 0)).toBe(0);
        expect(w.bar.place(StaffSide.Bottom, 55, 65, 1, 0)).toBe(3);
        expect(w.bar.place(StaffSide.Bottom, 15, 25, 1, 0)).toBe(0);
    });

    it('top and bottom are mutually independent', () => {
        const w: Wrapper = BarLocalSkylineFixtures.newWrapper();
        w.bar.insertPlaced(StaffSide.Top, 20, 60, 7, 0);
        w.bar.insertPlaced(StaffSide.Bottom, 20, 60, 2, 0);
        expect(w.bar.place(StaffSide.Top, 30, 50, 1, 0)).toBe(7);
        expect(w.bar.place(StaffSide.Bottom, 30, 50, 1, 0)).toBe(2);
    });
});

describe('BarLocalSkyline — stacking via repeated place+insertPlaced', () => {
    it('subsequent placements stack outward in call order', () => {
        const w: Wrapper = BarLocalSkylineFixtures.newWrapper();
        // Seed: notehead extent 2.0 above staff at x=10..30.
        w.bar.insertPlaced(StaffSide.Top, 10, 30, 2, 0);
        const yA: number = w.bar.place(StaffSide.Top, 15, 25, 0.8, 0.25);
        // base = max-in-range (2) + pad (0.25) = 2.25.
        expect(yA).toBeCloseTo(2.25);
        w.bar.insertPlaced(StaffSide.Top, 15, 25, yA + 0.8, 0);
        const yB: number = w.bar.place(StaffSide.Top, 15, 25, 0.8, 0.25);
        // base = 3.05 + 0.25 = 3.3.
        expect(yB).toBeCloseTo(3.3);
    });
});

describe('BarLocalSkyline — computeBarScalars', () => {
    it('emits per-side max heights with both sides populated', () => {
        const w: Wrapper = BarLocalSkylineFixtures.newWrapper();
        w.bar.insertPlaced(StaffSide.Top, 10, 30, 4, 0);
        w.bar.insertPlaced(StaffSide.Top, 50, 70, 8, 0);
        w.bar.insertPlaced(StaffSide.Bottom, 20, 40, 3, 0);
        const s: BarSkylineScalars = w.bar.computeBarScalars();
        expect(s.skylineUp).toBe(8);
        expect(s.skylineDown).toBe(3);
    });

    it('emits zero scalars for an empty bar', () => {
        const w: Wrapper = BarLocalSkylineFixtures.newWrapper();
        const s: BarSkylineScalars = w.bar.computeBarScalars();
        expect(s.skylineUp).toBe(0);
        expect(s.skylineDown).toBe(0);
    });

    it('BarSkylineScalars.reset zeroes both fields', () => {
        const s: BarSkylineScalars = new BarSkylineScalars(3, 5);
        s.reset();
        expect(s.skylineUp).toBe(0);
        expect(s.skylineDown).toBe(0);
    });
});

describe('BarLocalSkyline — reset', () => {
    it('returns child Skylines to baseline + reuses pool segments', () => {
        const w: Wrapper = BarLocalSkylineFixtures.newWrapper();
        w.bar.insertPlaced(StaffSide.Top, 10, 30, 4, 0);
        w.bar.insertPlaced(StaffSide.Bottom, 50, 70, 3, 0);
        const grownBefore: number = w.pool.grownCount;
        w.bar.reset();
        expect(w.bar.upSky.maxHeight()).toBe(0);
        expect(w.bar.downSky.maxHeight()).toBe(0);
        w.bar.insertPlaced(StaffSide.Top, 20, 80, 6, 0);
        expect(w.bar.place(StaffSide.Top, 40, 60, 1, 0)).toBe(6);
        expect(w.pool.grownCount).toBe(grownBefore);
    });
});

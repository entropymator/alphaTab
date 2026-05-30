import { Skyline } from '@coderline/alphatab/rendering/skyline/Skyline';
import { SkylineSegmentPool } from '@coderline/alphatab/rendering/skyline/SkylineSegmentPool';
import { describe, expect, it } from 'vitest';

class SkylineFixtures {
    public static newSkyline(xMin: number, xMax: number): Skyline {
        const pool: SkylineSegmentPool = new SkylineSegmentPool();
        return new Skyline(xMin, xMax, pool);
    }
}

describe('Skyline — construction', () => {
    it('starts with two segments: baseline at xMin + sentinel at xMax', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        expect(sky.xMin).toBe(0);
        expect(sky.xMax).toBe(100);
        expect(sky.segmentCount).toBe(1);
        expect(sky.maxHeight()).toBe(0);
    });

    it('empty placeAbove on a fresh skyline returns pad (zero clearance for pad=0)', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        expect(sky.placeAbove(10, 20, 1, 0)).toBe(0);
        expect(sky.placeAbove(10, 20, 1, 0.5)).toBe(0.5);
    });
});

describe('Skyline — insert + placeAbove', () => {
    it('a single insert raises the skyline in its range', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        sky.insert(10, 30, 5, 0);
        expect(sky.placeAbove(15, 25, 1, 0)).toBe(5);
        expect(sky.placeAbove(40, 60, 1, 0)).toBe(0);
    });

    it('placeAbove adds pad clearance on top of max-in-range', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        sky.insert(10, 30, 5, 0);
        expect(sky.placeAbove(15, 25, 1, 0.5)).toBe(5.5);
    });

    it('placeAbove with horizontal pad sees a neighbouring inserted rect', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        sky.insert(10, 30, 5, 0);
        expect(sky.placeAbove(35, 40, 1, 0)).toBe(0);
        expect(sky.placeAbove(35, 40, 1, 10)).toBe(15);
    });

    it('multiple non-overlapping inserts coexist', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        sky.insert(10, 30, 5, 0);
        sky.insert(50, 70, 3, 0);
        expect(sky.placeAbove(15, 25, 1, 0)).toBe(5);
        expect(sky.placeAbove(55, 65, 1, 0)).toBe(3);
        expect(sky.placeAbove(35, 45, 1, 0)).toBe(0);
    });

    it('overlapping inserts take the per-x max', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        sky.insert(10, 40, 5, 0);
        sky.insert(30, 60, 8, 0);
        expect(sky.placeAbove(15, 25, 1, 0)).toBe(5);
        expect(sky.placeAbove(35, 38, 1, 0)).toBe(8);
        expect(sky.placeAbove(45, 55, 1, 0)).toBe(8);
        expect(sky.placeAbove(80, 90, 1, 0)).toBe(0);
    });

    it('insert below current height is a no-op (per-x max semantics)', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        sky.insert(10, 30, 5, 0);
        sky.insert(10, 30, 2, 0);
        expect(sky.placeAbove(15, 25, 1, 0)).toBe(5);
    });

    it('non-positive newHeight is a no-op', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        sky.insert(10, 30, 0, 0);
        sky.insert(10, 30, -5, 0);
        expect(sky.maxHeight()).toBe(0);
    });

    it('insert outside the skyline range is clamped to [xMin, xMax]', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        sky.insert(-50, 200, 7, 0);
        expect(sky.placeAbove(0, 100, 1, 0)).toBe(7);
    });
});

describe('Skyline — placeBelow', () => {
    it('placeBelow runs the same algorithm as placeAbove', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        sky.insert(10, 30, 4, 0);
        expect(sky.placeBelow(15, 25, 1, 0)).toBe(4);
        expect(sky.placeBelow(15, 25, 1, 0.5)).toBe(4.5);
    });
});

describe('Skyline — adjacency merge', () => {
    it('two contiguous same-height inserts collapse into one segment', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        sky.insert(10, 30, 5, 0);
        sky.insert(30, 50, 5, 0);
        expect(sky.segmentCount).toBe(3);
        expect(sky.placeAbove(40, 45, 1, 0)).toBe(5);
    });

    it('three overlapping inserts at same height collapse', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        sky.insert(10, 30, 5, 0);
        sky.insert(20, 40, 5, 0);
        sky.insert(35, 50, 5, 0);
        expect(sky.segmentCount).toBe(3);
        expect(sky.placeAbove(15, 45, 1, 0)).toBe(5);
    });
});

describe('Skyline — segment splitting at insert boundaries', () => {
    it('insert splits existing segments at xStart and xEnd', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        sky.insert(0, 100, 3, 0);
        expect(sky.segmentCount).toBe(1);
        sky.insert(20, 40, 7, 0);
        expect(sky.segmentCount).toBe(3);
        expect(sky.placeAbove(10, 15, 1, 0)).toBe(3);
        expect(sky.placeAbove(25, 35, 1, 0)).toBe(7);
        expect(sky.placeAbove(50, 60, 1, 0)).toBe(3);
    });
});

describe('Skyline — maxHeight', () => {
    it('returns the largest segment height', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        sky.insert(10, 30, 5, 0);
        sky.insert(50, 70, 12, 0);
        sky.insert(80, 90, 3, 0);
        expect(sky.maxHeight()).toBe(12);
    });

    it('returns 0 for an empty skyline', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        expect(sky.maxHeight()).toBe(0);
    });
});

describe('Skyline — union', () => {
    it('raises self to per-x max of self and other', () => {
        const a: Skyline = SkylineFixtures.newSkyline(0, 100);
        const b: Skyline = SkylineFixtures.newSkyline(0, 100);
        a.insert(10, 40, 5, 0);
        b.insert(30, 60, 8, 0);
        a.union(b);
        expect(a.placeAbove(15, 25, 1, 0)).toBe(5);
        expect(a.placeAbove(35, 38, 1, 0)).toBe(8);
        expect(a.placeAbove(45, 55, 1, 0)).toBe(8);
        expect(a.placeAbove(65, 75, 1, 0)).toBe(0);
    });

    it('union of an empty skyline is a no-op', () => {
        const a: Skyline = SkylineFixtures.newSkyline(0, 100);
        a.insert(10, 30, 5, 0);
        const empty: Skyline = SkylineFixtures.newSkyline(0, 100);
        a.union(empty);
        expect(a.placeAbove(15, 25, 1, 0)).toBe(5);
        expect(a.maxHeight()).toBe(5);
    });
});

describe('Skyline — meshDistance', () => {
    it('returns max over the overlap range of (a.h + b.h)', () => {
        const downSky: Skyline = SkylineFixtures.newSkyline(0, 100);
        const upSky: Skyline = SkylineFixtures.newSkyline(0, 100);
        downSky.insert(10, 40, 3, 0);
        upSky.insert(30, 60, 5, 0);
        expect(downSky.meshDistance(upSky)).toBe(8);
    });

    it('returns 0 when neither skyline has any inserted content', () => {
        const a: Skyline = SkylineFixtures.newSkyline(0, 100);
        const b: Skyline = SkylineFixtures.newSkyline(0, 100);
        expect(a.meshDistance(b)).toBe(0);
    });

    it('returns the larger single-side height when the other is empty', () => {
        const a: Skyline = SkylineFixtures.newSkyline(0, 100);
        const b: Skyline = SkylineFixtures.newSkyline(0, 100);
        a.insert(10, 50, 4, 0);
        expect(a.meshDistance(b)).toBe(4);
        expect(b.meshDistance(a)).toBe(4);
    });
});

describe('Skyline — reset', () => {
    it('returns segments to the pool and rebuilds the baseline', () => {
        const pool: SkylineSegmentPool = new SkylineSegmentPool();
        const sky: Skyline = new Skyline(0, 100, pool);
        sky.insert(10, 30, 5, 0);
        sky.insert(50, 70, 8, 0);
        const grownBefore: number = pool.grownCount;
        expect(grownBefore).toBeGreaterThan(2);
        sky.reset();
        expect(sky.maxHeight()).toBe(0);
        expect(sky.segmentCount).toBe(1);
        sky.insert(20, 80, 6, 0);
        expect(sky.placeAbove(40, 60, 1, 0)).toBe(6);
        expect(pool.grownCount).toBe(grownBefore);
    });

    it('reset is idempotent', () => {
        const sky: Skyline = SkylineFixtures.newSkyline(0, 100);
        sky.insert(10, 30, 5, 0);
        sky.reset();
        sky.reset();
        expect(sky.maxHeight()).toBe(0);
        expect(sky.segmentCount).toBe(1);
    });
});

describe('SkylineSegmentPool class', () => {
    it('acquires a fresh segment with zeroed fields', () => {
        const pool: SkylineSegmentPool = new SkylineSegmentPool();
        const a = pool.acquire();
        expect(a.xStart).toBe(0);
        expect(a.height).toBe(0);
    });

    it('reuses released segments before growing', () => {
        const pool: SkylineSegmentPool = new SkylineSegmentPool();
        const a = pool.acquire();
        a.xStart = 5;
        a.height = 7;
        pool.release(a);
        const b = pool.acquire();
        expect(b).toBe(a);
        expect(b.xStart).toBe(0);
        expect(b.height).toBe(0);
        expect(pool.grownCount).toBe(1);
    });
});

import type { SkylineSegment, SkylineSegmentPool } from '@coderline/alphatab/rendering/skyline/SkylineSegmentPool';

/**
 * Piecewise-constant step-function skyline used as a placement oracle.
 *
 * Heights are non-negative magnitudes measured outward from a reference edge
 * (the staff's top or bottom line). The Skyline itself owns no sign convention;
 * the caller chooses which Skyline instance (upSky / downSky) and translates
 * the returned magnitude into a signed coordinate in its own frame.
 *
 * Internal representation: sorted array of `SkylineSegment` records. Each
 * segments[i] covers `[segments[i].xStart, segments[i+1].xStart)` with
 * constant `height`. The final element is a sentinel at `xMax` with
 * `height = 0`.
 *
 * @internal
 */
export class Skyline {
    public readonly xMin: number;
    public readonly xMax: number;

    private readonly _pool: SkylineSegmentPool;
    private readonly _segments: SkylineSegment[] = [];

    public constructor(xMin: number, xMax: number, pool: SkylineSegmentPool) {
        this.xMin = xMin;
        this.xMax = xMax;
        this._pool = pool;
        this._initBaseline();
    }

    /** Number of segments excluding the trailing sentinel. Test / diagnostic surface. */
    public get segmentCount(): number {
        return this._segments.length - 1;
    }

    /**
     * Iterate each non-sentinel segment as a `(xStart, xEnd, height)` triple.
     * Diagnostic surface — zero-allocation, intended for visualization /
     * tracing of skyline state.
     */
    public forEachSegment(cb: (xStart: number, xEnd: number, height: number) => void): void {
        for (let k: number = 0; k < this._segments.length - 1; k = k + 1) {
            cb(this._segments[k].xStart, this._segments[k + 1].xStart, this._segments[k].height);
        }
    }

    /**
     * Smallest base y at which a rect (xStart - pad .. xEnd + pad) ×
     * (y .. y + intrinsicHeight) clears the current skyline state, with
     * `pad` vertical clearance applied to the returned y.
     *
     * The rect's outer edge sits at returned-y + intrinsicHeight.
     */
    public placeAbove(xStart: number, xEnd: number, _intrinsicHeight: number, pad: number): number {
        return this._maxHeightInRange(xStart - pad, xEnd + pad) + pad;
    }

    /** Same algorithm as `placeAbove`; the caller picks upSky vs downSky. */
    public placeBelow(xStart: number, xEnd: number, _intrinsicHeight: number, pad: number): number {
        return this._maxHeightInRange(xStart - pad, xEnd + pad) + pad;
    }

    /**
     * Raise the skyline within `(xStart - pad .. xEnd + pad)` to
     * `outerEdgeHeight` wherever the current height is lower. Splits
     * segments at the endpoints and merges adjacent equal-height segments
     * to keep the representation compact.
     */
    public insert(xStart: number, xEnd: number, outerEdgeHeight: number, pad: number): void {
        this._raiseRange(xStart - pad, xEnd + pad, outerEdgeHeight);
    }

    /**
     * For inter-staff gap (`this = staffA.downSky`; `other = staffB.upSky`):
     * returns max over the overlap range of `this.heightAt(x) + other.heightAt(x)`.
     * Both inputs are outward-magnitude skylines in opposing frames; the returned
     * value is the minimum distance needed between the two reference edges so the
     * two outlines do not collide. O(n + m).
     */
    public meshDistance(other: Skyline): number {
        const a: SkylineSegment[] = this._segments;
        const b: SkylineSegment[] = other._segments;
        let i: number = 0;
        let j: number = 0;
        let best: number = 0;
        while (i < a.length - 1 && j < b.length - 1) {
            const aStart: number = a[i].xStart;
            const aEnd: number = a[i + 1].xStart;
            const bStart: number = b[j].xStart;
            const bEnd: number = b[j + 1].xStart;
            const overlapStart: number = aStart > bStart ? aStart : bStart;
            const overlapEnd: number = aEnd < bEnd ? aEnd : bEnd;
            if (overlapStart < overlapEnd) {
                const sum: number = a[i].height + b[j].height;
                if (sum > best) {
                    best = sum;
                }
            }
            if (aEnd <= bEnd) {
                i = i + 1;
            } else {
                j = j + 1;
            }
        }
        return best;
    }

    /**
     * Raise this skyline to per-x max of itself and `other` (same direction
     * convention). Used to aggregate per-bar scalar envelopes into a seeded
     * system skyline. O(n + m).
     */
    public union(other: Skyline): void {
        const o: SkylineSegment[] = other._segments;
        for (let k: number = 0; k < o.length - 1; k = k + 1) {
            const segStart: number = o[k].xStart;
            const segEnd: number = o[k + 1].xStart;
            const h: number = o[k].height;
            if (h > 0) {
                this._raiseRange(segStart, segEnd, h);
            }
        }
    }

    /**
     * Maximum height across the half-open range `[xStart, xEnd)`. O(n).
     * Used by {@link EffectSystemPlacement} to read each renderer's
     * post-placement envelope from the staff-system skyline.
     */
    public maxHeightInRange(xStart: number, xEnd: number): number {
        return this._maxHeightInRange(xStart, xEnd);
    }

    /** Maximum height across the skyline's full x-range. O(n). */
    public maxHeight(): number {
        let best: number = 0;
        for (let k: number = 0; k < this._segments.length - 1; k = k + 1) {
            const h: number = this._segments[k].height;
            if (h > best) {
                best = h;
            }
        }
        return best;
    }

    /**
     * Release all intermediate segments back to the pool and rebuild the
     * two-segment baseline `(xMin, 0)` + sentinel `(xMax, 0)`. Required
     * before pool reuse.
     */
    public reset(): void {
        this._releaseAllInternal();
        this._initBaseline();
    }

    /**
     * Release ALL segments (including the baseline pair) back to the pool.
     * After this call the Skyline is empty and cannot be queried or inserted
     * into — the caller is expected to discard it.
     */
    public releaseAll(): void {
        this._releaseAllInternal();
    }

    private _releaseAllInternal(): void {
        while (this._segments.length > 0) {
            const s: SkylineSegment = this._segments.pop()!;
            this._pool.release(s);
        }
    }

    private _initBaseline(): void {
        const first: SkylineSegment = this._pool.acquire();
        first.xStart = this.xMin;
        first.height = 0;
        this._segments.push(first);
        const sentinel: SkylineSegment = this._pool.acquire();
        sentinel.xStart = this.xMax;
        sentinel.height = 0;
        this._segments.push(sentinel);
    }

    private _maxHeightInRange(xStart: number, xEnd: number): number {
        const lo: number = xStart > this.xMin ? xStart : this.xMin;
        const hi: number = xEnd < this.xMax ? xEnd : this.xMax;
        if (lo >= hi) {
            return 0;
        }
        let best: number = 0;
        for (let k: number = 0; k < this._segments.length - 1; k = k + 1) {
            const segStart: number = this._segments[k].xStart;
            const segEnd: number = this._segments[k + 1].xStart;
            if (segEnd <= lo) {
                continue;
            }
            if (segStart >= hi) {
                break;
            }
            const h: number = this._segments[k].height;
            if (h > best) {
                best = h;
            }
        }
        return best;
    }

    private _raiseRange(xStart: number, xEnd: number, newHeight: number): void {
        const lo: number = xStart > this.xMin ? xStart : this.xMin;
        const hi: number = xEnd < this.xMax ? xEnd : this.xMax;
        if (lo >= hi || newHeight <= 0) {
            return;
        }
        this._splitAt(lo);
        this._splitAt(hi);
        for (let k: number = 0; k < this._segments.length - 1; k = k + 1) {
            const segStart: number = this._segments[k].xStart;
            const segEnd: number = this._segments[k + 1].xStart;
            if (segEnd <= lo) {
                continue;
            }
            if (segStart >= hi) {
                break;
            }
            if (this._segments[k].height < newHeight) {
                this._segments[k].height = newHeight;
            }
        }
        this._mergeAdjacent();
    }

    private _splitAt(x: number): void {
        if (x <= this.xMin || x >= this.xMax) {
            return;
        }
        for (let k: number = 0; k < this._segments.length - 1; k = k + 1) {
            const segStart: number = this._segments[k].xStart;
            const segEnd: number = this._segments[k + 1].xStart;
            if (segStart === x) {
                return;
            }
            if (segStart < x && x < segEnd) {
                const newSeg: SkylineSegment = this._pool.acquire();
                newSeg.xStart = x;
                newSeg.height = this._segments[k].height;
                this._segments.splice(k + 1, 0, newSeg);
                return;
            }
        }
    }

    private _mergeAdjacent(): void {
        let k: number = 0;
        while (k < this._segments.length - 2) {
            if (this._segments[k].height === this._segments[k + 1].height) {
                const removed: SkylineSegment = this._segments.splice(k + 1, 1)[0];
                this._pool.release(removed);
            } else {
                k = k + 1;
            }
        }
    }
}

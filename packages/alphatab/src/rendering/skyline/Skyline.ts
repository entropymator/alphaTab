import type { SkylineSegment, SkylineSegmentPool } from '@coderline/alphatab/rendering/skyline/SkylineSegmentPool';

/**
 * Piecewise-constant step-function skyline used as a placement oracle.
 * Heights are non-negative magnitudes measured outward from a reference edge.
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

    public get segmentCount(): number {
        return this._segments.length - 1;
    }

    public forEachSegment(cb: (xStart: number, xEnd: number, height: number) => void): void {
        for (let k: number = 0; k < this._segments.length - 1; k = k + 1) {
            cb(this._segments[k].xStart, this._segments[k + 1].xStart, this._segments[k].height);
        }
    }

    public placeAbove(xStart: number, xEnd: number, _intrinsicHeight: number, pad: number): number {
        return this._maxHeightInRange(xStart, xEnd) + pad;
    }

    public placeBelow(xStart: number, xEnd: number, _intrinsicHeight: number, pad: number): number {
        return this._maxHeightInRange(xStart, xEnd) + pad;
    }

    public insert(xStart: number, xEnd: number, outerEdgeHeight: number, _pad: number): void {
        this._raiseRange(xStart, xEnd, outerEdgeHeight);
    }

    /** Inter-staff gap: max over the overlap range of `this.heightAt(x) + other.heightAt(x)`. */
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

    public maxHeightInRange(xStart: number, xEnd: number): number {
        return this._maxHeightInRange(xStart, xEnd);
    }

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

    public reset(): void {
        this._releaseAllInternal();
        this._initBaseline();
    }

    /** Releases the baseline too — the instance is unusable afterward. */
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

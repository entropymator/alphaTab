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

    /**
     * Index-based segment accessors. `segmentCount` returns the number of
     * non-sentinel segments; valid indices are `[0, segmentCount)`. These
     * exist so hot consumers can iterate without allocating a closure (as
     * `forEachSegment` does), which matters in transpile targets (C#/Kotlin)
     * where closures are not free. The sentinel segment at the tail is not
     * exposed.
     */
    public segmentXStart(i: number): number {
        return this._segments[i].xStart;
    }

    public segmentXEnd(i: number): number {
        return this._segments[i + 1].xStart;
    }

    public segmentHeight(i: number): number {
        return this._segments[i].height;
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
     * Unions every segment of `other` into `this`, shifted by `dx` on the
     * x-axis (i.e. each other-segment `[xs, xe)` contributes height `h` to
     * the range `[xs + dx, xe + dx)`). Clamps to `[xMin, xMax]`.
     *
     * Pair-merge implementation: walks `this._segments` and `other._segments`
     * in lockstep and emits a fresh segment list in O(s_this + s_other) time.
     * Each emitted segment's height is `max(thisH, otherH)` for that span;
     * adjacent equal-height pieces are coalesced inline so the result stays
     * in canonical form (no two consecutive segments with equal height). The
     * sentinel structure is preserved by appending a fresh sentinel at
     * `xMax` after the sweep. Old segments are returned to the pool.
     *
     * This replaces the previous "iterate other + raise per segment" path,
     * which was O(s_other * s_this) due to repeated split+raise on `this`.
     */
    public unionShifted(other: Skyline, dx: number): void {
        const o: SkylineSegment[] = other._segments;
        const oLast: number = o.length - 1; // sentinel index in other
        const xMin: number = this.xMin;
        const xMax: number = this.xMax;

        // Short-circuit: other entirely out of [xMin, xMax] after shifting.
        if (o[oLast].xStart + dx <= xMin || o[0].xStart + dx >= xMax) {
            return;
        }
        // Short-circuit: other has no positive-height segments at all.
        let hasContent: boolean = false;
        for (let k: number = 0; k < oLast; k = k + 1) {
            if (o[k].height > 0) {
                hasContent = true;
                break;
            }
        }
        if (!hasContent) {
            return;
        }

        const t: SkylineSegment[] = this._segments;
        const tLast: number = t.length - 1; // sentinel index in this

        const newSegs: SkylineSegment[] = [];

        let i: number = 0; // current segment index in this (active over [t[i].xStart, t[i+1].xStart))
        let j: number = 0; // current segment index in other

        // Skip other's segments that end at or before xMin.
        while (j < oLast && o[j + 1].xStart + dx <= xMin) {
            j = j + 1;
        }

        let x: number = xMin;
        while (x < xMax) {
            const thisH: number = i < tLast ? t[i].height : 0;
            let otherH: number = 0;
            if (j < oLast) {
                const oStart: number = o[j].xStart + dx;
                if (x >= oStart) {
                    otherH = o[j].height;
                }
            }
            const h: number = thisH > otherH ? thisH : otherH;

            // Find next breakpoint.
            let nextX: number = xMax;
            if (i < tLast) {
                const tNext: number = t[i + 1].xStart;
                if (tNext < nextX) {
                    nextX = tNext;
                }
            }
            if (j < oLast) {
                const oStart: number = o[j].xStart + dx;
                if (x < oStart) {
                    if (oStart < nextX) {
                        nextX = oStart;
                    }
                } else {
                    const oExit: number = o[j + 1].xStart + dx;
                    if (oExit < nextX) {
                        nextX = oExit;
                    }
                }
            }
            if (nextX > xMax) {
                nextX = xMax;
            }
            // Safety: guarantee forward progress. Should not trigger for
            // valid sorted inputs, but avoid an infinite loop on degenerate
            // (zero-width) inputs.
            if (nextX <= x) {
                nextX = xMax;
            }

            // Emit, coalescing adjacent equal-height pieces.
            if (newSegs.length > 0 && newSegs[newSegs.length - 1].height === h) {
                // skip — previous segment already covers up to nextX implicitly
            } else {
                const ns: SkylineSegment = this._pool.acquire();
                ns.xStart = x;
                ns.height = h;
                newSegs.push(ns);
            }

            x = nextX;

            // Advance i while its right edge is at or before x.
            while (i < tLast && t[i + 1].xStart <= x) {
                i = i + 1;
            }
            // Advance j similarly (shifted).
            while (j < oLast && o[j + 1].xStart + dx <= x) {
                j = j + 1;
            }
        }

        // Append sentinel at xMax.
        const sentinel: SkylineSegment = this._pool.acquire();
        sentinel.xStart = xMax;
        sentinel.height = 0;
        newSegs.push(sentinel);

        // Release old segments and swap in the new list.
        while (this._segments.length > 0) {
            const s: SkylineSegment = this._segments.pop()!;
            this._pool.release(s);
        }
        for (let k: number = 0; k < newSegs.length; k = k + 1) {
            this._segments.push(newSegs[k]);
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
        while (this._segments.length > 0) {
            const s: SkylineSegment = this._segments.pop()!;
            this._pool.release(s);
        }
        this._initBaseline();
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
        // Split at `lo`, capturing the index of the first segment in the
        // raised range. Splitting at `hi` then may shift `hi` indices but
        // never the `lo` index, so it is safe to keep `loIdx` afterwards.
        const loIdx: number = this._splitAt(lo);
        const hiIdx: number = this._splitAt(hi);
        // Raise heights over the half-open index range [loIdx, hiIdx).
        for (let i: number = loIdx; i < hiIdx; i = i + 1) {
            if (this._segments[i].height < newHeight) {
                this._segments[i].height = newHeight;
            }
        }
        // Merge only inside the touched window: any new same-height
        // adjacency can only appear at the boundary with the left
        // neighbour (loIdx-1 / loIdx), inside the raised range itself
        // (segments that were already >= newHeight stay distinct from
        // those that were raised to newHeight), or at the boundary with
        // the right neighbour (hiIdx-1 / hiIdx). Segments outside this
        // window are untouched and were already in canonical form.
        const mergeLo: number = loIdx > 0 ? loIdx - 1 : 0;
        // hiIdx is the index of the first segment AFTER the raised range.
        // We must consider the adjacency between hiIdx-1 and hiIdx, so
        // iterate up to and including hiIdx-1.
        let mergeIdx: number = mergeLo;
        let mergeEnd: number = hiIdx; // upper bound (inclusive) on left-of-pair index
        // Cap `mergeEnd` so we never look past the last non-sentinel segment.
        if (mergeEnd > this._segments.length - 2) {
            mergeEnd = this._segments.length - 2;
        }
        while (mergeIdx <= mergeEnd) {
            if (
                mergeIdx < this._segments.length - 2 &&
                this._segments[mergeIdx].height === this._segments[mergeIdx + 1].height
            ) {
                const removed: SkylineSegment = this._segments.splice(mergeIdx + 1, 1)[0];
                this._pool.release(removed);
                mergeEnd = mergeEnd - 1;
                // do not advance mergeIdx: re-check current index against the new neighbour
            } else {
                mergeIdx = mergeIdx + 1;
            }
        }
    }

    /**
     * Splits the skyline at `x` so that some segment afterwards has
     * `xStart === x`. Returns the index of that segment. If `x <= xMin`
     * the baseline (index 0) is returned. If `x >= xMax` the sentinel
     * index (`_segments.length - 1`) is returned.
     */
    private _splitAt(x: number): number {
        if (x <= this.xMin) {
            return 0;
        }
        if (x >= this.xMax) {
            return this._segments.length - 1;
        }
        // Binary search for the largest index k with segments[k].xStart <= x.
        // Segments are sorted strictly increasing by xStart.
        let lo: number = 0;
        let hi: number = this._segments.length - 1;
        while (lo < hi) {
            const mid: number = Math.floor((lo + hi + 1) / 2);
            if (this._segments[mid].xStart <= x) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        // Now segments[lo].xStart <= x < segments[lo+1].xStart.
        if (this._segments[lo].xStart === x) {
            return lo;
        }
        const newSeg: SkylineSegment = this._pool.acquire();
        newSeg.xStart = x;
        newSeg.height = this._segments[lo].height;
        this._segments.splice(lo + 1, 0, newSeg);
        return lo + 1;
    }
}

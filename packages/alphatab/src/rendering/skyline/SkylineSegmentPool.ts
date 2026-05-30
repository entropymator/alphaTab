/**
 * One segment of a piecewise-constant skyline step function. Pooled.
 *
 * A skyline owns a sorted array of these segments; each segment covers
 * `[segments[i].xStart, segments[i+1].xStart)` with constant `height`.
 * A sentinel final entry at `xMax` with `height = 0` terminates the range.
 *
 * @internal
 */
export class SkylineSegment {
    public xStart: number = 0;
    public height: number = 0;

    public reset(): void {
        this.xStart = 0;
        this.height = 0;
    }
}

/**
 * Freelist pool for SkylineSegment objects. The free list never shrinks —
 * acquire reuses a released segment if available, otherwise grows.
 *
 * @internal
 */
export class SkylineSegmentPool {
    private readonly _free: SkylineSegment[] = [];
    private _grown: number = 0;

    public acquire(): SkylineSegment {
        let s: SkylineSegment;
        if (this._free.length > 0) {
            s = this._free.pop()!;
        } else {
            s = new SkylineSegment();
            this._grown = this._grown + 1;
        }
        s.reset();
        return s;
    }

    public release(s: SkylineSegment): void {
        this._free.push(s);
    }

    public get grownCount(): number {
        return this._grown;
    }
}

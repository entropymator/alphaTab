/**
 * One segment of a piecewise-constant skyline. segment[i] covers
 * `[xStart, segments[i+1].xStart)`; final entry is a sentinel.
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

/** @internal */
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

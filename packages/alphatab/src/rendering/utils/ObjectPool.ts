/**
 * Objects participating in {@link ObjectPool} must implement this contract.
 * `reset()` is invoked at acquire-time (not release-time) so the hot path can
 * skip zeroing slots that get immediately re-acquired and overwritten.
 * @internal
 */
export interface IPoolable {
    reset(): void;
}

/**
 * Bump-allocator / arena-style object pool.
 *
 * - `acquire()` returns a previously-released object (O(1)), or grows by
 *   allocating one via the supplied factory.
 * - `release(obj)` returns a single object to the pool for reuse.
 * - `releaseAll()` is an O(1) reset of the entire pool: previously-acquired
 *   objects stay alive in the backing array and become available for reuse on
 *   the next `acquire()` cycle. This is the win for batch-allocated structures
 *   like the `BoundsLookup` tree that are entirely discarded between renders.
 *
 * Callers using fine-grained `release()` (e.g. `SkylineSegmentPool`) pair every
 * `acquire()` with a `release()`; callers using `releaseAll()` (e.g. the bounds
 * pools) acquire freely and reset at well-defined lifecycle boundaries.
 * @internal
 */
export class ObjectPool<T extends IPoolable> {
    private readonly _items: T[] = [];
    private readonly _recycled: T[] = [];
    private _cursor: number = 0;
    private _grown: number = 0;
    private readonly _factory: () => T;

    public constructor(factory: () => T) {
        this._factory = factory;
    }

    public acquire(): T {
        let obj: T;
        if (this._recycled.length > 0) {
            obj = this._recycled.pop()!;
        } else if (this._cursor < this._items.length) {
            obj = this._items[this._cursor];
            this._cursor++;
        } else {
            obj = this._factory();
            this._items.push(obj);
            this._cursor++;
            this._grown++;
        }
        obj.reset();
        return obj;
    }

    public release(obj: T): void {
        this._recycled.push(obj);
    }

    public releaseAll(): void {
        this._cursor = 0;
        // splice(0) rather than `.length = 0` for transpiler compatibility,
        // matching the precedent in EffectSystemPlacement.
        this._recycled.splice(0);
    }

    public get grownCount(): number {
        return this._grown;
    }
}

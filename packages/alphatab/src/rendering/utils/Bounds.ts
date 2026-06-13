import type { IPoolable } from '@coderline/alphatab/rendering/utils/ObjectPool';

/**
 * Represents a rectangular area within the renderer music notation.
 * @public
 */
export class Bounds implements IPoolable {
    /**
     * Gets or sets the X-position of the rectangle within the music notation.
     */
    public x: number;

    /**
     * Gets or sets the Y-position of the rectangle within the music notation.
     */
    public y: number;

    /**
     * Gets or sets the width of the rectangle.
     */
    public w: number;

    /**
     * Gets or sets the height of the rectangle.
     */
    public h: number;

    public scaleWith(scale: number) {
        this.x *= scale;
        this.y *= scale;
        this.w *= scale;
        this.h *= scale;
    }

    public constructor(x: number = 0, y: number = 0, w: number = 0, h: number = 0) {
        this.x = x;
        this.y = y;
        this.h = h;
        this.w = w;
    }

    /** @internal */
    public reset(): void {
        this.x = 0;
        this.y = 0;
        this.w = 0;
        this.h = 0;
    }
}

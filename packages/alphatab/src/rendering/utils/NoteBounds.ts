import type { Note } from '@coderline/alphatab/model/Note';
import type { BeatBounds } from '@coderline/alphatab/rendering/utils/BeatBounds';
import type { Bounds } from '@coderline/alphatab/rendering/utils/Bounds';
import type { IPoolable } from '@coderline/alphatab/rendering/utils/ObjectPool';

/**
 * Represents the bounds of a single note
 * @public
 */
export class NoteBounds implements IPoolable {
    /**
     * Gets or sets the reference to the beat boudns this note relates to.
     */
    public beatBounds!: BeatBounds;

    /**
     * Gets or sets the bounds of the individual note head.
     */
    public noteHeadBounds!: Bounds;

    /**
     * Gets or sets the note related to this instance.
     */
    public note!: Note;

    /**
     * Finishes the lookup object and optimizes itself for fast access.
     */
    public finish(scale: number = 1) {
        this.noteHeadBounds.scaleWith(scale);
    }

    /** @internal */
    public reset(): void {
        // Reference fields (beatBounds, noteHeadBounds, note) are always
        // reassigned by the caller before this NoteBounds is exposed via the
        // lookup; no clear needed.
    }
}

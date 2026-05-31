import type { Beat } from '@coderline/alphatab/model/Beat';
import type { NotationElement } from '@coderline/alphatab/NotationSettings';
import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';
import type { EffectBand } from '@coderline/alphatab/rendering/EffectBand';
import type { EffectBarGlyphSizing } from '@coderline/alphatab/rendering/EffectBarGlyphSizing';
import type { EffectGlyph } from '@coderline/alphatab/rendering/glyphs/EffectGlyph';
import type { Settings } from '@coderline/alphatab/Settings';

/**
 * Coarse placement category used by {@link EffectSystemPlacement} to
 * decide how far from the staff an effect band sits. Lower category =
 * placed first against the skyline = closer to the staff edge. Mirrors
 * Gould (Behind Bars p.118, 184, 484) and the engine-design priority
 * ordering: note-attached annotations sit closest, passage spans sit
 * above them, and system-level markers (tempo, rehearsal, section)
 * sit furthest out so they don't have to be displaced by other
 * material.
 * @internal
 */
export enum EffectBandPlacementCategory {
    /**
     * Note-attached annotations: articulations, fingerings, dynamics,
     * text labels, ornaments, pick strokes, fermatas, lyrics. Sit
     * closest to the staff (placed first).
     */
    NoteAttached = 0,
    /**
     * Passage-describing spans: vibrato, let-ring, palm-mute, trill,
     * whammy, crescendo / fade hairpins, ottava, sustain pedal,
     * rasgueado, barré. Sit above any note-attached annotations.
     */
    Span = 1,
    /**
     * System-level markers that conventionally float above all other
     * notation: tempo, rehearsal marks, section markers (D.C., D.S.,
     * Coda), free-time, alternate endings, chord symbols. Placed last
     * so they sit furthest from the staff.
     */
    SystemMarker = 2,
    /**
     * Text rows whose convention is to sit on a single y baseline that
     * runs parallel to the staff for the whole system (Gould p.300:
     * "A line of text should be parallel to the stave for the length
     * of the system"). Lyrics are the canonical case; chord symbols
     * and figured bass follow the same rule.
     *
     * Placement is grouped by {@link EffectInfo.effectId}: every band
     * sharing one id is aligned at the deepest magnitude needed across
     * the row's combined x-range, so per-bar envelope differences
     * (stem-down notes, dots, …) cannot stagger the text. Bands in this
     * category place AFTER all preceding categories so they clear any
     * note-attached / span / system-marker material in their column.
     */
    HorizontalRow = 3
}

/**
 * A classes inheriting from this base can provide the
 * data needed by a EffectBarRenderer to create effect glyphs dynamically.
 * @internal
 */
export abstract class EffectInfo {
    /**
     * Gets the unique effect name for this effect. (Used for grouping)
     */
    public get effectId(): string {
        return this.notationElement.toString();
    }

    /**
     * Gets the notation element that this effect represents. (Used for dynamic showing/hiding)
     */
    public abstract get notationElement(): NotationElement;

    /**
     * Gets a value indicating whether this effect glyphs
     * should only be added once on the first track if multiple tracks are rendered.
     * (Example: this allows to render the tempo changes only once)
     * @returns true if this effect bar should only be created once for the first track, otherwise false.
     */
    public abstract get hideOnMultiTrack(): boolean;

    /**
     * Checks whether the given beat has the appropriate effect set and
     * needs a glyph creation
     * @param settings
     * @param beat the beat storing the data
     * @returns true if the beat has the effect set, otherwise false.
     */
    public abstract shouldCreateGlyph(settings: Settings, beat: Beat): boolean;

    /**
     * Gets the sizing mode of the glyphs created by this info.
     * @returns the sizing mode to apply to the glyphs during layout
     */
    public abstract get sizingMode(): EffectBarGlyphSizing;

    /**
     * Creates a new effect glyph for the given beat.
     * @param renderer the renderer which requests for glyph creation
     * @param beat the beat storing the data
     * @returns the glyph which needs to be added to the renderer
     */
    public abstract createNewGlyph(renderer: BarRendererBase, beat: Beat): EffectGlyph;

    /**
     * Checks whether an effect glyph can be expanded to a particular beat.
     * @param from the beat which already has the glyph applied
     * @param to the beat which the glyph should get expanded to
     * @returns true if the glyph can be expanded, false if a new glyph needs to be created.
     */
    public abstract canExpand(from: Beat, to: Beat): boolean;

    /**
     * Coarse placement-band category. Default {@link
     * EffectBandPlacementCategory.NoteAttached} so unfamiliar / future
     * effect kinds land close to the staff (the safe default — they
     * cannot get visually buried under spans / markers without an
     * explicit override). Subclasses representing spans or system
     * markers override this getter.
     */
    public get placementCategory(): EffectBandPlacementCategory {
        return EffectBandPlacementCategory.NoteAttached;
    }

    /**
     * Override this method to finalize an effect band with all glyphs created.
     * Allows special layout logic like for whammys where we center-align the glyphs and size the band accordingly.
     * @param _band The band which is being finalized.
     */
    public finalizeBand(_band: EffectBand): void {}

    /**
     * Override this method when glyphs are for this effect is being re-aligned during resizing.
     * @param _band The band holding the glyph
     */
    public onAlignGlyphs(_band: EffectBand) {}
}

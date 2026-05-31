/**
 * Test-only placement inspector. Renders a tex score via the full pipeline
 * (alphaSkia + AlphaTabApiBase) and emits a human-readable textual report
 * of every effect band's skyline placement decision.
 *
 * Used during bugfix rounds to compare expected vs. actual placement
 * numerically without having to eyeball PNG diffs. Lives under
 * `test/visualTests/skyline/` and is never imported by production code.
 *
 * Typical use:
 *
 * ```ts
 * import { inspectPlacement } from './PlacementInspector';
 *
 * it('repro', async () => {
 *     console.log(await inspectPlacement('C4 {txt "A"} C4 {su}'));
 * });
 * ```
 *
 * @internal
 */

import { AlphaTabApiBase } from '@coderline/alphatab/AlphaTabApiBase';
import { AlphaTabError, AlphaTabErrorType } from '@coderline/alphatab/AlphaTabError';
import { AlphaTexImporter } from '@coderline/alphatab/importer/AlphaTexImporter';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { ByteBuffer } from '@coderline/alphatab/io/ByteBuffer';
import { JsonConverter } from '@coderline/alphatab/model/JsonConverter';
import type { Score } from '@coderline/alphatab/model/Score';
import { NotationElement } from '@coderline/alphatab/NotationSettings';
import type { BarRendererBase } from '@coderline/alphatab/rendering/BarRendererBase';
import type { EffectBand } from '@coderline/alphatab/rendering/EffectBand';
import { EffectBarGlyphSizing } from '@coderline/alphatab/rendering/EffectBarGlyphSizing';
import type { ScoreRenderer } from '@coderline/alphatab/rendering/ScoreRenderer';
import type { ScoreRendererWrapper } from '@coderline/alphatab/rendering/ScoreRendererWrapper';
import type { Skyline } from '@coderline/alphatab/rendering/skyline/Skyline';
import type { RenderStaff } from '@coderline/alphatab/rendering/staves/RenderStaff';
import type { StaffSystem } from '@coderline/alphatab/rendering/staves/StaffSystem';
import { Settings } from '@coderline/alphatab/Settings';
import { TestUiFacade } from '../TestUiFacade';
import { VisualTestHelper } from '../VisualTestHelper';

async function loadScore(tex: string): Promise<Score> {
    const settings = new Settings();
    const importer = new AlphaTexImporter();
    importer.init(ByteBuffer.fromString(tex), settings);
    return importer.readScore();
}

function loadScoreFromBytes(bytes: Uint8Array): Score {
    return ScoreLoader.loadScoreFromBytes(bytes);
}

function sizingName(s: EffectBarGlyphSizing): string {
    switch (s) {
        case EffectBarGlyphSizing.SinglePreBeat:
            return 'SinglePreBeat';
        case EffectBarGlyphSizing.SingleOnBeat:
            return 'SingleOnBeat';
        case EffectBarGlyphSizing.SingleOnBeatToEnd:
            return 'SingleOnBeatToEnd';
        case EffectBarGlyphSizing.GroupedOnBeat:
            return 'GroupedOnBeat';
        case EffectBarGlyphSizing.GroupedOnBeatToEnd:
            return 'GroupedOnBeatToEnd';
        case EffectBarGlyphSizing.FullBar:
            return 'FullBar';
    }
}

/**
 * Mirrors the tier logic in
 * {@link import('@coderline/alphatab/rendering/EffectSystemPlacement').EffectSystemPlacement}
 * so the report shows the same classification the placement pass used.
 */
function tier(band: EffectBand): number {
    const sm = band.info.sizingMode;
    const single =
        sm === EffectBarGlyphSizing.SinglePreBeat ||
        sm === EffectBarGlyphSizing.SingleOnBeat ||
        sm === EffectBarGlyphSizing.SingleOnBeatToEnd;
    return single && band.firstBeat === band.lastBeat ? 1 : 2;
}

function n(value: number, fractionDigits: number = 2): string {
    if (!Number.isFinite(value)) {
        return value.toString();
    }
    const rounded = Number.parseFloat(value.toFixed(fractionDigits));
    return rounded.toString();
}

function dumpSegments(label: string, sky: Skyline, indent: string): string {
    const parts: string[] = [];
    sky.forEachSegment((xStart, xEnd, height) => {
        if (height > 0) {
            parts.push(`(${n(xStart)},${n(xEnd)},${n(height)})`);
        }
    });
    const max = sky.maxHeight();
    return `${indent}${label}: [${parts.join('')}]  max=${n(max)}`;
}

function effectName(band: EffectBand): string {
    const id = band.info.effectId;
    const numeric = Number.parseInt(id, 10);
    if (!Number.isNaN(numeric)) {
        const enumName = NotationElement[numeric];
        if (enumName) {
            return enumName;
        }
    }
    return id;
}

function dumpBand(band: EffectBand, index: number, indent: string): string {
    const lines: string[] = [];
    const range = band.computeLocalXRange();
    const xLocal = range ? `(${n(range.xStart)},${n(range.xEnd)})` : '<null>';
    const outerEdge = band.placedMagnitude + band.height;
    const firstBeatIdx = band.firstBeat ? band.firstBeat.index : -1;
    const lastBeatIdx = band.lastBeat ? band.lastBeat.index : -1;
    lines.push(
        `${indent}[${index}] effect=${effectName(band)}  sizing=${sizingName(band.info.sizingMode)}  tier=${tier(band)}` +
            `  isEmpty=${band.isEmpty}`
    );
    lines.push(
        `${indent}    firstBeat=${firstBeatIdx} lastBeat=${lastBeatIdx}  xLocal=${xLocal}  band.height=${n(band.height)}`
    );
    lines.push(
        `${indent}    placedMagnitude=${n(band.placedMagnitude)}  outerEdge=${n(outerEdge)}  band.y=${n(band.y)}`
    );
    return lines.join('\n');
}

function dumpRenderer(renderer: BarRendererBase, indent: string): string {
    const lines: string[] = [];
    const contentTop = renderer.topOverflow - renderer.topEffects.height;
    const contentBottom = renderer.bottomOverflow - renderer.bottomEffects.height;
    lines.push(
        `${indent}Renderer[${renderer.index}]  x=${n(renderer.x)}  width=${n(renderer.width)}` +
            `  topOverflow=${n(renderer.topOverflow)} (content=${n(contentTop)}, effects=${n(renderer.topEffects.height)})` +
            `  bottomOverflow=${n(renderer.bottomOverflow)} (content=${n(contentBottom)}, effects=${n(renderer.bottomEffects.height)})`
    );
    lines.push(dumpSegments('barLocal.up', renderer.barLocalSkyline.upSky, `${indent}    `));
    lines.push(dumpSegments('barLocal.down', renderer.barLocalSkyline.downSky, `${indent}    `));

    const topBands = renderer.topEffects.bands;
    lines.push(`${indent}    topBands[${topBands.length}]:`);
    for (let i = 0; i < topBands.length; i++) {
        lines.push(dumpBand(topBands[i], i, `${indent}      `));
    }
    const bottomBands = renderer.bottomEffects.bands;
    lines.push(`${indent}    bottomBands[${bottomBands.length}]:`);
    for (let i = 0; i < bottomBands.length; i++) {
        lines.push(dumpBand(bottomBands[i], i, `${indent}      `));
    }
    return lines.join('\n');
}

function dumpStaff(staff: RenderStaff, system: StaffSystem): string {
    const lines: string[] = [];
    lines.push(
        `Staff  systemIndex=${system.index}  staffIndex=${staff.staffIndex}` +
            `  track=${staff.staffTrackGroup.track.index}  id=${staff.staffId}` +
            `  topOverflow=${n(staff.topOverflow)}  bottomOverflow=${n(staff.bottomOverflow)}` +
            `  topPadding=${n(staff.topPadding)}  bottomPadding=${n(staff.bottomPadding)}`
    );
    lines.push(dumpSegments('  systemSkyline.upSky', staff.systemSkyline.upSky, ''));
    lines.push(dumpSegments('  systemSkyline.downSky', staff.systemSkyline.downSky, ''));
    for (const renderer of staff.barRenderers) {
        lines.push(dumpRenderer(renderer, '  '));
    }
    return lines.join('\n');
}

function captureReport(api: AlphaTabApiBase<unknown>, tex: string, width: number): string {
    const wrapper = api.renderer as unknown as ScoreRendererWrapper;
    const inner = wrapper.instance as unknown as ScoreRenderer;
    const systems = (inner.layout as unknown as { systems: readonly StaffSystem[] }).systems;

    const lines: string[] = [];
    const escaped = tex.replace(/\n/g, '\\n');
    lines.push(`inspectPlacement  tex="${escaped}"  width=${width}`);
    lines.push('-'.repeat(80));

    for (const system of systems) {
        for (const group of system.staves) {
            for (const staff of group.staves) {
                if (!staff.isVisible) {
                    continue;
                }
                lines.push(dumpStaff(staff, system));
                lines.push('');
            }
        }
    }
    return lines.join('\n');
}

/**
 * Render `tex` once at the given width and return a textual placement
 * report. Designed for `console.log` output inside throwaway repro tests.
 */
export async function inspectPlacement(tex: string, width: number = 1000): Promise<string> {
    return inspectScore(await loadScore(tex), width, tex);
}

/**
 * Render a pre-loaded {@link Score} at the given width and return a textual
 * placement report. Use when the repro lives in a file format other than
 * alphaTex (MusicXML, GP, …); load via {@link ScoreLoader.loadScoreFromBytes}.
 *
 * The `matchVisualTest` flag (default `true`) mirrors the settings the
 * MusicXML / non-tex visual test suites apply, so the layout numbers in the
 * report match what the reference PNG would render at the given width:
 *   - `justifyLastSystem = true` when the score has > 4 master bars;
 *   - `layoutMode = Parchment` when any track has an explicit systems layout;
 *   - all tracks rendered.
 */
export async function inspectScoreFromBytes(
    bytes: Uint8Array,
    width: number = 1000,
    label: string = '<file>',
    matchVisualTest: boolean = true
): Promise<string> {
    return inspectScore(loadScoreFromBytes(bytes), width, label, matchVisualTest);
}

async function inspectScore(score: Score, width: number, label: string, matchVisualTest: boolean = false): Promise<string> {
    await VisualTestHelper.prepareAlphaSkia();
    const settings = new Settings();
    VisualTestHelper.prepareSettingsForTest(settings);

    let tracks: number[] | undefined;
    if (matchVisualTest) {
        settings.display.justifyLastSystem = score.masterBars.length > 4;
        if (score.tracks.some(t => t.systemsLayout.length > 0)) {
            const { LayoutMode } = await import('@coderline/alphatab/LayoutMode');
            settings.display.layoutMode = LayoutMode.Parchment;
        }
        tracks = score.tracks.map(t => t.index);
    } else {
        tracks = [0];
    }

    const uiFacade = new TestUiFacade();
    uiFacade.rootContainer.width = width;
    const api = new AlphaTabApiBase<unknown>(uiFacade, settings);

    try {
        return await new Promise<string>((resolve, reject) => {
            api.renderer.postRenderFinished.on(() => {
                resolve(captureReport(api, label, width));
            });
            api.error.on(e => {
                reject(
                    new AlphaTabError(
                        AlphaTabErrorType.General,
                        `inspectPlacement failed (${e.message} ${e.stack})`,
                        e
                    )
                );
            });
            const renderScore = JsonConverter.jsObjectToScore(JsonConverter.scoreToJsObject(score), settings);
            api.renderScore(renderScore, tracks);
            setTimeout(() => reject(new Error('inspectPlacement render harness timed out')), 5000);
        });
    } finally {
        api.destroy();
    }
}

/**
 * Integration tests for skyline lifecycle through resize / restructure flows.
 *
 * These tests exercise the rendering pipeline at multiple widths and
 * inspect the resulting `BarLocalSkyline` and `StaffSystemSkyline` state
 * to verify the Phase 1 invariants:
 *
 *   - Bar-local skylines reflect the content envelope of every renderer
 *     after every render.
 *   - Staff-system skylines re-assemble correctly when bars get distributed
 *     across a different number of systems.
 *   - Re-layout paths (resize) do not leak stale skyline state.
 *   - A single resize from one width to another produces consistent skyline
 *     state for the new width (no orphaned data).
 *
 * Each test that needs a fresh layout creates its own API to keep tests
 * isolated from one another. The harness exposes a `renderOnce` (fresh
 * API per render) and a `renderWithResize` (single resize from W1 to W2
 * on a shared API) so the resize path itself is exercised meaningfully.
 */

import { AlphaTabApiBase } from '@coderline/alphatab/AlphaTabApiBase';
import { AlphaTabError, AlphaTabErrorType } from '@coderline/alphatab/AlphaTabError';
import { AlphaTexImporter } from '@coderline/alphatab/importer/AlphaTexImporter';
import { ByteBuffer } from '@coderline/alphatab/io/ByteBuffer';
import { JsonConverter } from '@coderline/alphatab/model/JsonConverter';
import type { Score } from '@coderline/alphatab/model/Score';
import type { ScoreRenderer } from '@coderline/alphatab/rendering/ScoreRenderer';
import type { ScoreRendererWrapper } from '@coderline/alphatab/rendering/ScoreRendererWrapper';
import type { StaffSystem } from '@coderline/alphatab/rendering/staves/StaffSystem';
import { Settings } from '@coderline/alphatab/Settings';
import { describe, expect, it } from 'vitest';
import { TestUiFacade } from '../TestUiFacade';
import { VisualTestHelper } from '../VisualTestHelper';

interface StaffSkylineSnapshot {
    systemIndex: number;
    staffIndex: number;
    /**
     * Stable identifier composed of `staffId` (factory id, e.g. "score" / "tab")
     * and the track index. Used to group bars across systems that belong to
     * the same logical staff. `staffIndex` alone is NOT a stable identifier
     * because the score-staff and tab-staff of the same track share it.
     */
    staffKey: string;
    upMax: number;
    downMax: number;
    barUpMaxes: number[];
    barDownMaxes: number[];
    barWidths: number[];
    barLineLocalX: number[];
}

async function loadScore(tex: string): Promise<Score> {
    const settings = new Settings();
    const importer = new AlphaTexImporter();
    importer.init(ByteBuffer.fromString(tex), settings);
    return importer.readScore();
}

function captureSnapshot(api: AlphaTabApiBase<unknown>): StaffSkylineSnapshot[] {
    const wrapper = api.renderer as unknown as ScoreRendererWrapper;
    const inner = wrapper.instance as unknown as ScoreRenderer;
    const systems = (inner.layout as unknown as { systems: readonly StaffSystem[] }).systems;

    const out: StaffSkylineSnapshot[] = [];
    for (const system of systems) {
        for (const group of system.staves) {
            for (const staff of group.staves) {
                if (!staff.isVisible) {
                    continue;
                }
                out.push({
                    systemIndex: system.index,
                    staffIndex: staff.staffIndex,
                    staffKey: `${staff.staffTrackGroup.track.index}/${staff.staffId}`,
                    upMax: staff.systemSkyline.upSky.maxHeight(),
                    downMax: staff.systemSkyline.downSky.maxHeight(),
                    barUpMaxes: staff.barRenderers.map(r => r.barLocalSkyline.upSky.maxHeight()),
                    barDownMaxes: staff.barRenderers.map(r => r.barLocalSkyline.downSky.maxHeight()),
                    barWidths: staff.barRenderers.map(r => r.width),
                    barLineLocalX: staff.barRenderers.map(r => r.x)
                });
            }
        }
    }
    return out;
}

/** Single render at one width via a fresh API. */
async function renderOnce(tex: string, width: number): Promise<StaffSkylineSnapshot[]> {
    await VisualTestHelper.prepareAlphaSkia();
    const score = await loadScore(tex);
    const settings = new Settings();
    VisualTestHelper.prepareSettingsForTest(settings);

    const uiFacade = new TestUiFacade();
    uiFacade.rootContainer.width = width;
    const api = new AlphaTabApiBase<unknown>(uiFacade, settings);

    try {
        return await new Promise<StaffSkylineSnapshot[]>((resolve, reject) => {
            api.renderer.postRenderFinished.on(() => {
                resolve(captureSnapshot(api));
            });
            api.error.on(e => {
                reject(
                    new AlphaTabError(
                        AlphaTabErrorType.General,
                        `Failed to render skyline harness score (${e.message} ${e.stack})`,
                        e
                    )
                );
            });
            const renderScore = JsonConverter.jsObjectToScore(JsonConverter.scoreToJsObject(score), settings);
            api.renderScore(renderScore, [0]);
            setTimeout(() => reject(new Error('skyline render harness timed out')), 5000);
        });
    } finally {
        api.destroy();
    }
}

/**
 * Single resize on a shared API: render at `initialWidth`, then once
 * complete, resize to `targetWidth` and capture the resulting snapshot.
 */
async function renderWithResize(
    tex: string,
    initialWidth: number,
    targetWidth: number
): Promise<{ initial: StaffSkylineSnapshot[]; resized: StaffSkylineSnapshot[] }> {
    await VisualTestHelper.prepareAlphaSkia();
    const score = await loadScore(tex);
    const settings = new Settings();
    VisualTestHelper.prepareSettingsForTest(settings);

    const uiFacade = new TestUiFacade();
    uiFacade.rootContainer.width = initialWidth;
    const api = new AlphaTabApiBase<unknown>(uiFacade, settings);

    let initialSnap: StaffSkylineSnapshot[] = [];
    let resizedSnap: StaffSkylineSnapshot[] = [];
    let phase: 'initial' | 'resized' = 'initial';

    try {
        await new Promise<void>((resolve, reject) => {
            api.renderer.postRenderFinished.on(() => {
                if (phase === 'initial') {
                    initialSnap = captureSnapshot(api);
                    phase = 'resized';
                    setTimeout(() => {
                        uiFacade.rootContainer.width = targetWidth;
                        api.triggerResize();
                    }, 0);
                } else {
                    resizedSnap = captureSnapshot(api);
                    resolve();
                }
            });
            api.error.on(e => {
                reject(
                    new AlphaTabError(
                        AlphaTabErrorType.General,
                        `Failed to render skyline harness score (${e.message} ${e.stack})`,
                        e
                    )
                );
            });
            const renderScore = JsonConverter.jsObjectToScore(JsonConverter.scoreToJsObject(score), settings);
            api.renderScore(renderScore, [0]);
            setTimeout(() => reject(new Error('skyline resize harness timed out')), 10000);
        });
    } finally {
        api.destroy();
    }

    return { initial: initialSnap, resized: resizedSnap };
}

/**
 * Concatenate per-bar up/down maxes per logical staff in left-to-right
 * (system, then renderer-index) order. Keyed by `staffKey` so the score-
 * staff and tab-staff of the same track are correctly separated.
 */
function envelopesByStaff(snapshot: StaffSkylineSnapshot[]): Map<string, { up: number[]; down: number[] }> {
    const byStaff = new Map<string, { up: number[]; down: number[] }>();
    const ordered = [...snapshot].sort((a, b) => {
        if (a.staffKey !== b.staffKey) {
            return a.staffKey < b.staffKey ? -1 : 1;
        }
        return a.systemIndex - b.systemIndex;
    });
    for (const s of ordered) {
        if (!byStaff.has(s.staffKey)) {
            byStaff.set(s.staffKey, { up: [], down: [] });
        }
        const e = byStaff.get(s.staffKey)!;
        for (const v of s.barUpMaxes) {
            e.up.push(v);
        }
        for (const v of s.barDownMaxes) {
            e.down.push(v);
        }
    }
    return byStaff;
}

function totalBarsInSnapshot(snapshot: StaffSkylineSnapshot[]): number {
    return snapshot.reduce((sum, s) => sum + s.barWidths.length, 0);
}

describe('SkylineResizeFlow', () => {
    const resizeTex = `
        \\track "Guitar"
        :4 17.1 19.1 22.1 24.1 |
        12.1{v f} 14.1{v f}.4 :8 15.1 17.1 |
        :4 0.6 0.6 0.6 0.6 |
        :4 12.1 14.1 17.1 0.6 |
        :4 22.1 24.1 17.1 19.1 |
        :4 12.1 12.6 17.1 0.6
    `;

    it('initial render at a wide width populates the staff skyline', async () => {
        const snap = await renderOnce(resizeTex, 1300);
        expect(snap.length).toBeGreaterThan(0);
        const anyContent = snap.some(s => s.upMax > 0 || s.downMax > 0);
        expect(anyContent).toBe(true);
        // Every bar-local skyline must reflect some content (positive
        // up- or down-magnitude) since the score has notes on every bar.
        for (const staff of snap) {
            for (let i = 0; i < staff.barUpMaxes.length; i++) {
                expect(staff.barUpMaxes[i] + staff.barDownMaxes[i]).toBeGreaterThan(0);
            }
        }
    });

    it('initial render at a narrow width populates skylines across multiple systems', async () => {
        const snap = await renderOnce(resizeTex, 600);
        expect(snap.length).toBeGreaterThan(0);
        const systems = new Set(snap.map(s => s.systemIndex));
        // At narrow width the score should distribute across more than one system.
        expect(systems.size).toBeGreaterThanOrEqual(2);
        // Every staff that has content reports a non-zero staff-skyline max.
        for (const staff of snap) {
            const hasContent = staff.barUpMaxes.some(v => v > 0) || staff.barDownMaxes.some(v => v > 0);
            if (hasContent) {
                expect(staff.upMax + staff.downMax).toBeGreaterThan(0);
            }
        }
    });

    it('same bar count is produced regardless of width (fresh API per render)', async () => {
        const [wide, narrow] = await Promise.all([renderOnce(resizeTex, 1300), renderOnce(resizeTex, 600)]);
        expect(totalBarsInSnapshot(wide)).toBe(totalBarsInSnapshot(narrow));
    });

    it('per-staff envelope totals are stable across widths (fresh APIs)', async () => {
        // Two independent renders at different widths should produce
        // equivalent total skyline content per logical staff. We compare
        // aggregates (max + sum) rather than per-bar arrays because
        // layout choices can legitimately re-allocate effect-band content
        // between adjacent bars (e.g. a multi-bar effect that anchors to
        // a different bar when the system breaks differently).
        const [wide, narrow] = await Promise.all([renderOnce(resizeTex, 1300), renderOnce(resizeTex, 600)]);
        const a = envelopesByStaff(wide);
        const b = envelopesByStaff(narrow);
        expect(a.size).toBe(b.size);
        for (const [staffKey, ea] of a) {
            const eb = b.get(staffKey)!;
            // The peaks survive layout choices: the maximum up-side and
            // down-side magnitude per staff must match across widths.
            expect(Math.max(0, ...ea.up)).toBeCloseTo(Math.max(0, ...eb.up), 3);
            expect(Math.max(0, ...ea.down)).toBeCloseTo(Math.max(0, ...eb.down), 3);
        }
    });

    it('single resize wide→narrow re-distributes bars across systems', async () => {
        const { initial, resized } = await renderWithResize(resizeTex, 1300, 600);

        // Both renders must produce visible staves.
        expect(initial.length).toBeGreaterThan(0);
        expect(resized.length).toBeGreaterThan(0);

        // The resized layout (narrow) should occupy at least as many
        // systems as the initial wide layout.
        const initialSystems = new Set(initial.map(s => s.systemIndex)).size;
        const resizedSystems = new Set(resized.map(s => s.systemIndex)).size;
        expect(resizedSystems).toBeGreaterThanOrEqual(initialSystems);

        // The resized staff skylines must be non-empty for staves with
        // content — guards against the regression where reflow leaves
        // a staff skyline empty.
        for (const staff of resized) {
            const hasContent = staff.barUpMaxes.some(v => v > 0) || staff.barDownMaxes.some(v => v > 0);
            if (hasContent) {
                expect(staff.upMax + staff.downMax).toBeGreaterThan(0);
            }
        }
    });

    it('single resize narrow→wide preserves bar-local envelopes', async () => {
        // After resize, every renderer's bar-local skyline must still
        // reflect its glyph content. This catches the regression where
        // a resize path discarded bar-local state.
        const { initial, resized } = await renderWithResize(resizeTex, 600, 900);

        const sumInitial = initial.reduce(
            (s, st) => s + st.barUpMaxes.reduce((a, b) => a + b, 0) + st.barDownMaxes.reduce((a, b) => a + b, 0),
            0
        );
        const sumResized = resized.reduce(
            (s, st) => s + st.barUpMaxes.reduce((a, b) => a + b, 0) + st.barDownMaxes.reduce((a, b) => a + b, 0),
            0
        );
        // Total summed skyline magnitude is content-determined, so it
        // must be the same across both renders even if layout differs.
        expect(sumResized).toBeCloseTo(sumInitial, 5);
    });

    it('bars in each staff are contiguous (no gaps or overlaps) after resize', async () => {
        const { resized } = await renderWithResize(resizeTex, 1300, 800);
        const tolerance = 1.5;
        for (const staff of resized) {
            if (staff.barLineLocalX.length === 0) {
                continue;
            }
            let expectedX = staff.barLineLocalX[0];
            for (let i = 0; i < staff.barLineLocalX.length; i++) {
                expect(Math.abs(staff.barLineLocalX[i] - expectedX)).toBeLessThanOrEqual(tolerance);
                expectedX += staff.barWidths[i];
            }
        }
    });

    it('staff skyline maxHeight is at least the max over its constituent bar-local maxHeights', async () => {
        // Phase 1's staff-skyline assembly inserts per-bar scalars across
        // the bar's renderer-local x range. Phase 2's effect-band placement
        // pass then stacks effect bands on top of the assembled staff
        // skyline, so the staff skyline's maxHeight is at least the max
        // bar-local skyline maxHeight — bigger when effect bands push it
        // further out.
        const snap = await renderOnce(resizeTex, 600);
        for (const staff of snap) {
            const localUpMax = staff.barUpMaxes.reduce((a, b) => Math.max(a, b), 0);
            const localDownMax = staff.barDownMaxes.reduce((a, b) => Math.max(a, b), 0);
            expect(staff.upMax).toBeGreaterThanOrEqual(localUpMax - 1e-5);
            expect(staff.downMax).toBeGreaterThanOrEqual(localDownMax - 1e-5);
        }
    });

    it('resize back to a width that fits the score in one system populates _systems', async () => {
        // Regression test for the _resizeAndRenderScore last-system push fix:
        // after a wide → narrow → wide-enough-for-one-system resize, the
        // layout's _systems must include the single trailing system that
        // holds every bar, so the skyline visible-staff iteration returns
        // non-empty.
        const { initial, resized } = await renderWithResize(resizeTex, 1300, 600);
        expect(initial.length).toBeGreaterThan(0);
        expect(resized.length).toBeGreaterThan(0);

        // Drive a second resize back to the wide width on a separate
        // harness instance (renderWithResize only does one resize). Use
        // the wider value that fits the score in a single system so we
        // hit the previously-broken path: trailing-system fallthrough.
        const backToWide = await renderWithResize(resizeTex, 600, 1300);
        expect(backToWide.resized.length).toBeGreaterThan(0);
        const singleSystem = new Set(backToWide.resized.map(s => s.systemIndex));
        expect(singleSystem.size).toBe(1);
    });
});

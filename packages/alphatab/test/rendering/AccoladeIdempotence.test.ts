/**
 * §H Step 1c sentinel — `_calculateAccoladeSpacing` idempotency.
 *
 * After v5 Step 1c, the `_accoladeSpacingCalculated` first-call gate is gone
 * and `_calculateAccoladeSpacing` may be invoked at every `addBars` /
 * `revertLastBar`. The contract: the accolade contribution to `system.width`
 * must be applied exactly once per cycle, never accumulated across calls.
 *
 * This test drives a multi-bar single-system score through the full renderer
 * and asserts that the accolade contribution to `system.width` matches what a
 * single accolade application would produce (catches `+=` regressions on
 * `system.width` / `system.computedWidth` / `system.accoladeWidth`).
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
import { TestUiFacade } from '../visualTests/TestUiFacade';
import { VisualTestHelper } from '../visualTests/VisualTestHelper';

/**
 * @record
 * @internal
 */
interface SystemMetrics {
    accoladeWidth: number;
    width: number;
    computedWidth: number;
    barWidths: number[];
}

/**
 * @record
 * @internal
 */
interface ScoreLayoutInternals {
    systems: readonly StaffSystem[];
}

/**
 * @internal
 */
class AccoladeIdempotenceHelper {
    public static async loadScore(tex: string): Promise<Score> {
        const settings = new Settings();
        const importer = new AlphaTexImporter();
        importer.init(ByteBuffer.fromString(tex), settings);
        return importer.readScore();
    }

    public static async renderAndCaptureSystem0(tex: string, width: number): Promise<SystemMetrics> {
        await VisualTestHelper.prepareAlphaSkia();
        const score = await AccoladeIdempotenceHelper.loadScore(tex);
        const settings = new Settings();
        VisualTestHelper.prepareSettingsForTest(settings);

        const uiFacade = new TestUiFacade();
        uiFacade.rootContainer.width = width;
        const api = new AlphaTabApiBase<unknown>(uiFacade, settings);

        try {
            return await new Promise<SystemMetrics>((resolve, reject) => {
                api.renderer.postRenderFinished.on(() => {
                    const wrapper = api.renderer as unknown as ScoreRendererWrapper;
                    const inner = wrapper.instance as unknown as ScoreRenderer;
                    const systems = (inner.layout as unknown as ScoreLayoutInternals).systems;
                    if (systems.length === 0) {
                        reject(new Error('expected at least one system'));
                        return;
                    }
                    const s = systems[0];
                    const firstStaffGroup = s.staves[0];
                    const firstStaff = firstStaffGroup.staves[0];
                    resolve({
                        accoladeWidth: s.accoladeWidth,
                        width: s.width,
                        computedWidth: s.computedWidth,
                        barWidths: firstStaff.barRenderers.map(r => r.width)
                    });
                });
                api.error.on(e => {
                    reject(
                        new AlphaTabError(
                            AlphaTabErrorType.General,
                            `Failed to render score (${e.message} ${e.stack})`,
                            e
                        )
                    );
                });
                const renderScore = JsonConverter.jsObjectToScore(JsonConverter.scoreToJsObject(score), settings);
                api.renderScore(renderScore, [0]);
                setTimeout(() => reject(new Error('render timed out')), 5000);
            });
        } finally {
            api.destroy();
        }
    }
}

describe('AccoladeIdempotence', () => {
    it('§H Step 1c: accolade contribution applied exactly once for a multi-bar single-system score', async () => {
        // Five identical-content bars on a single staff. Render width is large enough
        // to keep them all on one system (no wrap, no revert). With stable visibility
        // the accolade contribution should be added exactly once, regardless of how
        // many times `_calculateAccoladeSpacing` is invoked during system assembly.
        const tex = `
            \\track "T1"
            \\staff {score}
            C4.4 *4 | C4.4 *4 | C4.4 *4 | C4.4 *4 | C4.4 *4
        `;

        const metrics = await AccoladeIdempotenceHelper.renderAndCaptureSystem0(tex, 3000);

        expect(metrics.barWidths.length).toBe(5);
        expect(metrics.accoladeWidth).toBeGreaterThanOrEqual(0);

        // The accolade contribution to system.width is exactly the once-applied
        // accoladeWidth. A `+=` regression would inflate the difference by
        // (N-1) × accoladeWidth.
        const sumBarWidths = metrics.barWidths.reduce((a, b) => a + b, 0);
        const accoladePortion = metrics.width - sumBarWidths;
        expect(accoladePortion).toBeCloseTo(metrics.accoladeWidth, 1);

        // computedWidth has the same contract.
        const computedAccoladePortion = metrics.computedWidth - sumBarWidths;
        expect(computedAccoladePortion).toBeCloseTo(metrics.accoladeWidth, 1);
    });

    it('§H Step 1c: accolade contribution stable across renders with same inputs', async () => {
        // Idempotency across complete renders: same score + same width → same
        // accolade. This catches a different regression class than the per-render
        // sentinel above: cross-render bleed via cache or state retention.
        const tex = `
            \\track "T1"
            \\staff {score}
            C4.4 *4 | C4.4 *4 | C4.4 *4
        `;

        const first = await AccoladeIdempotenceHelper.renderAndCaptureSystem0(tex, 3000);
        const second = await AccoladeIdempotenceHelper.renderAndCaptureSystem0(tex, 3000);

        expect(second.accoladeWidth).toBe(first.accoladeWidth);
        expect(second.width).toBe(first.width);
        expect(second.computedWidth).toBe(first.computedWidth);
    });
});

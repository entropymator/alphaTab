/**
 * Smoke test + live usage example for the {@link PlacementInspector}.
 *
 * The first case runs the inspector and logs the report — point this at
 * any tex string that exhibits a placement bug to get a numeric snapshot
 * of every band's placed magnitude / band.y / skyline state.
 *
 * The second case is a regression guard: it parses the report and asserts
 * the inspector keeps emitting the structural fields the bugfix workflow
 * depends on. If the harness drifts (renames, missing fields, ...) this
 * fails loudly before the next bugfix round starts.
 */

import { describe, expect, it } from 'vitest';
import { inspectPlacement } from './PlacementInspector';

describe('PlacementInspector', () => {
    it('renders a report for the lyrics placement repro case', async () => {
        const tex = `\\hidedynamics
E5 {lyrics "A"}
D5 {lyrics "A"}
B4 {lyrics "A"}
|
r.4
D5 {lyrics "A"}`;
        const report = await inspectPlacement(tex);
        console.log(`\n${report}\n`);
        expect(report).toContain('inspectPlacement  tex=');
    });

    it.skip('renders a report for the slur+trill repro case', async () => {
        const tex = `\\ts (6 8)
      E5{slur s0}.4
      Gb5{acc #}.16
      G5{tr (81 32) slur s0}.16
      B5.8{gr onbeat}
      A5.4{d}
      G5.16{gr onbeat}
      A5.16{gr onbeat}
      |`;
        const report = await inspectPlacement(tex);
        console.log(`\n${report}\n`);
        expect(report).toContain('inspectPlacement  tex=');
    });

    it('emits the structural fields the bugfix workflow depends on', async () => {
        const report = await inspectPlacement('\\tempo 120 . C4 {txt "A"} C4');
        // Each of these tokens is a contract with the inspector format —
        // bugfix rounds grep through the output for them.
        for (const token of [
            'topOverflow=',
            'bottomOverflow=',
            'systemSkyline.upSky',
            'systemSkyline.downSky',
            'Renderer[0]',
            'barLocal.up',
            'barLocal.down',
            'topBands[',
            'bottomBands[',
            'placedMagnitude=',
            'outerEdge=',
            'band.y=',
            'xLocal=',
            'tier='
        ]) {
            expect(report).toContain(token);
        }
    });
});

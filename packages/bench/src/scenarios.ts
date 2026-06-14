import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

// Walk upward looking for the .git marker so scenarios.ts resolves the same
// REPO_ROOT regardless of how deeply nested the bundle ends up under dist/
// (e.g. dist/runOne.mjs vs dist/ab/A/runOneCore.mjs for the A/B harness).
function findRepoRoot(start: string): string {
    let cur = start;
    while (cur !== path.parse(cur).root) {
        if (fs.existsSync(path.join(cur, '.git'))) {
            return cur;
        }
        cur = path.dirname(cur);
    }
    throw new Error(`scenarios.ts: cannot find repo root walking up from ${start}`);
}

const REPO_ROOT = findRepoRoot(__dirname);
const DATA = path.join(REPO_ROOT, 'packages/alphatab/test-data');

/**
 * A measured scenario. `mode = 'render'` measures cold full render at a fixed
 * width. `mode = 'resize'` does an initial render, then drives one or more
 * width changes through `triggerResize()`.
 */
export interface Scenario {
    id: string;
    /** Path to the score file. */
    scorePath: string;
    mode: 'render' | 'resize';
    /** Initial render width. */
    width: number;
    /** Additional widths to resize to; only used in `resize` mode. */
    resizeWidths?: number[];
    warmup: number;
    iterations: number;
    tracks?: number[];
}

export const SCENARIOS: Scenario[] = [
    // Noise floor: small score, dominated by fixed per-render cost.
    {
        id: 'tiny-render',
        scorePath: path.join(DATA, 'visual-tests/general/song-details.gp'),
        mode: 'render',
        width: 970,
        warmup: 5,
        iterations: 20
    },
    // Real multitrack song. Resize is the user's primary pain point.
    {
        id: 'nightwish-resize',
        scorePath: path.join(DATA, 'guitarpro5/nightwish.gp5'),
        mode: 'resize',
        width: 1200,
        resizeWidths: [970, 1400, 800],
        warmup: 3,
        iterations: 10
    },
    {
        id: 'nightwish-render',
        scorePath: path.join(DATA, 'guitarpro5/nightwish.gp5'),
        mode: 'render',
        width: 1200,
        warmup: 3,
        iterations: 10
    },
    // Dense multitrack canon. Heaviest pure-notation fixture.
    {
        id: 'canon-resize',
        scorePath: path.join(DATA, 'guitarpro5/canon.gp5'),
        mode: 'resize',
        width: 1200,
        resizeWidths: [970, 1400, 800],
        warmup: 3,
        iterations: 8
    },
    {
        id: 'canon-render',
        scorePath: path.join(DATA, 'guitarpro5/canon.gp5'),
        mode: 'render',
        width: 1200,
        warmup: 3,
        iterations: 8
    },
    // Real song with heavy effects/distortion.
    {
        id: 'fade-to-black-resize',
        scorePath: path.join(DATA, 'guitarpro4/fade-to-black.gp4'),
        mode: 'resize',
        width: 1200,
        resizeWidths: [970, 1400],
        warmup: 3,
        iterations: 8
    },
    // Sustained browser-drag pattern: many small width steps wide → narrow →
    // partial-back. canon-resize at 4 widths is ~90 ms/iter, which leaves the
    // CPU profile thinly sampled per resize. This scenario drives 12 widths
    // per driveOnce (~3× canon-resize sample density) so the resize path
    // dominates wall-clock and per-frame analysis has enough samples to
    // resolve sub-percent hotspots.
    {
        id: 'canon-resize-drag',
        scorePath: path.join(DATA, 'guitarpro5/canon.gp5'),
        mode: 'resize',
        width: 1200,
        resizeWidths: [1400, 1300, 1200, 1100, 1000, 900, 800, 700, 600, 650, 750, 850],
        warmup: 3,
        iterations: 8
    }
];

export function scenarioById(id: string): Scenario {
    const s = SCENARIOS.find(x => x.id === id);
    if (!s) {
        throw new Error(`Unknown scenario '${id}'. Known: ${SCENARIOS.map(x => x.id).join(', ')}`);
    }
    return s;
}

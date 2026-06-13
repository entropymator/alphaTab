import path from 'node:path';
import url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
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
    }
];

export function scenarioById(id: string): Scenario {
    const s = SCENARIOS.find(x => x.id === id);
    if (!s) {
        throw new Error(`Unknown scenario '${id}'. Known: ${SCENARIOS.map(x => x.id).join(', ')}`);
    }
    return s;
}

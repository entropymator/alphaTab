/**
 * Small CLI multiplexer. Currently dispatches `diff`.
 */
import { diffRuns } from './analyze/diff';

const [, , cmd, ...rest] = process.argv;

if (cmd === 'diff') {
    const [baseline, candidate] = rest;
    if (!baseline || !candidate) {
        console.error('usage: cli.mjs diff <baseline.json> <candidate.json>');
        process.exit(2);
    }
    try {
        process.stdout.write(diffRuns(baseline, candidate));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[bench] diff refused: ${msg}`);
        process.exit(2);
    }
} else {
    console.error(`unknown cli command: ${cmd ?? '<none>'}`);
    console.error('available: diff <baseline.json> <candidate.json>');
    process.exit(2);
}

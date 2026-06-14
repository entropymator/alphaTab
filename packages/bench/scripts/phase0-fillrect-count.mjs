/**
 * Phase 0 §8.1 probe — count fillRect calls per iter on canon-resize-drag and
 * break down by integer-vs-fractional coordinate, scale==1 vs non-1, and total
 * <rect> byte volume.
 *
 * Runs the same bundled runOneCore the A/B harness uses so the call count
 * reflects the actual scenario shape (3 warmup + N measured driveOnce calls,
 * each of which is 13 resizes back to base width).
 *
 * The fillRect counter is incremented in a temporary instrumentation block in
 * SvgCanvas.ts. That block is reverted before any Phase A commit.
 *
 * Usage (from packages/bench):
 *   npx vite build && node scripts/phase0-fillrect-count.mjs
 */
import path from 'node:path';
import url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const distRunOne = path.resolve(__dirname, '../dist/ab/PROBE/runOneCore.mjs');

// Opt-in caller attribution (slow due to stack capture per call).
globalThis.ew10Stacks = process.argv.includes('--stacks');

const mod = await import(url.pathToFileURL(distRunOne).href);
const { prepareScenario, scenarioById } = mod;
const scenario = scenarioById('canon-resize-drag');

const prepared = prepareScenario(scenario);

// reset the counter — prepareScenario does warmup iterations which already
// populated globalThis.ew10Counter.
const g = globalThis;
const warmCounter = { ...(g.ew10Counter ?? {}) };
g.ew10Counter = { calls: 0, frac: 0, ints: 0, nonScale1: 0, bytes: 0, perCaller: new Map() };

const iters = 8;
const wall = [];
for (let i = 0; i < iters; i++) {
    const ns = prepared.tick();
    wall.push(ns);
}

const c = g.ew10Counter;
const perIter = (n) => (n / iters).toFixed(0);

console.log('Phase 0 §8.1 — fillRect call count probe on canon-resize-drag');
console.log('================================================================');
console.log(`measured iterations: ${iters}`);
console.log(`total fillRect calls (measured): ${c.calls}`);
console.log(`  per iter: ${perIter(c.calls)}`);
console.log(`  integer-coord (after *scale): ${c.ints} (${((c.ints / c.calls) * 100).toFixed(1)}%)`);
console.log(`  fractional-coord:             ${c.frac} (${((c.frac / c.calls) * 100).toFixed(1)}%)`);
console.log(`  with scale !== 1:             ${c.nonScale1} (${((c.nonScale1 / c.calls) * 100).toFixed(1)}%)`);
console.log(`  total <rect> string bytes:    ${c.bytes} (${perIter(c.bytes)} bytes/iter)`);
console.log('');
console.log(`warmup-phase counts (prepareScenario, 3 warmups): ${JSON.stringify(warmCounter)}`);
console.log('');
const medNs = wall.slice().sort((a, b) => a - b)[Math.floor(iters / 2)];
console.log(`wall-clock median: ${(medNs / 1e6).toFixed(2)} ms / iter`);
console.log('');
// estimated per-call cost (lower bound): if fillRect were free, iter would
// drop by (current fillRect ms). Per the post-DR-1 profile, that's ~19.57 ms.
// per-call ns = 19.57e6 / (calls/iter)
const callsPerIter = c.calls / iters;
const perCallNs = (19.57e6) / callsPerIter;
console.log(`derived per-call cost (using post-DR-1 fillRect self-time 19.57 ms): ${perCallNs.toFixed(0)} ns`);

if (c.perCaller && c.perCaller.size > 0) {
    console.log('');
    console.log('per-caller breakdown (top 30):');
    const sorted = Array.from(c.perCaller.entries()).sort((a, b) => b[1] - a[1]).slice(0, 30);
    for (const [caller, n] of sorted) {
        console.log(`  ${(n / iters).toFixed(0).padStart(8)} /iter  ${((n / c.calls) * 100).toFixed(1).padStart(5)}%  ${caller}`);
    }
}

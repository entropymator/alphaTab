/**
 * EW-11 Phase 0 probe — count calls / ns / scale=1 hit rate for four SVG
 * emission methods on canon-resize-drag:
 *   - SvgCanvas.fillText
 *   - SvgCanvas.lineTo
 *   - SvgCanvas.moveTo
 *   - CssFontSvgCanvas._fillMusicFontSymbolText
 *
 * Requires the working-tree alphatab build under dist/ab/PROBE/runOneCore.mjs
 * (build with `node scripts/build-ab.mjs --ref-a HEAD` — arm B reads working
 * tree, which contains the instrumentation). The instrumentation is gated on
 * `globalThis.ew11Probe` being truthy — set BEFORE the first call by this script.
 *
 * Usage (from packages/bench):
 *   node scripts/phase0-ew11-probe.mjs [--iters N]
 */
import path from 'node:path';
import url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const distRunOne = path.resolve(__dirname, '../dist/ab/PROBE/runOneCore.mjs');

const args = process.argv.slice(2);
let iters = 8;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--iters') {
        iters = Number(args[++i]) | 0 || 8;
    }
}

function freshProbe() {
    return {
        fillText:  { calls: 0, ns: 0, scale1: 0 },
        lineTo:    { calls: 0, ns: 0, scale1: 0 },
        moveTo:    { calls: 0, ns: 0, scale1: 0 },
        fillMusic: { calls: 0, ns: 0, scale1: 0, relScale1: 0, bothScale1: 0 }
    };
}

// Install probe BEFORE importing the bundle.
globalThis.ew11Probe = freshProbe();

const mod = await import(url.pathToFileURL(distRunOne).href);
const { prepareScenario, scenarioById } = mod;
const scenario = scenarioById('canon-resize-drag');

const prepared = prepareScenario(scenario);

// Reset probe — prepareScenario does warmup iterations.
const warm = globalThis.ew11Probe;
globalThis.ew11Probe = freshProbe();

const wall = [];
for (let i = 0; i < iters; i++) {
    const ns = prepared.tick();
    wall.push(ns);
}

const p = globalThis.ew11Probe;
const fmt = (n, d = 2) => n.toFixed(d);
const fmtMs = (ns) => (ns / 1e6).toFixed(3);

function row(name, rec) {
    const calls = rec.calls;
    const callsPerIter = calls / iters;
    const totalMs = rec.ns / 1e6;
    const msPerIter = totalMs / iters;
    const nsPerCall = calls > 0 ? rec.ns / calls : 0;
    const s1Pct = calls > 0 ? (rec.scale1 / calls) * 100 : 0;
    console.log(`  ${name.padEnd(28)} calls=${String(calls).padStart(7)}  /iter=${callsPerIter.toFixed(0).padStart(6)}  ns/call=${nsPerCall.toFixed(0).padStart(5)}  total=${fmtMs(rec.ns).padStart(7)} ms  /iter=${msPerIter.toFixed(3).padStart(6)} ms  scale1=${fmt(s1Pct, 1).padStart(5)}%`);
}

console.log('EW-11 Phase 0 — empirical probes (canon-resize-drag)');
console.log('====================================================');
console.log(`measured iterations: ${iters}`);
console.log(`warmup counts: fillText=${warm.fillText.calls} lineTo=${warm.lineTo.calls} moveTo=${warm.moveTo.calls} fillMusic=${warm.fillMusic.calls}`);
console.log('');
console.log('Per-method totals:');
row('SvgCanvas.fillText',          p.fillText);
row('SvgCanvas.lineTo',            p.lineTo);
row('SvgCanvas.moveTo',            p.moveTo);
row('CssFontSvgCanvas.fillMusicSymText', p.fillMusic);
console.log('');
if (p.fillMusic.calls > 0) {
    const relS1Pct = (p.fillMusic.relScale1 / p.fillMusic.calls) * 100;
    const bothS1Pct = (p.fillMusic.bothScale1 / p.fillMusic.calls) * 100;
    console.log(`  fillMusicSymbolText — relativeScale=1: ${fmt(relS1Pct, 1)}%  both this.scale=1 AND relativeScale=1: ${fmt(bothS1Pct, 1)}%`);
}
console.log('');
const totalNs = p.fillText.ns + p.lineTo.ns + p.moveTo.ns + p.fillMusic.ns;
console.log(`Combined surface (sum of timed bodies): ${fmtMs(totalNs)} ms total / ${(totalNs / 1e6 / iters).toFixed(3)} ms/iter`);
console.log('NOTE: per-method ns includes the instrumentation overhead (~50-100 ns from hrtime). True per-call cost is somewhat lower.');
console.log('');
const medNs = wall.slice().sort((a, b) => a - b)[Math.floor(iters / 2)];
console.log(`wall-clock median: ${(medNs / 1e6).toFixed(2)} ms / iter`);
console.log('');
console.log('JSON ----');
console.log(JSON.stringify({
    iters,
    scenario: 'canon-resize-drag',
    medianWallMs: medNs / 1e6,
    fillText: p.fillText,
    lineTo: p.lineTo,
    moveTo: p.moveTo,
    fillMusic: p.fillMusic,
    fillText_perIter: { calls: p.fillText.calls / iters, ms: p.fillText.ns / 1e6 / iters, nsPerCall: p.fillText.calls > 0 ? p.fillText.ns / p.fillText.calls : 0, scale1Pct: p.fillText.calls > 0 ? p.fillText.scale1 / p.fillText.calls * 100 : 0 },
    lineTo_perIter:   { calls: p.lineTo.calls / iters,   ms: p.lineTo.ns / 1e6 / iters,   nsPerCall: p.lineTo.calls > 0 ? p.lineTo.ns / p.lineTo.calls : 0, scale1Pct: p.lineTo.calls > 0 ? p.lineTo.scale1 / p.lineTo.calls * 100 : 0 },
    moveTo_perIter:   { calls: p.moveTo.calls / iters,   ms: p.moveTo.ns / 1e6 / iters,   nsPerCall: p.moveTo.calls > 0 ? p.moveTo.ns / p.moveTo.calls : 0, scale1Pct: p.moveTo.calls > 0 ? p.moveTo.scale1 / p.moveTo.calls * 100 : 0 },
    fillMusic_perIter:{ calls: p.fillMusic.calls / iters, ms: p.fillMusic.ns / 1e6 / iters, nsPerCall: p.fillMusic.calls > 0 ? p.fillMusic.ns / p.fillMusic.calls : 0, scale1Pct: p.fillMusic.calls > 0 ? p.fillMusic.scale1 / p.fillMusic.calls * 100 : 0, relScale1Pct: p.fillMusic.calls > 0 ? p.fillMusic.relScale1 / p.fillMusic.calls * 100 : 0, bothScale1Pct: p.fillMusic.calls > 0 ? p.fillMusic.bothScale1 / p.fillMusic.calls * 100 : 0 }
}, null, 2));

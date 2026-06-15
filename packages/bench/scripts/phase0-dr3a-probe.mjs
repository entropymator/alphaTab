/**
 * DR-3.A Phase 0 probe — count calls / ns / scale=1 hit rate for the OPEN
 * SVG emission methods (those NOT yet covered by EW-10 / EW-11 fast paths)
 * on canon-resize-drag:
 *   - SvgCanvas.strokeRect
 *   - SvgCanvas.quadraticCurveTo
 *   - SvgCanvas.bezierCurveTo
 *   - SvgCanvas.fillCircle
 *   - SvgCanvas.strokeCircle
 *   - SvgCanvas.fill
 *   - SvgCanvas.stroke
 *   - SvgCanvas.beginRotate
 *   - SvgCanvas.beginGroup
 *
 * Same shape as phase0-ew11-probe.mjs. Requires a bench bundle built from a
 * working tree carrying the DR-3.A instrumentation patch.
 *
 * Usage (from packages/bench):
 *   node scripts/phase0-dr3a-probe.mjs [--iters N]
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
        strokeRect:       { calls: 0, ns: 0, scale1: 0 },
        quadraticCurveTo: { calls: 0, ns: 0, scale1: 0 },
        bezierCurveTo:    { calls: 0, ns: 0, scale1: 0 },
        fillCircle:       { calls: 0, ns: 0, scale1: 0 },
        strokeCircle:     { calls: 0, ns: 0, scale1: 0 },
        fill:             { calls: 0, ns: 0, scale1: 0 },
        stroke:           { calls: 0, ns: 0, scale1: 0 },
        beginRotate:      { calls: 0, ns: 0, scale1: 0 },
        beginGroup:       { calls: 0, ns: 0, scale1: 0 }
    };
}

// Install probe BEFORE importing the bundle.
globalThis.dr3aProbe = freshProbe();

const mod = await import(url.pathToFileURL(distRunOne).href);
const { prepareScenario, scenarioById } = mod;
const scenario = scenarioById('canon-resize-drag');

const prepared = prepareScenario(scenario);

// Reset probe — prepareScenario does warmup iterations.
const warm = globalThis.dr3aProbe;
globalThis.dr3aProbe = freshProbe();

const wall = [];
for (let i = 0; i < iters; i++) {
    const ns = prepared.tick();
    wall.push(ns);
}

const p = globalThis.dr3aProbe;
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

console.log('DR-3.A Phase 0 — empirical probes (canon-resize-drag)');
console.log('=====================================================');
console.log(`measured iterations: ${iters}`);
console.log(`warmup counts: strokeRect=${warm.strokeRect.calls} quadraticCurveTo=${warm.quadraticCurveTo.calls} bezierCurveTo=${warm.bezierCurveTo.calls} fillCircle=${warm.fillCircle.calls} strokeCircle=${warm.strokeCircle.calls} fill=${warm.fill.calls} stroke=${warm.stroke.calls} beginRotate=${warm.beginRotate.calls} beginGroup=${warm.beginGroup.calls}`);
console.log('');
console.log('Per-method totals:');
row('SvgCanvas.strokeRect',       p.strokeRect);
row('SvgCanvas.quadraticCurveTo', p.quadraticCurveTo);
row('SvgCanvas.bezierCurveTo',    p.bezierCurveTo);
row('SvgCanvas.fillCircle',       p.fillCircle);
row('SvgCanvas.strokeCircle',     p.strokeCircle);
row('SvgCanvas.fill',             p.fill);
row('SvgCanvas.stroke',           p.stroke);
row('SvgCanvas.beginRotate',      p.beginRotate);
row('SvgCanvas.beginGroup',       p.beginGroup);
console.log('');
const totalNs = p.strokeRect.ns + p.quadraticCurveTo.ns + p.bezierCurveTo.ns + p.fillCircle.ns + p.strokeCircle.ns + p.fill.ns + p.stroke.ns + p.beginRotate.ns + p.beginGroup.ns;
console.log(`Combined surface (sum of timed bodies): ${fmtMs(totalNs)} ms total / ${(totalNs / 1e6 / iters).toFixed(3)} ms/iter`);
console.log('NOTE: per-method ns includes the instrumentation overhead (~50-100 ns from hrtime). True per-call cost is somewhat lower.');
console.log('');
const medNs = wall.slice().sort((a, b) => a - b)[Math.floor(iters / 2)];
console.log(`wall-clock median: ${(medNs / 1e6).toFixed(2)} ms / iter`);
console.log('');
console.log('JSON ----');
const perIter = (rec) => ({
    calls: rec.calls / iters,
    ms: rec.ns / 1e6 / iters,
    nsPerCall: rec.calls > 0 ? rec.ns / rec.calls : 0,
    scale1Pct: rec.calls > 0 ? rec.scale1 / rec.calls * 100 : 0
});
console.log(JSON.stringify({
    iters,
    scenario: 'canon-resize-drag',
    medianWallMs: medNs / 1e6,
    strokeRect: p.strokeRect,
    quadraticCurveTo: p.quadraticCurveTo,
    bezierCurveTo: p.bezierCurveTo,
    fillCircle: p.fillCircle,
    strokeCircle: p.strokeCircle,
    fill: p.fill,
    stroke: p.stroke,
    beginRotate: p.beginRotate,
    beginGroup: p.beginGroup,
    perIter: {
        strokeRect: perIter(p.strokeRect),
        quadraticCurveTo: perIter(p.quadraticCurveTo),
        bezierCurveTo: perIter(p.bezierCurveTo),
        fillCircle: perIter(p.fillCircle),
        strokeCircle: perIter(p.strokeCircle),
        fill: perIter(p.fill),
        stroke: perIter(p.stroke),
        beginRotate: perIter(p.beginRotate),
        beginGroup: perIter(p.beginGroup)
    }
}, null, 2));

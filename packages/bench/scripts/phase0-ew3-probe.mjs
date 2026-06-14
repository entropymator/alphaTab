/**
 * EW-3 Phase 0 probe — runs canon-resize-drag with the temporary EW-3
 * instrumentation in LineBarRenderer enabled. Dumps the four §6 probes:
 *   §6.1 per-class collectSpaces invocation count
 *   §6.2 layout-vs-resize stability test for collectSpaces output
 *   §6.3 per-call cost microbench
 *   §6.4 paintStaffLines work decomposition (pre-emit vs emit timer)
 *
 * Requires the working-tree alphatab build under dist/ab/PROBE/runOneCore.mjs
 * (build with `node scripts/build-ab.mjs --ref-a HEAD` — arm A reads HEAD,
 * arm B reads working tree; either reused as "PROBE"). The instrumentation
 * is gated on `globalThis.ew3Probe` being truthy — set BEFORE the first
 * call by this script.
 *
 * Usage (from packages/bench):
 *   node scripts/phase0-ew3-probe.mjs [--iters N]
 */
import path from 'node:path';
import url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const distRunOne = path.resolve(__dirname, '../dist/ab/PROBE/runOneCore.mjs');

const args = process.argv.slice(2);
let iters = 3;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--iters') {
        iters = Number(args[++i]) | 0 || 3;
    }
}

// CRITICAL: install the probe BEFORE importing the bundle. The bundle's
// LineBarRenderer.paintStaffLines reads `globalThis.ew3Probe` per-call and
// no-ops if undefined.
globalThis.ew3Probe = {
    collectSpacesCalls: 0,
    collectSpacesNs: 0,
    paintStaffLinesCalls: 0,
    paintStaffLinesNs: 0,
    preEmitNs: 0,
    emitNs: 0,
    perClass: new Map(),
    snapshotByRenderer: new WeakMap(),
    snapshotsTaken: 0,
    stabilityIdentical: 0,
    stabilityChanged: 0,
    diffExamples: []
};

const mod = await import(url.pathToFileURL(distRunOne).href);
const { prepareScenario, scenarioById } = mod;
const scenario = scenarioById('canon-resize-drag');

const prepared = prepareScenario(scenario);

// The probe accumulated warmup data — reset before measured iters.
const warmCounts = {
    collectSpacesCalls: globalThis.ew3Probe.collectSpacesCalls,
    paintStaffLinesCalls: globalThis.ew3Probe.paintStaffLinesCalls,
    snapshotsTaken: globalThis.ew3Probe.snapshotsTaken,
    stabilityIdentical: globalThis.ew3Probe.stabilityIdentical,
    stabilityChanged: globalThis.ew3Probe.stabilityChanged,
    perClassClasses: [...globalThis.ew3Probe.perClass.keys()]
};

globalThis.ew3Probe = {
    collectSpacesCalls: 0,
    collectSpacesNs: 0,
    paintStaffLinesCalls: 0,
    paintStaffLinesNs: 0,
    preEmitNs: 0,
    emitNs: 0,
    perClass: new Map(),
    snapshotByRenderer: globalThis.ew3Probe.snapshotByRenderer, // KEEP — we want snapshots from warmup
    snapshotsTaken: 0,
    stabilityIdentical: 0,
    stabilityChanged: 0,
    diffExamples: []
};

const wall = [];
for (let i = 0; i < iters; i++) {
    const ns = prepared.tick();
    wall.push(ns);
}

const p = globalThis.ew3Probe;
const fmt = (n, d = 2) => n.toFixed(d);
const fmtMs = (ns) => (ns / 1e6).toFixed(3);

console.log('EW-3 Phase 0 probes — canon-resize-drag');
console.log('========================================');
console.log(`measured iterations: ${iters}`);
console.log(`warmup classes seen: ${JSON.stringify(warmCounts.perClassClasses)}`);
console.log(`warmup collectSpaces calls: ${warmCounts.collectSpacesCalls}`);
console.log(`warmup paintStaffLines calls: ${warmCounts.paintStaffLinesCalls}`);
console.log(`warmup snapshots: ${warmCounts.snapshotsTaken}  stability identical: ${warmCounts.stabilityIdentical}  changed: ${warmCounts.stabilityChanged}`);
console.log('');
console.log('---- §6.1 Per-class collectSpaces invocation count -----------------');
const totalCS = p.collectSpacesCalls || 1;
for (const [cls, rec] of p.perClass.entries()) {
    const nonEmptyPct = rec.calls > 0 ? (rec.nonEmpty / rec.calls) * 100 : 0;
    console.log(
        `  ${cls.padEnd(22)} calls=${String(rec.calls).padStart(7)}  ` +
        `nonEmpty=${String(rec.nonEmpty).padStart(7)} (${fmt(nonEmptyPct, 1)}%)  ` +
        `totalGaps=${String(rec.gapsTotal).padStart(7)}`
    );
}
console.log('');
console.log('---- §6.2 Layout-vs-resize stability test --------------------------');
console.log(`  snapshots taken (first observation per renderer): ${p.snapshotsTaken}`);
console.log(`  subsequent calls byte-identical (stable):          ${p.stabilityIdentical}`);
console.log(`  subsequent calls CHANGED (unstable):               ${p.stabilityChanged}`);
const stableShare = p.stabilityIdentical + p.stabilityChanged;
const pctStable = stableShare > 0 ? (p.stabilityIdentical / stableShare) * 100 : 0;
console.log(`  stability ratio (of repeated calls): ${fmt(pctStable, 2)}% identical`);
if (p.diffExamples.length > 0) {
    console.log('  diff examples (capped to 5):');
    for (const d of p.diffExamples) {
        console.log(`    cls=${d.cls} prevLen=${d.prevLen} curLen=${d.curLen}`);
        console.log(`      prev: ${d.prevHead}`);
        console.log(`      cur : ${d.curHead}`);
    }
}
console.log('');
console.log('---- §6.3 Per-call cost microbench ---------------------------------');
const csPerCallNs = totalCS > 0 ? p.collectSpacesNs / totalCS : 0;
const psPerCallNs = p.paintStaffLinesCalls > 0 ? p.paintStaffLinesNs / p.paintStaffLinesCalls : 0;
console.log(`  collectSpaces  total: ${fmtMs(p.collectSpacesNs)} ms over ${p.collectSpacesCalls} calls`);
console.log(`                 per call: ${fmt(csPerCallNs, 0)} ns`);
console.log(`                 per iter: ${fmtMs(p.collectSpacesNs / iters)} ms (${(p.collectSpacesCalls / iters).toFixed(0)} calls/iter)`);
console.log(`  paintStaffLines total: ${fmtMs(p.paintStaffLinesNs)} ms over ${p.paintStaffLinesCalls} calls`);
console.log(`                 per call: ${fmt(psPerCallNs, 0)} ns`);
console.log(`                 per iter: ${fmtMs(p.paintStaffLinesNs / iters)} ms (${(p.paintStaffLinesCalls / iters).toFixed(0)} calls/iter)`);
console.log('');
console.log('---- §6.4 paintStaffLines work decomposition -----------------------');
const totalSampled = p.preEmitNs + p.emitNs;
const prePct = totalSampled > 0 ? (p.preEmitNs / totalSampled) * 100 : 0;
const emitPct = totalSampled > 0 ? (p.emitNs / totalSampled) * 100 : 0;
console.log(`  pre-emit (sort): ${fmtMs(p.preEmitNs)} ms total (${fmt(prePct, 1)}%)  ${fmtMs(p.preEmitNs / iters)} ms/iter`);
console.log(`  emit (fillRect): ${fmtMs(p.emitNs)} ms total (${fmt(emitPct, 1)}%)  ${fmtMs(p.emitNs / iters)} ms/iter`);
console.log(`  collectSpaces share of paintStaffLines: ${fmt(p.paintStaffLinesNs > 0 ? (p.collectSpacesNs / p.paintStaffLinesNs) * 100 : 0, 1)}%`);
console.log('');
const medNs = wall.slice().sort((a, b) => a - b)[Math.floor(iters / 2)];
console.log(`wall-clock median: ${(medNs / 1e6).toFixed(2)} ms / iter`);

// Dump compact JSON for downstream archival.
const out = {
    iters,
    scenario: 'canon-resize-drag',
    perClass: Object.fromEntries(
        Array.from(p.perClass.entries()).map(([k, v]) => [k, { ...v }])
    ),
    stabilitySnapshotsTaken: p.snapshotsTaken,
    stabilityIdentical: p.stabilityIdentical,
    stabilityChanged: p.stabilityChanged,
    stabilityIdenticalPct: pctStable,
    diffExamples: p.diffExamples,
    collectSpacesCalls: p.collectSpacesCalls,
    collectSpacesTotalMs: p.collectSpacesNs / 1e6,
    collectSpacesPerCallNs: csPerCallNs,
    collectSpacesPerIterMs: p.collectSpacesNs / 1e6 / iters,
    paintStaffLinesCalls: p.paintStaffLinesCalls,
    paintStaffLinesTotalMs: p.paintStaffLinesNs / 1e6,
    paintStaffLinesPerCallNs: psPerCallNs,
    paintStaffLinesPerIterMs: p.paintStaffLinesNs / 1e6 / iters,
    preEmitTotalMs: p.preEmitNs / 1e6,
    emitTotalMs: p.emitNs / 1e6,
    preEmitPct: prePct,
    emitPct,
    medianWallMs: medNs / 1e6
};
console.log('');
console.log('JSON ----');
console.log(JSON.stringify(out, null, 2));

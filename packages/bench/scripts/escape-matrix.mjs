#!/usr/bin/env node
// Orchestrator for the _escapeText variant matrix.
//
// For each variant, spawn N trials in fresh Node child processes (CPU-pinned
// on linux when taskset is available, to keep cache state stable across
// trials). Aggregate per_call_ns medians + spread, sort by speed, print a
// markdown comparison table.
//
// Usage:
//   node escape-matrix.mjs            # default: 7 trials per variant
//   node escape-matrix.mjs --trials 9 # override
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const HARNESS = path.join(__dirname, 'escape-microbench.mjs');

const VARIANTS = ['V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10'];

function parseArgs() {
    let trials = 7;
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--trials') trials = Number(argv[++i]);
    }
    return { trials };
}

function detectPin() {
    // Same approach the main bench harness uses: prefer cores 2,3 on a
    // multi-core linux box; skip on other platforms or when taskset is
    // unavailable.
    if (process.platform !== 'linux') return null;
    const which = spawnSync('which', ['taskset'], { encoding: 'utf8' });
    if (which.status !== 0) return null;
    const ncpu = (() => {
        const r = spawnSync('nproc', { encoding: 'utf8' });
        return r.status === 0 ? Number(r.stdout.trim()) : 0;
    })();
    return ncpu >= 4 ? '2,3' : null;
}

function runOne(variant, pin) {
    const args = pin
        ? ['-c', pin, 'node', '--expose-gc', HARNESS, variant]
        : ['--expose-gc', HARNESS, variant];
    const cmd = pin ? 'taskset' : 'node';
    const res = spawnSync(cmd, args, { encoding: 'utf8' });
    if (res.status !== 0) {
        throw new Error(`variant ${variant} failed: ${res.stderr || res.stdout}`);
    }
    const lines = res.stdout.trim().split('\n');
    const jsonLine = lines[lines.length - 1];
    return JSON.parse(jsonLine);
}

function median(xs) {
    const sorted = [...xs].sort((a, b) => a - b);
    const n = sorted.length;
    return n % 2 === 1 ? sorted[(n - 1) / 2] : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
}

function mad(xs) {
    // Median absolute deviation — robust spread measure.
    const med = median(xs);
    const deviations = xs.map(x => Math.abs(x - med));
    return median(deviations);
}

const { trials } = parseArgs();
const pin = detectPin();

console.error(`# Escape variant matrix — ${trials} trials per variant`);
console.error(`# Pin: ${pin ?? '<none>'}`);
console.error(`# Harness: ${HARNESS}`);
console.error('');

const results = new Map();
for (const v of VARIANTS) {
    const trialsRecord = [];
    for (let t = 0; t < trials; t++) {
        const r = runOne(v, pin);
        trialsRecord.push(r);
        process.stderr.write(`  ${v} trial ${t + 1}/${trials}: ${r.per_call_ns.toFixed(3)} ns/call\n`);
    }
    const perCalls = trialsRecord.map(r => r.per_call_ns);
    const med = median(perCalls);
    const madVal = mad(perCalls);
    results.set(v, {
        label: trialsRecord[0].label,
        median_ns: med,
        mad_ns: madVal,
        min_ns: Math.min(...perCalls),
        max_ns: Math.max(...perCalls),
        all: perCalls
    });
    console.error('');
}

// Reference variants for relative speedup.
const V0 = results.get('V0');
const V1 = results.get('V1');

// Sort by median for ranked output (ascending = faster first).
const ranked = [...results.entries()].sort((a, b) => a[1].median_ns - b[1].median_ns);

console.log('');
console.log('## Results');
console.log('');
console.log(`Trials per variant: ${trials}. Reporting median ± MAD ns/call across trials.`);
console.log('');
console.log('| Rank | ID | Label | median ns/call | MAD | min | max | vs V0 | vs V1 |');
console.log('| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (let i = 0; i < ranked.length; i++) {
    const [id, r] = ranked[i];
    const vsV0 = (r.median_ns / V0.median_ns - 1) * 100;
    const vsV1 = (r.median_ns / V1.median_ns - 1) * 100;
    const sign = (x) => (x >= 0 ? '+' : '') + x.toFixed(1) + ' %';
    console.log(
        `| ${i + 1} | ${id} | ${r.label} | ${r.median_ns.toFixed(3)} | ${r.mad_ns.toFixed(3)} | ${r.min_ns.toFixed(3)} | ${r.max_ns.toFixed(3)} | ${sign(vsV0)} | ${sign(vsV1)} |`
    );
}

console.log('');
console.log('## Per-trial raw data (ns/call)');
console.log('');
console.log('| Variant | trials |');
console.log('| --- | --- |');
for (const id of VARIANTS) {
    const r = results.get(id);
    console.log(`| ${id} | ${r.all.map(x => x.toFixed(2)).join(' / ')} |`);
}

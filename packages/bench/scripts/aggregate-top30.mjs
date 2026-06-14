#!/usr/bin/env node
// Aggregate top-30 self-CPU and self-heap entries by (function, file:line)
// across all trials for the given scenario. Walks cpu.cpuprofile nodes[]
// (hitCount × sampleInterval) and heap.heapprofile recursive head (selfSize).
//
// Usage:
//   node scripts/aggregate-top30.mjs <runs/<label>/<scenario-id>>
import fs from 'node:fs';
import path from 'node:path';

const runDir = process.argv[2];
if (!runDir) {
    console.error('usage: node scripts/aggregate-top30.mjs <scenario-run-dir>');
    process.exit(2);
}

const trials = fs.readdirSync(runDir).filter(n => /^trial-\d+$/.test(n)).sort();
if (trials.length === 0) {
    console.error(`no trial-N subdirs in ${runDir}`);
    process.exit(2);
}

const cpuTotals = new Map();
const heapTotals = new Map();

function key(callFrame) {
    const fn = callFrame.functionName || '(anonymous)';
    const url = callFrame.url || '<unknown>';
    const line = callFrame.lineNumber ?? -1;
    return `${fn}\t${url}:${line + 1}`;
}

for (const trial of trials) {
    // --- CPU ---
    const cpu = JSON.parse(fs.readFileSync(path.join(runDir, trial, 'cpu.cpuprofile'), 'utf8'));
    // V8 cpuprofile uses microsecond sample intervals on inspector. Derive
    // interval from startTime/endTime/samples count for accuracy.
    const sampleInterval = cpu.samples && cpu.samples.length > 1
        ? (cpu.endTime - cpu.startTime) / cpu.samples.length // microseconds
        : 100; // fallback
    for (const node of cpu.nodes) {
        if (!node.hitCount) continue;
        const k = key(node.callFrame);
        const ms = (node.hitCount * sampleInterval) / 1000; // µs → ms
        cpuTotals.set(k, (cpuTotals.get(k) || 0) + ms);
    }

    // --- HEAP ---
    const heap = JSON.parse(fs.readFileSync(path.join(runDir, trial, 'heap.heapprofile'), 'utf8'));
    function walk(node) {
        if (node.selfSize) {
            const k = key(node.callFrame);
            heapTotals.set(k, (heapTotals.get(k) || 0) + node.selfSize);
        }
        if (node.children) {
            for (const c of node.children) walk(c);
        }
    }
    walk(heap.head);
}

const trialCount = trials.length;

function ranking(map, suffix) {
    const arr = [...map.entries()]
        .map(([k, v]) => {
            const [fn, where] = k.split('\t');
            return { fn, where, total: v, perTrial: v / trialCount };
        })
        .sort((a, b) => b.total - a.total);
    return arr;
}

const cpuRanked = ranking(cpuTotals);
const heapRanked = ranking(heapTotals);

const grandCpu = cpuRanked.reduce((s, e) => s + e.total, 0);
const grandHeap = heapRanked.reduce((s, e) => s + e.total, 0);

console.log(`# Aggregated top-30 — ${path.basename(runDir)}`);
console.log(`# trials = ${trialCount}`);
console.log('');
console.log(`## CPU top 30 (self-time, summed across ${trialCount} trials)`);
console.log(`# total sampled across trials: ${grandCpu.toFixed(1)} ms\n`);
console.log('| # | Self ms (sum) | Self ms / trial | Self % | Function | File:line |');
console.log('| ---: | ---: | ---: | ---: | --- | --- |');
cpuRanked.slice(0, 30).forEach((e, i) => {
    const pct = (e.total / grandCpu) * 100;
    console.log(`| ${i + 1} | ${e.total.toFixed(2)} | ${e.perTrial.toFixed(2)} | ${pct.toFixed(2)}% | ${e.fn} | ${e.where} |`);
});

console.log('');
console.log(`## Heap top 30 (self-bytes, summed across ${trialCount} trials)`);
console.log(`# total sampled across trials: ${(grandHeap / 1024).toFixed(1)} kB\n`);
console.log('| # | Bytes (sum) | kB / trial | Self % | Function | File:line |');
console.log('| ---: | ---: | ---: | ---: | --- | --- |');
heapRanked.slice(0, 30).forEach((e, i) => {
    const pct = (e.total / grandHeap) * 100;
    console.log(`| ${i + 1} | ${e.total.toFixed(0)} | ${(e.perTrial / 1024).toFixed(2)} | ${pct.toFixed(2)}% | ${e.fn} | ${e.where} |`);
});

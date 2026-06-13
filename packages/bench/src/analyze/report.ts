import fs from 'node:fs';
import path from 'node:path';
import { analyzeCpuProfile } from './cpuprof';
import { analyzeHeapProfile } from './heapprof';
import { type Scenario } from '../scenarios';
import { type ScenarioResult } from '../harness';

export interface ScenarioReport {
    scenario: Scenario;
    result: ScenarioResult;
    /** Directory containing this scenario's profile files. */
    sceneDir: string;
}

function fmtMs(ns: number): string {
    return (ns / 1e6).toFixed(2);
}

function fmtKb(bytes: number): string {
    return (bytes / 1024).toFixed(1);
}

export function renderReport(reports: ScenarioReport[], label: string): string {
    const lines: string[] = [];
    lines.push(`# alphaTab bench report — ${label}`);
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    lines.push('## Wall-clock summary');
    lines.push('');
    lines.push('| Scenario | n | median | mean | p5 | p95 | min | max |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of reports) {
        const s = r.result.summary;
        lines.push(
            `| ${r.scenario.id} | ${s.n} | ${fmtMs(s.medianNs)} ms | ${fmtMs(s.meanNs)} ms | ${fmtMs(s.p5Ns)} ms | ${fmtMs(s.p95Ns)} ms | ${fmtMs(s.minNs)} ms | ${fmtMs(s.maxNs)} ms |`
        );
    }
    lines.push('');

    lines.push('## Stage breakdown (Profiler)');
    lines.push('');
    for (const r of reports) {
        lines.push(`### ${r.scenario.id}`);
        lines.push('');
        const stages = Object.entries(r.result.profiler.stages).sort((a, b) => b[1].totalNs - a[1].totalNs);
        if (stages.length === 0) {
            lines.push('_no stage data captured_');
            lines.push('');
            continue;
        }
        lines.push('| Stage | calls | total ms | mean us | max ms |');
        lines.push('| --- | --- | --- | --- | --- |');
        for (const [name, stats] of stages) {
            const meanUs = stats.totalNs / stats.count / 1000;
            lines.push(
                `| ${name} | ${stats.count} | ${fmtMs(stats.totalNs)} | ${meanUs.toFixed(2)} | ${fmtMs(stats.maxNs)} |`
            );
        }
        lines.push('');

        const counters = Object.entries(r.result.profiler.counters).sort((a, b) => b[1] - a[1]);
        if (counters.length > 0) {
            lines.push('Counters:');
            lines.push('');
            for (const [name, count] of counters) {
                lines.push(`- ${name}: ${count.toLocaleString()}`);
            }
            lines.push('');
        }

        lines.push(`Heap delta: used ${fmtKb(r.result.heap.usedHeapAfter - r.result.heap.usedHeapBefore)} kB, total ${fmtKb(r.result.heap.totalHeapAfter - r.result.heap.totalHeapBefore)} kB`);
        lines.push('');
    }

    lines.push('## CPU hotspots (top 15 self-time per scenario)');
    lines.push('');
    for (const r of reports) {
        const cpuPath = path.join(r.sceneDir, 'cpu.cpuprofile');
        lines.push(`### ${r.scenario.id}`);
        lines.push('');
        try {
            const cpu = analyzeCpuProfile(cpuPath);
            lines.push(`Total sampled: ${fmtMs(cpu.totalSelfNs)} ms across ${cpu.sampleCount.toLocaleString()} samples.`);
            lines.push('');
            lines.push('| Self ms | Self % | Function | File:line |');
            lines.push('| ---: | ---: | --- | --- |');
            for (const e of cpu.topSelf.slice(0, 15)) {
                lines.push(
                    `| ${fmtMs(e.selfNs)} | ${(e.selfPct * 100).toFixed(1)}% | ${escapePipe(e.functionName)} | ${escapePipe(e.location)} |`
                );
            }
            lines.push('');
        } catch (e) {
            lines.push(`_failed to parse ${cpuPath}: ${(e as Error).message}_`);
            lines.push('');
        }
    }

    lines.push('## Heap allocation hotspots (top 15 bytes per scenario)');
    lines.push('');
    for (const r of reports) {
        // The first heap profile written by --heap-prof-name follows a numeric pattern in newer Node;
        // try the exact name first, else fall back to any file matching the prefix.
        const heapPath = resolveHeapPath(r.sceneDir);
        lines.push(`### ${r.scenario.id}`);
        lines.push('');
        try {
            const heap = analyzeHeapProfile(heapPath);
            lines.push(`Total sampled: ${fmtKb(heap.totalBytes)} kB.`);
            lines.push('');
            lines.push('| Bytes | Count | Function | File:line |');
            lines.push('| ---: | ---: | --- | --- |');
            for (const e of heap.topBytes.slice(0, 15)) {
                lines.push(
                    `| ${fmtKb(e.selfBytes)} | ${e.selfCount} | ${escapePipe(e.functionName)} | ${escapePipe(e.location)} |`
                );
            }
            lines.push('');
        } catch (e) {
            lines.push(`_failed to parse heap profile in ${r.sceneDir}: ${(e as Error).message}_`);
            lines.push('');
        }
    }

    return lines.join('\n');
}

function escapePipe(s: string): string {
    return s.replace(/\|/g, '\\|');
}

function resolveHeapPath(dir: string): string {
    const exact = path.join(dir, 'heap.heapprofile');
    if (fs.existsSync(exact)) return exact;
    const fallback = fs.readdirSync(dir).find(f => f.endsWith('.heapprofile'));
    if (fallback) return path.join(dir, fallback);
    throw new Error(`no .heapprofile found in ${dir}`);
}

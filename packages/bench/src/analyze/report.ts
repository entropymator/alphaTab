import fs from 'node:fs';
import path from 'node:path';
import type { ScenarioResult, ScenarioSummary } from '../harness';
import type { Scenario } from '../scenarios';
import { analyzeCpuProfile } from './cpuprof';
import { analyzeHeapProfile } from './heapprof';

export interface ScenarioReport {
    scenario: Scenario;
    /** One entry per trial. Single-trial runs have length 1. */
    trials: ScenarioResult[];
    /** Directory containing the profile files we surface in the hotspot tables. */
    sceneDir: string;
}

function fmtMs(ns: number): string {
    return (ns / 1e6).toFixed(2);
}

function fmtKb(bytes: number): string {
    return (bytes / 1024).toFixed(1);
}

/**
 * Aggregate across trials. We use median-of-medians for the central tendency
 * (robust to one slow trial from a GC pause / background load) and mean-of-
 * medians + stddev-of-medians as a diagnostic for run-to-run drift.
 */
interface AggregatedSummary {
    perTrialMedians: number[];
    medianOfMediansNs: number;
    meanOfMediansNs: number;
    /** Standard deviation across the per-trial medians. */
    crossTrialStddevNs: number;
    /** Pooled per-iteration noise (mean of single-trial median SE). */
    avgIntraTrialSeNs: number;
    /** Total iterations counted across all trials. */
    totalIterations: number;
    /** Worst single iteration observed across all trials. */
    maxNs: number;
    bestSummary: ScenarioSummary;
}

function aggregate(trials: ScenarioResult[]): AggregatedSummary {
    const perTrialMedians = trials.map(t => t.summary.medianNs);
    const sorted = [...perTrialMedians].sort((a, b) => a - b);
    const medianOfMedians = sorted[Math.floor(sorted.length / 2)];
    const mean = perTrialMedians.reduce((a, b) => a + b, 0) / perTrialMedians.length;
    const varSum = perTrialMedians.reduce((acc, v) => acc + (v - mean) ** 2, 0);
    const crossStddev = perTrialMedians.length > 1 ? Math.sqrt(varSum / (perTrialMedians.length - 1)) : 0;
    const avgSe = trials.reduce((acc, t) => acc + t.summary.medianSeNs, 0) / trials.length;
    return {
        perTrialMedians,
        medianOfMediansNs: medianOfMedians,
        meanOfMediansNs: mean,
        crossTrialStddevNs: crossStddev,
        avgIntraTrialSeNs: avgSe,
        totalIterations: trials.reduce((acc, t) => acc + t.summary.n, 0),
        maxNs: Math.max(...trials.map(t => t.summary.maxNs)),
        bestSummary: trials.reduce(
            (best, t) => (t.summary.medianNs < best.medianNs ? t.summary : best),
            trials[0].summary
        )
    };
}

export function renderReport(reports: ScenarioReport[], label: string, trialsPerScenario: number): string {
    const lines: string[] = [];
    lines.push(`# alphaTab bench report — ${label}`);
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Trials per scenario: ${trialsPerScenario}`);
    lines.push('');

    lines.push('## Wall-clock summary');
    lines.push('');
    if (trialsPerScenario > 1) {
        lines.push(
            '`median*` is the median of per-trial medians. `±` is the standard deviation across the per-trial medians — a noise floor for cross-run comparison. A delta smaller than 2× this number is not distinguishable from run-to-run drift.'
        );
        lines.push('');
        lines.push(
            '| Scenario | trials | iters/trial | median* | mean | ± cross-trial | avg intra-trial SE | min | max |'
        );
        lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
        for (const r of reports) {
            const a = aggregate(r.trials);
            const itersPerTrial = r.trials[0].summary.n;
            lines.push(
                `| ${r.scenario.id} | ${r.trials.length} | ${itersPerTrial} | ${fmtMs(a.medianOfMediansNs)} ms | ${fmtMs(a.meanOfMediansNs)} ms | ± ${fmtMs(a.crossTrialStddevNs)} ms | ${fmtMs(a.avgIntraTrialSeNs)} ms | ${fmtMs(Math.min(...r.trials.map(t => t.summary.minNs)))} ms | ${fmtMs(a.maxNs)} ms |`
            );
        }
        lines.push('');
        lines.push('Per-trial medians (ms):');
        lines.push('');
        for (const r of reports) {
            const a = aggregate(r.trials);
            lines.push(`- **${r.scenario.id}**: ${a.perTrialMedians.map(v => fmtMs(v)).join(', ')}`);
        }
        lines.push('');
    } else {
        lines.push(
            '`median ± SE` shows the asymptotic standard error of the median. A delta smaller than 2× SE is below the noise floor. Run `--trials 3+` for cross-run variance.'
        );
        lines.push('');
        lines.push('| Scenario | n | median ± SE | mean | stddev | p5 | p95 | min | max |');
        lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
        for (const r of reports) {
            const s = r.trials[0].summary;
            lines.push(
                `| ${r.scenario.id} | ${s.n} | ${fmtMs(s.medianNs)} ± ${fmtMs(s.medianSeNs)} ms | ${fmtMs(s.meanNs)} ms | ${fmtMs(s.stddevNs)} ms | ${fmtMs(s.p5Ns)} ms | ${fmtMs(s.p95Ns)} ms | ${fmtMs(s.minNs)} ms | ${fmtMs(s.maxNs)} ms |`
            );
        }
        lines.push('');
        lines.push('Per-iteration durations (ms):');
        lines.push('');
        for (const r of reports) {
            const it = r.trials[0].iterations.map(i => fmtMs(i.durationNs));
            lines.push(`- **${r.scenario.id}**: ${it.join(', ')}`);
        }
        lines.push('');
    }

    lines.push('## Stage breakdown (Profiler) — first trial');
    lines.push('');
    for (const r of reports) {
        const t = r.trials[0];
        lines.push(`### ${r.scenario.id}`);
        lines.push('');
        const stages = Object.entries(t.profiler.stages).sort((a, b) => b[1].totalNs - a[1].totalNs);
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

        const counters = Object.entries(t.profiler.counters).sort((a, b) => b[1] - a[1]);
        if (counters.length > 0) {
            lines.push('Counters:');
            lines.push('');
            for (const [name, count] of counters) {
                lines.push(`- ${name}: ${count.toLocaleString()}`);
            }
            lines.push('');
        }

        lines.push(
            `Heap delta: used ${fmtKb(t.heap.usedHeapAfter - t.heap.usedHeapBefore)} kB, total ${fmtKb(t.heap.totalHeapAfter - t.heap.totalHeapBefore)} kB`
        );
        lines.push('');
    }

    lines.push('## CPU hotspots (top 15 self-time, measured-loop only)');
    lines.push('');
    for (const r of reports) {
        const cpuPath = path.join(r.sceneDir, 'cpu.cpuprofile');
        lines.push(`### ${r.scenario.id}`);
        lines.push('');
        try {
            const cpu = analyzeCpuProfile(cpuPath);
            lines.push(
                `Total sampled: ${fmtMs(cpu.totalSelfNs)} ms across ${cpu.sampleCount.toLocaleString()} samples.`
            );
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

    lines.push('## Heap allocation hotspots (top 15 bytes, measured-loop only)');
    lines.push('');
    for (const r of reports) {
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
    if (fs.existsSync(exact)) {
        return exact;
    }
    const fallback = fs.readdirSync(dir).find(f => f.endsWith('.heapprofile'));
    if (fallback) {
        return path.join(dir, fallback);
    }
    throw new Error(`no .heapprofile found in ${dir}`);
}

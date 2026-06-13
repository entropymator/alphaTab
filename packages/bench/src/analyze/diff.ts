import fs from 'node:fs';
import path from 'node:path';

interface BaselineSummary {
    n: number;
    medianNs: number;
    meanNs: number;
    minNs: number;
    maxNs: number;
    p5Ns: number;
    p95Ns: number;
    stddevNs: number;
    medianSeNs: number;
}

interface BaselineTrial {
    summary: BaselineSummary;
    profilerStages: Record<string, { count: number; totalNs: number; maxNs: number }>;
}

interface BaselineScenario {
    id: string;
    trials: BaselineTrial[];
}

interface BaselineHost {
    hostname?: string;
    platform?: string;
    arch?: string;
    cpuModel?: string;
    cpuCount?: number;
    tasksetCores?: string | null;
    cpuGovernors?: string[];
    turboBoost?: { engine: string; on: boolean } | null;
}

interface BaselineFile {
    label: string;
    savedAt: string;
    trialsPerScenario: number;
    host?: BaselineHost;
    scenarios: BaselineScenario[];
}

function medianOf(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function crossTrialStats(trials: BaselineTrial[]): { medianNs: number; crossStddevNs: number; n: number } {
    const medians = trials.map(t => t.summary.medianNs);
    const mid = medianOf(medians);
    const mean = medians.reduce((a, b) => a + b, 0) / medians.length;
    const v = medians.reduce((acc, x) => acc + (x - mean) ** 2, 0);
    const std = medians.length > 1 ? Math.sqrt(v / (medians.length - 1)) : 0;
    return { medianNs: mid, crossStddevNs: std, n: medians.length };
}

function ms(ns: number): string {
    return (ns / 1e6).toFixed(2);
}

/**
 * Significance: a delta is below the noise floor if its magnitude is smaller
 * than 2× the pooled cross-trial stddev (a ~95 % CI proxy under normality).
 */
function significance(deltaNs: number, baseStd: number, candStd: number): string {
    const pooled = Math.sqrt(baseStd * baseStd + candStd * candStd);
    if (pooled === 0) {
        return Math.abs(deltaNs) > 0 ? '?' : '·';
    }
    const z = Math.abs(deltaNs) / pooled;
    if (z >= 2) {
        return '★';
    }
    if (z >= 1) {
        return '~';
    }
    return '·';
}

/**
 * Threshold: two baselines whose savedAt timestamps differ by more than this
 * window almost certainly come from different sessions, and so likely from
 * different host states (load, clock state, V8 warm-up). Comparing them
 * means the wall-clock σ on one side will reflect a different machine reality
 * than the other. The diff still runs — we just shout.
 */
const SAVED_AT_DRIFT_WARN_MIN = 30;

function compareHosts(a: BaselineFile, b: BaselineFile): string[] {
    const warnings: string[] = [];
    const ah = a.host;
    const bh = b.host;
    if (!ah || !bh) {
        // Pre-host-metadata baselines: nothing we can compare beyond timestamps.
    } else {
        if (ah.hostname && bh.hostname && ah.hostname !== bh.hostname) {
            warnings.push(`hostname differs: ${ah.hostname} vs ${bh.hostname} — cross-host deltas are meaningless`);
        }
        if (ah.cpuModel && bh.cpuModel && ah.cpuModel !== bh.cpuModel) {
            warnings.push(`CPU model differs: ${ah.cpuModel} vs ${bh.cpuModel}`);
        }
        const aGov = (ah.cpuGovernors ?? []).join('/');
        const bGov = (bh.cpuGovernors ?? []).join('/');
        if (aGov && bGov && aGov !== bGov) {
            warnings.push(`CPU governor differs: ${aGov} vs ${bGov}`);
        }
        const aBoost = ah.turboBoost ? String(ah.turboBoost.on) : 'unknown';
        const bBoost = bh.turboBoost ? String(bh.turboBoost.on) : 'unknown';
        if (aBoost !== 'unknown' && bBoost !== 'unknown' && aBoost !== bBoost) {
            warnings.push(`Turbo Boost differs: ${aBoost} vs ${bBoost}`);
        }
        const aPin = ah.tasksetCores ?? 'none';
        const bPin = bh.tasksetCores ?? 'none';
        if (aPin !== bPin) {
            warnings.push(`CPU pin differs: ${aPin} vs ${bPin}`);
        }
    }
    try {
        const driftMs = Math.abs(new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
        const driftMin = driftMs / 60_000;
        if (driftMin > SAVED_AT_DRIFT_WARN_MIN) {
            warnings.push(
                `baselines saved ${driftMin.toFixed(0)} min apart (> ${SAVED_AT_DRIFT_WARN_MIN} min) — likely different sessions; re-baseline candidate's pair in the same session`
            );
        }
    } catch {
        /* ignore unparseable dates */
    }
    return warnings;
}

export function diffRuns(baselinePath: string, candidatePath: string): string {
    const a = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as BaselineFile;
    const b = JSON.parse(fs.readFileSync(candidatePath, 'utf8')) as BaselineFile;

    if (a.trialsPerScenario !== b.trialsPerScenario) {
        // Hard error: comparing different trial counts means baseline and
        // candidate have systematically different σ floors, and the apparent
        // delta may be entirely an artefact of one side being measured more
        // tightly. See round summary 2026-06-13 — EW-5 paintStaffLines was
        // killed by exactly this confound.
        throw new Error(
            `baseline trials=${a.trialsPerScenario} vs candidate trials=${b.trialsPerScenario} — refusing to diff. Re-measure both at the same --trials N.`
        );
    }

    const bById = new Map(b.scenarios.map(s => [s.id, s]));

    const lines: string[] = [];
    lines.push(`# Bench diff — ${path.basename(baselinePath)} → ${path.basename(candidatePath)}`);
    lines.push('');
    lines.push(
        `baseline: trials=${a.trialsPerScenario}, label=${a.label} · candidate: trials=${b.trialsPerScenario}, label=${b.label}`
    );
    lines.push('');
    const hostWarnings = compareHosts(a, b);
    if (hostWarnings.length > 0) {
        lines.push('> ⚠️  Host / session drift detected:');
        for (const w of hostWarnings) {
            lines.push(`> - ${w}`);
        }
        lines.push('');
    }
    lines.push(
        'Significance: `★` = ≥ 2σ pooled (clear win/regression), `~` = 1-2σ (marginal), `·` = below noise floor.'
    );
    lines.push('');
    lines.push('## Median wall-clock delta');
    lines.push('');
    lines.push('| Scenario | baseline ms (±σ, n trials) | candidate ms (±σ, n trials) | Δ ms | Δ % | sig |');
    lines.push('| --- | --- | --- | ---: | ---: | :---: |');
    for (const aScen of a.scenarios) {
        const bScen = bById.get(aScen.id);
        if (!bScen) {
            const aStats = crossTrialStats(aScen.trials);
            lines.push(
                `| ${aScen.id} | ${ms(aStats.medianNs)} ± ${ms(aStats.crossStddevNs)} (n=${aStats.n}) | _missing_ | — | — | — |`
            );
            continue;
        }
        const aStats = crossTrialStats(aScen.trials);
        const bStats = crossTrialStats(bScen.trials);
        const delta = bStats.medianNs - aStats.medianNs;
        const pct = aStats.medianNs > 0 ? (delta / aStats.medianNs) * 100 : 0;
        const sig = significance(delta, aStats.crossStddevNs, bStats.crossStddevNs);
        lines.push(
            `| ${aScen.id} | ${ms(aStats.medianNs)} ± ${ms(aStats.crossStddevNs)} (n=${aStats.n}) | ${ms(bStats.medianNs)} ± ${ms(bStats.crossStddevNs)} (n=${bStats.n}) | ${delta >= 0 ? '+' : ''}${ms(delta)} | ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% | ${sig} |`
        );
    }
    lines.push('');

    lines.push('## Stage time deltas (first trial baseline → first trial candidate)');
    lines.push('');
    for (const aScen of a.scenarios) {
        const bScen = bById.get(aScen.id);
        if (!bScen) {
            continue;
        }
        const aStages = aScen.trials[0]?.profilerStages ?? {};
        const bStages = bScen.trials[0]?.profilerStages ?? {};
        const allStageNames = new Set([...Object.keys(aStages), ...Object.keys(bStages)]);
        if (allStageNames.size === 0) {
            continue;
        }
        lines.push(`### ${aScen.id}`);
        lines.push('');
        type Row = { name: string; aNs: number; bNs: number; delta: number; pct: number };
        const rows: Row[] = [];
        for (const name of allStageNames) {
            const aTotal = aStages[name]?.totalNs ?? 0;
            const bTotal = bStages[name]?.totalNs ?? 0;
            const delta = bTotal - aTotal;
            const pct = aTotal > 0 ? (delta / aTotal) * 100 : 0;
            rows.push({ name, aNs: aTotal, bNs: bTotal, delta, pct });
        }
        rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
        lines.push('| Stage | baseline ms | candidate ms | Δ ms | Δ % |');
        lines.push('| --- | ---: | ---: | ---: | ---: |');
        for (const row of rows.slice(0, 10)) {
            lines.push(
                `| ${row.name} | ${ms(row.aNs)} | ${ms(row.bNs)} | ${row.delta >= 0 ? '+' : ''}${ms(row.delta)} | ${row.pct >= 0 ? '+' : ''}${row.pct.toFixed(1)}% |`
            );
        }
        lines.push('');
    }
    return lines.join('\n');
}

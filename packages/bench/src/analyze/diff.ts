import fs from 'node:fs';
import path from 'node:path';

interface BaselineFile {
    label: string;
    savedAt: string;
    scenarios: BaselineScenario[];
}

interface BaselineScenario {
    id: string;
    summary: {
        n: number;
        medianNs: number;
        meanNs: number;
        minNs: number;
        maxNs: number;
        p5Ns: number;
        p95Ns: number;
    };
    profilerStages: Record<string, { count: number; totalNs: number; maxNs: number }>;
}

export function diffRuns(baselinePath: string, candidatePath: string): string {
    const a = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as BaselineFile;
    const b = JSON.parse(fs.readFileSync(candidatePath, 'utf8')) as BaselineFile;
    const bById = new Map(b.scenarios.map(s => [s.id, s]));

    const lines: string[] = [];
    lines.push(`# Bench diff — ${path.basename(baselinePath)} → ${path.basename(candidatePath)}`);
    lines.push('');
    lines.push('## Wall-clock median delta');
    lines.push('');
    lines.push('| Scenario | baseline ms | candidate ms | Δ ms | Δ % |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const aScen of a.scenarios) {
        const bScen = bById.get(aScen.id);
        if (!bScen) {
            lines.push(`| ${aScen.id} | ${ms(aScen.summary.medianNs)} | _missing_ | — | — |`);
            continue;
        }
        const delta = bScen.summary.medianNs - aScen.summary.medianNs;
        const pct = aScen.summary.medianNs > 0 ? (delta / aScen.summary.medianNs) * 100 : 0;
        const arrow = pct < -1 ? '↓' : pct > 1 ? '↑' : '·';
        lines.push(
            `| ${aScen.id} | ${ms(aScen.summary.medianNs)} | ${ms(bScen.summary.medianNs)} | ${delta >= 0 ? '+' : ''}${ms(delta)} | ${arrow} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% |`
        );
    }
    lines.push('');

    lines.push('## Stage time deltas (top regressions + improvements)');
    lines.push('');
    for (const aScen of a.scenarios) {
        const bScen = bById.get(aScen.id);
        if (!bScen) continue;
        lines.push(`### ${aScen.id}`);
        lines.push('');
        const allStageNames = new Set([
            ...Object.keys(aScen.profilerStages),
            ...Object.keys(bScen.profilerStages)
        ]);
        type Row = { name: string; aNs: number; bNs: number; delta: number; pct: number };
        const rows: Row[] = [];
        for (const name of allStageNames) {
            const aTotal = aScen.profilerStages[name]?.totalNs ?? 0;
            const bTotal = bScen.profilerStages[name]?.totalNs ?? 0;
            const delta = bTotal - aTotal;
            const pct = aTotal > 0 ? (delta / aTotal) * 100 : 0;
            rows.push({ name, aNs: aTotal, bNs: bTotal, delta, pct });
        }
        rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
        lines.push('| Stage | baseline ms | candidate ms | Δ ms | Δ % |');
        lines.push('| --- | ---: | ---: | ---: | ---: |');
        for (const r of rows.slice(0, 10)) {
            lines.push(
                `| ${r.name} | ${ms(r.aNs)} | ${ms(r.bNs)} | ${r.delta >= 0 ? '+' : ''}${ms(r.delta)} | ${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(1)}% |`
            );
        }
        lines.push('');
    }
    return lines.join('\n');
}

function ms(ns: number): string {
    return (ns / 1e6).toFixed(2);
}

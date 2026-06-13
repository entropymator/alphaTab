import fs from 'node:fs';

/** Subset of the V8 CPU profile JSON shape we care about. */
interface CpuProfile {
    nodes: CpuNode[];
    samples: number[];
    timeDeltas: number[];
    startTime: number;
    endTime: number;
}

interface CpuNode {
    id: number;
    callFrame: {
        functionName: string;
        url?: string;
        scriptId?: string;
        lineNumber: number;
        columnNumber: number;
    };
    hitCount?: number;
    children?: number[];
}

export interface CpuHotspot {
    functionName: string;
    location: string;
    selfNs: number;
    selfPct: number;
    samples: number;
}

export interface CpuProfileAnalysis {
    totalSelfNs: number;
    sampleCount: number;
    topSelf: CpuHotspot[];
}

/**
 * Parse a Node `--cpu-prof` output and produce a self-time ranking. Times in
 * the .cpuprofile are microseconds; we convert to nanoseconds for parity with
 * the wall-clock numbers elsewhere in the bench.
 */
export function analyzeCpuProfile(filePath: string): CpuProfileAnalysis {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CpuProfile;
    const byId = new Map<number, CpuNode>();
    for (const n of raw.nodes) {
        byId.set(n.id, n);
    }

    // Self time per node = sum of timeDeltas at samples landing on that node.
    const selfMicros = new Map<number, number>();
    const sampleCounts = new Map<number, number>();
    const samples = raw.samples;
    const deltas = raw.timeDeltas;
    let total = 0;
    for (let i = 0; i < samples.length; i++) {
        const id = samples[i];
        const delta = deltas[i];
        if (delta > 0) {
            total += delta;
            selfMicros.set(id, (selfMicros.get(id) ?? 0) + delta);
            sampleCounts.set(id, (sampleCounts.get(id) ?? 0) + 1);
        }
    }

    const entries: CpuHotspot[] = [];
    for (const [id, micros] of selfMicros) {
        const node = byId.get(id);
        if (!node) continue;
        const fn = node.callFrame.functionName || '(anonymous)';
        // Skip the synthetic root nodes that have no real frame.
        if (fn === '(root)' || fn === '(idle)' || fn === '(program)') continue;
        entries.push({
            functionName: fn,
            location: locationOf(node),
            selfNs: micros * 1000,
            selfPct: total > 0 ? micros / total : 0,
            samples: sampleCounts.get(id) ?? 0
        });
    }
    entries.sort((a, b) => b.selfNs - a.selfNs);

    return {
        totalSelfNs: total * 1000,
        sampleCount: samples.length,
        topSelf: entries
    };
}

function locationOf(node: CpuNode): string {
    const url = node.callFrame.url ?? '';
    if (!url) return '<native>';
    // Trim file:// and project prefix to keep table readable.
    const trimmed = url.replace(/^file:\/\//, '').replace(/.*?\/packages\//, 'packages/');
    return `${trimmed}:${node.callFrame.lineNumber + 1}`;
}

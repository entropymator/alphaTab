import fs from 'node:fs';

/** Subset of the V8 sampled-heap-profile JSON we care about. */
interface HeapProfileRoot {
    head: HeapNode;
}

interface HeapNode {
    callFrame: {
        functionName: string;
        url?: string;
        lineNumber: number;
        columnNumber: number;
    };
    selfSize: number;
    /** Some Node versions emit allocation counts; older ones don't. */
    selfCount?: number;
    children?: HeapNode[];
}

export interface HeapHotspot {
    functionName: string;
    location: string;
    selfBytes: number;
    selfCount: number;
}

export interface HeapProfileAnalysis {
    totalBytes: number;
    topBytes: HeapHotspot[];
}

/**
 * Parse a Node `--heap-prof` output and produce an allocation ranking.
 */
export function analyzeHeapProfile(filePath: string): HeapProfileAnalysis {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as HeapProfileRoot;
    const entries: HeapHotspot[] = [];
    let total = 0;
    walk(raw.head, entries, t => {
        total += t;
    });
    entries.sort((a, b) => b.selfBytes - a.selfBytes);
    return { totalBytes: total, topBytes: entries };
}

function walk(node: HeapNode, out: HeapHotspot[], addTotal: (n: number) => void): void {
    if (node.selfSize > 0) {
        const fn = node.callFrame.functionName || '(anonymous)';
        if (fn !== '(root)') {
            out.push({
                functionName: fn,
                location: locationOf(node),
                selfBytes: node.selfSize,
                selfCount: node.selfCount ?? 0
            });
            addTotal(node.selfSize);
        }
    }
    if (node.children) {
        for (const c of node.children) {
            walk(c, out, addTotal);
        }
    }
}

function locationOf(node: HeapNode): string {
    const url = node.callFrame.url ?? '';
    if (!url) {
        return '<native>';
    }
    const trimmed = url.replace(/^file:\/\//, '').replace(/.*?\/packages\//, 'packages/');
    return `${trimmed}:${node.callFrame.lineNumber + 1}`;
}

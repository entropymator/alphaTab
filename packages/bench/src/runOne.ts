/**
 * Child-process entry point. Runs exactly one scenario by id and writes the
 * result JSON to the path given by `--out`. The harness opens an inspector
 * session internally and scopes the CPU and heap profilers to the measured
 * loop, so the parent does NOT pass `--cpu-prof`/`--heap-prof` flags to Node
 * — those would profile the whole process including module load.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runScenario } from './harness';
import { scenarioById } from './scenarios';

function parseArgs(argv: string[]): { id: string; out: string } {
    let id: string | undefined;
    let out: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out') {
            out = argv[++i];
        } else if (!id && !a.startsWith('-')) {
            id = a;
        }
    }
    if (!id) {
        throw new Error('runOne: missing scenario id (first positional arg)');
    }
    if (!out) {
        throw new Error('runOne: missing --out <path>');
    }
    return { id, out };
}

const args = parseArgs(process.argv.slice(2));
const scenario = scenarioById(args.id);
const outDir = path.dirname(args.out);

console.error(
    `[bench] running scenario '${scenario.id}' (mode=${scenario.mode}, warmup=${scenario.warmup}, iterations=${scenario.iterations})`
);

const result = await runScenario(scenario, { outDir });

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
console.error(`[bench] wrote ${args.out}`);
console.error(
    `[bench] ${scenario.id}: median ${(result.summary.medianNs / 1e6).toFixed(2)} ms` +
        ` ± ${(result.summary.medianSeNs / 1e6).toFixed(2)} (SE),` +
        ` stddev ${(result.summary.stddevNs / 1e6).toFixed(2)} ms,` +
        ` p5 ${(result.summary.p5Ns / 1e6).toFixed(2)} ms,` +
        ` p95 ${(result.summary.p95Ns / 1e6).toFixed(2)} ms`
);

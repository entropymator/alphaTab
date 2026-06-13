/**
 * Orchestrator. Spawns one Node child per scenario with `--cpu-prof`,
 * `--heap-prof`, and `--expose-gc` flags so each scenario gets a clean V8
 * state plus per-scenario profile files on disk. Collates the per-scenario
 * JSON results and emits a combined markdown report.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { SCENARIOS, type Scenario } from './scenarios';
import { renderReport, type ScenarioReport } from './analyze/report';
import { type ScenarioResult } from './harness';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const RUN_ONE = path.join(__dirname, 'runOne.mjs');
const RUNS_ROOT = path.resolve(__dirname, '../runs');
const BASELINES_ROOT = path.resolve(__dirname, '../baselines');

function parseArgs(argv: string[]): { only?: string[]; saveBaseline?: string; label?: string } {
    let only: string[] | undefined;
    let saveBaseline: string | undefined;
    let label: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--only') {
            only = (argv[++i] ?? '').split(',').filter(Boolean);
        } else if (a === '--save-baseline') {
            saveBaseline = argv[++i] ?? 'feature-perf';
        } else if (a === '--label') {
            label = argv[++i];
        }
    }
    return { only, saveBaseline, label };
}

const args = parseArgs(process.argv.slice(2));
const label = args.label ?? new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(RUNS_ROOT, label);
fs.mkdirSync(runDir, { recursive: true });

const selected: Scenario[] = args.only
    ? SCENARIOS.filter(s => args.only!.includes(s.id))
    : SCENARIOS;
if (selected.length === 0) {
    console.error('No scenarios selected.');
    process.exit(1);
}

console.error(`[bench] run label: ${label}`);
console.error(`[bench] writing to: ${runDir}`);
console.error(`[bench] scenarios: ${selected.map(s => s.id).join(', ')}`);

const reports: ScenarioReport[] = [];

for (const scenario of selected) {
    const sceneDir = path.join(runDir, scenario.id);
    fs.mkdirSync(sceneDir, { recursive: true });
    const resultPath = path.join(sceneDir, 'result.json');

    const nodeArgs = [
        '--expose-gc',
        '--cpu-prof',
        '--cpu-prof-interval=100',
        `--cpu-prof-dir=${sceneDir}`,
        '--cpu-prof-name=cpu.cpuprofile',
        '--heap-prof',
        '--heap-prof-interval=16384',
        `--heap-prof-dir=${sceneDir}`,
        '--heap-prof-name=heap.heapprofile',
        RUN_ONE,
        scenario.id,
        '--out',
        resultPath
    ];

    const proc = spawnSync(process.execPath, nodeArgs, {
        stdio: ['ignore', 'inherit', 'inherit']
    });
    if (proc.status !== 0) {
        console.error(`[bench] scenario '${scenario.id}' exited with status ${proc.status}`);
        process.exit(proc.status ?? 1);
    }

    const result: ScenarioResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    reports.push({ scenario, result, sceneDir });
}

const reportText = renderReport(reports, label);
const reportPath = path.join(runDir, 'REPORT.md');
fs.writeFileSync(reportPath, reportText);

console.error(`\n[bench] combined report: ${reportPath}\n`);
process.stdout.write(reportText);

if (args.saveBaseline) {
    fs.mkdirSync(BASELINES_ROOT, { recursive: true });
    const baselinePath = path.join(BASELINES_ROOT, `${args.saveBaseline}.json`);
    const baselineData = {
        label,
        savedAt: new Date().toISOString(),
        scenarios: reports.map(r => ({
            id: r.scenario.id,
            summary: r.result.summary,
            profilerStages: r.result.profiler.stages
        }))
    };
    fs.writeFileSync(baselinePath, JSON.stringify(baselineData, null, 2));
    console.error(`[bench] baseline saved: ${baselinePath}`);
}

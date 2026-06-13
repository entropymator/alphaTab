/**
 * Orchestrator. Spawns one Node child per (scenario × trial). Each child runs
 * the scenario once, with CPU and heap profilers scoped to the measured loop
 * via node:inspector (NOT --cpu-prof / --heap-prof, which would profile the
 * whole process including module load and score parsing).
 *
 * `--trials N` runs each scenario N times in separate child processes so we
 * can estimate run-to-run variance. The default is 1 (fast feedback). Use
 * 3-5 trials when comparing two perf states to be confident a delta is real.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { renderReport, type ScenarioReport } from './analyze/report';
import type { ScenarioResult } from './harness';
import { SCENARIOS, type Scenario } from './scenarios';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const RUN_ONE = path.join(__dirname, 'runOne.mjs');
const RUNS_ROOT = path.resolve(__dirname, '../runs');
const BASELINES_ROOT = path.resolve(__dirname, '../baselines');

interface CliArgs {
    only?: string[];
    saveBaseline?: string;
    label?: string;
    trials: number;
}

function parseArgs(argv: string[]): CliArgs {
    const out: CliArgs = { trials: 1 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--only') {
            out.only = (argv[++i] ?? '').split(',').filter(Boolean);
        } else if (a === '--save-baseline') {
            out.saveBaseline = argv[++i] ?? 'feature-perf';
        } else if (a === '--label') {
            out.label = argv[++i];
        } else if (a === '--trials') {
            const n = Number.parseInt(argv[++i] ?? '', 10);
            if (!Number.isFinite(n) || n < 1) {
                throw new Error('--trials must be a positive integer');
            }
            out.trials = n;
        }
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const label = args.label ?? new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(RUNS_ROOT, label);
fs.mkdirSync(runDir, { recursive: true });

const selected: Scenario[] = args.only ? SCENARIOS.filter(s => args.only!.includes(s.id)) : SCENARIOS;
if (selected.length === 0) {
    console.error('No scenarios selected.');
    process.exit(1);
}

console.error(`[bench] run label: ${label}`);
console.error(`[bench] writing to: ${runDir}`);
console.error(`[bench] scenarios: ${selected.map(s => s.id).join(', ')}`);
console.error(`[bench] trials per scenario: ${args.trials}`);

const reports: ScenarioReport[] = [];

for (const scenario of selected) {
    const trials: ScenarioResult[] = [];

    for (let trial = 0; trial < args.trials; trial++) {
        const trialDir =
            args.trials === 1 ? path.join(runDir, scenario.id) : path.join(runDir, scenario.id, `trial-${trial}`);
        fs.mkdirSync(trialDir, { recursive: true });
        const resultPath = path.join(trialDir, 'result.json');

        const nodeArgs = ['--expose-gc', RUN_ONE, scenario.id, '--out', resultPath];
        const proc = spawnSync(process.execPath, nodeArgs, {
            stdio: ['ignore', 'inherit', 'inherit']
        });
        if (proc.status !== 0) {
            console.error(`[bench] scenario '${scenario.id}' trial ${trial} exited with status ${proc.status}`);
            process.exit(proc.status ?? 1);
        }

        trials.push(JSON.parse(fs.readFileSync(resultPath, 'utf8')));
    }

    // For multi-trial mode, pick the first trial's profile files for the
    // CPU/heap hotspot tables (sampled profiles aren't trivially mergeable).
    // The wall-clock + stage summary aggregates across all trials.
    const profileDir = args.trials === 1 ? path.join(runDir, scenario.id) : path.join(runDir, scenario.id, 'trial-0');
    reports.push({ scenario, trials, sceneDir: profileDir });
}

const reportText = renderReport(reports, label, args.trials);
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
        trialsPerScenario: args.trials,
        scenarios: reports.map(r => ({
            id: r.scenario.id,
            // Save one summary per trial so a future diff can use the same
            // aggregation strategy on both sides.
            trials: r.trials.map(t => ({ summary: t.summary, profilerStages: t.profiler.stages }))
        }))
    };
    fs.writeFileSync(baselinePath, JSON.stringify(baselineData, null, 2));
    console.error(`[bench] baseline saved: ${baselinePath}`);
}

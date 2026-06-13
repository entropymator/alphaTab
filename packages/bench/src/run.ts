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
import os from 'node:os';
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
    pin: string | null;
}

function parseArgs(argv: string[]): CliArgs {
    const out: CliArgs = { trials: 1, pin: 'auto' };
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
        } else if (a === '--pin') {
            out.pin = argv[++i] ?? 'auto';
        } else if (a === '--no-pin') {
            out.pin = null;
        }
    }
    return out;
}

/**
 * Determinism setup. Each scenario runs in a fresh child process, but those
 * children inherit OS-level noise: CPU frequency scaling, core migration,
 * Turbo Boost ramp-up. We pin children to a stable core set via `taskset` and
 * surface warnings (not errors — they require root to fix) when the host's
 * governor or boost state would inflate cross-trial σ.
 *
 * Tradeoff: pinning to a fixed core means we lose the OS scheduler's heat
 * balancing. For a single-process bench this is the right call — cache state
 * stays warm across trials. Reach for `--no-pin` only when running the bench
 * with other heavy workloads on the same machine.
 */
interface DeterminismSetup {
    tasksetCores: string | null;
    warnings: string[];
}

function readMaybe(p: string): string | null {
    try {
        return fs.readFileSync(p, 'utf8').trim();
    } catch {
        return null;
    }
}

function detectGovernors(): string[] {
    const govs = new Set<string>();
    const cpuDir = '/sys/devices/system/cpu';
    let entries: string[];
    try {
        entries = fs.readdirSync(cpuDir);
    } catch {
        return [];
    }
    for (const e of entries) {
        if (!/^cpu\d+$/.test(e)) {
            continue;
        }
        const g = readMaybe(path.join(cpuDir, e, 'cpufreq', 'scaling_governor'));
        if (g) {
            govs.add(g);
        }
    }
    return [...govs];
}

function detectTurboBoost(): { engine: string; on: boolean } | null {
    const intel = readMaybe('/sys/devices/system/cpu/intel_pstate/no_turbo');
    if (intel !== null) {
        return { engine: 'intel_pstate', on: intel === '0' };
    }
    const amd = readMaybe('/sys/devices/system/cpu/cpufreq/boost');
    if (amd !== null) {
        return { engine: 'cpufreq.boost', on: amd === '1' };
    }
    return null;
}

function hasTaskset(): boolean {
    const r = spawnSync('taskset', ['--version'], { stdio: 'ignore' });
    return r.status === 0;
}

function autoPickCores(): string | null {
    // Skip cpu0 — it usually handles IRQs on Linux. Prefer two physical
    // sibling cores when available. Fallback: cpus 1..min(N-1, 2).
    const n = os.cpus().length;
    if (n >= 4) {
        return '2,3';
    }
    if (n >= 2) {
        return '1';
    }
    return null;
}

function setupDeterminism(pinFlag: string | null): DeterminismSetup {
    const out: DeterminismSetup = { tasksetCores: null, warnings: [] };
    if (process.platform !== 'linux') {
        if (pinFlag !== null) {
            out.warnings.push(`platform is ${process.platform}; CPU pinning + governor checks are linux-only`);
        }
        return out;
    }

    const govs = detectGovernors();
    if (govs.length > 0 && !govs.every(g => g === 'performance')) {
        out.warnings.push(
            `CPU governor is ${govs.join('/')} — variance will be high. Fix: sudo cpupower frequency-set -g performance`
        );
    }

    const boost = detectTurboBoost();
    if (boost?.on) {
        out.warnings.push(
            `Turbo Boost is ON (${boost.engine}) — first-trial clock differs from sustained. Fix: sudo bash -c 'echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo' (or amd: echo 0 > /sys/devices/system/cpu/cpufreq/boost)`
        );
    }

    if (pinFlag === null) {
        return out;
    }
    if (!hasTaskset()) {
        out.warnings.push('taskset not found — child processes will float across cores (high variance)');
        return out;
    }
    const cores = pinFlag === 'auto' ? autoPickCores() : pinFlag;
    if (!cores) {
        out.warnings.push(`could not auto-pick cores (only ${os.cpus().length} cpus visible)`);
        return out;
    }
    out.tasksetCores = cores;
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

const determinism = setupDeterminism(args.pin);
for (const w of determinism.warnings) {
    console.error(`[bench] WARN: ${w}`);
}

console.error(`[bench] run label: ${label}`);
console.error(`[bench] writing to: ${runDir}`);
console.error(`[bench] scenarios: ${selected.map(s => s.id).join(', ')}`);
console.error(`[bench] trials per scenario: ${args.trials}`);
if (determinism.tasksetCores) {
    console.error(`[bench] pinning children to cores: ${determinism.tasksetCores} (taskset)`);
}

const reports: ScenarioReport[] = [];

for (const scenario of selected) {
    const trials: ScenarioResult[] = [];

    for (let trial = 0; trial < args.trials; trial++) {
        const trialDir =
            args.trials === 1 ? path.join(runDir, scenario.id) : path.join(runDir, scenario.id, `trial-${trial}`);
        fs.mkdirSync(trialDir, { recursive: true });
        const resultPath = path.join(trialDir, 'result.json');

        const nodeArgs = ['--expose-gc', RUN_ONE, scenario.id, '--out', resultPath];
        const proc = determinism.tasksetCores
            ? spawnSync('taskset', ['-c', determinism.tasksetCores, process.execPath, ...nodeArgs], {
                  stdio: ['ignore', 'inherit', 'inherit']
              })
            : spawnSync(process.execPath, nodeArgs, {
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
        host: {
            hostname: os.hostname(),
            platform: process.platform,
            arch: process.arch,
            cpuModel: os.cpus()[0]?.model ?? 'unknown',
            cpuCount: os.cpus().length,
            tasksetCores: determinism.tasksetCores,
            cpuGovernors: detectGovernors(),
            turboBoost: detectTurboBoost()
        },
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

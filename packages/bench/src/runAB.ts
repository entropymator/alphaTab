/**
 * Same-process A/B driver. Loads two pre-built `runOneCore.*.mjs` bundles
 * via dynamic import — Node ESM caches modules by URL, so two distinct
 * file paths give two distinct module records with their own alphatab
 * instances. V8's optimised code cache is still shared across both arms
 * (same isolate), and the OS scheduler / CPU pin / thermal state are
 * identical for the back-to-back A→B iterations. The resulting per-
 * iteration paired delta has dramatically less variance than two
 * independent runs.
 *
 * The driver does NOT run the inspector (CPU + heap) profilers. Those
 * cost cross-arm comparability — sampling state from arm A's
 * iterations would bleed into arm B's profile. Use the regular
 * `run.mjs` flow when you need a profile; use this when you need a
 * decisive A/B verdict.
 *
 * Iteration order: ABBA-blocks instead of strict ABAB. ABBA gives B a
 * fair shake at being the first call (the very first one tier-ups V8's
 * code) and balances any cache-state asymmetry from A-then-B
 * orderings. Over N iterations, half the pairs are (A,B) and half are
 * (B,A) — the per-iteration delta is recorded in chronological order
 * for diagnosability.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { type PairedSample, type PairedSummary, summarizePaired } from './analyze/pairedStats';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const RUNS_ROOT = path.resolve(__dirname, '../runs');

interface CliArgs {
    armA: string;
    armB: string;
    only?: string[];
    label?: string;
    iterations?: number;
}

function parseArgs(argv: string[]): CliArgs {
    let armA: string | undefined;
    let armB: string | undefined;
    const out: Partial<CliArgs> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--a') {
            armA = argv[++i];
        } else if (a === '--b') {
            armB = argv[++i];
        } else if (a === '--only') {
            out.only = (argv[++i] ?? '').split(',').filter(Boolean);
        } else if (a === '--label') {
            out.label = argv[++i];
        } else if (a === '--iterations') {
            const n = Number.parseInt(argv[++i] ?? '', 10);
            if (!Number.isFinite(n) || n < 4) {
                throw new Error('--iterations must be ≥ 4 (paired stats need a few pairs)');
            }
            out.iterations = n;
        }
    }
    if (!armA || !armB) {
        throw new Error('runAB: missing --a <path> and --b <path>');
    }
    return { armA, armB, ...out };
}

interface CoreModule {
    prepareScenario: typeof import('./runOneCore').prepareScenario;
    SCENARIOS: typeof import('./runOneCore').SCENARIOS;
    scenarioById: typeof import('./runOneCore').scenarioById;
}

async function loadArm(p: string): Promise<CoreModule> {
    // url.pathToFileURL so Node ESM uses a file:// URL key — required for
    // relative paths to be importable from outside the bundler's tree.
    const u = url.pathToFileURL(path.resolve(p));
    return (await import(u.href)) as CoreModule;
}

function runOnePair(coreA: CoreModule, coreB: CoreModule, scenarioId: string, iterations: number): PairedSample[] {
    const scA = coreA.scenarioById(scenarioId);
    const scB = coreB.scenarioById(scenarioId);
    if (scA.id !== scB.id || scA.mode !== scB.mode) {
        throw new Error(`scenario shape diverged: A=${scA.id}/${scA.mode} B=${scB.id}/${scB.mode}`);
    }

    // One-time setup per arm: load score, build renderer, initial render,
    // run the scenario's warmup loop. From here on, `tick()` runs only the
    // measured body.
    const armA = coreA.prepareScenario(scA);
    const armB = coreB.prepareScenario(scB);

    // Extra cross-arm warmup so V8 has tier-up'd both arms' driveOnce
    // before sampling. Each `prepareScenario` already ran its own per-arm
    // warmup; this loop ensures BOTH arms are warm in the same V8 isolate.
    for (let i = 0; i < 5; i++) {
        armA.tick();
        armB.tick();
    }
    if (global.gc) {
        global.gc();
    }

    // Measured loop: simple AB pairs. The two `tick()`s happen back-to-back
    // in the same Node process so they share cache state and CPU pin —
    // per-iteration delta variance is dramatically smaller than independent-
    // run variance. Half the pairs use AB order and half use BA so any
    // first-call-after-the-other asymmetry averages out.
    const samples: PairedSample[] = [];
    for (let i = 0; i < iterations; i++) {
        if (i % 2 === 0) {
            const a = armA.tick();
            const b = armB.tick();
            samples.push({ aNs: a, bNs: b });
        } else {
            const b = armB.tick();
            const a = armA.tick();
            samples.push({ aNs: a, bNs: b });
        }
    }
    return samples;
}

const args = parseArgs(process.argv.slice(2));
const label = args.label ?? `ab-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const runDir = path.join(RUNS_ROOT, label);
fs.mkdirSync(runDir, { recursive: true });

console.error(`[bench-ab] arm A: ${args.armA}`);
console.error(`[bench-ab] arm B: ${args.armB}`);
console.error(`[bench-ab] label: ${label}`);

const coreA = await loadArm(args.armA);
const coreB = await loadArm(args.armB);

const allScenarios = coreA.SCENARIOS;
const selected = args.only ? allScenarios.filter(s => args.only!.includes(s.id)) : allScenarios;
if (selected.length === 0) {
    console.error('[bench-ab] no scenarios selected');
    process.exit(1);
}

interface ScenarioReport {
    id: string;
    iterations: number;
    samples: PairedSample[];
    summary: PairedSummary;
}

const reports: ScenarioReport[] = [];

for (const scenario of selected) {
    // Default to the scenario's own iterations count, but we run them as
    // ABBA-blocked single calls so the total pair count matches.
    const iters = args.iterations ?? scenario.iterations * 2;
    console.error(`[bench-ab] scenario '${scenario.id}' — pairs=${iters}`);

    const samples = runOnePair(coreA, coreB, scenario.id, iters);
    const summary = summarizePaired(samples);
    reports.push({ id: scenario.id, iterations: samples.length, samples, summary });

    const ms = (ns: number) => (ns / 1e6).toFixed(2);
    console.error(
        `[bench-ab] ${scenario.id}: A=${ms(summary.medianANs)} B=${ms(summary.medianBNs)} ` +
            `Δ=${summary.medianDeltaNs >= 0 ? '+' : ''}${ms(summary.medianDeltaNs)} ms ` +
            `(${summary.medianDeltaPct >= 0 ? '+' : ''}${summary.medianDeltaPct.toFixed(1)}%) ` +
            `CI=[${ms(summary.ci95LowNs)}, ${ms(summary.ci95HighNs)}] ` +
            `B<A in ${summary.bFasterCount}/${summary.n} (z=${summary.signZ.toFixed(2)}) ` +
            `sig=${summary.sig}`
    );
}

const ms = (ns: number) => (ns / 1e6).toFixed(2);
const lines: string[] = [];
lines.push(`# A/B bench report — ${label}`);
lines.push('');
lines.push(`arm A: ${args.armA}`);
lines.push(`arm B: ${args.armB}`);
lines.push('');
lines.push(
    'Paired per-iteration measurement. CI is bootstrap 95 % on median delta; sign-test z = (B<A iterations − N/2) / √(N/4). `★` = CI excludes 0 AND |z| ≥ 2; `~` = one of the two; `·` = neither.'
);
lines.push('');
lines.push('| Scenario | n | median A ms | median B ms | Δ ms | Δ % | 95% CI ms | B<A | sign z | sig |');
lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | :---: |');
for (const r of reports) {
    const s = r.summary;
    lines.push(
        `| ${r.id} | ${r.iterations} | ${ms(s.medianANs)} | ${ms(s.medianBNs)} | ${s.medianDeltaNs >= 0 ? '+' : ''}${ms(s.medianDeltaNs)} | ${s.medianDeltaPct >= 0 ? '+' : ''}${s.medianDeltaPct.toFixed(1)}% | [${ms(s.ci95LowNs)}, ${ms(s.ci95HighNs)}] | ${s.bFasterCount}/${s.n} | ${s.signZ.toFixed(2)} | ${s.sig} |`
    );
}
lines.push('');
lines.push('## Raw paired samples (per iteration, ms)');
lines.push('');
for (const r of reports) {
    lines.push(`### ${r.id}`);
    lines.push('');
    lines.push('| iter | A ms | B ms | Δ ms |');
    lines.push('| ---: | ---: | ---: | ---: |');
    for (let i = 0; i < r.samples.length; i++) {
        const s = r.samples[i];
        const d = s.bNs - s.aNs;
        lines.push(`| ${i} | ${ms(s.aNs)} | ${ms(s.bNs)} | ${d >= 0 ? '+' : ''}${ms(d)} |`);
    }
    lines.push('');
}

const reportText = lines.join('\n');
const reportPath = path.join(runDir, 'REPORT.md');
fs.writeFileSync(reportPath, reportText);
console.error(`\n[bench-ab] report: ${reportPath}\n`);
process.stdout.write(reportText);

const summaryJsonPath = path.join(runDir, 'summary.json');
fs.writeFileSync(
    summaryJsonPath,
    JSON.stringify(
        {
            label,
            armA: args.armA,
            armB: args.armB,
            savedAt: new Date().toISOString(),
            scenarios: reports.map(r => ({ id: r.id, iterations: r.iterations, summary: r.summary }))
        },
        null,
        2
    )
);

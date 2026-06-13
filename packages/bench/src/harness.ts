import fs from 'node:fs';
import inspector from 'node:inspector/promises';
import path from 'node:path';
import * as v8 from 'node:v8';

import { Environment } from '@coderline/alphatab/Environment';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { Profiler, type ProfilerSnapshot } from '@coderline/alphatab/profiling/Profiler';
import { ScoreRenderer } from '@coderline/alphatab/rendering/ScoreRenderer';
import { Settings } from '@coderline/alphatab/Settings';
import type { Scenario } from './scenarios';

function makeSettings(): Settings {
    const settings = new Settings();
    // SVG is the primary engine in the web version of alphaTab, and what the
    // user actually feels when resizing. We measure that path. CssFontSvgCanvas
    // generates markup as strings, so it has no DOM dependency in Node — the
    // measurement layer (FontSizes) falls back to a constant character-width
    // table on Node.js, which gives reproducible (if visually imprecise)
    // numbers. Layout cost — what we're profiling — is unaffected.
    settings.core.engine = 'svg';
    settings.core.enableLazyLoading = false;
    Environment.highDpiFactor = 1;
    settings.display.resources.tablatureFont.families = ['Noto Sans', 'Noto Music', 'Noto Color Emoji'];
    settings.display.resources.graceFont.families = ['Noto Sans', 'Noto Music', 'Noto Color Emoji'];
    settings.display.resources.numberedNotationFont.families = ['Noto Sans', 'Noto Music', 'Noto Color Emoji'];
    settings.display.resources.numberedNotationGraceFont.families = ['Noto Sans', 'Noto Music', 'Noto Color Emoji'];
    for (const f of settings.display.resources.elementFonts.values()) {
        if (f.families.includes('sans-serif')) {
            f.families = ['Noto Sans', 'Noto Music', 'Noto Color Emoji'];
        } else {
            f.families = ['Noto Serif', 'Noto Music', 'Noto Color Emoji'];
        }
    }
    return settings;
}

export interface IterationResult {
    /** Wall-clock duration in nanoseconds. */
    durationNs: number;
}

export interface ScenarioSummary {
    n: number;
    medianNs: number;
    meanNs: number;
    minNs: number;
    maxNs: number;
    p5Ns: number;
    p95Ns: number;
    /** Sample standard deviation across iterations. */
    stddevNs: number;
    /**
     * Approximate standard error of the median, computed as
     * 1.2533 * stddev / sqrt(n) (the asymptotic SE of the median for a
     * normal distribution). Useful as a noise-floor guide when comparing
     * two runs — wins below ~2× SE are not distinguishable from noise.
     */
    medianSeNs: number;
}

export interface ScenarioResult {
    scenarioId: string;
    iterations: IterationResult[];
    /**
     * Profiler stage stats accumulated across the measured iterations only
     * (Profiler.reset() is called immediately before the measured loop).
     */
    profiler: ProfilerSnapshot;
    /** v8.getHeapStatistics() before and after the measured loop. */
    heap: {
        usedHeapBefore: number;
        usedHeapAfter: number;
        totalHeapBefore: number;
        totalHeapAfter: number;
    };
    summary: ScenarioSummary;
}

function summarize(iterations: IterationResult[]): ScenarioSummary {
    const durations = iterations.map(i => i.durationNs).sort((a, b) => a - b);
    const n = durations.length;
    const sum = durations.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const varianceSum = durations.reduce((acc, d) => acc + (d - mean) ** 2, 0);
    const stddev = n > 1 ? Math.sqrt(varianceSum / (n - 1)) : 0;
    return {
        n,
        medianNs: durations[Math.floor(n / 2)],
        meanNs: mean,
        minNs: durations[0],
        maxNs: durations[n - 1],
        p5Ns: durations[Math.floor(n * 0.05)],
        p95Ns: durations[Math.floor(n * 0.95)],
        stddevNs: stddev,
        medianSeNs: n > 1 ? (1.2533 * stddev) / Math.sqrt(n) : 0
    };
}

export interface RunOptions {
    /** Where to write `cpu.cpuprofile` and `heap.heapprofile`. */
    outDir: string;
}

export interface PreparedScenario {
    /** Run one iteration of the scenario, return its wall-clock duration in ns. */
    tick(): number;
}

/**
 * Variant of `runScenario` for the paired A/B driver. Sets up the score,
 * renderer, and initial render ONCE (those costs are not what we're
 * measuring), runs the scenario's warmup, then returns a `tick()` that
 * executes exactly one iteration of `driveOnce` and returns its wall-clock
 * duration. The driver alternates `tick()` calls between two prepared arms
 * to get per-iteration paired samples within a single Node process.
 *
 * Does NOT enable the CPU / heap inspector profilers — those would
 * cross-contaminate between the two arms in one isolate. Use the regular
 * `runScenario` flow when you need a profile.
 */
export function prepareScenario(scenario: Scenario): PreparedScenario {
    const settings = makeSettings();

    const data = fs.readFileSync(scenario.scorePath);
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const score = ScoreLoader.loadScoreFromBytes(bytes, settings);

    const tracks = scenario.tracks ?? [0];
    const renderer = new ScoreRenderer(settings);
    renderer.width = scenario.width;

    const driveOnce = () => {
        if (scenario.mode === 'render') {
            renderer.renderScore(score, tracks);
        } else {
            const widths = scenario.resizeWidths!;
            for (const w of widths) {
                renderer.width = w;
                renderer.resizeRender();
            }
            renderer.width = scenario.width;
            renderer.resizeRender();
        }
    };

    if (scenario.mode === 'resize') {
        renderer.renderScore(score, tracks);
    }
    for (let i = 0; i < scenario.warmup; i++) {
        driveOnce();
    }

    return {
        tick(): number {
            const t0 = process.hrtime.bigint();
            driveOnce();
            const t1 = process.hrtime.bigint();
            return Number(t1 - t0);
        }
    };
}

/**
 * Runs one scenario in the current process. CPU and heap profilers are
 * scoped via the node:inspector API to the measured loop only — warmup,
 * module load, and score loading are excluded — so the resulting profiles
 * are not contaminated by one-time startup costs.
 */
export async function runScenario(scenario: Scenario, options: RunOptions): Promise<ScenarioResult> {
    const settings = makeSettings();

    const data = fs.readFileSync(scenario.scorePath);
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const score = ScoreLoader.loadScoreFromBytes(bytes, settings);

    const tracks = scenario.tracks ?? [0];
    const renderer = new ScoreRenderer(settings);
    renderer.width = scenario.width;

    const driveOnce = () => {
        if (scenario.mode === 'render') {
            renderer.renderScore(score, tracks);
        } else {
            const widths = scenario.resizeWidths!;
            for (const w of widths) {
                renderer.width = w;
                renderer.resizeRender();
            }
            renderer.width = scenario.width;
            renderer.resizeRender();
        }
    };

    if (scenario.mode === 'resize') {
        renderer.renderScore(score, tracks);
    }
    for (let i = 0; i < scenario.warmup; i++) {
        driveOnce();
    }

    if (global.gc) {
        global.gc();
    }

    const session = new inspector.Session();
    session.connect();
    try {
        await session.post('Profiler.enable');
        await session.post('Profiler.setSamplingInterval', { interval: 100 });
        await session.post('Profiler.start');

        await session.post('HeapProfiler.enable');
        await session.post('HeapProfiler.startSampling', { samplingInterval: 16384 });

        Profiler.reset();
        const heapBefore = v8.getHeapStatistics();
        const iterations: IterationResult[] = [];

        for (let i = 0; i < scenario.iterations; i++) {
            const t0 = process.hrtime.bigint();
            driveOnce();
            const t1 = process.hrtime.bigint();
            iterations.push({ durationNs: Number(t1 - t0) });
        }

        const heapAfter = v8.getHeapStatistics();
        const profiler = Profiler.snapshot();

        const cpu = await session.post('Profiler.stop');
        const heap = await session.post('HeapProfiler.stopSampling');

        fs.mkdirSync(options.outDir, { recursive: true });
        fs.writeFileSync(
            path.join(options.outDir, 'cpu.cpuprofile'),
            JSON.stringify((cpu as { profile: unknown }).profile)
        );
        fs.writeFileSync(
            path.join(options.outDir, 'heap.heapprofile'),
            JSON.stringify((heap as { profile: unknown }).profile)
        );

        return {
            scenarioId: scenario.id,
            iterations,
            profiler,
            heap: {
                usedHeapBefore: heapBefore.used_heap_size,
                usedHeapAfter: heapAfter.used_heap_size,
                totalHeapBefore: heapBefore.total_heap_size,
                totalHeapAfter: heapAfter.total_heap_size
            },
            summary: summarize(iterations)
        };
    } finally {
        session.disconnect();
    }
}

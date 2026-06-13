import fs from 'node:fs';
import * as v8 from 'node:v8';

import { Environment } from '@coderline/alphatab/Environment';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { Profiler, type ProfilerSnapshot } from '@coderline/alphatab/profiling/Profiler';
import { ScoreRenderer } from '@coderline/alphatab/rendering/ScoreRenderer';
import { Settings } from '@coderline/alphatab/Settings';
import { type Scenario } from './scenarios';

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

export interface ScenarioResult {
    scenarioId: string;
    iterations: IterationResult[];
    /** Profiler snapshot accumulated across measured iterations. */
    profiler: ProfilerSnapshot;
    /** Heap stats sampled before/after the measured loop. */
    heap: {
        usedHeapBefore: number;
        usedHeapAfter: number;
        totalHeapBefore: number;
        totalHeapAfter: number;
    };
    /** Iteration counts and median wall times for the report. */
    summary: {
        n: number;
        medianNs: number;
        meanNs: number;
        minNs: number;
        maxNs: number;
        p5Ns: number;
        p95Ns: number;
    };
}

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
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
            // For resize: keep one rendered baseline across iterations.
            // Each measured iteration runs through every resize width once.
            const widths = scenario.resizeWidths!;
            for (const w of widths) {
                renderer.width = w;
                renderer.resizeRender();
            }
            // Reset to initial width so the next iteration starts from the same state.
            renderer.width = scenario.width;
            renderer.resizeRender();
        }
    };

    // Warmup
    if (scenario.mode === 'resize') {
        // resize needs an initial full render before resizeRender works.
        renderer.renderScore(score, tracks);
    }
    for (let i = 0; i < scenario.warmup; i++) {
        driveOnce();
    }

    // Force a GC if exposed to flatten warmup noise.
    if (global.gc) {
        global.gc();
    }

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

    const durations = iterations.map(i => i.durationNs).sort((a, b) => a - b);
    const sum = durations.reduce((a, b) => a + b, 0);
    const summary = {
        n: durations.length,
        medianNs: durations[Math.floor(durations.length / 2)],
        meanNs: sum / durations.length,
        minNs: durations[0],
        maxNs: durations[durations.length - 1],
        p5Ns: durations[Math.floor(durations.length * 0.05)],
        p95Ns: durations[Math.floor(durations.length * 0.95)]
    };

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
        summary
    };
}

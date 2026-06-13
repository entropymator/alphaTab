/**
 * Profiling instrumentation. All call sites are guarded by
 * `if (__PROFILING__) { ... }` blocks that DCE away in production builds.
 *
 * In a profiling build (packages/bench), measurements accumulate into the
 * static fields below and are dumped via {@link Profiler.snapshot}. The bench
 * harness reads the snapshot at the end of each scenario iteration.
 */

export interface StageStats {
    count: number;
    totalNs: number;
    maxNs: number;
}

export interface ProfilerSnapshot {
    stages: Record<string, StageStats>;
    counters: Record<string, number>;
}

const STACK_LIMIT = 64;

export class Profiler {
    private static readonly _stages = new Map<string, StageStats>();
    private static readonly _counters = new Map<string, number>();
    private static readonly _stack: { name: string; startNs: number }[] = [];

    static begin(name: string): void {
        // Nested timers (e.g. layout.doLayout inside render.layoutAndRender)
        // are tracked via a small stack. Mismatched begin/end pairs throw so
        // the harness fails loudly during a bench run.
        if (Profiler._stack.length >= STACK_LIMIT) {
            throw new Error(`Profiler stack overflow on '${name}'`);
        }
        Profiler._stack.push({ name, startNs: nowNs() });
    }

    static end(name: string): void {
        const top = Profiler._stack.pop();
        if (!top || top.name !== name) {
            throw new Error(
                `Profiler.end('${name}') mismatched; expected '${top?.name ?? '<empty>'}'`
            );
        }
        const elapsed = nowNs() - top.startNs;
        const stats = Profiler._stages.get(name);
        if (stats === undefined) {
            Profiler._stages.set(name, { count: 1, totalNs: elapsed, maxNs: elapsed });
        } else {
            stats.count++;
            stats.totalNs += elapsed;
            if (elapsed > stats.maxNs) {
                stats.maxNs = elapsed;
            }
        }
    }

    static bump(name: string, delta: number = 1): void {
        Profiler._counters.set(name, (Profiler._counters.get(name) ?? 0) + delta);
    }

    static snapshot(): ProfilerSnapshot {
        const stages: Record<string, StageStats> = {};
        for (const [name, stats] of Profiler._stages) {
            stages[name] = { count: stats.count, totalNs: stats.totalNs, maxNs: stats.maxNs };
        }
        const counters: Record<string, number> = {};
        for (const [name, value] of Profiler._counters) {
            counters[name] = value;
        }
        return { stages, counters };
    }

    static reset(): void {
        Profiler._stages.clear();
        Profiler._counters.clear();
        Profiler._stack.length = 0;
    }
}

function nowNs(): number {
    // performance.now() returns ms with sub-microsecond resolution; convert to
    // integer ns so accumulated totals don't drift from float rounding.
    return Math.round(performance.now() * 1_000_000);
}

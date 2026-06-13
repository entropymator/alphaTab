import MagicString from 'magic-string';
import type { Plugin } from 'vite';

/**
 * Strips profiler instrumentation from alphatab source at transform time.
 *
 * Call sites in the source tree look like
 *
 *     import { Profiler } from '@coderline/alphatab/profiling/Profiler';
 *     // ...
 *     Profiler.begin('render.total');
 *     // ... work ...
 *     Profiler.end('render.total');
 *
 * with no conditional guard. When this plugin is added with `enabled: false`
 * (the default for production / library / vitest / playground builds), it
 * deletes the import line and every `Profiler.<method>(...)` statement from
 * each transformed module. Once those statements vanish, tree-shaking drops
 * the {@link Profiler} module from the output bundle entirely — verified by
 * `grep -c Profiler dist/alphaTab*.{mjs,js}` returning 0.
 *
 * When `enabled: true` (packages/bench), the plugin is a passthrough and the
 * calls stay in the bundle so the harness can read measurements.
 *
 * The Profiler module itself is exempt; statements inside it would otherwise
 * be eaten alive.
 */
export function stripProfilingPlugin(options: { enabled: boolean }): Plugin {
    const importLine = /^[\t ]*import\s*\{\s*Profiler\s*\}\s*from\s*['"][^'"]*profiling\/Profiler['"]\s*;?[\t ]*\r?\n/m;
    const callStatement = /^[\t ]*Profiler\.[A-Za-z_$][\w$]*\s*\([^()\n]*\)\s*;?[\t ]*\r?\n/gm;

    return {
        name: 'alphatab:strip-profiling',
        enforce: 'pre',
        transform(code, id) {
            if (options.enabled) {
                return null;
            }
            if (!code.includes('Profiler')) {
                return null;
            }
            // Don't eat the Profiler module's own methods.
            if (/[\\/]profiling[\\/]Profiler\.ts$/.test(id)) {
                return null;
            }

            const ms = new MagicString(code);
            let changed = false;

            const importMatch = importLine.exec(code);
            if (importMatch && importMatch.index !== undefined) {
                ms.remove(importMatch.index, importMatch.index + importMatch[0].length);
                changed = true;
            }

            for (const m of code.matchAll(callStatement)) {
                if (m.index === undefined) {
                    continue;
                }
                ms.remove(m.index, m.index + m[0].length);
                changed = true;
            }

            if (!changed) {
                return null;
            }

            return {
                code: ms.toString(),
                map: ms.generateMap({ hires: 'boundary' })
            };
        }
    };
}

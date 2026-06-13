import path from 'node:path';
import url from 'node:url';
import type { OutputOptions } from 'rollup';
import { defineConfig } from 'vite';
import { defaultBuildUserConfig } from '../tooling/src/vite';
import { stripProfilingPlugin } from '../tooling/src/vite.plugin.strip-profiling';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(() => {
    const config = defaultBuildUserConfig(__dirname);

    // The bench is the one consumer that keeps profiler calls in the bundle.
    // Drop the default `enabled: false` strip plugin inherited from
    // `defaultBuildUserConfig`, replace with `enabled: true` (passthrough).
    // Also drop the license-banner plugin — this is an internal bench, not a
    // published artifact, and the banner plugin demands a LICENSE.header file.
    config.plugins = (config.plugins ?? []).filter(p => {
        if (!p || typeof p !== 'object' || !('name' in p)) {
            return true;
        }
        const name = (p as { name: string }).name;
        return name !== 'rollup-plugin-license' && name !== 'alphatab:strip-profiling';
    });
    config.plugins.push(stripProfilingPlugin({ enabled: true }));

    const alphatabSrc = process.env.ALPHATAB_SRC;
    const lib = config.build!.lib!;

    if (alphatabSrc) {
        // A/B build mode. Only the runOneCore entry is built, and the
        // output is forced into a single self-contained ESM file so the
        // two arms' bundles never share a chunk (which Node ESM would
        // dedup by URL, defeating the per-arm isolation).
        (lib as { entry: Record<string, string> }).entry = {
            runOneCore: path.resolve(__dirname, 'src/runOneCore.ts')
        };
        const outputs = config.build!.rollupOptions!.output as OutputOptions[];
        for (const o of outputs) {
            o.inlineDynamicImports = true;
        }

        // Redirect the `@coderline/alphatab` aliases to the provided source
        // tree (typically a git worktree at a different ref). Same shape as
        // the tsconfig path mappings.
        const aliases = (config.resolve?.alias ?? []) as Array<{ find: RegExp | string; replacement: string }>;
        // Drop ONLY the alphatab aliases (not alphatab-csharp / alphatab-kotlin /
        // alphasynth / etc.). RegExp.source has `\/` (escaped) so we test
        // against the regex itself, not its serialised form.
        const filtered = aliases.filter(a => {
            const f = a.find;
            if (typeof f === 'string') {
                return f !== '@coderline/alphatab' && !f.startsWith('@coderline/alphatab/');
            }
            return !f.test('@coderline/alphatab') && !f.test('@coderline/alphatab/anything');
        });
        // `$1` must survive into the alias replacement string — `path.resolve`
        // would expand it to a literal directory at config-load time.
        filtered.push({
            find: /^@coderline\/alphatab\/(.*)$/,
            replacement: `${alphatabSrc}/$1`
        });
        filtered.push({
            find: /^@coderline\/alphatab$/,
            replacement: `${alphatabSrc}/alphaTab.main`
        });
        (config.resolve as { alias: typeof filtered }).alias = filtered;
        console.error(`[vite.config] A/B mode — ALPHATAB_SRC=${alphatabSrc}`);
        console.error(
            `[vite.config] aliases: ${filtered
                .map(a => {
                    const f = a.find;
                    const s = typeof f === 'string' ? f : f.source;
                    return `${s} -> ${a.replacement}`;
                })
                .filter(s => s.includes('@coderline'))
                .join(' | ')}`
        );
    } else {
        (lib as { entry: Record<string, string> }).entry = {
            run: path.resolve(__dirname, 'src/run.ts'),
            runOne: path.resolve(__dirname, 'src/runOne.ts'),
            runAB: path.resolve(__dirname, 'src/runAB.ts'),
            cli: path.resolve(__dirname, 'src/cli.ts')
        };
    }

    // Output dir is overridable via BENCH_OUTDIR (used by scripts/build-ab.mjs
    // to land each arm's bundle in its own directory; vite's `--outDir` CLI
    // flag doesn't override rollup's explicit `output.dir`).
    const outDir = process.env.BENCH_OUTDIR ?? 'dist/';
    (config.build!.rollupOptions!.output as OutputOptions[]).push({
        dir: outDir,
        format: 'es',
        entryFileNames: '[name].mjs',
        chunkFileNames: '[name].mjs'
    });

    // Externalize Node built-ins and the native alphaskia bindings.
    const ext = config.build!.rollupOptions!.external as (string | RegExp)[];
    ext.push('@coderline/alphaskia');
    ext.push(/^@coderline\/alphaskia-/);

    config.build!.ssr = true;
    config.build!.sourcemap = true;

    return config;
});

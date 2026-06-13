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

    const lib = config.build!.lib!;
    (lib as { entry: Record<string, string> }).entry = {
        run: path.resolve(__dirname, 'src/run.ts'),
        runOne: path.resolve(__dirname, 'src/runOne.ts'),
        cli: path.resolve(__dirname, 'src/cli.ts')
    };

    (config.build!.rollupOptions!.output as OutputOptions[]).push({
        dir: 'dist/',
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

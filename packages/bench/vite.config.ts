import path from 'node:path';
import url from 'node:url';
import type { OutputOptions } from 'rollup';
import { defineConfig } from 'vite';
import { defaultBuildUserConfig, profilingDefine } from '../tooling/src/vite';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(() => {
    const config = defaultBuildUserConfig(__dirname);

    // Override the inherited `__PROFILING__: false` from defaultBuildUserConfig.
    // The bench bundles alphatab source with profiling baked in; everything else
    // (the published library, vitest visual tests, sibling plugin packages)
    // keeps the default `false` and strips the profiler bodies out.
    config.define = { ...config.define, ...profilingDefine(true) };

    // Drop the license-banner plugin — this is an internal bench, not a
    // published artifact, and the banner plugin demands a LICENSE.header file.
    config.plugins = (config.plugins ?? []).filter(
        p => !(p && typeof p === 'object' && 'name' in p && (p as { name: string }).name === 'rollup-plugin-license')
    );

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

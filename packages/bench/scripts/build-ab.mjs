#!/usr/bin/env node
/**
 * Build two bench bundles for A/B comparison. Each arm's `runOneCore.mjs`
 * is bundled with alphatab resolved from a specific source tree, so the
 * two arms differ ONLY in the alphatab content — bench source code and
 * dependencies are identical across them.
 *
 * Usage:
 *   node scripts/build-ab.mjs --ref-a <git-ref> [--ref-b <git-ref>]
 *
 * If `--ref-b` is omitted, arm B is built from the working tree's
 * `packages/alphatab/src` — handy for measuring an uncommitted patch
 * against an existing commit (`--ref-a HEAD` measures working tree vs HEAD).
 *
 * Outputs:
 *   dist/ab/A/runOneCore.mjs   ← arm A (passed to runAB as --a)
 *   dist/ab/B/runOneCore.mjs   ← arm B (passed to runAB as --b)
 *
 * Each arm's bundle is built into its own output directory so chunk
 * filenames don't collide between arms.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const BENCH_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BENCH_DIR, '../..');

function parseArgs(argv) {
    let refA = null;
    let refB = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--ref-a') {
            refA = argv[++i];
        } else if (a === '--ref-b') {
            refB = argv[++i];
        } else if (a === '-h' || a === '--help') {
            console.error('usage: node scripts/build-ab.mjs --ref-a <git-ref> [--ref-b <git-ref>]');
            process.exit(0);
        }
    }
    if (!refA) {
        console.error('error: --ref-a <git-ref> is required');
        console.error('usage: node scripts/build-ab.mjs --ref-a <git-ref> [--ref-b <git-ref>]');
        process.exit(2);
    }
    return { refA, refB };
}

function buildArm(armId, ref) {
    const outDir = `dist/ab/${armId}`;
    const absOutDir = path.join(BENCH_DIR, outDir);
    fs.rmSync(absOutDir, { recursive: true, force: true });
    console.error(`[build-ab] arm ${armId}: target ${outDir}`);

    if (!ref) {
        console.error(`[build-ab] arm ${armId}: building from working tree`);
        // BENCH_OUTDIR drives the rollup output.dir (vite's --outDir CLI flag
        // does not override an explicit rollup output.dir). ALPHATAB_SRC is
        // omitted so vite resolves alphatab via the tsconfig alias (working
        // tree's packages/alphatab/src).
        const bs = spawnSync('npx', ['vite', 'build'], {
            cwd: BENCH_DIR,
            env: { ...process.env, BENCH_OUTDIR: outDir, ALPHATAB_SRC: path.resolve(BENCH_DIR, '../alphatab/src') },
            stdio: 'inherit'
        });
        if (bs.status !== 0) {
            throw new Error(`vite build failed for arm ${armId}`);
        }
        return;
    }

    // Resolve the commit SHA for readable logging, then create a detached
    // worktree pinned to it.
    const resolveSha = spawnSync('git', ['rev-parse', '--short', ref], {
        cwd: REPO_ROOT,
        encoding: 'utf8'
    });
    const sha = resolveSha.status === 0 ? resolveSha.stdout.trim() : ref;
    console.error(`[build-ab] arm ${armId}: building from ${ref} (${sha})`);

    const wt = fs.mkdtempSync(path.join(os.tmpdir(), `alphatab-bench-ab-${armId}-`));
    try {
        const wsAdd = spawnSync('git', ['worktree', 'add', '--detach', wt, ref], {
            cwd: REPO_ROOT,
            stdio: 'inherit'
        });
        if (wsAdd.status !== 0) {
            throw new Error(`git worktree add failed for ${ref}`);
        }
        const alphatabSrc = path.join(wt, 'packages/alphatab/src');
        if (!fs.existsSync(alphatabSrc)) {
            throw new Error(`worktree at ${ref} is missing packages/alphatab/src`);
        }

        // Seed gitignored build-time artefacts that the bench bundle imports
        // but a fresh worktree won't have. VersionInfo.ts is regenerated on
        // every alphatab build; its content is irrelevant for the bench
        // measurement, so we just copy whatever the host repo has.
        const seedFiles = ['packages/alphatab/src/generated/VersionInfo.ts'];
        for (const rel of seedFiles) {
            const src = path.join(REPO_ROOT, rel);
            const dst = path.join(wt, rel);
            if (fs.existsSync(src) && !fs.existsSync(dst)) {
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.copyFileSync(src, dst);
            }
        }
        const env = { ...process.env, ALPHATAB_SRC: alphatabSrc, BENCH_OUTDIR: outDir };
        const bs = spawnSync('npx', ['vite', 'build'], {
            cwd: BENCH_DIR,
            env,
            stdio: 'inherit'
        });
        if (bs.status !== 0) {
            throw new Error(`vite build failed for arm ${armId}`);
        }
    } finally {
        spawnSync('git', ['worktree', 'remove', '--force', wt], {
            cwd: REPO_ROOT,
            stdio: 'inherit'
        });
    }
}

const { refA, refB } = parseArgs(process.argv.slice(2));

buildArm('A', refA);
buildArm('B', refB);

const aPath = path.join(BENCH_DIR, 'dist/ab/A/runOneCore.mjs');
const bPath = path.join(BENCH_DIR, 'dist/ab/B/runOneCore.mjs');
if (!fs.existsSync(aPath) || !fs.existsSync(bPath)) {
    console.error('[build-ab] WARNING: expected runOneCore.mjs missing in one of the arms; check vite output above.');
    process.exit(1);
}

console.error('');
console.error('[build-ab] ready. next step:');
console.error(
    `  node dist/runAB.mjs --a ${path.relative(BENCH_DIR, aPath)} --b ${path.relative(BENCH_DIR, bPath)} --only canon-resize`
);

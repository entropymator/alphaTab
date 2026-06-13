# Agent iteration playbook

This document tells an agent (or a human) how to drive one perf-improvement
cycle against alphaTab using the bench harness. Each cycle should produce
either a committed measured win, or a documented `HOTSPOTS.md` entry —
never silent thrashing.

## Architecture in one paragraph

The bench is a sibling workspace at [packages/bench](.). It bundles the alphatab
source via Vite with `__PROFILING__: true`, which keeps the `if (__PROFILING__) { Profiler.* }`
blocks in [packages/alphatab/src/profiling/Profiler.ts](../alphatab/src/profiling/Profiler.ts).
Production builds (the published library, vitest, sibling plugin packages) inherit
`__PROFILING__: false` from `defaultBuildUserConfig` in
[packages/tooling/src/vite.ts](../tooling/src/vite.ts) and dead-code-eliminate every
profiler call site — verified by `grep -c Profiler packages/alphatab/dist/alphaTab.mjs`
returning `0`.

## Commands

All from `packages/bench/`:

```bash
# build the bench bundle (must run after touching alphatab source)
npx vite build

# run all scenarios, write per-scenario profiles + combined report
node dist/run.mjs --label <some-label>

# run one scenario only
node dist/run.mjs --only canon-resize --label probe-canon

# save the current run as a baseline (for later diff)
node dist/run.mjs --save-baseline feature-perf --label feature-perf

# diff two baseline JSON files (markdown table to stdout)
node dist/cli.mjs diff baselines/feature-perf.json baselines/<later>.json
```

Per-scenario output lands in `runs/<label>/<scenario-id>/`:
- `result.json` — wall-clock per iteration + Profiler stage stats + heap deltas
- `cpu.cpuprofile` — open in Chrome DevTools → Performance → Load profile
- `heap.heapprofile` — open in Chrome DevTools → Memory → Load (sampled)

Each scenario runs in a fresh child process (clean V8 state, profilers
attached at process start). See `scenarios.ts` for the corpus.

## One iteration

### 1. Establish baseline

If you haven't already:

```bash
node dist/run.mjs --save-baseline feature-perf --label feature-perf-$(date +%s)
```

This pins the current state of `feature/perf` HEAD as the baseline you'll
measure against.

### 2. Pick a target

Open `HOTSPOTS.md` and pick the highest-priority open easy-win entry. If the
list is stale, regenerate by re-running and reading `runs/<latest>/REPORT.md`
yourself — focus on the stage breakdown, then cross-reference the CPU and
heap hotspot tables.

**Cross-reference rule**: a function appearing in BOTH the CPU top-15 and
heap top-15 is the strongest candidate. CPU-only suggests algorithmic work;
heap-only suggests allocation pressure; both means a near-guaranteed win.

### 3. Form a hypothesis, classify

- **Easy win**: single file, no public API change, no semantic change.
  Examples: hoist allocation, replace `new Map()` with reused instance,
  unroll a tight loop, split a polymorphic helper into monomorphic copies.
- **Deferred refactor**: multi-file, API change, layout-pass restructure.
  Document in `HOTSPOTS.md` under "Major refactors — deferred" and stop.

### 4. Patch and measure

Apply the patch, then:

```bash
npx vite build
node dist/run.mjs --only <target-scenario> --label probe-<short-name>
```

Compare:

```bash
node dist/cli.mjs diff baselines/feature-perf.json \
    runs/probe-<short-name>/baseline-equivalent.json
```

(Or just eyeball the two REPORT.md files side by side; the harness keeps
both.)

**Decision rule:**
- Improvement ≥ 1 % on target scenario median wall-clock AND
- No > 2 % regression on any other scenario median AND
- Stage breakdown shows the improvement landed on the targeted stage
  (not just on noise)

→ keep. Otherwise revert.

### 5. Verify visual

```bash
cd ../alphatab && npx vitest run
```

A single pixel diff regression on a reference PNG is a hard stop. Either fix
the regression or revert the patch. Do not promote the patch and the
reference image together — that's how silent visual bugs ship.

### 6. Commit

Follow existing convention on the branch:

- `perf(<area>): <what>` for the measured win, with the median delta in the
  body.
- `docs(perf): record landed/deferred items in HOTSPOTS.md` for the doc
  update.

Always separate commits for code and doc. Do not bundle perf wins with
unrelated refactors.

### 7. Update baseline

After a landed win:

```bash
node dist/run.mjs --save-baseline feature-perf --label feature-perf-$(date +%s)
```

Next iteration measures against the new floor.

## Guardrails

- **No Goodhart's law.** Do not modify Profiler instrumentation to make a
  hotspot disappear from the report. Instrumentation is read-only state.
- **No silent reverts.** If a patch doesn't land, append a sentence to the
  HOTSPOTS entry explaining what was tried and why it didn't work. The next
  agent shouldn't repeat the experiment blind.
- **No bundling perf with unrelated changes.** A 1 % perf win in a 200-line
  diff that also "cleans up" surrounding code is unreviewable. Keep perf
  diffs minimal so they can be safely reverted if a regression surfaces
  later.
- **Visual tests are sacred.** Never `npm run test-accept-reference` to make
  a perf patch pass. If pixels changed, the perf change is wrong.

## Known limitations to fix early

See `HOTSPOTS.md` EW-6: the heap profile currently spans the whole process
lifetime (including the importer). It's still useful for relative ranking
but not for absolute byte counts on the measured loop. Fix this before
relying on absolute allocation numbers.

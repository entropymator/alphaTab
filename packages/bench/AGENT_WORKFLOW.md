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

# Fast feedback: 1 trial per scenario. Single-trial summary shows per-iter
# stddev + standard error of the median; useful while iterating quickly.
node dist/run.mjs --label probe-quick

# Rigorous: 3 trials per scenario in separate child processes. Cross-trial
# stddev reveals the run-to-run noise floor — the threshold below which a
# delta is meaningless. Use this for saving baselines and for diffing a
# patch against the baseline.
node dist/run.mjs --trials 3 --label feature-perf-$(date +%s) \
    --save-baseline feature-perf

# Single scenario
node dist/run.mjs --only canon-resize --label probe-canon --trials 3

# Diff two saved baselines (markdown to stdout). The diff column `sig`
# marks ★ for ≥ 2σ pooled (real win/regression), ~ for 1-2σ (marginal),
# · for below noise floor. The diff REFUSES to compare baselines with
# different --trials counts, and warns when the saved hostname / CPU
# model / governor / Turbo state / pin set differ between baseline and
# candidate, or when their savedAt timestamps are >30 min apart.
node dist/cli.mjs diff baselines/feature-perf.json baselines/<later>.json

# By default, child processes are pinned to a stable core set with
# `taskset` (linux only; auto-picks cores 2,3 when ≥4 CPUs visible) so
# cache state survives across trials. Override the pin or disable it
# entirely when you actually want the OS scheduler to float:
node dist/run.mjs --trials 3 --pin 4,5 ...
node dist/run.mjs --trials 3 --no-pin ...
```

### Host preflight (linux)

The bench reads `/sys/devices/system/cpu/.../scaling_governor` and the
Turbo Boost knob at startup and warns when either would inflate σ. To
silence the warnings:

```bash
# Lock CPU clock (the bench will pin to two cores; this stops them ramping)
sudo cpupower frequency-set -g performance

# Disable Turbo Boost — first-trial clock would otherwise differ from
# sustained, biasing the first sample optimistically.
sudo bash -c 'echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo'   # intel
sudo bash -c 'echo 0 > /sys/devices/system/cpu/cpufreq/boost'           # amd
```

These changes survive until reboot. On a shared workstation, run them
just before a perf session and don't bother reverting — `performance`
governor + no Turbo costs a few percent of peak throughput but the
single-digit-percent perf wins this bench is designed to detect can
otherwise be drowned by clock-state variance.

Per-scenario output lands in:
- Single-trial: `runs/<label>/<scenario-id>/{result.json, cpu.cpuprofile, heap.heapprofile}`
- Multi-trial: `runs/<label>/<scenario-id>/trial-N/{result.json, cpu.cpuprofile, heap.heapprofile}`

CPU and heap profiles are **scoped to the measured loop only** via the
`node:inspector` API — they do not include warmup, module load, or score
parsing. The heap top-N is real layout-time allocation data (no importer
noise).

Each scenario runs in a fresh child process per trial (clean V8 state).
See `scenarios.ts` for the corpus.

## One iteration

### 1. Establish baseline

If you haven't already:

```bash
node dist/run.mjs --trials 3 --save-baseline feature-perf \
    --label feature-perf-$(date +%s)
```

This pins the current state of `feature/perf` HEAD as the baseline plus its
per-scenario noise floor. **Always run baselines with `--trials 3+`**:
single-trial medians can drift 5+ ms run-to-run on resize scenarios, which
is bigger than most "easy win" deltas you're trying to detect.

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

Apply the patch, build, run with **the same trial count as the baseline**:

```bash
npx vite build
node dist/run.mjs --trials 3 --label probe-<short-name> \
    --save-baseline probe-<short-name>
node dist/cli.mjs diff baselines/feature-perf.json \
    baselines/probe-<short-name>.json
```

**Decision rule:**
- The diff's `sig` column shows `★` on the target scenario (≥ 2σ pooled — a
  real win), AND
- No other scenario shows `★` regressing, AND
- Stage breakdown shows the improvement landed on the targeted stage (not on
  noise or elsewhere)

→ keep. Otherwise revert.

A win that shows only `~` (1-2σ) is suggestive but not conclusive — re-run
with `--trials 5` to either promote it to `★` or rule it out.

A win below noise (`·`) is not a win, even if the median dropped. Trying
to ship one is how perf regressions accidentally land.

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
- **Always re-baseline in the same session, at the same `--trials`.** Saved
  baselines older than ~30 min, or measured at a different trial count,
  are no longer valid comparison anchors — the noise floor is a property
  of *this* session's host load and *this* trial count, not of the code
  itself. The diff CLI hard-errors on a trial-count mismatch and warns on
  savedAt drift / host-info mismatch; treat both as "go re-baseline" not
  "ignore and continue". (This rule exists because round 2026-06-13 lost
  a full day to apparent `★` wins that were 3-trial baseline noise; a
  fair 5/5-trial re-baseline showed +2.5 % regression on the same code.)

## Known limitations to fix early

See `HOTSPOTS.md` EW-6: the heap profile currently spans the whole process
lifetime (including the importer). It's still useful for relative ranking
but not for absolute byte counts on the measured loop. Fix this before
relying on absolute allocation numbers.

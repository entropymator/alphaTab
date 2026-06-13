/**
 * Single-arm bundle for A/B comparison. Vite bundles this file together with
 * its alphatab dependency (resolved via the `@coderline/alphatab` alias) into
 * a standalone ESM module that exports `runScenario` + scenario metadata.
 *
 * For an A/B comparison, this file is built twice with `ALPHATAB_SRC` pointing
 * at two different alphatab source trees (typically two git worktrees), and
 * the resulting bundles land at `dist/runOneCore.A.mjs` and `dist/runOneCore.B.mjs`.
 * The `runAB.mjs` driver loads both via dynamic import and interleaves them
 * iteration-by-iteration in the SAME Node process — V8 share JIT-compiled
 * code across the two arms, but module-level state is isolated because
 * Node ESM caches by URL.
 *
 * The driver expects the SCENARIOS metadata to be identical between the two
 * arms (same scenario ids, same iteration counts) — drift would mean the
 * two arms aren't measuring the same workload.
 */

export type { IterationResult, PreparedScenario, ScenarioResult, ScenarioSummary } from './harness';
export { prepareScenario, runScenario } from './harness';
export type { Scenario } from './scenarios';
export { SCENARIOS, scenarioById } from './scenarios';

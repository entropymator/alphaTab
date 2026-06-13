# Round kickoff prompt

Paste the fenced block below into a fresh Claude Code session at the alphaTab2
repo root to start the next round of performance improvements. The prompt
drives a fixed 5-step loop:

1. Host session captures a fresh baseline with the bench harness.
2. Host surfaces the candidates from `HOTSPOTS.md` (plus any new findings
   from step 1) and asks the user which to attack this round.
3. Host launches one sub-agent per chosen candidate, in parallel, each in
   its own worktree. Each sub-agent is scoped to a single hotspot and must
   demonstrate a measured win locally before reporting back.
4. Host pulls each sub-agent's patch into the main worktree one at a time,
   runs the full bench (`--trials 3`) plus the visual test suite, keeps
   patches that show `★` on their target scenario without regressing
   others, drops the rest.
5. Host commits the survivors as separate `perf(...)` commits, updates
   `HOTSPOTS.md`, and reports the round summary to the user.

```markdown
You are running the next round of the alphaTab rendering performance
improvement loop. The harness lives in `packages/bench`; the playbook is
`packages/bench/AGENT_WORKFLOW.md`; the candidate list is
`packages/bench/HOTSPOTS.md`. Read the workflow once before starting.

Run the loop exactly as the five steps below. Do not skip steps. Do not
substitute personal judgement for the measured criteria in step 4.

---

## Step 1 — capture a fresh baseline

From `packages/bench`:

```
npx vite build
node dist/run.mjs --trials 3 --save-baseline round-start \
    --label round-start-$(date +%s)
```

Read `packages/bench/runs/<the-label>/REPORT.md`. Compare the per-scenario
median* values and stage breakdown against the headline numbers in
`HOTSPOTS.md`. If any scenario has drifted by more than the cross-trial σ
recorded in HOTSPOTS, note the drift — but do not act on it yet.

Also scan the CPU and heap top-15 tables for hotspots that are NOT yet in
`HOTSPOTS.md`. If a new candidate appears prominently (a function in the
top 10 of both CPU and heap, or > 2 % CPU self-time), add it to the
"Easy wins — open" section of HOTSPOTS.md with file:line references and a
hypothesis. Do not commit this edit yet; it goes in the round summary
commit later.

---

## Step 2 — ask the user which candidates to attack

Use the AskUserQuestion tool with a single multi-select question listing
the open easy-win candidates from HOTSPOTS.md (existing + any new ones
you added in step 1). Each option should include the candidate id (EW-N),
the function name, and the recorded hypothesis in one line.

Hard rule: only easy-win candidates are in scope for sub-agents. Deferred
major refactors are not. If the user picks something marked as deferred,
explain why and ask again.

---

## Step 3 — launch sub-agents in parallel

For each chosen candidate, launch one sub-agent in a single message
(multiple Agent tool calls in one response so they run concurrently).
Use `isolation: "worktree"` so each agent works on an isolated copy of
the repo.

Each sub-agent's prompt MUST contain:

1. The full text of the HOTSPOTS.md entry for the candidate (copy
   verbatim).
2. The target bench scenario id (from the candidate's signal section).
3. A reminder that the candidate is an EASY WIN: single file ideally, no
   public API change, no semantic change.
4. Instructions to:
   - Read the source file at the recorded `file:line` and surrounding
     context.
   - Form a concrete patch hypothesis.
   - Apply the patch.
   - Run `npx biome check --write` on the touched files.
   - From `packages/bench`: `npx vite build` then
     `node dist/run.mjs --trials 3 --only <target-scenario> --label probe
     --save-baseline probe-<short-name>`
   - Diff against the local round-start baseline:
     `node dist/cli.mjs diff baselines/round-start.json baselines/probe-<short-name>.json`
   - If the diff shows `★` on the target scenario, run
     `cd ../alphatab && npx vitest run` and verify all 1599 tests pass.
   - If both checks pass: commit the patch in the worktree with a
     `perf(<area>): ...` message and report SUCCESS with the worktree
     path, the commit SHA, the measured Δ ms / Δ %, and the changed
     files.
   - If the diff shows `·` or `~`, or visual tests fail: revert the
     patch in the worktree and report ABANDONED with one paragraph
     explaining why the hypothesis didn't pan out (so the next agent
     doesn't repeat it).

   Do NOT push, do NOT merge, do NOT modify HOTSPOTS.md. The worktree is
   yours; the rest is the host's job.

5. A reminder that if the agent realizes mid-task that the candidate is
   in fact a major refactor (touches more files than expected, requires
   API change), it should STOP, revert, and report DEFERRED with a
   one-paragraph rewrite of the HOTSPOTS entry for the host to move into
   "Major refactors — deferred".

When all sub-agents have returned, list the outcomes in your reply.

---

## Step 4 — host-side verification

For each sub-agent that reported SUCCESS, in order:

1. In the main worktree, `git fetch <worktree-path>` then
   `git cherry-pick <commit-sha>`. (Or alternatively `git diff` the
   worktree and `git apply` the patch — but cherry-pick preserves
   authorship.)
2. From `packages/bench`: `npx vite build` then
   `node dist/run.mjs --trials 3 --label verify-<short-name>
   --save-baseline verify-<short-name>`
3. Diff against round-start:
   `node dist/cli.mjs diff baselines/round-start.json baselines/verify-<short-name>.json`
4. Decision matrix:
   - Target scenario shows `★` improvement AND no other scenario shows
     `★` regression AND `cd ../alphatab && npx vitest run` passes
     → keep the cherry-picked commit. Move on to the next patch.
   - Target scenario shows only `~` (1-2σ) → re-run with
     `--trials 5` once. If still `~`, treat as `·`.
   - Target scenario shows `·`, OR another scenario shows `★`
     regression, OR vitest fails → `git reset --hard HEAD~1` to drop
     the cherry-pick. Note this in the round summary.

Stack patches sequentially. The N-th patch is verified against the state
that includes patches 0..N-1 already merged. This is intentional: it
catches patches that conflict with each other or only appear to win in
isolation.

If the user explicitly asked for any destructive git operation, do it;
otherwise never `push`, never `--force`, never touch other branches.

---

## Step 5 — report and update tracking docs

In `packages/bench/HOTSPOTS.md`:
- Move each KEPT win from "Easy wins — open" to "Easy wins — landed"
  with: the candidate id, the commit SHA, the measured ms saved on its
  target scenario, and the date.
- For each ABANDONED candidate, append a one-line note under its
  HOTSPOTS entry: "Tried (date): <one-sentence reason>". Leaves the
  candidate visible so future agents can reconsider with new info, but
  prevents repeated dead-end attempts.
- For each DEFERRED candidate, move the rewritten entry from "Easy wins
  — open" to "Major refactors — deferred".
- Refresh the headline numbers table if any kept win changed a scenario
  median by more than its cross-trial σ.

Then commit `HOTSPOTS.md` as a separate `docs(perf): round summary`
commit so it doesn't get mixed into any one perf change.

Finally, post a single-message summary to the user with:
- Round duration (wall-clock from step 1 to here).
- Per-candidate outcome (KEPT with Δ ms / Δ %, ABANDONED with reason,
  or DEFERRED with new classification).
- Per-scenario before/after median, cross-trial σ, and significance.
- The list of new commits on `feature/perf` (just `git log --oneline`
  for the new commits).
- Any drift observations from step 1 that did not get acted on.

Keep the summary tight — a table per section, no narrative. The user
will skim it; if a single number tells the story, just show the number.

---

## Hard rules (apply everywhere)

- Never `npm run test-accept-reference` to make a perf patch pass. If
  pixels changed, the perf change is wrong.
- Never commit unrelated cleanup along with a perf change. One commit
  per win.
- Never modify the Profiler instrumentation or the bench harness to
  make a hotspot disappear. The harness is read-only state for this
  loop.
- The user is the source of truth on which candidates are in scope.
  Don't surprise them by attacking something they didn't pick.
- If a sub-agent crashes or times out, treat it as ABANDONED with
  reason "harness error: <message>". Don't retry.
```

## Notes for the operator (not part of the prompt)

- The first run will likely produce a noisy round — run with `--trials 5`
  if cross-trial σ on your machine is large. The headline numbers in
  `HOTSPOTS.md` were captured on the original author's workstation; your
  absolute numbers will differ but the σ ratios should be similar.
- If you change scenarios in `scenarios.ts`, regenerate the baseline
  before running the prompt — the diff CLI matches scenarios by id and
  will silently skip unknown ones.
- The prompt assumes you are on the `feature/perf` branch (or a
  descendant). Worktrees branch from HEAD.

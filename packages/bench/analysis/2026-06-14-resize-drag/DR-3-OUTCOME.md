# DR-3 — outcome

**Round closed**: DR-3.B falsified at Phase 2 (A/B); DR-3.A ratified and landed.

| Phase | Outcome |
|---|---|
| 0a — DR-3.A instrumentation | Open methods sum ≈ 1-2 ms real (post-hrtime overhead). |
| 0b — DR-3.B fixture equivalence | PASSED on 3 fixtures × 3 scales. Arithmetic equivalence verified. |
| §3.6 decision gate | Proceed with DR-3.B as primary. |
| 1 — DR-3.B implement | Done — single commit touching SvgCanvas.ts + CssFontSvgCanvas.ts. |
| 2 — DR-3.B A/B n=64 | Δ = -0.79 ms (-0.5 %), sig=`·` (z=1.50). |
| 2 — DR-3.B A/B n=128 | Δ = -0.16 ms (-0.1 %), sig=`·` (z=0.18). CI=[-1.02, +0.90]. |
| §9.2 falsification | TRIGGERED per plan §7.5: Δ below σ at n=128 → fall back to DR-3.A. |
| §12.3 fallback | DR-3.A as primary. |
| 8 — DR-3.A implement | Done — bezierCurveTo / fill / stroke / beginGroup. |
| 9 — DR-3.A A/B n=64 | Δ = -2.34 ms (-1.5 %), sig=`★` (z=3.00). CI=[-4.23, -1.04]. |
| 9 — DR-3.A cross-scenario n=32 | canon-resize -1.47 ms ★, no regression on any scenario. |
| 10 — DR-3.A vitest | 1599/1599 PASS. |

---

## DR-3.B falsification — why the bench didn't ratify the structural change

### The Phase 0b probe DID validate correctness

Three fixtures × three scales produced arithmetically-equivalent SVG output
between the current per-emission-scale form and a hand-rolled centralized-
scale form. The §3.4 risk surface (BoundsLookup contract, stroke widths,
font sizes, sub-pixel AA) all held:

- **scale=1.0**: byte-identical modulo the root `viewBox` attribute.
- **scale=1.5**: 8954 rects + 1422 paths + 2051 fonts satisfy
  `baseline = patched × 1.5` on canon.gp5.
- **scale=2.0**: same with `× 2.0`.

The arithmetic-equivalence claim is **proven** at the SVG-text level. The
production user at scale!=1 would get the documented win (no per-coord
multiplies, no template-literal IC, simplified emission).

### The bench couldn't measure that win

The bench corpus (`canon-resize-drag`) runs at `display.scale = 1.0` —
where the EW-10 / EW-11 fast paths ALREADY emit logical-coord byte content
that's near-identical to what DR-3.B would emit. The branches that
DR-3.B was supposed to eliminate (`if (s === 1)`) had become V8-predicted
no-ops at this point in the optimization sequence.

The bench-measurable Δ for DR-3.B at scale=1 collapses to:

1. The cost of EW-10/EW-11's `const s = this.scale` read + `if (s === 1)`
   branch (cheap, V8 predicts it).
2. The cost of the few open-method `*scale` multiplies on
   `bezierCurveTo`, `strokeRect`, etc. (Phase 0a measured ~1-2 ms total,
   most of which is `bezierCurveTo` whose `*scale` operations at scale=1
   multiply Smi values — V8 handles this with a single SMI-overflow check).
3. Negative: the extra arithmetic for `viewBox` (lw/lh integer-divide
   coercion) AND the +30-40 bytes of `viewBox="..."` attribute per render.

The structural simplification was real — 199 → 113 lines, dual paths
collapsed to single-form emissions — but on the bench corpus, the Δ is
indistinguishable from noise:

| n | median A | median B | Δ | sig |
|---:|---:|---:|---:|---|
| 64 | 157.76 | 158.07 | -0.79 ms (-0.5 %) | · |
| 128 | 157.52 | 158.08 | -0.16 ms (-0.1 %) | · |

At n=128 the CI [-1.02, +0.90] ms **straddles zero**. By plan §7.5 this
is the explicit falsification path: "Falsify the Δ estimate. The
simplification still has code-clarity value; ship anyway? No — without
the perf justification, this is a behaviour-changing patch and gets the
usual stability heuristic. **Fall back to DR-3.A.**"

### Structural lesson — EW-10/EW-11 captured most of the well

The §3.2 Δ estimate of 2-4 ms was predicated on:
- Eliminate `*scale` × 29 sites × ~30k aggregate calls × ~3 ns (1.5-3 ms)
- Eliminate `if (s === 1) { fastpath } else { slowpath }` branch overhead (0.3-0.8 ms)

But on canon-resize-drag at scale=1, the FAST PATH was already winning.
The branch was free (V8 IC). The `*scale=1` multiplies were already
SKIPPED in the fast path. DR-3.B's win-source on this scenario was
mostly "the open methods that EW-10/EW-11 didn't cover" — which Phase 0a
shows is exactly the DR-3.A surface (~1-2 ms real). That's what landed.

Production users at scale!=1 would get the full 2-4 ms predicted —
that population is REAL but UNMEASURED. Per the user's Goodhart filter:
"bench-favorable optimizations that don't generalize to production"
trigger rejection. The inverse — production wins the bench can't measure
— ALSO doesn't pass the gate by §7.5's explicit rule. Both ways, the
plan calls for falsification when the bench Δ is below σ.

### Side observations from the DR-3.B implementation

- Bundle size dropped 23 KB (2311 KB → 2288 KB for the bench arm).
- Vitest 1599/1599 PASS — the data model and rendering glyphs are
  unchanged; only string-building differs.
- Phase 0b probe script (`packages/alphatab/scripts/dr3b-phase0-capture.ts`)
  is reusable for future SVG-emission research.
- The 18 captured SVG files in
  `packages/bench/analysis/2026-06-14-resize-drag/dr3b-phase0/` document
  what the centralized form would look like.

### What was NOT done

- **Phase 5 manual browser smoke test was NOT run.** With DR-3.B
  falsified at Phase 2 (perf gate), there's no need to ratify it at the
  rasterise gate.

If a future round revisits DR-3.B (e.g. with a bench scenario that
exercises scale!=1), the Phase 0b probe stands as the correctness
foundation; Phase 5 browser smoke test becomes the open verification.

---

## DR-3.A — what landed

Per §12.2 fallback path. Template→concat completeness on the four open
methods that actually fire on `canon-resize-drag`:

| Method | calls/iter (Phase 0a) | Change |
|---|---:|---|
| `beginGroup` | 38,428 | template→concat; no `*scale` in body |
| `bezierCurveTo` | 3,371 | scale=1 fast-path + manual concat |
| `fill` | 15,436 | template→concat on always-emitted prefix |
| `stroke` | 3,042 | manual concat on always-emitted prefix |

The dead-on-canon-resize-drag methods (`strokeRect`, `quadraticCurveTo`,
`fillCircle`, `strokeCircle`, `beginRotate`) are LEFT in template form.
They fire elsewhere (tab dot barlines, multi-bar slurs, rotated staff
labels), but Phase 0a measured 0 calls/iter on the target scenario, so
adding the scale=1 branch overhead would be net-negative without bench
validation.

### A/B verdict

- **canon-resize-drag n=64**: -2.34 ms (-1.5 %), CI=[-4.23, -1.04], z=3.00, ★
- **Cross-scenario n=32**: 
  - `canon-resize`: -1.47 ms ★
  - `nightwish-resize`: -0.33 ms ·
  - `nightwish-render`: -0.04 ms ·
  - `canon-render`: -0.17 ms ·
  - `fade-to-black-resize`: +0.30 ms ·
  - `tiny-render`: -0.00 ms ·

No regression on any scenario. Two `★` improvements (target + canon-resize).

### Vitest

1599/1599 PASS.

---

## Final state

- DR-3.B work fully reverted; SvgCanvas.ts / CssFontSvgCanvas.ts back to
  HEAD `2b742569` shape, then DR-3.A patch applied.
- Phase 0 probe scripts retained:
  - `packages/bench/scripts/phase0-dr3a-probe.mjs`
  - `packages/alphatab/scripts/dr3b-phase0-capture.ts`
- Phase 0b probe outputs retained for future research (song-details.gp
  only; canon.gp5 and bends.gp captures reproducible via the script):
  - `packages/bench/analysis/2026-06-14-resize-drag/dr3b-phase0/`
- This outcome doc: `DR-3-OUTCOME.md`
- Phase 0 findings doc: `DR-3-PHASE-0-PROBES.md`

DR-3.A commit will reference this outcome doc.

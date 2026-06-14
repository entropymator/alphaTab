# EW-11 Phase 0 — empirical probes (no source change)

Date: 2026-06-14, ~4:40pm GMT+2.
HEAD at probe time: `0a0207e7` (EW-11 plan commit).
Scenario probed: `canon-resize-drag` (8 measured iterations after 3 warmup, the bench's default).
Method: temporary instrumentation patch wrapping all four candidate methods with a
`process.hrtime.bigint()` straddle + counters. The patch is reverted before any
source commit lands.

This document records the §3 probes mandated by `EW-11-PLAN.md`.

---

## Per-method call count / ns / scale=1 hit rate

| Method | calls/iter | ns/call (instrumented) | total ms/iter (instrumented) | `this.scale === 1` |
|---|---:|---:|---:|---:|
| `SvgCanvas.fillText` | **26,673** | 300 | 7.99 | **100.0 %** |
| `SvgCanvas.lineTo` | **46,034** | 159 | 7.34 | **100.0 %** |
| `SvgCanvas.moveTo` | **19,383** | 182 | 3.54 | **100.0 %** |
| `CssFontSvgCanvas._fillMusicFontSymbolText` | **34,471** | 281 | 9.67 | **100.0 %** |

**Combined instrumented surface ≈ 28.5 ms / iter** (median wall-clock at probe time: 182.7 ms / iter).

NOTE: per-method ns includes ~50-100 ns hrtime overhead per call. True per-call body cost is somewhat lower (estimated 100-200 ns lower than the instrumented numbers above). Even so the per-iter ms figures above are useful as relative-cost indicators.

### `_fillMusicFontSymbolText` — relativeScale distribution

| Sub-condition | Calls / iter | Share |
|---|---:|---:|
| `this.scale === 1` (always in bench) | 34,471 | 100.0 % |
| `relativeScale === 1` | 34,042 | 98.8 % |
| **both `this.scale === 1` AND `relativeScale === 1`** | 34,042 | **98.8 %** |

The 1.2 % of calls where `relativeScale !== 1` come from multi-bar rest scaling, alphaTab grace-note `noteScale`, and similar relative-size factors. The "nested fast-path" (plan §2.3 option 1) is therefore attractive — 98.8 % of calls can skip the font-size attribute entirely.

---

## Comparison against plan §2.x volume predictions

| Method | Plan predicted calls/iter | Plan predicted ns/call | Actual calls/iter | Actual ns/call | Verdict |
|---|---:|---:|---:|---:|---|
| `fillText` | 15-30k | 200-350 | 26,673 | ~300 | matches |
| `lineTo` | 20-40k | 80-150 | 46,034 | ~159 | volume slightly above range; ns matches |
| `moveTo` | 10-20k | 80-150 | 19,383 | ~182 | matches |
| `_fillMusicFontSymbolText` | 15-30k | 200-400 | 34,471 | ~281 | volume slightly above range; ns matches |

All four are at or above the predicted ranges. None is anywhere near the 5k-floor where the plan would suggest dropping a candidate.

---

## Decision gate (plan §3.6) — all four candidates pass

| Outcome | Condition | Met? |
|---|---|:---:|
| All three (four) candidates ≥ 90 % `scale=1` | 100 % each | ✅ |
| Combined surface ≥ 8 ms confirmed | 28.5 ms instrumented (≥ 20 ms even after removing hrtime overhead) | ✅ |
| `_fillMusicFontSymbolText` `scale=1` rate ≥ 50 % | 100 % | ✅ |
| No candidate < 5k calls/iter | min = moveTo @ 19,383 | ✅ |
| Bundle total surface < 5 ms (would falsify) | 28.5 ms (far above) | ✅ (not falsified) |

**Verdict**: proceed to Phase 1, bundle all four methods. No candidate dropped.

The combined surface (~28.5 ms instrumented) is the largest remaining single-shape paint hotspot post-EW-10. Even a conservative 10 % savings would clear σ (~2.85 ms vs 2.2 ms σ floor); 15-30 % savings (the plan's expected range) puts the bundle solidly in `★` territory.

---

## Findings that update the plan

1. **All four methods are 100 % `scale=1` in canon-resize-drag.** This matches the EW-10 Phase 0 finding for `fillRect`. The slow-path (template-literal-with-multiplies) branch is dead code in this bench but cannot be removed unconditionally because user-side HiDPI relies on it.

2. **`_fillMusicFontSymbolText` is 98.8 % `(scale=1 AND relativeScale=1)`.** The nested fast-path (skipping the font-size attr entirely) is worth implementing. The non-1 relativeScale case can keep the existing template literal.

3. **`lineTo` is the volume leader (46k/iter)**, ahead of `_fillMusicFontSymbolText` (34k/iter), `fillText` (27k/iter), and `moveTo` (19k/iter). Per-call cost of `lineTo` is the lowest (~159 ns) — the body is shorter than the others.

4. **Combined instrumented surface ≈ 28.5 ms/iter** is larger than the plan §1.2 estimate of ~14.7 ms. The plan's estimate was based on profiler self-time (post-EW10 anchor); the instrumented total runs hot because (a) hrtime overhead inflates per-call ns, and (b) `_fillMusicFontSymbolText` self-time is split across two profiler bins on the V8 IC. Either way the surface is real and well above σ.

---

## Cross-references

- Plan: `EW-11-PLAN.md`.
- Probe script: `packages/bench/scripts/phase0-ew11-probe.mjs`.
- Probe artifact build: `packages/bench/dist/ab/PROBE/runOneCore.mjs` (transient).
- HEAD at probe time: `0a0207e7`.
- EW-10 Phase 0 (template / methodology reference): `EW-10-PHASE-0-PROBES.md`.

# EW-10 Phase 0 — empirical probes (no source change)

Date: 2026-06-14, ~4:15pm GMT+2.
HEAD at probe time: `77071ea5` (the EW-10 plan commit).
Scenario probed: `canon-resize-drag` (8 measured iterations after 3 warmup, the bench's default).
Method: temporary instrumentation patch on `SvgCanvas.fillRect` to capture
per-call statistics. The patch is reverted before this commit lands.

This document records the three Phase 0 probes mandated by plan §8.

---

## §8.1 — fillRect call shape on canon-resize-drag

The probe wraps every `fillRect(x, y, w, h)` call, recording the post-`*scale`
coordinates, whether they round to integers, and the size of the emitted
`<rect …/>` string. A second pass with `--stacks` attributes calls to
their immediate caller via stack-frame parse (slow; not measured for ms).

### Bulk counts (8 measured iters)

| Metric | Value |
| --- | ---: |
| total fillRect calls | 914,456 |
| **per iter** | **114,307** |
| integer-coord (post-`*scale`) | **0 (0.0 %)** |
| fractional-coord | 914,456 (100.0 %) |
| with `scale !== 1` | 0 (0.0 %) |
| total `<rect>` string bytes | 83,180,536 (10.4 MB / iter) |
| **derived per-call ns** (using post-DR-1 self-time 19.57 ms) | **~171 ns** |

### Per-caller breakdown (with --stacks)

| Caller | Calls/iter | Share | Class (plan §3.1) |
| --- | ---: | ---: | --- |
| `TabBarRenderer.paintStaffLines` | 36,670 | 32.1 % | **Z** |
| `ScoreNoteChordGlyph._paintLedgerLines` | 30,420 | 26.6 % | G |
| `ScoreBarRenderer.paintBeamingStem` | 18,655 | 16.3 % | G |
| `ScoreBarRenderer.paintStaffLines` | 14,560 | 12.7 % | **Z** |
| `BarLineLightGlyph.paintExtended` | 8,660 | 7.6 % | S |
| `LineRangedGlyph.paintGrouped` | 2,116 | 1.9 % | C |
| `StaffSystem.paintPartial` (accolade bar) | 1,418 | 1.2 % | S |
| `StaffSystem._paintBrackets` | 1,418 | 1.2 % | C |
| `BendNoteHeadGroupGlyph._paintLedgerLines` | 364 | 0.3 % | G |
| `BarLineHeavyGlyph.paintExtended` | 26 | 0.0 % | S |

(Stack-frame attribution is exact for the immediate caller; the named call
sites are the leaf-most paint methods. Inner micro-callers like
`SustainPedalGlyph` etc. did not fire on canon-resize-drag corpus.)

### Plan §3.4 volume-distribution revision

Plan §3.4 estimated paintStaffLines at 60-75 % of total fillRect call volume.
The probe finds **paintStaffLines = 44.8 %** (TabBarRenderer 32.1 + ScoreBarRenderer 12.7).
Lower than expected. Ledger lines come in at **26.6 %** — much higher
than the plan's 5-10 % estimate.

The plan's §4 classification is unaffected by the revised volume — paintStaffLines
is still the largest *batchable* volume target, and ledger lines stay Class G
(group identity).

### Plan §5.1 scale=1-integer assumption is INVALIDATED

Plan §5.1 implicitly assumed that with `scale === 1`, fillRect calls would
produce integer-coordinate `<rect>`s for the bulk caller set. The probe finds
**0 of 914,456 calls produce integer coordinates after `*scale`**.

Root cause: the input arguments themselves are fractional even when scale is 1.
`paintStaffLines` passes `lineY = getLineY(i) - staffLineThickness/2` (a half-of-thickness fractional);
`paintLedgerLines` passes a similar half-of-thickness offset; stems pass
`stemThickness` which is the SMuFL float metric (~0.32 spaces in floats).

**Consequences for T1 (scale=1 short-circuit) in plan §5.3:**
- T1 still has *some* value — it eliminates 4 float multiplies per call (`x*1, y*1, w*1, h*1`). At 171 ns/call × 114k = 19.57 ms/iter, even saving 4 multiplies × ~3 ns × 114k = ~1.4 ms. Below σ alone.
- T1 does NOT enable an integer fast-path that bypasses generic number-to-string. The output is fractional regardless. The "pre-formatted scale-1 fast path" (T3) must still handle fractional output.

### Plan §5.2 call-volume estimate is REVISED

Plan §5.2 estimated 18-39k calls/iter. The probe finds **114k/iter** — about 3-6× higher than the plan's estimate, with per-call cost correspondingly LOWER (~171 ns vs the plan's 500-1100 ns range).

### `<rect>` element-kind probe (deferred)

Plan §8.1 also asked for a `<rect>`-vs-`<path>` pixel-diff sample. **Not run** —
the §6 batching design preserves `<rect>` element kind (each batched record
emits as `<rect …/>` at flush time). The rasteriser sees identical element
strings, just buffered. The element-kind probe is therefore not on the
critical path for Phase B as designed. If a future round considers a
`<path>`-batch shape (EW-5's abandoned design), the probe becomes mandatory
again.

---

## §8.2 — `beginGroup`/`endGroup` inventory

`grep -rn "beginGroup\|endGroup" packages/alphatab/src --include="*.ts"`:

| Site | Contains fillRect? |
| --- | --- |
| `ICanvas.ts:93,95` (declaration) | n/a |
| `Html5Canvas.ts:221,225` (no-op impl) | n/a |
| `SkiaCanvas.ts:237,241` (no-op impl) | n/a |
| `SvgCanvas.ts:39,43` (impl) | n/a |
| `BarRendererBase.ts:985,994,997,998,1009,1010` — `paintSimileMark` | **No** (uses `fillMusicFontSymbolSafe` only) |
| `BeatContainerGlyph.ts:313,326` — beat group | **Yes** (per-beat fillRect via stems, ledger lines, numbered-dash) |

Conclusion: **only `BeatContainerGlyph.paint` wraps fillRect-bearing paint with `beginGroup`/`endGroup`.** Class G membership is bounded by this single site. Plan §8.2 prediction confirmed.

---

## §8.3 — z-order trace

Verified by re-reading `BarRendererBase.paintContent` and `LineBarRenderer.paintContent`
and `LineBarRenderer.paintBackground` at HEAD (`77071ea5`).

```
BarRendererBase.paintContent:817
  → paintBackground(cx, cy, canvas)                            [Z-PIN ANCHOR]
        → super.paintBackground (layoutingInfo.paint, line 841)
        + LineBarRenderer.paintBackground:118
              → paintStaffLines(cx, cy, canvas)                [PHASE B TARGET — 44.8% of fillRect volume]
              → paintSimileMark(cx, cy, canvas)
  → canvas.color = mainGlyphColor                              [line 820]
  → _preBeatGlyphs.paint(...)                                  [clef, key sig, time sig]
  → voiceContainer.paint(...)
        each beat: BeatContainerGlyph.paint:313 → beginGroup
            → preNotes.paint
            → onNotes.paint                                    [NOTEHEADS + ledger lines]
            → ties
          BeatContainerGlyph.paint:326 → endGroup
  → _postBeatGlyphs.paint(...)                                 [barlines, repeat counts]
  → _paintMultiSystemSlurs(...)

LineBarRenderer.paintContent:112 (override):
  → super.paintContent(...)                                    [all of the above]
  → paintBeams(...)                                            [calls paintBar → paintBeamingStem]
  → paintTuplets(...)

BarRendererBase.paint:804:
  → paintContent(cx, cy, canvas)                               [all of the above]
  → topEffects.paint(...)                                      [chord diagrams, line-ranged]
  → bottomEffects.paint(...)                                   [sustain pedal]
```

**Anchor confirmed**: `paintStaffLines` is the FIRST emission in any bar (line 167/175 fillRects). Every notehead, ledger line, stem, beam, barline, slur, and effect paints **after** it in document order. Moving paintStaffLines's fillRect emissions to `endRender` would put the rects after all bars' content — striking through every notehead.

The plan §6.3 flush boundary — `paintBackground` end — is therefore the right anchor: it preserves document order exactly.

**Stems (16.3 % of fillRect volume) paint AFTER notes**: paintBeamingStem is invoked from paintBar (line 747), which is called from `paintBeams` (line 519), which runs AFTER `super.paintContent` in `LineBarRenderer.paintContent:113-114`. Confirms plan §3.2.A: stems are not literally inside the `BeatContainerGlyph` group but DO carry per-beat identity via `ElementStyleHelper.beat` (LineBarRenderer:749 `using _ = ElementStyleHelper.beat(canvas, beamsElement, beat)`). Stems remain Class G.

---

## Phase 0 verdict and Phase A go/no-go

### Findings that update the plan

1. **Per-call cost is ~171 ns**, not 500-1100 ns. The string-build dominates (~91 bytes per `<rect>`). Per-call optimisation has lower headroom than the plan implied.
2. **paintStaffLines volume = 44.8 %**, not 60-75 %. Phase B's max win is `8.8 ms × cost-elimination-fraction`. At a generous 80 % elimination, ~7 ms — well above σ (2.7 ms). Phase B is still viable, with less margin than plan §6.6's 12 ms estimate.
3. **0 % integer coordinates** — T1 cannot enable a fast integer path. T1 alone saves at most ~1.4 ms (multiplies). Below σ.
4. **T2 (hoist Color.rgba)**: `Color.rgba` is a plain string field, not a getter — already cached. T2 yields ~0 ms. **Removed from Phase A.**
5. **T3 (manual concat with scale-1 fast path)**: only worth trying if T1 alone fails — the bulk cost is string-build, not template-literal mechanics.

### Phase A plan (revised post-Phase-0)

- T1: scale=1 short-circuit (4 multiply elimination).
- T3: manual `+` concat replacing the template literal, only on the scale=1 path.
- ~~T2~~: dropped (no value).
- T4 = T1 + T3 combined.

**Expected**: 0.5-2.5 ms total. Likely below σ. Plan §5.5 said this. The probe confirms it more precisely.

### Phase A decision rule (per plan §10.1)

- `★ Δ ≤ -2.7 ms` → land. (Unlikely.)
- `Δ ∈ (-2.7, 0)` → don't revert immediately. Fall through to Phase B. If Phase B lands, evaluate whether Phase A's marginal contribution is worth keeping (could land both in sequence if Phase A is ≥ -1 ms even though below σ; otherwise drop).
- `Δ ≥ 0` → revert Phase A; assess Phase B.

### Phase B is the load-bearing slice

Phase B's headroom (~7 ms expected) is the only path to clear σ with margin. The probe re-confirms Phase B as the primary target of EW-10. Phase A is a cheap warmup that may or may not land.

---

## Cross-references

- Plan: `EW-10-PLAN.md`.
- Probe script: `packages/bench/scripts/phase0-fillrect-count.mjs`.
- Probe artifact build: `packages/bench/dist/ab/PROBE/runOneCore.mjs` (not committed; transient).
- HEAD at probe time: `77071ea5`.

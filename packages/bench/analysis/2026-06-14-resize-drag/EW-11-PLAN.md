# EW-11 — extend the EW-10 Phase A pattern to `fillText`, `lineTo`, and (optionally) `_fillMusicFontSymbolText`

**Status**: planning round, not started.
**Branch / HEAD**: `feature/perf` at `5f7d425e` (post-EW-3 landed; this is the A/B reference anchor — see §1.4).
**Scenario**: `canon-resize-drag`.
**σ floor (authoritative)**: post-EW10 `baselines/post-EW10.json` σ = ±3.68 ms (1.66 %). 1 % ≈ 2.2 ms, 2σ ≈ 7.4 ms. Recent hosts have drifted, so this is the **resolution floor** for `★` classification in this round.
**Author rule**: this is a methodical extension of a *landed* pattern (`SvgCanvas.fillRect` scale=1 fast path at `244c8e0b`). Each candidate is below σ standalone. The whole point is to **bundle** the safe subset into one commit and clear σ in aggregate. If the bundle is also below σ, falsify per §9 — that's a valid outcome.

---

## 1. Goal & framing (plain English)

### 1.1 What EW-10 Phase A established

`SvgCanvas.fillRect` (`packages/alphatab/src/platform/svg/SvgCanvas.ts:52`) was the #1 self-time hotspot on `canon-resize-drag` post-DR-1. The Phase A diff at commit `244c8e0b` is:

```ts
public fillRect(x, y, w, h) {
    if (w > 0) {
        const s = this.scale;
        if (s === 1) {
            this.buffer += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + this.color.rgba + '" />\n';
        } else {
            this.buffer += `<rect x="${x*s}" y="${y*s}" width="${w*s}" height="${h*s}" fill="${this.color.rgba}" />\n`;
        }
    }
}
```

EW-10 Phase 0 (`EW-10-PHASE-0-PROBES.md` §8.1) found:
- **114,307 fillRect calls / iter** on canon-resize-drag.
- **100 % at `scale === 1`** in the bench workload (Environment.highDpiFactor=1, settings.display.scale=1).
- **~171 ns / call** dominated by string-build, not multiplies.
- Phase A landed **★ Δ -4.14 ms / -2.7 % at n=64** vs `be8b724b`.

The mechanism is two-fold:
1. Eliminate the 4 `*scale` multiplies (each ~3 ns; ~1.4 ms / iter total).
2. Swap the template literal for manual `+`-concat. Both call `Number.prototype.toString` for numeric interpolands, so output is **byte-identical**, but template literals carry V8-internal formatting/IC overhead that `+` does not on this hot path.

### 1.2 What EW-11 proposes

Extend the **same Phase A shape** to the remaining hot SVG emission methods listed in the post-EW-3 CPU top-15:

| # | % CPU | Self ms (post-EW10 anchor) | Function | File:line |
|---:|---:|---:|---|---|
| 6 | 2.42 | 6.08 | `_fillMusicFontSymbolText` | `CssFontSvgCanvas.ts:39` |
| 8 | 2.27 | 5.24 | `fillText` | `SvgCanvas.ts:172` |
| 16 | 1.40 | 3.36 | `lineTo` | `SvgCanvas.ts:104` |

Combined max-surface in scope: **~14.7 ms / iter** if all three bundle, or ~8.6 ms for fillText + lineTo alone. The σ floor for `★` is ~7.4 ms (2σ on the post-EW10 anchor), so the all-three bundle has margin; the two-method bundle is on the edge.

### 1.3 Why this is one commit, not three

EW-10 Phase A was alone enough only because fillRect's per-call volume × the per-call savings cleared σ. Each EW-11 candidate is below σ standalone:

- `lineTo` 3.36 ms × ~30 % savings ≈ 1.0 ms standalone.
- `fillText` 5.24 ms × ~30 % savings ≈ 1.6 ms standalone.
- `_fillMusicFontSymbolText` 6.08 ms × ~25 % savings ≈ 1.5 ms standalone (more state-dependent branching, less savings headroom).

None of these cross 2.2 ms alone. The sum (~4.1 ms) is also below the σ floor (~7.4 ms) but is a more reasonable target for **n=64 paired A/B** where the resolution is finer than the multi-trial σ allows. The plan accepts that this bundle is **inside-σ on the strict reading** but is a worthwhile probe because:
- The pattern is identical to a landed change (`244c8e0b`).
- Byte-identical output expectation makes correctness near-trivial to verify.
- Tooling already exists.
- The combined ~14.7 ms surface is the largest remaining single-shape paint hotspot.

### 1.4 A/B reference anchor

A/B baseline is `5f7d425e` (the head of `feature/perf` at session start, post-EW-3 landed). This includes:
- EW-10 Phase A `fillRect` fast path (`244c8e0b`).
- EW-7/EW-8 escape-text micro-opt (`2251590d`, `ac8606e7`).
- EW-9 broker-lifecycle split landed (`022d8c9a`).
- DR-1 broker-lifecycle landed (`be8b724b`).
- EW-3 tab-number gap cache (`4f89adda`).

EW-11 is layered **on top** of all of these. The probes will confirm the candidates still rank in their current positions at this HEAD.

### 1.5 What this plan deliberately is NOT

- **Not** a structural rewrite of any emission method. Phase A pattern only: scale=1 short-circuit + manual `+` concat. Same byte output, same element kind, same z-order, no group/state changes.
- **Not** a batching plan. EW-10 Phase B was falsified; do not retry batching here. The plan stays inside the emission method.
- **Not** an attempt to cache `Font.toCssString()`. Per observation 17610, `Font.toCssString` already caches per `(font, scale)`. No headroom there. (§4 confirms this.)

---

## 2. Per-method body inventory

All bodies as of `5f7d425e` (current HEAD).

### 2.1 `SvgCanvas.fillText` — `SvgCanvas.ts:172`

```ts
public fillText(text: string, x: number, y: number): void {
    if (text === '') {
        return;
    }
    let s: string = `<text x="${x * this.scale}" y="${
        y * this.scale
    }" style='stroke: none; font:${this.font.toCssString(this.settings.display.scale)}; ${this.getSvgBaseLine()}'`;
    if (this.color.rgba !== '#000000') {
        s += ` fill="${this.color.rgba}"`;
    }
    if (this.textAlign !== TextAlign.Left) {
        s += ` text-anchor="${this.getSvgTextAlignment(this.textAlign)}"`;
    }
    s += `>${SvgCanvas._escapeText(text)}</text>`;
    this.buffer += s;
}
```

**Per-call work:**
- 2 `* scale` multiplies (x, y).
- 1 `this.font.toCssString(this.settings.display.scale)` — already cached per `(font, scale)`, returns memoised string.
- 1 `this.getSvgBaseLine()` virtual call (returns a constant string per `textBaseline` setting).
- 1 `this.color.rgba !== '#000000'` branch — `Color.rgba` is a **plain string field** (`Color.ts:65`), already pre-computed in the constructor (line 35-37). No getter cost.
- 1 `this.textAlign !== TextAlign.Left` branch — `this.getSvgTextAlignment(this.textAlign)` if non-default.
- 1 `SvgCanvas._escapeText(text)` — short-circuits cheaply on numeric text per EW-8 (commit `2251590d`).
- 4 template-literal interpolations in the main string, plus 1 each for the conditional fragments.
- 1 string concat to `this.buffer`.

**Scale=1 short-circuit applicable?** YES. The 2 multiplies become identity ops.

**Other state-dependent reads:**
- `this.font.toCssString(scale)` — call this exactly once per fillText regardless of fast/slow path (cached, ~ns-cheap). Cannot be hoisted further without altering output (a font setter mutation between two fillText calls *must* re-compute, which the cache already handles).
- `this.getSvgBaseLine()` — returns one of 4 string constants. Reads `this.textBaseline`. Cheap, but the dispatch is a switch; could be hoisted if measured to matter (likely not).

**Estimated per-call cost:** rough — Phase 0 will measure. If fillRect is 171 ns/call, fillText is likely 200-350 ns due to extra string concat and conditional branches.

**Volume estimate:** 5.24 ms / 250 ns ≈ 20-25k calls/iter. Phase 0 §3.1 to confirm.

**Caller fan-in:** 28 live sites (excluding Skia / commented), covering bar numbers, lyrics, tempo text, chord names, fret labels, time-signature numbers (Numbered notation), tuplet labels, repeat counts, tie labels. Bar numbers, fret numbers, and numbered-notation digits are likely the bulk of volume on this corpus.

### 2.2 `SvgCanvas.lineTo` — `SvgCanvas.ts:104`

```ts
public lineTo(x: number, y: number): void {
    this._currentPathIsEmpty = false;
    this._currentPath += ` L${x * this.scale},${y * this.scale}`;
}
```

**Per-call work:**
- 1 field write (`_currentPathIsEmpty = false`).
- 2 `* scale` multiplies.
- 1 template-literal with 2 interpolations.
- 1 string concat to `this._currentPath`.

**Scale=1 short-circuit applicable?** YES, and the body is **smaller** than fillRect — the entire string template is `` ` L${x*s},${y*s}` ``, very amenable to the fast path:

```ts
if (s === 1) {
    this._currentPath += ' L' + x + ',' + y;
} else {
    this._currentPath += ` L${x * s},${y * s}`;
}
```

**Other state-dependent reads:** none. The body is pure on `this._currentPath` and `this.scale`. No font/color/font-size reads.

**Per-call cost (rough):** ~100 ns / call. Body is ~half of fillRect. 3.36 ms ÷ 100 ns ≈ 30-35k calls/iter on canon-resize-drag. (Or could be fewer calls × higher per-call cost.)

**Caller fan-in:** 15+ live sites. Volume drivers on canon-resize-drag: `BarLineGlyph.paintExtended` (every barline calls moveTo+lineTo+stroke), `LineBarRenderer.paintBeams` (beam stems via path), `TripletFeelGlyph`, `LineRangedGlyph` paths. NOT `paintStaffLines` (that uses fillRect, not lineTo).

**Note**: `lineTo` accumulates into `this._currentPath`, **not** `this.buffer`. The string-concat target differs from fillRect/fillText. This is mechanically the same shape but a separate buffer. Phase 0 measurement should not be confused by this.

### 2.3 `CssFontSvgCanvas._fillMusicFontSymbolText` — `CssFontSvgCanvas.ts:39`

```ts
private _fillMusicFontSymbolText(
    x: number, y: number, relativeScale: number,
    symbols: string, centerAtPosition?: boolean
): void {
    x *= this.scale;
    y *= this.scale;

    this.buffer += `<g transform="translate(${x} ${y})" class="at" ><text`;
    const scale = this.scale * relativeScale;
    if (scale !== 1) {
        this.buffer += ` style="font-size: ${scale * 100}%; stroke:none"`;
    } else {
        this.buffer += ' style="stroke:none"';
    }
    if (this.color.rgba !== '#000000') {
        this.buffer += ` fill="${this.color.rgba}"`;
    }
    if (centerAtPosition) {
        this.buffer += ` text-anchor="${this.getSvgTextAlignment(TextAlign.Center)}"`;
    }
    this.buffer += `>${symbols}</text></g>`;
}
```

**Per-call work:**
- 2 `* scale` multiplies (mutating the parameters — unusual, but the params are local copies).
- 1 `const scale = this.scale * relativeScale` — a third multiply.
- 3-5 separate `this.buffer += ...` concats, each with its own template literal.
- 2 `if` branches (color, centerAtPosition).
- 1 virtual call to `this.getSvgTextAlignment` if centerAtPosition.

**Scale=1 short-circuit applicable?** PARTIAL. The body already short-circuits on `this.scale * relativeScale === 1`, but it still computes `x *= this.scale`, `y *= this.scale`, and reads `relativeScale` etc. Two layers of scale:
- `this.scale` (the global display.scale) — what EW-10 Phase A short-circuited.
- `relativeScale` (per-call symbol scale) — bench corpus passes both `1` (most callers) and `noteScale` / `_scale` / `MultiBarRest` factors.

**Two short-circuit paths possible:**
1. `this.scale === 1` AND `relativeScale === 1` — fully no-multiply, no font-size attr. Smallest body.
2. `this.scale === 1` AND `relativeScale !== 1` — no x/y multiply, but font-size attr is `relativeScale * 100`.
3. `this.scale !== 1` — keep current template literal form (HiDPI; rare in bench).

A simpler two-way split (`s === 1` for `this.scale`) is the EW-10 mirror. Decide in Phase 0 whether the nested split is worth the extra branch.

**Other state-dependent reads:**
- `this.color.rgba` — pre-computed string field, cheap.
- `this.getSvgTextAlignment(TextAlign.Center)` — returns `'middle'`. Could be a string literal directly; minor.

**Per-call cost (rough):** ~250-400 ns. The 3-5 separate concats hurt more than a single bigger one.

**Volume estimate:** 6.08 ms / 300 ns ≈ 20k calls/iter on canon-resize-drag. Music symbols (noteheads, rests, accidentals, clefs, time signatures).

**Sub-shape: `fillMusicFontSymbol(x, y, scale, sym, ...)`** at `CssFontSvgCanvas.ts:10` is a one-line wrapper that builds `&#${symbol};` and calls `_fillMusicFontSymbolText`. Not separately optimisable; its cost is in `_fillMusicFontSymbolText`.

### 2.4 Other SvgCanvas emission methods (audit pass)

Quick survey of remaining methods in `SvgCanvas.ts` to ensure no above-σ-threshold candidate is missed:

| Method | File:line | Body shape | Scale=1 helps? | Likely volume | In scope? |
|---|---|---|---|---|---|
| `beginGroup` | :39 | One concat, one interpolation, no `*scale` | NO (no scale ops) | M | NO — no scale work, body too small |
| `endGroup` | :43 | Literal append | n/a | M | NO |
| `endRender` | :47 | Literal append | n/a | 1/iter | NO |
| `strokeRect` | :81 | Template literal, multiple `* scale`, conditional `stroke-width` | YES | L (`BeatTimerGlyph` only on bench? unlikely on canon-resize-drag — Phase 0 to count) | DEFER — likely below 1 ms |
| `closePath` | :96 | Literal `' z'` append | n/a | N | NO |
| `moveTo` | :100 | Identical shape to lineTo (template + 2 multiplies) | YES | M (~half of lineTo, since each path has 1 moveTo per N lineTos) | **YES — bundle with lineTo for symmetry, ~1 ms surface estimate** |
| `quadraticCurveTo` | :109 | Template + 4 multiplies | YES | L (TieGlyph, LineBarRenderer slurs) | DEFER unless Phase 0 finds it above 0.5 ms |
| `bezierCurveTo` | :114 | Template + 6 multiplies | YES | L (TieGlyph mostly) | DEFER unless Phase 0 finds it above 0.5 ms |
| `fillCircle` | :121 | Composite (writes `_currentPath` then calls `fill()`) | YES (the path-build part) | N (BarLineGlyph dotted-barline only) | DEFER |
| `strokeCircle` | :134 | Same as fillCircle | YES | N | DEFER |
| `fill` | :147 | Conditional template literal | NO (no `*scale` in body itself) | M | DEFER (template literal is small; little headroom) |
| `stroke` | :159 | Conditional template literal w/ `lineWidth * scale` | YES (when `lineWidth !== 1 || scale !== 1`) | M | DEFER — body branching is already short-circuited |
| `fillText` | :172 | See §2.1 | YES | M-H | **YES** |
| `beginRotate` | :271 | Template + 2 multiplies | YES | L (rotated text in StaffSystem etc.) | DEFER |
| `lineTo` | :104 | See §2.2 | YES | M-H | **YES** |
| `_fillMusicFontSymbolText` (CssFontSvgCanvas) | :39 | See §2.3 | YES | M-H | **YES (TBD by Phase 0)** |

**Conclusion**: in scope = `fillText`, `lineTo`, `moveTo` (symmetric with lineTo, ~free addition), `_fillMusicFontSymbolText` (subject to Phase 0 cost confirmation). The rest stay on the unchanged path.

### 2.5 Why moveTo joins lineTo

`moveTo` and `lineTo` have **identical body shape** — a template literal with two `* scale` interpolations appended to `_currentPath`. The only difference is the command letter (`M` vs `L`) and that `lineTo` also clears `_currentPathIsEmpty`. Applying the same fast-path to both is symmetric — leaving moveTo on the slow path while lineTo is fast would create a semi-arbitrary split that future readers would have to justify. Bundle them together.

`quadraticCurveTo` (4 multiplies) and `bezierCurveTo` (6 multiplies) have higher per-call savings but much lower volume — `TieGlyph` is the main caller and ties are rendered once per beat-pair, not per beat. Phase 0 will count them; defer unless the count is >1k/iter.

---

## 3. Phase 0 — empirical probes

Same shape as EW-10 Phase 0 (`EW-10-PHASE-0-PROBES.md`): a single instrumentation patch wrapping all candidate methods, run the bench once, write a findings doc, **revert the instrumentation**. The findings doc is committed; no source change ships from Phase 0.

### 3.1 Per-method call count / iter on canon-resize-drag

For each of `fillText`, `lineTo`, `moveTo`, `_fillMusicFontSymbolText` (and optionally `quadraticCurveTo`, `bezierCurveTo`, `strokeRect` as audit-pass spot-checks):
- Wrap the body with a counter `++callCount[name]` and a `process.hrtime.bigint()` start/end accumulator.
- Run `node dist/run.mjs --only canon-resize-drag --trials 1 --label phase0-EW11`.
- Report per-iter counts and total ns spent per method.
- Confirm rank order matches the top-15.

**Volume tier prediction (revise after probe):**

| Method | Predicted calls / iter | Predicted ns / call |
|---|---:|---:|
| `lineTo` | 20-40k | 80-150 |
| `moveTo` | 10-20k | 80-150 |
| `fillText` | 15-30k | 200-350 |
| `_fillMusicFontSymbolText` | 15-30k | 200-400 |

### 3.2 Per-method per-call ns cost

With `process.hrtime.bigint()` straddling the body:
- Confirm the **distribution** matches the top-15 self-time: counts × ns ≈ reported self-time ms.
- If the product is wildly off (>2× either direction), inspect — the profiler self-time aggregator may be miscounting (template-literal vs concat may split into V8 ICs).

### 3.3 Scale=1 hit rate

Specifically: count for each method, how many calls hit `this.scale === 1` (and for `_fillMusicFontSymbolText`, also how many have `relativeScale === 1` vs not).

Prediction (per EW-10 Phase 0 §8.1): **100 % at `this.scale === 1`** for all SvgCanvas methods on canon-resize-drag. If the prediction holds, the slow-path template literal is dead code in this bench and the fast path captures all volume.

For `_fillMusicFontSymbolText`: report the `relativeScale === 1` rate separately. If it's also >80 %, the nested fast-path (§2.3 option 1) becomes attractive.

### 3.4 State-read overhead specific to fillText

The fillText body reads `this.font.toCssString(this.settings.display.scale)` once per call. Add a counter:
- How often does `Font._css` stay cached vs re-compute?
- Is `this.font` the **same instance** across most calls, or do different glyphs swap fonts mid-paint?

Prediction: `this.font` mutates often (every glyph that calls `using ElementStyleHelper.bar` may swap it). But because the cache is keyed on `(family, size, style, weight, scale)`, hitting the cache requires equality on those — and the same logical font swapped in and out will still need to invalidate-and-rebuild. **Worth a probe**.

If `_css` is being rebuilt frequently (say >50 % of fillText calls), there's a second-order optimisation outside the EW-11 scope: hoist the font-CSS into an immutable `(family×size×style×weight)` map keyed by hashed identity. **Out of scope for this round** — just flag it for a future EW.

### 3.5 Output: artifact location

Phase 0 findings → `packages/bench/analysis/2026-06-14-resize-drag/EW-11-PHASE-0-PROBES.md`. Same format as `EW-10-PHASE-0-PROBES.md`. Commit message: `docs(bench): EW-11 Phase 0 — empirical probes (no source change)`.

### 3.6 Decision gate after Phase 0

| Outcome | Action |
|---|---|
| All three candidates ≥ 90 % `scale=1` AND combined surface ≥ 8 ms confirmed | Proceed to Phase 1 bundling all three (+ moveTo). |
| `_fillMusicFontSymbolText` `scale=1` rate < 50 % (e.g. due to nested relativeScale always !=1) | Drop `_fillMusicFontSymbolText`, bundle fillText+lineTo+moveTo only (smaller margin). |
| Any candidate has <5k calls/iter (way below predicted volume) | Drop that candidate, reassess bundle. |
| Bundle total surface < 5 ms confirmed | Falsify per §9; do not proceed to Phase 1. |
| `quadraticCurveTo` or `bezierCurveTo` shows >1k calls/iter | Add to bundle (~free extension). |

---

## 4. Option matrix

### 4.1 `fillText` (`SvgCanvas.ts:172`)

**Shape sketch:**
```ts
public fillText(text: string, x: number, y: number): void {
    if (text === '') {
        return;
    }
    const s = this.scale;
    let str: string;
    if (s === 1) {
        str = '<text x="' + x + '" y="' + y +
              '" style=\'stroke: none; font:' +
              this.font.toCssString(this.settings.display.scale) +
              '; ' + this.getSvgBaseLine() + '\'';
    } else {
        str = `<text x="${x * s}" y="${y * s}" style='stroke: none; font:${this.font.toCssString(this.settings.display.scale)}; ${this.getSvgBaseLine()}'`;
    }
    if (this.color.rgba !== '#000000') {
        str += ` fill="${this.color.rgba}"`;
    }
    if (this.textAlign !== TextAlign.Left) {
        str += ` text-anchor="${this.getSvgTextAlignment(this.textAlign)}"`;
    }
    str += `>${SvgCanvas._escapeText(text)}</text>`;
    this.buffer += str;
}
```

**Note:** the conditional branches (`color != #000000`, `textAlign != Left`) can stay as template literals — they fire infrequently and the per-call savings of `+` would be lost in the branch overhead. Only the always-emitted main string gets the `+` fast path.

**Expected Δ:** 1.0-2.0 ms / iter (rough 20-30 % of 5.24 ms self-time).

**Risk:** **LOW**. The output must be byte-identical:
- `${x * 1}` and `'+x` both produce `Number.prototype.toString(x)`, identical for all finite numbers.
- `${y * 1}` ditto.
- String concatenation order is preserved.
- The slow path retains the original template literal verbatim for scale!=1.

**Output verification:** for any call, the two branches produce string-equal output. This can be asserted in dev with an assertion harness around the body OR confirmed by running the visual vitest suite (1599 tests) and expecting **zero diffs**.

**Dependencies:** none.

### 4.2 `lineTo` (`SvgCanvas.ts:104`)

**Shape sketch:**
```ts
public lineTo(x: number, y: number): void {
    this._currentPathIsEmpty = false;
    const s = this.scale;
    if (s === 1) {
        this._currentPath += ' L' + x + ',' + y;
    } else {
        this._currentPath += ` L${x * s},${y * s}`;
    }
}
```

**Expected Δ:** 0.5-1.0 ms / iter (rough 20-30 % of 3.36 ms self-time).

**Risk:** **VERY LOW**. The body is among the smallest emission methods. Pure string-buffer-write, no state mutation beyond the existing `_currentPathIsEmpty` and `_currentPath` fields.

**Output verification:** same numeric-toString equivalence as fillText. Byte-identical when scale=1; slow path untouched.

**Dependencies:** none.

### 4.3 `moveTo` (`SvgCanvas.ts:100`) — bundled with lineTo

**Shape sketch:**
```ts
public moveTo(x: number, y: number): void {
    const s = this.scale;
    if (s === 1) {
        this._currentPath += ' M' + x + ',' + y;
    } else {
        this._currentPath += ` M${x * s},${y * s}`;
    }
}
```

**Expected Δ:** 0.3-0.6 ms / iter. moveTo is roughly half the volume of lineTo (one moveTo per N lineTos per path).

**Risk:** **VERY LOW**. Identical shape to lineTo.

**Output verification:** same byte-identity guarantee.

**Dependencies:** bundle with lineTo for symmetry. Splitting them is arbitrary.

### 4.4 `_fillMusicFontSymbolText` (`CssFontSvgCanvas.ts:39`)

**Shape sketch (single-level short-circuit on `this.scale === 1`):**
```ts
private _fillMusicFontSymbolText(x, y, relativeScale, symbols, centerAtPosition?): void {
    const s = this.scale;
    if (s === 1) {
        this.buffer += '<g transform="translate(' + x + ' ' + y + ')" class="at" ><text';
    } else {
        const sx = x * s;
        const sy = y * s;
        this.buffer += `<g transform="translate(${sx} ${sy})" class="at" ><text`;
    }
    const scale = s * relativeScale;
    if (scale !== 1) {
        this.buffer += ` style="font-size: ${scale * 100}%; stroke:none"`;
    } else {
        this.buffer += ' style="stroke:none"';
    }
    if (this.color.rgba !== '#000000') {
        this.buffer += ' fill="' + this.color.rgba + '"';
    }
    if (centerAtPosition) {
        this.buffer += ' text-anchor="middle"';  // hoist getSvgTextAlignment(Center) → constant
    }
    this.buffer += '>' + symbols + '</text></g>';
}
```

**Expected Δ:** 1.0-2.0 ms / iter (rough 15-30 % of 6.08 ms self-time). Slightly less headroom than fillText because the body has more branches and the `relativeScale` multiply remains.

**Risk:** **LOW**, but slightly higher than fillText/lineTo because:
- The body has 3 separate `this.buffer +=` appends in the existing form. The fast-path collapses two of them but preserves all branch conditions.
- The hoisting of `getSvgTextAlignment(Center)` → `'middle'` is a constant fold. Verified by reading `SvgCanvas.ts:212`: `case TextAlign.Center: return 'middle';`. Direct substitution is byte-identical for the `centerAtPosition === true` branch.

**Output verification:** byte-identical for all 4 combinations of (color, centerAtPosition) × (scale=1, scale!=1). Worth asserting via a debug check in Phase 0 before committing.

**Dependencies:** none on EW-11 internals. But this lives in `CssFontSvgCanvas`, not `SvgCanvas` — so the diff touches 2 files instead of 1.

### 4.5 Bundle summary

| Method | Δ expected (ms) | Risk | Files changed |
|---|---:|---|---|
| `fillText` | 1.0-2.0 | LOW | `SvgCanvas.ts` |
| `lineTo` | 0.5-1.0 | VERY LOW | `SvgCanvas.ts` |
| `moveTo` | 0.3-0.6 | VERY LOW | `SvgCanvas.ts` |
| `_fillMusicFontSymbolText` | 1.0-2.0 | LOW | `CssFontSvgCanvas.ts` |
| **Sum** | **2.8-5.6 ms** | LOW | 2 files |

Combined Δ expectation **2.8-5.6 ms**. The σ floor for `★` is ~2.2 ms (1 %) on this round's anchor. The bundle is expected to clear σ but with thin margin — n=64 paired A/B should be sufficient; fall through to n=128 if marginal.

---

## 5. Bundle strategy

### 5.1 One commit, not four

Each candidate alone is sub-σ (per §1.3). Phase A landed for fillRect was a single-method commit because fillRect alone cleared σ; EW-11 candidates don't, so the bundle is the unit. Splitting into 4 commits invites bisect-mode regret if the sum lands but one component slightly regresses an unrelated scenario — and adds 4× the A/B time. Keep it one commit.

### 5.2 Bundle order (decision: bundle the safe block, not the cheapest)

Order isn't strictly relevant for one commit, but for **post-Phase-0 narrowing** (if Phase 0 falsifies one candidate), drop the highest-risk / lowest-expected-Δ first:

1. `lineTo` + `moveTo` — keep always (VERY LOW risk, identical shape to landed fillRect).
2. `fillText` — keep unless Phase 0 shows < 5k calls/iter or scale=1 rate < 50 %.
3. `_fillMusicFontSymbolText` — drop first if Phase 0 falsifies (it touches a different file, and `getSvgTextAlignment` constant-fold is a (tiny) new tactic not used by EW-10 Phase A).

Stop bundling when the **sum of expected Δs exceeds 2σ (~7.4 ms)**. The current bundle sums to ~2.8-5.6 ms expected, so all four stay in.

### 5.3 Byte-identical output is the correctness contract

Each bundled change must satisfy: **for every input, the fast-path output equals the slow-path output character-for-character.**

The argument:
- For numeric `x` (the only thing being interpolated for coordinate values), `${x}` invokes `ToString(x)` per ECMA-262 §13.2.8.2 ↔ TemplateLiteral evaluation. `'' + x` invokes the abstract `ToString` per §6.1.7.1 / §7.1.17. Both branches reach `Number::toString` and produce identical output for any IEEE-754 double.
- For the slow-path multiply `${x * s}` where `s === 1`, `x * 1 === x` for any finite x. (For `x === NaN`, both branches still produce `'NaN'`. For Infinity, both produce `'Infinity'` / `'-Infinity'`.) `x * 1` is non-identity for `-0` (still `-0`, which `ToString` renders as `'0'`). So no edge case differs.
- String concatenation order in the fast path **matches** the template literal expansion order — verified by reading the source side-by-side per method.

**Defensive verification mechanism**: vitest's pixel-diff suite (1599 fixtures) compares rendered PNGs. If the SVG output is byte-identical, the rasteriser sees identical input, and no diff will appear. If even one byte differs (whitespace, attribute order, escape sequence), some fixture will surface it. This is the test backstop for the correctness argument.

### 5.4 What is explicitly NOT in scope

- **Caching `font.toCssString()` per call site** — handled internally already (observation 17610), no headroom.
- **Hoisting `getSvgBaseLine()` to a field** — could save a virtual call but has a state-coupling concern (must invalidate on `textBaseline` change). Defer to a future EW unless Phase 0 shows it as a measurable cost.
- **Generalising the fast-path to a private helper method** — adds a function call frame on the hot path. Inline-by-duplication is the right shape (EW-10 Phase A did it; honour the precedent).
- **Any change to `_currentPath` data structure** — keep it a string.
- **Pre-computing `' L' + x` segment templates** — that's batching territory, EW-10 Phase B class, falsified.

---

## 6. Phases

### 6.1 Phase 0 — instrumentation probes

**Duration**: 30-45 min.
**Output**: `EW-11-PHASE-0-PROBES.md` committed; instrumentation reverted before the commit.
**Commit message**: `docs(bench): EW-11 Phase 0 — empirical probes (no source change)`.

**Steps:**
1. Apply instrumentation patch to all four candidate methods (counters + ns timers).
2. Build bench: `cd packages/bench && npx vite build`.
3. Run: `node dist/run.mjs --only canon-resize-drag --trials 1 --label phase0-EW11`.
4. Extract counts and timings.
5. Verify against §3.6 decision gate.
6. Write findings doc.
7. `git stash` or `git restore` the instrumentation; confirm working tree clean.
8. Commit the findings doc only.

### 6.2 Phase 1 — implement the bundle (single commit)

**Duration**: 30-45 min.
**Output**: one commit touching `SvgCanvas.ts` and `CssFontSvgCanvas.ts`.
**Commit message**: `perf(svg): EW-11 — scale=1 fast path for fillText, moveTo, lineTo, _fillMusicFontSymbolText`.

**Steps:**
1. Apply the four method diffs per §4.
2. Verify each body manually: side-by-side compare fast-path concat with the original template literal; confirm byte-identical for scale=1.
3. Run vitest: `cd packages/alphatab && npx vitest run`. Expect 1599/1599 with zero diffs.
4. If diffs appear, classify per §7 anti-revert (likely Class A: byte mismatch).
5. Commit.

### 6.3 Phase 2 — A/B at n=64

**Duration**: 15-25 min.

**Steps:**
1. `cd packages/bench && node scripts/build-ab.mjs --ref-a 5f7d425e`.
2. Run paired A/B at n=64:
   ```
   node dist/runAB.mjs --a 5f7d425e --b HEAD --only canon-resize-drag \
     --iterations 64 --label probe-EW11-bundle
   ```
3. Decision rule (per the σ-floor anchor §1):
   - `★ Δ ≤ -2.2 ms` (≥ 1 %, clears σ) → proceed to Phase 3 (vitest re-verify + land).
   - **Marginal** (`★ Δ ∈ (-2.2, 0)` ms or wide CI) → re-run at n=128 with a fresh label. If still below σ → fall to §6.5.
   - `★ Δ ≥ 0` ms (regression) → fall to §6.5 (unbundle + investigate).

### 6.4 Phase 3 — vitest re-verify (already done in §6.2, this is a paranoia gate)

Already run in §6.2 Step 3. If anything changed between §6.2 and §6.3 (it shouldn't — no source edits between them), re-run.

Expected: zero diffs. If diffs appear, this is a **Class E DR-1 §18.5 surface** — surface to the user, do NOT auto-classify or auto-revert per §7.

### 6.5 Unbundle / falsification path

If the bundle is below σ:
1. Per-candidate A/B (4 separate n=64 runs). If any single candidate clears σ alone (unlikely per §1.3), land just that one.
2. If no subset clears σ → falsify per §9. Document in `EW-11-FALSIFICATION.md` + HOTSPOTS.md entry.

### 6.6 Phase 4 — ship

**Steps:**
1. Confirm the working tree is clean.
2. Land the bundle commit (already present if Phase 1 completed).
3. Update `packages/bench/HOTSPOTS.md`: move EW-11 entry to "Easy wins — landed" with commit hash, A/B result, and per-method breakdown.
4. Plan §10 postscript (write into this plan file): record the actual A/B outcome, any deviations from expectations, and re-baseline snapshot path.
5. Commit docs change: `docs(perf): EW-11 — fillText/lineTo/_fillMusicFontSymbolText scale=1 fast path landed`.

---

## 7. Anti-revert directives

These carry over from EW-10 plan §11 and DR-1 plan §18.5. Read before each phase.

> **DO NOT** run `npm run test-accept-reference` if vitest produces any diff PNGs. Surface the diff to the user; do NOT auto-classify or auto-accept (DR-1 §18.5 Class E pattern).

> **DO NOT** revert on the first below-σ A/B reading. Re-run at n=128 first per §6.3.

> **DO NOT** alter the byte content of the emitted SVG. The slow path (`this.scale !== 1`) is preserved verbatim; the fast path (`this.scale === 1`) must produce **character-for-character identical** output. If any test diffs, the diff is a bug, not an "acceptable rasteriser variance" — investigate per §7.1.

> **DO NOT** generalise to other emission methods mid-round. The §2.4 audit defined the scope. If Phase 0 reveals (say) `bezierCurveTo` is hot, defer it to EW-12, do not enlarge this round mid-flight.

> **DO NOT** introduce a private helper method to share the fast-path body across methods. Inline-by-duplication is the EW-10 Phase A precedent and avoids a virtual call on the hot path.

> **DO NOT** cache `Font._css` differently. Observation 17610: the cache already covers (family×size×style×weight×scale). Hoisting it would not help and would risk staleness.

> **DO NOT** hoist `this.color.rgba` into a local in the body. It's already a plain string field (no getter cost), and the JIT-visible read is cheaper than a synthesised local under V8's elision rules. EW-10 Phase 0 §8.1 ("T2 hoist Color.rgba — dropped, no value").

> **DO** commit Phase 0 findings, Phase 1 bundle, and Phase 4 docs as **three separate commits**.

> **DO** re-run cross-scenario neutrality after the bundle lands:
> ```
> node dist/runAB.mjs --a 5f7d425e --b HEAD --iterations 32 --label EW11-cross
> ```
> (no `--only` filter). Expect `·` / `~` on every non-target scenario; `★` regression on any scenario is grounds for revert.

> **DO** include a `vitest 1599/1599` check in §6.2 step 3 AND §6.3 step 4.

### 7.1 Class E visual-diff inspection (carried over from EW-10 §11.1)

If vitest produces visual diffs:
- **Class A** (clear regression: pixel content moved or text broken). The expected outcome IF byte-identity broke. Revert immediately; the diff means the fast-path output diverged from the slow-path output. Inspect the relevant method body; either fix and re-verify or unbundle that method.
- **Class B** (subpixel anti-aliasing shift). NOT EXPECTED — byte-identical output produces no subpixel shift. If observed, the change is somehow not byte-identical; investigate as Class A.
- **Class C** (layout regression). NOT EXPECTED — no layout-affecting state is touched. If observed, treat as Class A.
- **Class D** (identity / class attribute). NOT EXPECTED — no `beginGroup`/`endGroup` or attribute reordering. If observed, treat as Class A.
- **Class E** (improvement / pre-existing bug encoded in reference). Surface to user. **DO NOT** auto-accept.

---

## 8. Definition of done

EW-11 is shippable when **all** hold:

- **vitest 1599/1599** in `packages/alphatab`. Zero diff PNGs.
- **A/B `★` Δ ≤ -2.2 ms** (≥ 1 %, the σ-floor target) on canon-resize-drag at n=64 paired vs `5f7d425e`. (Or `★` at n=128 if n=64 is marginal.)
- **Cross-scenario neutrality**: every non-target scenario on a n=32 paired A/B shows `·` / `~` / `★ improvement`. No `★` regressions.
- **HOTSPOTS.md updated**: EW-11 under "Easy wins — landed", listing the four affected methods, the A/B result, and the commit hash.
- **Plan postscript (§10)**: actual per-method ns/call, total Δ, and any deviations from expectation recorded in this file.

---

## 9. Documented falsification path

If the bundle clears neither σ nor a 1 % threshold at n=128:

**Write `EW-11-FALSIFICATION.md`** (or postscript to this plan, §10):

> **EW-11 fillText/lineTo/moveTo/_fillMusicFontSymbolText surface** — bundle of four scale=1 fast paths extending the EW-10 Phase A pattern. Measured `★` Δ = X.XX ms at n=64 (paired vs 5f7d425e), CI [...], below the 2.2 ms σ-floor. Per-candidate fallback A/B (each n=64) likewise sub-σ. **EW-10 Phase A was the highest-value Phase-A-shape extraction.** The remaining hot SVG emission surface is now intrinsic at this codebase shape: per-call costs (~100-350 ns for the body) are dominated by the string-build and buffer-concat, not by the template-literal-vs-`+` mechanics. Future revisit would require either (a) a structurally different emission shape (batched, indexed, or numeric-buffer flushes — EW-10 Phase B class, also falsified), or (b) a buffer-write path that bypasses V8 string-concatenation entirely (e.g. typed-byte buffer with deferred UTF-8 encoding — DR-3 territory).

Update HOTSPOTS.md: EW-11 to **"Demoted at this site"** (same section as EW-2(b), EW-3 micro-devirt, EW-5).

This is an **acceptable outcome**. The pattern is established, the surface is small, the evidence forecloses follow-ups in this shape.

---

## 10. Quick reference card

```
σ-floor anchor: post-EW10 σ ±3.68 ms (1.66 %).
A/B reference: 5f7d425e (post-EW-3, EW-10 Phase A landed).
Target: ★ Δ ≤ -2.2 ms (1 %) on canon-resize-drag.

Phase 0 (empirical probes; no source change):
  Instrument fillText / lineTo / moveTo / _fillMusicFontSymbolText
  Run: node dist/run.mjs --only canon-resize-drag --trials 1 --label phase0-EW11
  Verify:
    - All ≥ predicted volume? proceed
    - scale=1 rate ≥ 90 % for each? proceed
    - any candidate <5k calls/iter or <50 % scale=1? drop that one
  Revert instrumentation; commit findings doc.

Phase 1 (single source commit):
  Apply §4 diffs to SvgCanvas.fillText, SvgCanvas.lineTo, SvgCanvas.moveTo,
  CssFontSvgCanvas._fillMusicFontSymbolText.
  Verify byte-identity by side-by-side reading.
  Run vitest 1599/1599. Expect zero diffs.
  Commit: perf(svg): EW-11 — scale=1 fast path for fillText / lineTo / moveTo / _fillMusicFontSymbolText

Phase 2 (A/B at n=64):
  node scripts/build-ab.mjs --ref-a 5f7d425e
  node dist/runAB.mjs --a 5f7d425e --b HEAD --only canon-resize-drag \
    --iterations 64 --label probe-EW11-bundle
  Decision:
    ★ Δ ≤ -2.2 ms → land (Phase 3)
    marginal      → re-run at n=128
    below σ       → §6.5 unbundle, falsify if no subset clears

Phase 3 (vitest paranoia + cross-scenario neutrality):
  cd packages/alphatab && npx vitest run  → 1599/1599
  cd packages/bench && node dist/runAB.mjs --a 5f7d425e --b HEAD \
    --iterations 32 --label EW11-cross  (no --only)
  Any non-target ★ regression? revert.

Phase 4 (ship):
  HOTSPOTS.md: EW-11 under "Easy wins — landed"
  Plan §10 postscript with actual numbers
  Commit: docs(perf): EW-11 — fillText/lineTo/_fillMusicFontSymbolText scale=1 fast path landed

NEVER:
  - test-accept-reference without user confirmation
  - introduce a shared private helper for the fast path (inline-by-duplication)
  - cache font/color/baseline state in EW-11 scope (Phase 0 may flag for future EWs)
  - alter slow-path (scale !== 1) bodies
  - enlarge scope mid-round (bezierCurveTo etc. → EW-12)
  - commit Phase 0 + Phase 1 + Phase 4 together
```

---

## 11. Supporting evidence

- **EW-10 Phase A precedent**: commit `244c8e0b`, landed `★ Δ -4.14 ms / -2.7 %` at n=64. Source diff at `SvgCanvas.ts:52-77`.
- **EW-10 Phase 0 findings**: `packages/bench/analysis/2026-06-14-resize-drag/EW-10-PHASE-0-PROBES.md` — methodological template for §3 probes.
- **σ-floor anchor**: `packages/bench/baselines/post-EW10.json` (σ ±3.68 ms / 1.66 %).
- **A/B reference**: `5f7d425e` — current HEAD of `feature/perf` at session start.
- **Color.rgba is a string field** (no getter cost): `packages/alphatab/src/model/Color.ts:35-37, 65`.
- **Font.toCssString already caches per (font, scale)**: `packages/alphatab/src/model/Font.ts:354, 457, 482-498` and observation 17610.
- **Caller fan-in inventories** (from grep of `canvas.fillText` / `canvas.lineTo` / `canvas.moveTo` / `canvas.fillMusicFontSymbol(s)?`):
  - `fillText`: 28 live sites across glyphs (NoteNumberGlyph, BarNumberGlyph, ChordDiagramGlyph, BarTempoGlyph, LyricsGlyph, TabWhammyBarGlyph, TripletFeelGlyph, NumberedNoteHeadGlyph, TextGlyph, TieGlyph, AlternateEndingsGlyph, LineRangedGlyph, DirectionsContainerGlyph, BeatTimerGlyph, TabBendGlyph, RepeatCountGlyph, NumberedKeySignatureGlyph, StaffSystem trackname).
  - `lineTo`: 15+ sites (BarLineGlyph, TripletFeelGlyph, LineBarRenderer beams/slurs, OttavaGlyph, TabSlideLineGlyph, TabWhammyBarGlyph, CrescendoGlyph, TieGlyph, AlternateEndingsGlyph, DeadSlappedBeatGlyph, ScoreBrushGlyph, TabBrushGlyph, TabBendGlyph, ScoreSlideLineGlyph).
  - `moveTo`: same sites as lineTo (paired).
  - `fillMusicFontSymbol(s)`: 12 sites (LineBarRenderer tuplets/middle, MultiBarRestGlyph, TrillGlyph, TripletFeelGlyph, NumberGlyph, NoteVibratoGlyph, DirectionsContainerGlyph, MusicFontGlyph).

---

## 12. Estimated effort

| Phase | Wall-clock | Notes |
|---|---|---|
| 0 | 30-45 min | Instrumentation patch on 4 methods, build bench, run single trial, write findings, revert instrumentation, commit |
| 1 | 30-45 min | Apply 4 method diffs, side-by-side correctness reading, vitest |
| 2 | 15-25 min | build-ab, n=64 A/B, evaluate |
| 2b (if marginal) | 15-25 min | n=128 re-run |
| 3 | 10-15 min | vitest paranoia + cross-scenario neutrality A/B at n=32 |
| 4 | 15-20 min | HOTSPOTS.md update + plan §10 postscript + docs commit |
| **Total (clean path)** | **~2-2.5 hours** | If Phase 0 confirms scope and bundle clears σ at n=64 |
| **Total (falsified)** | **~3-4 hours** | If §6.5 unbundle + per-candidate A/B + falsification record |

---

## 13. The two non-negotiable rules

1. **Byte-identical output is the correctness contract.** If vitest diffs, the diff is a bug. Investigate; do not accept.
2. **Phase 0 decides scope.** Do not implement Phase 1 with assumptions from §2 alone — measure first.

---

## (§10 postscript — to be written after Phase 4 lands or §6.5 falsifies)

_Placeholder. Fill in with: actual Phase 0 numbers (per-method calls/iter, ns/call, scale=1 rate), Phase 2 A/B `★` Δ + CI + n, final HEAD commit hash, deviations from §4 expectations, cross-scenario neutrality result, HOTSPOTS.md before/after row, any Class E visual-diff surfacing._

# EW-3 (expanded) — Staff-line-gap-aware paint surface

**Status**: PLAN — investigation + option matrix, no source edits.
**Branch**: `feature/perf`, HEAD `d5fd6667`.
**Baseline**: `packages/bench/baselines/post-EW10.json` (5-trial),
canon-resize-drag = **221.31 ± 3.68 ms**.
σ floors: 1 % = **2.21 ms**, ≥ 2σ = **7.36 ms**.

---

## 1. Goal & framing (plain English)

### Product requirement

When alphaTab renders guitar tablature, the **horizontal staff lines** must
not visually cut through the **fret-number digits** drawn on top of them.
The current product behaviour leaves a small horizontal gap in each
staff line behind every tab number, so the digits stay legible.

The output background is **transparent** — alphaTab cannot solve the
problem by drawing a small white rectangle over the line at the digit's
position, because the digit would then have a white box around it on a
non-white host page. The same constraint rules out any approach that
relies on a **solid-coloured mask rectangle drawn after the staff line**:
that rectangle would still be visible against a transparent or coloured
background.

The visual outcome the user explicitly wants preserved:
- Staff lines visible everywhere EXCEPT directly behind tab numbers.
- No coloured fill behind the digits — the host page colour shows through.

### Perf surface

Post-EW-10 5-trial CPU top of the staff-line-gap-aware paint surface on
**canon-resize-drag**:

| # | Self ms | Self % | Function | Role |
|---:|---:|---:|---|---|
| 7 | **5.65** | 2.42 % | `collectSpaces` (`TabBarRenderer.ts:89`) | gap inventory |
| 8 | 5.26 | 2.25 % | `paintBackground` (`LineBarRenderer.ts:118`) | parent of staff-line painting |
| 11 | **4.59** | 1.97 % | `paintStaffLines` (`LineBarRenderer.ts:131`) | gap-aware emission |

**Combined surface = ~15.5 ms / iter** (note: this is the union of all
three frames' self time; some overlap likely between `paintBackground`
and `paintStaffLines` because `paintBackground` calls `paintStaffLines`
inside itself, so the genuine in-scope budget is whichever of these
three frames is *not* upstack of the others — likely ~10-13 ms / iter
of distinct in-scope cost). Well above the 7.36 ms ≥ 2σ floor.

### Design question

Can we reduce the wall-clock cost of producing the staff-line-with-gaps
visual output by ≥ 2.2 ms / iter (σ floor) and ideally ≥ 7.4 ms / iter
(≥ 2σ ★), while preserving the transparent-background product
behaviour?

The user has explicitly opened scope: **algorithmically different
approaches are on the table**, not just micro-optimisation of the
current shape. The current shape — `collectSpaces` builds a per-line
list of (x, width) gap intervals, `paintStaffLines` iterates each
drawn line and emits N+1 `<rect>` chunks between the gaps — is one of
several legal solutions to the product requirement.

---

## 2. Architecture map — current implementation

### 2.1 Dispatch tree

`BarRendererBase.paint`
→ `paintContent` (`BarRendererBase.ts:817`)
  → `paintBackground` (virtual; `BarRendererBase.ts:840` base)
    - `LineBarRenderer.paintBackground` override (`LineBarRenderer.ts:118-129`)
      - `super.paintBackground` — emits the `layoutingInfo.paint` debug-spring guides
      - `this.paintStaffLines(cx, cy, canvas)` (`LineBarRenderer.ts:126`)
        - `this.collectSpaces(spaces)` (virtual; `LineBarRenderer.ts:142`)
          - `LineBarRenderer.collectSpaces` (no-op stub, line 184-186)
          - `TabBarRenderer.collectSpaces` (real impl, line 89-114)
          - `ScoreBarRenderer` / `SlashBarRenderer` / `NumberedBarRenderer`:
            inherit the no-op stub (verified via grep — no `override` in
            these three subclasses)
      - `this.paintSimileMark(cx, cy, canvas)` — unrelated to gap surface

### 2.2 `collectSpaces` — TabBarRenderer.ts:89

```
protected override collectSpaces(spaces: Float32Array[][]): void {
    if (this.additionalMultiRestBars) {
        return;
    }
    const padding: number = this.smuflMetrics.staffLineThickness;
    const tuning = this.bar.staff.tuning;
    for (const voice of this.voiceContainer.beatGlyphs.values()) {
        for (const bg of voice) {
            const notes: TabBeatGlyph = (bg as TabBeatContainerGlyph).onNotes as TabBeatGlyph;
            const noteNumbers: TabNoteChordGlyph | null = notes.noteNumbers;
            if (noteNumbers) {
                for (const [str, noteNumber] of noteNumbers.notesPerString) {
                    if (!noteNumber.isEmpty) {
                        spaces[tuning.length - str].push(
                            new Float32Array([
                                this.beatGlyphsStart + bg.x + notes.x + noteNumbers!.x - padding,
                                noteNumbers!.width + padding * 2
                            ])
                        );
                    }
                }
            }
        }
    }
}
```

**Inputs read** (data dependencies):
- `this.additionalMultiRestBars` — bar identity, immutable after layout.
- `this.smuflMetrics.staffLineThickness` — global, immutable.
- `this.bar.staff.tuning.length` — model, immutable.
- `this.voiceContainer.beatGlyphs.values()` — Map iteration, **identity stable** across resize (same glyph instances), but iteration creates a fresh iterator each call.
- For each beat-glyph `bg`:
  - `bg.x` — **width-dependent**. Written by
    `MultiVoiceContainerGlyph._scaleToForce` (line 73-74, 81, 95-104) inside
    every `scaleToWidth` call.
  - `(bg as TabBeatContainerGlyph).onNotes as TabBeatGlyph` — identity stable.
  - `notes.x` — set during `doLayout`; not touched in `scaleToWidth`
    paths (verified — TabBeatGlyph.doLayout is layout-time only).
    **Width-invariant**.
  - `notes.noteNumbers` — instance, identity stable.
  - `noteNumbers.x` — set in `TabNoteChordGlyph.doLayout`; **width-invariant**.
  - `noteNumbers.width` — width of the digit run; **width-invariant**.
  - `noteNumbers.notesPerString` — `Map<number, NoteNumberGlyph>`,
    identity stable.
- `this.beatGlyphsStart` — getter returning `this.voiceContainer.x`,
  which is **width-dependent** (set in `BarRendererBase.applyLayoutingInfo`
  line 524 and updated implicitly via `scaleToWidth`).

**Critical observation**: the *only* width-dependent inputs are
`this.beatGlyphsStart` (a single scalar per bar) and `bg.x` (one per
beat container). The padded width `noteNumbers.width + padding * 2`
and the relative x within the beat (`notes.x + noteNumbers.x`) are
both width-invariant. The note-string identity (which staff-line index
the gap belongs to) is also width-invariant.

This means: a layout-time pre-compute can store **(string_index,
relativeX, width)** tuples per beat, and the resize-time consumer
needs only `(this.beatGlyphsStart + bg.x)` per beat to project them to
absolute coordinates. This is the algebraic foundation of Option A.

### 2.3 `paintStaffLines` — LineBarRenderer.ts:131

```
protected paintStaffLines(cx: number, cy: number, canvas: ICanvas) {
    using _ = ElementStyleHelper.bar(canvas, this.staffLineBarSubElement, this.bar, true);

    const spaces: Float32Array[][] = [];
    for (let i = 0, j = this.drawnLineCount; i < j; i++) {
        spaces.push([]);
    }

    if (!this.additionalMultiRestBars) {
        this.collectSpaces(spaces);
    }

    for (const line of spaces) {
        line.sort((a, b) => a[0] > b[0] ? 1 : a[0] < b[0] ? -1 : 0);
    }

    const lineWidth = this.width;
    const lineYOffset = this.smuflMetrics.staffLineThickness / 2;

    for (let i = 0; i < this.drawnLineCount; i++) {
        const lineY = this.getLineY(i) - lineYOffset;

        let lineX = 0;
        for (const line of spaces[i]) {
            canvas.fillRect(cx + this.x + lineX, cy + this.y + lineY,
                            line[0] - lineX, this.smuflMetrics.staffLineThickness);
            lineX = line[0] + line[1];
        }
        canvas.fillRect(cx + this.x + lineX, cy + this.y + lineY,
                        lineWidth - lineX, this.smuflMetrics.staffLineThickness);
    }
}
```

**Per-call work** (one call per rendered bar):

1. Allocate **`drawnLineCount`-element outer array of empty inner arrays**
   (5 lines for a 6-string TAB; the 6th tuning string maps to gap index 0,
   etc — `drawnLineCount = tuning.length`).
2. Virtual dispatch to `collectSpaces`.
3. For each line, allocate a `Float32Array(2)` per gap (one alloc per
   note-on-that-string in the bar) — pushed into `spaces[i]`.
4. Sort each line's gap list by x (in-place; ascending).
5. For each of N drawn lines: walk gaps in order, emit `fillRect` per
   contiguous segment (gaps_count + 1 rects per line).

**Allocation cost per bar (TAB only, 6 strings, ~6 beats avg)**:
- 1× `Float32Array[]` outer = 1 alloc.
- 6× inner `Float32Array[]` (empty arrays) = 6 allocs.
- ~6 beats × ~5 notes-with-numbers (some beats have fewer strings active)
  = ~30 Float32Array(2) allocs per bar.
- Plus the sort callback retained per `line.sort` call (6 closures, but
  the same arrow each time — V8 likely shares).

Per iter, canon-resize-drag has ~12 resize widths × ~37 TAB bars per
score-system × ~3-4 systems ≈ a few thousand `paintStaffLines` calls per
iter. The 4.59 ms self-time is consistent with several thousand
small-allocations and one ~1500-call fillRect emission stream.

**fillRect emission count** (rough): 6 lines × 7 chunks/line × ~1500
bars/iter × 12 widths ≈ ~90 000 fillRect calls per iter — a sizable
chunk of EW-10's 114 307 total fillRect calls. EW-10 §17923 confirmed
**paintStaffLines is 60-75 % of total fillRect volume**.

### 2.4 What's hot in this surface vs what's amortised

The 5.65 ms / 2.42 % `collectSpaces` self-time is the cost of the
gap-inventory walk: ~thousand allocation × `noteNumbers.notesPerString`
Map iterations × push-into-Float32Array-array. The 4.59 ms / 1.97 %
`paintStaffLines` self-time is the cost of the *consumer*: outer
allocation, sort, fillRect emission. Together: ~10.2 ms of in-scope
work on this surface per iter; `paintBackground` self-time (5.26 ms)
includes `super.paintBackground` (broker debug paint) plus the
fall-through to `paintStaffLines` and `paintSimileMark`, so the gap
surface's true self share is probably 10-13 ms / iter.

### 2.5 Lifecycle hooks for cache invalidation

If we build a layout-time cache on the renderer (Option A), we need a
clear invalidation policy. Existing precedents in the same file:

- `_layoutInvariantCached` (EW-9, `BarRendererBase.ts:557`): set true
  at end of `doLayout`/`reLayout`'s overflow walk. Invalidated by
  `invalidateLayoutCache()`, `wasFirstOfStaff`-flip in `reLayout`, and
  `recreatePreBeatGlyphs()`. **Survives `afterReverted`** — that's the
  whole point.
- `_voiceWalkDone` (DR-1, `BarRendererBase.ts:465`): set true after the
  voice-container walk. **Survives `afterReverted`**.

These flags survive because the broker writes they protect are
**bar-local invariant** (immutable per renderer lifetime). The
collectSpaces output's width-dependent term (`beatGlyphsStart + bg.x`)
must be refreshed every resize, but its width-invariant payload
(string_index, relativeX, width) can follow the same flag pattern.

---

## 3. Prior history

### 3.1 HOTSPOTS.md EW-3 narrative

From `HOTSPOTS.md` §118-147 (verbatim summary):

- **2026-06-13 first attempt**: extracted a module-level
  `paintStaffLineRects` helper; had `LineBarRenderer.paintStaffLines`
  pass `null` for the spaces, then overrode `paintStaffLines` in
  `TabBarRenderer` to call the helper with the real spaces. Goal:
  eliminate the 4-way megamorphic `collectSpaces` dispatch by replacing
  it with monomorphic per-subclass dispatch on the outer
  `paintStaffLines`. Refactor compiled clean, biome-passed, but the
  session noise floor was ~10 % so the result was inconclusive.

- **2026-06-13 round-3 verification**: same shape re-applied with the
  paired-sample A/B harness at n=64. Results:
  - canon-resize: -0.1 % `·` (CI half-width ≈ 0.8 ms at n=64).
  - canon-render: +1.4 % `·`.
  - All six scenarios within ±0.5 ms of zero, none clear `★` or `~`.
  - vitest 1599/1599 in both runs.
  - The polymorphic dispatch the profiler flagged is real but its
    absolute cost (~0.3 ms across both frames) was below σ.
  - **Demoted**: "bundle with a larger paint-path refactor only if one
    materialises for unrelated reasons; standalone the candidate
    cannot clear the σ floor."

- **2026-06-13 regression**: per claude-mem 17134, an EW-3 patch later
  showed a **+11.7 % ★ regression** on a re-apply — reverted.

### 3.2 Why the cost has grown relative to other surfaces

Pre-DR-1 / pre-EW-9 baseline had canon-resize-drag at ~257 ms; post-EW10
is 221 ms. The frames that competed with `collectSpaces` for share
(`registerLayoutingInfo` 7.0 ms, `calculateOverflows` 3.1 ms,
`_emitGroupOverflows` 2.4 ms, `_computeBeamingBounds` 2.9 ms) have all
been pulled out. The absolute ms / iter of `collectSpaces` may not have
changed much, but its **relative share** has gone up, and the **σ floor
also shrank** because the host workload got cheaper. A sub-1 ms win
was below σ; a 5-7 ms win on a 5.65 ms surface is above σ if achievable.

### 3.3 Why monomorphisation ALONE failed

The 2026-06-13 measurement showed monomorphisation moved ~0.3 ms.
The frames the profiler attributes to `collectSpaces` are not just the
v-table lookup — they include the **per-call work inside the function**
(Map iteration, Float32Array allocations, push to array-of-arrays).
That work is invariant under the dispatch shape; switching from virtual
to monomorphic just removed the IC miss cost.

The cost we now want to attack is the **per-iter sum of the inner
work**, which can only fall via:
- Doing the inner work fewer times (caching across resize cycles).
- Replacing the inner data structure with something cheaper.
- Skipping the inner work entirely via a different visual approach.

This is why §4 enumerates options that are NOT just monomorphisation.

---

## 4. Option matrix

Each option below is rated on: **expected Δ ms** (paired n=64 A/B on
canon-resize-drag), **blast radius** (files / contracts touched),
**risk** (likelihood of behavioural drift), and **dependencies** on
prior landings.

### A. Layout-time gap cache + projection at paint

**Shape**: at the end of `TabBarRenderer.doLayout` (after voice glyphs
are positioned), pre-compute a packed per-bar **gap descriptor**:
each entry is `(stringIndex, relativeX, width)` where `relativeX` is
the *bar-local* x of the gap measured from `voiceContainer.x`
(i.e. `bg.x + notes.x + noteNumbers.x - padding`). Store on the
renderer in a `Float32Array` (3 * N entries) plus a parallel
`Uint8Array` of string indices, or use a fused single packed buffer.

At paint time, `paintStaffLines` reads the cache, projects each entry
by adding `this.beatGlyphsStart` once to recover absolute x, and
emits the rects without going through the `collectSpaces` virtual
dispatch OR the per-call Map iteration OR the per-gap allocation.

The cache survives `afterReverted` for the same reason
`_voiceWalkDone` does — the gap descriptors are **bar-local
invariant**.

**Width-invariance verification** (critical):
- `bg.x` is set in `_scaleToForce` (line 73-74) — width-dependent.
- BUT what we need is `bg.x + notes.x + noteNumbers.x - padding -
  voiceContainer.x`. That equals `(bg.x - 0) + (notes.x + noteNumbers.x - padding)`
  where `notes.x + noteNumbers.x - padding` is width-invariant. The
  remaining `bg.x` term IS width-dependent. So **the cache cannot be a
  single layout-time scalar per gap** — it must be `(stringIndex,
  beatGlyphRelativeX_within_beat, width)` and at paint time we add
  `beatGlyphsStart + bg.x` for that specific beat.
- That means the cache must store **a reference to the beat-glyph**
  (or its index in the voice array) to look up the live `bg.x` at
  paint time.

**Refined cache shape** (algebraic):
```
struct CachedGap {
    stringIndex: u8;       // -> spaces[tuning.length - str] line
    beatRef: BeatGlyph;    // resolve to current bg.x at paint time
    relativeX: f32;        // notes.x + noteNumbers.x - padding
    width: f32;            // noteNumbers.width + padding * 2
}
```
Packed two-array variant for cache locality:
- `Float32Array(2 * N)` for `relativeX`/`width` pairs.
- `Uint32Array(N)` for `(stringIndex << 24) | beatGlyphIndex`.
- Parallel `BeatGlyph[]` for beat resolution by index.

At paint:
```
const base = this.beatGlyphsStart;
for (let i = 0; i < gapCount; i++) {
    const meta = packedMeta[i];
    const stringIdx = meta >>> 24;
    const bg = beatList[meta & 0xFFFFFF];
    const absX = base + bg.x + packedXY[2*i];
    const width = packedXY[2*i + 1];
    spaces[stringIdx].push(/* or emit directly without ever building spaces[][] */);
}
```

**Even better — skip the spaces[][] intermediate entirely**. The
`paintStaffLines` consumer only uses the `(x, width)` ranges per line,
sorted ascending. If the layout-time cache stores gaps **pre-sorted by
beatIndex** (which is also their x-order modulo grace notes, since
beats are positioned monotonically by `_scaleToForce`'s
`positions.get(...)` lookup), then the resize-time sort is also
amortised away.

**Verification**: grace notes break the monotonicity assumption — a
grace beat group can have a negative-x glyph (`relativeOffset` line
108-110 of MultiVoiceContainerGlyph). The cache may need a layout-time
sort instead of paint-time.

**Expected Δ ms**:
- Eliminates the 5.65 ms `collectSpaces` self-time outright on resize
  cycles (paid once at layout).
- Eliminates the per-bar `Float32Array(2)` allocations × ~30/bar.
- Eliminates the `line.sort()` cost per bar (6 sorts × ~5 entries).
- Keeps the `paintStaffLines` fillRect emission (still ~4.59 ms).
- **Estimated win: 4-6 ms / iter** (≥ 2σ ★ possible).

**Risk**: medium.
- (R1) Beat composition mutation across `afterReverted` — does any
  reverted-bar path mutate `noteNumbers.notesPerString` or
  `noteNumbers.width`? **Investigate Phase 0**: if no, survive
  `afterReverted` like `_voiceWalkDone` does.
- (R2) Grace-beat re-positioning across width changes — the relative
  offset between grace and main beats CAN change per resize (line
  108-110 of MultiVoiceContainerGlyph computes `relativeOffset` from
  `graceSpring[i].postSpringWidth - graceSpring[i].preSpringWidth`,
  width-invariant per spring; spring widths themselves are mostly
  layout-time). Need to verify the springs are width-invariant after
  initial layout (DR-1's `_voiceWalkDone` precedent says yes for the
  broker walk; the spring **stretch** values are width-dependent but
  the **pre/post-spring widths** themselves are layout-time).
- (R3) `recreatePreBeatGlyphs` doesn't touch the voice container, but
  the cache invalidation policy must still be defined.

**Blast radius**: 1 file (`TabBarRenderer.ts`) for the cache, 1 file
(`LineBarRenderer.ts`) for the paint-time read path. Optional
extension to `LineBarRenderer.paintStaffLines` signature to take a
pre-built spaces structure.

**Dependencies**: none — works at HEAD `d5fd6667`.

### B. Monomorphise `collectSpaces` dispatch

**Shape**: re-apply the 2026-06-13 attempt. Drop the
`LineBarRenderer.collectSpaces` virtual; have `LineBarRenderer.paintStaffLines`
do its work assuming no gaps. Override `paintStaffLines` in
`TabBarRenderer` to compute gaps inline and call a shared private
helper that does the per-line emission.

**Expected Δ ms**: 0.3-0.5 ms (sub-σ, by HOTSPOTS evidence).
**Risk**: low.
**Blast radius**: 2 files.
**Dependencies**: none.

**Why include this**: HOTSPOTS demoted it standalone, but if combined
with Option A it becomes free — Option A already overrides the
shape in `TabBarRenderer`, and the virtual stub in `LineBarRenderer`
can be removed at the same time. **Treat as a free bundled win
inside A, not a standalone option.**

### C. SVG `<mask>` cutout per system

**Shape**: emit one full-length staff `<path>` per system (covering all
bars on that staff), then attach an SVG `<mask>` listing the
tab-number rectangles as cut-outs. The `<mask>` semantically lets the
path show through where the mask is white and hides it where the mask
is black, producing the gap effect without any colored mask
rectangle — the host page colour shows through the cut-outs as required.

```xml
<defs>
  <mask id="staffmask-system-0">
    <rect x="..." y="..." width="systemW" height="staffH" fill="white"/>
    <rect x="gapX" y="gapY" width="gapW" height="gapH" fill="black"/>
    <!-- one black rect per tab number gap -->
  </mask>
</defs>
<g mask="url(#staffmask-system-0)">
  <rect x="..." y="..." width="systemW" height="thickness"/>
  <!-- 6 unbroken staff line rects -->
</g>
```

**Expected Δ ms** (Node-bench): potentially significant — collapses
N+1 rect emissions per line to 1 full-line rect, and the mask
rectangles are still emitted but as a flat list with no per-line
sort. Estimate **2-4 ms / iter** on canon-resize-drag Node-bench.

**Browser rasteriser concern (CRITICAL)**: SVG `<mask>` requires the
rasteriser to (a) build an offscreen mask bitmap at the size of the
masked group's bounding box, (b) composite the staff lines against it.
Browser rendering cost is NOT visible in the Node-bench. A win in
`runOne.mjs` (which measures the JS-side markup generation) could be
a **loss in the user's browser**. This is a known limitation of the
bench harness — see §5 constraints.

**Risk**: high. Trades measurable Node-bench savings for unmeasurable
browser cost. Visual output must be exact.

**Blast radius**: large — requires the renderer to emit elements at
**system level** (one mask per system) rather than **bar level** (one
emit per bar). The current paint pipeline is bar-local; this would
need either a deferred-flush mechanism in SvgCanvas (à la EW-10 Phase
B's batching, which failed) or a new "system-paint" lifecycle hook.

**Dependencies**: would benefit from a deferred-flush capability in
SvgCanvas that doesn't currently exist.

**Recommendation**: defer unless A fails, AND only attempt with
parallel browser-side measurement (which alphaTab's bench doesn't
have today).

### D. SVG `<clipPath>` cutout per system

**Shape**: identical to C but using `<clipPath>` semantics. Define a
clip region as "full system rect MINUS the tab-number rects" — the
"even-odd" fill-rule path approach lets the rect-minus-rects shape be
expressed in a single `<clipPath>` element. Apply to a single staff
`<rect>` per line.

**Expected Δ ms / risk / radius**: same trade-off as C, except
`<clipPath>` is generally rasterised slightly faster than `<mask>`
because it's a 1-bit alpha rather than 8-bit grayscale. Browser
rasteriser concern same as C.

**Recommendation**: prefer over C if either is pursued, but defer
both pending browser-side measurement capability.

### E. Single stroked `<path>` per staff line per bar with gap segments

**Shape**: replace the N+1 `fillRect` calls per staff line with a
single `<path d="M ... L ... M ... L ..."/>` where each `M ... L ...`
sub-stroke covers one contiguous segment, and gaps are skipped via
`M`-only repositioning.

**Why this might be different from EW-5 (demoted)**: EW-5 batched
**filled rects** into one filled `<path>` per bar and lost. The
hypothesis there was that SVG rasterisers special-case axis-aligned
`<rect>` with fill. A **stroked** `<path>` with line strokes is a
different rasteriser code path — closer to the visual intent
("draw a horizontal line, skipping gaps") and avoids the rect-fill
path entirely.

**Expected Δ ms (Node-bench)**: reduces ~7 fillRect calls per line ×
6 lines = ~42 calls per bar down to 6 path emissions (one per line).
Per-call cost of `fillRect` is ~171 ns (EW-10 Phase 0 §8.1); path
emission with N sub-moves is heavier per-call but amortises. **Rough
estimate: 1-3 ms / iter.**

**Browser rasteriser concern**: stroked `<path>` with multiple
`M`-only sub-strokes goes through the general path rasteriser, which
EW-5 evidence suggests is slower per-pixel than axis-aligned `<rect>`.
But the staff lines are **thin horizontal strokes** (1 px tall) — the
per-pixel cost is dominated by edge-finding, where axis-aligned might
not have as big an advantage as it does for filled rectangles.

**Risk**: medium. Demoted shape (EW-5) was filled-path; this is
stroked-path. Different code path, different prior, but the same
class of trade-off (Node savings vs browser cost).

**Blast radius**: small — change to `paintStaffLines` only, use
existing `canvas.beginPath`/`moveTo`/`lineTo`/`stroke` API.

**Recommendation**: behind A, ahead of C/D. Cheap to try and the
EW-5 demotion specifically called out "do this as line stroking
(closer to visual intent) ... if attacked again" as a legitimate
follow-up.

### F. Inline gap emission inside tab-number text path

**Shape**: tab numbers already emit `<text>` (or music-font symbol)
elements in `paintContent` via the voice-container's beat-glyph paint
chain. Instead of collecting gaps separately and consuming them in
`paintStaffLines`, have each tab-number emission ALSO emit a
`paintBackground`-time "gap registration" — or, dually, have
`paintStaffLines` query the already-positioned tab-number glyphs
directly without going through the `collectSpaces` virtual.

**Effectively**: this is Option A under a different name. The
"separate collect step" is the artifact we want to remove; whether
the read happens at layout-time-cache or at paint-time-via-direct-query
is an implementation choice.

**Recommendation**: subsumed by A.

### G. Drop `collectSpaces` for non-Tab renderers via type check

**Shape**: in `LineBarRenderer.paintStaffLines`, replace
`this.collectSpaces(spaces)` with `if (this instanceof TabBarRenderer)
{ this.collectSpaces(spaces); }`. The other three subclasses skip the
virtual entirely.

**Why this might help**: collectSpaces fires 4-way megamorphic and
3 of the 4 receivers return immediately. An `instanceof` check is
typically faster than a megamorphic dispatch.

**Expected Δ ms**: ~0.2-0.5 ms. The Score/Slash/Numbered receivers
hit a no-op stub that costs nothing once V8 inlines it, but the IC
miss is real. Replacing dispatch with instanceof + monomorphic call
removes the IC miss.

**Risk**: low.

**Recommendation**: bundle into A or B. Standalone too small.

### H. Cache invalidation policy: identity-mode

**Shape**: instead of an explicit invalidation flag, key the cache on
a **content fingerprint** of the bar (sum of `bg.absoluteDisplayStart`,
note count per beat, string set per beat). At paint, if the
fingerprint matches the cached one, use the cache; if not, rebuild.

**Why include this**: provides a fallback for cases where
`afterReverted` should invalidate (which we suspect it doesn't need
to, but the data structure offers a safety net).

**Risk**: low. Cheap fingerprint compare.

**Recommendation**: belt-and-braces on top of A. Phase 0
instrumentation should determine if the explicit
"`_voiceWalkDone`-pattern flag survives `afterReverted`" claim holds;
if it does, drop the fingerprint as overhead.

### I. Replace `Float32Array[][]` with packed buffers

**Shape**: independent of A. The current
`Float32Array[][]` data shape allocates an outer Array, N inner
Arrays, M Float32Array(2) entries. A single packed `Float32Array(2 *
maxGapsPerBar)` plus a `Uint16Array(drawnLineCount + 1)` of
per-line offsets eliminates the inner-array allocations and the
Float32Array(2) allocs.

**Expected Δ ms**: 0.5-1 ms (the alloc itself is sub-σ on V8's
young gen per DR-2 findings, but the array-of-arrays shape forces the
sort comparator into a `Float32Array`-cell access which can't be
cleanly auto-promoted).

**Risk**: low.

**Recommendation**: bundle into A. If A is implemented, the
intermediate buffer is gone anyway.

---

### Option summary table

| Opt | Shape | Δ ms est | Risk | Files | Bundle? |
|---|---|---:|---|---:|---|
| A | Layout-time gap cache + paint-time projection | 4-6 | M | 2 | primary |
| B | Monomorphise dispatch | 0.3-0.5 | L | 2 | inside A |
| C | SVG `<mask>` cutout | 2-4 (Node) | H | 3+ | defer |
| D | SVG `<clipPath>` cutout | 2-4 (Node) | H | 3+ | defer |
| E | Single stroked `<path>` per line | 1-3 | M | 1 | standalone |
| F | Inline at tab-number paint | (= A) | M | n/a | subsumed |
| G | `instanceof` short-circuit | 0.2-0.5 | L | 1 | inside A |
| H | Fingerprint-based invalidation | — | L | 1 | safety on A |
| I | Packed buffer for spaces | 0.5-1 | L | 1 | inside A |

**Primary**: A (with B, G, H, I bundled).
**Standalone fallback if A fails**: E.
**Deferred (browser cost unmeasurable)**: C, D.

---

## 5. Constraints reminder

1. **Background must stay transparent**. No solution may rely on a
   coloured fill (white, page-background, or otherwise) behind the
   tab number to "cover" the staff line. The line MUST be either
   absent there, or rendered with transparent stroke at that x-range
   (i.e. broken into segments, which is what we do today). `<mask>`
   and `<clipPath>` qualify (alpha-based hole, not coloured fill).
   Z-order with a coloured rectangle is NOT acceptable.

2. **Visual output must match the current product behaviour at the
   staff-line-gap level**. Subtle pixel differences (1-pixel offsets,
   stroke vs fill anti-aliasing) require user inspection before
   classifying — per DR-1 §18.5 Class E ("old behavior was wrong" is
   a pre-existing bug fix masked as a regression, not a regression).

3. **SVG primitives only**. Skia surface has its own rasteriser; this
   work is SVG-side only. The `SvgCanvas` API (`fillRect`, `beginPath`/
   `moveTo`/`lineTo`/`stroke`, `<g>` grouping) is the surface.

4. **Browser rasteriser cost is unmeasurable in this bench**. The
   bench measures `string +=` markup-generation cost in Node. SVG
   features that move work to the **rasteriser** (filters, masks,
   clipPaths, large `<path>`s with many subpaths) save Node time but
   add browser time. The bench will reward such trades; the user's
   actual experience may regress. **Options C, D, and E are subject to
   this constraint.** Options A, B, G, H, I keep the same SVG
   element kinds (`<rect>`) and only reduce Node-side dispatch /
   allocation work — they're safe.

5. **No `npm run test-accept-reference` without user confirmation**.
   Per DR-1 §18.5 and EW-10 §11.

---

## 6. Phase 0 — empirical probes (MANDATORY before any code change)

### 6.1 Per-renderer-class collectSpaces invocation count

**Goal**: verify the claim that only `TabBarRenderer` returns non-empty
gaps. If even one other receiver returns gaps, Options G and "drop
the virtual entirely" are invalid.

**Method**: temporarily instrument `LineBarRenderer.collectSpaces` and
`TabBarRenderer.collectSpaces` to log the receiver class name + the
spaces[i].length sum on each call. Run one iteration of
canon-resize-drag in the bench. Report the per-class breakdown.

**Expected**: 100 % of non-empty calls are TabBarRenderer.

**Decision**: if confirmed → G/B safe to bundle. If not → re-think
the whole "Tab-only" assumption.

### 6.2 Layout-vs-resize stability test for collectSpaces

**Goal**: determine whether the gap **descriptors** (string_index,
beat-relative x, width) are byte-identical across resize cycles for
the same bar, OR whether they shift on width changes (and if so,
along which dimension).

**Method**: at the END of the first `collectSpaces` call per renderer,
snapshot the returned spaces[][] data deep-copied. On every subsequent
call, compare the just-collected data against the snapshot byte-by-byte.
Log mismatches with diff descriptions ("x changed by +12.5 on
spaces[2][0]", "new entry appeared at spaces[1][3]", etc).

**Expected outcomes and decisions**:

- **Outcome A (best)**: byte-identical across all resize cycles on a
  given bar. → Option A primary cache shape is the simplest possible
  (absolute coords, no projection needed). **Most optimistic.**
- **Outcome B (likely)**: x-values shift by a constant per bar but
  the *relative* shape (intra-bar offsets, widths, string indices) is
  stable. → Option A's projection-from-relative-coords shape is
  needed. **The plan's primary assumption.**
- **Outcome C (worst)**: relative shape changes across resize cycles
  (different gap counts, widths shift). → Option A needs an explicit
  invalidation strategy keyed on what changed. Fall back to options
  E (stroked path) or G (cheap short-circuit).

**Effort**: ~30 min instrumentation patch + 1 bench run.

### 6.3 Per-call cost microbench

**Goal**: split the 5.65 ms / iter `collectSpaces` self-time into
(call_count × per_call_cost). If per-call is 100 ns × 56 500 calls,
that's a different optimisation problem than 5 µs × 1 130 calls.

**Method**: instrument with `performance.now()` deltas summed across
all `collectSpaces` calls in one iter. Log total / count / per-call.

**Effort**: ~10 min.

**Decision**: if per-call cost is dominated by Map iteration over
`notesPerString` (~6 strings per beat), then cache-of-flat-array shape
wins independently. If per-call cost is dominated by Float32Array(2)
allocation (the alloc shows up in DR-2 GC frames), the win on
Option A is bounded by the alloc share, which V8 amortises near-zero
per DR-2 evidence.

### 6.4 paintStaffLines work decomposition

**Goal**: split the 4.59 ms / iter into (a) the consumer side that
*depends* on spaces[][] (sort, walk, emit-between-gaps), (b) the
emit-rect work that is invariant of gap data (the final per-line
rect after the last gap, plus the no-gap path on non-Tab renderers).

**Method**: instrument `paintStaffLines` with two timed segments:
"pre-emit" (allocate, collectSpaces, sort) vs "emit" (the two
nested-loop fillRects). Sum per iter.

**Decision**: if "emit" is 80 %+ of the 4.59 ms, then the win from
optimising the consumer side (Option A's paint-time read path) is
capped at <1 ms — the only way to push lower is Options C/D/E
(reduce emission count via SVG primitives).

### 6.5 Bundle Phase 0 probes into one instrumentation patch

All four probes touch the same two files and can be measured in one
bench run. Plan: write the instrumentation patch, run
`cd packages/bench && node dist/run.mjs --only canon-resize-drag
--iterations 3 --label probe-EW-3`, dump the counters to a JSON file,
strip the instrumentation. Total elapsed time: ~30 min.

---

## 7. Decision tree

```
Phase 0 §6.1 confirms TabBarRenderer is sole non-empty?
├─ NO  → Options G / B / "drop virtual" off-table. Skip to fallback E.
└─ YES → continue

Phase 0 §6.2 stability outcome?
├─ A (byte-identical) → A primary, simplest cache shape (absolute coords).
├─ B (relative-stable) → A primary, projection cache shape (THIS PLAN'S DEFAULT).
└─ C (relative-shifts) → A needs explicit invalidation; consider B+G+E as
                          cheap-first bundle. If still below σ, retire EW-3.

Phase 0 §6.3 per-call cost dominated by Map iter or allocation?
├─ Map iter → A's gap-cache cleanly eliminates this. Strong primary.
├─ Allocation → A's win partially absorbed by V8 amortisation (DR-2 evidence).
│               Expected Δ lowers from 4-6 ms to 2-4 ms. Still ≥ σ floor.
└─ Other (function-call overhead, branch mispredict) → narrows to monomorph
                          which HOTSPOTS already demoted standalone.

Phase 0 §6.4 emit vs pre-emit dominance?
├─ pre-emit dominant → A is the primary lever.
├─ emit dominant → Consider E (stroked path) as bundled secondary.
└─ balanced → Bundle A + E in two phases.

After Phase 0 → Implement A. Measure A/B at n=64 paired.
├─ ★ ≥ -2.2 ms (≥ 1 %) → vitest, accept, HOTSPOTS update, ship.
├─ ~ -0.5 to -2.2 ms   → re-measure at n=128 to clear σ; if still ~,
│                         bundle with E as Phase 2.
└─ · below noise       → falsify; HOTSPOTS update with "demote v2";
                          attempt E standalone as last gasp.
```

---

## 8. Implementation phases

### Phase 0 — Instrumentation probes (§6)

- Branch off `feature/perf` HEAD `d5fd6667`.
- Write the four-probe instrumentation patch on a throwaway branch.
- Run `cd packages/bench && npx vite build && node dist/run.mjs
  --only canon-resize-drag --iterations 3 --label probe-EW-3-phase0`.
- Dump probe counters to `packages/bench/analysis/2026-06-14-resize-drag/
  EW-3-PHASE0-PROBES.md` with the §6 questions answered.
- DECISION POINT: proceed to Phase 1 or fall back to E / E+B per §7.

### Phase 1 — Option A baseline (cache shape, no skip)

**Goal**: build the layout-time cache and verify it produces
byte-identical output to the current paint, without yet activating
the skip path. Pure correctness verification.

**Sketch** (no code in this plan; for executor reference only):

1. Add private fields to `TabBarRenderer`:
   ```
   private _gapsCache: Float32Array | null = null;     // [relX, width, ...]
   private _gapsMeta: Uint32Array | null = null;        // [(stringIdx<<24)|beatIdx, ...]
   private _gapsBeatRefs: BeatContainerGlyphBase[] | null = null;
   ```
2. Override `doLayout`: after `super.doLayout()` (which positions
   voice glyphs), walk the same loop as current `collectSpaces`
   does, but write into the packed buffers instead of allocating
   Float32Array(2) per gap.
3. Add a new method `paintStaffLinesFromCache(cx, cy, canvas)`:
   - Project each cached gap by adding `this.beatGlyphsStart +
     beatRef.x` to its relX.
   - Bucket into per-string-line lists.
   - Sort each list.
   - Emit the same rects as current code.
4. Override `paintStaffLines` in TabBarRenderer to call the
   from-cache variant; keep `LineBarRenderer.paintStaffLines` for
   the other three subclasses (which all return empty gaps).
5. Add `collectSpaces` virtual removal (Option B+G bundle) — drop
   `LineBarRenderer.collectSpaces` stub now that no callers remain.

**Verification**: byte-diff the produced SVG markup against pre-patch
for a representative bar set. Must be identical.

### Phase 2 — Option A skip path (the actual win)

**Goal**: activate the cache hit on resize cycles. Add an
`_gapsCacheValid` flag that follows the `_voiceWalkDone` precedent
(survives `afterReverted`, invalidated by `recreatePreBeatGlyphs`,
`invalidateLayoutCache`, and explicit `_resetGapsCache` calls).

**Sketch**:
- `doLayout`: build cache, set flag true.
- `paintStaffLinesFromCache`: assert flag true; if false, raise (defensive — should not happen on the resize path).
- `reLayout`: do NOT rebuild cache (flag survives).
- `afterReverted`: do NOT invalidate flag (precedent: `_voiceWalkDone`).
- `recreatePreBeatGlyphs`: invalidate flag (cache may go stale if
  voice composition changed — defensive; voice composition probably
  doesn't change here, verify).
- `invalidateLayoutCache`: invalidate flag.

### Phase 3 — A/B measurement

```
node scripts/build-ab.mjs --ref-a d5fd6667
node dist/runAB.mjs --a <ref-a> --b <head-after-EW-3> \
  --only canon-resize-drag --iterations 64 --label probe-EW-3-A-cache
```

Pass criterion: **★ Δ ≤ -2.2 ms** (≥ 1 % / σ floor).
Stretch: **★ Δ ≤ -7.4 ms** (≥ 2σ).

### Phase 4 — vitest verification with Class E inspection

```
cd packages/alphatab && npx vitest run
```

Per DR-1 §18.5: if reference PNG diffs appear, **do not** revert.
Inspect each diff before classifying:
- Class A: cleanly improved (e.g. gap edge now snaps to integer
  pixel instead of fractional). Accept.
- Class B: cleanly identical (sub-pixel float noise). Accept.
- Class C: visual regression. Investigate root cause; do NOT
  revert without root cause.
- Class D: visual regression from a known unrelated source.
  Investigate; do NOT widen scope.
- Class E: old behaviour was wrong (pre-existing bug surfaced by
  the change). Accept and document.

User confirmation required before `npm run test-accept-reference`.

### Phase 5 — Multi-scenario cross-check

5-trial multi-process diff against `d5fd6667`:
```
node dist/run.mjs --label EW-3-vs-d5fd6667-5trial --iterations 30 \
  --trials 5 --baselines post-EW10
```

Pass criterion: no `★` regression on any other scenario.
Expected pattern (post-EW10 + EW-3 A): canon-resize-drag `★`,
canon-render directional, nightwish-* directional or flat, tiny-render
flat.

### Phase 6 — Ship

- Commit message: `perf(rendering): cache tab-number gap descriptors at layout`.
- Update HOTSPOTS.md §118 EW-3 entry: move from "demoted" to "landed".
- Update HOTSPOTS.md "Easy wins — landed" table with the n=64 paired
  Δ ms + CI + z + win-count.

### Phase N (conditional) — Fallback E (stroked path)

If A's Δ is between σ and 2σ (`~` range, not `★`), bundle E
(single stroked `<path>` per staff line per bar) as Phase 2 of the
same round. EW-5 demotion explicitly called out "do this as `<line>`
stroking" as a legitimate retry shape.

---

## 9. Anti-revert directives

Cross-references to prior plan §10-11 directives:

1. **No `npm run test-accept-reference` without user confirmation**
   per DR-1 §18.5. The executor must surface every PNG diff to the
   user with a Class A-E classification BEFORE running accept.

2. **No revert on first vitest red**. Inspect every diff. DR-1's
   §18 history is the canonical reminder: the executor reverted
   prematurely on visual diffs that turned out to be bug-fixes (9
   reference PNGs, all Class E "old behavior was wrong"). The plan
   §10.2-style "diagnostic gate" must be **measured**, not
   speculated.

3. **No widening scope to "fix" a Class D failure**. If a vitest
   failure traces to an unrelated source, file it as an issue, do
   NOT incorporate the fix into this round.

4. **§10-style fall-through requires measured erosion**. If Phase 1
   correctness verification passes but Phase 2 skip-path measurement
   shows degradation, *measure* whether the cache hit rate is
   sub-100 % before claiming the cache shape itself is wrong.

5. **`afterReverted`-style every-cycle hooks are anti-patterns**.
   The cache flag must follow the `_voiceWalkDone` precedent
   (survives `afterReverted`) unless Phase 0 §6.2 proves otherwise.
   v1 of DR-1 invalidated `_voiceWalkDone` in `afterReverted` and
   defeated the optimisation; v2 removed that invalidation. EW-3
   must NOT repeat that path.

6. **No bundling unrelated changes**. If Phase 0 reveals an
   unrelated optimisation opportunity (e.g. paintStaffLines emission
   work decomposition exposes a bug), file it as a separate EW
   entry, do NOT bundle.

---

## 10. Definition of done

- [ ] vitest **1599/1599**.
- [ ] A/B `★ Δ ≤ -2.2 ms` (≥ 1 % / σ floor) on canon-resize-drag at
      n=64 paired vs `d5fd6667`.
  - **Stretch**: ★ Δ ≤ -3.5 ms (covers ~50 % of the in-scope surface).
  - **Ideal**: ★ Δ ≤ -7.4 ms (≥ 2σ, half the in-scope surface).
- [ ] No `★` regression on other scenarios in 5-trial multi-process
      diff against post-EW10 baseline.
- [ ] HOTSPOTS.md §118 EW-3 entry moved from "demoted" narrative to
      "landed" table with all measurement evidence.
- [ ] All visual diffs (if any) surfaced to user with Class A-E
      classification BEFORE `test-accept-reference`.
- [ ] Phase 0 probe results archived at
      `packages/bench/analysis/2026-06-14-resize-drag/EW-3-PHASE0-PROBES.md`.

---

## 11. Documented falsification path

If no option clears σ → document. Specifically:

- **Option A falsified**: if Phase 0 §6.2 Outcome C (relative shape
  shifts across resize) holds AND the cache shape with invalidation
  doesn't recover the win, document the falsification and move EW-3
  from "demoted" to "structurally demoted — gap descriptors are
  width-dependent". File the gap-paint surface under DR-3 / DR-4
  for the next round of structural refactor.

- **Options C, D, E falsified at Node-bench level**: document as
  expected; the bench is not the user. Add a HOTSPOTS bench-harness
  limitation note: "SVG `<mask>`/`<clipPath>`/path-coalesce
  candidates are Node-measurable but not browser-measurable; defer
  to a future round when browser-side instrumentation lands".

- **All options falsified**: EW-3 retires permanently. Document the
  in-scope ~10-13 ms as **structurally locked** (intrinsic cost of
  the gap-aware paint surface under the transparent-background
  constraint, given the current SvgCanvas API).

- **Browser cost regression discovered post-ship**: if a future
  measurement shows a shipped EW-3 change (specifically C, D, or E
  if those land) regresses browser rendering, revert immediately
  and document the failure mode.

---

## 12. Quick reference card

**Surface**: `collectSpaces` (5.65 ms) + `paintStaffLines` (4.59 ms)
+ shared `paintBackground` frame (5.26 ms with overlap) =
**~10-13 ms in-scope**.

**σ floor**: 2.21 ms (1 %); 7.36 ms (≥ 2σ ★).

**Primary**: **Option A** — layout-time gap cache, paint-time
projection. Bundles B (drop virtual), G (instanceof shortcut), H
(fingerprint safety), I (packed buffers).

**Risk**: medium. Hinges on Phase 0 §6.2 outcome (relative-stable
descriptors expected, plan's default assumption).

**Fallback**: **Option E** — single stroked `<path>` per staff
line. EW-5 demotion explicitly green-lit this as a retry shape.

**Deferred** (browser-cost unmeasurable): **C** (`<mask>`),
**D** (`<clipPath>`).

**Anti-revert**: follow DR-1 §18.5 — no revert on first red, no
`test-accept-reference` without user confirm, follow
`_voiceWalkDone` lifecycle precedent for `afterReverted`.

**Done when**: vitest 1599/1599 + ★ ≥ -2.2 ms paired n=64 +
no ★ regression elsewhere + HOTSPOTS updated + Phase 0 probes
archived.

**Estimated round duration**: 1-2 sessions (~30 min Phase 0 +
~60 min Phase 1-2 + ~30 min Phase 3-5 + ~30 min Phase 6).

---

## Appendix A — Inputs to `TabBarRenderer.collectSpaces` (full)

Cited from `TabBarRenderer.ts:89-114` and traced to setters:

| Input | Type | Setter | Width-dep? |
|---|---|---|---|
| `this.additionalMultiRestBars` | bool | layout-time set in BarRendererBase | No |
| `this.smuflMetrics.staffLineThickness` | number | global settings | No |
| `this.bar.staff.tuning` | array | model | No |
| `this.voiceContainer.beatGlyphs` | Map | layout-time built in voice creation | No (Map identity) |
| `bg` (BeatContainerGlyph) | object | layout-time | No (identity) |
| `bg.x` | number | `MultiVoiceContainerGlyph._scaleToForce` | **YES** |
| `(bg as TabBeatContainerGlyph).onNotes` | object | layout-time | No |
| `notes.x` (= `TabBeatGlyph.x`) | number | layout-time in `doLayout` | No |
| `notes.noteNumbers` | object | layout-time | No |
| `noteNumbers.x` | number | layout-time in `TabNoteChordGlyph.doLayout` | No |
| `noteNumbers.width` | number | layout-time | No |
| `noteNumbers.notesPerString` | Map | layout-time | No (identity) |
| `noteNumber.isEmpty` | bool | per-note layout-time | No |
| `this.beatGlyphsStart` (= `voiceContainer.x`) | number | `applyLayoutingInfo` / scaleToWidth | **YES** |

**Width-dependent inputs**: 2 of 14 (`bg.x` and `beatGlyphsStart`).
**Algebraic separation**: cache the 12 width-invariants, project
with the 2 width-dependents at paint. This is the algebraic
foundation of Option A.

---

## Appendix B — File:line index

- `LineBarRenderer.paintBackground`: `packages/alphatab/src/rendering/LineBarRenderer.ts:118`
- `LineBarRenderer.paintStaffLines`: `packages/alphatab/src/rendering/LineBarRenderer.ts:131`
- `LineBarRenderer.collectSpaces` (stub): `packages/alphatab/src/rendering/LineBarRenderer.ts:184`
- `TabBarRenderer.collectSpaces`: `packages/alphatab/src/rendering/TabBarRenderer.ts:89`
- `BarRendererBase.paintContent` → `paintBackground`: `packages/alphatab/src/rendering/BarRendererBase.ts:817-818`
- `BarRendererBase.paintBackground` (base): `packages/alphatab/src/rendering/BarRendererBase.ts:840`
- `BarRendererBase._voiceWalkDone` precedent: `packages/alphatab/src/rendering/BarRendererBase.ts:465`
- `BarRendererBase._layoutInvariantCached` precedent: `packages/alphatab/src/rendering/BarRendererBase.ts:557`
- `BarRendererBase.afterReverted`: `packages/alphatab/src/rendering/BarRendererBase.ts:488`
- `BarRendererBase.recreatePreBeatGlyphs`: `packages/alphatab/src/rendering/BarRendererBase.ts:970`
- `MultiVoiceContainerGlyph._scaleToForce`: `packages/alphatab/src/rendering/glyphs/MultiVoiceContainerGlyph.ts:64` (sets `bg.x`)
- `TabNoteChordGlyph.notesPerString`: `packages/alphatab/src/rendering/glyphs/TabNoteChordGlyph.ts:26`
- `TabBeatGlyph.noteNumbers`: `packages/alphatab/src/rendering/glyphs/TabBeatGlyph.ts:23`
- `SvgCanvas.fillRect`: `packages/alphatab/src/platform/svg/SvgCanvas.ts:52`
- HOTSPOTS EW-3 narrative: `packages/bench/HOTSPOTS.md:118-147`
- HOTSPOTS EW-5 retry-shape green-light: `packages/bench/HOTSPOTS.md:189-194`
- DR-1 §18.5 anti-revert precedent: `packages/bench/analysis/2026-06-14-resize-drag/DR-1-BROKER-LIFECYCLE-PLAN.md` §15
- EW-10 §18 batching-failure precedent: `packages/bench/analysis/2026-06-14-resize-drag/EW-10-PLAN.md` §18

---

## 13. Execution outcome — Option A landed 2026-06-14

**Status**: Option A (layout-time gap cache + projection at paint) landed.
vitest 1599/1599. A/B at n=64 paired: `★ Δ = -4.09 ms (-2.5 %)` on
canon-resize-drag. n=128 confirmation: `★ Δ = -4.34 ms (-2.7 %)`,
CI [-5.37, -3.02], z=4.95. 5-trial session-paired multi-process diff:
canon-resize-drag -2.94 ms (-1.3 % `·`), no `★` regression on any
scenario. Within the plan §10 σ floor (≥ 1 % / 2.21 ms) and clears `★`;
below the 2σ stretch (7.36 ms) — consistent with Phase 0's measured
4-7 ms ceiling for the collectSpaces + sort surface.

### 13.1 Phase order

| Phase | Outcome | Commit |
|---|---|---|
| Phase 0 — probes | Outcome B confirmed, ceiling ~4-7 ms / iter | `927201c9` (docs-only, instrumentation reverted) |
| Phase 1 — cache built, projection through legacy spaces[][] | Built; A/B Δ -0.44 ms `·` (the per-gap Float32Array(2) alloc was preserved, defeating half the win) | not committed — superseded by Phase 2 |
| Phase 2 — paint-time direct emit from cache | Skips `Float32Array[][]` outer alloc, per-gap `Float32Array(2)` alloc, and the per-line sort | landed |
| Phase 3 — n=64 / n=128 A/B vs `05ec1dbb` | `★` at both n | — |
| Phase 4 — vitest | 1599/1599, no visual diffs | — |
| Phase 5 — 5-trial multi-process diff | session-paired: no `★` regression | — |
| Phase 6 — HOTSPOTS + this postscript | landed | this commit |

### 13.2 Phase 0 findings vs plan assumptions

Phase 0 measured outcomes vs the plan's §4 assumptions:

| Plan assumption | Phase 0 finding | Adjustment |
|---|---|---|
| Dispatch is 4-way polymorphic | 2-way in canon-resize-drag (Score + Tab) | Option G short-circuit is even cheaper than estimated; bundled inside A. |
| Outcome B (relative-stable) is the default expected outcome | **CONFIRMED** — widths byte-stable, x-positions shift with `bg.x` | Projection cache is the correct shape. |
| collectSpaces ~5.65 ms / iter (HOTSPOTS) | 3.96 ms / iter (probe estimate; includes timing overhead) | Authority unchanged. |
| paintStaffLines win ceiling 4-6 ms | Phase 0 §6.4: emit is 92.5 %; collectSpaces+sort are 14.8 %+7.5 % | Ceiling at ~4-5 ms (collectSpaces + sort + alloc). |
| afterReverted-pattern invalidation defeats the cache (DR-1 §18.2) | Confirmed — followed `_voiceWalkDone` precedent (survives `afterReverted`) | Cache invalidated only by `recreatePreBeatGlyphs` + `invalidateLayoutCache`. |

### 13.3 The "Phase 1 trap" — why the first implementation didn't clear σ

The plan §8 Phase 1 described "build the cache, verify byte-identity, no
skip yet". This executor's first cut implemented that literally:

- `_buildGapCache()` populated parallel arrays at layout.
- `collectSpaces` was rewritten to project the cache into the legacy
  `spaces[][]` shape — preserving the per-gap `Float32Array(2)`
  allocation.
- vitest passed 1599/1599.
- A/B at n=64: **Δ = -0.44 ms, `·`** (below σ).
- A/B re-run: **Δ = -2.76 ms, `·`** (CI [-4.35, +2.04] — wide because of
  one GC outlier).

The win was below σ. Diagnosis: the per-gap `Float32Array(2)` allocation
was the cost the cache was meant to eliminate, but Phase 1 kept it. Map
iteration was eliminated (the cache walk is a typed-array loop), but the
alloc share survived.

Phase 2 rewrote `paintStaffLines` to read directly from the cache and
emit `fillRect` without ever building `spaces[][]`. This is the actual
Option A shape per the plan §4 "Even better — skip the spaces[][]
intermediate entirely". With the alloc share gone:

- A/B at n=64: **`★ Δ = -4.09 ms (-2.5 %)`**, z=2.50, CI [-5.93, -1.37].
- A/B at n=128: **`★ Δ = -4.34 ms (-2.7 %)`**, z=4.95, CI [-5.37, -3.02].

### 13.4 What was NOT done

- **Option E (stroked path) was NOT attempted.** Option A cleared σ
  cleanly at `★` n=128; the §8 conditional fallback E only fires if A
  is `~` or `·`. The plan's bundled-secondary suggestion (§7.4) for
  emit-dominant cases is left as a future round.
- **The browser cost was not measured.** Options C and D remain
  deferred per plan §4 and §5.4.
- **No `npm run test-accept-reference`** — vitest had zero visual diffs.

### 13.5 Cache invariants verified

Per-line bucket layout is built in beat-iteration order, which is
left-to-right at layout time. The paint-time fast path walks each
bucket linearly and emits fillRects between consecutive gaps. A
slow-path insertion-sort kicks in if any inversion is detected (rare
grace-beat ordering edge case). vitest with 1599 fixtures including
grace-note alignment exercises this path; all pass with no diffs.

Padding (`smuflMetrics.staffLineThickness`) is captured at cache-build
time. The cache survives `afterReverted` and `reLayout`. The cache is
re-built lazily on first read if `_gapBucketEnd === null`.

### 13.6 Cite-by-commit timeline

- `927201c9` — Phase 0 empirical probes (docs-only, instrumentation reverted).
- Phase 1 superseded by Phase 2 (not committed — single-step develop).
- (this commit) — Phase 2 source change + HOTSPOTS + this postscript.

### 13.7 Plan corrections for future executors

- **Plan §8 Phase 1's "cache built but not consumed" verification step
  is a trap if read literally.** The cache's value comes from eliminating
  ALL of (a) Map iteration, (b) per-gap `Float32Array(2)` alloc,
  (c) per-line sort. Keeping the legacy `spaces[][]` consumer shape
  (which forces (b)) cuts the expected win roughly in half, often
  pushing it below σ. Either skip Phase 1's intermediate verification
  and go straight to direct-emit, OR explicitly note that Phase 1's
  expected Δ is sub-σ and Phase 2 is mandatory.

- **The "Outcome B = projection cache" foundation held.** Plan §6.2
  / §7.2 / §4 Appendix A are reusable templates for future projection-cache
  candidates (they share the same algebraic separation: layout-invariant
  payload + per-resize scalar projection).

- **Phase 0 §6.4 emit-dominance flag is load-bearing.** When emit cost
  dominates a surface, the cache-eliminate options are bounded by the
  pre-emit share. The plan correctly flagged Option E as a bundled
  secondary in this case; the executor's call to defer E until A
  clears σ standalone was conservative (A landed `★` without it).


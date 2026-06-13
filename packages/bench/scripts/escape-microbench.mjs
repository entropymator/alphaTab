#!/usr/bin/env node
// Microbenchmark harness for SvgCanvas._escapeText variants.
//
// Runs ONE variant for ONE trial in a fresh Node process and prints JSON.
// The orchestrator (escape-matrix.mjs) spawns this many times and
// aggregates the results.
//
// Usage:
//   node escape-microbench.mjs <variant-id>
//
// Stdout: single JSON line with { variant, trial_ms, per_call_ns, checksum, iterations, inputs_len }.
import { performance } from 'node:perf_hooks';

// =============================================================================
// Input distribution — mirrors the canon-resize fillText caller mix.
// ~90 % numeric (bar numbers, fret numbers), ~7 % short literals (TripletFeel,
// bend labels, tempo postfix), ~3 % user text (lyrics, directions, tempo
// prefix; occasionally with XML-special chars).
// =============================================================================
function buildInputs() {
    const inputs = [];
    // 900 numeric strings — bar numbers, fret numbers, octave dots.
    // BarNumberGlyph emits `${num}  ` (2-space suffix); fret numbers are .toString().
    for (let i = 0; i < 600; i++) {
        inputs.push(`${(i % 200) + 1}  `);
    }
    for (let i = 0; i < 300; i++) {
        inputs.push(String(i % 24)); // fret numbers 0-23
    }
    // 70 short fixed literals.
    const literals = [
        '(', ' = ', ' )', // TripletFeel
        '0', // TabWhammyBar
        '1/2', '1', '1 1/2', '2', 'full', // bend labels (TabBendGlyph)
        '8va', '8vb', '15ma', '15mb', // DirectionsContainer
        '120bpm', '140bpm', '60bpm', // tempo postfix
        'rit.', 'accel.', 'cresc.', 'dim.' // tempo prefix
    ];
    for (let i = 0; i < 70; i++) {
        inputs.push(literals[i % literals.length]);
    }
    // 30 user-text strings — most safe, a few with XML-special chars.
    inputs.push('Tempo: Allegro');
    inputs.push('Verse 1');
    inputs.push('Refrain');
    inputs.push('Chord: Em7');
    inputs.push('Intro');
    inputs.push('A simple lyric line');
    inputs.push('Another safe lyric');
    inputs.push('Vocal melody');
    inputs.push('Bridge section');
    inputs.push('Outro fade');
    inputs.push('Tempo prefix only');
    inputs.push('Chord progression');
    inputs.push('Solo guitar');
    inputs.push('Rhythm track');
    inputs.push('Bass line');
    inputs.push('Acoustic guitar');
    inputs.push('Electric piano');
    inputs.push('Drum fill');
    inputs.push('String section');
    inputs.push('Synth pad');
    inputs.push('Brass stab');
    inputs.push('Vocals & harmonies'); // & — with-match
    inputs.push('A "quoted" lyric'); // " — with-match
    inputs.push("Don't stop"); // ' — with-match
    inputs.push('<i>italics</i>'); // < > — with-match
    inputs.push('Voice & instrument'); // & — with-match
    inputs.push('Lead "guitar" solo'); // " — with-match
    inputs.push('Drummer\'s break'); // ' — with-match
    inputs.push('Tempo 120 & 140'); // & — with-match
    inputs.push('Lyric with <em>emphasis</em>'); // < > — with-match
    return inputs;
}

const INPUTS = buildInputs();
const N_ITER = 5000; // 5000 × 1000 inputs = 5M function calls per trial.

// =============================================================================
// Variants — each is a pure function of (text) → escaped string.
// All produce semantically identical output for the XML-escape contract:
// { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }.
// =============================================================================
const V0_baseline = text =>
    text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

const _V1_regex = /[&<>"']/;
const V1_test_guard_then_chain = text => {
    if (!_V1_regex.test(text)) return text;
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
};

const _V2_regex = /[&<>"']/g;
const V2_single_regex_switch_callback = text =>
    text.replace(_V2_regex, ch => {
        switch (ch) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
        }
        return ch;
    });

const _V3_map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const _V3_regex = /[&<>"']/g;
const V3_single_regex_map_callback = text =>
    text.replace(_V3_regex, ch => _V3_map[ch]);

const V4_replaceAll_chain = text =>
    text
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');

const _V5_regex = /[&<>"']/;
const V5_test_guard_then_replaceAll = text => {
    if (!_V5_regex.test(text)) return text;
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
};

const V6_indexOf_guard_then_chain = text => {
    if (text.indexOf('&') < 0 &&
        text.indexOf('<') < 0 &&
        text.indexOf('>') < 0 &&
        text.indexOf('"') < 0 &&
        text.indexOf("'") < 0) {
        return text;
    }
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
};

const V7_charcode_single_pass = text => {
    const len = text.length;
    let result = null;
    let lastIdx = 0;
    for (let i = 0; i < len; i++) {
        let entity = null;
        switch (text.charCodeAt(i)) {
            case 38: entity = '&amp;'; break;
            case 60: entity = '&lt;'; break;
            case 62: entity = '&gt;'; break;
            case 34: entity = '&quot;'; break;
            case 39: entity = '&#39;'; break;
        }
        if (entity !== null) {
            if (result === null) result = text.slice(0, i);
            else result += text.slice(lastIdx, i);
            result += entity;
            lastIdx = i + 1;
        }
    }
    if (result === null) return text;
    return result + text.slice(lastIdx);
};

const V8_split_join_chain = text =>
    text
        .split('&').join('&amp;')
        .split('"').join('&quot;')
        .split("'").join('&#39;')
        .split('<').join('&lt;')
        .split('>').join('&gt;');

const _V9_regex = /[&<>"']/;
const V9_test_guard_then_split_join = text => {
    if (!_V9_regex.test(text)) return text;
    return text
        .split('&').join('&amp;')
        .split('"').join('&quot;')
        .split("'").join('&#39;')
        .split('<').join('&lt;')
        .split('>').join('&gt;');
};

const V10_identity = text => text;

const VARIANTS = {
    V0: { fn: V0_baseline, label: 'baseline: 5x chained .replace(/g/) [no guard]' },
    V1: { fn: V1_test_guard_then_chain, label: 'test() guard + 5x chained .replace(/g/) [shipped EW-8]' },
    V2: { fn: V2_single_regex_switch_callback, label: 'single regex + callback (switch)' },
    V3: { fn: V3_single_regex_map_callback, label: 'single regex + callback (map lookup)' },
    V4: { fn: V4_replaceAll_chain, label: 'replaceAll literal chain [no guard]' },
    V5: { fn: V5_test_guard_then_replaceAll, label: 'test() guard + replaceAll literal chain' },
    V6: { fn: V6_indexOf_guard_then_chain, label: 'indexOf chain guard + 5x chained .replace(/g/)' },
    V7: { fn: V7_charcode_single_pass, label: 'charCodeAt single-pass manual escape' },
    V8: { fn: V8_split_join_chain, label: 'split/join chain [no guard]' },
    V9: { fn: V9_test_guard_then_split_join, label: 'test() guard + split/join chain' },
    V10: { fn: V10_identity, label: 'identity (return text) — floor measurement' }
};

const variantId = process.argv[2];
if (!variantId || !VARIANTS[variantId]) {
    console.error(`usage: node escape-microbench.mjs <variant>`);
    console.error(`variants: ${Object.keys(VARIANTS).join(', ')}`);
    process.exit(2);
}

const { fn, label } = VARIANTS[variantId];

// Correctness sanity: every variant must produce identical output to V0
// across the input distribution.
if (variantId !== 'V10') {
    for (let i = 0; i < INPUTS.length; i++) {
        const expected = V0_baseline(INPUTS[i]);
        const actual = fn(INPUTS[i]);
        if (expected !== actual) {
            console.error(`CORRECTNESS FAIL on input[${i}] = ${JSON.stringify(INPUTS[i])}:`);
            console.error(`  expected: ${JSON.stringify(expected)}`);
            console.error(`  actual:   ${JSON.stringify(actual)}`);
            process.exit(3);
        }
    }
}

// Warmup — 500 iterations of the full input set; let V8 settle into the
// optimised tier.
let warmupChecksum = 0;
for (let w = 0; w < 500; w++) {
    for (let k = 0; k < INPUTS.length; k++) {
        warmupChecksum = (warmupChecksum + fn(INPUTS[k]).length) | 0;
    }
}

// Force a GC if --expose-gc was passed, so each trial starts with a similar
// heap state.
if (typeof globalThis.gc === 'function') {
    globalThis.gc();
}

// Measure.
let checksum = 0;
const t0 = performance.now();
for (let i = 0; i < N_ITER; i++) {
    for (let k = 0; k < INPUTS.length; k++) {
        checksum = (checksum + fn(INPUTS[k]).length) | 0;
    }
}
const t1 = performance.now();

const totalCalls = N_ITER * INPUTS.length;
const trialMs = t1 - t0;
const perCallNs = (trialMs * 1e6) / totalCalls;

process.stdout.write(
    JSON.stringify({
        variant: variantId,
        label,
        trial_ms: trialMs,
        per_call_ns: perCallNs,
        total_calls: totalCalls,
        inputs_len: INPUTS.length,
        iterations: N_ITER,
        checksum,
        warmup_checksum: warmupChecksum
    }) + '\n'
);

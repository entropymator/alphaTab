/**
 * Statistics for paired A/B samples. Each iteration of the A/B runner
 * produces a `(a_i, b_i)` pair measured back-to-back in the same Node
 * process — they share V8 state, CPU pin, and thermal state, so the
 * delta `d_i = b_i - a_i` has dramatically less variance than two
 * independent runs of the same iteration. Paired statistics exploit
 * that.
 *
 * Test choices:
 * - Median of per-iteration deltas (robust to outliers, unlike mean).
 * - Sign test: count how many iterations have `b < a` vs `b > a`. Under
 *   the null hypothesis "no real difference", each direction is 50 %.
 *   With N pairs, ≥ 2σ ≈ N/2 + sqrt(N) faster-on-B iterations means
 *   reject the null at p < 0.05.
 * - Bootstrap percentile CI on the median delta: resample with
 *   replacement, compute median delta on each resample, take the 2.5th
 *   and 97.5th percentiles → 95 % CI. CI excluding zero ⇒ significant.
 *
 * Significance marker (matches the existing diff.ts grammar):
 * - `★`: 95 % bootstrap CI on median delta excludes zero AND sign-test
 *   z ≥ 2 (both agree).
 * - `~`: one of the two agrees that B is faster/slower.
 * - `·`: neither agrees.
 */

export interface PairedSample {
    /** Wall-clock duration of arm A in nanoseconds. */
    aNs: number;
    /** Wall-clock duration of arm B in nanoseconds. */
    bNs: number;
}

export interface PairedSummary {
    n: number;
    medianANs: number;
    medianBNs: number;
    medianDeltaNs: number;
    medianDeltaPct: number;
    meanDeltaNs: number;
    /** 95 % bootstrap percentile CI on the median delta. */
    ci95LowNs: number;
    ci95HighNs: number;
    /** Number of iterations where B was faster than A. */
    bFasterCount: number;
    /** Sign-test z-score: (bFasterCount - n/2) / sqrt(n/4). */
    signZ: number;
    /** `★` / `~` / `·`. */
    sig: string;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length / 2;
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[Math.floor(mid)];
}

function percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) {
        return sorted[lo];
    }
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * `seed` controls reproducibility of the bootstrap resample order, so the CI
 * is deterministic for the same input. We use a tiny xorshift32 PRNG;
 * Math.random would be non-reproducible across reports.
 */
function makePrng(seed: number): () => number {
    let state = seed | 0 || 0x9e3779b9;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0xffffffff;
    };
}

function bootstrapMedianCI(deltas: number[], iters: number, seed: number): { lo: number; hi: number } {
    const n = deltas.length;
    const rand = makePrng(seed);
    const medians: number[] = new Array(iters);
    const resample: number[] = new Array(n);
    for (let i = 0; i < iters; i++) {
        for (let j = 0; j < n; j++) {
            resample[j] = deltas[Math.floor(rand() * n)];
        }
        medians[i] = median(resample);
    }
    return {
        lo: percentile(medians, 0.025),
        hi: percentile(medians, 0.975)
    };
}

export function summarizePaired(samples: PairedSample[]): PairedSummary {
    const n = samples.length;
    const aSorted = samples.map(s => s.aNs);
    const bSorted = samples.map(s => s.bNs);
    const deltas = samples.map(s => s.bNs - s.aNs);

    const medA = median(aSorted);
    const medB = median(bSorted);
    const medD = median(deltas);
    const meanD = deltas.reduce((a, b) => a + b, 0) / n;
    const pct = medA > 0 ? (medD / medA) * 100 : 0;

    const bFaster = deltas.filter(d => d < 0).length;
    const signZ = n > 0 ? (bFaster - n / 2) / Math.sqrt(n / 4) : 0;

    const { lo, hi } = bootstrapMedianCI(deltas, 2000, 0xc0ffee);

    // Significance: both checks must agree the difference exists for ★.
    const ciExcludesZero = (lo > 0 && hi > 0) || (lo < 0 && hi < 0);
    const signSignificant = Math.abs(signZ) >= 2;
    let sig: string;
    if (ciExcludesZero && signSignificant) {
        sig = '★';
    } else if (ciExcludesZero || signSignificant) {
        sig = '~';
    } else {
        sig = '·';
    }

    return {
        n,
        medianANs: medA,
        medianBNs: medB,
        medianDeltaNs: medD,
        medianDeltaPct: pct,
        meanDeltaNs: meanD,
        ci95LowNs: lo,
        ci95HighNs: hi,
        bFasterCount: bFaster,
        signZ,
        sig
    };
}

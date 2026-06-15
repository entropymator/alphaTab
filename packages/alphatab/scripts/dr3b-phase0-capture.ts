/**
 * DR-3.B Phase 0b — fixture-equivalence capture.
 *
 * Renders a tiny score via SvgCanvas at three scales (1.0, 1.5, 2.0) using:
 *   (A) The current SvgCanvas / CssFontSvgCanvas (HEAD).
 *   (B) A hand-rolled DR-3.B variant that emits logical coords + a root
 *       viewBox attribute on <svg>.
 *
 * Writes 6 SVG files to packages/bench/analysis/2026-06-14-resize-drag/dr3b-phase0/:
 *   baseline-scale-1.svg, baseline-scale-1.5.svg, baseline-scale-2.svg
 *   patched-scale-1.svg,  patched-scale-1.5.svg,  patched-scale-2.svg
 *
 * Also prints a structural analysis: which lines differ, do numeric coordinates
 * in the patched form (logical) match baseline / scale at each non-1 scale?
 *
 * Usage:
 *   cd packages/alphatab && npx tsx scripts/dr3b-phase0-capture.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { ScoreRenderer } from '@coderline/alphatab/rendering/ScoreRenderer';
import { Settings } from '@coderline/alphatab/Settings';
import { Environment } from '@coderline/alphatab/Environment';
import { CssFontSvgCanvas } from '@coderline/alphatab/platform/svg/CssFontSvgCanvas';
import { Color } from '@coderline/alphatab/model/Color';
import { Font, FontStyle } from '@coderline/alphatab/model/Font';
import { TextAlign, TextBaseline } from '@coderline/alphatab/platform/ICanvas';
import type { MusicFontSymbol } from '@coderline/alphatab/model/MusicFontSymbol';
import type { RenderFinishedEventArgs } from '@coderline/alphatab/rendering/RenderFinishedEventArgs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = path.join(
    REPO_ROOT,
    'packages/bench/analysis/2026-06-14-resize-drag/dr3b-phase0'
);
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// DR-3.B patched CssFontSvgCanvas — logical coords + root viewBox.
// Drops every `*this.scale` from the emission methods; root <svg> carries
// viewBox covering logical W×H; width/height attrs carry the pixel-scaled
// values. Font.toCssString called with scale=1.
// ---------------------------------------------------------------------------
class Dr3bCssFontSvgCanvas extends CssFontSvgCanvas {
    public override beginRender(width: number, height: number): void {
        this.scale = this.settings.display.scale;
        const s = this.scale;
        // width/height arriving here are already pixel-scaled by ScoreLayout
        // (args.width *= scale at ScoreLayout.ts:148 boundary). Convert back
        // to logical for the viewBox; keep pixel-scaled for the width/height
        // attributes (DOM box).
        const lw = ((width / s) | 0);
        const lh = ((height / s) | 0);
        (this as any).buffer = `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 ${lw} ${lh}" width="${width | 0}px" height="${height | 0}px" class="at-surface-svg">\n`;
        (this as any)._currentPath = '';
        (this as any)._currentPathIsEmpty = true;
        this.textBaseline = TextBaseline.Top;
    }

    public override fillRect(x: number, y: number, w: number, h: number): void {
        if (w > 0) {
            (this as any).buffer +=
                '<rect x="' + x + '" y="' + y + '" width="' + w +
                '" height="' + h + '" fill="' + this.color.rgba + '" />\n';
        }
    }

    public override strokeRect(x: number, y: number, w: number, h: number): void {
        // Under root transform-scale, strokes scale with transform — DROP *scale.
        // blurOffset based on logical lineWidth only.
        const blurOffset = this.lineWidth % 2 === 0 ? 0 : 0.5;
        (this as any).buffer += `<rect x="${x + blurOffset}" y="${y + blurOffset}" width="${w}" height="${h}" stroke="${this.color.rgba}"`;
        if (this.lineWidth !== 1) {
            (this as any).buffer += ` stroke-width="${this.lineWidth}"`;
        }
        (this as any).buffer += ' fill="transparent" />\n';
    }

    public override moveTo(x: number, y: number): void {
        (this as any)._currentPath += ' M' + x + ',' + y;
    }

    public override lineTo(x: number, y: number): void {
        (this as any)._currentPathIsEmpty = false;
        (this as any)._currentPath += ' L' + x + ',' + y;
    }

    public override quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
        (this as any)._currentPathIsEmpty = false;
        (this as any)._currentPath += ` Q${cpx},${cpy},${x},${y}`;
    }

    public override bezierCurveTo(cp1X: number, cp1Y: number, cp2X: number, cp2Y: number, x: number, y: number): void {
        (this as any)._currentPathIsEmpty = false;
        (this as any)._currentPath += ` C${cp1X},${cp1Y},${cp2X},${cp2Y},${x},${y}`;
    }

    public override fillCircle(x: number, y: number, radius: number): void {
        (this as any)._currentPathIsEmpty = false;
        // No *scale.
        (this as any)._currentPath += ` M${x - radius},${y} A1,1 0 0,0 ${x + radius},${y} A1,1 0 0,0 ${x - radius},${y} z`;
        this.fill();
    }

    public override strokeCircle(x: number, y: number, radius: number): void {
        (this as any)._currentPathIsEmpty = false;
        (this as any)._currentPath += ` M${x - radius},${y} A1,1 0 0,0 ${x + radius},${y} A1,1 0 0,0 ${x - radius},${y} z`;
        this.stroke();
    }

    public override stroke(): void {
        if (!(this as any)._currentPathIsEmpty) {
            let s = `<path d="${(this as any)._currentPath}" stroke="${this.color.rgba}"`;
            // Under root transform-scale we DROP *scale from stroke-width.
            if (this.lineWidth !== 1) {
                s += ` stroke-width="${this.lineWidth}"`;
            }
            s += ' style="fill: none" />';
            (this as any).buffer += s;
        }
        (this as any)._currentPath = '';
        (this as any)._currentPathIsEmpty = true;
    }

    public override fillText(text: string, x: number, y: number): void {
        if (text === '') return;
        // Font.toCssString called with scale=1 (the root transform applies scale).
        let s =
            '<text x="' + x + '" y="' + y +
            '" style=\'stroke: none; font:' + this.font.toCssString(1) + '; ' +
            this.getSvgBaseLine() + "'";
        if (this.color.rgba !== '#000000') {
            s += ` fill="${this.color.rgba}"`;
        }
        if (this.textAlign !== TextAlign.Left) {
            s += ` text-anchor="${this.getSvgTextAlignment(this.textAlign)}"`;
        }
        s += `>${escapeXml(text)}</text>`;
        (this as any).buffer += s;
    }

    public override beginRotate(centerX: number, centerY: number, angle: number): void {
        // No *scale on the translate — the root transform handles it.
        (this as any).buffer += `<g transform="translate(${centerX} ,${centerY}) rotate( ${angle})">`;
    }

    public override fillMusicFontSymbol(
        x: number, y: number, relativeScale: number, symbol: MusicFontSymbol, centerAtPosition?: boolean
    ): void {
        if ((symbol as number) === 0) return;
        this._fillMusicFontSymbolText(x, y, relativeScale, `&#${symbol};`, centerAtPosition);
    }

    public override fillMusicFontSymbols(
        x: number, y: number, relativeScale: number, symbols: MusicFontSymbol[], centerAtPosition?: boolean
    ): void {
        let s = '';
        for (const symbol of symbols) {
            if ((symbol as number) !== 0) {
                s += `&#${symbol};`;
            }
        }
        this._fillMusicFontSymbolText(x, y, relativeScale, s, centerAtPosition);
    }

    private _fillMusicFontSymbolText(
        x: number, y: number, relativeScale: number, symbols: string, centerAtPosition?: boolean
    ): void {
        // No this.scale multiply — root viewBox handles it. relativeScale stays.
        (this as any).buffer += '<g transform="translate(' + x + ' ' + y + ')" class="at" ><text';
        if (relativeScale !== 1) {
            (this as any).buffer += ` style="font-size: ${relativeScale * 100}%; stroke:none"`;
        } else {
            (this as any).buffer += ' style="stroke:none"';
        }
        if (this.color.rgba !== '#000000') {
            (this as any).buffer += ' fill="' + this.color.rgba + '"';
        }
        if (centerAtPosition) {
            (this as any).buffer += ' text-anchor="middle"';
        }
        (this as any).buffer += '>' + symbols + '</text></g>';
    }
}

function escapeXml(text: string): string {
    if (!/[&<>"']/.test(text)) return text;
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Render one fixture at a given scale, return concatenated SVG output.
// ---------------------------------------------------------------------------
function renderFixture(scoreBytes: Uint8Array, scale: number, useDr3b: boolean): string {
    const settings = new Settings();
    settings.core.engine = useDr3b ? 'dr3b' : 'svg';
    settings.core.enableLazyLoading = false;
    settings.display.scale = scale;
    Environment.highDpiFactor = 1;

    // Register a custom 'dr3b' engine if using patched canvas.
    if (useDr3b && !Environment.renderEngines.has('dr3b')) {
        Environment.renderEngines.set('dr3b', {
            createCanvas: () => new Dr3bCssFontSvgCanvas(),
            supportsWorkers: false
        } as any);
    }

    const score = ScoreLoader.loadScoreFromBytes(scoreBytes, settings);
    const renderer = new ScoreRenderer(settings);
    renderer.width = 970;

    const fragments: string[] = [];
    renderer.partialRenderFinished.on((e: RenderFinishedEventArgs) => {
        const r = e.renderResult;
        if (typeof r === 'string') {
            fragments.push(r);
        }
    });
    renderer.renderFinished.on((e: RenderFinishedEventArgs) => {
        const r = e.renderResult;
        if (typeof r === 'string') {
            fragments.push(r);
        }
    });

    renderer.renderScore(score, [0]);
    return fragments.join('\n');
}

// ---------------------------------------------------------------------------
// Drive Phase 0b — three scales × two canvas variants.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
    const fixtureArg = process.argv.find(a => a.startsWith('--fixture='));
    const fixtureRel = fixtureArg
        ? fixtureArg.slice('--fixture='.length)
        : 'packages/alphatab/test-data/visual-tests/general/song-details.gp';
    const fixturePath = path.join(REPO_ROOT, fixtureRel);
    const fixtureName = path.basename(fixtureRel);
    console.log(`Fixture: ${fixtureRel}`);
    const scoreBytes = new Uint8Array(fs.readFileSync(fixturePath));

    const scales = [1.0, 1.5, 2.0];
    const results: Record<string, string> = {};
    for (const sc of scales) {
        const baseline = renderFixture(scoreBytes, sc, false);
        const patched = renderFixture(scoreBytes, sc, true);
        const baselineFile = path.join(OUT_DIR, `${fixtureName}-baseline-scale-${sc}.svg`);
        const patchedFile = path.join(OUT_DIR, `${fixtureName}-patched-scale-${sc}.svg`);
        fs.writeFileSync(baselineFile, baseline);
        fs.writeFileSync(patchedFile, patched);
        results[`baseline-${sc}`] = baseline;
        results[`patched-${sc}`] = patched;
        console.log(`scale=${sc}  baseline ${baseline.length}b  patched ${patched.length}b`);
    }

    // -- Equivalence analysis ----------------------------------------------
    console.log('\n=== Equivalence analysis ===\n');

    // 1. At scale=1, baseline and patched should differ ONLY by the
    //    presence of `viewBox="..."` in the patched form's <svg> root.
    {
        const a = results['baseline-1'];
        const b = results['patched-1'];
        // Strip viewBox AND the dr3b vs svg fragment header difference.
        const aStripped = a.replace(/ viewBox="[^"]*"/g, '');
        const bStripped = b.replace(/ viewBox="[^"]*"/g, '');
        if (aStripped === bStripped) {
            console.log('scale=1.0: PASS — baseline and patched are byte-identical modulo viewBox.');
        } else {
            // Find first divergence.
            let i = 0;
            while (i < aStripped.length && i < bStripped.length && aStripped[i] === bStripped[i]) i++;
            const ctxA = aStripped.slice(Math.max(0, i - 50), i + 80);
            const ctxB = bStripped.slice(Math.max(0, i - 50), i + 80);
            console.log(`scale=1.0: DIVERGE at byte ${i}`);
            console.log(`  baseline: …${JSON.stringify(ctxA)}…`);
            console.log(`  patched:  …${JSON.stringify(ctxB)}…`);
        }
    }

    // 2. At scale=1.5 and 2.0: extract <rect x=…> coords from both;
    //    baseline.x should equal patched.x * scale (within FP tolerance).
    for (const sc of [1.5, 2.0]) {
        const a = results[`baseline-${sc}`];
        const b = results[`patched-${sc}`];

        // Pluck rect coordinates: x, y, width, height.
        const rectRe = /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g;
        const aRects = [...a.matchAll(rectRe)];
        const bRects = [...b.matchAll(rectRe)];
        if (aRects.length !== bRects.length) {
            console.log(`scale=${sc}: rect count mismatch baseline=${aRects.length} patched=${bRects.length}`);
            continue;
        }
        let okRects = 0, badRects = 0;
        const sample: string[] = [];
        for (let i = 0; i < aRects.length; i++) {
            const a4 = aRects[i].slice(1, 5).map(Number);
            const b4 = bRects[i].slice(1, 5).map(Number);
            const ok = a4.every((av, j) => Math.abs(av - b4[j] * sc) < 1e-6);
            if (ok) okRects++; else {
                badRects++;
                if (sample.length < 5) {
                    sample.push(`  rect[${i}] baseline=${JSON.stringify(a4)} patched=${JSON.stringify(b4)} patched*scale=${JSON.stringify(b4.map(v=>v*sc))}`);
                }
            }
        }
        console.log(`scale=${sc}: rects: ${okRects}/${aRects.length} satisfy baseline=patched*scale`);
        if (sample.length > 0) {
            for (const s of sample) console.log(s);
        }

        // Pluck path d coordinates (M / L / C / Q tokens) — sample a few.
        const pathRe = /<path d="([^"]+)"/g;
        const aPaths = [...a.matchAll(pathRe)];
        const bPaths = [...b.matchAll(pathRe)];
        if (aPaths.length !== bPaths.length) {
            console.log(`scale=${sc}: path count mismatch baseline=${aPaths.length} patched=${bPaths.length}`);
            continue;
        }
        // Extract all numeric coords from a path d, check arithmetic.
        let okPaths = 0;
        for (let i = 0; i < aPaths.length; i++) {
            const aNums = (aPaths[i][1].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
            const bNums = (bPaths[i][1].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
            if (aNums.length !== bNums.length) continue;
            const ok = aNums.every((av, j) => {
                const bv = bNums[j];
                if (bv === 1 || bv === 0) return av === bv; // arc-flag literals
                return Math.abs(av - bv * sc) < 1e-3;
            });
            if (ok) okPaths++;
        }
        console.log(`scale=${sc}: paths: ${okPaths}/${aPaths.length} satisfy baseline=patched*scale on numeric tokens`);

        // <text> font-size verification.
        const aFontSizes = [...a.matchAll(/font:[^;]*?(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
        const bFontSizes = [...b.matchAll(/font:[^;]*?(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
        if (aFontSizes.length === bFontSizes.length && aFontSizes.length > 0) {
            const okFonts = aFontSizes.every((av, j) => Math.abs(av - bFontSizes[j] * sc) < 1e-6);
            console.log(`scale=${sc}: font-size px (text): ${aFontSizes.length} values, baseline=patched*scale ${okFonts ? 'PASS' : 'FAIL'}`);
            if (!okFonts) {
                const idx = aFontSizes.findIndex((av, j) => Math.abs(av - bFontSizes[j] * sc) >= 1e-6);
                console.log(`  first divergence: baseline=${aFontSizes[idx]} patched=${bFontSizes[idx]} patched*scale=${bFontSizes[idx] * sc}`);
            }
        } else {
            console.log(`scale=${sc}: font-size count baseline=${aFontSizes.length} patched=${bFontSizes.length}`);
        }
    }

    console.log('\nSVG files written to:', OUT_DIR);
}

main().catch(e => { console.error(e); process.exit(1); });

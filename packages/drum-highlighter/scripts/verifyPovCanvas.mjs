import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { get } from 'node:https';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const port = 4183;
const baseUrl = `https://localhost:${port}/`;
const screenshotDirectory = join(tmpdir(), 'drum-highlighter-pov-checks');
const localChromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const server = spawn(process.execPath, ['scripts/previewHttps.mjs'], {
    cwd: packageDirectory,
    env: {
        ...process.env,
        PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
});

server.stdout.on('data', chunk => process.stdout.write(chunk));
server.stderr.on('data', chunk => process.stderr.write(chunk));

try {
    await waitForServer();
    await mkdir(screenshotDirectory, { recursive: true });

    const browser = await chromium.launch(
        existsSync(localChromePath)
            ? {
                  executablePath: localChromePath
              }
            : undefined
    );
    try {
        for (const viewport of [
            { name: 'desktop', width: 1280, height: 800 },
            { name: 'ipad-landscape', width: 1180, height: 820 },
            { name: 'ipad-portrait', width: 820, height: 1180 }
        ]) {
            const page = await browser.newPage({
                ignoreHTTPSErrors: true,
                viewport: {
                    width: viewport.width,
                    height: viewport.height
                }
            });
            await page.goto(baseUrl, { waitUntil: 'networkidle' });
            await page.getByText('POV', { exact: true }).click();
            await page.waitForSelector('.kit-3d-canvas');
            await page.waitForTimeout(250);
            const layoutResult = await page.evaluate(() => {
                const toolbar = document.querySelector('.score-toolbar');
                const viewport = document.querySelector('.score-viewport');
                if (!(toolbar instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
                    return { ok: false, reason: 'Missing toolbar or score viewport' };
                }

                const toolbarRect = toolbar.getBoundingClientRect();
                const viewportRect = viewport.getBoundingClientRect();
                if (toolbarRect.bottom > viewportRect.top + 1) {
                    return {
                        ok: false,
                        reason: `Toolbar overlaps score viewport: toolbar bottom ${toolbarRect.bottom}, viewport top ${viewportRect.top}`
                    };
                }

                const overflowingLabel = [
                    ...document.querySelectorAll(
                        '.count-in-toggle, .metronome-toggle, .auto-scroll-toggle, .loop-selection-toggle, .debug-toggle'
                    )
                ].find(label => {
                    const labelRect = label.getBoundingClientRect();
                    return labelRect.top < toolbarRect.top - 1 || labelRect.bottom > toolbarRect.bottom + 1;
                });

                if (overflowingLabel instanceof HTMLElement) {
                    return {
                        ok: false,
                        reason: `${overflowingLabel.className} overflows the toolbar`
                    };
                }

                return { ok: true, reason: '' };
            });

            const result = await page.evaluate(() => {
                const canvas = document.querySelector('.kit-3d-canvas');
                if (!(canvas instanceof HTMLCanvasElement)) {
                    return { colorfulPixels: 0, height: 0, width: 0 };
                }

                const width = canvas.width;
                const height = canvas.height;
                const sample = document.createElement('canvas');
                sample.width = width;
                sample.height = height;
                const context = sample.getContext('2d', { willReadFrequently: true });
                if (!context) {
                    return { colorfulPixels: 0, height, width };
                }

                context.drawImage(canvas, 0, 0);
                const data = context.getImageData(0, 0, width, height).data;
                let colorfulPixels = 0;
                for (let index = 0; index < data.length; index += 16) {
                    const red = data[index];
                    const green = data[index + 1];
                    const blue = data[index + 2];
                    const alpha = data[index + 3];
                    if (alpha > 20 && Math.max(red, green, blue) - Math.min(red, green, blue) > 10) {
                        colorfulPixels++;
                    }
                }

                return { colorfulPixels, height, width };
            });

            const screenshotPath = join(screenshotDirectory, `${viewport.name}.png`);
            await page.locator('.detected-kit-stage').screenshot({ path: screenshotPath });
            await page.close();

            if (!layoutResult.ok) {
                throw new Error(`${viewport.name} toolbar layout failed: ${layoutResult.reason}`);
            }

            if (result.width < 100 || result.height < 100 || result.colorfulPixels < 300) {
                throw new Error(
                    `${viewport.name} POV canvas looked blank: ${JSON.stringify(result)}. Screenshot: ${screenshotPath}`
                );
            }

            console.log(
                `${viewport.name} POV canvas OK: ${result.width}x${result.height}, ${result.colorfulPixels} sampled colorful pixels. Screenshot: ${screenshotPath}`
            );
        }
    } finally {
        await browser.close();
    }
} finally {
    server.kill();
}

async function waitForServer() {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        try {
            if (await canReachServer()) {
                return;
            }
        } catch {
            await new Promise(resolve => setTimeout(resolve, 150));
        }
    }

    throw new Error(`Timed out waiting for ${baseUrl}`);
}

function canReachServer() {
    return new Promise(resolve => {
        const request = get(baseUrl, { rejectUnauthorized: false, timeout: 500 }, response => {
            response.resume();
            resolve(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 500);
        });
        request.on('error', () => resolve(false));
        request.on('timeout', () => {
            request.destroy();
            resolve(false);
        });
    });
}

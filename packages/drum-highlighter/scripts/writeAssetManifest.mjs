import { readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
const manifestPath = fileURLToPath(new URL('../dist/asset-manifest.json', import.meta.url));
const ignoredFiles = new Set(['asset-manifest.json']);

const files = await collectFiles(distDirectory);
const urls = files
    .map(file => `/${relative(distDirectory, file).split(sep).join('/')}`)
    .filter(url => !ignoredFiles.has(url.slice(1)))
    .sort();

await writeFile(manifestPath, `${JSON.stringify({ urls }, null, 2)}\n`, 'utf8');

async function collectFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await collectFiles(entryPath)));
        } else {
            files.push(entryPath);
        }
    }

    return files;
}

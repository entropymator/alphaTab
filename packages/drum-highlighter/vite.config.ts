import { alphaTab } from '@coderline/alphatab-vite';
import { defineConfig } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig({
    plugins: [alphaTab()],
    server: {
        open: true,
        https: getHttpsOptions()
    },
    preview: {
        https: getHttpsOptions()
    }
});

function getHttpsOptions(): { cert: Buffer; key: Buffer } | undefined {
    if (process.env.DRUM_HIGHLIGHTER_HTTPS !== 'true') {
        return undefined;
    }

    const certPath = process.env.DRUM_HIGHLIGHTER_HTTPS_CERT ?? resolve('certs/local-cert.pem');
    const keyPath = process.env.DRUM_HIGHLIGHTER_HTTPS_KEY ?? resolve('certs/local-key.pem');

    if (!existsSync(certPath) || !existsSync(keyPath)) {
        throw new Error(
            `HTTPS requested but certificate files were not found. Expected cert at "${certPath}" and key at "${keyPath}".`
        );
    }

    const cert = readFileSync(certPath);
    const key = readFileSync(keyPath);

    if (cert.includes('BEGIN PRIVATE KEY') && key.includes('BEGIN CERTIFICATE')) {
        return {
            cert: key,
            key: cert
        };
    }

    return { cert, key };
}

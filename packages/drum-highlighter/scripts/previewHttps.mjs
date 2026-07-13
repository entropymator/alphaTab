import { createServer } from 'node:https';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const distDirectory = resolve(packageDirectory, 'dist');
const port = Number(process.env.PORT ?? 4173);

const certPath = process.env.DRUM_HIGHLIGHTER_HTTPS_CERT ?? resolve(packageDirectory, 'certs/local-cert.pem');
const keyPath = process.env.DRUM_HIGHLIGHTER_HTTPS_KEY ?? resolve(packageDirectory, 'certs/local-key.pem');

if (!existsSync(distDirectory)) {
    throw new Error('dist was not found. Run "npm run build --workspace=packages/drum-highlighter" first.');
}

if (!existsSync(certPath) || !existsSync(keyPath)) {
    throw new Error(`HTTPS certificate files were not found. Expected cert at "${certPath}" and key at "${keyPath}".`);
}

const cert = readFileSync(certPath);
const key = readFileSync(keyPath);
const server = createServer(
    cert.includes('BEGIN PRIVATE KEY') && key.includes('BEGIN CERTIFICATE') ? { cert: key, key: cert } : { cert, key },
    (request, response) => {
        const requestUrl = new URL(request.url ?? '/', `https://${request.headers.host ?? `localhost:${port}`}`);
        const filePath = resolveRequestedFile(requestUrl.pathname);

        console.log(`${new Date().toLocaleTimeString()} ${request.method} ${requestUrl.pathname}`);

        if (!filePath) {
            response.writeHead(404);
            response.end('Not found');
            return;
        }

        response.writeHead(200, getHeaders(filePath));
        createReadStream(filePath).pipe(response);
    }
);

server.listen(port, '0.0.0.0', () => {
    console.log('Drum Highlighter HTTPS preview');
    for (const url of getPreviewUrls()) {
        console.log(`  ${url}`);
    }
});

function resolveRequestedFile(pathname) {
    const decodedPath = decodeURIComponent(pathname);
    const cleanPath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, '');
    const requestedPath = resolve(distDirectory, `.${sep}${cleanPath}`);
    const relativePath = requestedPath.slice(distDirectory.length);

    if (!requestedPath.startsWith(distDirectory) || relativePath.startsWith(`..${sep}`)) {
        return null;
    }

    if (existsSync(requestedPath) && statSync(requestedPath).isFile()) {
        return requestedPath;
    }

    if (decodedPath === '/' || !extname(decodedPath)) {
        return join(distDirectory, 'index.html');
    }

    return null;
}

function getHeaders(filePath) {
    const headers = {
        'Cache-Control': filePath.endsWith('service-worker.js') ? 'no-cache' : 'public, max-age=31536000',
        'Content-Type': getContentType(filePath)
    };

    if (filePath.endsWith('.js')) {
        headers['Service-Worker-Allowed'] = '/';
    }

    return headers;
}

function getContentType(filePath) {
    switch (extname(filePath)) {
        case '.css':
            return 'text/css; charset=utf-8';
        case '.html':
            return 'text/html; charset=utf-8';
        case '.js':
        case '.mjs':
            return 'text/javascript; charset=utf-8';
        case '.json':
        case '.webmanifest':
            return 'application/manifest+json; charset=utf-8';
        case '.png':
            return 'image/png';
        case '.svg':
            return 'image/svg+xml';
        case '.sf2':
        case '.sf3':
            return 'application/octet-stream';
        case '.woff':
            return 'font/woff';
        case '.woff2':
            return 'font/woff2';
        case '.otf':
            return 'font/otf';
        default:
            return 'application/octet-stream';
    }
}

function getPreviewUrls() {
    const urls = [`https://localhost:${port}/`];
    for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family === 'IPv4' && !address.internal) {
                urls.push(`https://${address.address}:${port}/`);
            }
        }
    }
    return urls;
}

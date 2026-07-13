const CACHE_NAME = 'drum-highlighter-shell-v6';
const APP_SHELL_URLS = [
    '/',
    '/asset-manifest.json',
    '/manifest.webmanifest',
    '/icon.svg',
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png',
    '/icon-192.png',
    '/icon-512.png',
    '/font/Bravura.woff2',
    '/font/Bravura.woff',
    '/font/Bravura.otf',
    '/font/bravura_metadata.json',
    '/soundfont/sonivox.sf2',
    '/soundfont/sonivox.sf3'
];

self.addEventListener('install', event => {
    event.waitUntil(precacheAppShell());
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames
                    .filter(cacheName => cacheName !== CACHE_NAME)
                    .map(cacheName => caches.delete(cacheName))
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') {
        return;
    }

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) {
        return;
    }

    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request, '/'));
        return;
    }

    event.respondWith(cacheFirst(request));
});

async function precacheAppShell() {
    const cache = await caches.open(CACHE_NAME);
    const pendingUrls = [...APP_SHELL_URLS];
    const visitedUrls = new Set();

    for (const manifestUrl of await readBuildManifestUrls(cache)) {
        pendingUrls.push(manifestUrl);
    }

    while (pendingUrls.length > 0 && visitedUrls.size < 120) {
        const url = pendingUrls.shift();
        if (!url || visitedUrls.has(url)) {
            continue;
        }

        visitedUrls.add(url);

        try {
            const response = await fetch(url, { cache: 'reload' });
            if (!response.ok) {
                console.warn(`[drum-highlighter] could not precache ${url}: ${response.status}`);
                continue;
            }

            await cache.put(url, response.clone());

        } catch (error) {
            console.warn(`[drum-highlighter] could not precache ${url}`, error);
        }
    }
}

async function readBuildManifestUrls(cache) {
    try {
        const response = await fetch('/asset-manifest.json', { cache: 'reload' });
        if (!response.ok) {
            return [];
        }

        await cache.put('/asset-manifest.json', response.clone());
        const manifest = await response.json();
        return Array.isArray(manifest.urls) ? manifest.urls.filter(url => typeof url === 'string') : [];
    } catch (error) {
        console.warn('[drum-highlighter] could not read build asset manifest', error);
        return [];
    }
}

async function cacheFirst(request) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
        return cachedResponse;
    }

    const response = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
    return response;
}

async function networkFirst(request, fallbackUrl) {
    try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
        return response;
    } catch {
        const cachedResponse = await caches.match(request);
        return cachedResponse ?? caches.match(fallbackUrl);
    }
}

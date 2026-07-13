const CACHE_NAME = 'drum-highlighter-shell-v6';

export interface PwaStatus {
    cacheName: string;
    cachedUrls: string[];
    controlled: boolean;
    displayMode: 'browser' | 'standalone';
    online: boolean;
    serviceWorker: string;
}

export function registerServiceWorker(onStatus?: (status: PwaStatus) => void): void {
    if (!('serviceWorker' in navigator) || import.meta.env.DEV) {
        onStatus?.({
            cacheName: CACHE_NAME,
            cachedUrls: [],
            controlled: false,
            displayMode: getDisplayMode(),
            online: navigator.onLine,
            serviceWorker: import.meta.env.DEV ? 'disabled in dev server' : 'not supported'
        });
        return;
    }

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        readPwaStatus().then(status => onStatus?.(status));
    });

    registerAndCache(onStatus);
}

async function cacheCurrentAppShell(): Promise<void> {
    if (!('caches' in window)) {
        return;
    }

    const urls = new Set<string>([
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
    ]);

    for (const element of document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
        'script[src], link[rel="stylesheet"][href]'
    )) {
        const source = element instanceof HTMLScriptElement ? element.src : element.href;
        if (source.startsWith(window.location.origin)) {
            urls.add(new URL(source).pathname);
        }
    }

    for (const url of await readBuildAssetManifestUrls()) {
        urls.add(url);
    }

    const cache = await caches.open(CACHE_NAME);
    await Promise.all(
        [...urls].map(async url => {
            try {
                await cache.add(url);
            } catch (error) {
                console.warn(`[drum-highlighter] could not cache ${url}`, error);
            }
        })
    );
}

async function readBuildAssetManifestUrls(): Promise<string[]> {
    try {
        const response = await fetch('/asset-manifest.json', { cache: 'reload' });
        if (!response.ok) {
            return [];
        }

        const manifest = (await response.json()) as { urls?: unknown };
        return Array.isArray(manifest.urls) ? manifest.urls.filter((url): url is string => typeof url === 'string') : [];
    } catch (error) {
        console.warn('[drum-highlighter] could not read build asset manifest', error);
        return [];
    }
}

async function registerAndCache(onStatus?: (status: PwaStatus) => void): Promise<void> {
    try {
        await navigator.serviceWorker.register('/service-worker.js');
        await navigator.serviceWorker.ready;
        await cacheCurrentAppShell();
        onStatus?.(await readPwaStatus());
    } catch (error) {
        console.warn('[drum-highlighter] service worker registration failed', error);
        onStatus?.({
                    cacheName: CACHE_NAME,
                    cachedUrls: [],
                    controlled: Boolean(navigator.serviceWorker.controller),
                    displayMode: getDisplayMode(),
                    online: navigator.onLine,
                    serviceWorker: `registration failed: ${String(error)}`
                });
    }
}

async function readPwaStatus(): Promise<PwaStatus> {
    const cachedUrls = await readCachedUrls();
    const registration = await navigator.serviceWorker.getRegistration();

    return {
        cacheName: CACHE_NAME,
        cachedUrls,
        controlled: Boolean(navigator.serviceWorker.controller),
        displayMode: getDisplayMode(),
        online: navigator.onLine,
        serviceWorker: registration?.active?.state ?? registration?.installing?.state ?? registration?.waiting?.state ?? 'none'
    };
}

async function readCachedUrls(): Promise<string[]> {
    if (!('caches' in window)) {
        return [];
    }

    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    return keys.map(request => new URL(request.url).pathname).sort();
}

function getDisplayMode(): 'browser' | 'standalone' {
    const iosNavigator = navigator as Navigator & { standalone?: boolean };
    return window.matchMedia('(display-mode: standalone)').matches || iosNavigator.standalone === true
        ? 'standalone'
        : 'browser';
}

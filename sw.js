// sw.js
importScripts('https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.32/dist/zip.min.js');

let zipReader = null;
let keepAlivePort = null;
let keepAliveInterval = null;

const KEEPALIVE_INTERVAL = 15000;

self.addEventListener('install', event => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

function startKeepAlive(port) {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    keepAlivePort = port;

    keepAliveInterval = setInterval(() => {
        if (keepAlivePort) {
            try {
                keepAlivePort.postMessage({ type: 'KEEPALIVE_PING' });
            } catch (e) {
                stopKeepAlive();
            }
        }
    }, KEEPALIVE_INTERVAL);
}

function stopKeepAlive() {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    keepAlivePort = null;
}

self.addEventListener('message', async event => {
    const { type, zipArray } = event.data || {};

    if (type === 'INIT_VAULT' && zipArray) {
        try {
            const blob = new Blob([zipArray]);
            zipReader = new zip.ZipReader(new zip.BlobReader(blob), { useWebWorkers: true });

            if (event.ports && event.ports[0]) {
                startKeepAlive(event.ports[0]);
                event.ports[0].postMessage({ type: 'VAULT_READY' });
            }
            console.log('[SW] Vault loaded');
        } catch (err) {
            console.error('[SW] Init failed', err);
        }
    }

    if (type === 'CONNECT' && event.ports && event.ports[0]) {
        // Port already handled in INIT_VAULT, but keep for compatibility
    }

    if (type === 'CLOSE_VAULT') {
        stopKeepAlive();
        if (zipReader) {
            await zipReader.close().catch(() => {});
            zipReader = null;
        }
    }
});

self.addEventListener('fetch', async event => {
    const url = new URL(event.request.url);
    let path = url.pathname;

    if (path === '/' || path === '') path = '/index.html';
    if (path.startsWith('/')) path = path.slice(1);

    // Bypass for vault files themselves
    if (!zipReader || path === 'sw.js' || path === 'decrypt.js' || path === 'setup.ini' || path === 'project_data.zip') {
        return; // fall through
    }

    event.respondWith((async () => {
        try {
            const entries = await zipReader.getEntries();
            const entry = entries.find(e => e.filename === path);

            if (!entry) throw new Error('Not found');

            const data = await entry.getData(new zip.BlobWriter());
            const mime = getMimeType(path);

            return new Response(data, {
                status: 200,
                headers: {
                    'Content-Type': mime,
                    'Cache-Control': 'no-store, no-cache'
                }
            });
        } catch (err) {
            return fetch(event.request); // fallback
        }
    })());
});

function getMimeType(path) {
    const ext = path.split('.').pop().toLowerCase();
    const map = {
        html: 'text/html;charset=utf-8',
        css: 'text/css',
        js: 'application/javascript',
        json: 'application/json',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        webp: 'image/webp',
        ico: 'image/x-icon'
    };
    return map[ext] || 'application/octet-stream';
}
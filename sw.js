const CACHE_NAME = 'cee-pwa-v1';
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/config.js',

    // src
    '/src/supabase-client.js',
    '/src/utils.js',
    '/src/auth.js',
    'src/combobox.js',
    '/src/ui.js',

    // src/tabs
    'src/tabs/account.js',
    'src/tabs/bug-reports.js',
    'src/tabs/cep-search.js',
    'src/tabs/contact.js',
    'src/tabs/daily-ops.js',
    'src/tabs/employees.js',
    'src/tabs/helpdesk.js',
    'src/tabs/loec-analysis.js',
    'src/tabs/loec-scans.js',
    'src/tabs/malote-scans.js',
    'src/tabs/metrics.js',
    'src/tabs/rules.js',
    'src/tabs/streets.js',
    'src/tabs/zips.js',
    'src/tabs/geocoding.js',

    '/res/fav.svg',
    'res/icon-192.png',
    'res/icon-512.png'
];


self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

// Ativação: Limpa caches antigos se você atualizar a versão (CACHE_NAME)
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((name) => {
                    if (name !== CACHE_NAME) {
                        return caches.delete(name);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Interceptação de Rede (Estratégia: Network First com fallback para Cache)
self.addEventListener('fetch', (event) => {
    // Ignora as requisições de API do Supabase (não queremos cachear os dados dinâmicos do banco)
    if (event.request.url.includes('/rest/v1/') || event.request.url.includes('/auth/v1/')) {
        return;
    }

    // Tenta buscar da rede primeiro (para ter o código mais atualizado)
    // Se falhar (offline), busca no cache
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});
const CACHE_NAME = 'focus-timer-cache-v6';
const urlsToCache = [
  './index.html',
  './manifest.json'
];

// Install Service Worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
  );
  self.skipWaiting();
});

// Activate Service Worker
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch events
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true })
      .then(response => {
        // Return cached response if found
        if (response) {
          return response;
        }
        // Else fetch from network
        return fetch(event.request).then(
          function(response) {
            // Check if we received a valid response
            if(!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }

            // Clone the response
            var responseToCache = response.clone();

            caches.open(CACHE_NAME)
              .then(function(cache) {
                // Cache basic requests for offline use
                if(event.request.url.startsWith(self.location.origin)){
                   cache.put(event.request, responseToCache);
                }
              });

            return response;
          }
        ).catch(function() {
          // Fallback to index.html if offline and requesting a web page
          if (event.request.mode === 'navigate' || (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html'))) {
            return caches.match('./index.html').then(function(cacheResp) {
              return cacheResp || Response.error();
            });
          }
          return Response.error();
        });
      })
  );
});

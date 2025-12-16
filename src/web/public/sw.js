/**
 * Prestige Service Worker
 * Handles caching, offline support, and background sync
 */

const CACHE_NAME = 'prestige-v1';
const OFFLINE_URL = '/offline.html';

// Assets to cache immediately on install
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/ballot.html',
  '/results.html',
  '/offline.html',
  '/styles.css',
  '/js/api.js',
  '/js/identity.js',
  '/js/crypto.js',
  '/js/gates.js',
  '/js/vote.js',
  '/js/offline-queue.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// API routes that should use network-first strategy
const API_ROUTES = [
  '/api/ballot',
  '/api/ballots',
  '/api/votes',
  '/api/reveals',
  '/api/results',
  '/api/gates',
  '/api/token',
  '/health',
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker...');

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Precaching static assets');
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => {
        console.log('[SW] Skip waiting');
        return self.skipWaiting();
      })
      .catch((error) => {
        console.error('[SW] Precache failed:', error);
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker...');

  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        console.log('[SW] Claiming clients');
        return self.clients.claim();
      })
  );
});

// Fetch event - handle requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip cross-origin requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // Handle API requests with network-first strategy
  if (isApiRequest(url.pathname)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Handle navigation requests
  if (event.request.mode === 'navigate') {
    event.respondWith(navigationHandler(event.request));
    return;
  }

  // Handle static assets with cache-first strategy
  event.respondWith(cacheFirst(event.request));
});

// Background sync for offline votes and reveals
self.addEventListener('sync', (event) => {
  console.log('[SW] Sync event:', event.tag);

  if (event.tag === 'sync-votes') {
    event.waitUntil(syncVotes());
  } else if (event.tag === 'sync-reveals') {
    event.waitUntil(syncReveals());
  }
});

// Notification click handler (handles clicks on local notifications)
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event.notification.tag);

  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Check if there's already a window open
        for (const client of clientList) {
          if (client.url.includes(urlToOpen) && 'focus' in client) {
            return client.focus();
          }
        }
        // Open new window if none found
        if (self.clients.openWindow) {
          return self.clients.openWindow(urlToOpen);
        }
      })
  );
});

// ============= Caching Strategies =============

/**
 * Cache-first strategy - for static assets
 */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);

    // Cache successful responses
    if (response.ok) {
      cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    console.error('[SW] Cache-first fetch failed:', error);

    // Return offline page for navigation requests
    if (request.mode === 'navigate') {
      return cache.match(OFFLINE_URL);
    }

    throw error;
  }
}

/**
 * Network-first strategy - for API requests
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);

    // Cache GET requests
    if (response.ok && request.method === 'GET') {
      cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    console.log('[SW] Network-first falling back to cache:', request.url);

    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }

    // Return offline JSON response for API
    return new Response(
      JSON.stringify({
        error: 'You are offline',
        code: 'OFFLINE',
        offline: true
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

/**
 * Navigation handler - with offline fallback
 */
async function navigationHandler(request) {
  try {
    // Try network first for navigation
    const response = await fetch(request);

    // Cache successful navigation responses
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    console.log('[SW] Navigation offline, checking cache');

    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);

    if (cached) {
      return cached;
    }

    // Return offline page
    return cache.match(OFFLINE_URL);
  }
}

// ============= Helper Functions =============

/**
 * Check if a path is an API request
 */
function isApiRequest(pathname) {
  return API_ROUTES.some(route => pathname.startsWith(route));
}

// ============= Background Sync Functions =============

/**
 * Sync pending votes when back online
 */
async function syncVotes() {
  console.log('[SW] Syncing pending votes...');

  try {
    const db = await openOfflineDB();
    const pendingVotes = await getAllPending(db, 'votes');

    for (const vote of pendingVotes) {
      try {
        const response = await fetch('/api/vote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(vote.data),
        });

        if (response.ok) {
          await removePending(db, 'votes', vote.id);
          console.log('[SW] Vote synced:', vote.id);

          // Notify the client
          notifyClients('vote-synced', { ballotId: vote.data.ballotId });
        }
      } catch (e) {
        console.error('[SW] Failed to sync vote:', vote.id, e);
      }
    }
  } catch (error) {
    console.error('[SW] Sync votes failed:', error);
  }
}

/**
 * Sync pending reveals when back online
 */
async function syncReveals() {
  console.log('[SW] Syncing pending reveals...');

  try {
    const db = await openOfflineDB();
    const pendingReveals = await getAllPending(db, 'reveals');

    for (const reveal of pendingReveals) {
      try {
        const response = await fetch('/api/reveal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reveal.data),
        });

        if (response.ok) {
          await removePending(db, 'reveals', reveal.id);
          console.log('[SW] Reveal synced:', reveal.id);

          // Notify the client
          notifyClients('reveal-synced', { ballotId: reveal.data.ballotId });
        }
      } catch (e) {
        console.error('[SW] Failed to sync reveal:', reveal.id, e);
      }
    }
  } catch (error) {
    console.error('[SW] Sync reveals failed:', error);
  }
}

/**
 * Notify all clients of an event
 */
async function notifyClients(type, data) {
  const clients = await self.clients.matchAll({ type: 'window' });

  for (const client of clients) {
    client.postMessage({ type, data });
  }
}

// ============= IndexedDB for Offline Queue =============

const OFFLINE_DB_NAME = 'prestige-offline';
const OFFLINE_DB_VERSION = 1;

function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('votes')) {
        db.createObjectStore('votes', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('reveals')) {
        db.createObjectStore('reveals', { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

function getAllPending(db, storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.getAll();

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function removePending(db, storeName, id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.delete(id);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

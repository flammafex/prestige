/**
 * Offline Queue for Prestige
 * Handles queueing votes and reveals when offline
 * Uses Background Sync API when available
 */

const OFFLINE_DB_NAME = 'prestige-offline';
const OFFLINE_DB_VERSION = 1;

let offlineDB = null;

/**
 * Initialize the offline queue database
 */
async function initOfflineQueue() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      offlineDB = request.result;
      resolve(offlineDB);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Store for pending votes
      if (!db.objectStoreNames.contains('votes')) {
        const voteStore = db.createObjectStore('votes', { keyPath: 'id', autoIncrement: true });
        voteStore.createIndex('ballotId', 'data.ballotId', { unique: false });
        voteStore.createIndex('timestamp', 'timestamp', { unique: false });
      }

      // Store for pending reveals
      if (!db.objectStoreNames.contains('reveals')) {
        const revealStore = db.createObjectStore('reveals', { keyPath: 'id', autoIncrement: true });
        revealStore.createIndex('ballotId', 'data.ballotId', { unique: false });
        revealStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
}

/**
 * Ensure database is open
 */
async function ensureDB() {
  if (!offlineDB) {
    await initOfflineQueue();
  }
  return offlineDB;
}

/**
 * Queue a vote for sync
 */
async function queueVote(voteData) {
  const db = await ensureDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction('votes', 'readwrite');
    const store = transaction.objectStore('votes');

    const record = {
      data: voteData,
      timestamp: Date.now(),
      status: 'pending',
    };

    const request = store.add(record);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      console.log('[OfflineQueue] Vote queued:', request.result);
      triggerSync('sync-votes');
      resolve(request.result);
    };
  });
}

/**
 * Queue a reveal for sync
 */
async function queueReveal(revealData) {
  const db = await ensureDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction('reveals', 'readwrite');
    const store = transaction.objectStore('reveals');

    const record = {
      data: revealData,
      timestamp: Date.now(),
      status: 'pending',
    };

    const request = store.add(record);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      console.log('[OfflineQueue] Reveal queued:', request.result);
      triggerSync('sync-reveals');
      resolve(request.result);
    };
  });
}

/**
 * Get all pending votes
 */
async function getPendingVotes() {
  const db = await ensureDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction('votes', 'readonly');
    const store = transaction.objectStore('votes');
    const request = store.getAll();

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Get all pending reveals
 */
async function getPendingReveals() {
  const db = await ensureDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction('reveals', 'readonly');
    const store = transaction.objectStore('reveals');
    const request = store.getAll();

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Get pending actions for a specific ballot
 */
async function getPendingForBallot(ballotId) {
  const db = await ensureDB();

  const getFromStore = (storeName) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index('ballotId');
      const request = index.getAll(ballotId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  };

  const [votes, reveals] = await Promise.all([
    getFromStore('votes'),
    getFromStore('reveals'),
  ]);

  return { votes, reveals };
}

/**
 * Remove a pending vote
 */
async function removePendingVote(id) {
  const db = await ensureDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction('votes', 'readwrite');
    const store = transaction.objectStore('votes');
    const request = store.delete(id);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

/**
 * Remove a pending reveal
 */
async function removePendingReveal(id) {
  const db = await ensureDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction('reveals', 'readwrite');
    const store = transaction.objectStore('reveals');
    const request = store.delete(id);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

/**
 * Clear all pending actions
 */
async function clearPendingActions() {
  const db = await ensureDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['votes', 'reveals'], 'readwrite');

    transaction.objectStore('votes').clear();
    transaction.objectStore('reveals').clear();

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * Trigger background sync
 */
async function triggerSync(tag) {
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const registration = await navigator.serviceWorker.ready;
      if (registration.sync) {
        await registration.sync.register(tag);
        console.log('[OfflineQueue] Background sync registered:', tag);
        return;
      }
    } catch (e) {
      console.log('[OfflineQueue] Background sync not available, will retry manually');
    }
  }
  // Fallback for browsers without Background Sync
  manualSync(tag);
}

/**
 * Manual sync fallback
 */
async function manualSync(tag) {
  if (!navigator.onLine) {
    console.log('[OfflineQueue] Still offline, skipping manual sync');
    return;
  }

  if (tag === 'sync-votes') {
    await syncVotesManually();
  } else if (tag === 'sync-reveals') {
    await syncRevealsManually();
  }
}

/**
 * Manually sync pending votes
 */
async function syncVotesManually() {
  const pendingVotes = await getPendingVotes();

  for (const vote of pendingVotes) {
    try {
      const response = await fetch('/api/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vote.data),
      });

      if (response.ok) {
        await removePendingVote(vote.id);
        console.log('[OfflineQueue] Vote synced:', vote.id);

        // Dispatch event for UI update
        window.dispatchEvent(new CustomEvent('prestige:vote-synced', {
          detail: { ballotId: vote.data.ballotId }
        }));
      }
    } catch (e) {
      console.error('[OfflineQueue] Failed to sync vote:', vote.id, e);
    }
  }
}

/**
 * Manually sync pending reveals
 */
async function syncRevealsManually() {
  const pendingReveals = await getPendingReveals();

  for (const reveal of pendingReveals) {
    try {
      const response = await fetch('/api/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reveal.data),
      });

      if (response.ok) {
        await removePendingReveal(reveal.id);
        console.log('[OfflineQueue] Reveal synced:', reveal.id);

        // Dispatch event for UI update
        window.dispatchEvent(new CustomEvent('prestige:reveal-synced', {
          detail: { ballotId: reveal.data.ballotId }
        }));
      }
    } catch (e) {
      console.error('[OfflineQueue] Failed to sync reveal:', reveal.id, e);
    }
  }
}

/**
 * Check if we're online
 */
function isOnline() {
  return navigator.onLine;
}

/**
 * Get pending action count
 */
async function getPendingCount() {
  const [votes, reveals] = await Promise.all([
    getPendingVotes(),
    getPendingReveals(),
  ]);

  return {
    votes: votes.length,
    reveals: reveals.length,
    total: votes.length + reveals.length,
  };
}

// Listen for online event to trigger sync
window.addEventListener('online', () => {
  console.log('[OfflineQueue] Back online, triggering sync');
  triggerSync('sync-votes');
  triggerSync('sync-reveals');
});

// Listen for service worker messages
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const { type, data } = event.data;

    if (type === 'vote-synced') {
      window.dispatchEvent(new CustomEvent('prestige:vote-synced', { detail: data }));
    } else if (type === 'reveal-synced') {
      window.dispatchEvent(new CustomEvent('prestige:reveal-synced', { detail: data }));
    }
  });
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.offlineQueue = {
    init: initOfflineQueue,
    queueVote,
    queueReveal,
    getPendingVotes,
    getPendingReveals,
    getPendingForBallot,
    getPendingCount,
    removePendingVote,
    removePendingReveal,
    clearPendingActions,
    isOnline,
    syncVotesManually,
    syncRevealsManually,
  };
}

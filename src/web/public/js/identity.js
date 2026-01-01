/**
 * Identity management for Prestige
 * Stores keypair and voter secrets in IndexedDB
 */

const DB_NAME = 'prestige-identity';
const DB_VERSION = 1;
const STORE_NAME = 'identity';

let db = null;

/**
 * Open the IndexedDB database
 */
async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
  });
}

/**
 * Get a value from the store
 */
async function getValue(key) {
  await ensureDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(key);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Set a value in the store
 */
async function setValue(key, value) {
  await ensureDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(value, key);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

/**
 * Ensure database is open
 */
async function ensureDatabase() {
  if (!db) {
    await openDatabase();
  }
}

// ============= Identity Functions =============

/**
 * Get or create the user's identity
 */
async function getIdentity() {
  let identity = await getValue('identity');

  if (!identity) {
    // Generate new identity using Web Crypto API
    identity = await generateIdentity();
    await setValue('identity', identity);
    console.log('Generated new identity:', identity.publicKey.slice(0, 16) + '...');
  }

  return identity;
}

/**
 * Generate a new identity keypair
 */
async function generateIdentity() {
  // Use Web Crypto for Ed25519-like key generation
  // Note: In production, use @noble/curves for actual Ed25519
  const keyData = new Uint8Array(32);
  crypto.getRandomValues(keyData);

  const publicKey = await derivePublicKey(keyData);

  return {
    privateKey: bytesToHex(keyData),
    publicKey: publicKey,
    created: Date.now(),
  };
}

/**
 * Derive public key from private key (simplified)
 * In production, use proper Ed25519
 */
async function derivePublicKey(privateKey) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', privateKey);
  return bytesToHex(new Uint8Array(hashBuffer));
}

// ============= Voter Secret Functions =============

/**
 * Get or create voter secret for a ballot
 */
async function getVoterSecret(ballotId) {
  const key = `secret:${ballotId}`;
  let secret = await getValue(key);

  if (!secret) {
    secret = generateRandomHex(32);
    await setValue(key, secret);
  }

  return secret;
}

/**
 * Get vote data for a ballot (for reveal phase)
 */
async function getVoteData(ballotId) {
  const key = `vote:${ballotId}`;
  return await getValue(key);
}

/**
 * Save vote data for later reveal
 */
async function saveVoteData(ballotId, data) {
  const key = `vote:${ballotId}`;
  await setValue(key, {
    ...data,
    savedAt: Date.now(),
  });
}

/**
 * Check if we've voted on a ballot
 */
async function hasVotedLocally(ballotId) {
  const data = await getVoteData(ballotId);
  return data !== undefined;
}

/**
 * Mark vote as revealed
 */
async function markRevealed(ballotId) {
  const data = await getVoteData(ballotId);
  if (data) {
    data.revealed = true;
    data.revealedAt = Date.now();
    await saveVoteData(ballotId, data);
  }
}

// ============= Utility Functions =============

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function generateRandomHex(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Initialize identity on page load
 */
async function initIdentity() {
  try {
    const identity = await getIdentity();
    console.log('Identity loaded:', identity.publicKey.slice(0, 16) + '...');
    return identity;
  } catch (error) {
    console.error('Failed to initialize identity:', error);
    throw error;
  }
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.identity = {
    getIdentity,
    getVoterSecret,
    getVoteData,
    saveVoteData,
    hasVotedLocally,
    markRevealed,
    initIdentity,
  };
}

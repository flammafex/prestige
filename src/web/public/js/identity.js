/**
 * Identity management for Prestige
 * Stores keypair and voter secrets in IndexedDB
 */

const DB_NAME = 'prestige-identity';
const DB_VERSION = 1;
const STORE_NAME = 'identity';

let db = null;

// Local storage key recording that the user has acknowledged the
// first-run identity notice. Set when the notice is dismissed so the
// notice only ever appears once per browser.
const IDENTITY_ACK_KEY = 'prestige-identity-acknowledged';

// Set transiently during this page load when getIdentity() generates a
// brand-new identity. Reset on every initIdentity() call so it reflects
// the most recent initialization.
let createdNewIdentity = false;

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
    createdNewIdentity = true;
    console.log('Generated new identity:', identity.publicKey.slice(0, 16) + '...');
  }

  return identity;
}

/**
 * Generate a new identity keypair
 */
async function generateIdentity() {
  // Prefer native Ed25519 so signatures can be verified server-side.
  try {
    if (crypto.subtle && typeof crypto.subtle.generateKey === 'function') {
      const keyPair = await crypto.subtle.generateKey(
        { name: 'Ed25519' },
        true,
        ['sign', 'verify']
      );

      const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
      const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

      if (privateJwk.d && publicJwk.x) {
        return {
          privateKey: base64UrlToHex(privateJwk.d),
          publicKey: base64UrlToHex(publicJwk.x),
          created: Date.now(),
          scheme: 'ed25519',
        };
      }
    }
  } catch (error) {
    console.warn('Falling back to legacy identity generation:', error);
  }

  // Fallback identity format for browsers without Ed25519 support.
  const keyData = new Uint8Array(32);
  crypto.getRandomValues(keyData);
  const publicKey = await derivePublicKey(keyData);
  return {
    privateKey: bytesToHex(keyData),
    publicKey,
    created: Date.now(),
    scheme: 'legacy',
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
    data.revealQueued = false;
    data.voteQueued = false;
    data.revealedAt = Date.now();
    await saveVoteData(ballotId, data);
  }
}

/**
 * Mark vote as synced after an offline queue submission succeeds
 */
async function markVoteSynced(ballotId) {
  const data = await getVoteData(ballotId);
  if (data) {
    data.voteQueued = false;
    data.voteSyncedAt = Date.now();
    await saveVoteData(ballotId, data);
  }
}

/**
 * Mark reveal as queued while offline
 */
async function markRevealQueued(ballotId) {
  const data = await getVoteData(ballotId);
  if (data) {
    data.revealQueued = true;
    data.revealQueuedAt = Date.now();
    await saveVoteData(ballotId, data);
  }
}

/**
 * Resolve the active (post-migration) identity for a given optional identity.
 * Legacy (non-ed25519) identities are migrated to ed25519 so signatures can
 * be verified server-side. The migrated identity is persisted.
 */
async function getActiveIdentity(identityData = null) {
  let activeIdentity = identityData ?? await getIdentity();

  // Migrate legacy identities so challenge signatures can be verified server-side.
  if (activeIdentity.scheme !== 'ed25519') {
    activeIdentity = await generateIdentity();
    await setValue('identity', activeIdentity);
  }

  return activeIdentity;
}

/**
 * Resolve and return just the active (post-migration) public key.
 *
 * Use this instead of getIdentity() whenever the caller needs the public key
 * that the server will see alongside a signature: getIdentity() may return a
 * stale legacy (pre-migration) public key, which would hide create/sign UI
 * actions incorrectly. This helper triggers the same legacy→ed25519 migration
 * as getActiveIdentity()/signMessageWithKey() without signing anything.
 */
async function getActivePublicKey(identityData = null) {
  const activeIdentity = await getActiveIdentity(identityData);
  return activeIdentity.publicKey;
}

/**
 * Sign a challenge message with the local identity key
 */
async function signMessage(message, identityData = null) {
  const activeIdentity = await getActiveIdentity(identityData);
  return signWithIdentity(message, activeIdentity);
}

/**
 * Sign a challenge message and return both the signature and the active
 * (post-migration) public key. Callers that need to send the public key
 * alongside the signature MUST use this helper so the key matches the
 * signature — signMessage can migrate legacy identities, which changes
 * the active public key after signing.
 */
async function signMessageWithKey(message, identityData = null) {
  const activeIdentity = await getActiveIdentity(identityData);
  const signature = await signWithIdentity(message, activeIdentity);
  return { publicKey: activeIdentity.publicKey, signature };
}

/**
 * Internal: sign a message with a resolved ed25519 identity keypair.
 */
async function signWithIdentity(message, activeIdentity) {
  const privateJwk = {
    kty: 'OKP',
    crv: 'Ed25519',
    d: hexToBase64Url(activeIdentity.privateKey),
    x: hexToBase64Url(activeIdentity.publicKey),
    key_ops: ['sign'],
    ext: true,
  };

  const key = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'Ed25519' },
    false,
    ['sign']
  );

  const encoded = new TextEncoder().encode(message);
  const signature = await crypto.subtle.sign('Ed25519', key, encoded);
  return bytesToHex(new Uint8Array(signature));
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

function base64UrlToHex(base64Url) {
  const normalized = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytesToHex(bytes);
}

function hexToBase64Url(hex) {
  const bytes = hexToBytes(hex);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Initialize identity on page load
 */
async function initIdentity() {
  // Reset the per-load creation flag before resolving the identity so it
  // reflects whether THIS initialization created a new identity.
  createdNewIdentity = false;
  try {
    const identity = await getIdentity();
    console.log('Identity loaded:', identity.publicKey.slice(0, 16) + '...');
    return identity;
  } catch (error) {
    console.error('Failed to initialize identity:', error);
    throw error;
  }
}

/**
 * Whether the most recent initIdentity()/getIdentity() call generated a
 * brand-new identity (i.e. this is the first time this browser has run
 * Prestige). Resets at the start of each initIdentity() call.
 */
function wasNewlyCreated() {
  return createdNewIdentity;
}

/**
 * True when the first-run identity notice should be shown: a new identity
 * was created during this page load AND the user has not yet acknowledged
 * the notice. Existing users (who already had an identity) never see it.
 */
function shouldShowFirstRunNotice() {
  if (!createdNewIdentity) return false;
  try {
    return !localStorage.getItem(IDENTITY_ACK_KEY);
  } catch {
    // localStorage may be unavailable (private mode); err on showing.
    return true;
  }
}

/**
 * Mark the first-run identity notice as acknowledged so it does not
 * reappear on future page loads.
 */
function acknowledgeIdentity() {
  try {
    localStorage.setItem(IDENTITY_ACK_KEY, '1');
  } catch {
    // Ignore storage failures (private mode, quota); notice may reappear.
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
    markVoteSynced,
    markRevealQueued,
    signMessage,
    signMessageWithKey,
    getActivePublicKey,
    initIdentity,
    wasNewlyCreated,
    shouldShowFirstRunNotice,
    acknowledgeIdentity,
  };
}

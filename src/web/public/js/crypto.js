/**
 * Client-side cryptographic operations for Prestige
 * Commitment and nullifier generation
 */

const prestigeCrypto = {
  /**
   * Generate SHA-256 hash of concatenated inputs
   */
  async hash(...inputs) {
    const encoder = new TextEncoder();
    const combined = inputs.map(input => {
      if (typeof input === 'string') {
        return encoder.encode(input);
      }
      return input;
    });

    // Calculate total length
    const totalLength = combined.reduce((acc, arr) => acc + arr.length, 0);
    const result = new Uint8Array(totalLength);

    // Concatenate all inputs
    let offset = 0;
    for (const arr of combined) {
      result.set(arr, offset);
      offset += arr.length;
    }

    // Hash
    const hashBuffer = await crypto.subtle.digest('SHA-256', result);
    return this.bytesToHex(new Uint8Array(hashBuffer));
  },

  /**
   * Generate a commitment: H(choice || salt)
   */
  async generateCommitment(choice, salt) {
    return this.hash(choice, salt);
  },

  /**
   * Generate a commitment for extended vote types: H(serialized(voteData) || salt)
   */
  async generateVoteCommitment(voteData, salt) {
    const serialized = this.serializeVoteData(voteData);
    return this.hash(serialized, salt);
  },

  /**
   * Serialize vote data deterministically for commitment generation
   */
  serializeVoteData(voteData) {
    switch (voteData.type) {
      case 'single':
        return voteData.choice;
      case 'approval':
        // Sort choices for deterministic serialization
        return `approval:${[...voteData.choices].sort().join(',')}`;
      case 'ranked':
        // Order matters for rankings, don't sort
        return `ranked:${voteData.rankings.join(',')}`;
      case 'score':
        // Sort by choice name for deterministic serialization
        const sortedScores = Object.entries(voteData.scores)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([choice, score]) => `${choice}:${score}`)
          .join(',');
        return `score:${sortedScores}`;
      default:
        throw new Error(`Unknown vote type: ${voteData.type}`);
    }
  },

  /**
   * Generate a nullifier: H(voterSecret || ballotId)
   */
  async generateNullifier(voterSecret, ballotId) {
    return this.hash(voterSecret, ballotId);
  },

  /**
   * Verify a commitment matches revealed values
   */
  async verifyCommitment(commitment, choice, salt) {
    const computed = await this.generateCommitment(choice, salt);
    return this.constantTimeEqual(commitment, computed);
  },

  /**
   * Generate a random salt (32 bytes hex)
   */
  generateSalt() {
    return this.randomHex(32);
  },

  /**
   * Generate a voter secret (32 bytes hex)
   */
  generateVoterSecret() {
    return this.randomHex(32);
  },

  /**
   * Generate random hex string
   */
  randomHex(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return this.bytesToHex(bytes);
  },

  /**
   * Convert bytes to hex string
   */
  bytesToHex(bytes) {
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  },

  /**
   * Convert hex string to bytes
   */
  hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  },

  /**
   * Constant-time string comparison
   */
  constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  },

  /**
   * Validate hash format (64 hex chars)
   */
  isValidHash(hash) {
    if (typeof hash !== 'string') return false;
    if (hash.length !== 64) return false;
    return /^[0-9a-f]+$/i.test(hash);
  },

  /**
   * Sign a message using the private key
   * Uses server-side signing endpoint for Ed25519
   */
  async sign(message, privateKey) {
    const response = await fetch('/api/crypto/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, privateKey }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Signing failed');
    }

    const data = await response.json();
    return data.signature;
  },
};

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.prestigeCrypto = prestigeCrypto;
}

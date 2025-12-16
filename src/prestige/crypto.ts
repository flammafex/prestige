/**
 * Cryptographic operations for Prestige
 * Follows patterns from Scarcity's crypto.ts
 */

import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { KeyPair, PublicKey, PrivateKey, Signature, Hash, VoteData } from './types.js';

export class Crypto {
  /**
   * Generate cryptographically secure random bytes
   */
  static randomBytes(length: number): Uint8Array {
    return randomBytes(length);
  }

  /**
   * Generate a random hex string
   */
  static randomHex(length: number): string {
    return bytesToHex(this.randomBytes(length));
  }

  /**
   * SHA-256 hash with multiple input support
   */
  static hash(...inputs: (Uint8Array | string)[]): Hash {
    const combined = new Uint8Array(
      inputs.reduce((acc, input) => {
        const bytes = typeof input === 'string'
          ? new TextEncoder().encode(input)
          : input;
        return acc + bytes.length;
      }, 0)
    );

    let offset = 0;
    for (const input of inputs) {
      const bytes = typeof input === 'string'
        ? new TextEncoder().encode(input)
        : input;
      combined.set(bytes, offset);
      offset += bytes.length;
    }

    return bytesToHex(sha256(combined));
  }

  /**
   * Generate a new Ed25519 keypair
   */
  static generateKeyPair(): KeyPair {
    const privateKey = this.randomBytes(32);
    const publicKey = ed25519.getPublicKey(privateKey);
    return {
      privateKey: bytesToHex(privateKey),
      publicKey: bytesToHex(publicKey),
    };
  }

  /**
   * Sign a message with Ed25519
   */
  static sign(message: string | Uint8Array, privateKey: PrivateKey): Signature {
    const messageBytes = typeof message === 'string'
      ? new TextEncoder().encode(message)
      : message;
    const signature = ed25519.sign(messageBytes, hexToBytes(privateKey));
    return bytesToHex(signature);
  }

  /**
   * Verify an Ed25519 signature
   */
  static verify(message: string | Uint8Array, signature: Signature, publicKey: PublicKey): boolean {
    try {
      const messageBytes = typeof message === 'string'
        ? new TextEncoder().encode(message)
        : message;
      return ed25519.verify(hexToBytes(signature), messageBytes, hexToBytes(publicKey));
    } catch {
      return false;
    }
  }

  /**
   * Generate a nullifier: H(voterSecret || ballotId)
   * This is identical to Scarcity's nullifier generation
   */
  static generateNullifier(voterSecret: string, ballotId: string): Hash {
    return this.hash(voterSecret, ballotId);
  }

  /**
   * Generate a commitment: H(choice || salt)
   * Hides the choice until reveal phase
   */
  static generateCommitment(choice: string, salt: string): Hash {
    return this.hash(choice, salt);
  }

  /**
   * Generate a commitment for any vote data type
   * Uses canonical JSON serialization for deterministic hashing
   */
  static generateVoteCommitment(voteData: VoteData, salt: string): Hash {
    // Serialize vote data deterministically
    const serialized = this.serializeVoteData(voteData);
    return this.hash(serialized, salt);
  }

  /**
   * Serialize vote data deterministically for commitment generation
   */
  static serializeVoteData(voteData: VoteData): string {
    switch (voteData.type) {
      case 'single':
        // For backwards compatibility, single choice uses just the choice string
        return voteData.choice;

      case 'approval':
        // Sort choices for deterministic ordering
        return `approval:${[...voteData.choices].sort().join(',')}`;

      case 'ranked':
        // Rankings are order-dependent, don't sort
        return `ranked:${voteData.rankings.join(',')}`;

      case 'score':
        // Sort by choice name for deterministic ordering
        const sortedScores = Object.entries(voteData.scores)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([choice, score]) => `${choice}:${score}`)
          .join(',');
        return `score:${sortedScores}`;

      default:
        throw new Error(`Unknown vote type: ${(voteData as VoteData).type}`);
    }
  }

  /**
   * Verify a commitment matches the revealed vote data
   */
  static verifyVoteCommitment(commitment: Hash, voteData: VoteData, salt: string): boolean {
    const computed = this.generateVoteCommitment(voteData, salt);
    return this.constantTimeEqual(commitment, computed);
  }

  /**
   * Verify a commitment matches the revealed values
   */
  static verifyCommitment(commitment: Hash, choice: string, salt: string): boolean {
    const computed = this.generateCommitment(choice, salt);
    return this.constantTimeEqual(commitment, computed);
  }

  /**
   * Generate a random salt for commitment
   */
  static generateSalt(): string {
    return this.randomHex(32);
  }

  /**
   * Generate a voter secret (stored locally, used for nullifier)
   */
  static generateVoterSecret(): string {
    return this.randomHex(32);
  }

  /**
   * Constant-time comparison to prevent timing attacks
   */
  static constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  /**
   * Validate a public key format
   */
  static isValidPublicKey(key: string): boolean {
    if (typeof key !== 'string') return false;
    if (key.length !== 64) return false;  // 32 bytes = 64 hex chars
    return /^[0-9a-f]+$/i.test(key);
  }

  /**
   * Validate a hash format
   */
  static isValidHash(hash: string): boolean {
    if (typeof hash !== 'string') return false;
    if (hash.length !== 64) return false;  // SHA-256 = 32 bytes = 64 hex chars
    return /^[0-9a-f]+$/i.test(hash);
  }

  /**
   * Convert bytes to hex
   */
  static toHex(bytes: Uint8Array): string {
    return bytesToHex(bytes);
  }

  /**
   * Convert hex to bytes
   */
  static fromHex(hex: string): Uint8Array {
    return hexToBytes(hex);
  }

  /**
   * Deterministic JSON stringification for consistent hashing
   */
  static canonicalJson(obj: unknown): string {
    return JSON.stringify(obj, Object.keys(obj as object).sort());
  }

  /**
   * Hash an object deterministically
   */
  static hashObject(obj: unknown): Hash {
    return this.hash(this.canonicalJson(obj));
  }
}

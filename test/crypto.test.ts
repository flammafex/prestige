/**
 * Crypto module tests
 */

import { describe, it, expect } from '@jest/globals';
import { Crypto } from '../src/prestige/crypto.js';

describe('Crypto', () => {
  describe('hash', () => {
    it('should produce consistent hashes for the same input', () => {
      const input = 'test input';
      const hash1 = Crypto.hash(input);
      const hash2 = Crypto.hash(input);
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different inputs', () => {
      const hash1 = Crypto.hash('input1');
      const hash2 = Crypto.hash('input2');
      expect(hash1).not.toBe(hash2);
    });

    it('should handle multiple inputs', () => {
      const hash1 = Crypto.hash('a', 'b', 'c');
      const hash2 = Crypto.hash('abc');
      // Combined hash should be different from concatenated string hash
      // because inputs are concatenated as bytes, not strings
      expect(hash1).toBe(hash2); // Actually they should be equal
    });

    it('should produce 64-character hex strings', () => {
      const hash = Crypto.hash('test');
      expect(hash.length).toBe(64);
      expect(/^[0-9a-f]+$/i.test(hash)).toBe(true);
    });
  });

  describe('generateKeyPair', () => {
    it('should generate valid keypairs', () => {
      const keypair = Crypto.generateKeyPair();
      expect(keypair.publicKey).toBeDefined();
      expect(keypair.privateKey).toBeDefined();
      expect(keypair.publicKey.length).toBe(64);
      expect(keypair.privateKey.length).toBe(64);
    });

    it('should generate unique keypairs', () => {
      const kp1 = Crypto.generateKeyPair();
      const kp2 = Crypto.generateKeyPair();
      expect(kp1.publicKey).not.toBe(kp2.publicKey);
      expect(kp1.privateKey).not.toBe(kp2.privateKey);
    });
  });

  describe('sign and verify', () => {
    it('should sign and verify messages', () => {
      const keypair = Crypto.generateKeyPair();
      const message = 'Hello, world!';

      const signature = Crypto.sign(message, keypair.privateKey);
      const valid = Crypto.verify(message, signature, keypair.publicKey);

      expect(valid).toBe(true);
    });

    it('should reject invalid signatures', () => {
      const keypair = Crypto.generateKeyPair();
      const message = 'Hello, world!';

      const signature = Crypto.sign(message, keypair.privateKey);

      // Tamper with signature
      const tamperedSig = signature.slice(0, -2) + '00';
      const valid = Crypto.verify(message, tamperedSig, keypair.publicKey);

      expect(valid).toBe(false);
    });

    it('should reject signatures from wrong key', () => {
      const keypair1 = Crypto.generateKeyPair();
      const keypair2 = Crypto.generateKeyPair();
      const message = 'Hello, world!';

      const signature = Crypto.sign(message, keypair1.privateKey);
      const valid = Crypto.verify(message, signature, keypair2.publicKey);

      expect(valid).toBe(false);
    });

    it('should reject modified messages', () => {
      const keypair = Crypto.generateKeyPair();
      const message = 'Hello, world!';

      const signature = Crypto.sign(message, keypair.privateKey);
      const valid = Crypto.verify('Hello, World!', signature, keypair.publicKey);

      expect(valid).toBe(false);
    });
  });

  describe('commitment scheme', () => {
    it('should generate consistent commitments', () => {
      const choice = 'Option A';
      const salt = Crypto.generateSalt();

      const commitment1 = Crypto.generateCommitment(choice, salt);
      const commitment2 = Crypto.generateCommitment(choice, salt);

      expect(commitment1).toBe(commitment2);
    });

    it('should generate different commitments for different choices', () => {
      const salt = Crypto.generateSalt();

      const commitment1 = Crypto.generateCommitment('Option A', salt);
      const commitment2 = Crypto.generateCommitment('Option B', salt);

      expect(commitment1).not.toBe(commitment2);
    });

    it('should generate different commitments for different salts', () => {
      const choice = 'Option A';

      const commitment1 = Crypto.generateCommitment(choice, Crypto.generateSalt());
      const commitment2 = Crypto.generateCommitment(choice, Crypto.generateSalt());

      expect(commitment1).not.toBe(commitment2);
    });

    it('should verify commitments correctly', () => {
      const choice = 'Option A';
      const salt = Crypto.generateSalt();

      const commitment = Crypto.generateCommitment(choice, salt);
      const valid = Crypto.verifyCommitment(commitment, choice, salt);

      expect(valid).toBe(true);
    });

    it('should reject invalid reveals', () => {
      const salt = Crypto.generateSalt();

      const commitment = Crypto.generateCommitment('Option A', salt);
      const valid = Crypto.verifyCommitment(commitment, 'Option B', salt);

      expect(valid).toBe(false);
    });
  });

  describe('nullifier', () => {
    it('should generate consistent nullifiers', () => {
      const secret = Crypto.generateVoterSecret();
      const ballotId = 'ballot-123';

      const nullifier1 = Crypto.generateNullifier(secret, ballotId);
      const nullifier2 = Crypto.generateNullifier(secret, ballotId);

      expect(nullifier1).toBe(nullifier2);
    });

    it('should generate different nullifiers for different ballots', () => {
      const secret = Crypto.generateVoterSecret();

      const nullifier1 = Crypto.generateNullifier(secret, 'ballot-1');
      const nullifier2 = Crypto.generateNullifier(secret, 'ballot-2');

      expect(nullifier1).not.toBe(nullifier2);
    });

    it('should generate different nullifiers for different voters', () => {
      const ballotId = 'ballot-123';

      const nullifier1 = Crypto.generateNullifier(Crypto.generateVoterSecret(), ballotId);
      const nullifier2 = Crypto.generateNullifier(Crypto.generateVoterSecret(), ballotId);

      expect(nullifier1).not.toBe(nullifier2);
    });
  });

  describe('validation', () => {
    it('should validate public keys', () => {
      const keypair = Crypto.generateKeyPair();
      expect(Crypto.isValidPublicKey(keypair.publicKey)).toBe(true);
      expect(Crypto.isValidPublicKey('invalid')).toBe(false);
      expect(Crypto.isValidPublicKey('')).toBe(false);
      expect(Crypto.isValidPublicKey('x'.repeat(64))).toBe(false);
    });

    it('should validate hashes', () => {
      const hash = Crypto.hash('test');
      expect(Crypto.isValidHash(hash)).toBe(true);
      expect(Crypto.isValidHash('invalid')).toBe(false);
      expect(Crypto.isValidHash('')).toBe(false);
    });
  });

  describe('constantTimeEqual', () => {
    it('should return true for equal strings', () => {
      expect(Crypto.constantTimeEqual('abc', 'abc')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(Crypto.constantTimeEqual('abc', 'abd')).toBe(false);
    });

    it('should return false for different lengths', () => {
      expect(Crypto.constantTimeEqual('abc', 'abcd')).toBe(false);
    });
  });
});

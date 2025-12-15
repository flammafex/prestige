/**
 * Witness Adapter
 * Handles BFT timestamping for ballot creation, votes, and results
 *
 * Witness provides cryptographic proof that something existed at a specific time.
 * Multiple witnesses sign the timestamp, requiring a threshold for validity.
 */

import type { WitnessAttestation, Hash } from '../types.js';

export interface WitnessConfig {
  gatewayUrl: string;
  timeout?: number;
  threshold?: number;
}

export interface WitnessAdapter {
  /**
   * Get an attestation for a hash at a specific time
   */
  attest(hash: Hash, timestamp: number): Promise<WitnessAttestation>;

  /**
   * Verify an attestation is valid
   */
  verify(attestation: WitnessAttestation): Promise<boolean>;

  /**
   * Check if the Witness service is available
   */
  healthCheck(): Promise<boolean>;
}

/**
 * HTTP-based Witness adapter for production use
 */
export class HttpWitnessAdapter implements WitnessAdapter {
  private timeout: number;
  private threshold: number;

  constructor(private config: WitnessConfig) {
    this.timeout = config.timeout ?? 10000;
    this.threshold = config.threshold ?? 2;
  }

  async attest(hash: Hash, timestamp: number): Promise<WitnessAttestation> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.config.gatewayUrl}/attest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash, timestamp }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new WitnessError(
          `Failed to get attestation: ${response.status}`,
          'ATTEST_FAILED'
        );
      }

      const data = await response.json() as {
        hash: string;
        timestamp: number;
        signatures: Array<{ witnessId: string; signature: string }>;
        witnessIds: string[];
      };

      return {
        hash: data.hash,
        timestamp: data.timestamp,
        signatures: data.signatures,
        witnessIds: data.witnessIds,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async verify(attestation: WitnessAttestation): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.config.gatewayUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attestation),
        signal: controller.signal,
      });

      if (!response.ok) {
        return false;
      }

      const data = await response.json() as { valid: boolean; signatureCount: number };
      return data.valid === true && data.signatureCount >= this.threshold;
    } catch {
      console.warn('Witness verification failed');
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${this.config.gatewayUrl}/health`, {
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Mock Witness adapter for testing and development
 */
export class MockWitnessAdapter implements WitnessAdapter {
  private attestations = new Map<string, WitnessAttestation>();
  private witnessIds = ['witness-1', 'witness-2', 'witness-3'];
  private threshold: number;
  private timestampTolerance: number;

  constructor(options?: { threshold?: number; timestampTolerance?: number }) {
    this.threshold = options?.threshold ?? 2;
    this.timestampTolerance = options?.timestampTolerance ?? 5000; // 5 seconds
  }

  async attest(hash: Hash, timestamp: number): Promise<WitnessAttestation> {
    // Validate timestamp is reasonable (not too far in the future)
    const now = Date.now();
    if (timestamp > now + this.timestampTolerance) {
      throw new WitnessError('Timestamp is in the future', 'INVALID_TIMESTAMP');
    }

    const attestation: WitnessAttestation = {
      hash,
      timestamp,
      signatures: this.witnessIds.slice(0, this.threshold).map(id => ({
        witnessId: id,
        signature: `mock-sig-${id}-${hash.slice(0, 8)}-${timestamp}`,
      })),
      witnessIds: this.witnessIds.slice(0, this.threshold),
    };

    this.attestations.set(hash, attestation);
    return attestation;
  }

  async verify(attestation: WitnessAttestation): Promise<boolean> {
    // Check threshold
    if (attestation.signatures.length < this.threshold) {
      return false;
    }

    // Check all witness IDs are valid
    const validWitnesses = attestation.witnessIds.every(id =>
      this.witnessIds.includes(id)
    );
    if (!validWitnesses) {
      return false;
    }

    // Check signatures match witness IDs
    const signatureWitnessIds = attestation.signatures.map(s => s.witnessId);
    const signaturesValid = attestation.witnessIds.every(id =>
      signatureWitnessIds.includes(id)
    );

    return signaturesValid;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  // Test helpers
  setWitnessIds(ids: string[]): void {
    this.witnessIds = ids;
  }

  setThreshold(threshold: number): void {
    this.threshold = threshold;
  }

  clearAttestations(): void {
    this.attestations.clear();
  }
}

/**
 * Witness-specific error
 */
class WitnessError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'WitnessError';
  }
}

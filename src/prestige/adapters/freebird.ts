/**
 * Freebird Adapter
 * Handles VOPRF-based token issuance and verification for voter eligibility
 *
 * Uses P-256 VOPRF (Verifiable Oblivious PRF) protocol:
 * 1. Client blinds input with random scalar r
 * 2. Client sends blinded element to issuer
 * 3. Issuer evaluates VOPRF with private key
 * 4. Client verifies DLEQ proof
 * 5. Token provides anonymous authorization
 */

import type { FreebirdToken } from '../types.js';
import * as voprf from '../../vendor/freebird/voprf.js';
import type { BlindState } from '../../vendor/freebird/voprf.js';

export interface FreebirdConfig {
  issuerUrl: string;
  verifierUrl: string;
  timeout?: number;
}

/**
 * Issue response from Freebird API
 */
interface IssueResponse {
  token: string;
  proof: string;
  kid: string;
  exp: number;
  epoch: number;
  sybil_info?: {
    required: boolean;
    passed: boolean;
    cost: number;
  };
}

export interface FreebirdAdapter {
  /**
   * Issue a new eligibility token
   * The token proves the holder is eligible to vote without revealing identity
   */
  issue(context: string): Promise<FreebirdToken>;

  /**
   * Verify an eligibility token
   * Returns true if the token is valid and not expired
   */
  verify(token: FreebirdToken): Promise<boolean>;

  /**
   * Check if the Freebird service is available
   */
  healthCheck(): Promise<boolean>;
}

/**
 * HTTP-based Freebird adapter with full VOPRF protocol
 */
export class HttpFreebirdAdapter implements FreebirdAdapter {
  private timeout: number;
  private readonly context: Uint8Array;
  private blindStates: Map<string, BlindState> = new Map();
  private metadata: any = null;

  constructor(private config: FreebirdConfig) {
    this.timeout = config.timeout ?? 10000;
    // Context must match Freebird server
    this.context = new TextEncoder().encode('freebird:v1');
  }

  /**
   * Fetch issuer metadata (public key, etc.)
   */
  private async init(): Promise<void> {
    if (this.metadata) return;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.config.issuerUrl}/.well-known/issuer`, {
        signal: controller.signal,
      });

      if (response.ok) {
        this.metadata = await response.json();
        console.log(`[Freebird] Connected to issuer: ${this.metadata.issuer_id || 'unknown'}`);
      } else {
        throw new FreebirdError(
          `Failed to fetch issuer metadata: ${response.status}`,
          'INIT_FAILED'
        );
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Issue a token via VOPRF protocol
   */
  async issue(input: string): Promise<FreebirdToken> {
    await this.init();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      // 1. Blind the input client-side
      const inputBytes = new TextEncoder().encode(input);
      const { blinded, state } = voprf.blind(inputBytes, this.context);

      // Store blind state for potential finalization
      const blindedHex = bytesToHex(blinded);
      this.blindStates.set(blindedHex, state);

      // 2. Send blinded element to issuer
      const url = `${this.config.issuerUrl}/v1/oprf/issue`;
      console.log(`[Freebird] POST ${url}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blinded_element_b64: voprf.bytesToBase64Url(blinded),
          sybil_proof: { type: 'none' }, // For MVP - no sybil resistance
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new FreebirdError(
          `Failed to issue token: ${response.status} - ${url}${body ? ` - ${body}` : ''}`,
          'ISSUE_FAILED'
        );
      }

      const data = await response.json() as IssueResponse;

      // Clean up blind state
      this.blindStates.delete(blindedHex);

      // 3. Return token with server-provided expiration and metadata
      return {
        blindedToken: data.token,
        proof: data.proof || '',
        issuerPublicKey: this.metadata?.voprf?.pubkey || '',
        expiresAt: data.exp * 1000, // Convert Unix seconds to milliseconds
        kid: data.kid,
        epoch: data.epoch,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Verify a token with the verifier service
   */
  async verify(token: FreebirdToken): Promise<boolean> {
    // Check expiration locally first
    if (token.expiresAt < Date.now()) {
      return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const url = `${this.config.verifierUrl}/v1/verify`;

    try {
      console.log(`[Freebird] POST ${url}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token_b64: token.blindedToken,
          issuer_id: this.metadata?.issuer_id,
          // Use token's actual expiration and epoch if available
          exp: token.expiresAt ? Math.floor(token.expiresAt / 1000) : undefined,
          epoch: token.epoch ?? this.metadata?.current_epoch ?? 0,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return false;
      }

      const data = await response.json() as { ok?: boolean; verified_at?: number };
      return data.ok === true;
    } catch {
      console.warn('[Freebird] Verification failed, assuming invalid');
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${this.config.issuerUrl}/.well-known/issuer`, {
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
 * Mock Freebird adapter for testing and development
 */
export class MockFreebirdAdapter implements FreebirdAdapter {
  private issuedTokens = new Set<string>();
  private tokenTTL: number;

  constructor(options?: { tokenTTL?: number }) {
    this.tokenTTL = options?.tokenTTL ?? 60 * 60 * 1000; // 1 hour default
  }

  async issue(context: string): Promise<FreebirdToken> {
    const token: FreebirdToken = {
      blindedToken: `mock-token-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      proof: `mock-proof-${context}`,
      issuerPublicKey: 'mock-issuer-public-key',
      expiresAt: Date.now() + this.tokenTTL,
    };

    this.issuedTokens.add(token.blindedToken);
    return token;
  }

  async verify(token: FreebirdToken): Promise<boolean> {
    // Check expiration
    if (token.expiresAt < Date.now()) {
      return false;
    }

    // Check if token was issued by us
    return this.issuedTokens.has(token.blindedToken);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  // Test helpers
  clearTokens(): void {
    this.issuedTokens.clear();
  }
}

/**
 * Freebird-specific error
 */
class FreebirdError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'FreebirdError';
  }
}

// Helper
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

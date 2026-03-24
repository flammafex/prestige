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

import type { FreebirdToken, FreebirdSybilProof } from '../types.js';
import * as voprf from '../../vendor/freebird/voprf.js';
import type { BlindState } from '../../vendor/freebird/voprf.js';

export interface FreebirdConfig {
  issuerUrl: string;
  verifierUrl: string;
  timeout?: number;
}

/**
 * Issue response from Freebird API (V3)
 */
interface IssueResponse {
  token: string;
  sig: string;
  kid: string;
  exp: number;
  issuer_id: string;
  sybil_info?: {
    required: boolean;
    passed: boolean;
    cost: number;
  };
}

/**
 * Issuer metadata from /.well-known/issuer
 * Aligned with Freebird SDK IssuerMetadata (freebird/sdk/js/src/types.ts)
 */
interface IssuerMetadata {
  issuer_id: string;
  voprf: {
    suite: string;
    kid: string;
    pubkey: string;  // Base64url encoded SEC1 compressed point
    exp_sec: number;
  };
}

export interface FreebirdAdapter {
  /**
   * Issue a new eligibility token
   * The token proves the holder is eligible to vote without revealing identity
   */
  issue(context: string, options?: { sybilProof?: FreebirdSybilProof }): Promise<FreebirdToken>;

  /**
   * Verify and consume an eligibility token via /v1/verify.
   * The token is marked as spent — it cannot be verified again.
   * Use this only when accepting a token for the first time (e.g. casting a vote).
   */
  verify(token: FreebirdToken): Promise<boolean>;

  /**
   * Check a token's validity without consuming it via /v1/check.
   * The token remains usable after this call.
   * Use this for re-validation (e.g. gossip verification, audit checks).
   */
  check(token: FreebirdToken): Promise<boolean>;

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
  private metadata: IssuerMetadata | null = null;

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
        const metadata = await response.json() as IssuerMetadata;

        // Validate required fields
        if (!metadata.voprf?.pubkey) {
          throw new FreebirdError(
            'Issuer metadata missing required voprf.pubkey field',
            'INIT_FAILED'
          );
        }

        this.metadata = metadata;
        console.log(`[Freebird] Connected to issuer: ${metadata.issuer_id || 'unknown'}`);
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
  async issue(input: string, options?: { sybilProof?: FreebirdSybilProof }): Promise<FreebirdToken> {
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
          sybil_proof: options?.sybilProof ?? { type: 'none' }, // MVP fallback when no proof is provided
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

      // 3. Verify DLEQ proof, unblind, and build V3 redemption token
      const output = voprf.finalize(
        state, data.token, this.metadata!.voprf.pubkey, this.context
      );

      // Clean up blind state
      this.blindStates.delete(blindedHex);

      const sigBytes = base64UrlToBytes(data.sig);
      const issuerId = data.issuer_id ?? this.metadata?.issuer_id ?? '';
      const redemptionToken = voprf.buildRedemptionToken(
        output, data.kid, BigInt(data.exp), issuerId, sigBytes
      );

      // 4. Return V3 token
      return {
        tokenValue: voprf.bytesToBase64Url(redemptionToken),
        issuerId,
        expiresAt: data.exp * 1000, // Convert Unix seconds to milliseconds
        kid: data.kid,
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
      // V3 tokens are self-contained — verifier only needs the token itself
      console.log(`[Freebird] POST ${url}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token_b64: token.tokenValue,
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

  /**
   * Check a token's validity without consuming it.
   * Uses /v1/check — token remains usable afterward.
   */
  async check(token: FreebirdToken): Promise<boolean> {
    // Check expiration locally first
    if (token.expiresAt < Date.now()) {
      return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const url = `${this.config.verifierUrl}/v1/check`;

    try {
      console.log(`[Freebird] POST ${url}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token_b64: token.tokenValue,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return false;
      }

      const data = await response.json() as { ok?: boolean; verified_at?: number };
      return data.ok === true;
    } catch {
      console.warn('[Freebird] Check failed, assuming invalid');
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

  async issue(context: string, _options?: { sybilProof?: FreebirdSybilProof }): Promise<FreebirdToken> {
    const token: FreebirdToken = {
      tokenValue: `mock-token-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      issuerId: 'mock-issuer:v1',
      expiresAt: Date.now() + this.tokenTTL,
    };

    this.issuedTokens.add(token.tokenValue);
    return token;
  }

  async verify(token: FreebirdToken): Promise<boolean> {
    // Check expiration
    if (token.expiresAt < Date.now()) {
      return false;
    }

    // Check if token was issued by us, then consume it
    const exists = this.issuedTokens.has(token.tokenValue);
    if (exists) {
      this.issuedTokens.delete(token.tokenValue);
    }
    return exists;
  }

  async check(token: FreebirdToken): Promise<boolean> {
    // Check expiration
    if (token.expiresAt < Date.now()) {
      return false;
    }

    // Check validity without consuming
    return this.issuedTokens.has(token.tokenValue);
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

// Helpers
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64UrlToBytes(base64: string): Uint8Array {
  const binString = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binString, (m) => m.codePointAt(0)!);
}

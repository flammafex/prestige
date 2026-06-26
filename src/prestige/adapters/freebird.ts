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
 * Issue response from Freebird API (V4)
 */
interface IssueResponse {
  token: string;
  kid: string;
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
  };
}

/**
 * Verifier metadata from /.well-known/verifier.
 * V4 tokens are bound to this verifier/audience scope.
 */
interface VerifierMetadata {
  verifier_id: string;
  audience: string;
  scope_digest_b64: string;
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
  private verifierMetadata: VerifierMetadata | null = null;

  constructor(private config: FreebirdConfig) {
    this.timeout = config.timeout ?? 10000;
    // Context must match Freebird server
    this.context = new TextEncoder().encode('freebird:v4');
  }

  /**
   * Fetch issuer metadata (public key, etc.)
   */
  private async init(): Promise<void> {
    if (this.metadata && this.verifierMetadata) return;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      if (!this.metadata) {
        const response = await fetch(`${this.config.issuerUrl}/.well-known/issuer`, {
          signal: controller.signal,
        });

        if (response.ok) {
          const metadata = await response.json() as IssuerMetadata;

          // Validate required fields
          if (!metadata.issuer_id || !metadata.voprf?.kid || !metadata.voprf?.pubkey) {
            throw new FreebirdError(
              'Issuer metadata missing required issuer_id/voprf fields',
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
      }

      if (!this.verifierMetadata) {
        const response = await fetch(`${this.config.verifierUrl}/.well-known/verifier`, {
          signal: controller.signal,
        });

        if (response.ok) {
          const verifierMetadata = await response.json() as VerifierMetadata;
          if (
            !verifierMetadata.verifier_id ||
            !verifierMetadata.audience ||
            !verifierMetadata.scope_digest_b64
          ) {
            throw new FreebirdError(
              'Verifier metadata missing required verifier_id/audience/scope fields',
              'INIT_FAILED'
            );
          }

          const scopeDigest = voprf.base64UrlToBytes(verifierMetadata.scope_digest_b64);
          const expectedScopeDigest = voprf.buildScopeDigest(
            verifierMetadata.verifier_id,
            verifierMetadata.audience
          );
          if (!bytesEqual(scopeDigest, expectedScopeDigest)) {
            throw new FreebirdError(
              'Verifier scope metadata is inconsistent',
              'INIT_FAILED'
            );
          }

          this.verifierMetadata = verifierMetadata;
          console.log(`[Freebird] Connected to verifier: ${verifierMetadata.verifier_id}`);
        } else {
          throw new FreebirdError(
            `Failed to fetch verifier metadata: ${response.status}`,
            'INIT_FAILED'
          );
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Issue a token via VOPRF protocol
   */
  async issue(_context: string, options?: { sybilProof?: FreebirdSybilProof }): Promise<FreebirdToken> {
    await this.init();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      // 1. Build and blind the V4 private-token input.
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const scopeDigest = voprf.base64UrlToBytes(this.verifierMetadata!.scope_digest_b64);
      const inputBytes = voprf.buildPrivateTokenInput(
        this.metadata!.issuer_id,
        this.metadata!.voprf.kid,
        nonce,
        scopeDigest
      );
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
          sybil_proof: options?.sybilProof,
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
      if (
        data.kid !== this.metadata!.voprf.kid ||
        data.issuer_id !== this.metadata!.issuer_id
      ) {
        throw new FreebirdError(
          'Issuer metadata changed during issuance',
          'ISSUE_FAILED'
        );
      }

      // 3. Verify DLEQ proof, unblind, and build a V4 redemption token.
      const output = voprf.finalize(
        state, data.token, this.metadata!.voprf.pubkey, this.context
      );

      // Clean up blind state
      this.blindStates.delete(blindedHex);

      const redemptionToken = voprf.buildRedemptionToken(
        nonce,
        scopeDigest,
        data.kid,
        data.issuer_id,
        output
      );

      // 4. Return V4 token
      return {
        tokenValue: voprf.bytesToBase64Url(redemptionToken),
        issuerId: data.issuer_id,
        version: 4,
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
    // Current V4 tokens do not carry an expiry. Honor legacy tokens that do.
    if (token.expiresAt !== undefined && token.expiresAt < Date.now()) {
      return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const url = `${this.config.verifierUrl}/v1/verify`;

    try {
      // V4/V5 tokens are self-contained — verifier only needs the token itself.
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
    // Current V4 tokens do not carry an expiry. Honor legacy tokens that do.
    if (token.expiresAt !== undefined && token.expiresAt < Date.now()) {
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
      issuerId: 'mock-issuer:v4',
      version: 4,
      expiresAt: Date.now() + this.tokenTTL,
    };

    this.issuedTokens.add(token.tokenValue);
    return token;
  }

  async verify(token: FreebirdToken): Promise<boolean> {
    // Check expiration
    if (token.expiresAt !== undefined && token.expiresAt < Date.now()) {
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
    if (token.expiresAt !== undefined && token.expiresAt < Date.now()) {
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

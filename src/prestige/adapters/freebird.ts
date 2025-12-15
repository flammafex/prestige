/**
 * Freebird Adapter
 * Handles VOPRF-based token issuance and verification for voter eligibility
 *
 * Freebird provides unlinkable tokens - the issuer knows someone is eligible,
 * but cannot link the issued token to the verifier presentation. This is
 * essential for ballot secrecy.
 */

import type { FreebirdToken } from '../types.js';

export interface FreebirdConfig {
  issuerUrl: string;
  verifierUrl: string;
  timeout?: number;
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
 * HTTP-based Freebird adapter for production use
 */
export class HttpFreebirdAdapter implements FreebirdAdapter {
  private timeout: number;

  constructor(private config: FreebirdConfig) {
    this.timeout = config.timeout ?? 10000;
  }

  async issue(context: string): Promise<FreebirdToken> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      // Step 1: Get blinding factor from issuer
      const blindResponse = await fetch(`${this.config.issuerUrl}/blind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context }),
        signal: controller.signal,
      });

      if (!blindResponse.ok) {
        throw new FreebirdError(
          `Failed to get blinding factor: ${blindResponse.status}`,
          'ISSUE_FAILED'
        );
      }

      const blindData = await blindResponse.json() as { blindedToken: string };

      // Step 2: Get signed token
      const signResponse = await fetch(`${this.config.issuerUrl}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blindedToken: blindData.blindedToken,
          context,
        }),
        signal: controller.signal,
      });

      if (!signResponse.ok) {
        throw new FreebirdError(
          `Failed to sign token: ${signResponse.status}`,
          'ISSUE_FAILED'
        );
      }

      const signData = await signResponse.json() as {
        blindedToken: string;
        proof: string;
        issuerPublicKey: string;
        expiresAt: number;
      };

      return {
        blindedToken: signData.blindedToken,
        proof: signData.proof,
        issuerPublicKey: signData.issuerPublicKey,
        expiresAt: signData.expiresAt,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async verify(token: FreebirdToken): Promise<boolean> {
    // Check expiration locally first
    if (token.expiresAt < Date.now()) {
      return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.config.verifierUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(token),
        signal: controller.signal,
      });

      if (!response.ok) {
        return false;
      }

      const data = await response.json() as { valid: boolean };
      return data.valid === true;
    } catch {
      // On network error, fail open for availability
      // In production, consider caching or fallback strategies
      console.warn('Freebird verification failed, assuming invalid');
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const [issuerHealth, verifierHealth] = await Promise.all([
        fetch(`${this.config.issuerUrl}/health`, { signal: controller.signal }),
        fetch(`${this.config.verifierUrl}/health`, { signal: controller.signal }),
      ]);

      return issuerHealth.ok && verifierHealth.ok;
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

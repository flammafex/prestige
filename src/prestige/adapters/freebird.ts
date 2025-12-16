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
 *
 * Note: Token issuance requires an invitation code from Freebird.
 * For MVP, use open voter gate. For production, users should
 * obtain Freebird tokens externally and present them to vote.
 */
export class HttpFreebirdAdapter implements FreebirdAdapter {
  private timeout: number;

  constructor(private config: FreebirdConfig) {
    this.timeout = config.timeout ?? 10000;
  }

  /**
   * Issue a token using an invitation code
   * In the real flow, the invitation_code would come from the user
   * For now, this is a placeholder - use open voter gate for MVP
   */
  async issue(context: string): Promise<FreebirdToken> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      // Real Freebird API requires invitation_code
      // This is a design mismatch - for MVP, use open voter gate
      const response = await fetch(`${this.config.issuerUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // invitation_code would need to come from somewhere
          // For now, this will fail unless you have a valid code
          invitation_code: context,
          user_id: `prestige-voter-${Date.now()}`,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new FreebirdError(
          `Failed to issue token: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`,
          'ISSUE_FAILED'
        );
      }

      const data = await response.json() as {
        token: string;
        expires_at: number;
      };

      return {
        blindedToken: data.token,
        proof: '',
        issuerPublicKey: '',
        expiresAt: data.expires_at * 1000, // Convert to ms if needed
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
        body: JSON.stringify({ token: token.blindedToken }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return false;
      }

      const data = await response.json() as {
        valid: boolean;
        issuer_id?: string;
        expires_at?: number;
      };
      return data.valid === true;
    } catch {
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

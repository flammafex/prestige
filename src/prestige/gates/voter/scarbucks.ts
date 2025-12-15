/**
 * Scarbucks Voter Gate
 * Anyone holding specific tokens can vote
 */

import type { VoterGate, GateResult, GateRequirements } from '../types.js';

export class ScarbucksVoterGate implements VoterGate {
  readonly type = 'scarbucks' as const;
  private timeout: number;

  constructor(
    private scarcityUrl: string,
    private tokenId: string,
    private minAmount: number,
    options?: { timeout?: number }
  ) {
    this.timeout = options?.timeout ?? 10000;
  }

  async canVote(publicKey: string): Promise<GateResult> {
    const hasTokens = await this.verifyOwnership(publicKey);
    return {
      allowed: hasTokens,
      reason: hasTokens ? undefined : `Requires ${this.minAmount}+ tokens of ${this.tokenId}`,
    };
  }

  getRequirements(): GateRequirements {
    return {
      type: 'scarbucks',
      description: `Requires ${this.minAmount}+ ${this.tokenId} tokens`,
      requirements: [
        `Must hold at least ${this.minAmount} ${this.tokenId} tokens`,
        'Token ownership is verified anonymously',
      ],
    };
  }

  /**
   * Verify token ownership via Scarcity API
   * Uses privacy-preserving proof (prove >= minAmount without revealing exact balance)
   */
  private async verifyOwnership(publicKey: string): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      // Query Scarcity for ownership proof
      // The API should support proving "I own >= X tokens" without revealing exact balance
      const response = await fetch(`${this.scarcityUrl}/api/tokens/verify-ownership`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenId: this.tokenId,
          publicKey,
          minAmount: this.minAmount,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        console.warn(`Scarcity API returned ${response.status}`);
        return false;
      }

      const data = await response.json() as { verified?: boolean };
      return data.verified === true;
    } catch (error) {
      console.error('Failed to verify token ownership:', error);
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get the minimum amount required
   */
  getMinAmount(): number {
    return this.minAmount;
  }

  /**
   * Get the token ID
   */
  getTokenId(): string {
    return this.tokenId;
  }
}

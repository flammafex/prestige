/**
 * Clout Voter Gate
 * Anyone within N trust hops of the owner can vote
 */

import type { VoterGate, GateResult, GateRequirements } from '../types.js';

export class CloutVoterGate implements VoterGate {
  readonly type = 'clout' as const;
  private timeout: number;

  constructor(
    private cloutUrl: string,
    private ownerKey: string,
    private maxHops: number,
    options?: { timeout?: number }
  ) {
    this.timeout = options?.timeout ?? 10000;
  }

  async canVote(publicKey: string): Promise<GateResult> {
    // Owner is always within 0 hops
    if (publicKey === this.ownerKey) {
      return { allowed: true };
    }

    const distance = await this.getTrustDistance(publicKey);
    const allowed = distance >= 0 && distance <= this.maxHops;

    return {
      allowed,
      reason: allowed
        ? undefined
        : distance < 0
          ? 'Not in trust network'
          : `Beyond ${this.maxHops} trust hops from instance owner`,
    };
  }

  getRequirements(): GateRequirements {
    return {
      type: 'clout',
      description: `Within ${this.maxHops} trust hops of owner`,
      requirements: [
        `Must be within ${this.maxHops} trust hops of the instance owner`,
        'Build trust connections to become part of the network',
      ],
    };
  }

  /**
   * Query Clout API for trust distance
   */
  private async getTrustDistance(publicKey: string): Promise<number> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.cloutUrl}/api/trust/distance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: this.ownerKey,
          to: publicKey,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        console.warn(`Clout API returned ${response.status}`);
        return -1;
      }

      const data = await response.json();
      return data.distance ?? -1;
    } catch (error) {
      console.error('Failed to query Clout trust distance:', error);
      return -1;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get the configured max hops
   */
  getMaxHops(): number {
    return this.maxHops;
  }
}

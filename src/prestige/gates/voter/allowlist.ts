/**
 * Allowlist Voter Gate
 * Only specific keys can vote
 */

import type { VoterGate, GateResult, GateRequirements } from '../types.js';

export class AllowlistVoterGate implements VoterGate {
  readonly type = 'allowlist' as const;

  constructor(private allowlist: Set<string>) {}

  async canVote(publicKey: string): Promise<GateResult> {
    const allowed = this.allowlist.has(publicKey);
    return {
      allowed,
      reason: allowed ? undefined : 'Not on the voter allowlist',
    };
  }

  getRequirements(): GateRequirements {
    return {
      type: 'allowlist',
      description: 'Restricted to specific voters',
      requirements: ['Must be on the instance voter allowlist'],
    };
  }

  /**
   * Add a key to the allowlist (for runtime management)
   */
  addToAllowlist(publicKey: string): void {
    this.allowlist.add(publicKey);
  }

  /**
   * Remove a key from the allowlist (for runtime management)
   */
  removeFromAllowlist(publicKey: string): void {
    this.allowlist.delete(publicKey);
  }

  /**
   * Check if a key is on the allowlist
   */
  isAllowed(publicKey: string): boolean {
    return this.allowlist.has(publicKey);
  }

  /**
   * Get the allowlist
   */
  getAllowlist(): string[] {
    return Array.from(this.allowlist);
  }

  /**
   * Get the size of the allowlist
   */
  size(): number {
    return this.allowlist.size;
  }
}

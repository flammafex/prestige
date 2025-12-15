/**
 * Delegation Ballot Gate
 * Authorized delegates can create ballots
 */

import type { BallotGate, GateResult, GateRequirements } from '../types.js';

export class DelegationBallotGate implements BallotGate {
  readonly type = 'delegation' as const;

  constructor(private delegates: Set<string>) {}

  async canCreate(publicKey: string): Promise<GateResult> {
    const allowed = this.delegates.has(publicKey);
    return {
      allowed,
      reason: allowed ? undefined : 'Not a delegated ballot creator',
    };
  }

  getRequirements(): GateRequirements {
    return {
      type: 'delegation',
      description: 'Delegated creators only',
      requirements: ['Must be on the list of authorized ballot creators'],
    };
  }

  /**
   * Add a delegate (for runtime management)
   */
  addDelegate(publicKey: string): void {
    this.delegates.add(publicKey);
  }

  /**
   * Remove a delegate (for runtime management)
   */
  removeDelegate(publicKey: string): void {
    this.delegates.delete(publicKey);
  }

  /**
   * Check if a key is a delegate
   */
  isDelegate(publicKey: string): boolean {
    return this.delegates.has(publicKey);
  }

  /**
   * Get all delegates
   */
  getDelegates(): string[] {
    return Array.from(this.delegates);
  }
}

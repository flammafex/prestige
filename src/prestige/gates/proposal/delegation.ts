/**
 * Delegation Proposal Gate
 * Only specific designated keys can propose ballots
 */

import type { GateResult, GateRequirements } from '../types.js';
import type { ProposalGate, ProposalGateType } from './types.js';

export class DelegationProposalGate implements ProposalGate {
  readonly type: ProposalGateType = 'delegation';

  constructor(private delegates: Set<string>) {}

  async canPropose(publicKey: string): Promise<GateResult> {
    const allowed = this.delegates.has(publicKey);
    return {
      allowed,
      reason: allowed ? undefined : 'Only designated proposers can open petitions',
    };
  }

  getRequirements(): GateRequirements {
    return {
      type: 'delegation',
      description: 'Only designated proposers can open petitions',
      requirements: [
        'Must be on the list of authorized proposers',
        `${this.delegates.size} proposer(s) authorized`,
      ],
    };
  }

  /**
   * Get the set of delegate public keys
   */
  getDelegates(): Set<string> {
    return new Set(this.delegates);
  }

  /**
   * Check if a key is a delegate
   */
  isDelegate(publicKey: string): boolean {
    return this.delegates.has(publicKey);
  }
}

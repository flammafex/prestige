/**
 * Freebird Voter Gate
 * Anyone passing the Sybil check can vote
 * Uses the instance's Freebird configuration for Sybil resistance
 */

import type { FreebirdAdapter } from '../../adapters/freebird.js';
import type { VoterGate, GateResult, GateRequirements } from '../types.js';

export class FreebirdVoterGate implements VoterGate {
  readonly type = 'freebird' as const;

  constructor(private freebird: FreebirdAdapter) {}

  /**
   * Freebird gate always allows at the gate level.
   * The actual Sybil check happens during token issuance.
   * This gate just indicates that Freebird tokens will be required.
   */
  async canVote(_publicKey: string): Promise<GateResult> {
    // The Freebird voter gate allows anyone to attempt voting,
    // but they must obtain a valid Freebird token first.
    // The actual Sybil resistance is enforced by the Freebird issuer.
    return { allowed: true };
  }

  getRequirements(): GateRequirements {
    return {
      type: 'freebird',
      description: 'Sybil-resistant voting',
      requirements: [
        'Must pass the Sybil resistance check',
        'One vote per verified identity',
      ],
    };
  }

  /**
   * Get the Freebird adapter for token issuance
   */
  getFreebirdAdapter(): FreebirdAdapter {
    return this.freebird;
  }
}

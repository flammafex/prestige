/**
 * Open Ballot Gate
 * Anyone can create ballots (for MVP/testing)
 */

import type { BallotGate, GateResult, GateRequirements } from '../types.js';

export class OpenBallotGate implements BallotGate {
  readonly type = 'open' as const;

  async canCreate(_publicKey: string): Promise<GateResult> {
    return { allowed: true };
  }

  getRequirements(): GateRequirements {
    return {
      type: 'open',
      description: 'Anyone can create ballots',
      requirements: ['No restrictions'],
    };
  }
}

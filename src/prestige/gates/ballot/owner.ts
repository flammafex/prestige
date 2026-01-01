/**
 * Owner Ballot Gate
 * Only the instance admin can create ballots
 */

import type { BallotGate, GateResult, GateRequirements } from '../types.js';

export class OwnerBallotGate implements BallotGate {
  readonly type = 'owner' as const;

  constructor(private adminKey: string) {}

  async canCreate(publicKey: string): Promise<GateResult> {
    const allowed = publicKey === this.adminKey;
    return {
      allowed,
      reason: allowed ? undefined : 'Only instance owner can create ballots',
    };
  }

  getRequirements(): GateRequirements {
    return {
      type: 'owner',
      description: 'Instance owner only',
      requirements: ['Must be the instance administrator'],
    };
  }
}

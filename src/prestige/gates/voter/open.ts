/**
 * Open Voter Gate
 * Anyone can vote (no restrictions)
 */

import type { VoterGate, GateResult, GateRequirements } from '../types.js';

export class OpenVoterGate implements VoterGate {
  readonly type = 'open' as const;

  async canVote(_publicKey: string): Promise<GateResult> {
    return { allowed: true };
  }

  getRequirements(): GateRequirements {
    return {
      type: 'open',
      description: 'Open to everyone',
      requirements: ['Anyone with the ballot link can vote'],
    };
  }
}

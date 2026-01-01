/**
 * Voters Proposal Gate
 * Anyone passing the instance voter gate can propose ballots
 * This is the default - if you can vote, you can propose
 */

import type { VoterGate, GateResult, GateRequirements } from '../types.js';
import type { ProposalGate, ProposalGateType } from './types.js';

export class VotersProposalGate implements ProposalGate {
  readonly type: ProposalGateType = 'voters';

  constructor(private voterGate: VoterGate) {}

  async canPropose(publicKey: string): Promise<GateResult> {
    const result = await this.voterGate.canVote(publicKey);
    return {
      allowed: result.allowed,
      reason: result.allowed
        ? undefined
        : 'Must be eligible to vote to propose ballots',
    };
  }

  getRequirements(): GateRequirements {
    const voterReqs = this.voterGate.getRequirements();
    return {
      type: 'voters',
      description: 'Any eligible voter can propose',
      requirements: [
        'Must pass the instance voter eligibility check',
        `Voter gate: ${voterReqs.description}`,
      ],
    };
  }
}

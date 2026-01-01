/**
 * Proposal Gates - Controls who can open petitions
 *
 * The proposal gate is nested inside the petition ballot gate.
 * It determines who can propose ballots that require signatures to activate.
 */

import type { VoterGate } from '../types.js';
import type { ProposalGate, ProposalGateType } from './types.js';
import { VotersProposalGate } from './voters.js';
import { DelegationProposalGate } from './delegation.js';

/**
 * Configuration for proposal gate creation
 */
export interface ProposalGateConfig {
  petitionProposalGate?: ProposalGateType;

  // For delegation proposal gate
  petitionProposalDelegates?: string[];
}

export interface ProposalGateFactoryOptions {
  config: ProposalGateConfig;
  voterGate: VoterGate;
  instancePublicKey: string;
}

/**
 * Create a proposal gate from configuration
 */
export function createProposalGate(options: ProposalGateFactoryOptions): ProposalGate {
  const { config, voterGate } = options;

  switch (config.petitionProposalGate ?? 'voters') {
    case 'voters':
      return new VotersProposalGate(voterGate);

    case 'delegation':
      return new DelegationProposalGate(
        new Set(config.petitionProposalDelegates ?? [])
      );

    default:
      // Default to voters gate
      return new VotersProposalGate(voterGate);
  }
}

// Re-export types
export type { ProposalGate, ProposalGateType } from './types.js';

// Re-export implementations
export { VotersProposalGate } from './voters.js';
export { DelegationProposalGate } from './delegation.js';

/**
 * Proposal Gates - Controls who can open petitions
 *
 * The proposal gate is nested inside the petition ballot gate.
 * It determines who can propose ballots that require signatures to activate.
 */

import type { VoterGate } from '../types.js';
import type { ProposalGate, ProposalGateType } from './types.js';
import { VotersProposalGate } from './voters.js';
import { CloutProposalGate } from './clout.js';
import { DelegationProposalGate } from './delegation.js';
import { TokenProposalGate } from './token.js';

/**
 * Configuration for proposal gate creation
 */
export interface ProposalGateConfig {
  petitionProposalGate?: ProposalGateType;

  // For clout proposal gate
  petitionProposalCloutUrl?: string;
  petitionProposalTrustHops?: number;

  // For delegation proposal gate
  petitionProposalDelegates?: string[];

  // For token proposal gate
  petitionProposalScarcityUrl?: string;
  petitionProposalTokenId?: string;
  petitionProposalMinAmount?: number;
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
  const { config, voterGate, instancePublicKey } = options;

  switch (config.petitionProposalGate ?? 'voters') {
    case 'voters':
      return new VotersProposalGate(voterGate);

    case 'clout':
      if (!config.petitionProposalCloutUrl) {
        throw new Error('PETITION_PROPOSAL_CLOUT_URL is required for clout proposal gate');
      }
      return new CloutProposalGate(
        config.petitionProposalCloutUrl,
        instancePublicKey,
        config.petitionProposalTrustHops ?? 1
      );

    case 'delegation':
      return new DelegationProposalGate(
        new Set(config.petitionProposalDelegates ?? [])
      );

    case 'token':
      if (!config.petitionProposalScarcityUrl || !config.petitionProposalTokenId) {
        throw new Error(
          'PETITION_PROPOSAL_SCARCITY_URL and PETITION_PROPOSAL_TOKEN_ID are required for token proposal gate'
        );
      }
      return new TokenProposalGate(
        config.petitionProposalScarcityUrl,
        config.petitionProposalTokenId,
        config.petitionProposalMinAmount ?? 1
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
export { CloutProposalGate } from './clout.js';
export { DelegationProposalGate } from './delegation.js';
export { TokenProposalGate } from './token.js';

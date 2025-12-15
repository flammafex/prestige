/**
 * Gate System - Controls ballot creation and voter eligibility
 *
 * "No one owns the mechanism, but someone owns each instance."
 */

import type { PrestigeStore } from '../types.js';
import type { FreebirdAdapter } from '../adapters/freebird.js';
import type { BallotGate, VoterGate, GateConfig } from './types.js';

// Ballot Gates
import { OwnerBallotGate } from './ballot/owner.js';
import { DelegationBallotGate } from './ballot/delegation.js';
import { CloutBallotGate } from './ballot/clout.js';
import { FreebirdBallotGate } from './ballot/freebird.js';
import { PetitionBallotGate } from './ballot/petition.js';

// Voter Gates
import { OpenVoterGate } from './voter/open.js';
import { FreebirdVoterGate } from './voter/freebird.js';
import { CloutVoterGate } from './voter/clout.js';
import { ScarbucksVoterGate } from './voter/scarbucks.js';
import { AllowlistVoterGate } from './voter/allowlist.js';

// Proposal Gates
import {
  createProposalGate,
  type ProposalGate,
  type ProposalGateType,
} from './proposal/index.js';

export interface GateFactoryOptions {
  config: GateConfig;
  store: PrestigeStore;
  freebird: FreebirdAdapter;
  instancePublicKey: string;
  voterGate?: VoterGate; // Required for petition ballot gate
}

/**
 * Create a ballot gate from configuration
 */
export function createBallotGate(options: GateFactoryOptions): BallotGate {
  const { config, store, freebird, instancePublicKey } = options;

  switch (config.ballotGate) {
    case 'owner':
      return new OwnerBallotGate(config.ballotGateAdminKey ?? instancePublicKey);

    case 'delegation':
      return new DelegationBallotGate(
        new Set(config.ballotGateDelegates ?? [])
      );

    case 'clout':
      if (!config.ballotGateCloutUrl) {
        throw new Error('BALLOT_GATE_CLOUT_URL is required for clout gate');
      }
      return new CloutBallotGate(
        config.ballotGateCloutUrl,
        config.ballotGateAdminKey ?? instancePublicKey,
        config.ballotGateTrustHops ?? 2
      );

    case 'freebird':
      if (!config.ballotGateFreebirdIssuer) {
        throw new Error('BALLOT_GATE_FREEBIRD_ISSUER is required for freebird gate');
      }
      return new FreebirdBallotGate(freebird, config.ballotGateFreebirdIssuer);

    case 'petition': {
      // Petition gate needs a voter gate for signature validation
      // If not provided, create a temporary one to pass to proposal gate
      const voterGateForPetition = options.voterGate ?? createVoterGate(options);

      // Create proposal gate
      const proposalGate = createProposalGate({
        config: {
          petitionProposalGate: config.petitionProposalGate,
          petitionProposalCloutUrl: config.petitionProposalCloutUrl,
          petitionProposalTrustHops: config.petitionProposalTrustHops,
          petitionProposalDelegates: config.petitionProposalDelegates,
          petitionProposalScarcityUrl: config.petitionProposalScarcityUrl,
          petitionProposalTokenId: config.petitionProposalTokenId,
          petitionProposalMinAmount: config.petitionProposalMinAmount,
        },
        voterGate: voterGateForPetition,
        instancePublicKey,
      });

      return new PetitionBallotGate(
        config.ballotGatePetitionThreshold ?? 10,
        store,
        proposalGate,
        voterGateForPetition
      );
    }

    default:
      // Default to owner gate
      return new OwnerBallotGate(config.ballotGateAdminKey ?? instancePublicKey);
  }
}

/**
 * Create a voter gate from configuration
 */
export function createVoterGate(options: GateFactoryOptions): VoterGate {
  const { config, freebird, instancePublicKey } = options;

  switch (config.voterGate) {
    case 'open':
      return new OpenVoterGate();

    case 'freebird':
      return new FreebirdVoterGate(freebird);

    case 'clout':
      if (!config.voterGateCloutUrl) {
        throw new Error('VOTER_GATE_CLOUT_URL is required for clout gate');
      }
      return new CloutVoterGate(
        config.voterGateCloutUrl,
        config.ballotGateAdminKey ?? instancePublicKey,
        config.voterGateTrustHops ?? 3
      );

    case 'scarbucks':
      if (!config.voterGateScarcityUrl || !config.voterGateTokenId) {
        throw new Error(
          'VOTER_GATE_SCARCITY_URL and VOTER_GATE_TOKEN_ID are required for scarbucks gate'
        );
      }
      return new ScarbucksVoterGate(
        config.voterGateScarcityUrl,
        config.voterGateTokenId,
        config.voterGateMinAmount ?? 1
      );

    case 'allowlist':
      return new AllowlistVoterGate(new Set(config.voterGateAllowlist ?? []));

    default:
      // Default to freebird gate for Sybil resistance
      return new FreebirdVoterGate(freebird);
  }
}

// Re-export types
export * from './types.js';

// Re-export ballot gates
export { OwnerBallotGate } from './ballot/owner.js';
export { DelegationBallotGate } from './ballot/delegation.js';
export { CloutBallotGate } from './ballot/clout.js';
export { FreebirdBallotGate } from './ballot/freebird.js';
export { PetitionBallotGate } from './ballot/petition.js';

// Re-export voter gates
export { OpenVoterGate } from './voter/open.js';
export { FreebirdVoterGate } from './voter/freebird.js';
export { CloutVoterGate } from './voter/clout.js';
export { ScarbucksVoterGate } from './voter/scarbucks.js';
export { AllowlistVoterGate } from './voter/allowlist.js';

// Re-export proposal gates
export { createProposalGate } from './proposal/index.js';
export { VotersProposalGate } from './proposal/voters.js';
export { CloutProposalGate } from './proposal/clout.js';
export { DelegationProposalGate } from './proposal/delegation.js';
export { TokenProposalGate } from './proposal/token.js';
export type { ProposalGate, ProposalGateType } from './proposal/types.js';

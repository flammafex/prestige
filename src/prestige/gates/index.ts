/**
 * Gate System - Controls ballot creation and voter eligibility
 *
 * "No one owns the mechanism, but someone owns each instance."
 */

import type { PrestigeStore } from '../types.js';
import { HttpFreebirdAdapter, type FreebirdAdapter } from '../adapters/freebird.js';
import type { BallotGate, VoterGate, GateConfig } from './types.js';

// Ballot Gates
import { OpenBallotGate } from './ballot/open.js';
import { OwnerBallotGate } from './ballot/owner.js';
import { DelegationBallotGate } from './ballot/delegation.js';
import { FreebirdBallotGate } from './ballot/freebird.js';
import { PetitionBallotGate } from './ballot/petition.js';

// Voter Gates
import { OpenVoterGate } from './voter/open.js';
import { FreebirdVoterGate } from './voter/freebird.js';
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
  /** Shared Freebird verifier URL (for creating gate-specific adapters) */
  freebirdVerifierUrl: string;
  instancePublicKey: string;
  voterGate?: VoterGate; // Required for petition ballot gate
}

/**
 * Create a ballot gate from configuration
 */
export function createBallotGate(options: GateFactoryOptions): BallotGate {
  const { config, store, freebird, instancePublicKey } = options;

  switch (config.ballotGate) {
    case 'open':
      return new OpenBallotGate();

    case 'owner':
      return new OwnerBallotGate(config.ballotGateAdminKey ?? instancePublicKey);

    case 'delegation':
      return new DelegationBallotGate(
        new Set(config.ballotGateDelegates ?? [])
      );

    case 'freebird': {
      if (!config.ballotGateFreebirdIssuer) {
        throw new Error('BALLOT_GATE_FREEBIRD_ISSUER is required for freebird gate');
      }
      // Use gate-specific issuer URL if provided, otherwise use default adapter
      const ballotFreebirdAdapter = config.ballotGateFreebirdIssuerUrl
        ? new HttpFreebirdAdapter({
            issuerUrl: config.ballotGateFreebirdIssuerUrl,
            verifierUrl: options.freebirdVerifierUrl,
          })
        : freebird;
      return new FreebirdBallotGate(ballotFreebirdAdapter, config.ballotGateFreebirdIssuer);
    }

    case 'petition': {
      // Petition gate needs a voter gate for signature validation
      // If not provided, create a temporary one to pass to proposal gate
      const voterGateForPetition = options.voterGate ?? createVoterGate(options);

      // Create proposal gate
      const proposalGate = createProposalGate({
        config: {
          petitionProposalGate: config.petitionProposalGate,
          petitionProposalDelegates: config.petitionProposalDelegates,
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

    case 'freebird': {
      // Use gate-specific issuer URL if provided, otherwise use default adapter
      const voterFreebirdAdapter = config.voterGateFreebirdIssuerUrl
        ? new HttpFreebirdAdapter({
            issuerUrl: config.voterGateFreebirdIssuerUrl,
            verifierUrl: options.freebirdVerifierUrl,
          })
        : freebird;
      return new FreebirdVoterGate(voterFreebirdAdapter);
    }

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
export { OpenBallotGate } from './ballot/open.js';
export { OwnerBallotGate } from './ballot/owner.js';
export { DelegationBallotGate } from './ballot/delegation.js';
export { FreebirdBallotGate } from './ballot/freebird.js';
export { PetitionBallotGate } from './ballot/petition.js';

// Re-export voter gates
export { OpenVoterGate } from './voter/open.js';
export { FreebirdVoterGate } from './voter/freebird.js';
export { AllowlistVoterGate } from './voter/allowlist.js';

// Re-export proposal gates
export { createProposalGate } from './proposal/index.js';
export { VotersProposalGate } from './proposal/voters.js';
export { DelegationProposalGate } from './proposal/delegation.js';
export type { ProposalGate, ProposalGateType } from './proposal/types.js';

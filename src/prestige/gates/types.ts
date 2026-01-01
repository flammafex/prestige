/**
 * Gate System Types
 *
 * Gates control who can create ballots and who can vote on an instance.
 * "No one owns the mechanism, but someone owns each instance."
 */

import type { CreateBallotRequest, PublicKey } from '../types.js';

/**
 * Result from a gate check
 */
export interface GateResult {
  allowed: boolean;
  reason?: string;
  /** For petition gate: current signature count */
  progress?: { current: number; required: number };
}

/**
 * Human-readable requirements for UI
 */
export interface GateRequirements {
  type: string;
  description: string;
  /** What the user needs to do/have */
  requirements: string[];
}

/**
 * Ballot Gate Interface
 * Controls who can create ballots on this instance
 */
export interface BallotGate {
  readonly type: BallotGateType;

  /**
   * Check if a public key can create a ballot
   */
  canCreate(publicKey: string, request?: CreateBallotRequest): Promise<GateResult>;

  /**
   * Get human-readable requirements for UI
   */
  getRequirements(): GateRequirements;
}

/**
 * Voter Gate Interface
 * Controls who can vote on this instance (baseline eligibility)
 */
export interface VoterGate {
  readonly type: VoterGateType;

  /**
   * Check if a public key can vote on this instance at all
   * This is the instance-level check before ballot-specific eligibility
   */
  canVote(publicKey: string): Promise<GateResult>;

  /**
   * Get human-readable requirements for UI
   */
  getRequirements(): GateRequirements;
}

/**
 * Petition signature for petition gate
 */
export interface PetitionSignature {
  ballotId: string;
  publicKey: PublicKey;
  signature: string;
  timestamp: number;
}

/**
 * Petition status for a ballot
 */
export interface PetitionStatus {
  ballotId: string;
  required: number;
  current: number;
  signatures: PetitionSignature[];
  activated: boolean;
  activatedAt?: number;
}

/**
 * Ballot gate types
 */
export type BallotGateType = 'open' | 'owner' | 'delegation' | 'freebird' | 'petition';

/**
 * Voter gate types
 */
export type VoterGateType = 'open' | 'freebird' | 'allowlist';

/**
 * Proposal gate types (nested inside petition ballot gate)
 * - voters: Anyone passing instance voter gate
 * - delegation: Specific keys only
 */
export type ProposalGateType = 'voters' | 'delegation';

/**
 * Gate configuration for Prestige
 */
export interface GateConfig {
  // Ballot Gate configuration
  ballotGate: BallotGateType;
  ballotGateAdminKey?: string;
  ballotGateDelegates?: string[];
  ballotGateFreebirdIssuer?: string;
  /** Separate Freebird issuer URL for ballot gate (invitation mode) */
  ballotGateFreebirdIssuerUrl?: string;
  ballotGatePetitionThreshold?: number;

  // Voter Gate configuration
  voterGate: VoterGateType;
  voterGateAllowlist?: string[];
  /** Separate Freebird issuer URL for voter gate (webauthn/pow mode) */
  voterGateFreebirdIssuerUrl?: string;

  // Proposal Gate configuration (when ballotGate=petition)
  petitionProposalGate?: ProposalGateType;

  // For delegation proposal gate
  petitionProposalDelegates?: string[];
}

/**
 * Gate-specific error class
 */
export class GateError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 403
  ) {
    super(message);
    this.name = 'GateError';
  }
}

export const GateErrorCodes = {
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  NOT_IN_TRUST_NETWORK: 'NOT_IN_TRUST_NETWORK',
  INSUFFICIENT_TOKENS: 'INSUFFICIENT_TOKENS',
  NOT_IN_ALLOWLIST: 'NOT_IN_ALLOWLIST',
  PETITION_NOT_MET: 'PETITION_NOT_MET',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
} as const;

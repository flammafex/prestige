/**
 * Proposal Gate Types
 * Controls who can open petitions (propose ballots for signature collection)
 */

import type { GateResult, GateRequirements } from '../types.js';

/**
 * Proposal Gate Interface
 * Controls who can open petitions on an instance using the petition ballot gate
 */
export interface ProposalGate {
  readonly type: ProposalGateType;

  /**
   * Check if a public key can open a petition (propose a ballot)
   */
  canPropose(publicKey: string): Promise<GateResult>;

  /**
   * Get human-readable requirements for UI
   */
  getRequirements(): GateRequirements;
}

/**
 * Proposal gate types
 * - voters: Anyone passing instance voter gate
 * - delegation: Specific keys only
 */
export type ProposalGateType = 'voters' | 'delegation';

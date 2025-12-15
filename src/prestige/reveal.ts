/**
 * Reveal phase logic
 * Handles reveal submission and verification
 */

import { Crypto } from './crypto.js';
import type {
  Reveal,
  Vote,
  Ballot,
  RevealVerification,
  PrestigeStore,
  SubmitRevealRequest,
} from './types.js';
import { ErrorCodes } from './types.js';
import type { BallotManager } from './ballot.js';

export class RevealManager {
  constructor(
    private store: PrestigeStore,
    private ballotManager: BallotManager
  ) {}

  /**
   * Submit a reveal for a vote
   */
  async submitReveal(request: SubmitRevealRequest): Promise<Reveal> {
    // 1. Get and validate ballot
    const ballot = await this.ballotManager.getBallot(request.ballotId);
    if (!ballot) {
      throw new RevealError('Ballot not found', ErrorCodes.BALLOT_NOT_FOUND, 404);
    }

    // 2. Check ballot is in reveal phase
    const now = Date.now();
    if (!this.ballotManager.isAcceptingReveals(ballot, now)) {
      if (this.ballotManager.isAcceptingVotes(ballot, now)) {
        throw new RevealError(
          'Ballot is still in voting phase. Wait until the deadline to reveal.',
          ErrorCodes.BALLOT_CLOSED
        );
      }
      throw new RevealError(
        'Reveal phase has ended',
        ErrorCodes.BALLOT_NOT_REVEALING
      );
    }

    // 3. Validate nullifier format
    if (!Crypto.isValidHash(request.nullifier)) {
      throw new RevealError('Invalid nullifier format', ErrorCodes.INVALID_REVEAL);
    }

    // 4. Find the original vote
    const votes = await this.store.getVotesByBallot(request.ballotId);
    const originalVote = votes.find(v => v.nullifier === request.nullifier);
    if (!originalVote) {
      throw new RevealError(
        'No vote found with this nullifier',
        ErrorCodes.INVALID_REVEAL
      );
    }

    // 5. Validate choice is one of the ballot options
    if (!ballot.choices.includes(request.choice)) {
      throw new RevealError(
        `Invalid choice. Must be one of: ${ballot.choices.join(', ')}`,
        ErrorCodes.INVALID_REVEAL
      );
    }

    // 6. Verify commitment matches: H(choice || salt) === commitment
    const computedCommitment = Crypto.generateCommitment(request.choice, request.salt);
    if (!Crypto.constantTimeEqual(computedCommitment, originalVote.commitment)) {
      throw new RevealError(
        'Reveal does not match original commitment',
        ErrorCodes.INVALID_REVEAL
      );
    }

    // 7. Check for duplicate reveal
    const existingReveal = await this.store.getRevealByNullifier(
      request.ballotId,
      request.nullifier
    );
    if (existingReveal) {
      throw new RevealError(
        'A reveal has already been submitted for this vote',
        ErrorCodes.INVALID_REVEAL
      );
    }

    // 8. Store the reveal
    const reveal: Reveal = {
      ballotId: request.ballotId,
      nullifier: request.nullifier,
      choice: request.choice,
      salt: request.salt,
    };

    await this.store.saveReveal(reveal);

    return reveal;
  }

  /**
   * Get all reveals for a ballot
   */
  async getReveals(ballotId: string): Promise<Reveal[]> {
    return this.store.getRevealsByBallot(ballotId);
  }

  /**
   * Verify a reveal against its original vote commitment
   */
  async verifyReveal(reveal: Reveal, ballotId: string): Promise<RevealVerification> {
    // Get ballot to validate choice
    const ballot = await this.ballotManager.getBallot(ballotId);
    if (!ballot) {
      return {
        nullifier: reveal.nullifier,
        choice: reveal.choice,
        valid: false,
        reason: 'Ballot not found',
      };
    }

    // Validate choice is one of the ballot options
    if (!ballot.choices.includes(reveal.choice)) {
      return {
        nullifier: reveal.nullifier,
        choice: reveal.choice,
        valid: false,
        reason: 'Choice is not a valid ballot option',
      };
    }

    // Find the original vote
    const votes = await this.store.getVotesByBallot(ballotId);
    const originalVote = votes.find(v => v.nullifier === reveal.nullifier);
    if (!originalVote) {
      return {
        nullifier: reveal.nullifier,
        choice: reveal.choice,
        valid: false,
        reason: 'No vote found with this nullifier',
      };
    }

    // Verify commitment: H(choice || salt) === commitment
    const computedCommitment = Crypto.generateCommitment(reveal.choice, reveal.salt);
    const valid = Crypto.constantTimeEqual(computedCommitment, originalVote.commitment);

    return {
      nullifier: reveal.nullifier,
      choice: reveal.choice,
      valid,
      reason: valid ? undefined : 'Reveal does not match original commitment',
    };
  }

  /**
   * Verify all reveals for a ballot
   */
  async verifyAllReveals(ballotId: string): Promise<RevealVerification[]> {
    const reveals = await this.store.getRevealsByBallot(ballotId);
    const verifications: RevealVerification[] = [];

    for (const reveal of reveals) {
      const verification = await this.verifyReveal(reveal, ballotId);
      verifications.push(verification);
    }

    return verifications;
  }

  /**
   * Get reveal statistics for a ballot
   */
  async getRevealStats(ballotId: string): Promise<RevealStats> {
    const votes = await this.store.getVotesByBallot(ballotId);
    const reveals = await this.store.getRevealsByBallot(ballotId);
    const verifications = await this.verifyAllReveals(ballotId);

    const validReveals = verifications.filter(v => v.valid).length;
    const invalidReveals = verifications.filter(v => !v.valid).length;

    return {
      totalVotes: votes.length,
      totalReveals: reveals.length,
      validReveals,
      invalidReveals,
      pendingReveals: votes.length - reveals.length,
      revealRate: votes.length > 0 ? reveals.length / votes.length : 0,
    };
  }
}

/**
 * Reveal statistics
 */
export interface RevealStats {
  totalVotes: number;
  totalReveals: number;
  validReveals: number;
  invalidReveals: number;
  pendingReveals: number;
  revealRate: number;
}

/**
 * Reveal-specific error class
 */
class RevealError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'RevealError';
  }
}

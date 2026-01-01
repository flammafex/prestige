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
  VoteData,
  VoteTypeConfig,
} from './types.js';
import { ErrorCodes } from './types.js';
import type { BallotManager } from './ballot.js';
import {
  type PrivacyConfig,
  DEFAULT_PRIVACY_CONFIG,
  privacyDelay,
} from './privacy.js';

export class RevealManager {
  constructor(
    private store: PrestigeStore,
    private ballotManager: BallotManager,
    private privacyConfig: PrivacyConfig = DEFAULT_PRIVACY_CONFIG
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

    // 5. Determine vote type and validate accordingly
    const voteType = ballot.voteType?.type ?? 'single';

    // Get or construct vote data
    const voteData: VoteData = request.voteData ?? { type: 'single', choice: request.choice };

    // 6. Validate vote data against ballot configuration
    this.validateVoteData(voteData, ballot);

    // 7. Verify commitment matches
    let computedCommitment: string;
    if (voteType === 'single' && voteData.type === 'single') {
      // Backwards compatible: use simple commitment for single choice
      computedCommitment = Crypto.generateCommitment(request.choice, request.salt);
    } else {
      // Use extended vote commitment for other types
      computedCommitment = Crypto.generateVoteCommitment(voteData, request.salt);
    }

    if (!Crypto.constantTimeEqual(computedCommitment, originalVote.commitment)) {
      throw new RevealError(
        'Reveal does not match original commitment',
        ErrorCodes.INVALID_REVEAL
      );
    }

    // 8. Check for duplicate reveal
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

    // 9. Store the reveal
    const reveal: Reveal = {
      ballotId: request.ballotId,
      nullifier: request.nullifier,
      choice: request.choice,
      salt: request.salt,
      voteData: voteData.type !== 'single' ? voteData : undefined,
    };

    await this.store.saveReveal(reveal);

    // Apply privacy delay to mask processing time
    await privacyDelay(this.privacyConfig);

    return reveal;
  }

  /**
   * Validate vote data against ballot configuration
   */
  private validateVoteData(voteData: VoteData, ballot: Ballot): void {
    const voteType = ballot.voteType?.type ?? 'single';

    if (voteData.type !== voteType) {
      throw new RevealError(
        `Vote type mismatch. Expected ${voteType}, got ${voteData.type}`,
        ErrorCodes.INVALID_REVEAL
      );
    }

    switch (voteData.type) {
      case 'single':
        if (!ballot.choices.includes(voteData.choice)) {
          throw new RevealError(
            `Invalid choice. Must be one of: ${ballot.choices.join(', ')}`,
            ErrorCodes.INVALID_REVEAL
          );
        }
        break;

      case 'approval':
        if (voteData.choices.length === 0) {
          throw new RevealError('Approval voting requires at least one choice', ErrorCodes.INVALID_REVEAL);
        }
        for (const choice of voteData.choices) {
          if (!ballot.choices.includes(choice)) {
            throw new RevealError(
              `Invalid choice "${choice}". Must be one of: ${ballot.choices.join(', ')}`,
              ErrorCodes.INVALID_REVEAL
            );
          }
        }
        // Check for duplicates
        if (new Set(voteData.choices).size !== voteData.choices.length) {
          throw new RevealError('Duplicate choices not allowed in approval voting', ErrorCodes.INVALID_REVEAL);
        }
        break;

      case 'ranked':
        const minRankings = ballot.voteType?.minRankings ?? 1;
        const maxRankings = ballot.voteType?.maxRankings ?? ballot.choices.length;

        if (voteData.rankings.length < minRankings) {
          throw new RevealError(
            `Ranked choice requires at least ${minRankings} ranking(s)`,
            ErrorCodes.INVALID_REVEAL
          );
        }
        if (voteData.rankings.length > maxRankings) {
          throw new RevealError(
            `Ranked choice allows at most ${maxRankings} ranking(s)`,
            ErrorCodes.INVALID_REVEAL
          );
        }
        for (const choice of voteData.rankings) {
          if (!ballot.choices.includes(choice)) {
            throw new RevealError(
              `Invalid choice "${choice}". Must be one of: ${ballot.choices.join(', ')}`,
              ErrorCodes.INVALID_REVEAL
            );
          }
        }
        // Check for duplicates
        if (new Set(voteData.rankings).size !== voteData.rankings.length) {
          throw new RevealError('Duplicate rankings not allowed', ErrorCodes.INVALID_REVEAL);
        }
        break;

      case 'score':
        const minScore = ballot.voteType?.minScore ?? 0;
        const maxScore = ballot.voteType?.maxScore ?? 10;

        for (const [choice, score] of Object.entries(voteData.scores)) {
          if (!ballot.choices.includes(choice)) {
            throw new RevealError(
              `Invalid choice "${choice}". Must be one of: ${ballot.choices.join(', ')}`,
              ErrorCodes.INVALID_REVEAL
            );
          }
          if (score < minScore || score > maxScore) {
            throw new RevealError(
              `Score for "${choice}" must be between ${minScore} and ${maxScore}`,
              ErrorCodes.INVALID_REVEAL
            );
          }
          if (!Number.isInteger(score)) {
            throw new RevealError(`Scores must be integers`, ErrorCodes.INVALID_REVEAL);
          }
        }
        break;
    }
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

    // Determine vote type and verify accordingly
    const voteType = ballot.voteType?.type ?? 'single';

    // Construct vote data for verification
    const voteData: VoteData = reveal.voteData ?? { type: 'single', choice: reveal.choice };

    // Verify commitment based on vote type
    let computedCommitment: string;
    if (voteType === 'single' && voteData.type === 'single') {
      // Backwards compatible: use simple commitment for single choice
      computedCommitment = Crypto.generateCommitment(reveal.choice, reveal.salt);
    } else {
      // Use extended vote commitment for other types
      computedCommitment = Crypto.generateVoteCommitment(voteData, reveal.salt);
    }

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

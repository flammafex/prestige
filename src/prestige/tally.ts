/**
 * Result computation and tally logic
 */

import { Crypto } from './crypto.js';
import type {
  Result,
  Ballot,
  Reveal,
  RevealVerification,
  WitnessAttestation,
  PrestigeStore,
  VoteType,
  RankedChoiceRound,
  VoteData,
  ApprovalVoteData,
  RankedVoteData,
  ScoreVoteData,
} from './types.js';
import { ErrorCodes } from './types.js';
import type { BallotManager } from './ballot.js';
import type { RevealManager } from './reveal.js';
import type { WitnessAdapter } from './adapters/witness.js';

export class TallyManager {
  constructor(
    private store: PrestigeStore,
    private ballotManager: BallotManager,
    private revealManager: RevealManager,
    private witness: WitnessAdapter
  ) {}

  /**
   * Compute and finalize results for a ballot
   */
  async computeResult(ballotId: string): Promise<Result> {
    // Check if result already exists
    const existingResult = await this.store.getResult(ballotId);
    if (existingResult) {
      return existingResult;
    }

    // Get ballot
    const ballot = await this.ballotManager.getBallot(ballotId);
    if (!ballot) {
      throw new TallyError('Ballot not found', ErrorCodes.BALLOT_NOT_FOUND, 404);
    }

    // Check ballot is finalized (past reveal deadline)
    const now = Date.now();
    if (!this.ballotManager.isFinalized(ballot, now)) {
      throw new TallyError(
        'Ballot is not yet finalized. Wait until reveal phase ends.',
        ErrorCodes.BALLOT_CLOSED
      );
    }

    // Get all votes and reveals
    const votes = await this.store.getVotesByBallot(ballotId);
    const reveals = await this.store.getRevealsByBallot(ballotId);
    const verifications = await this.revealManager.verifyAllReveals(ballotId);

    // Get valid reveals
    const validVerifications = verifications.filter(v => v.valid);
    const validReveals = validVerifications.length;

    // Compute tally based on vote type
    const voteType: VoteType = ballot.voteType?.type ?? 'single';
    const tallyResult = this.computeTallyByType(ballot, reveals, validVerifications, voteType);

    // Get witness attestation for the result
    const resultHash = Crypto.hash(
      ballotId,
      Crypto.canonicalJson(tallyResult.tally),
      votes.length.toString(),
      validReveals.toString()
    );
    const attestation = await this.witness.attest(resultHash);

    const result: Result = {
      ballotId,
      tally: tallyResult.tally,
      totalVotes: votes.length,
      totalReveals: verifications.length,
      validReveals,
      attestation,
      finalized: now,
      voteType,
      rankedChoiceRounds: tallyResult.rankedChoiceRounds,
      averageScores: tallyResult.averageScores,
    };

    // Store the result
    await this.store.saveResult(result);

    // Update ballot status
    await this.store.updateBallotStatus(ballotId, 'finalized');

    return result;
  }

  /**
   * Compute tally based on vote type
   */
  private computeTallyByType(
    ballot: Ballot,
    reveals: Reveal[],
    validVerifications: RevealVerification[],
    voteType: VoteType
  ): {
    tally: Record<string, number>;
    rankedChoiceRounds?: RankedChoiceRound[];
    averageScores?: Record<string, number>;
  } {
    switch (voteType) {
      case 'single':
        return { tally: this.computeSingleChoiceTally(ballot, validVerifications) };

      case 'approval':
        return { tally: this.computeApprovalTally(ballot, reveals, validVerifications) };

      case 'ranked':
        return this.computeRankedChoiceTally(ballot, reveals, validVerifications);

      case 'score':
        return this.computeScoreTally(ballot, reveals, validVerifications);

      default:
        return { tally: this.computeSingleChoiceTally(ballot, validVerifications) };
    }
  }

  /**
   * Compute single choice tally (original method)
   */
  private computeSingleChoiceTally(
    ballot: Ballot,
    validVerifications: RevealVerification[]
  ): Record<string, number> {
    const tally: Record<string, number> = {};
    for (const choice of ballot.choices) {
      tally[choice] = 0;
    }

    for (const verification of validVerifications) {
      tally[verification.choice] = (tally[verification.choice] || 0) + 1;
    }

    return tally;
  }

  /**
   * Compute approval voting tally
   * Each voter can approve multiple choices, each approved choice gets +1
   */
  private computeApprovalTally(
    ballot: Ballot,
    reveals: Reveal[],
    validVerifications: RevealVerification[]
  ): Record<string, number> {
    const tally: Record<string, number> = {};
    for (const choice of ballot.choices) {
      tally[choice] = 0;
    }

    // Create a set of valid nullifiers
    const validNullifiers = new Set(validVerifications.map(v => v.nullifier));

    for (const reveal of reveals) {
      if (!validNullifiers.has(reveal.nullifier)) continue;

      // Get the approved choices from voteData
      const voteData = reveal.voteData as ApprovalVoteData | undefined;
      const approvedChoices = voteData?.choices ?? [reveal.choice];

      for (const choice of approvedChoices) {
        if (ballot.choices.includes(choice)) {
          tally[choice] = (tally[choice] || 0) + 1;
        }
      }
    }

    return tally;
  }

  /**
   * Compute ranked choice voting (Instant-Runoff Voting)
   * Returns round-by-round elimination results
   */
  private computeRankedChoiceTally(
    ballot: Ballot,
    reveals: Reveal[],
    validVerifications: RevealVerification[]
  ): {
    tally: Record<string, number>;
    rankedChoiceRounds: RankedChoiceRound[];
  } {
    // Create a set of valid nullifiers
    const validNullifiers = new Set(validVerifications.map(v => v.nullifier));

    // Get all valid ranked ballots
    const validBallots: string[][] = [];
    for (const reveal of reveals) {
      if (!validNullifiers.has(reveal.nullifier)) continue;

      const voteData = reveal.voteData as RankedVoteData | undefined;
      const rankings = voteData?.rankings ?? [reveal.choice];
      validBallots.push(rankings);
    }

    // Run instant-runoff voting
    const rounds: RankedChoiceRound[] = [];
    let remainingChoices = [...ballot.choices];
    let currentBallots = validBallots.map(b => [...b]); // Copy ballots

    let roundNum = 1;
    while (remainingChoices.length > 1) {
      // Count first-choice votes
      const votes: Record<string, number> = {};
      for (const choice of remainingChoices) {
        votes[choice] = 0;
      }

      for (const ballot of currentBallots) {
        // Find first valid choice in this ballot
        const firstChoice = ballot.find(c => remainingChoices.includes(c));
        if (firstChoice) {
          votes[firstChoice]++;
        }
      }

      // Check for majority winner
      const totalVotes = currentBallots.length;
      const majorityNeeded = Math.floor(totalVotes / 2) + 1;
      const maxVotes = Math.max(...Object.values(votes));

      if (maxVotes >= majorityNeeded) {
        // We have a winner
        rounds.push({ round: roundNum, votes });
        break;
      }

      // Find choice(s) with fewest votes to eliminate
      const minVotes = Math.min(...Object.values(votes).filter(v => v >= 0));
      const toEliminate = Object.entries(votes)
        .filter(([_, count]) => count === minVotes)
        .map(([choice]) => choice);

      // In case of tie for last place, eliminate all tied choices
      // (Alternative: could use random tiebreaker)
      const eliminated = toEliminate[0]; // Eliminate first alphabetically for determinism

      rounds.push({
        round: roundNum,
        votes,
        eliminated,
      });

      // Remove eliminated choice from remaining
      remainingChoices = remainingChoices.filter(c => c !== eliminated);

      // Remove eliminated choice from all ballots
      currentBallots = currentBallots.map(ballot =>
        ballot.filter(c => c !== eliminated)
      );

      roundNum++;

      // Safety check to prevent infinite loops
      if (roundNum > ballot.choices.length + 1) break;
    }

    // Final tally is the last round's votes
    const finalTally: Record<string, number> = {};
    for (const choice of ballot.choices) {
      finalTally[choice] = 0;
    }

    if (rounds.length > 0) {
      const lastRound = rounds[rounds.length - 1];
      for (const [choice, count] of Object.entries(lastRound.votes)) {
        finalTally[choice] = count;
      }
    }

    return {
      tally: finalTally,
      rankedChoiceRounds: rounds,
    };
  }

  /**
   * Compute score voting tally
   * Each voter assigns a score to each choice, scores are summed
   */
  private computeScoreTally(
    ballot: Ballot,
    reveals: Reveal[],
    validVerifications: RevealVerification[]
  ): {
    tally: Record<string, number>;
    averageScores: Record<string, number>;
  } {
    const totalScores: Record<string, number> = {};
    const scoreCounts: Record<string, number> = {};

    for (const choice of ballot.choices) {
      totalScores[choice] = 0;
      scoreCounts[choice] = 0;
    }

    // Create a set of valid nullifiers
    const validNullifiers = new Set(validVerifications.map(v => v.nullifier));

    for (const reveal of reveals) {
      if (!validNullifiers.has(reveal.nullifier)) continue;

      const voteData = reveal.voteData as ScoreVoteData | undefined;
      if (!voteData?.scores) continue;

      for (const [choice, score] of Object.entries(voteData.scores)) {
        if (ballot.choices.includes(choice)) {
          totalScores[choice] = (totalScores[choice] || 0) + score;
          scoreCounts[choice] = (scoreCounts[choice] || 0) + 1;
        }
      }
    }

    // Calculate average scores
    const averageScores: Record<string, number> = {};
    for (const choice of ballot.choices) {
      averageScores[choice] = scoreCounts[choice] > 0
        ? totalScores[choice] / scoreCounts[choice]
        : 0;
    }

    return {
      tally: totalScores,
      averageScores,
    };
  }

  /**
   * Get result for a ballot
   * If ballot is finalized but result not computed, compute it
   */
  async getResult(ballotId: string): Promise<Result | null> {
    // Check for existing result
    const existingResult = await this.store.getResult(ballotId);
    if (existingResult) {
      return existingResult;
    }

    // Check if ballot is finalized
    const ballot = await this.ballotManager.getBallot(ballotId);
    if (!ballot) {
      return null;
    }

    if (this.ballotManager.isFinalized(ballot)) {
      // Compute result on demand
      return this.computeResult(ballotId);
    }

    return null;
  }

  /**
   * Get live tally (during reveal phase, before finalization)
   * This is a preview and not attested
   */
  async getLiveTally(ballotId: string): Promise<LiveTally> {
    const ballot = await this.ballotManager.getBallot(ballotId);
    if (!ballot) {
      throw new TallyError('Ballot not found', ErrorCodes.BALLOT_NOT_FOUND, 404);
    }

    const votes = await this.store.getVotesByBallot(ballotId);
    const reveals = await this.store.getRevealsByBallot(ballotId);
    const verifications = await this.revealManager.verifyAllReveals(ballotId);

    // Get valid verifications
    const validVerifications = verifications.filter(v => v.valid);
    const validReveals = validVerifications.length;

    // Compute tally based on vote type
    const voteType: VoteType = ballot.voteType?.type ?? 'single';
    const tallyResult = this.computeTallyByType(ballot, reveals, validVerifications, voteType);

    return {
      ballotId,
      tally: tallyResult.tally,
      totalVotes: votes.length,
      totalReveals: verifications.length,
      validReveals,
      isFinalized: this.ballotManager.isFinalized(ballot),
      status: this.ballotManager.computeStatus(ballot),
      voteType,
      rankedChoiceRounds: tallyResult.rankedChoiceRounds,
      averageScores: tallyResult.averageScores,
    };
  }

  /**
   * Get detailed verification report
   */
  async getVerificationReport(ballotId: string): Promise<VerificationReport> {
    const ballot = await this.ballotManager.getBallot(ballotId);
    if (!ballot) {
      throw new TallyError('Ballot not found', ErrorCodes.BALLOT_NOT_FOUND, 404);
    }

    const votes = await this.store.getVotesByBallot(ballotId);
    const reveals = await this.store.getRevealsByBallot(ballotId);
    const verifications = await this.revealManager.verifyAllReveals(ballotId);
    const result = await this.store.getResult(ballotId);

    const validVerifications = verifications.filter(v => v.valid);
    const invalidVerifications = verifications.filter(v => !v.valid);

    return {
      ballotId,
      ballot: {
        question: ballot.question,
        choices: ballot.choices,
        created: ballot.created,
        deadline: ballot.deadline,
        revealDeadline: ballot.revealDeadline,
        status: this.ballotManager.computeStatus(ballot),
      },
      votes: {
        total: votes.length,
        nullifiers: votes.map(v => v.nullifier),
      },
      reveals: {
        total: reveals.length,
        valid: validVerifications.length,
        invalid: invalidVerifications.length,
        pending: votes.length - reveals.length,
        validDetails: validVerifications,
        invalidDetails: invalidVerifications,
      },
      result: result ? {
        tally: result.tally,
        attestation: result.attestation,
        finalized: result.finalized,
      } : null,
      integrity: {
        allVotesAttested: votes.every(v => (v.attestation?.signatures?.length ?? 0) > 0),
        allRevealsVerified: invalidVerifications.length === 0,
        resultAttested: (result?.attestation?.signatures?.length ?? 0) > 0,
      },
    };
  }
}

/**
 * Live tally (not finalized)
 */
export interface LiveTally {
  ballotId: string;
  tally: Record<string, number>;
  totalVotes: number;
  totalReveals: number;
  validReveals: number;
  isFinalized: boolean;
  status: string;
  // Extended results for different voting methods
  voteType?: VoteType;
  rankedChoiceRounds?: RankedChoiceRound[];
  averageScores?: Record<string, number>;
}

/**
 * Verification report
 */
export interface VerificationReport {
  ballotId: string;
  ballot: {
    question: string;
    choices: string[];
    created: number;
    deadline: number;
    revealDeadline: number;
    status: string;
  };
  votes: {
    total: number;
    nullifiers: string[];
  };
  reveals: {
    total: number;
    valid: number;
    invalid: number;
    pending: number;
    validDetails: RevealVerification[];
    invalidDetails: RevealVerification[];
  };
  result: {
    tally: Record<string, number>;
    attestation: WitnessAttestation;
    finalized: number;
  } | null;
  integrity: {
    allVotesAttested: boolean;
    allRevealsVerified: boolean;
    resultAttested: boolean;
  };
}

/**
 * Tally-specific error class
 */
class TallyError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'TallyError';
  }
}

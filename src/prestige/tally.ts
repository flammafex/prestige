/**
 * Result computation and tally logic
 */

import { Crypto } from './crypto.js';
import type {
  Result,
  Ballot,
  RevealVerification,
  WitnessAttestation,
  PrestigeStore,
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
    const verifications = await this.revealManager.verifyAllReveals(ballotId);

    // Compute tally from valid reveals only
    const tally: Record<string, number> = {};
    for (const choice of ballot.choices) {
      tally[choice] = 0;
    }

    let validReveals = 0;
    for (const verification of verifications) {
      if (verification.valid) {
        tally[verification.choice] = (tally[verification.choice] || 0) + 1;
        validReveals++;
      }
    }

    // Get witness attestation for the result
    const resultHash = Crypto.hash(
      ballotId,
      Crypto.canonicalJson(tally),
      votes.length.toString(),
      validReveals.toString()
    );
    const attestation = await this.witness.attest(resultHash, now);

    const result: Result = {
      ballotId,
      tally,
      totalVotes: votes.length,
      totalReveals: verifications.length,
      validReveals,
      attestation,
      finalized: now,
    };

    // Store the result
    await this.store.saveResult(result);

    // Update ballot status
    await this.store.updateBallotStatus(ballotId, 'finalized');

    return result;
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
    const verifications = await this.revealManager.verifyAllReveals(ballotId);

    // Compute tally from valid reveals only
    const tally: Record<string, number> = {};
    for (const choice of ballot.choices) {
      tally[choice] = 0;
    }

    let validReveals = 0;
    for (const verification of verifications) {
      if (verification.valid) {
        tally[verification.choice] = (tally[verification.choice] || 0) + 1;
        validReveals++;
      }
    }

    return {
      ballotId,
      tally,
      totalVotes: votes.length,
      totalReveals: verifications.length,
      validReveals,
      isFinalized: this.ballotManager.isFinalized(ballot),
      status: this.ballotManager.computeStatus(ballot),
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
        allVotesAttested: votes.every(v => v.attestation?.signatures?.length > 0),
        allRevealsVerified: invalidVerifications.length === 0,
        resultAttested: result?.attestation?.signatures?.length > 0,
      },
    };
  }
}

/**
 * Live tally (not finalized)
 */
interface LiveTally {
  ballotId: string;
  tally: Record<string, number>;
  totalVotes: number;
  totalReveals: number;
  validReveals: number;
  isFinalized: boolean;
  status: string;
}

/**
 * Verification report
 */
interface VerificationReport {
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

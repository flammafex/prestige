/**
 * Vote casting logic
 * Implements commit-reveal scheme with nullifier-based double-vote prevention
 *
 * Eligibility hierarchy:
 * 1. Instance Voter Gate - Can this person vote HERE at all?
 * 2. Ballot Eligibility - Can this person vote on THIS question? (can restrict, not expand)
 * 3. Freebird Token Issue - Anonymous proof of eligibility
 */

import { Crypto } from './crypto.js';
import type {
  Vote,
  Ballot,
  FreebirdToken,
  WitnessAttestation,
  PrestigeStore,
  CastVoteRequest,
  PrestigeError,
  EligibilityConfig,
  PrestigeConfig,
} from './types.js';
import { ErrorCodes } from './types.js';
import type { FreebirdAdapter } from './adapters/freebird.js';
import type { WitnessAdapter } from './adapters/witness.js';
import type { BallotManager } from './ballot.js';
import type { VoterGate, GateResult } from './gates/types.js';
import {
  type PrivacyConfig,
  DEFAULT_PRIVACY_CONFIG,
  privacyDelay,
  withNormalizedTiming,
  RequestBatcher,
  shuffleArray,
} from './privacy.js';

/**
 * Request for batched eligibility processing
 */
interface EligibilityRequest {
  publicKey: string;
  ballotId: string;
  index: number;
}

/**
 * Result from eligibility check
 */
interface EligibilityResult {
  eligible: boolean;
  token?: FreebirdToken;
  reason?: string;
}

export interface VoteManagerConfig {
  // Reserved for future configuration
}

export class VoteManager {
  private voterGate: VoterGate | null = null;
  private config: VoteManagerConfig;
  private privacyConfig: PrivacyConfig;
  private eligibilityBatcher?: RequestBatcher<EligibilityRequest, EligibilityResult>;

  constructor(
    private store: PrestigeStore,
    private ballotManager: BallotManager,
    private freebird: FreebirdAdapter,
    private witness: WitnessAdapter,
    config?: VoteManagerConfig,
    privacyConfig?: PrivacyConfig
  ) {
    this.config = config ?? {};
    this.privacyConfig = privacyConfig ?? DEFAULT_PRIVACY_CONFIG;

    // Initialize eligibility batcher if batching is enabled
    if (this.privacyConfig.enabled && this.privacyConfig.batchingEnabled) {
      this.eligibilityBatcher = new RequestBatcher<EligibilityRequest, EligibilityResult>(
        async (requests) => this.processBatchedEligibility(requests),
        this.privacyConfig.batchIntervalMs
      );
    }
  }

  /**
   * Set the instance-level voter gate
   */
  setVoterGate(gate: VoterGate): void {
    this.voterGate = gate;
  }

  /**
   * Get the current voter gate
   */
  getVoterGate(): VoterGate | null {
    return this.voterGate;
  }

  /**
   * Cast a vote (commit phase)
   *
   * This receives a pre-computed commitment and nullifier from the client,
   * verifies eligibility via Freebird token, and stores the vote.
   */
  async castVote(request: CastVoteRequest): Promise<Vote> {
    // 1. Get and validate ballot
    const ballot = await this.ballotManager.getBallot(request.ballotId);
    if (!ballot) {
      throw new VoteError('Ballot not found', ErrorCodes.BALLOT_NOT_FOUND, 404);
    }

    // 2. Check if ballot is in petition status (not yet activated)
    if (this.ballotManager.isPetition(ballot)) {
      throw new VoteError(
        'Ballot is still collecting petition signatures and not yet accepting votes',
        ErrorCodes.BALLOT_IN_PETITION
      );
    }

    // 3. Check ballot is still accepting votes
    const now = Date.now();
    if (!this.ballotManager.isAcceptingVotes(ballot, now)) {
      throw new VoteError('Ballot is no longer accepting votes', ErrorCodes.BALLOT_CLOSED);
    }

    // 4. Validate commitment format
    if (!Crypto.isValidHash(request.commitment)) {
      throw new VoteError('Invalid commitment format', ErrorCodes.INVALID_COMMITMENT);
    }

    // 5. Validate nullifier format
    if (!Crypto.isValidHash(request.nullifier)) {
      throw new VoteError('Invalid nullifier format', ErrorCodes.INVALID_COMMITMENT);
    }

    // 6. Check for double voting (nullifier already used)
    const hasVoted = await this.store.hasNullifier(request.ballotId, request.nullifier);
    if (hasVoted) {
      throw new VoteError('You have already voted on this ballot', ErrorCodes.DOUBLE_VOTE);
    }

    // 7. Verify Freebird token (eligibility check)
    const tokenValid = await this.freebird.verify(request.proof);
    if (!tokenValid) {
      throw new VoteError('Invalid eligibility proof', ErrorCodes.INVALID_PROOF);
    }

    // 8. Get witness attestation for the vote
    const voteHash = Crypto.hash(
      request.ballotId,
      request.nullifier,
      request.commitment
    );
    const attestation = await this.witness.attest(voteHash);

    // 9. Verify attestation timestamp is within ballot window
    // Attestation timestamp is in Unix seconds, ballot deadline is in milliseconds
    const attestationMs = attestation.timestamp * 1000;
    if (attestationMs > ballot.deadline) {
      throw new VoteError('Vote attestation is after deadline', ErrorCodes.TOO_LATE);
    }

    // 10. Create and store the vote
    const vote: Vote = {
      ballotId: request.ballotId,
      nullifier: request.nullifier,
      commitment: request.commitment,
      proof: request.proof,
      attestation,
    };

    await this.store.saveVote(vote);

    // Apply privacy delay to mask processing time
    await privacyDelay(this.privacyConfig);

    return vote;
  }

  /**
   * Get all votes for a ballot
   */
  async getVotes(ballotId: string): Promise<Vote[]> {
    return this.store.getVotesByBallot(ballotId);
  }

  /**
   * Get vote count for a ballot (without revealing choices)
   */
  async getVoteCount(ballotId: string): Promise<number> {
    const votes = await this.store.getVotesByBallot(ballotId);
    return votes.length;
  }

  /**
   * Check if a nullifier has been used for a ballot
   */
  async hasVoted(ballotId: string, nullifier: string): Promise<boolean> {
    return this.store.hasNullifier(ballotId, nullifier);
  }

  /**
   * Validate a vote without storing it (for gossip validation)
   */
  async validateVote(vote: Vote, ballot: Ballot): Promise<ValidationResult> {
    const errors: string[] = [];

    // 1. Check ballot ID matches
    if (vote.ballotId !== ballot.id) {
      errors.push('Vote ballot ID does not match');
    }

    // 2. Validate commitment format
    if (!Crypto.isValidHash(vote.commitment)) {
      errors.push('Invalid commitment format');
    }

    // 3. Validate nullifier format
    if (!Crypto.isValidHash(vote.nullifier)) {
      errors.push('Invalid nullifier format');
    }

    // 4. Verify Freebird token
    try {
      const tokenValid = await this.freebird.verify(vote.proof);
      if (!tokenValid) {
        errors.push('Invalid eligibility proof');
      }
    } catch (e) {
      errors.push(`Freebird verification failed: ${e}`);
    }

    // 5. Verify witness attestation
    try {
      const attestationValid = await this.witness.verify(vote.attestation);
      if (!attestationValid) {
        errors.push('Invalid witness attestation');
      }
    } catch (e) {
      errors.push(`Witness verification failed: ${e}`);
    }

    // 6. Check attestation timestamp is within ballot window
    // Attestation timestamp is in Unix seconds, ballot deadline is in milliseconds
    if (vote.attestation.timestamp * 1000 > ballot.deadline) {
      errors.push('Vote attestation is after deadline');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Request an eligibility token for voting
   * Returns a Freebird token if the requester is eligible
   *
   * Implements the eligibility hierarchy:
   * 1. Instance-level voter gate check
   * 2. Ballot-level eligibility check (can restrict, not expand)
   * 3. Freebird token issuance (anonymous from here on)
   */
  async requestEligibilityToken(
    ballotId: string,
    requesterPublicKey: string
  ): Promise<FreebirdToken> {
    // Use batching if enabled for stronger timing correlation protection
    if (this.eligibilityBatcher) {
      const result = await this.eligibilityBatcher.add({
        publicKey: requesterPublicKey,
        ballotId,
        index: 0, // Will be set by batch processor
      });

      if (!result.eligible) {
        throw new VoteError(
          result.reason ?? 'Not eligible to vote',
          ErrorCodes.INELIGIBLE
        );
      }

      return result.token!;
    }

    // Without batching, use normalized timing if privacy is enabled
    const processRequest = async (): Promise<FreebirdToken> => {
      return this.processEligibilityRequest(ballotId, requesterPublicKey);
    };

    if (this.privacyConfig.enabled && this.privacyConfig.normalizedResponseMs > 0) {
      return withNormalizedTiming(processRequest, this.privacyConfig.normalizedResponseMs);
    }

    return processRequest();
  }

  /**
   * Process a single eligibility request (extracted for batching)
   */
  private async processEligibilityRequest(
    ballotId: string,
    requesterPublicKey: string
  ): Promise<FreebirdToken> {
    const ballot = await this.ballotManager.getBallot(ballotId);
    if (!ballot) {
      throw new VoteError('Ballot not found', ErrorCodes.BALLOT_NOT_FOUND, 404);
    }

    // Check if ballot is in petition status
    if (this.ballotManager.isPetition(ballot)) {
      throw new VoteError(
        'Ballot is still collecting petition signatures and not yet accepting votes',
        ErrorCodes.BALLOT_IN_PETITION
      );
    }

    // 1. Check instance-level voter gate
    if (this.voterGate) {
      const instanceResult = await this.voterGate.canVote(requesterPublicKey);
      if (!instanceResult.allowed) {
        throw new VoteError(
          instanceResult.reason ?? 'Not eligible to vote on this instance',
          ErrorCodes.INELIGIBLE
        );
      }
    }

    // 2. Check ballot-level eligibility (more restrictive)
    const ballotEligible = await this.checkBallotEligibility(ballot, requesterPublicKey);
    if (!ballotEligible.allowed) {
      throw new VoteError(
        ballotEligible.reason ?? 'Not eligible to vote on this ballot',
        ErrorCodes.INELIGIBLE
      );
    }

    // 3. Issue Freebird token (anonymous from here on)
    return this.freebird.issue(ballotId);
  }

  /**
   * Process a batch of eligibility requests together
   * Shuffles processing order to prevent timing correlation
   */
  private async processBatchedEligibility(
    requests: EligibilityRequest[]
  ): Promise<EligibilityResult[]> {
    // Shuffle order to prevent timing correlation
    const indexedRequests = requests.map((r, i) => ({ ...r, originalIndex: i }));
    const shuffled = shuffleArray(indexedRequests);
    const results: EligibilityResult[] = new Array(requests.length);

    for (const req of shuffled) {
      try {
        const token = await this.processEligibilityRequest(req.ballotId, req.publicKey);
        results[req.originalIndex] = { eligible: true, token };
      } catch (error) {
        results[req.originalIndex] = {
          eligible: false,
          reason: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }

    return results;
  }

  /**
   * Check eligibility at the ballot level
   * This is separate from the instance voter gate and can only restrict, not expand
   */
  async checkBallotEligibility(ballot: Ballot, publicKey: string): Promise<GateResult> {
    return this.checkEligibility(ballot, publicKey);
  }

  /**
   * Check if a user is eligible to vote based on ballot configuration
   */
  private async checkEligibility(ballot: Ballot, publicKey: string): Promise<GateResult> {
    switch (ballot.eligibility.type) {
      case 'open':
        // Anyone with the link can vote
        return { allowed: true };

      case 'invite-list':
        // Must be in the invite list
        const isInvited = ballot.eligibility.invitees?.includes(publicKey) ?? false;
        return {
          allowed: isInvited,
          reason: isInvited ? undefined : 'Not on the invite list for this ballot',
        };

      case 'allowlist':
        // Must be on the allowlist
        const isAllowed = ballot.eligibility.allowlist?.includes(publicKey) ?? false;
        return {
          allowed: isAllowed,
          reason: isAllowed ? undefined : 'Not on the allowlist for this ballot',
        };

      default:
        return { allowed: false, reason: 'Unknown eligibility type' };
    }
  }
}

/**
 * Vote validation result
 */
interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Vote-specific error class
 */
class VoteError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'VoteError';
  }
}

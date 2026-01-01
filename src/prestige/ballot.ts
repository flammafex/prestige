/**
 * Ballot creation and management
 */

import { v4 as uuidv4 } from 'uuid';
import { Crypto } from './crypto.js';
import type {
  Ballot,
  BallotStatus,
  EligibilityConfig,
  WitnessAttestation,
  PrestigeStore,
  CreateBallotRequest,
  PrestigeError,
  BallotGateType,
  VoteTypeConfig,
} from './types.js';
import { ErrorCodes } from './types.js';
import type { WitnessAdapter } from './adapters/witness.js';
import type { BallotGate, GateResult, VoterGate } from './gates/types.js';

export interface BallotManagerConfig {
  defaultBallotDurationMinutes: number;
  revealWindowMinutes: number;
  maxChoices: number;
  maxQuestionLength: number;
  /** Minimum duration in minutes (default: 1) */
  minDurationMinutes?: number;
  /** The type of ballot gate being used (for initial status) */
  ballotGateType?: BallotGateType;
}

export class BallotManager {
  constructor(
    private store: PrestigeStore,
    private witness: WitnessAdapter,
    private config: BallotManagerConfig
  ) {}

  /**
   * Create a new ballot
   * @param options.isPetitionGate - If true, ballot starts in 'petition' status with placeholder deadlines
   */
  async createBallot(
    request: CreateBallotRequest,
    creatorPublicKey: string,
    options?: { isPetitionGate?: boolean }
  ): Promise<Ballot> {
    // Validate request
    this.validateBallotRequest(request);

    const now = Date.now();
    const durationMs = (request.durationMinutes ?? this.config.defaultBallotDurationMinutes) * 60 * 1000;
    const revealWindowMs = (request.revealWindowMinutes ?? this.config.revealWindowMinutes) * 60 * 1000;

    // For petition gate, deadlines are set when petition threshold is met
    // Use placeholder values that will be updated on activation
    const isPetition = options?.isPetitionGate || this.config.ballotGateType === 'petition';
    const deadline = isPetition ? 0 : now + durationMs;
    const revealDeadline = isPetition ? 0 : now + durationMs + revealWindowMs;
    const status: BallotStatus = isPetition ? 'petition' : 'voting';

    const ballot: Omit<Ballot, 'attestation'> = {
      id: uuidv4(),
      question: request.question.trim(),
      choices: request.choices.map(c => c.trim()),
      created: now,
      deadline,
      revealDeadline,
      eligibility: request.eligibility ?? { type: 'open' },
      creatorPublicKey,
      status,
      // Default to single choice voting for backwards compatibility
      voteType: request.voteType ?? { type: 'single' },
    };

    // Get witness attestation for creation time (server generates timestamp)
    const attestation = await this.witness.attest(Crypto.hashObject(ballot));

    const fullBallot: Ballot = {
      ...ballot,
      attestation,
    };

    await this.store.saveBallot(fullBallot);

    return fullBallot;
  }

  /**
   * Activate a ballot from petition status
   * Called when petition threshold is met
   */
  async activateBallot(ballotId: string, durationMinutes?: number, revealWindowMinutes?: number): Promise<Ballot> {
    const ballot = await this.store.getBallot(ballotId);
    if (!ballot) {
      throw new PrestigeValidationError('Ballot not found');
    }

    if (ballot.status !== 'petition') {
      throw new PrestigeValidationError('Ballot is not in petition status');
    }

    const now = Date.now();
    const durationMs = (durationMinutes ?? this.config.defaultBallotDurationMinutes) * 60 * 1000;
    const revealWindowMs = (revealWindowMinutes ?? this.config.revealWindowMinutes) * 60 * 1000;

    ballot.deadline = now + durationMs;
    ballot.revealDeadline = now + durationMs + revealWindowMs;
    ballot.status = 'voting';

    await this.store.updateBallotDeadlines(ballotId, ballot.deadline, ballot.revealDeadline);
    await this.store.updateBallotStatus(ballotId, 'voting');

    return ballot;
  }

  /**
   * Get a ballot by ID
   */
  async getBallot(id: string): Promise<Ballot | null> {
    const ballot = await this.store.getBallot(id);
    if (ballot) {
      // Update status based on current time
      const updatedStatus = this.computeStatus(ballot);
      if (updatedStatus !== ballot.status) {
        await this.store.updateBallotStatus(id, updatedStatus);
        ballot.status = updatedStatus;
      }
    }
    return ballot;
  }

  /**
   * List all ballots
   */
  async listBallots(options?: { status?: BallotStatus; limit?: number }): Promise<Ballot[]> {
    const ballots = await this.store.listBallots(options);
    // Update statuses
    const now = Date.now();
    for (const ballot of ballots) {
      const updatedStatus = this.computeStatus(ballot, now);
      if (updatedStatus !== ballot.status) {
        ballot.status = updatedStatus;
        await this.store.updateBallotStatus(ballot.id, updatedStatus);
      }
    }
    return ballots;
  }

  /**
   * Compute ballot status based on current time
   */
  computeStatus(ballot: Ballot, now: number = Date.now()): BallotStatus {
    // Petition status is sticky until explicitly activated
    if (ballot.status === 'petition') {
      return 'petition';
    }
    if (ballot.status === 'finalized') {
      return 'finalized';
    }
    if (now < ballot.deadline) {
      return 'voting';
    }
    if (now < ballot.revealDeadline) {
      return 'revealing';
    }
    return 'finalized';
  }

  /**
   * Check if a ballot is accepting votes
   */
  isAcceptingVotes(ballot: Ballot, now: number = Date.now()): boolean {
    // Petition ballots cannot accept votes until activated
    if (ballot.status === 'petition') {
      return false;
    }
    return now < ballot.deadline;
  }

  /**
   * Check if a ballot is in petition status (waiting for signatures)
   */
  isPetition(ballot: Ballot): boolean {
    return ballot.status === 'petition';
  }

  /**
   * Check if a ballot is accepting reveals
   */
  isAcceptingReveals(ballot: Ballot, now: number = Date.now()): boolean {
    return now >= ballot.deadline && now < ballot.revealDeadline;
  }

  /**
   * Check if a ballot is finalized
   */
  isFinalized(ballot: Ballot, now: number = Date.now()): boolean {
    return now >= ballot.revealDeadline || ballot.status === 'finalized';
  }

  /**
   * Validate ballot creation request
   */
  private validateBallotRequest(request: CreateBallotRequest): void {
    if (!request.question || request.question.trim().length === 0) {
      throw new PrestigeValidationError('Question is required');
    }

    if (request.question.length > this.config.maxQuestionLength) {
      throw new PrestigeValidationError(
        `Question must be ${this.config.maxQuestionLength} characters or less`
      );
    }

    if (!request.choices || !Array.isArray(request.choices)) {
      throw new PrestigeValidationError('Choices must be an array');
    }

    if (request.choices.length < 2) {
      throw new PrestigeValidationError('At least 2 choices are required');
    }

    if (request.choices.length > this.config.maxChoices) {
      throw new PrestigeValidationError(
        `Maximum ${this.config.maxChoices} choices allowed`
      );
    }

    // Check for empty or duplicate choices
    const trimmedChoices = request.choices.map(c => c.trim());
    const uniqueChoices = new Set(trimmedChoices);

    if (trimmedChoices.some(c => c.length === 0)) {
      throw new PrestigeValidationError('Choices cannot be empty');
    }

    if (uniqueChoices.size !== trimmedChoices.length) {
      throw new PrestigeValidationError('Choices must be unique');
    }

    // Validate duration if provided
    if (request.durationMinutes !== undefined) {
      const minDuration = this.config.minDurationMinutes ?? 1;
      if (request.durationMinutes < minDuration) {
        throw new PrestigeValidationError(
          `Duration must be at least ${minDuration} minute${minDuration === 1 ? '' : 's'}`
        );
      }
      if (request.durationMinutes > 43200) { // 30 days in minutes
        throw new PrestigeValidationError('Duration cannot exceed 30 days');
      }
    }

    // Validate eligibility config
    if (request.eligibility) {
      this.validateEligibilityConfig(request.eligibility);
    }

    // Validate vote type config
    if (request.voteType) {
      this.validateVoteTypeConfig(request.voteType, request.choices.length);
    }
  }

  /**
   * Validate vote type configuration
   */
  private validateVoteTypeConfig(config: VoteTypeConfig, numChoices: number): void {
    const validTypes = ['single', 'approval', 'ranked', 'score'];
    if (!validTypes.includes(config.type)) {
      throw new PrestigeValidationError(
        `Invalid vote type. Must be one of: ${validTypes.join(', ')}`
      );
    }

    // Validate score voting config
    if (config.type === 'score') {
      const minScore = config.minScore ?? 0;
      const maxScore = config.maxScore ?? 10;

      if (minScore < 0) {
        throw new PrestigeValidationError('Score voting minScore cannot be negative');
      }
      if (maxScore > 100) {
        throw new PrestigeValidationError('Score voting maxScore cannot exceed 100');
      }
      if (minScore >= maxScore) {
        throw new PrestigeValidationError('Score voting minScore must be less than maxScore');
      }
    }

    // Validate ranked choice config
    if (config.type === 'ranked') {
      const minRankings = config.minRankings ?? 1;
      const maxRankings = config.maxRankings ?? numChoices;

      if (minRankings < 1) {
        throw new PrestigeValidationError('Ranked choice minRankings must be at least 1');
      }
      if (maxRankings > numChoices) {
        throw new PrestigeValidationError('Ranked choice maxRankings cannot exceed number of choices');
      }
      if (minRankings > maxRankings) {
        throw new PrestigeValidationError('Ranked choice minRankings cannot exceed maxRankings');
      }
    }
  }

  /**
   * Validate eligibility configuration
   */
  private validateEligibilityConfig(config: EligibilityConfig): void {
    const validTypes = ['open', 'invite-list', 'allowlist'];
    if (!validTypes.includes(config.type)) {
      throw new PrestigeValidationError(
        `Invalid eligibility type. Must be one of: ${validTypes.join(', ')}`
      );
    }

    if (config.type === 'invite-list') {
      if (!config.invitees || config.invitees.length === 0) {
        throw new PrestigeValidationError(
          'Invite list eligibility requires at least one invitee'
        );
      }
      for (const key of config.invitees) {
        if (!Crypto.isValidPublicKey(key)) {
          throw new PrestigeValidationError(`Invalid public key in invitee list: ${key}`);
        }
      }
    }

    if (config.type === 'allowlist') {
      if (!config.allowlist || config.allowlist.length === 0) {
        throw new PrestigeValidationError(
          'Allowlist eligibility requires at least one allowed key'
        );
      }
      for (const key of config.allowlist) {
        if (!Crypto.isValidPublicKey(key)) {
          throw new PrestigeValidationError(`Invalid public key in allowlist: ${key}`);
        }
      }
    }
  }

  /**
   * Generate a shareable URL for a ballot
   */
  generateShareUrl(ballot: Ballot, baseUrl: string): string {
    return `${baseUrl}/b/${ballot.id}`;
  }
}

/**
 * Validation error class
 */
class PrestigeValidationError extends Error {
  code = ErrorCodes.VALIDATION_ERROR;
  statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'PrestigeValidationError';
  }
}

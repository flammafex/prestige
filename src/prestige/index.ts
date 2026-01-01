/**
 * Prestige - Anonymous Verifiable Voting
 * "Doodle poll, but you can't stuff the ballot and no one knows how you voted."
 *
 * Secret ballot. Public proof. That's the whole product.
 *
 * Gate System:
 * - Ballot Gates: Control who can create ballots (instance-level)
 * - Voter Gates: Control who can vote (instance-level default + per-ballot restrictions)
 *
 * "No one owns the mechanism, but someone owns each instance."
 */

import { Crypto } from './crypto.js';
import { BallotManager, type BallotManagerConfig } from './ballot.js';
import { VoteManager, type VoteManagerConfig } from './vote.js';
import { RevealManager, type RevealStats } from './reveal.js';
import { TallyManager, type LiveTally, type VerificationReport } from './tally.js';
import { NullifierGossip, type GossipConfig } from './gossip.js';
import { SQLiteStore, InMemoryStore } from './storage.js';
import {
  HttpFreebirdAdapter,
  MockFreebirdAdapter,
  type FreebirdConfig,
  type FreebirdAdapter,
} from './adapters/freebird.js';
import {
  HttpWitnessAdapter,
  MockWitnessAdapter,
  type WitnessConfig,
  type WitnessAdapter,
} from './adapters/witness.js';
import {
  WebSocketHyperTokenAdapter,
  MockHyperTokenAdapter,
  type HyperTokenConfig,
  type HyperTokenAdapter,
} from './adapters/hypertoken.js';
import {
  createBallotGate,
  createVoterGate,
  createProposalGate,
  type BallotGate,
  type VoterGate,
  type GateResult,
  type GateRequirements,
  type PetitionStatus,
  PetitionBallotGate,
  OpenBallotGate,
  OpenVoterGate,
  OwnerBallotGate,
  DelegationBallotGate,
  FreebirdBallotGate,
  FreebirdVoterGate,
  AllowlistVoterGate,
  VotersProposalGate,
  DelegationProposalGate,
  type ProposalGate,
  type ProposalGateType,
} from './gates/index.js';
import type {
  Ballot,
  Vote,
  Reveal,
  Result,
  KeyPair,
  PrestigeStore,
  PrestigeConfig,
  CreateBallotRequest,
  CastVoteRequest,
  SubmitRevealRequest,
  PetitionSignature,
} from './types.js';
import { ErrorCodes } from './types.js';
import { type PrivacyConfig, DEFAULT_PRIVACY_CONFIG } from './privacy.js';

export interface PrestigeOptions {
  config: PrestigeConfig;
  identity?: KeyPair;
  store?: PrestigeStore;
  freebird?: FreebirdAdapter;
  witness?: WitnessAdapter;
  hypertoken?: HyperTokenAdapter;
  ballotGate?: BallotGate;
  voterGate?: VoterGate;
  /** Privacy configuration for timing obfuscation and batching */
  privacyConfig?: PrivacyConfig;
}

/**
 * Main Prestige class - coordinates all voting operations
 */
export class Prestige {
  readonly identity: KeyPair;
  readonly store: PrestigeStore;
  readonly freebird: FreebirdAdapter;
  readonly witness: WitnessAdapter;
  readonly hypertoken: HyperTokenAdapter;

  readonly ballotManager: BallotManager;
  readonly voteManager: VoteManager;
  readonly revealManager: RevealManager;
  readonly tallyManager: TallyManager;
  readonly gossip: NullifierGossip;

  // Gate system
  readonly ballotGate: BallotGate;
  readonly voterGate: VoterGate;

  private config: PrestigeConfig;
  private privacyConfig: PrivacyConfig;

  constructor(options: PrestigeOptions) {
    this.config = options.config;
    this.privacyConfig = options.privacyConfig ?? DEFAULT_PRIVACY_CONFIG;

    // Generate or use provided identity
    this.identity = options.identity ?? Crypto.generateKeyPair();

    // Initialize store
    this.store = options.store ?? this.createStore();

    // Initialize adapters
    this.freebird = options.freebird ?? this.createFreebirdAdapter();
    this.witness = options.witness ?? this.createWitnessAdapter();
    this.hypertoken = options.hypertoken ?? this.createHyperTokenAdapter();

    // Initialize gates (voterGate first since ballotGate may need it for petition)
    this.voterGate = options.voterGate ?? this.createVoterGate();
    this.ballotGate = options.ballotGate ?? this.createBallotGate();

    // Initialize managers
    const ballotConfig: BallotManagerConfig = {
      defaultBallotDurationMinutes: options.config.defaultBallotDurationMinutes,
      revealWindowMinutes: options.config.revealWindowMinutes,
      maxChoices: options.config.maxChoices,
      maxQuestionLength: options.config.maxQuestionLength,
      minDurationMinutes: options.config.minDurationMinutes,
      ballotGateType: options.config.ballotGate,
    };

    this.ballotManager = new BallotManager(this.store, this.witness, ballotConfig);

    const voteManagerConfig: VoteManagerConfig = {};

    this.voteManager = new VoteManager(
      this.store,
      this.ballotManager,
      this.freebird,
      this.witness,
      voteManagerConfig,
      this.privacyConfig
    );

    // Set voter gate on vote manager
    this.voteManager.setVoterGate(this.voterGate);

    this.revealManager = new RevealManager(this.store, this.ballotManager, this.privacyConfig);
    this.tallyManager = new TallyManager(
      this.store,
      this.ballotManager,
      this.revealManager,
      this.witness
    );

    // Initialize gossip
    this.gossip = new NullifierGossip(
      this.store,
      this.ballotManager,
      this.freebird,
      this.witness,
      this.hypertoken,
      this.identity
    );
  }

  /**
   * Start the Prestige node
   */
  async start(): Promise<void> {
    await this.gossip.start();
    console.log(`Prestige node started with identity: ${this.identity.publicKey.slice(0, 16)}...`);
  }

  /**
   * Stop the Prestige node
   */
  stop(): void {
    this.gossip.stop();
    console.log('Prestige node stopped');
  }

  // ============= Ballot Operations =============

  /**
   * Create a new ballot
   * Requires passing the ballot gate check first
   * @param creatorPublicKey - Optional public key of the creator (defaults to instance identity)
   */
  async createBallot(request: CreateBallotRequest, creatorPublicKey?: string): Promise<Ballot> {
    const publicKey = creatorPublicKey ?? this.identity.publicKey;

    // Check ballot gate
    const gateResult = await this.ballotGate.canCreate(publicKey, request);
    if (!gateResult.allowed) {
      throw new BallotCreationError(
        gateResult.reason ?? 'Not authorized to create ballots',
        ErrorCodes.NOT_AUTHORIZED
      );
    }

    const ballot = await this.ballotManager.createBallot(request, publicKey);
    await this.gossip.broadcastBallot(ballot);
    return ballot;
  }

  /**
   * Check if a public key can create a ballot
   */
  async canCreateBallot(publicKey: string, request?: CreateBallotRequest): Promise<GateResult> {
    return this.ballotGate.canCreate(publicKey, request);
  }

  /**
   * Get a ballot by ID
   */
  async getBallot(id: string): Promise<Ballot | null> {
    return this.ballotManager.getBallot(id);
  }

  /**
   * List all ballots
   */
  async listBallots(options?: { status?: string; limit?: number }): Promise<Ballot[]> {
    return this.ballotManager.listBallots(options as any);
  }

  /**
   * Get ballot status information
   */
  async getBallotStatus(id: string): Promise<BallotStatus | null> {
    const ballot = await this.ballotManager.getBallot(id);
    if (!ballot) return null;

    const voteCount = await this.voteManager.getVoteCount(id);
    const now = Date.now();
    const isPetition = this.ballotManager.isPetition(ballot);

    // Get petition status if applicable
    let petitionStatus: PetitionStatus | null = null;
    if (isPetition && this.ballotGate.type === 'petition') {
      const petitionGate = this.ballotGate as PetitionBallotGate;
      petitionStatus = await petitionGate.getPetitionStatus(id);
    }

    return {
      ballot,
      voteCount,
      status: this.ballotManager.computeStatus(ballot),
      isAcceptingVotes: this.ballotManager.isAcceptingVotes(ballot, now),
      isAcceptingReveals: this.ballotManager.isAcceptingReveals(ballot, now),
      isFinalized: this.ballotManager.isFinalized(ballot, now),
      isPetition,
      petitionStatus,
      timeRemaining: ballot.deadline > now ? ballot.deadline - now : 0,
      revealTimeRemaining: ballot.revealDeadline > now ? ballot.revealDeadline - now : 0,
    };
  }

  // ============= Petition Operations =============

  /**
   * Sign a petition to activate a ballot
   * Only works if ballot is in petition status
   */
  async signPetition(ballotId: string, publicKey: string, signature: string): Promise<{
    added: boolean;
    activated: boolean;
    status: PetitionStatus;
  }> {
    if (this.ballotGate.type !== 'petition') {
      throw new BallotCreationError('Instance does not use petition gate', ErrorCodes.VALIDATION_ERROR);
    }

    const petitionGate = this.ballotGate as PetitionBallotGate;
    const result = await petitionGate.addSignature(ballotId, publicKey, signature);

    // If petition was just activated, update ballot deadlines
    if (result.activated) {
      await this.ballotManager.activateBallot(ballotId);
    }

    return result;
  }

  /**
   * Get petition status for a ballot
   */
  async getPetitionStatus(ballotId: string): Promise<PetitionStatus | null> {
    if (this.ballotGate.type !== 'petition') {
      return null;
    }

    const petitionGate = this.ballotGate as PetitionBallotGate;
    return petitionGate.getPetitionStatus(ballotId);
  }

  // ============= Gate Operations =============

  /**
   * Get ballot gate requirements
   */
  getBallotGateRequirements(): GateRequirements {
    return this.ballotGate.getRequirements();
  }

  /**
   * Get voter gate requirements
   */
  getVoterGateRequirements(): GateRequirements {
    return this.voterGate.getRequirements();
  }

  /**
   * Get all gate info (for UI)
   */
  getGateInfo(): { ballot: GateRequirements; voter: GateRequirements } {
    return {
      ballot: this.ballotGate.getRequirements(),
      voter: this.voterGate.getRequirements(),
    };
  }

  /**
   * Check if a public key can vote on the instance
   */
  async canVoteOnInstance(publicKey: string): Promise<GateResult> {
    return this.voterGate.canVote(publicKey);
  }

  // ============= Vote Operations =============

  /**
   * Cast a vote on a ballot
   */
  async castVote(request: CastVoteRequest): Promise<Vote> {
    const vote = await this.voteManager.castVote(request);
    await this.gossip.broadcastVote(vote);
    return vote;
  }

  /**
   * Get eligibility token for voting
   */
  async requestEligibilityToken(ballotId: string): Promise<import('./types.js').FreebirdToken> {
    return this.voteManager.requestEligibilityToken(ballotId, this.identity.publicKey);
  }

  /**
   * Get all votes for a ballot
   */
  async getVotes(ballotId: string): Promise<Vote[]> {
    return this.voteManager.getVotes(ballotId);
  }

  /**
   * Check if already voted on a ballot
   */
  async hasVoted(ballotId: string, nullifier: string): Promise<boolean> {
    return this.voteManager.hasVoted(ballotId, nullifier);
  }

  // ============= Reveal Operations =============

  /**
   * Submit a reveal for a vote
   */
  async submitReveal(request: SubmitRevealRequest): Promise<Reveal> {
    const reveal = await this.revealManager.submitReveal(request);
    await this.gossip.broadcastReveal(reveal);
    return reveal;
  }

  /**
   * Get all reveals for a ballot
   */
  async getReveals(ballotId: string): Promise<Reveal[]> {
    return this.revealManager.getReveals(ballotId);
  }

  /**
   * Get reveal statistics
   */
  async getRevealStats(ballotId: string) {
    return this.revealManager.getRevealStats(ballotId);
  }

  // ============= Result Operations =============

  /**
   * Get final results for a ballot
   */
  async getResults(ballotId: string): Promise<Result | null> {
    return this.tallyManager.getResult(ballotId);
  }

  /**
   * Get live tally (before finalization)
   */
  async getLiveTally(ballotId: string) {
    return this.tallyManager.getLiveTally(ballotId);
  }

  /**
   * Get detailed verification report
   */
  async getVerificationReport(ballotId: string) {
    return this.tallyManager.getVerificationReport(ballotId);
  }

  // ============= Utilities =============

  /**
   * Generate share URL for a ballot
   */
  generateShareUrl(ballot: Ballot, baseUrl: string): string {
    return this.ballotManager.generateShareUrl(ballot, baseUrl);
  }

  /**
   * Generate a voter secret for nullifier computation
   */
  generateVoterSecret(): string {
    return Crypto.generateVoterSecret();
  }

  /**
   * Generate a nullifier from voter secret and ballot ID
   */
  generateNullifier(voterSecret: string, ballotId: string): string {
    return Crypto.generateNullifier(voterSecret, ballotId);
  }

  /**
   * Generate a commitment from choice and salt
   */
  generateCommitment(choice: string, salt: string): string {
    return Crypto.generateCommitment(choice, salt);
  }

  /**
   * Generate a random salt for commitment
   */
  generateSalt(): string {
    return Crypto.generateSalt();
  }

  /**
   * Health check all services
   */
  async healthCheck(): Promise<HealthStatus> {
    const [freebirdOk, witnessOk, hypertokenOk] = await Promise.all([
      this.freebird.healthCheck().catch(() => false),
      this.witness.healthCheck().catch(() => false),
      this.hypertoken.healthCheck().catch(() => false),
    ]);

    return {
      healthy: freebirdOk && witnessOk,
      freebird: freebirdOk,
      witness: witnessOk,
      hypertoken: hypertokenOk,
      identity: this.identity.publicKey,
    };
  }

  // ============= Private Methods =============

  private createStore(): PrestigeStore {
    const dbPath = `${this.config.dataDir}/prestige.db`;
    return new SQLiteStore(dbPath);
  }

  private createFreebirdAdapter(): FreebirdAdapter {
    const config: FreebirdConfig = {
      issuerUrl: this.config.freebirdIssuerUrl,
      verifierUrl: this.config.freebirdVerifierUrl,
    };
    return new HttpFreebirdAdapter(config);
  }

  private createWitnessAdapter(): WitnessAdapter {
    const config: WitnessConfig = {
      gatewayUrl: this.config.witnessUrl,
    };
    return new HttpWitnessAdapter(config);
  }

  private createHyperTokenAdapter(): HyperTokenAdapter {
    const config: HyperTokenConfig = {
      relayUrl: this.config.hypertokenRelayUrl,
    };
    return new WebSocketHyperTokenAdapter(config);
  }

  private createBallotGate(): BallotGate {
    const gateConfig = {
      ballotGate: this.config.ballotGate ?? 'owner',
      ballotGateAdminKey: this.config.ballotGateAdminKey ?? this.identity.publicKey,
      ballotGateDelegates: this.config.ballotGateDelegates,
      ballotGateFreebirdIssuer: this.config.ballotGateFreebirdIssuer,
      ballotGateFreebirdIssuerUrl: this.config.ballotGateFreebirdIssuerUrl,
      ballotGatePetitionThreshold: this.config.ballotGatePetitionThreshold,
      voterGate: this.config.voterGate ?? 'freebird',
      // Proposal gate config (for petition ballot gate)
      petitionProposalGate: this.config.petitionProposalGate,
      petitionProposalDelegates: this.config.petitionProposalDelegates,
    };

    return createBallotGate({
      config: gateConfig,
      store: this.store,
      freebird: this.freebird,
      freebirdVerifierUrl: this.config.freebirdVerifierUrl,
      instancePublicKey: this.identity.publicKey,
      voterGate: this.voterGate,
    });
  }

  private createVoterGate(): VoterGate {
    const gateConfig = {
      ballotGate: this.config.ballotGate ?? 'owner',
      ballotGateAdminKey: this.config.ballotGateAdminKey ?? this.identity.publicKey,
      voterGate: this.config.voterGate ?? 'freebird',
      voterGateAllowlist: this.config.voterGateAllowlist,
      voterGateFreebirdIssuerUrl: this.config.voterGateFreebirdIssuerUrl,
    };

    return createVoterGate({
      config: gateConfig,
      store: this.store,
      freebird: this.freebird,
      freebirdVerifierUrl: this.config.freebirdVerifierUrl,
      instancePublicKey: this.identity.publicKey,
    });
  }
}

/**
 * Ballot status response
 */
interface BallotStatus {
  ballot: Ballot;
  voteCount: number;
  status: string;
  isAcceptingVotes: boolean;
  isAcceptingReveals: boolean;
  isFinalized: boolean;
  isPetition: boolean;
  petitionStatus: PetitionStatus | null;
  timeRemaining: number;
  revealTimeRemaining: number;
}

/**
 * Error for ballot creation issues
 */
class BallotCreationError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 403
  ) {
    super(message);
    this.name = 'BallotCreationError';
  }
}

/**
 * Health check status
 */
interface HealthStatus {
  healthy: boolean;
  freebird: boolean;
  witness: boolean;
  hypertoken: boolean;
  identity: string;
}

/**
 * Create a Prestige instance with default configuration
 */
export function createPrestige(configOverrides?: Partial<PrestigeConfig>): Prestige {
  const config: PrestigeConfig = {
    // Service URLs
    freebirdIssuerUrl: process.env.FREEBIRD_ISSUER_URL ?? 'http://localhost:8081',
    freebirdVerifierUrl: process.env.FREEBIRD_VERIFIER_URL ?? 'http://localhost:8082',
    witnessUrl: process.env.WITNESS_URL ?? 'http://localhost:8080',
    hypertokenRelayUrl: process.env.HYPERTOKEN_RELAY_URL ?? 'ws://localhost:3001',

    // Defaults (24 hours = 1440 minutes)
    defaultBallotDurationMinutes: 1440,
    revealWindowMinutes: 1440,
    maxChoices: 20,
    maxQuestionLength: 500,
    maxPeers: 50,
    gossipInterval: 5000,
    dataDir: process.env.DATA_DIR ?? './data',

    // Ballot Gate configuration
    ballotGate: (process.env.BALLOT_GATE as any) ?? 'owner',
    ballotGateAdminKey: process.env.BALLOT_GATE_ADMIN_KEY,
    ballotGateDelegates: process.env.BALLOT_GATE_DELEGATES?.split(',').filter(Boolean),
    ballotGateFreebirdIssuer: process.env.BALLOT_GATE_FREEBIRD_ISSUER,
    ballotGateFreebirdIssuerUrl: process.env.BALLOT_GATE_FREEBIRD_ISSUER_URL,
    ballotGatePetitionThreshold: process.env.BALLOT_GATE_PETITION_THRESHOLD
      ? parseInt(process.env.BALLOT_GATE_PETITION_THRESHOLD, 10)
      : 10,

    // Voter Gate configuration
    voterGate: (process.env.VOTER_GATE as any) ?? 'freebird',
    voterGateAllowlist: process.env.VOTER_GATE_ALLOWLIST?.split(',').filter(Boolean),
    voterGateFreebirdIssuerUrl: process.env.VOTER_GATE_FREEBIRD_ISSUER_URL,

    // Proposal Gate configuration (when BALLOT_GATE=petition)
    petitionProposalGate: (process.env.PETITION_PROPOSAL_GATE as any) ?? 'voters',
    petitionProposalDelegates: process.env.PETITION_PROPOSAL_DELEGATES?.split(',').filter(Boolean),

    ...configOverrides,
  };

  // Use mock HyperToken if relay URL is not configured (single-node deployment)
  const hypertoken = process.env.HYPERTOKEN_RELAY_URL
    ? undefined  // Will create real adapter
    : new MockHyperTokenAdapter();

  if (!process.env.HYPERTOKEN_RELAY_URL) {
    console.log('  HyperToken: disabled (no HYPERTOKEN_RELAY_URL configured)');
  }

  return new Prestige({ config, hypertoken });
}

/**
 * Create a Prestige instance for testing (with mock adapters)
 */
export function createTestPrestige(identity?: KeyPair): Prestige {
  const config: PrestigeConfig = {
    freebirdIssuerUrl: 'http://mock',
    freebirdVerifierUrl: 'http://mock',
    witnessUrl: 'http://mock',
    hypertokenRelayUrl: 'ws://mock',
    defaultBallotDurationMinutes: 60,
    revealWindowMinutes: 60,
    maxChoices: 10,
    maxQuestionLength: 200,
    // Allow short durations for testing (1 minute minimum)
    minDurationMinutes: 1,
    maxPeers: 10,
    gossipInterval: 1000,
    dataDir: './test-data',
    // Open gates for MVP - anyone can create ballots and vote
    ballotGate: 'open',
    voterGate: 'open',
  };

  return new Prestige({
    config,
    identity,
    store: new InMemoryStore(),
    freebird: new MockFreebirdAdapter(),
    witness: new MockWitnessAdapter(),
    hypertoken: new MockHyperTokenAdapter(),
  });
}

// Re-export types and utilities
export { Crypto } from './crypto.js';
export type * from './types.js';
export { BallotManager } from './ballot.js';
export { VoteManager } from './vote.js';
export { RevealManager, type RevealStats } from './reveal.js';
export { TallyManager, type LiveTally, type VerificationReport } from './tally.js';
export { NullifierGossip } from './gossip.js';
export { SQLiteStore, InMemoryStore } from './storage.js';
export {
  HttpFreebirdAdapter,
  MockFreebirdAdapter,
  type FreebirdAdapter,
} from './adapters/freebird.js';
export {
  HttpWitnessAdapter,
  MockWitnessAdapter,
  type WitnessAdapter,
} from './adapters/witness.js';
export {
  WebSocketHyperTokenAdapter,
  MockHyperTokenAdapter,
  type HyperTokenAdapter,
} from './adapters/hypertoken.js';

// Privacy utilities
export {
  randomDelay,
  privacyDelay,
  withNormalizedTiming,
  jitterTimestamp,
  constantTimeCompare,
  shuffleArray,
  parsePrivacyConfig,
  RequestBatcher,
  DEFAULT_PRIVACY_CONFIG,
  type PrivacyConfig,
} from './privacy.js';

// Gate system exports
export {
  createBallotGate,
  createVoterGate,
  createProposalGate,
  // Ballot gates
  OpenBallotGate,
  OwnerBallotGate,
  DelegationBallotGate,
  FreebirdBallotGate,
  PetitionBallotGate,
  // Voter gates
  OpenVoterGate,
  FreebirdVoterGate,
  AllowlistVoterGate,
  // Proposal gates
  VotersProposalGate,
  DelegationProposalGate,
  // Types
  type BallotGate,
  type VoterGate,
  type ProposalGate,
  type ProposalGateType,
  type GateResult,
  type GateRequirements,
  type GateConfig,
  type PetitionStatus,
  type PetitionSignature,
} from './gates/index.js';

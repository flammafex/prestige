/**
 * Prestige Core Types
 * Anonymous verifiable voting - Secret ballot, public proof
 */

// Cryptographic primitives
export type PublicKey = string;  // hex-encoded 32 bytes
export type PrivateKey = string; // hex-encoded 32 bytes
export type Signature = string;  // hex-encoded 64 bytes
export type Hash = string;       // hex-encoded 32 bytes

export interface KeyPair {
  publicKey: PublicKey;
  privateKey: PrivateKey;
}

// Witness attestation - proves timestamp via BFT consensus
export interface WitnessAttestation {
  hash: Hash;
  timestamp: number;
  signatures: Array<{
    witnessId: string;
    signature: Signature;
  }>;
  witnessIds: string[];
}

// Freebird token - proves eligibility without revealing identity
export interface FreebirdToken {
  blindedToken: string;
  proof: string;
  issuerPublicKey: string;
  expiresAt: number;
}

// Ballot eligibility configuration (per-ballot, can restrict but not expand instance voter gate)
export interface EligibilityConfig {
  type: 'open' | 'invite-list' | 'clout-trust-graph' | 'scarbucks' | 'allowlist';
  invitees?: PublicKey[];      // for invite-list
  trustHops?: number;          // for clout-trust-graph (must be <= instance voter gate hops)
  creatorPublicKey?: PublicKey; // for clout-trust-graph
  tokenId?: string;            // for scarbucks
  minAmount?: number;          // for scarbucks (must be >= instance voter gate minimum)
  allowlist?: PublicKey[];     // for allowlist (must be subset of instance-allowed voters)
}

// Ballot lifecycle states
// 'petition' - for petition gate: ballot is visible but waiting for signatures to activate
export type BallotStatus = 'petition' | 'open' | 'voting' | 'revealing' | 'finalized';

// The ballot itself
export interface Ballot {
  id: string;
  question: string;
  choices: string[];
  created: number;
  deadline: number;           // voting ends at this timestamp
  revealDeadline: number;     // reveals must be submitted by this time
  eligibility: EligibilityConfig;
  attestation: WitnessAttestation;  // proves creation time
  creatorPublicKey: PublicKey;
  status: BallotStatus;
}

// A vote commitment (hides choice until reveal)
export interface Vote {
  ballotId: string;
  nullifier: Hash;            // H(voterSecret || ballotId) - prevents double-vote
  commitment: Hash;           // H(choice || salt) - hides choice until reveal
  proof: FreebirdToken;       // proves eligibility without identity
  attestation: WitnessAttestation;
}

// A vote reveal (proves the committed choice)
export interface Reveal {
  ballotId: string;
  nullifier: Hash;            // links to original vote
  choice: string;             // the actual choice
  salt: string;               // random value used in commitment
}

// Verification result for a reveal
export interface RevealVerification {
  nullifier: Hash;
  choice: string;
  valid: boolean;
  reason?: string;
}

// Final ballot result
export interface Result {
  ballotId: string;
  tally: Record<string, number>;
  totalVotes: number;
  totalReveals: number;
  validReveals: number;
  attestation: WitnessAttestation;  // proves finalization time
  finalized: number;
}

// Gossip message types for P2P propagation
export type GossipMessageType = 'vote' | 'reveal' | 'ballot' | 'result';

export interface GossipMessage {
  type: GossipMessageType;
  payload: Vote | Reveal | Ballot | Result;
  sender: PublicKey;
  signature: Signature;
  nonce: string;
  timestamp: number;
}

// Peer connection info
export interface PeerConnection {
  peerId: string;
  address: string;
  connectedAt: number;
  lastSeen: number;
  score: number;
}

// Petition signature for petition gate
export interface PetitionSignature {
  ballotId: string;
  publicKey: PublicKey;
  signature: string;
  timestamp: number;
}

// Storage interface
export interface PrestigeStore {
  // Ballots
  saveBallot(ballot: Ballot): Promise<void>;
  getBallot(id: string): Promise<Ballot | null>;
  listBallots(options?: { status?: BallotStatus; limit?: number }): Promise<Ballot[]>;
  updateBallotStatus(id: string, status: BallotStatus): Promise<void>;
  updateBallotDeadlines(id: string, deadline: number, revealDeadline: number): Promise<void>;

  // Votes
  saveVote(vote: Vote): Promise<void>;
  getVotesByBallot(ballotId: string): Promise<Vote[]>;
  hasNullifier(ballotId: string, nullifier: Hash): Promise<boolean>;

  // Reveals
  saveReveal(reveal: Reveal): Promise<void>;
  getRevealsByBallot(ballotId: string): Promise<Reveal[]>;
  getRevealByNullifier(ballotId: string, nullifier: Hash): Promise<Reveal | null>;

  // Results
  saveResult(result: Result): Promise<void>;
  getResult(ballotId: string): Promise<Result | null>;

  // Petition signatures (for petition gate)
  savePetitionSignature(signature: PetitionSignature): Promise<void>;
  getPetitionSignatures(ballotId: string): Promise<PetitionSignature[]>;
  hasPetitionSignature(ballotId: string, publicKey: string): Promise<boolean>;
}

// Gate types
export type BallotGateType = 'open' | 'owner' | 'delegation' | 'clout' | 'freebird' | 'petition';
export type VoterGateType = 'open' | 'freebird' | 'clout' | 'scarbucks' | 'allowlist';
export type ProposalGateType = 'voters' | 'clout' | 'delegation' | 'token';

// Configuration
export interface PrestigeConfig {
  // Service URLs
  freebirdIssuerUrl: string;
  freebirdVerifierUrl: string;
  witnessUrl: string;
  hypertokenRelayUrl: string;

  // Defaults
  defaultBallotDurationHours: number;
  revealWindowHours: number;
  maxChoices: number;
  maxQuestionLength: number;
  /** Minimum ballot duration in hours (default: 1, set lower for testing) */
  minDurationHours?: number;

  // Network
  maxPeers: number;
  gossipInterval: number;

  // Storage
  dataDir: string;

  // Ballot Gate (who creates ballots)
  ballotGate?: BallotGateType;
  ballotGateAdminKey?: string;
  ballotGateDelegates?: string[];
  ballotGateTrustHops?: number;
  ballotGateCloutUrl?: string;
  ballotGateFreebirdIssuer?: string;
  ballotGatePetitionThreshold?: number;

  // Voter Gate (who can vote - instance level)
  voterGate?: VoterGateType;
  voterGateTrustHops?: number;
  voterGateCloutUrl?: string;
  voterGateTokenId?: string;
  voterGateMinAmount?: number;
  voterGateScarcityUrl?: string;
  voterGateAllowlist?: string[];

  // Proposal Gate (who can open petitions - when ballotGate=petition)
  petitionProposalGate?: ProposalGateType;

  // For clout proposal gate
  petitionProposalCloutUrl?: string;
  petitionProposalTrustHops?: number;

  // For delegation proposal gate
  petitionProposalDelegates?: string[];

  // For token proposal gate
  petitionProposalScarcityUrl?: string;
  petitionProposalTokenId?: string;
  petitionProposalMinAmount?: number;
}

// API request/response types
export interface CreateBallotRequest {
  question: string;
  choices: string[];
  durationHours?: number;
  revealWindowHours?: number;
  eligibility?: EligibilityConfig;
}

export interface CreateBallotResponse {
  ballot: Ballot;
  shareUrl: string;
}

export interface CastVoteRequest {
  ballotId: string;
  commitment: Hash;
  nullifier: Hash;
  proof: FreebirdToken;
}

export interface SubmitRevealRequest {
  ballotId: string;
  nullifier: Hash;
  choice: string;
  salt: string;
}

export interface BallotStatusResponse {
  ballot: Ballot;
  voteCount: number;
  status: BallotStatus;
  timeRemaining?: number;
}

export interface ResultsResponse {
  result: Result;
  verificationSummary: {
    totalVotes: number;
    totalReveals: number;
    validReveals: number;
    invalidReveals: number;
  };
}

// Error types
export class PrestigeError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'PrestigeError';
  }
}

export const ErrorCodes = {
  BALLOT_NOT_FOUND: 'BALLOT_NOT_FOUND',
  BALLOT_CLOSED: 'BALLOT_CLOSED',
  BALLOT_NOT_REVEALING: 'BALLOT_NOT_REVEALING',
  BALLOT_IN_PETITION: 'BALLOT_IN_PETITION',
  DOUBLE_VOTE: 'DOUBLE_VOTE',
  INVALID_PROOF: 'INVALID_PROOF',
  INVALID_ATTESTATION: 'INVALID_ATTESTATION',
  INVALID_COMMITMENT: 'INVALID_COMMITMENT',
  INVALID_REVEAL: 'INVALID_REVEAL',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  INELIGIBLE: 'INELIGIBLE',
  TOO_LATE: 'TOO_LATE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  // Gate-specific errors
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  NOT_IN_TRUST_NETWORK: 'NOT_IN_TRUST_NETWORK',
  INSUFFICIENT_TOKENS: 'INSUFFICIENT_TOKENS',
  NOT_IN_ALLOWLIST: 'NOT_IN_ALLOWLIST',
  PETITION_NOT_MET: 'PETITION_NOT_MET',
} as const;

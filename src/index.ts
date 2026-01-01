/**
 * Prestige - Anonymous Verifiable Voting for SophiaDOS
 *
 * Scarcity handles transfer() — conservation of value
 * Clout handles post() — propagation of signal
 * Prestige handles cast() — aggregation of will
 *
 * "Doodle poll, but you can't stuff the ballot and no one knows how you voted."
 */

export {
  Prestige,
  createPrestige,
  createTestPrestige,
  Crypto,
  BallotManager,
  VoteManager,
  RevealManager,
  TallyManager,
  NullifierGossip,
  SQLiteStore,
  InMemoryStore,
  HttpFreebirdAdapter,
  MockFreebirdAdapter,
  HttpWitnessAdapter,
  MockWitnessAdapter,
  WebSocketHyperTokenAdapter,
  MockHyperTokenAdapter,
} from './prestige/index.js';

export type {
  Ballot,
  BallotStatus,
  Vote,
  Reveal,
  Result,
  EligibilityConfig,
  FreebirdToken,
  WitnessAttestation,
  KeyPair,
  PrestigeStore,
  PrestigeConfig,
  CreateBallotRequest,
  CreateBallotResponse,
  CastVoteRequest,
  SubmitRevealRequest,
  BallotStatusResponse,
  ResultsResponse,
  GossipMessage,
  PeerConnection,
  FreebirdAdapter,
  WitnessAdapter,
  HyperTokenAdapter,
} from './prestige/index.js';

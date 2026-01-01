/**
 * NullifierGossip - Vote propagation and double-vote prevention
 *
 * Adapted from Scarcity's NullifierGossip pattern.
 * The nullifier prevents double-voting the same way it prevents double-spending.
 */

import { Crypto } from './crypto.js';
import type {
  Vote,
  Reveal,
  Ballot,
  Result,
  GossipMessage,
  GossipMessageType,
  PeerConnection,
  PrestigeStore,
  KeyPair,
} from './types.js';
import type { FreebirdAdapter } from './adapters/freebird.js';
import type { WitnessAdapter } from './adapters/witness.js';
import type { HyperTokenAdapter, MessageHandler } from './adapters/hypertoken.js';
import type { BallotManager } from './ballot.js';

export interface GossipConfig {
  maxNullifiers: number;
  maxNullifierAge: number;  // milliseconds
  peerScoreThreshold: number;
  pruneInterval: number;
}

const DEFAULT_CONFIG: GossipConfig = {
  maxNullifiers: 100000,
  maxNullifierAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  peerScoreThreshold: -50,
  pruneInterval: 60 * 60 * 1000, // 1 hour
};

interface NullifierEntry {
  ballotId: string;
  nullifier: string;
  commitment: string;
  timestamp: number;
  peerCount: number;
}

interface PeerScore {
  peerId: string;
  score: number;
  validMessages: number;
  invalidProofs: number;
  duplicates: number;
}

export class NullifierGossip {
  private nullifiers = new Map<string, NullifierEntry>();
  private peerScores = new Map<string, PeerScore>();
  private config: GossipConfig;
  private pruneTimer: NodeJS.Timeout | null = null;
  private messageHandler: MessageHandler | null = null;

  constructor(
    private store: PrestigeStore,
    private ballotManager: BallotManager,
    private freebird: FreebirdAdapter,
    private witness: WitnessAdapter,
    private hypertoken: HyperTokenAdapter,
    private identity: KeyPair,
    config?: Partial<GossipConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the gossip protocol
   */
  async start(): Promise<void> {
    // Connect to relay
    await this.hypertoken.connect();

    // Set up message handler
    this.messageHandler = (message) => this.handleMessage(message);
    this.hypertoken.onMessage(this.messageHandler);

    // Start pruning timer
    this.pruneTimer = setInterval(() => this.prune(), this.config.pruneInterval);
  }

  /**
   * Stop the gossip protocol
   */
  stop(): void {
    if (this.messageHandler) {
      this.hypertoken.offMessage(this.messageHandler);
      this.messageHandler = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.hypertoken.disconnect();
  }

  /**
   * Broadcast a vote to the network
   */
  async broadcastVote(vote: Vote): Promise<void> {
    const message = this.createMessage('vote', vote);
    await this.hypertoken.send(message);
  }

  /**
   * Broadcast a reveal to the network
   */
  async broadcastReveal(reveal: Reveal): Promise<void> {
    const message = this.createMessage('reveal', reveal);
    await this.hypertoken.send(message);
  }

  /**
   * Broadcast a ballot to the network
   */
  async broadcastBallot(ballot: Ballot): Promise<void> {
    const message = this.createMessage('ballot', ballot);
    await this.hypertoken.send(message);
  }

  /**
   * Broadcast a result to the network
   */
  async broadcastResult(result: Result): Promise<void> {
    const message = this.createMessage('result', result);
    await this.hypertoken.send(message);
  }

  /**
   * Check if a nullifier has been seen
   * Returns confidence score (0-1) based on peer count
   */
  checkNullifier(ballotId: string, nullifier: string): NullifierCheck {
    const key = `${ballotId}:${nullifier}`;
    const entry = this.nullifiers.get(key);

    if (!entry) {
      return { seen: false, confidence: 0, peerCount: 0 };
    }

    const peers = this.hypertoken.getPeers();
    const confidence = peers.length > 0 ? entry.peerCount / peers.length : 0;

    return {
      seen: true,
      confidence,
      peerCount: entry.peerCount,
      commitment: entry.commitment,
      timestamp: entry.timestamp,
    };
  }

  /**
   * Handle an incoming gossip message
   */
  private async handleMessage(message: GossipMessage): Promise<void> {
    // Validate message signature
    const messageContent = Crypto.canonicalJson({
      type: message.type,
      payload: message.payload,
      nonce: message.nonce,
      timestamp: message.timestamp,
    });

    if (!Crypto.verify(messageContent, message.signature, message.sender)) {
      this.penalizePeer(message.sender, 'invalid_signature');
      return;
    }

    // Check peer score
    const score = this.getPeerScore(message.sender);
    if (score.score < this.config.peerScoreThreshold) {
      return; // Ignore messages from low-reputation peers
    }

    // Route by message type
    switch (message.type) {
      case 'vote':
        await this.onReceiveVote(message.payload as Vote, message.sender);
        break;
      case 'reveal':
        await this.onReceiveReveal(message.payload as Reveal, message.sender);
        break;
      case 'ballot':
        await this.onReceiveBallot(message.payload as Ballot, message.sender);
        break;
      case 'result':
        await this.onReceiveResult(message.payload as Result, message.sender);
        break;
    }
  }

  /**
   * Handle an incoming vote
   * This is the core nullifier gossip logic from Scarcity
   */
  private async onReceiveVote(vote: Vote, peerId: string): Promise<void> {
    // 1. Get ballot
    const ballot = await this.ballotManager.getBallot(vote.ballotId);
    if (!ballot) {
      this.penalizePeer(peerId, 'unknown_ballot');
      return;
    }

    // 2. Verify Freebird token (eligible?)
    const tokenValid = await this.freebird.verify(vote.proof);
    if (!tokenValid) {
      this.penalizePeer(peerId, 'invalid_proof');
      return;
    }

    // 3. Verify Witness attestation (in valid window?)
    const attestationValid = await this.witness.verify(vote.attestation);
    if (!attestationValid) {
      this.penalizePeer(peerId, 'invalid_attestation');
      return;
    }

    if (vote.attestation.timestamp * 1000 > ballot.deadline) {
      this.penalizePeer(peerId, 'too_late');
      return;
    }

    // 4. Check nullifier (already voted?)
    const key = `${vote.ballotId}:${vote.nullifier}`;
    const existing = this.nullifiers.get(key);

    if (existing) {
      // Already seen - increment peer count
      existing.peerCount++;

      // Check for commitment mismatch (double-vote attempt!)
      if (existing.commitment !== vote.commitment) {
        console.warn(
          `Double-vote detected! Nullifier: ${vote.nullifier}, ` +
          `original commitment: ${existing.commitment}, ` +
          `new commitment: ${vote.commitment}`
        );
        this.penalizePeer(peerId, 'double_vote');
      } else {
        // Duplicate, slight penalty
        this.penalizePeer(peerId, 'duplicate', 1);
      }
      return;
    }

    // 5. Accept and store
    this.nullifiers.set(key, {
      ballotId: vote.ballotId,
      nullifier: vote.nullifier,
      commitment: vote.commitment,
      timestamp: vote.attestation.timestamp,
      peerCount: 1,
    });

    await this.store.saveVote(vote);
    this.rewardPeer(peerId);

    // 6. Propagate to other peers (epidemic broadcast)
    await this.broadcastVote(vote);
  }

  /**
   * Handle an incoming reveal
   */
  private async onReceiveReveal(reveal: Reveal, peerId: string): Promise<void> {
    // Verify the reveal
    const ballot = await this.ballotManager.getBallot(reveal.ballotId);
    if (!ballot) {
      this.penalizePeer(peerId, 'unknown_ballot');
      return;
    }

    // Check ballot is in reveal phase
    if (!this.ballotManager.isAcceptingReveals(ballot)) {
      this.penalizePeer(peerId, 'wrong_phase');
      return;
    }

    // Find original vote
    const votes = await this.store.getVotesByBallot(reveal.ballotId);
    const originalVote = votes.find(v => v.nullifier === reveal.nullifier);
    if (!originalVote) {
      this.penalizePeer(peerId, 'no_matching_vote');
      return;
    }

    // Verify commitment
    const computedCommitment = Crypto.generateCommitment(reveal.choice, reveal.salt);
    if (!Crypto.constantTimeEqual(computedCommitment, originalVote.commitment)) {
      this.penalizePeer(peerId, 'invalid_reveal');
      return;
    }

    // Check for duplicate reveal
    const existingReveal = await this.store.getRevealByNullifier(
      reveal.ballotId,
      reveal.nullifier
    );
    if (existingReveal) {
      this.penalizePeer(peerId, 'duplicate', 1);
      return;
    }

    // Store and propagate
    await this.store.saveReveal(reveal);
    this.rewardPeer(peerId);
    await this.broadcastReveal(reveal);
  }

  /**
   * Handle an incoming ballot
   */
  private async onReceiveBallot(ballot: Ballot, peerId: string): Promise<void> {
    // Verify attestation
    const attestationValid = await this.witness.verify(ballot.attestation);
    if (!attestationValid) {
      this.penalizePeer(peerId, 'invalid_attestation');
      return;
    }

    // Check if we already have this ballot
    const existing = await this.store.getBallot(ballot.id);
    if (existing) {
      this.penalizePeer(peerId, 'duplicate', 1);
      return;
    }

    // Store and propagate
    await this.store.saveBallot(ballot);
    this.rewardPeer(peerId);
    await this.broadcastBallot(ballot);
  }

  /**
   * Handle an incoming result
   */
  private async onReceiveResult(result: Result, peerId: string): Promise<void> {
    // Verify attestation
    const attestationValid = await this.witness.verify(result.attestation);
    if (!attestationValid) {
      this.penalizePeer(peerId, 'invalid_attestation');
      return;
    }

    // Check if we already have this result
    const existing = await this.store.getResult(result.ballotId);
    if (existing) {
      this.penalizePeer(peerId, 'duplicate', 1);
      return;
    }

    // Store and propagate
    await this.store.saveResult(result);
    this.rewardPeer(peerId);
    await this.broadcastResult(result);
  }

  /**
   * Create a signed gossip message
   */
  private createMessage(type: GossipMessageType, payload: Vote | Reveal | Ballot | Result): GossipMessage {
    const nonce = Crypto.randomHex(16);
    const timestamp = Date.now();

    const content = Crypto.canonicalJson({
      type,
      payload,
      nonce,
      timestamp,
    });

    const signature = Crypto.sign(content, this.identity.privateKey);

    return {
      type,
      payload,
      sender: this.identity.publicKey,
      signature,
      nonce,
      timestamp,
    };
  }

  /**
   * Get or create peer score
   */
  private getPeerScore(peerId: string): PeerScore {
    let score = this.peerScores.get(peerId);
    if (!score) {
      score = {
        peerId,
        score: 100,
        validMessages: 0,
        invalidProofs: 0,
        duplicates: 0,
      };
      this.peerScores.set(peerId, score);
    }
    return score;
  }

  /**
   * Penalize a peer for bad behavior
   */
  private penalizePeer(peerId: string, reason: string, amount: number = 10): void {
    const score = this.getPeerScore(peerId);
    score.score -= amount;

    if (reason === 'invalid_proof') score.invalidProofs++;
    if (reason === 'duplicate') score.duplicates++;

    console.log(`Penalized peer ${peerId.slice(0, 8)} by ${amount} for ${reason}`);
  }

  /**
   * Reward a peer for good behavior
   */
  private rewardPeer(peerId: string, amount: number = 1): void {
    const score = this.getPeerScore(peerId);
    score.score = Math.min(100, score.score + amount);
    score.validMessages++;
  }

  /**
   * Prune old nullifiers to prevent memory exhaustion
   */
  private prune(): void {
    const now = Date.now();
    const maxAge = this.config.maxNullifierAge;
    let pruned = 0;

    for (const [key, entry] of this.nullifiers) {
      if (now - entry.timestamp > maxAge) {
        this.nullifiers.delete(key);
        pruned++;
      }
    }

    // Hard cap: remove oldest entries if over limit
    if (this.nullifiers.size > this.config.maxNullifiers) {
      const entries = Array.from(this.nullifiers.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);

      const toRemove = entries.slice(0, this.nullifiers.size - this.config.maxNullifiers);
      for (const [key] of toRemove) {
        this.nullifiers.delete(key);
        pruned++;
      }
    }

    if (pruned > 0) {
      console.log(`Pruned ${pruned} old nullifiers`);
    }
  }
}

/**
 * Nullifier check result
 */
interface NullifierCheck {
  seen: boolean;
  confidence: number;
  peerCount: number;
  commitment?: string;
  timestamp?: number;
}

/**
 * Petition Ballot Gate
 * Ballots require signatures to activate. Who can propose is controlled by a nested proposal gate.
 * Who can sign is controlled by the instance voter gate.
 */

import { Crypto } from '../../crypto.js';
import type { PrestigeStore } from '../../types.js';
import type { VoterGate } from '../types.js';
import type {
  BallotGate,
  GateResult,
  GateRequirements,
  PetitionSignature,
  PetitionStatus,
} from '../types.js';
import type { ProposalGate } from '../proposal/types.js';

export class PetitionBallotGate implements BallotGate {
  readonly type = 'petition' as const;

  constructor(
    private threshold: number,
    private store: PrestigeStore,
    private proposalGate: ProposalGate,
    private voterGate: VoterGate
  ) {}

  /**
   * Check proposal gate - not open to everyone
   * The proposal gate determines who can create petition ballots
   */
  async canCreate(publicKey: string): Promise<GateResult> {
    const result = await this.proposalGate.canPropose(publicKey);
    if (!result.allowed) {
      return result;
    }
    return {
      allowed: true,
      progress: { current: 0, required: this.threshold },
    };
  }

  getRequirements(): GateRequirements {
    const proposalReqs = this.proposalGate.getRequirements();
    return {
      type: 'petition',
      description: `Requires ${this.threshold} signatures to activate`,
      requirements: [
        `To propose: ${proposalReqs.description}`,
        'To sign: Must be eligible to vote on this instance',
        `Ballot activates when ${this.threshold} eligible voters sign`,
      ],
    };
  }

  /**
   * Get the signature threshold
   */
  getThreshold(): number {
    return this.threshold;
  }

  /**
   * Get the proposal gate for introspection
   */
  getProposalGate(): ProposalGate {
    return this.proposalGate;
  }

  /**
   * Get the voter gate for introspection
   */
  getVoterGate(): VoterGate {
    return this.voterGate;
  }

  /**
   * Get petition status for a ballot
   */
  async getPetitionStatus(ballotId: string): Promise<PetitionStatus | null> {
    const signatures = await this.store.getPetitionSignatures(ballotId);
    if (!signatures) {
      return null;
    }

    const activated = signatures.length >= this.threshold;
    const activatedSignature = activated
      ? signatures
          .slice()
          .sort((a, b) => a.timestamp - b.timestamp)[this.threshold - 1]
      : undefined;

    return {
      ballotId,
      required: this.threshold,
      current: signatures.length,
      signatures,
      activated,
      activatedAt: activatedSignature?.timestamp,
    };
  }

  /**
   * Add a signature to a petition
   * Must pass voter gate to sign
   * Returns true if the petition is now activated
   */
  async addSignature(
    ballotId: string,
    publicKey: string,
    signature: string
  ): Promise<{ added: boolean; activated: boolean; status: PetitionStatus }> {
    // Check voter gate first - only eligible voters can sign
    const canSign = await this.voterGate.canVote(publicKey);
    if (!canSign.allowed) {
      throw new PetitionError(
        canSign.reason ?? 'Not eligible to sign petitions',
        'NOT_ELIGIBLE'
      );
    }

    // Verify the signature is over the ballot ID
    const isValid = Crypto.verify(ballotId, signature, publicKey);
    if (!isValid) {
      throw new PetitionError('Invalid signature', 'INVALID_SIGNATURE');
    }

    // Check if already signed
    const existing = await this.store.getPetitionSignatures(ballotId);
    if (existing?.some((s) => s.publicKey === publicKey)) {
      const status = await this.getPetitionStatus(ballotId);
      return { added: false, activated: status?.activated ?? false, status: status! };
    }

    // Add the signature
    const petitionSignature: PetitionSignature = {
      ballotId,
      publicKey,
      signature,
      timestamp: Date.now(),
    };

    await this.store.savePetitionSignature(petitionSignature);

    // Check if now activated
    const status = await this.getPetitionStatus(ballotId);
    const wasActivated = (existing?.length ?? 0) < this.threshold;
    const nowActivated = status!.activated;
    const justActivated = wasActivated && nowActivated;

    return {
      added: true,
      activated: justActivated,
      status: status!,
    };
  }

  /**
   * Check if a ballot petition has met its threshold
   */
  async isActivated(ballotId: string): Promise<boolean> {
    const status = await this.getPetitionStatus(ballotId);
    return status?.activated ?? false;
  }
}

/**
 * Petition-specific error
 */
export class PetitionError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'PetitionError';
  }
}

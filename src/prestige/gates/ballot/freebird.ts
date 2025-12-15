/**
 * Freebird Ballot Gate
 * Anyone with a ballot-creation token can create ballots
 */

import type { FreebirdAdapter } from '../../adapters/freebird.js';
import type { CreateBallotRequest } from '../../types.js';
import type { BallotGate, GateResult, GateRequirements } from '../types.js';

/**
 * Token verification request for ballot creation
 */
export interface BallotCreationToken {
  blindedToken: string;
  proof: string;
  issuerPublicKey: string;
  expiresAt: number;
}

export class FreebirdBallotGate implements BallotGate {
  readonly type = 'freebird' as const;

  constructor(
    private freebird: FreebirdAdapter,
    private issuerPublicKey: string
  ) {}

  async canCreate(
    publicKey: string,
    request?: CreateBallotRequest & { creationToken?: BallotCreationToken }
  ): Promise<GateResult> {
    // Require a ballot creation token in the request
    const token = request?.creationToken;
    if (!token) {
      return {
        allowed: false,
        reason: 'Ballot creation token required',
      };
    }

    // Verify the token is from the correct issuer
    if (token.issuerPublicKey !== this.issuerPublicKey) {
      return {
        allowed: false,
        reason: 'Invalid token issuer',
      };
    }

    // Check expiration
    if (token.expiresAt < Date.now()) {
      return {
        allowed: false,
        reason: 'Ballot creation token expired',
      };
    }

    // Verify the token with Freebird
    const valid = await this.freebird.verify({
      blindedToken: token.blindedToken,
      proof: token.proof,
      issuerPublicKey: token.issuerPublicKey,
      expiresAt: token.expiresAt,
    });

    return {
      allowed: valid,
      reason: valid ? undefined : 'Invalid ballot creation token',
    };
  }

  getRequirements(): GateRequirements {
    return {
      type: 'freebird',
      description: 'Token-gated ballot creation',
      requirements: [
        'Must obtain a ballot creation token',
        'Token must be valid and not expired',
      ],
    };
  }
}

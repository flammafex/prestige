/**
 * Freebird Ballot Gate
 * Anyone with a ballot-creation token can create ballots
 */

import type { FreebirdAdapter } from '../../adapters/freebird.js';
import type { CreateBallotRequest } from '../../types.js';
import type { BallotGate, GateResult, GateRequirements } from '../types.js';

export class FreebirdBallotGate implements BallotGate {
  readonly type = 'freebird' as const;

  constructor(
    private freebird: FreebirdAdapter,
    private issuerId: string
  ) {}

  async canCreate(
    _publicKey: string,
    request?: CreateBallotRequest
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
    if (token.issuerId !== this.issuerId) {
      return {
        allowed: false,
        reason: 'Invalid token issuer',
      };
    }

    if (!Number.isInteger(token.epoch) || token.epoch < 0) {
      return {
        allowed: false,
        reason: 'Invalid ballot creation token epoch',
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
      issuerId: token.issuerId,
      issuerPublicKey: token.issuerPublicKey,
      expiresAt: token.expiresAt,
      epoch: token.epoch,
      kid: token.kid,
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

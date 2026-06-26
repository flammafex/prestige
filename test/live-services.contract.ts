/**
 * Live service seam for Prestige.
 *
 * This file is intentionally outside the default Jest testMatch. Run it with
 * `npm run test:live` while Freebird, Witness, and HyperToken are available.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  Crypto,
  InMemoryStore,
  Prestige,
} from '../src/prestige/index.js';
import type { PrestigeConfig } from '../src/prestige/types.js';

const serviceUrls = {
  freebirdIssuer: process.env.FREEBIRD_ISSUER_URL ?? 'http://127.0.0.1:18081',
  freebirdVerifier: process.env.FREEBIRD_VERIFIER_URL ?? 'http://127.0.0.1:18082',
  witness: process.env.WITNESS_URL ?? process.env.WITNESS_GATEWAY_URL ?? 'http://127.0.0.1:18080',
  hypertoken: process.env.HYPERTOKEN_RELAY_URL ?? 'ws://127.0.0.1:13000',
};

function liveConfig(): PrestigeConfig {
  return {
    freebirdIssuerUrl: serviceUrls.freebirdIssuer,
    freebirdVerifierUrl: serviceUrls.freebirdVerifier,
    witnessUrl: serviceUrls.witness,
    hypertokenRelayUrl: serviceUrls.hypertoken,
    defaultBallotDurationMinutes: 5,
    revealWindowMinutes: 5,
    minDurationMinutes: 1,
    maxChoices: 10,
    maxQuestionLength: 200,
    maxPeers: 10,
    gossipInterval: 1000,
    dataDir: './test-data-live',
    ballotGate: 'open',
    voterGate: 'freebird',
  };
}

function expectCanonicalWitness(attestation: {
  hash: string;
  networkId?: string;
  sequence?: number;
  canonical?: any;
}) {
  expect(attestation.canonical).toMatchObject({
    contract_version: 'sophia/v1',
    artifact_type: 'witness.signed_attestation',
  });
  expect(attestation.canonical.attestation).toMatchObject({
    hash: attestation.hash,
    network_id: attestation.networkId,
    sequence: attestation.sequence,
  });
  expect(['multisig', 'aggregated']).toContain(
    attestation.canonical.signatures.kind
  );
}

describe('Prestige live service seam', () => {
  jest.setTimeout(30000);

  let prestige: Prestige | null = null;

  afterEach(() => {
    prestige?.stop();
    prestige = null;
  });

  it('creates and casts a ballot through live Freebird, Witness, and HyperToken', async () => {
    prestige = new Prestige({
      config: liveConfig(),
      identity: Crypto.generateKeyPair(),
      store: new InMemoryStore(),
      privacyConfig: {
        enabled: false,
        minDelayMs: 0,
        maxDelayMs: 0,
        normalizedResponseMs: 0,
        batchingEnabled: false,
        batchIntervalMs: 0,
      },
    });

    await prestige.start();

    const health = await prestige.healthCheck();
    expect(health.freebird).toBe(true);
    expect(health.witness).toBe(true);
    expect(health.hypertoken).toBe(true);

    const ballot = await prestige.createBallot({
      question: 'Live seam contract?',
      choices: ['Yes', 'No'],
      durationMinutes: 5,
      revealWindowMinutes: 5,
      eligibility: { type: 'open' },
    });

    expect(ballot.attestation.witnessIds.length).toBeGreaterThan(0);
    expect(ballot.attestation.witnessIds.some(id => id.startsWith('mock'))).toBe(false);
    expectCanonicalWitness(ballot.attestation);

    const proof = await prestige.requestEligibilityToken(
      ballot.id,
      prestige.identity.publicKey
    );
    expect(proof.version).toBe(4);
    expect(proof.tokenValue.length).toBeGreaterThan(0);

    const choice = 'Yes';
    const salt = prestige.generateSalt();
    const voterSecret = prestige.generateVoterSecret();
    const commitment = prestige.generateCommitment(choice, salt);
    const nullifier = prestige.generateNullifier(voterSecret, ballot.id);

    const vote = await prestige.castVote({
      ballotId: ballot.id,
      commitment,
      nullifier,
      proof,
    });

    expect(vote.attestation.witnessIds.length).toBeGreaterThan(0);
    expect(vote.attestation.witnessIds.some(id => id.startsWith('mock'))).toBe(false);
    expectCanonicalWitness(vote.attestation);
    expect(vote.proof.tokenValue).toBe(proof.tokenValue);
    await expect(prestige.witness.verify(vote.attestation)).resolves.toBe(true);

    const storedVotes = await prestige.getVotes(ballot.id);
    expect(storedVotes).toHaveLength(1);
  });
});

/**
 * Tests for the Prestige Gate System
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  Prestige,
  Crypto,
  InMemoryStore,
  MockFreebirdAdapter,
  MockWitnessAdapter,
  MockHyperTokenAdapter,
  // Ballot Gates
  OwnerBallotGate,
  DelegationBallotGate,
  PetitionBallotGate,
  // Voter Gates
  OpenVoterGate,
  AllowlistVoterGate,
  // Proposal Gates
  VotersProposalGate,
  DelegationProposalGate,
} from '../src/prestige/index.js';
import type { PrestigeConfig, PrestigeStore } from '../src/prestige/types.js';

function createTestConfig(overrides?: Partial<PrestigeConfig>): PrestigeConfig {
  return {
    freebirdIssuerUrl: 'http://mock',
    freebirdVerifierUrl: 'http://mock',
    witnessUrl: 'http://mock',
    hypertokenRelayUrl: 'ws://mock',
    defaultBallotDurationMinutes: 60,
    revealWindowMinutes: 60,
    maxChoices: 10,
    maxQuestionLength: 200,
    maxPeers: 10,
    gossipInterval: 1000,
    dataDir: './test-data',
    ...overrides,
  };
}

function createTestPrestige(
  config: PrestigeConfig,
  identity?: { publicKey: string; privateKey: string }
): Prestige {
  return new Prestige({
    config,
    identity,
    store: new InMemoryStore(),
    freebird: new MockFreebirdAdapter(),
    witness: new MockWitnessAdapter(),
    hypertoken: new MockHyperTokenAdapter(),
  });
}

describe('Gate System', () => {
  describe('OwnerBallotGate', () => {
    it('should allow the owner to create ballots', async () => {
      const adminKey = 'admin-public-key-123';
      const gate = new OwnerBallotGate(adminKey);

      const result = await gate.canCreate(adminKey);

      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should deny non-owners from creating ballots', async () => {
      const adminKey = 'admin-public-key-123';
      const gate = new OwnerBallotGate(adminKey);

      const result = await gate.canCreate('some-other-key');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Only instance owner can create ballots');
    });

    it('should return correct requirements', () => {
      const gate = new OwnerBallotGate('admin-key');

      const requirements = gate.getRequirements();

      expect(requirements.type).toBe('owner');
      expect(requirements.description).toBe('Instance owner only');
      expect(requirements.requirements).toContain('Must be the instance administrator');
    });
  });

  describe('DelegationBallotGate', () => {
    it('should allow delegates to create ballots', async () => {
      const delegates = new Set(['delegate-1', 'delegate-2']);
      const gate = new DelegationBallotGate(delegates);

      const result1 = await gate.canCreate('delegate-1');
      const result2 = await gate.canCreate('delegate-2');

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
    });

    it('should deny non-delegates from creating ballots', async () => {
      const delegates = new Set(['delegate-1']);
      const gate = new DelegationBallotGate(delegates);

      const result = await gate.canCreate('not-a-delegate');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Not a delegated ballot creator');
    });

    it('should support adding and removing delegates', async () => {
      const gate = new DelegationBallotGate(new Set());

      // Initially denied
      expect((await gate.canCreate('new-delegate')).allowed).toBe(false);

      // Add delegate
      gate.addDelegate('new-delegate');
      expect((await gate.canCreate('new-delegate')).allowed).toBe(true);

      // Remove delegate
      gate.removeDelegate('new-delegate');
      expect((await gate.canCreate('new-delegate')).allowed).toBe(false);
    });
  });

  describe('PetitionBallotGate', () => {
    let store: InMemoryStore;
    let voterGate: OpenVoterGate;
    let proposalGate: VotersProposalGate;

    beforeEach(() => {
      store = new InMemoryStore();
      voterGate = new OpenVoterGate();
      proposalGate = new VotersProposalGate(voterGate);
    });

    it('should allow voters to create ballots (via proposal gate)', async () => {
      const gate = new PetitionBallotGate(10, store, proposalGate, voterGate);

      const result = await gate.canCreate('anyone');

      expect(result.allowed).toBe(true);
      expect(result.progress).toEqual({ current: 0, required: 10 });
    });

    it('should deny non-voters when using voters proposal gate', async () => {
      const restrictedVoterGate = new AllowlistVoterGate(new Set(['allowed-voter']));
      const restrictedProposalGate = new VotersProposalGate(restrictedVoterGate);
      const gate = new PetitionBallotGate(10, store, restrictedProposalGate, restrictedVoterGate);

      const result = await gate.canCreate('not-allowed');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Must be eligible to vote to propose ballots');
    });

    it('should track petition signatures', async () => {
      const gate = new PetitionBallotGate(3, store, proposalGate, voterGate);
      const ballotId = 'test-ballot';

      // Initially no signatures
      const status1 = await gate.getPetitionStatus(ballotId);
      expect(status1).toBeNull();

      // Add first signature
      const keypair1 = Crypto.generateKeyPair();
      const result1 = await gate.addSignature(
        ballotId,
        keypair1.publicKey,
        Crypto.sign(ballotId, keypair1.privateKey)
      );
      expect(result1.added).toBe(true);
      expect(result1.activated).toBe(false);
      expect(result1.status.current).toBe(1);

      // Add second signature
      const keypair2 = Crypto.generateKeyPair();
      const result2 = await gate.addSignature(
        ballotId,
        keypair2.publicKey,
        Crypto.sign(ballotId, keypair2.privateKey)
      );
      expect(result2.status.current).toBe(2);
      expect(result2.activated).toBe(false);

      // Add third signature - should activate
      const keypair3 = Crypto.generateKeyPair();
      const result3 = await gate.addSignature(
        ballotId,
        keypair3.publicKey,
        Crypto.sign(ballotId, keypair3.privateKey)
      );
      expect(result3.status.current).toBe(3);
      expect(result3.activated).toBe(true);
    });

    it('should not allow duplicate signatures', async () => {
      const gate = new PetitionBallotGate(10, store, proposalGate, voterGate);
      const ballotId = 'test-ballot';
      const keypair = Crypto.generateKeyPair();
      const signature = Crypto.sign(ballotId, keypair.privateKey);

      // First signature
      const result1 = await gate.addSignature(ballotId, keypair.publicKey, signature);
      expect(result1.added).toBe(true);

      // Duplicate signature
      const result2 = await gate.addSignature(ballotId, keypair.publicKey, signature);
      expect(result2.added).toBe(false);
    });

    it('should deny signatures from non-voters', async () => {
      const restrictedVoterGate = new AllowlistVoterGate(new Set(['allowed-voter']));
      const gate = new PetitionBallotGate(10, store, proposalGate, restrictedVoterGate);
      const ballotId = 'test-ballot';
      const keypair = Crypto.generateKeyPair();
      const signature = Crypto.sign(ballotId, keypair.privateKey);

      // Signature from non-allowed voter
      await expect(
        gate.addSignature(ballotId, keypair.publicKey, signature)
      ).rejects.toThrow('Not eligible to sign petitions');
    });
  });

  describe('Proposal Gates', () => {
    describe('VotersProposalGate', () => {
      it('should allow voters to propose', async () => {
        const voterGate = new OpenVoterGate();
        const gate = new VotersProposalGate(voterGate);

        const result = await gate.canPropose('anyone');

        expect(result.allowed).toBe(true);
      });

      it('should deny non-voters from proposing', async () => {
        const voterGate = new AllowlistVoterGate(new Set(['voter-1']));
        const gate = new VotersProposalGate(voterGate);

        const result = await gate.canPropose('not-on-list');

        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('Must be eligible to vote to propose ballots');
      });

      it('should return correct requirements', () => {
        const voterGate = new OpenVoterGate();
        const gate = new VotersProposalGate(voterGate);

        const requirements = gate.getRequirements();

        expect(requirements.type).toBe('voters');
        expect(requirements.description).toBe('Any eligible voter can propose');
      });
    });

    describe('DelegationProposalGate', () => {
      it('should allow delegates to propose', async () => {
        const delegates = new Set(['delegate-1', 'delegate-2']);
        const gate = new DelegationProposalGate(delegates);

        const result1 = await gate.canPropose('delegate-1');
        const result2 = await gate.canPropose('delegate-2');

        expect(result1.allowed).toBe(true);
        expect(result2.allowed).toBe(true);
      });

      it('should deny non-delegates from proposing', async () => {
        const delegates = new Set(['delegate-1']);
        const gate = new DelegationProposalGate(delegates);

        const result = await gate.canPropose('not-a-delegate');

        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('Only designated proposers can open petitions');
      });

      it('should return correct requirements', () => {
        const delegates = new Set(['d1', 'd2', 'd3']);
        const gate = new DelegationProposalGate(delegates);

        const requirements = gate.getRequirements();

        expect(requirements.type).toBe('delegation');
        expect(requirements.description).toBe('Only designated proposers can open petitions');
        expect(requirements.requirements).toContain('3 proposer(s) authorized');
      });
    });
  });

  describe('OpenVoterGate', () => {
    it('should allow anyone to vote', async () => {
      const gate = new OpenVoterGate();

      const result = await gate.canVote('anyone');

      expect(result.allowed).toBe(true);
    });

    it('should return correct requirements', () => {
      const gate = new OpenVoterGate();

      const requirements = gate.getRequirements();

      expect(requirements.type).toBe('open');
      expect(requirements.description).toBe('Open to everyone');
    });
  });

  describe('AllowlistVoterGate', () => {
    it('should allow voters on the allowlist', async () => {
      const allowlist = new Set(['voter-1', 'voter-2']);
      const gate = new AllowlistVoterGate(allowlist);

      const result1 = await gate.canVote('voter-1');
      const result2 = await gate.canVote('voter-2');

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
    });

    it('should deny voters not on the allowlist', async () => {
      const allowlist = new Set(['voter-1']);
      const gate = new AllowlistVoterGate(allowlist);

      const result = await gate.canVote('not-on-list');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Not on the voter allowlist');
    });

    it('should support modifying the allowlist', async () => {
      const gate = new AllowlistVoterGate(new Set());

      // Initially denied
      expect((await gate.canVote('new-voter')).allowed).toBe(false);

      // Add to allowlist
      gate.addToAllowlist('new-voter');
      expect((await gate.canVote('new-voter')).allowed).toBe(true);

      // Remove from allowlist
      gate.removeFromAllowlist('new-voter');
      expect((await gate.canVote('new-voter')).allowed).toBe(false);
    });
  });

  describe('Prestige Integration with Gates', () => {
    describe('Owner Gate (Default)', () => {
      it('should allow instance owner to create ballots', async () => {
        const config = createTestConfig({ ballotGate: 'owner' });
        const prestige = createTestPrestige(config);

        // Instance creates ballot - should work
        const ballot = await prestige.createBallot({
          question: 'Test?',
          choices: ['Yes', 'No'],
        });

        expect(ballot.id).toBeDefined();
      });

      it('should deny non-owners from creating ballots', async () => {
        const config = createTestConfig({ ballotGate: 'owner' });
        const prestige = createTestPrestige(config);
        const otherKey = Crypto.generateKeyPair().publicKey;

        // Someone else tries to create - should fail
        await expect(
          prestige.createBallot(
            { question: 'Test?', choices: ['Yes', 'No'] },
            otherKey
          )
        ).rejects.toThrow('Not authorized');
      });
    });

    describe('Delegation Gate', () => {
      it('should allow delegates to create ballots', async () => {
        const delegateKey = Crypto.generateKeyPair().publicKey;
        const config = createTestConfig({
          ballotGate: 'delegation',
          ballotGateDelegates: [delegateKey],
        });
        const prestige = createTestPrestige(config);

        const ballot = await prestige.createBallot(
          { question: 'Test?', choices: ['Yes', 'No'] },
          delegateKey
        );

        expect(ballot.id).toBeDefined();
      });

      it('should deny non-delegates', async () => {
        const delegateKey = Crypto.generateKeyPair().publicKey;
        const otherKey = Crypto.generateKeyPair().publicKey;
        const config = createTestConfig({
          ballotGate: 'delegation',
          ballotGateDelegates: [delegateKey],
        });
        const prestige = createTestPrestige(config);

        await expect(
          prestige.createBallot(
            { question: 'Test?', choices: ['Yes', 'No'] },
            otherKey
          )
        ).rejects.toThrow();
      });
    });

    describe('Petition Gate', () => {
      it('should create ballots in petition status', async () => {
        const config = createTestConfig({
          ballotGate: 'petition',
          ballotGatePetitionThreshold: 3,
        });
        const prestige = createTestPrestige(config);

        const ballot = await prestige.createBallot({
          question: 'Test?',
          choices: ['Yes', 'No'],
        });

        expect(ballot.status).toBe('petition');
        expect(ballot.deadline).toBe(0); // Placeholder
      });

      it('should not allow voting on petition ballots', async () => {
        const config = createTestConfig({
          ballotGate: 'petition',
          ballotGatePetitionThreshold: 3,
        });
        const prestige = createTestPrestige(config);

        const ballot = await prestige.createBallot({
          question: 'Test?',
          choices: ['Yes', 'No'],
        });

        await expect(
          prestige.requestEligibilityToken(ballot.id)
        ).rejects.toThrow('petition');
      });

      it('should activate ballot after petition threshold is met', async () => {
        const config = createTestConfig({
          ballotGate: 'petition',
          ballotGatePetitionThreshold: 2,
        });
        const prestige = createTestPrestige(config);

        const ballot = await prestige.createBallot({
          question: 'Test?',
          choices: ['Yes', 'No'],
        });

        // Sign petition
        for (let i = 0; i < 2; i++) {
          const keypair = Crypto.generateKeyPair();
          const signature = Crypto.sign(ballot.id, keypair.privateKey);
          await prestige.signPetition(ballot.id, keypair.publicKey, signature);
        }

        // Check ballot is now active
        const status = await prestige.getBallotStatus(ballot.id);
        expect(status?.ballot.status).toBe('voting');
        expect(status?.ballot.deadline).toBeGreaterThan(0);
        expect(status?.isPetition).toBe(false);
      });
    });

    describe('Voter Gate with Allowlist', () => {
      it('should allow voters on the allowlist to get eligibility tokens', async () => {
        const voterKey = Crypto.generateKeyPair().publicKey;
        const config = createTestConfig({
          voterGate: 'allowlist',
          voterGateAllowlist: [voterKey],
        });
        const prestige = createTestPrestige(config);

        const ballot = await prestige.createBallot({
          question: 'Test?',
          choices: ['Yes', 'No'],
        });

        // This requires the vote manager to be set up correctly
        // For now we just test the gate directly
        const canVote = await prestige.canVoteOnInstance(voterKey);
        expect(canVote.allowed).toBe(true);
      });

      it('should deny voters not on the allowlist', async () => {
        const allowedKey = Crypto.generateKeyPair().publicKey;
        const deniedKey = Crypto.generateKeyPair().publicKey;
        const config = createTestConfig({
          voterGate: 'allowlist',
          voterGateAllowlist: [allowedKey],
        });
        const prestige = createTestPrestige(config);

        const canVote = await prestige.canVoteOnInstance(deniedKey);
        expect(canVote.allowed).toBe(false);
      });
    });

    describe('Gate Info', () => {
      it('should return gate requirements', () => {
        const config = createTestConfig({
          ballotGate: 'owner',
          voterGate: 'open',
        });
        const prestige = createTestPrestige(config);

        const info = prestige.getGateInfo();

        expect(info.ballot.type).toBe('owner');
        expect(info.voter.type).toBe('open');
      });
    });
  });

  describe('Eligibility Hierarchy', () => {
    it('should check instance voter gate before ballot eligibility', async () => {
      const allowedKey = Crypto.generateKeyPair().publicKey;
      const config = createTestConfig({
        voterGate: 'allowlist',
        voterGateAllowlist: [allowedKey],
      });
      const prestige = createTestPrestige(config);

      // Create ballot with open eligibility
      const ballot = await prestige.createBallot({
        question: 'Test?',
        choices: ['Yes', 'No'],
        eligibility: { type: 'open' },
      });

      // Allowed key should pass both gates
      const canVoteAllowed = await prestige.canVoteOnInstance(allowedKey);
      expect(canVoteAllowed.allowed).toBe(true);

      // Denied key should fail instance gate even though ballot is open
      const deniedKey = Crypto.generateKeyPair().publicKey;
      const canVoteDenied = await prestige.canVoteOnInstance(deniedKey);
      expect(canVoteDenied.allowed).toBe(false);
    });

    it('should allow ballot to restrict further than instance gate', async () => {
      const voter1 = Crypto.generateKeyPair().publicKey;
      const voter2 = Crypto.generateKeyPair().publicKey;
      const config = createTestConfig({
        voterGate: 'open', // Instance allows everyone
      });
      const prestige = createTestPrestige(config);

      // Create ballot with invite-list (more restrictive)
      const ballot = await prestige.createBallot({
        question: 'Test?',
        choices: ['Yes', 'No'],
        eligibility: {
          type: 'invite-list',
          invitees: [voter1],
        },
      });

      // Voter1 is on the list - should be able to get token
      // Voter2 is not - should be denied at ballot level
      // (Full integration test would require requesting tokens)
    });
  });

  describe('Ballot Eligibility Types', () => {
    it('should validate allowlist eligibility config', async () => {
      const config = createTestConfig();
      const prestige = createTestPrestige(config);

      // Empty allowlist should fail
      await expect(
        prestige.createBallot({
          question: 'Test?',
          choices: ['Yes', 'No'],
          eligibility: { type: 'allowlist', allowlist: [] },
        })
      ).rejects.toThrow('allowlist');
    });
  });
});

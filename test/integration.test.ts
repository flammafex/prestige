/**
 * Integration tests for Prestige voting system
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  createTestPrestige,
  Prestige,
  Crypto,
  InMemoryStore,
  MockFreebirdAdapter,
  MockWitnessAdapter,
  MockHyperTokenAdapter,
} from '../src/prestige/index.js';

describe('Prestige Integration', () => {
  let prestige: Prestige;

  beforeEach(() => {
    prestige = createTestPrestige();
  });

  describe('Ballot Lifecycle', () => {
    it('should create a ballot', async () => {
      const ballot = await prestige.createBallot({
        question: 'What is the best color?',
        choices: ['Red', 'Blue', 'Green'],
        durationMinutes: 60,
      });

      expect(ballot.id).toBeDefined();
      expect(ballot.question).toBe('What is the best color?');
      expect(ballot.choices).toEqual(['Red', 'Blue', 'Green']);
      expect(ballot.status).toBe('voting');
      expect(ballot.attestation).toBeDefined();
    });

    it('should retrieve a ballot by ID', async () => {
      const created = await prestige.createBallot({
        question: 'Test question',
        choices: ['A', 'B'],
      });

      const retrieved = await prestige.getBallot(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.question).toBe(created.question);
    });

    it('should list ballots', async () => {
      await prestige.createBallot({
        question: 'Question 1',
        choices: ['A', 'B'],
      });

      await prestige.createBallot({
        question: 'Question 2',
        choices: ['X', 'Y'],
      });

      const ballots = await prestige.listBallots();

      expect(ballots.length).toBe(2);
    });

    it('should validate ballot creation', async () => {
      // Missing choices
      await expect(
        prestige.createBallot({
          question: 'Test',
          choices: ['Only one'],
        })
      ).rejects.toThrow();

      // Empty question
      await expect(
        prestige.createBallot({
          question: '',
          choices: ['A', 'B'],
        })
      ).rejects.toThrow();
    });
  });

  describe('Voting', () => {
    it('should cast a vote with commitment', async () => {
      const ballot = await prestige.createBallot({
        question: 'Test vote',
        choices: ['Yes', 'No'],
        durationMinutes: 60,
      });

      const voterSecret = prestige.generateVoterSecret();
      const salt = prestige.generateSalt();
      const choice = 'Yes';

      const commitment = prestige.generateCommitment(choice, salt);
      const nullifier = prestige.generateNullifier(voterSecret, ballot.id);
      const proof = await prestige.requestEligibilityToken(ballot.id);

      const vote = await prestige.castVote({
        ballotId: ballot.id,
        commitment,
        nullifier,
        proof,
      });

      expect(vote.ballotId).toBe(ballot.id);
      expect(vote.commitment).toBe(commitment);
      expect(vote.nullifier).toBe(nullifier);
    });

    it('should prevent double voting', async () => {
      const ballot = await prestige.createBallot({
        question: 'Test',
        choices: ['A', 'B'],
        durationMinutes: 60,
      });

      const voterSecret = prestige.generateVoterSecret();
      const salt = prestige.generateSalt();
      const commitment = prestige.generateCommitment('A', salt);
      const nullifier = prestige.generateNullifier(voterSecret, ballot.id);
      const proof = await prestige.requestEligibilityToken(ballot.id);

      // First vote should succeed
      await prestige.castVote({
        ballotId: ballot.id,
        commitment,
        nullifier,
        proof,
      });

      // Second vote with same nullifier should fail
      const proof2 = await prestige.requestEligibilityToken(ballot.id);
      await expect(
        prestige.castVote({
          ballotId: ballot.id,
          commitment: prestige.generateCommitment('B', prestige.generateSalt()),
          nullifier, // Same nullifier!
          proof: proof2,
        })
      ).rejects.toThrow('already voted');
    });

    it('should track vote count', async () => {
      const ballot = await prestige.createBallot({
        question: 'Test',
        choices: ['A', 'B'],
        durationMinutes: 60,
      });

      // Cast 3 votes
      for (let i = 0; i < 3; i++) {
        const voterSecret = prestige.generateVoterSecret();
        const salt = prestige.generateSalt();
        const commitment = prestige.generateCommitment('A', salt);
        const nullifier = prestige.generateNullifier(voterSecret, ballot.id);
        const proof = await prestige.requestEligibilityToken(ballot.id);

        await prestige.castVote({
          ballotId: ballot.id,
          commitment,
          nullifier,
          proof,
        });
      }

      const votes = await prestige.getVotes(ballot.id);
      expect(votes.length).toBe(3);
    });
  });

  describe('Commit-Reveal Scheme', () => {
    it('should complete full commit-reveal cycle', async () => {
      // Create ballot with very short duration for testing
      const ballot = await prestige.createBallot({
        question: 'Test commit-reveal',
        choices: ['Option A', 'Option B'],
        durationMinutes: 1, // Very short for testing
        revealWindowMinutes: 1,
      });

      // Cast votes
      const voters = [
        { choice: 'Option A' },
        { choice: 'Option A' },
        { choice: 'Option B' },
      ];

      const voteData = [];

      for (const voter of voters) {
        const voterSecret = prestige.generateVoterSecret();
        const salt = prestige.generateSalt();
        const commitment = prestige.generateCommitment(voter.choice, salt);
        const nullifier = prestige.generateNullifier(voterSecret, ballot.id);
        const proof = await prestige.requestEligibilityToken(ballot.id);

        await prestige.castVote({
          ballotId: ballot.id,
          commitment,
          nullifier,
          proof,
        });

        voteData.push({
          choice: voter.choice,
          salt,
          nullifier,
        });
      }

      // Verify votes were cast
      const votes = await prestige.getVotes(ballot.id);
      expect(votes.length).toBe(3);

      // Manually advance ballot to reveal phase for testing
      const storedBallot = await prestige.getBallot(ballot.id);
      if (storedBallot) {
        // Manually set deadline to past for reveal phase
        (storedBallot as any).deadline = Date.now() - 1000;
        await (prestige.store as InMemoryStore).saveBallot(storedBallot);
      }

      // Submit reveals
      for (const vote of voteData) {
        await prestige.submitReveal({
          ballotId: ballot.id,
          nullifier: vote.nullifier,
          choice: vote.choice,
          salt: vote.salt,
        });
      }

      // Check reveals
      const reveals = await prestige.getReveals(ballot.id);
      expect(reveals.length).toBe(3);

      // Get reveal stats
      const stats = await prestige.getRevealStats(ballot.id);
      expect(stats.totalVotes).toBe(3);
      expect(stats.totalReveals).toBe(3);
      expect(stats.validReveals).toBe(3);
      expect(stats.invalidReveals).toBe(0);
    });

    it('should reject invalid reveals', async () => {
      const ballot = await prestige.createBallot({
        question: 'Test',
        choices: ['A', 'B'],
        durationMinutes: 1,
      });

      const voterSecret = prestige.generateVoterSecret();
      const salt = prestige.generateSalt();
      const commitment = prestige.generateCommitment('A', salt);
      const nullifier = prestige.generateNullifier(voterSecret, ballot.id);
      const proof = await prestige.requestEligibilityToken(ballot.id);

      await prestige.castVote({
        ballotId: ballot.id,
        commitment,
        nullifier,
        proof,
      });

      // Advance to reveal phase
      const storedBallot = await prestige.getBallot(ballot.id);
      if (storedBallot) {
        (storedBallot as any).deadline = Date.now() - 1000;
        await (prestige.store as InMemoryStore).saveBallot(storedBallot);
      }

      // Try to reveal wrong choice
      await expect(
        prestige.submitReveal({
          ballotId: ballot.id,
          nullifier,
          choice: 'B', // Wrong! Committed to 'A'
          salt,
        })
      ).rejects.toThrow('does not match');
    });

    it('should reject reveals with wrong salt', async () => {
      const ballot = await prestige.createBallot({
        question: 'Test',
        choices: ['A', 'B'],
        durationMinutes: 1,
      });

      const voterSecret = prestige.generateVoterSecret();
      const salt = prestige.generateSalt();
      const commitment = prestige.generateCommitment('A', salt);
      const nullifier = prestige.generateNullifier(voterSecret, ballot.id);
      const proof = await prestige.requestEligibilityToken(ballot.id);

      await prestige.castVote({
        ballotId: ballot.id,
        commitment,
        nullifier,
        proof,
      });

      // Advance to reveal phase
      const storedBallot = await prestige.getBallot(ballot.id);
      if (storedBallot) {
        (storedBallot as any).deadline = Date.now() - 1000;
        await (prestige.store as InMemoryStore).saveBallot(storedBallot);
      }

      // Try to reveal with wrong salt
      await expect(
        prestige.submitReveal({
          ballotId: ballot.id,
          nullifier,
          choice: 'A',
          salt: prestige.generateSalt(), // Wrong salt!
        })
      ).rejects.toThrow('does not match');
    });
  });

  describe('Results', () => {
    it('should compute tally correctly', async () => {
      const ballot = await prestige.createBallot({
        question: 'Test',
        choices: ['X', 'Y', 'Z'],
        durationMinutes: 1,
        revealWindowMinutes: 0.001,
      });

      // Vote and reveal: 2 for X, 1 for Y, 0 for Z
      const votes = [
        { choice: 'X' },
        { choice: 'X' },
        { choice: 'Y' },
      ];

      const voteData = [];

      for (const v of votes) {
        const voterSecret = prestige.generateVoterSecret();
        const salt = prestige.generateSalt();
        const commitment = prestige.generateCommitment(v.choice, salt);
        const nullifier = prestige.generateNullifier(voterSecret, ballot.id);
        const proof = await prestige.requestEligibilityToken(ballot.id);

        await prestige.castVote({
          ballotId: ballot.id,
          commitment,
          nullifier,
          proof,
        });

        voteData.push({ choice: v.choice, salt, nullifier });
      }

      // Advance to reveal phase
      const storedBallot = await prestige.getBallot(ballot.id);
      if (storedBallot) {
        (storedBallot as any).deadline = Date.now() - 1000;
        await (prestige.store as InMemoryStore).saveBallot(storedBallot);
      }

      // Reveal all
      for (const v of voteData) {
        await prestige.submitReveal({
          ballotId: ballot.id,
          nullifier: v.nullifier,
          choice: v.choice,
          salt: v.salt,
        });
      }

      // Advance past reveal deadline
      const ballot2 = await prestige.getBallot(ballot.id);
      if (ballot2) {
        (ballot2 as any).revealDeadline = Date.now() - 1000;
        await (prestige.store as InMemoryStore).saveBallot(ballot2);
      }

      // Get results
      const result = await prestige.getResults(ballot.id);

      expect(result).toBeDefined();
      expect(result?.tally['X']).toBe(2);
      expect(result?.tally['Y']).toBe(1);
      expect(result?.tally['Z']).toBe(0);
      expect(result?.totalVotes).toBe(3);
      expect(result?.validReveals).toBe(3);
    });

    it('should get live tally during reveal phase', async () => {
      const ballot = await prestige.createBallot({
        question: 'Test',
        choices: ['A', 'B'],
        durationMinutes: 1,
      });

      const voterSecret = prestige.generateVoterSecret();
      const salt = prestige.generateSalt();
      const commitment = prestige.generateCommitment('A', salt);
      const nullifier = prestige.generateNullifier(voterSecret, ballot.id);
      const proof = await prestige.requestEligibilityToken(ballot.id);

      await prestige.castVote({
        ballotId: ballot.id,
        commitment,
        nullifier,
        proof,
      });

      // Advance to reveal phase (but not finalized)
      const storedBallot = await prestige.getBallot(ballot.id);
      if (storedBallot) {
        (storedBallot as any).deadline = Date.now() - 1000;
        await (prestige.store as InMemoryStore).saveBallot(storedBallot);
      }

      await prestige.submitReveal({
        ballotId: ballot.id,
        nullifier,
        choice: 'A',
        salt,
      });

      const liveTally = await prestige.getLiveTally(ballot.id);

      expect(liveTally.totalVotes).toBe(1);
      expect(liveTally.totalReveals).toBe(1);
      expect(liveTally.tally['A']).toBe(1);
      expect(liveTally.isFinalized).toBe(false);
    });
  });

  describe('Eligibility', () => {
    it('should issue tokens for open ballots', async () => {
      const ballot = await prestige.createBallot({
        question: 'Open ballot',
        choices: ['A', 'B'],
        eligibility: { type: 'open' },
      });

      const token = await prestige.requestEligibilityToken(ballot.id);

      expect(token).toBeDefined();
      expect(token.blindedToken).toBeDefined();
      expect(token.expiresAt).toBeGreaterThan(Date.now());
    });
  });

  describe('Cryptographic Helpers', () => {
    it('should generate voter secrets', () => {
      const secret1 = prestige.generateVoterSecret();
      const secret2 = prestige.generateVoterSecret();

      expect(secret1.length).toBe(64);
      expect(secret2.length).toBe(64);
      expect(secret1).not.toBe(secret2);
    });

    it('should generate salts', () => {
      const salt1 = prestige.generateSalt();
      const salt2 = prestige.generateSalt();

      expect(salt1.length).toBe(64);
      expect(salt2.length).toBe(64);
      expect(salt1).not.toBe(salt2);
    });

    it('should generate consistent commitments', () => {
      const choice = 'Test';
      const salt = prestige.generateSalt();

      const c1 = prestige.generateCommitment(choice, salt);
      const c2 = prestige.generateCommitment(choice, salt);

      expect(c1).toBe(c2);
    });

    it('should generate consistent nullifiers', () => {
      const secret = prestige.generateVoterSecret();
      const ballotId = 'test-ballot';

      const n1 = prestige.generateNullifier(secret, ballotId);
      const n2 = prestige.generateNullifier(secret, ballotId);

      expect(n1).toBe(n2);
    });
  });
});

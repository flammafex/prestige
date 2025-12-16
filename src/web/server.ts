/**
 * Prestige Web Server
 * Express API for ballot creation, voting, and results
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  createPrestige,
  createTestPrestige,
  Crypto,
} from '../prestige/index.js';
import type {
  CreateBallotRequest,
  CastVoteRequest,
  SubmitRevealRequest,
} from '../prestige/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Prestige - use mocks for MVP/dev mode
const useMocks = process.env.USE_MOCKS === 'true' || !process.env.WITNESS_URL;
const prestige = useMocks ? createTestPrestige() : createPrestige();
if (useMocks) {
  console.log('Running in mock mode (no external services required)');
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Static files
app.use(express.static(join(__dirname, 'public')));

// Request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ============= Health & Info =============

app.get('/health', async (_req: Request, res: Response) => {
  try {
    const status = await prestige.healthCheck();
    res.json(status);
  } catch (error) {
    res.status(500).json({ healthy: false, error: String(error) });
  }
});

app.get('/api/info', (_req: Request, res: Response) => {
  res.json({
    name: 'Prestige',
    version: '0.1.0',
    description: 'Anonymous verifiable voting - Secret ballot, public proof',
    identity: prestige.identity.publicKey,
    gates: prestige.getGateInfo(),
  });
});

// ============= Gate Endpoints =============

/**
 * GET /api/gates - Get gate configuration info
 */
app.get('/api/gates', (_req: Request, res: Response) => {
  res.json(prestige.getGateInfo());
});

/**
 * POST /api/gates/ballot/check - Check if a public key can create ballots
 */
app.post('/api/gates/ballot/check', async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.body;
    if (!publicKey) {
      res.status(400).json({ error: 'publicKey is required' });
      return;
    }
    const result = await prestige.canCreateBallot(publicKey);
    res.json(result);
  } catch (error: any) {
    console.error('Error checking ballot gate:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

/**
 * POST /api/gates/voter/check - Check if a public key can vote on the instance
 */
app.post('/api/gates/voter/check', async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.body;
    if (!publicKey) {
      res.status(400).json({ error: 'publicKey is required' });
      return;
    }
    const result = await prestige.canVoteOnInstance(publicKey);
    res.json(result);
  } catch (error: any) {
    console.error('Error checking voter gate:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

// ============= Ballot Endpoints =============

/**
 * POST /api/ballot - Create a new ballot
 *
 * For non-server ballots, include X-Public-Key and X-Signature headers
 * to verify the creator's identity against the ballot gate.
 */
app.post('/api/ballot', async (req: Request, res: Response) => {
  try {
    const request: CreateBallotRequest = {
      question: req.body.question,
      choices: req.body.choices,
      durationMinutes: req.body.durationMinutes,
      revealWindowMinutes: req.body.revealWindowMinutes,
      eligibility: req.body.eligibility,
    };

    // Check for client-side signing
    const publicKey = req.headers['x-public-key'] as string | undefined;
    const signature = req.headers['x-signature'] as string | undefined;

    let creatorPublicKey: string | undefined;

    if (publicKey && signature) {
      // Verify the request signature
      const body = JSON.stringify(req.body);
      const isValid = Crypto.verify(body, signature, publicKey);
      if (!isValid) {
        res.status(401).json({ error: 'Invalid signature', code: 'INVALID_SIGNATURE' });
        return;
      }
      creatorPublicKey = publicKey;
    }

    // createBallot will check the ballot gate internally
    const ballot = await prestige.createBallot(request, creatorPublicKey);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const shareUrl = prestige.generateShareUrl(ballot, baseUrl);

    res.status(201).json({
      ballot,
      shareUrl,
    });
  } catch (error: any) {
    console.error('Error creating ballot:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
      requirements: error.code === 'NOT_AUTHORIZED'
        ? prestige.getBallotGateRequirements()
        : undefined,
    });
  }
});

/**
 * GET /api/ballot/:id - Get ballot details
 */
app.get('/api/ballot/:id', async (req: Request, res: Response) => {
  try {
    const ballot = await prestige.getBallot(req.params.id);
    if (!ballot) {
      res.status(404).json({ error: 'Ballot not found', code: 'BALLOT_NOT_FOUND' });
      return;
    }
    res.json(ballot);
  } catch (error: any) {
    console.error('Error getting ballot:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

/**
 * GET /api/ballot/:id/status - Get ballot status
 */
app.get('/api/ballot/:id/status', async (req: Request, res: Response) => {
  try {
    const status = await prestige.getBallotStatus(req.params.id);
    if (!status) {
      res.status(404).json({ error: 'Ballot not found', code: 'BALLOT_NOT_FOUND' });
      return;
    }
    res.json(status);
  } catch (error: any) {
    console.error('Error getting ballot status:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

/**
 * GET /api/ballots - List all ballots
 */
app.get('/api/ballots', async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    const ballots = await prestige.listBallots({ status, limit });
    res.json(ballots);
  } catch (error: any) {
    console.error('Error listing ballots:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

// ============= Petition Endpoints =============

/**
 * POST /api/ballot/:id/petition - Sign a petition to activate a ballot
 */
app.post('/api/ballot/:id/petition', async (req: Request, res: Response) => {
  try {
    const { publicKey, signature } = req.body;
    if (!publicKey || !signature) {
      res.status(400).json({ error: 'publicKey and signature are required' });
      return;
    }

    const result = await prestige.signPetition(req.params.id, publicKey, signature);
    res.json(result);
  } catch (error: any) {
    console.error('Error signing petition:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

/**
 * GET /api/ballot/:id/petition - Get petition status
 */
app.get('/api/ballot/:id/petition', async (req: Request, res: Response) => {
  try {
    const status = await prestige.getPetitionStatus(req.params.id);
    if (!status) {
      res.status(404).json({
        error: 'Petition status not available (not using petition gate or ballot not found)',
        code: 'NOT_FOUND',
      });
      return;
    }
    res.json(status);
  } catch (error: any) {
    console.error('Error getting petition status:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

// ============= Vote Endpoints =============

/**
 * POST /api/vote - Cast a vote
 */
app.post('/api/vote', async (req: Request, res: Response) => {
  try {
    const request: CastVoteRequest = {
      ballotId: req.body.ballotId,
      commitment: req.body.commitment,
      nullifier: req.body.nullifier,
      proof: req.body.proof,
    };

    const vote = await prestige.castVote(request);
    res.status(201).json(vote);
  } catch (error: any) {
    console.error('Error casting vote:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

/**
 * GET /api/votes/:ballotId - Get all votes (commitments) for a ballot
 */
app.get('/api/votes/:ballotId', async (req: Request, res: Response) => {
  try {
    const votes = await prestige.getVotes(req.params.ballotId);
    res.json(votes);
  } catch (error: any) {
    console.error('Error getting votes:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

/**
 * POST /api/token/:ballotId - Request eligibility token
 */
app.post('/api/token/:ballotId', async (req: Request, res: Response) => {
  try {
    const token = await prestige.requestEligibilityToken(req.params.ballotId);
    res.json(token);
  } catch (error: any) {
    console.error('Error requesting token:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

// ============= Reveal Endpoints =============

/**
 * POST /api/reveal - Submit a reveal
 */
app.post('/api/reveal', async (req: Request, res: Response) => {
  try {
    const request: SubmitRevealRequest = {
      ballotId: req.body.ballotId,
      nullifier: req.body.nullifier,
      choice: req.body.choice,
      salt: req.body.salt,
    };

    const reveal = await prestige.submitReveal(request);
    res.status(201).json(reveal);
  } catch (error: any) {
    console.error('Error submitting reveal:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

/**
 * GET /api/reveals/:ballotId - Get all reveals for a ballot
 */
app.get('/api/reveals/:ballotId', async (req: Request, res: Response) => {
  try {
    const reveals = await prestige.getReveals(req.params.ballotId);
    res.json(reveals);
  } catch (error: any) {
    console.error('Error getting reveals:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

/**
 * GET /api/reveals/:ballotId/stats - Get reveal statistics
 */
app.get('/api/reveals/:ballotId/stats', async (req: Request, res: Response) => {
  try {
    const stats = await prestige.getRevealStats(req.params.ballotId);
    res.json(stats);
  } catch (error: any) {
    console.error('Error getting reveal stats:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

// ============= Results Endpoints =============

/**
 * GET /api/results/:ballotId - Get final results
 * Results are hidden until the ballot is finalized for coercion resistance
 */
app.get('/api/results/:ballotId', async (req: Request, res: Response) => {
  try {
    const status = await prestige.getBallotStatus(req.params.ballotId);
    if (!status) {
      res.status(404).json({ error: 'Ballot not found', code: 'BALLOT_NOT_FOUND' });
      return;
    }

    // Hide results until finalized for coercion resistance
    if (!status.isFinalized) {
      res.status(403).json({
        error: 'Results are hidden until voting and reveal phases are complete',
        code: 'RESULTS_HIDDEN',
        status: status.ballot.status,
        revealDeadline: status.ballot.revealDeadline,
      });
      return;
    }

    const result = await prestige.getResults(req.params.ballotId);
    if (!result) {
      res.status(404).json({ error: 'Results not available', code: 'RESULTS_NOT_FOUND' });
      return;
    }
    res.json(result);
  } catch (error: any) {
    console.error('Error getting results:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

/**
 * GET /api/results/:ballotId/live - Get live tally
 * Disabled for coercion resistance - results hidden until finalized
 */
app.get('/api/results/:ballotId/live', async (req: Request, res: Response) => {
  try {
    const status = await prestige.getBallotStatus(req.params.ballotId);
    if (!status) {
      res.status(404).json({ error: 'Ballot not found', code: 'BALLOT_NOT_FOUND' });
      return;
    }

    // Hide live tally for coercion resistance
    if (!status.isFinalized) {
      res.status(403).json({
        error: 'Live tally is disabled for coercion resistance',
        code: 'RESULTS_HIDDEN',
        status: status.ballot.status,
      });
      return;
    }

    // If finalized, return final results instead
    const liveTally = await prestige.getLiveTally(req.params.ballotId);
    res.json(liveTally);
  } catch (error: any) {
    console.error('Error getting live tally:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

/**
 * GET /api/results/:ballotId/verify - Get verification report
 */
app.get('/api/results/:ballotId/verify', async (req: Request, res: Response) => {
  try {
    const report = await prestige.getVerificationReport(req.params.ballotId);
    res.json(report);
  } catch (error: any) {
    console.error('Error getting verification report:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

// ============= Client-Side Crypto Helpers =============

/**
 * POST /api/crypto/commitment - Generate commitment (for testing)
 * In production, this should be done client-side
 */
app.post('/api/crypto/commitment', (req: Request, res: Response) => {
  const { choice, salt } = req.body;
  if (!choice || !salt) {
    res.status(400).json({ error: 'Missing choice or salt' });
    return;
  }
  const commitment = prestige.generateCommitment(choice, salt);
  res.json({ commitment });
});

/**
 * POST /api/crypto/nullifier - Generate nullifier (for testing)
 * In production, this should be done client-side
 */
app.post('/api/crypto/nullifier', (req: Request, res: Response) => {
  const { voterSecret, ballotId } = req.body;
  if (!voterSecret || !ballotId) {
    res.status(400).json({ error: 'Missing voterSecret or ballotId' });
    return;
  }
  const nullifier = prestige.generateNullifier(voterSecret, ballotId);
  res.json({ nullifier });
});

/**
 * GET /api/crypto/salt - Generate random salt
 */
app.get('/api/crypto/salt', (_req: Request, res: Response) => {
  const salt = prestige.generateSalt();
  res.json({ salt });
});

/**
 * GET /api/crypto/secret - Generate voter secret
 */
app.get('/api/crypto/secret', (_req: Request, res: Response) => {
  const secret = prestige.generateVoterSecret();
  res.json({ secret });
});

/**
 * POST /api/crypto/sign - Sign a message with private key
 * Used for petition signing where client needs Ed25519 signature
 */
app.post('/api/crypto/sign', (req: Request, res: Response) => {
  const { message, privateKey } = req.body;
  if (!message || !privateKey) {
    res.status(400).json({ error: 'Missing message or privateKey' });
    return;
  }
  try {
    const signature = Crypto.sign(message, privateKey);
    res.json({ signature });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Signing failed' });
  }
});

// ============= Page Routes =============

// Serve ballot page for /b/:id
app.get('/b/:id', (_req: Request, res: Response) => {
  res.sendFile(join(__dirname, 'public', 'ballot.html'));
});

// Serve results page for /r/:id
app.get('/r/:id', (_req: Request, res: Response) => {
  res.sendFile(join(__dirname, 'public', 'results.html'));
});

// Catch-all for SPA (Express 5 syntax)
app.get('{*splat}', (_req: Request, res: Response) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function start() {
  try {
    await prestige.start();

    app.listen(PORT, () => {
      console.log(`Prestige server running on port ${PORT}`);
      console.log(`Identity: ${prestige.identity.publicKey}`);
      console.log(`Ballot Gate: ${prestige.ballotGate.type}`);
      console.log(`Voter Gate: ${prestige.voterGate.type}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  prestige.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  prestige.stop();
  process.exit(0);
});

start();

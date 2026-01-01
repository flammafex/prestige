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
  type Prestige,
} from '../prestige/index.js';
import type {
  CreateBallotRequest,
  CastVoteRequest,
  SubmitRevealRequest,
} from '../prestige/types.js';
import {
  parsePrivacyConfig,
  privacyDelay,
  type PrivacyConfig,
} from '../prestige/privacy.js';
import {
  securityHeaders,
  ipAnonymization,
  privacyAwareLogging,
  privacyRateLimiter,
} from './middleware/security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse privacy configuration
const privacyConfig: PrivacyConfig = parsePrivacyConfig(process.env);
if (privacyConfig.enabled) {
  console.log('Enhanced Privacy Mode: ENABLED');
  console.log(`  Timing delays: ${privacyConfig.minDelayMs}-${privacyConfig.maxDelayMs}ms`);
  if (privacyConfig.normalizedResponseMs > 0) {
    console.log(`  Normalized response time: ${privacyConfig.normalizedResponseMs}ms`);
  }
}

// Initialize Prestige
// USE_MOCKS=true forces mock mode
// WITNESS_URL enables real Witness adapter (other adapters can still be mocked)
const useMocks = process.env.USE_MOCKS === 'true';
const hasWitnessUrl = !!process.env.WITNESS_URL;

let prestige: Prestige;
if (useMocks || !hasWitnessUrl) {
  // Full mock mode - use test config with open gates
  prestige = createTestPrestige();
  console.log('Running in mock mode (no external services required)');
} else {
  // Production mode - use real adapters with env-configured gates
  prestige = createPrestige({
    // Allow overriding gates via env, default to 'open' for MVP
    ballotGate: (process.env.BALLOT_GATE as any) ?? 'open',
    voterGate: (process.env.VOTER_GATE as any) ?? 'open',
    // Allow shorter durations for testing
    minDurationMinutes: process.env.MIN_DURATION_MINUTES
      ? parseInt(process.env.MIN_DURATION_MINUTES, 10)
      : 1,
  });
  console.log('Running with real adapters:');
  console.log(`  Witness: ${process.env.WITNESS_URL}`);
  if (process.env.FREEBIRD_ISSUER_URL) {
    console.log(`  Freebird Issuer: ${process.env.FREEBIRD_ISSUER_URL}`);
  }
}

const app = express();

// ============= Security Middleware =============

// Security headers (always enabled)
app.use(securityHeaders({
  strictCSP: true,
  enableHSTS: process.env.NODE_ENV === 'production',
  onionLocation: process.env.ONION_LOCATION,
}));

// CORS
app.use(cors());

// JSON body parsing
app.use(express.json());

// IP anonymization (privacy mode only)
if (privacyConfig.enabled) {
  app.use(ipAnonymization(true));
}

// Request logging (privacy-aware or standard)
if (privacyConfig.enabled) {
  app.use(privacyAwareLogging(process.env.DISABLE_LOGGING === 'true'));
} else {
  app.use((req: Request, _res: Response, next: NextFunction) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });
}

// Rate limiting for sensitive endpoints
const sensitiveRateLimiter = privacyRateLimiter(
  60000, // 1 minute window
  parseInt(process.env.RATE_LIMIT_REQUESTS || '30', 10), // requests per window
);

// Static files
app.use(express.static(join(__dirname, 'public')));

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
 * Rate limited and timing-obfuscated for privacy
 */
app.post('/api/vote', sensitiveRateLimiter, async (req: Request, res: Response) => {
  try {
    // Add timing obfuscation before processing
    await privacyDelay(privacyConfig);

    const request: CastVoteRequest = {
      ballotId: req.body.ballotId,
      commitment: req.body.commitment,
      nullifier: req.body.nullifier,
      proof: req.body.proof,
    };

    const vote = await prestige.castVote(request);

    // Add timing obfuscation after processing
    await privacyDelay(privacyConfig);

    res.status(201).json(vote);
  } catch (error: any) {
    // Still add delay on error to prevent timing attacks
    await privacyDelay(privacyConfig);

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
 * Rate limited and timing-obfuscated for privacy
 */
app.post('/api/token/:ballotId', sensitiveRateLimiter, async (req: Request, res: Response) => {
  try {
    // Add timing obfuscation before processing
    await privacyDelay(privacyConfig);

    const token = await prestige.requestEligibilityToken(req.params.ballotId);

    // Add timing obfuscation after processing
    await privacyDelay(privacyConfig);

    res.json(token);
  } catch (error: any) {
    // Still add delay on error to prevent timing attacks
    await privacyDelay(privacyConfig);

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
 * Rate limited and timing-obfuscated for privacy
 */
app.post('/api/reveal', sensitiveRateLimiter, async (req: Request, res: Response) => {
  try {
    // Add timing obfuscation before processing
    await privacyDelay(privacyConfig);

    const request: SubmitRevealRequest = {
      ballotId: req.body.ballotId,
      nullifier: req.body.nullifier,
      choice: req.body.choice,
      salt: req.body.salt,
      voteData: req.body.voteData,
    };

    const reveal = await prestige.submitReveal(request);

    // Add timing obfuscation after processing
    await privacyDelay(privacyConfig);

    res.status(201).json(reveal);
  } catch (error: any) {
    // Still add delay on error to prevent timing attacks
    await privacyDelay(privacyConfig);

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

// ============= Audit Export Endpoints =============

/**
 * GET /api/results/:ballotId/export/json - Export full audit data as JSON
 * Provides complete ballot, votes, reveals, and attestation data for third-party auditors
 */
app.get('/api/results/:ballotId/export/json', async (req: Request, res: Response) => {
  try {
    const ballotId = req.params.ballotId;

    // Get all relevant data
    const [ballot, votes, reveals, result, report] = await Promise.all([
      prestige.getBallot(ballotId),
      prestige.getVotes(ballotId),
      prestige.getReveals(ballotId),
      prestige.getResults(ballotId).catch(() => null),
      prestige.getVerificationReport(ballotId),
    ]);

    if (!ballot) {
      res.status(404).json({ error: 'Ballot not found', code: 'BALLOT_NOT_FOUND' });
      return;
    }

    const exportData = {
      exportVersion: '1.0',
      exportedAt: new Date().toISOString(),
      ballot: {
        id: ballot.id,
        question: ballot.question,
        choices: ballot.choices,
        created: ballot.created,
        deadline: ballot.deadline,
        revealDeadline: ballot.revealDeadline,
        status: ballot.status,
        voteType: ballot.voteType,
        attestation: ballot.attestation,
      },
      votes: votes.map(v => ({
        nullifier: v.nullifier,
        commitment: v.commitment,
        timestamp: v.attestation?.timestamp,
        attestation: v.attestation,
      })),
      reveals: reveals.map(r => ({
        nullifier: r.nullifier,
        choice: r.choice,
        salt: r.salt,
        voteData: r.voteData,
      })),
      result: result ? {
        tally: result.tally,
        totalVotes: result.totalVotes,
        totalReveals: result.totalReveals,
        validReveals: result.validReveals,
        finalized: result.finalized,
        voteType: result.voteType,
        rankedChoiceRounds: result.rankedChoiceRounds,
        averageScores: result.averageScores,
        attestation: result.attestation,
      } : null,
      verification: {
        allVotesAttested: report.integrity.allVotesAttested,
        allRevealsVerified: report.integrity.allRevealsVerified,
        resultAttested: report.integrity.resultAttested,
        validReveals: report.reveals.valid,
        invalidReveals: report.reveals.invalid,
        pendingReveals: report.reveals.pending,
      },
    };

    // Set headers for file download
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="ballot-${ballotId}-audit.json"`);
    res.json(exportData);
  } catch (error: any) {
    console.error('Error exporting audit data:', error);
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

/**
 * GET /api/results/:ballotId/export/csv - Export audit data as CSV
 * Provides vote-level data in CSV format for spreadsheet analysis
 */
app.get('/api/results/:ballotId/export/csv', async (req: Request, res: Response) => {
  try {
    const ballotId = req.params.ballotId;

    // Get all relevant data
    const [ballot, votes, reveals, report] = await Promise.all([
      prestige.getBallot(ballotId),
      prestige.getVotes(ballotId),
      prestige.getReveals(ballotId),
      prestige.getVerificationReport(ballotId),
    ]);

    if (!ballot) {
      res.status(404).json({ error: 'Ballot not found', code: 'BALLOT_NOT_FOUND' });
      return;
    }

    // Create reveal lookup by nullifier
    const revealMap = new Map(reveals.map(r => [r.nullifier, r]));
    const validNullifiers = new Set(report.reveals.validDetails.map(v => v.nullifier));

    // Build CSV rows
    const rows: string[][] = [];

    // Header row
    rows.push([
      'vote_number',
      'nullifier',
      'commitment',
      'vote_timestamp',
      'vote_attested',
      'revealed',
      'choice',
      'vote_data_type',
      'vote_data',
      'reveal_valid',
      'witness_ids',
    ]);

    // Data rows
    votes.forEach((vote, index) => {
      const reveal = revealMap.get(vote.nullifier);
      const isValid = validNullifiers.has(vote.nullifier);
      const witnessIds = vote.attestation?.witnessIds?.join('; ') ?? '';

      let voteDataType = '';
      let voteDataStr = '';
      if (reveal?.voteData) {
        voteDataType = reveal.voteData.type;
        switch (reveal.voteData.type) {
          case 'single':
            voteDataStr = reveal.voteData.choice;
            break;
          case 'approval':
            voteDataStr = (reveal.voteData as any).choices?.join('; ') ?? '';
            break;
          case 'ranked':
            voteDataStr = (reveal.voteData as any).rankings?.join(' > ') ?? '';
            break;
          case 'score':
            voteDataStr = Object.entries((reveal.voteData as any).scores ?? {})
              .map(([k, v]) => `${k}:${v}`)
              .join('; ');
            break;
        }
      }

      rows.push([
        String(index + 1),
        vote.nullifier,
        vote.commitment,
        vote.attestation?.timestamp ? new Date(vote.attestation.timestamp * 1000).toISOString() : '',
        vote.attestation ? 'yes' : 'no',
        reveal ? 'yes' : 'no',
        reveal?.choice ?? '',
        voteDataType,
        voteDataStr,
        reveal ? (isValid ? 'yes' : 'no') : '',
        witnessIds,
      ]);
    });

    // Convert to CSV string
    const csvContent = rows.map(row =>
      row.map(cell => {
        // Escape quotes and wrap in quotes if contains comma, quote, or newline
        if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
          return `"${cell.replace(/"/g, '""')}"`;
        }
        return cell;
      }).join(',')
    ).join('\n');

    // Add summary section
    const summary = [
      '',
      '# Ballot Summary',
      `# Question: ${ballot.question.replace(/,/g, ';')}`,
      `# Choices: ${ballot.choices.join('; ')}`,
      `# Created: ${new Date(ballot.created).toISOString()}`,
      `# Voting Deadline: ${new Date(ballot.deadline).toISOString()}`,
      `# Reveal Deadline: ${new Date(ballot.revealDeadline).toISOString()}`,
      `# Status: ${ballot.status}`,
      `# Total Votes: ${votes.length}`,
      `# Total Reveals: ${reveals.length}`,
      `# Valid Reveals: ${report.reveals.valid}`,
      `# All Votes Attested: ${report.integrity.allVotesAttested ? 'yes' : 'no'}`,
      `# All Reveals Verified: ${report.integrity.allRevealsVerified ? 'yes' : 'no'}`,
    ].join('\n');

    const fullCsv = csvContent + '\n' + summary;

    // Set headers for file download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="ballot-${ballotId}-audit.csv"`);
    res.send(fullCsv);
  } catch (error: any) {
    console.error('Error exporting CSV:', error);
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

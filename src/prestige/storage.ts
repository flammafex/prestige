/**
 * Storage implementation using SQLite
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type {
  Ballot,
  BallotStatus,
  Vote,
  Reveal,
  Result,
  PrestigeStore,
  PetitionSignature,
  Hash,
} from './types.js';

export class SQLiteStore implements PrestigeStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure the directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ballots (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        choices TEXT NOT NULL,
        created INTEGER NOT NULL,
        deadline INTEGER NOT NULL,
        reveal_deadline INTEGER NOT NULL,
        eligibility TEXT NOT NULL,
        attestation TEXT NOT NULL,
        creator_public_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'voting'
      );

      CREATE INDEX IF NOT EXISTS idx_ballots_status ON ballots(status);
      CREATE INDEX IF NOT EXISTS idx_ballots_deadline ON ballots(deadline);

      CREATE TABLE IF NOT EXISTS votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ballot_id TEXT NOT NULL,
        nullifier TEXT NOT NULL,
        commitment TEXT NOT NULL,
        proof TEXT NOT NULL,
        attestation TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        FOREIGN KEY (ballot_id) REFERENCES ballots(id),
        UNIQUE(ballot_id, nullifier)
      );

      CREATE INDEX IF NOT EXISTS idx_votes_ballot ON votes(ballot_id);
      CREATE INDEX IF NOT EXISTS idx_votes_nullifier ON votes(ballot_id, nullifier);

      CREATE TABLE IF NOT EXISTS reveals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ballot_id TEXT NOT NULL,
        nullifier TEXT NOT NULL,
        choice TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        FOREIGN KEY (ballot_id) REFERENCES ballots(id),
        UNIQUE(ballot_id, nullifier)
      );

      CREATE INDEX IF NOT EXISTS idx_reveals_ballot ON reveals(ballot_id);
      CREATE INDEX IF NOT EXISTS idx_reveals_nullifier ON reveals(ballot_id, nullifier);

      CREATE TABLE IF NOT EXISTS results (
        ballot_id TEXT PRIMARY KEY,
        tally TEXT NOT NULL,
        total_votes INTEGER NOT NULL,
        total_reveals INTEGER NOT NULL,
        valid_reveals INTEGER NOT NULL,
        attestation TEXT NOT NULL,
        finalized INTEGER NOT NULL,
        FOREIGN KEY (ballot_id) REFERENCES ballots(id)
      );

      CREATE TABLE IF NOT EXISTS petition_signatures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ballot_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        signature TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (ballot_id) REFERENCES ballots(id),
        UNIQUE(ballot_id, public_key)
      );

      CREATE INDEX IF NOT EXISTS idx_petition_signatures_ballot ON petition_signatures(ballot_id);
    `);
  }

  // Ballot operations

  async saveBallot(ballot: Ballot): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO ballots
      (id, question, choices, created, deadline, reveal_deadline, eligibility, attestation, creator_public_key, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      ballot.id,
      ballot.question,
      JSON.stringify(ballot.choices),
      ballot.created,
      ballot.deadline,
      ballot.revealDeadline,
      JSON.stringify(ballot.eligibility),
      JSON.stringify(ballot.attestation),
      ballot.creatorPublicKey,
      ballot.status
    );
  }

  async getBallot(id: string): Promise<Ballot | null> {
    const stmt = this.db.prepare('SELECT * FROM ballots WHERE id = ?');
    const row = stmt.get(id) as BallotRow | undefined;

    if (!row) return null;

    return this.rowToBallot(row);
  }

  async listBallots(options?: { status?: BallotStatus; limit?: number }): Promise<Ballot[]> {
    let query = 'SELECT * FROM ballots';
    const params: (string | number)[] = [];

    if (options?.status) {
      query += ' WHERE status = ?';
      params.push(options.status);
    }

    query += ' ORDER BY created DESC';

    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as BallotRow[];

    return rows.map(row => this.rowToBallot(row));
  }

  async updateBallotStatus(id: string, status: BallotStatus): Promise<void> {
    const stmt = this.db.prepare('UPDATE ballots SET status = ? WHERE id = ?');
    stmt.run(status, id);
  }

  async updateBallotDeadlines(id: string, deadline: number, revealDeadline: number): Promise<void> {
    const stmt = this.db.prepare('UPDATE ballots SET deadline = ?, reveal_deadline = ? WHERE id = ?');
    stmt.run(deadline, revealDeadline, id);
  }

  // Vote operations

  async saveVote(vote: Vote): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO votes
      (ballot_id, nullifier, commitment, proof, attestation)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      vote.ballotId,
      vote.nullifier,
      vote.commitment,
      JSON.stringify(vote.proof),
      JSON.stringify(vote.attestation)
    );
  }

  async getVotesByBallot(ballotId: string): Promise<Vote[]> {
    const stmt = this.db.prepare('SELECT * FROM votes WHERE ballot_id = ?');
    const rows = stmt.all(ballotId) as VoteRow[];

    return rows.map(row => this.rowToVote(row));
  }

  async hasNullifier(ballotId: string, nullifier: Hash): Promise<boolean> {
    const stmt = this.db.prepare(
      'SELECT 1 FROM votes WHERE ballot_id = ? AND nullifier = ?'
    );
    const row = stmt.get(ballotId, nullifier);
    return row !== undefined;
  }

  // Reveal operations

  async saveReveal(reveal: Reveal): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO reveals
      (ballot_id, nullifier, choice, salt)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(reveal.ballotId, reveal.nullifier, reveal.choice, reveal.salt);
  }

  async getRevealsByBallot(ballotId: string): Promise<Reveal[]> {
    const stmt = this.db.prepare('SELECT * FROM reveals WHERE ballot_id = ?');
    const rows = stmt.all(ballotId) as RevealRow[];

    return rows.map(row => ({
      ballotId: row.ballot_id,
      nullifier: row.nullifier,
      choice: row.choice,
      salt: row.salt,
    }));
  }

  async getRevealByNullifier(ballotId: string, nullifier: Hash): Promise<Reveal | null> {
    const stmt = this.db.prepare(
      'SELECT * FROM reveals WHERE ballot_id = ? AND nullifier = ?'
    );
    const row = stmt.get(ballotId, nullifier) as RevealRow | undefined;

    if (!row) return null;

    return {
      ballotId: row.ballot_id,
      nullifier: row.nullifier,
      choice: row.choice,
      salt: row.salt,
    };
  }

  // Result operations

  async saveResult(result: Result): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO results
      (ballot_id, tally, total_votes, total_reveals, valid_reveals, attestation, finalized)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      result.ballotId,
      JSON.stringify(result.tally),
      result.totalVotes,
      result.totalReveals,
      result.validReveals,
      JSON.stringify(result.attestation),
      result.finalized
    );
  }

  async getResult(ballotId: string): Promise<Result | null> {
    const stmt = this.db.prepare('SELECT * FROM results WHERE ballot_id = ?');
    const row = stmt.get(ballotId) as ResultRow | undefined;

    if (!row) return null;

    return {
      ballotId: row.ballot_id,
      tally: JSON.parse(row.tally),
      totalVotes: row.total_votes,
      totalReveals: row.total_reveals,
      validReveals: row.valid_reveals,
      attestation: JSON.parse(row.attestation),
      finalized: row.finalized,
    };
  }

  // Petition signature operations

  async savePetitionSignature(signature: PetitionSignature): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO petition_signatures
      (ballot_id, public_key, signature, timestamp)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(
      signature.ballotId,
      signature.publicKey,
      signature.signature,
      signature.timestamp
    );
  }

  async getPetitionSignatures(ballotId: string): Promise<PetitionSignature[]> {
    const stmt = this.db.prepare('SELECT * FROM petition_signatures WHERE ballot_id = ? ORDER BY timestamp');
    const rows = stmt.all(ballotId) as PetitionSignatureRow[];

    return rows.map(row => ({
      ballotId: row.ballot_id,
      publicKey: row.public_key,
      signature: row.signature,
      timestamp: row.timestamp,
    }));
  }

  async hasPetitionSignature(ballotId: string, publicKey: string): Promise<boolean> {
    const stmt = this.db.prepare(
      'SELECT 1 FROM petition_signatures WHERE ballot_id = ? AND public_key = ?'
    );
    const row = stmt.get(ballotId, publicKey);
    return row !== undefined;
  }

  // Utilities

  private rowToBallot(row: BallotRow): Ballot {
    return {
      id: row.id,
      question: row.question,
      choices: JSON.parse(row.choices),
      created: row.created,
      deadline: row.deadline,
      revealDeadline: row.reveal_deadline,
      eligibility: JSON.parse(row.eligibility),
      attestation: JSON.parse(row.attestation),
      creatorPublicKey: row.creator_public_key,
      status: row.status as BallotStatus,
    };
  }

  private rowToVote(row: VoteRow): Vote {
    return {
      ballotId: row.ballot_id,
      nullifier: row.nullifier,
      commitment: row.commitment,
      proof: JSON.parse(row.proof),
      attestation: JSON.parse(row.attestation),
    };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * In-memory store for testing
 */
export class InMemoryStore implements PrestigeStore {
  private ballots = new Map<string, Ballot>();
  private votes = new Map<string, Vote[]>();
  private reveals = new Map<string, Reveal[]>();
  private results = new Map<string, Result>();
  private petitionSignatures = new Map<string, PetitionSignature[]>();

  async saveBallot(ballot: Ballot): Promise<void> {
    this.ballots.set(ballot.id, ballot);
  }

  async getBallot(id: string): Promise<Ballot | null> {
    return this.ballots.get(id) ?? null;
  }

  async listBallots(options?: { status?: BallotStatus; limit?: number }): Promise<Ballot[]> {
    let ballots = Array.from(this.ballots.values());

    if (options?.status) {
      ballots = ballots.filter(b => b.status === options.status);
    }

    ballots.sort((a, b) => b.created - a.created);

    if (options?.limit) {
      ballots = ballots.slice(0, options.limit);
    }

    return ballots;
  }

  async updateBallotStatus(id: string, status: BallotStatus): Promise<void> {
    const ballot = this.ballots.get(id);
    if (ballot) {
      ballot.status = status;
    }
  }

  async updateBallotDeadlines(id: string, deadline: number, revealDeadline: number): Promise<void> {
    const ballot = this.ballots.get(id);
    if (ballot) {
      ballot.deadline = deadline;
      ballot.revealDeadline = revealDeadline;
    }
  }

  async saveVote(vote: Vote): Promise<void> {
    const votes = this.votes.get(vote.ballotId) ?? [];
    if (!votes.find(v => v.nullifier === vote.nullifier)) {
      votes.push(vote);
      this.votes.set(vote.ballotId, votes);
    }
  }

  async getVotesByBallot(ballotId: string): Promise<Vote[]> {
    return this.votes.get(ballotId) ?? [];
  }

  async hasNullifier(ballotId: string, nullifier: Hash): Promise<boolean> {
    const votes = this.votes.get(ballotId) ?? [];
    return votes.some(v => v.nullifier === nullifier);
  }

  async saveReveal(reveal: Reveal): Promise<void> {
    const reveals = this.reveals.get(reveal.ballotId) ?? [];
    if (!reveals.find(r => r.nullifier === reveal.nullifier)) {
      reveals.push(reveal);
      this.reveals.set(reveal.ballotId, reveals);
    }
  }

  async getRevealsByBallot(ballotId: string): Promise<Reveal[]> {
    return this.reveals.get(ballotId) ?? [];
  }

  async getRevealByNullifier(ballotId: string, nullifier: Hash): Promise<Reveal | null> {
    const reveals = this.reveals.get(ballotId) ?? [];
    return reveals.find(r => r.nullifier === nullifier) ?? null;
  }

  async saveResult(result: Result): Promise<void> {
    this.results.set(result.ballotId, result);
  }

  async getResult(ballotId: string): Promise<Result | null> {
    return this.results.get(ballotId) ?? null;
  }

  async savePetitionSignature(signature: PetitionSignature): Promise<void> {
    const signatures = this.petitionSignatures.get(signature.ballotId) ?? [];
    if (!signatures.find(s => s.publicKey === signature.publicKey)) {
      signatures.push(signature);
      this.petitionSignatures.set(signature.ballotId, signatures);
    }
  }

  async getPetitionSignatures(ballotId: string): Promise<PetitionSignature[]> {
    return this.petitionSignatures.get(ballotId) ?? [];
  }

  async hasPetitionSignature(ballotId: string, publicKey: string): Promise<boolean> {
    const signatures = this.petitionSignatures.get(ballotId) ?? [];
    return signatures.some(s => s.publicKey === publicKey);
  }

  clear(): void {
    this.ballots.clear();
    this.votes.clear();
    this.reveals.clear();
    this.results.clear();
    this.petitionSignatures.clear();
  }
}

// Row types for SQLite
interface BallotRow {
  id: string;
  question: string;
  choices: string;
  created: number;
  deadline: number;
  reveal_deadline: number;
  eligibility: string;
  attestation: string;
  creator_public_key: string;
  status: string;
}

interface VoteRow {
  id: number;
  ballot_id: string;
  nullifier: string;
  commitment: string;
  proof: string;
  attestation: string;
  created_at: number;
}

interface RevealRow {
  id: number;
  ballot_id: string;
  nullifier: string;
  choice: string;
  salt: string;
  created_at: number;
}

interface ResultRow {
  ballot_id: string;
  tally: string;
  total_votes: number;
  total_reveals: number;
  valid_reveals: number;
  attestation: string;
  finalized: number;
}

interface PetitionSignatureRow {
  id: number;
  ballot_id: string;
  public_key: string;
  signature: string;
  timestamp: number;
}

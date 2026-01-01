#!/usr/bin/env node

/**
 * Prestige CLI
 * Command-line interface for ballot creation, voting, and results
 */

import { createPrestige, Prestige, Crypto } from '../prestige/index.js';
import type { CreateBallotRequest } from '../prestige/types.js';
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  console.log('Prestige CLI - Anonymous Verifiable Voting\n');

  switch (command) {
    case 'create':
      await createBallot();
      break;
    case 'vote':
      await castVote(args[1]);
      break;
    case 'reveal':
      await submitReveal(args[1]);
      break;
    case 'status':
      await showStatus(args[1]);
      break;
    case 'results':
      await showResults(args[1]);
      break;
    case 'list':
      await listBallots();
      break;
    case 'gates':
      await showGates();
      break;
    case 'petition':
      await signPetitionCmd(args[1]);
      break;
    case 'eligibility':
      await checkEligibility(args[1]);
      break;
    case 'health':
      await healthCheck();
      break;
    case 'help':
    default:
      showHelp();
  }

  rl.close();
}

function showHelp() {
  console.log(`Usage: prestige <command> [options]

Commands:
  create                  Create a new ballot interactively
  vote <ballot-id>        Vote on a ballot
  reveal <ballot-id>      Reveal your vote after deadline
  status <ballot-id>      Show ballot status
  results <ballot-id>     Show ballot results
  list                    List recent ballots

  gates                   Show gate configuration and your eligibility
  petition <ballot-id>    Sign a petition to activate a ballot
  eligibility [ballot-id] Check your voting eligibility

  health                  Check service health
  help                    Show this help message

Examples:
  prestige create
  prestige vote abc123
  prestige results abc123
  prestige gates
  prestige petition abc123
`);
}

async function createBallot() {
  console.log('Creating a new ballot...\n');

  const question = await prompt('Question: ');
  if (!question.trim()) {
    console.error('Error: Question is required');
    return;
  }

  console.log('\nEnter choices (one per line, empty line to finish):');
  const choices: string[] = [];
  while (true) {
    const choice = await prompt(`  Choice ${choices.length + 1}: `);
    if (!choice.trim()) break;
    choices.push(choice.trim());
  }

  if (choices.length < 2) {
    console.error('Error: At least 2 choices are required');
    return;
  }

  const durationStr = await prompt('\nVoting duration in minutes (default: 60): ');
  const durationMinutes = parseInt(durationStr, 10) || 60;

  const revealStr = await prompt('Reveal window in minutes (default: 60): ');
  const revealWindowMinutes = parseInt(revealStr, 10) || 60;

  console.log('\nCreating ballot...');

  try {
    const prestige = createPrestige();
    const ballot = await prestige.createBallot({
      question,
      choices,
      durationMinutes,
      revealWindowMinutes,
    });

    console.log('\nBallot created successfully!');
    console.log('----------------------------');
    console.log(`ID: ${ballot.id}`);
    console.log(`Question: ${ballot.question}`);
    console.log(`Choices: ${ballot.choices.join(', ')}`);
    console.log(`Deadline: ${new Date(ballot.deadline).toISOString()}`);
    console.log(`Reveal Deadline: ${new Date(ballot.revealDeadline).toISOString()}`);
    console.log(`Share URL: http://localhost:3000/b/${ballot.id}`);
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
  }
}

async function castVote(ballotId?: string) {
  if (!ballotId) {
    ballotId = await prompt('Ballot ID: ');
  }

  if (!ballotId.trim()) {
    console.error('Error: Ballot ID is required');
    return;
  }

  try {
    const prestige = createPrestige();
    const ballot = await prestige.getBallot(ballotId);

    if (!ballot) {
      console.error('Error: Ballot not found');
      return;
    }

    console.log(`\nQuestion: ${ballot.question}\n`);
    console.log('Choices:');
    ballot.choices.forEach((choice, i) => {
      console.log(`  ${i + 1}. ${choice}`);
    });

    const choiceNum = await prompt('\nEnter choice number: ');
    const choiceIndex = parseInt(choiceNum, 10) - 1;

    if (choiceIndex < 0 || choiceIndex >= ballot.choices.length) {
      console.error('Error: Invalid choice number');
      return;
    }

    const choice = ballot.choices[choiceIndex];
    console.log(`\nYou selected: ${choice}`);

    // Generate cryptographic values
    const voterSecret = Crypto.generateVoterSecret();
    const salt = Crypto.generateSalt();
    const commitment = Crypto.generateCommitment(choice, salt);
    const nullifier = Crypto.generateNullifier(voterSecret, ballotId);

    console.log('\nGetting eligibility token...');
    const proof = await prestige.requestEligibilityToken(ballotId);

    console.log('Casting vote...');
    await prestige.castVote({
      ballotId,
      commitment,
      nullifier,
      proof,
    });

    console.log('\nVote cast successfully!');
    console.log('\nIMPORTANT: Save these values for the reveal phase:');
    console.log('---------------------------------------------------');
    console.log(`Ballot ID: ${ballotId}`);
    console.log(`Your Choice: ${choice}`);
    console.log(`Salt: ${salt}`);
    console.log(`Nullifier: ${nullifier}`);
    console.log(`Voter Secret: ${voterSecret}`);
    console.log('\nYou will need these to reveal your vote after the deadline.');

  } catch (error: any) {
    console.error(`Error: ${error.message}`);
  }
}

async function submitReveal(ballotId?: string) {
  if (!ballotId) {
    ballotId = await prompt('Ballot ID: ');
  }

  if (!ballotId.trim()) {
    console.error('Error: Ballot ID is required');
    return;
  }

  const nullifier = await prompt('Nullifier: ');
  const choice = await prompt('Your choice (exact text): ');
  const salt = await prompt('Salt: ');

  if (!nullifier.trim() || !choice.trim() || !salt.trim()) {
    console.error('Error: All fields are required');
    return;
  }

  try {
    const prestige = createPrestige();

    console.log('\nSubmitting reveal...');
    await prestige.submitReveal({
      ballotId,
      nullifier: nullifier.trim(),
      choice: choice.trim(),
      salt: salt.trim(),
    });

    console.log('\nReveal submitted successfully!');
    console.log('Your vote will be counted in the final tally.');

  } catch (error: any) {
    console.error(`Error: ${error.message}`);
  }
}

async function showStatus(ballotId?: string) {
  if (!ballotId) {
    ballotId = await prompt('Ballot ID: ');
  }

  if (!ballotId.trim()) {
    console.error('Error: Ballot ID is required');
    return;
  }

  try {
    const prestige = createPrestige();
    const status = await prestige.getBallotStatus(ballotId);

    if (!status) {
      console.error('Error: Ballot not found');
      return;
    }

    console.log('\nBallot Status');
    console.log('-------------');
    console.log(`ID: ${status.ballot.id}`);
    console.log(`Question: ${status.ballot.question}`);
    console.log(`Status: ${status.status.toUpperCase()}`);
    console.log(`Votes: ${status.voteCount}`);
    console.log(`Deadline: ${new Date(status.ballot.deadline).toISOString()}`);
    console.log(`Reveal Deadline: ${new Date(status.ballot.revealDeadline).toISOString()}`);

    if (status.isAcceptingVotes) {
      const remaining = Math.max(0, status.ballot.deadline - Date.now());
      console.log(`Time Remaining: ${formatDuration(remaining)}`);
    } else if (status.isAcceptingReveals) {
      const remaining = Math.max(0, status.ballot.revealDeadline - Date.now());
      console.log(`Reveal Time Remaining: ${formatDuration(remaining)}`);
    }

  } catch (error: any) {
    console.error(`Error: ${error.message}`);
  }
}

async function showResults(ballotId?: string) {
  if (!ballotId) {
    ballotId = await prompt('Ballot ID: ');
  }

  if (!ballotId.trim()) {
    console.error('Error: Ballot ID is required');
    return;
  }

  try {
    const prestige = createPrestige();
    const ballot = await prestige.getBallot(ballotId);

    if (!ballot) {
      console.error('Error: Ballot not found');
      return;
    }

    const result = await prestige.getResults(ballotId);

    console.log('\nBallot Results');
    console.log('--------------');
    console.log(`Question: ${ballot.question}\n`);

    if (result) {
      const maxVotes = Math.max(...Object.values(result.tally));

      Object.entries(result.tally)
        .sort(([, a], [, b]) => b - a)
        .forEach(([choice, votes]) => {
          const pct = result.totalVotes > 0 ? (votes / result.totalVotes * 100).toFixed(1) : '0.0';
          const bar = '█'.repeat(Math.round(votes / Math.max(maxVotes, 1) * 20));
          const winner = votes === maxVotes && maxVotes > 0 ? ' ★' : '';
          console.log(`${choice}: ${bar} ${votes} (${pct}%)${winner}`);
        });

      console.log(`\nTotal Votes: ${result.totalVotes}`);
      console.log(`Valid Reveals: ${result.validReveals}`);
      console.log(`Finalized: ${new Date(result.finalized).toISOString()}`);
    } else {
      // Try live tally
      const liveTally = await prestige.getLiveTally(ballotId);
      console.log('(Live preview - not finalized)\n');

      Object.entries(liveTally.tally)
        .sort(([, a], [, b]) => b - a)
        .forEach(([choice, votes]) => {
          console.log(`${choice}: ${votes} votes`);
        });

      console.log(`\nTotal Votes: ${liveTally.totalVotes}`);
      console.log(`Reveals: ${liveTally.totalReveals}`);
    }

  } catch (error: any) {
    console.error(`Error: ${error.message}`);
  }
}

async function listBallots() {
  try {
    const prestige = createPrestige();
    const ballots = await prestige.listBallots({ limit: 10 });

    if (ballots.length === 0) {
      console.log('No ballots found.');
      return;
    }

    console.log('Recent Ballots');
    console.log('--------------');

    for (const ballot of ballots) {
      console.log(`\n[${ballot.status.toUpperCase()}] ${ballot.id}`);
      console.log(`  Question: ${ballot.question}`);
      console.log(`  Choices: ${ballot.choices.join(', ')}`);
      console.log(`  Created: ${new Date(ballot.created).toISOString()}`);
    }

  } catch (error: any) {
    console.error(`Error: ${error.message}`);
  }
}

async function healthCheck() {
  try {
    const prestige = createPrestige();
    const health = await prestige.healthCheck();

    console.log('Service Health');
    console.log('--------------');
    console.log(`Overall: ${health.healthy ? '✓ Healthy' : '✗ Unhealthy'}`);
    console.log(`Freebird: ${health.freebird ? '✓' : '✗'}`);
    console.log(`Witness: ${health.witness ? '✓' : '✗'}`);
    console.log(`HyperToken: ${health.hypertoken ? '✓' : '✗'}`);
    console.log(`Identity: ${health.identity.slice(0, 16)}...`);

  } catch (error: any) {
    console.error(`Error: ${error.message}`);
  }
}

async function showGates() {
  try {
    const prestige = createPrestige();
    const info = prestige.getGateInfo();

    console.log('Gate Configuration');
    console.log('==================\n');

    console.log('Ballot Creation');
    console.log(`  Type: ${info.ballot.type}`);
    console.log(`  ${info.ballot.description}`);
    info.ballot.requirements.forEach(r => console.log(`  • ${r}`));

    const canCreate = await prestige.canCreateBallot(prestige.identity.publicKey);
    console.log(`  Your status: ${canCreate.allowed ? '✓ Allowed' : '✗ ' + (canCreate.reason || 'Not allowed')}\n`);

    console.log('Voting');
    console.log(`  Type: ${info.voter.type}`);
    console.log(`  ${info.voter.description}`);
    info.voter.requirements.forEach(r => console.log(`  • ${r}`));

    const canVote = await prestige.canVoteOnInstance(prestige.identity.publicKey);
    console.log(`  Your status: ${canVote.allowed ? '✓ Allowed' : '✗ ' + (canVote.reason || 'Not allowed')}`);

  } catch (error: any) {
    console.error(`Error: ${error.message}`);
  }
}

async function signPetitionCmd(ballotId?: string) {
  if (!ballotId) {
    ballotId = await prompt('Ballot ID: ');
  }

  if (!ballotId.trim()) {
    console.error('Error: Ballot ID is required');
    return;
  }

  try {
    const prestige = createPrestige();

    // Check petition status
    const status = await prestige.getPetitionStatus(ballotId);
    if (!status) {
      console.log('This ballot is not using petition gate or does not exist.');
      return;
    }

    console.log(`\nPetition Status: ${status.current}/${status.required} signatures`);

    if (status.activated) {
      console.log('This petition has already been activated. Voting is open.');
      return;
    }

    // Check if already signed
    if (status.signatures.some(s => s.publicKey === prestige.identity.publicKey)) {
      console.log('You have already signed this petition.');
      return;
    }

    // Sign
    const signature = Crypto.sign(ballotId, prestige.identity.privateKey);
    const result = await prestige.signPetition(ballotId, prestige.identity.publicKey, signature);

    if (result.activated) {
      console.log('\n✓ Petition threshold reached! Voting is now open.');
    } else {
      console.log(`\n✓ Signature added. ${result.status.current}/${result.status.required} signatures.`);
    }

  } catch (error: any) {
    console.error(`Error: ${error.message}`);
  }
}

async function checkEligibility(ballotId?: string) {
  try {
    const prestige = createPrestige();

    // Instance-level check
    const canVote = await prestige.canVoteOnInstance(prestige.identity.publicKey);
    console.log('\nInstance Eligibility');
    console.log(`  Identity: ${prestige.identity.publicKey.slice(0, 16)}...`);
    console.log(`  ${canVote.allowed ? '✓ You can vote on this instance' : '✗ ' + (canVote.reason || 'Cannot vote')}`);

    if (ballotId) {
      // Ballot-level check
      const ballot = await prestige.getBallot(ballotId);
      if (!ballot) {
        console.log(`\nBallot ${ballotId} not found.`);
        return;
      }

      console.log(`\nBallot: ${ballot.question}`);
      console.log(`  Status: ${ballot.status}`);
      console.log(`  Eligibility type: ${ballot.eligibility?.type || 'instance default'}`);

      // Try to get token (will fail with reason if ineligible)
      try {
        await prestige.requestEligibilityToken(ballotId);
        console.log('  ✓ You are eligible to vote on this ballot');
      } catch (e: any) {
        console.log(`  ✗ ${e.message}`);
      }
    }

  } catch (error: any) {
    console.error(`Error: ${error.message}`);
  }
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

main().catch(console.error);

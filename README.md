# Prestige

**Anonymous Verifiable Voting for SophiaDOS**

> "Doodle poll, but you can't stuff the ballot and no one knows how you voted."

Secret ballot. Public proof. That's the whole product.

## Overview

Prestige is the third application in the SophiaDOS stack:
- **Scarcity** handles `transfer()` — conservation of value
- **Clout** handles `post()` — propagation of signal
- **Prestige** handles `cast()` — aggregation of will

## Features

- **Ballot Secrecy**: No one learns how anyone voted (Freebird unlinkability)
- **Eligibility**: Only authorized voters can vote (Freebird tokens)
- **No Double Voting**: One vote per eligible voter per ballot (nullifiers)
- **Verifiability**: Anyone can verify the tally is correct (public reveals + commitments)
- **Coercion Resistance**: Commit-reveal scheme prevents strategic voting
- **Configurable Gates**: Pluggable mechanisms for ballot creation and voter eligibility

## Gate System

> "No one owns the mechanism, but someone owns each instance."

Prestige uses a two-layer gate system to control access:

### Ballot Gates (Who Creates Ballots)

| Gate | Description | Config |
|------|-------------|--------|
| `owner` | Single admin key (default) | `BALLOT_GATE_ADMIN_KEY` |
| `delegation` | List of authorized keys | `BALLOT_GATE_DELEGATES` |
| `clout` | Anyone within N trust hops | `BALLOT_GATE_CLOUT_URL`, `BALLOT_GATE_TRUST_HOPS` |
| `freebird` | Token-gated creation | `BALLOT_GATE_FREEBIRD_ISSUER` |
| `petition` | Anyone, activates at threshold | `BALLOT_GATE_PETITION_THRESHOLD` |

### Voter Gates (Who Can Vote - Instance Level)

| Gate | Description | Config |
|------|-------------|--------|
| `open` | Anyone can vote | (none) |
| `freebird` | Sybil-resistant (default) | Uses instance Freebird |
| `clout` | Anyone in trust graph | `VOTER_GATE_CLOUT_URL`, `VOTER_GATE_TRUST_HOPS` |
| `scarbucks` | Token holders | `VOTER_GATE_TOKEN_ID`, `VOTER_GATE_MIN_AMOUNT` |
| `allowlist` | Specific keys only | `VOTER_GATE_ALLOWLIST` |

### Eligibility Hierarchy

```
Voter requests eligibility token
        │
        ▼
┌───────────────────────┐
│ Instance Voter Gate   │ ── Can this person vote HERE at all?
│ (configured by owner) │
└───────────────────────┘
        │ yes
        ▼
┌───────────────────────┐
│ Ballot Eligibility    │ ── Can this person vote on THIS question?
│ (set by ballot        │    (can restrict, not expand)
│  creator)             │
└───────────────────────┘
        │ yes
        ▼
┌───────────────────────┐
│ Freebird Token Issue  │ ── Anonymous proof of eligibility
└───────────────────────┘
        │
        ▼
    Vote cast with
    unlinkable proof
```

### Governance Models

| Model | Ballot Gate | Voter Gate | Use Case |
|-------|-------------|------------|----------|
| Church | `owner` | `clout` | Pastor sets agenda, congregation votes |
| Co-op | `delegation` | `scarbucks` | Board proposes, shareholders vote |
| DAO | `petition` | `scarbucks` | Anyone proposes, token holders vote |
| Community | `clout` | `clout` | Trusted members propose and vote |
| Public poll | `owner` | `open` | Operator polls the public |

## How It Works

### Commit-Reveal Scheme

1. **Voting Phase**: Voters submit encrypted commitments `H(choice || salt)` with nullifiers `H(secret || ballotId)`
2. **Deadline Passes**: No more votes accepted
3. **Reveal Phase**: Voters prove their commitment by revealing choice + salt
4. **Finalization**: Tally computed from valid reveals, attested by witnesses

### Privacy Guarantees

- **Freebird VOPRF**: Eligibility tokens are unlinkable - issuer can't connect token to verifier
- **Nullifiers**: Prevent double-voting without revealing identity
- **Witness Attestations**: Cryptographic timestamps prove when votes were cast

## Quick Start

### Using Docker Compose

```bash
# Start all services
docker compose up -d

# Create a ballot
curl -X POST http://localhost:3000/api/ballot \
  -H "Content-Type: application/json" \
  -d '{"question": "Best framework?", "choices": ["React", "Vue", "Svelte"]}'

# Open the web UI
open http://localhost:3000
```

### Local Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Start development server
npm run web
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │  IndexedDB  │  │   Crypto    │  │   Vote UI   │          │
│  │  (keypair)  │  │ (commit/    │  │             │          │
│  │             │  │  nullifier) │  │             │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Prestige Server                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │   Ballot    │  │    Vote     │  │   Reveal    │          │
│  │   Manager   │  │   Manager   │  │   Manager   │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │   Tally     │  │   Gossip    │  │   Storage   │          │
│  │   Manager   │  │  Protocol   │  │   (SQLite)  │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
└─────────────────────────────────────────────────────────────┘
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│   Freebird    │  │    Witness    │  │  HyperToken   │
│  (Issuer +    │  │   (Gateway +  │  │    Relay      │
│   Verifier)   │  │    Cluster)   │  │               │
└───────────────┘  └───────────────┘  └───────────────┘
```

## API Reference

### Gates

```
GET  /api/gates                    # Get gate configuration info
POST /api/gates/ballot/check       # Check if key can create ballots
POST /api/gates/voter/check        # Check if key can vote on instance
```

### Ballots

```
POST /api/ballot              # Create ballot (requires gate check)
GET  /api/ballot/:id          # Get ballot details
GET  /api/ballot/:id/status   # Get status with vote count
GET  /api/ballots             # List all ballots
```

For ballots with `petition` gate:
```
POST /api/ballot/:id/petition  # Sign petition to activate ballot
GET  /api/ballot/:id/petition  # Get petition status
```

### Voting

```
POST /api/vote                # Cast vote (commitment + nullifier + proof)
GET  /api/votes/:ballotId     # Get all commitments
POST /api/token/:ballotId     # Request eligibility token
```

### Reveals

```
POST /api/reveal              # Submit reveal (choice + salt)
GET  /api/reveals/:ballotId   # Get all reveals
GET  /api/reveals/:ballotId/stats  # Get reveal statistics
```

### Results

```
GET  /api/results/:ballotId        # Final tally with attestation
GET  /api/results/:ballotId/live   # Live tally during reveal phase
GET  /api/results/:ballotId/verify # Verification report
```

## CLI Usage

```bash
# Create a ballot interactively
prestige create

# Vote on a ballot
prestige vote <ballot-id>

# Reveal your vote after deadline
prestige reveal <ballot-id>

# Check ballot status
prestige status <ballot-id>

# View results
prestige results <ballot-id>

# List recent ballots
prestige list
```

## Data Model

```typescript
interface Ballot {
  id: string;
  question: string;
  choices: string[];
  deadline: number;         // Voting ends
  revealDeadline: number;   // Reveals must be submitted
  eligibility: EligibilityConfig;
  attestation: WitnessAttestation;
}

interface Vote {
  ballotId: string;
  nullifier: string;    // H(voterSecret || ballotId)
  commitment: string;   // H(choice || salt)
  proof: FreebirdToken; // Proves eligibility
  attestation: WitnessAttestation;
}

interface Reveal {
  ballotId: string;
  nullifier: string;    // Links to original vote
  choice: string;       // The actual choice
  salt: string;         // Proves commitment was honest
}
```

## Security Properties

| Property | Mechanism |
|----------|-----------|
| Ballot Secrecy | Freebird VOPRF unlinkability |
| Eligibility | Freebird token verification |
| No Double Voting | Nullifier tracking via gossip |
| Verifiability | Public commit-reveal scheme |
| Timestamp Integrity | Witness BFT attestations |

## Configuration

Environment variables:

```bash
# Server
PORT=3000
DATA_DIR=/data

# Freebird
FREEBIRD_ISSUER_URL=http://localhost:8081
FREEBIRD_VERIFIER_URL=http://localhost:8082

# Witness
WITNESS_URL=http://localhost:8080

# HyperToken
HYPERTOKEN_RELAY_URL=ws://localhost:3001

# Ballot defaults
DEFAULT_BALLOT_DURATION_HOURS=24
REVEAL_WINDOW_HOURS=24

# Ballot Gate (who can create ballots)
BALLOT_GATE=owner                          # owner | delegation | clout | freebird | petition
BALLOT_GATE_ADMIN_KEY=<public-key>         # For owner gate (defaults to instance key)
BALLOT_GATE_DELEGATES=key1,key2,key3       # For delegation gate
BALLOT_GATE_CLOUT_URL=http://clout:3000    # For clout gate
BALLOT_GATE_TRUST_HOPS=2                   # For clout gate (default: 2)
BALLOT_GATE_FREEBIRD_ISSUER=<issuer-id>    # For freebird gate
BALLOT_GATE_PETITION_THRESHOLD=10          # For petition gate (default: 10)

# Voter Gate (who can vote on this instance)
VOTER_GATE=freebird                        # open | freebird | clout | scarbucks | allowlist
VOTER_GATE_CLOUT_URL=http://clout:3000     # For clout gate
VOTER_GATE_TRUST_HOPS=3                    # For clout gate (default: 3)
VOTER_GATE_SCARCITY_URL=http://scarcity:3000  # For scarbucks gate
VOTER_GATE_TOKEN_ID=<token-id>             # For scarbucks gate
VOTER_GATE_MIN_AMOUNT=1                    # For scarbucks gate (default: 1)
VOTER_GATE_ALLOWLIST=key1,key2,key3        # For allowlist gate
```

## Testing

```bash
# Run all tests
npm test

# Run integration tests
npm run test:integration

# Run with coverage
npm test -- --coverage
```

## License

Apache-2.0

## Related Projects

- [Scarcity](https://github.com/flammafex/scarcity) - Token transfers
- [Clout](https://github.com/flammafex/clout) - Social reputation
- [Freebird](https://github.com/flammafex/freebird) - VOPRF tokens
- [Witness](https://github.com/flammafex/witness) - BFT timestamps
- [HyperToken](https://github.com/flammafex/hypertoken) - P2P sync

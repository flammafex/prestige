# 🗳️ Prestige

## Features

- **Ballot Secrecy**: No one learns how anyone voted (Freebird unlinkability)
- **Eligibility**: Only authorized voters can vote (caller-signed Freebird token requests)
- **No Double Voting**: One vote per eligible voter per ballot (nullifiers + one-time token spend tracking)
- **Verifiability**: Anyone can verify the tally is correct (public reveals + commitments)
- **Coercion Resistance**: Commit-reveal scheme prevents strategic voting
- **Configurable Gates**: Pluggable mechanisms for ballot creation and voter eligibility
- **Multiple Voting Methods**: Single choice, Approval, Ranked Choice (IRV), and Score voting
- **Progressive Web App**: Install on any device, vote offline, receive notifications
- **Enhanced Privacy Mode**: Timing attack protection, IP anonymization, Tor-friendly
- **Audit Exports**: Download ballot data as JSON or CSV for third-party verification

## Voting Methods

Prestige supports multiple voting methods to suit different decision-making needs:

| Method | Description | Best For |
|--------|-------------|----------|
| **Single Choice** | Traditional one-person-one-vote | Simple yes/no or binary decisions |
| **Approval Voting** | Vote for all acceptable choices | Selecting from many similar options |
| **Ranked Choice (IRV)** | Rank choices in preference order | Eliminating vote-splitting, finding consensus |
| **Score Voting** | Rate each choice on a scale | Nuanced preference expression |

### Ranked Choice Voting

Uses Instant-Runoff Voting (IRV):
1. Count first-choice votes
2. If no majority, eliminate lowest candidate
3. Redistribute eliminated candidate's votes to next preferences
4. Repeat until majority winner emerges

Results display round-by-round elimination for full transparency.

### Score Voting

Voters assign scores (e.g., 0-5) to each choice:
- Total scores determine winner
- Average scores shown for comparison
- Allows nuanced preference expression

## Gate System

> "No one owns the mechanism, but someone owns each instance."

Prestige uses a two-layer gate system to control access:

### Ballot Gates (Who Creates Ballots)

| Gate | Description | Config |
|------|-------------|--------|
| `open` | Anyone can create ballots | (none) |
| `owner` | Single admin key | `BALLOT_GATE_ADMIN_KEY` |
| `delegation` | List of authorized keys | `BALLOT_GATE_DELEGATES` |
| `freebird` | Token-gated creation | `BALLOT_GATE_FREEBIRD_ISSUER` |
| `petition` | Anyone proposes, activates at threshold | `BALLOT_GATE_PETITION_THRESHOLD` |

### Voter Gates (Who Can Vote - Instance Level)

| Gate | Description | Config |
|------|-------------|--------|
| `open` | Anyone can vote | (none) |
| `freebird` | Sybil-resistant via VOPRF tokens | Uses instance Freebird |
| `allowlist` | Specific keys only | `VOTER_GATE_ALLOWLIST` |

### Proposal Gates (For Petition Ballot Gate)

When using `BALLOT_GATE=petition`, a nested proposal gate controls who can open petitions:

| Gate | Description | Config |
|------|-------------|--------|
| `voters` | Anyone who can vote can propose (default) | (none) |
| `delegation` | Specific keys only | `PETITION_PROPOSAL_DELEGATES` |

### Eligibility Hierarchy

```
Voter requests token challenge (publicKey)
        │
        ▼
┌───────────────────────┐
│ Signed Challenge      │ ── Sign token:{ballotId}:{nonce}
│ (publicKey + signature│    with local Ed25519 identity
│  + nonce)             │
└───────────────────────┘
        │ valid
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
| Church | `owner` | `freebird` | Pastor sets agenda, verified members vote |
| Committee | `delegation` | `allowlist` | Board proposes, authorized members vote |
| Grassroots | `petition` | `freebird` | Anyone proposes, members activate and vote |
| Open forum | `open` | `open` | Anyone can create and vote (MVP testing) |
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
- **Timing Obfuscation**: Random delays prevent timing correlation attacks
- **IP Anonymization**: Headers stripped in privacy mode

## Privacy & Security

### Enhanced Privacy Mode

Enable privacy mode for high-stakes anonymous voting:

```bash
PRIVACY_MODE=true
PRIVACY_MIN_DELAY_MS=100    # Random delay range
PRIVACY_MAX_DELAY_MS=2000
DISABLE_LOGGING=false       # Set true for maximum privacy
```

Features:
- **Timing obfuscation**: Random delays on sensitive endpoints prevent timing attacks
- **IP anonymization**: Strips `X-Forwarded-For` and similar headers
- **Security headers**: CSP, HSTS, X-Frame-Options, and more
- **Privacy-aware rate limiting**: Uses request fingerprints instead of IPs

### Tor Hidden Service Deployment

Deploy Prestige as a Tor hidden service for maximum anonymity:

1. Install Tor: `apt install tor`
2. Configure `/etc/tor/torrc`:
   ```
   HiddenServiceDir /var/lib/tor/prestige/
   HiddenServicePort 80 127.0.0.1:3000
   ```
3. Restart Tor and get your `.onion` address:
   ```bash
   systemctl restart tor
   cat /var/lib/tor/prestige/hostname
   ```
4. Set `ONION_LOCATION` to advertise your onion address
5. Enable `PRIVACY_MODE=true` and `DISABLE_LOGGING=true`

### Privacy Tips for Voters

The web UI includes privacy guidance:
- Tor Browser usage recommendations
- VPN recommendations (Mullvad, ProtonVPN, IVPN)
- Device privacy best practices
- Timing attack mitigation tips

## Progressive Web App

Prestige works as a Progressive Web App (PWA):

- **Install on any device**: Add to home screen on mobile or desktop
- **Offline support**: Queue votes/reveals when offline, sync when connected
- **Local notifications**: Get reminded when ballots are ending or reveals are due (requires permission)
- **Fast loading**: Service worker caching for instant access

Note: vote sync requires a pre-issued eligibility proof. If a vote was queued without `proof`, replay is rejected.

### Installing

- **iOS**: Safari → Share → Add to Home Screen (iOS 16.4+ required for notifications)
- **Android**: Chrome → Menu → Add to Home Screen
- **Desktop**: Chrome/Edge → Install button in address bar

### Notifications

Local notifications require user permission. On iOS, the PWA must be installed to the home screen before notifications can be enabled. The app schedules reminders for:
- Voting deadlines (1 hour before)
- Reveal deadlines (30 minutes before)

## Audit & Verification

### Witness Attestations

All votes and results are timestamped by witness nodes:
- 🙌 Witnessed by {domain} at {time}
- Cryptographic signatures prove timestamp integrity
- Multiple witnesses for Byzantine fault tolerance

### Audit Exports

Download complete ballot data for independent verification:

- **JSON Export**: Full audit data including all votes, reveals, attestations, and cryptographic proofs
- **CSV Export**: Spreadsheet-friendly format with vote-level data and summary statistics

Exports include:
- All vote commitments and nullifiers
- All reveals with verification status
- Witness attestations and signatures
- Final tally computation data

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

# Start in mock mode (no external services required)
USE_MOCKS=true npm run dev

# Or start with real services
npm run web
```

### Mock Mode

For testing without external services:
```bash
USE_MOCKS=true npm run dev
```

This uses mock adapters for Freebird, Witness, and HyperToken.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │  IndexedDB  │  │   Crypto    │  │   Vote UI   │          │
│  │  (keypair)  │  │ (commit/    │  │   (PWA)     │          │
│  │             │  │  nullifier) │  │             │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
│  ┌─────────────┐  ┌─────────────┐                           │
│  │   Service   │  │   Offline   │                           │
│  │   Worker    │  │   Queue     │                           │
│  └─────────────┘  └─────────────┘                           │
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
│  │   Tally     │  │  Security   │  │   Storage   │          │
│  │   Manager   │  │ Middleware  │  │   (SQLite)  │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
└─────────────────────────────────────────────────────────────┘
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│   Freebird    │  │    Witness    │  │  HyperToken   │
│  (Issuer +    │  │   (Gateway +  │  │    Relay      │
│   Verifier)   │  │    Cluster)   │  │  (optional)   │
└───────────────┘  └───────────────┘  └───────────────┘
```

Note: HyperToken Relay is only needed for multi-node federation. Single-node deployments work without it.

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
POST /api/vote                          # Cast vote (commitment + nullifier + proof)
GET  /api/votes/:ballotId               # Get all commitments
POST /api/token/:ballotId/challenge     # Request one-time challenge { publicKey }
POST /api/token/:ballotId               # Request eligibility token { publicKey, signature, nonce, sybilProof? }
```

Token request flow:
1. Call `/api/token/:ballotId/challenge` with `publicKey`.
2. Sign `token:{ballotId}:{nonce}` with the same identity key.
3. Call `/api/token/:ballotId` with `publicKey`, `signature`, and `nonce`.

### Reveals

```
POST /api/reveal              # Submit reveal (choice + salt)
GET  /api/reveals/:ballotId   # Get all reveals
GET  /api/reveals/:ballotId/stats  # Get reveal statistics
```

### Results

```
GET  /api/results/:ballotId              # Final tally with attestation
GET  /api/results/:ballotId/live         # Live tally during reveal phase
GET  /api/results/:ballotId/verify       # Verification report
GET  /api/results/:ballotId/export/json  # Download full audit data (JSON)
GET  /api/results/:ballotId/export/csv   # Download audit data (CSV)
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

# Show gate configuration and your eligibility
prestige gates

# Sign a petition to activate a ballot (for petition gate)
prestige petition <ballot-id>

# Check your voting eligibility
prestige eligibility [ballot-id]

# Check service health
prestige health
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
  voteType: VoteTypeConfig; // single | approval | ranked | score
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
  voteData?: VoteData;  // Extended data for approval/ranked/score
}

type VoteData =
  | { type: 'single'; choice: string }
  | { type: 'approval'; choices: string[] }
  | { type: 'ranked'; rankings: string[] }
  | { type: 'score'; scores: Record<string, number> };
```

## Security Properties

| Property | Mechanism |
|----------|-----------|
| Ballot Secrecy | Freebird VOPRF unlinkability |
| Eligibility | Freebird token verification |
| No Double Voting | Nullifier tracking + one-time token spend tracking |
| Verifiability | Public commit-reveal scheme |
| Timestamp Integrity | Witness BFT attestations |
| Timing Attack Resistance | Random response delays |
| IP Privacy | Header stripping in privacy mode |

## Configuration

Environment variables:

```bash
# Server
PORT=3000
DATA_DIR=/data
TOKEN_CHALLENGE_TTL_MS=300000            # Token challenge nonce TTL in ms (default: 5 min)

# Freebird (VOPRF Token System)
FREEBIRD_ISSUER_URL=http://localhost:8081
FREEBIRD_VERIFIER_URL=http://localhost:8082

# Witness (BFT Timestamping)
WITNESS_URL=http://localhost:8080

# HyperToken Relay (optional - only needed for multi-node federation)
# HYPERTOKEN_RELAY_URL=ws://localhost:3001

# Ballot defaults
DEFAULT_BALLOT_DURATION_MINUTES=1440       # 24 hours
REVEAL_WINDOW_MINUTES=1440                 # 24 hours
MIN_DURATION_MINUTES=1                     # Minimum allowed duration

# Ballot Gate (who can create ballots)
BALLOT_GATE=open                           # open | owner | delegation | freebird | petition
BALLOT_GATE_ADMIN_KEY=<public-key>         # For owner gate (defaults to instance key)
BALLOT_GATE_DELEGATES=key1,key2,key3       # For delegation gate
BALLOT_GATE_FREEBIRD_ISSUER=<issuer-id>    # For freebird gate
# Freebird ballot creation token must include issuerId + epoch
BALLOT_GATE_PETITION_THRESHOLD=10          # For petition gate (default: 10)

# Voter Gate (who can vote on this instance)
VOTER_GATE=open                            # open | freebird | allowlist
VOTER_GATE_ALLOWLIST=key1,key2,key3        # For allowlist gate

# Proposal Gate (when BALLOT_GATE=petition)
PETITION_PROPOSAL_GATE=voters              # voters | delegation
PETITION_PROPOSAL_DELEGATES=key1,key2      # For delegation proposal gate

# Enhanced Privacy Mode
PRIVACY_MODE=false                         # Enable timing obfuscation & IP anonymization
PRIVACY_MIN_DELAY_MS=100                   # Minimum random delay (ms)
PRIVACY_MAX_DELAY_MS=2000                  # Maximum random delay (ms)
DISABLE_LOGGING=false                      # Disable request logging
ONION_LOCATION=http://your.onion           # Advertise Tor hidden service
```

Token challenges are stored in-memory and expire automatically. They are cleared when the server restarts.

## Testing

```bash
# Run all tests
npm test

# Run integration tests
npm run test:integration

# Run with coverage
npm test -- --coverage

# Run in mock mode for manual testing
USE_MOCKS=true npm run dev
```

## License

Apache-2.0

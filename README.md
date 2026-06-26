# Prestige

**Anonymous, verifiable voting. Secret ballot, public proof.**

Prestige is an anonymous, verifiable voting system built on unlinkable VOPRF tokens, commit-reveal schemes, and BFT timestamped attestations. Ballot secrecy is guaranteed — no one learns how anyone voted. Eligibility is enforced via gates. Double-voting is prevented via nullifiers and spent-token tracking. Anyone can verify the tally.

Ships as a web app (Express + PWA) and a CLI, backed by SQLite.

---

## Table of Contents

- [Quick Start](#quick-start)
  - [Mock Mode (Fastest)](#mock-mode-fastest)
  - [Docker Compose (Full Stack)](#docker-compose-full-stack)
  - [Local Development with Real Services](#local-development-with-real-services)
- [Demo Guide](#demo-guide)
- [How It Works](#how-it-works)
- [Features](#features)
- [Voting Methods](#voting-methods)
- [Gate System](#gate-system)
- [Architecture](#architecture)
- [API Reference](#api-reference)
- [CLI Usage](#cli-usage)
- [Configuration](#configuration)
- [Privacy & Security](#privacy--security)
- [Progressive Web App](#progressive-web-app)
- [Audit & Verification](#audit--verification)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Quick Start

Requires Node.js >= 20 (>= 20.10 for `--env-file` support).

### Mock Mode (Fastest)

No external services required. Uses mock adapters for Freebird (VOPRF tokens), Witness (BFT timestamping), and HyperToken (P2P relay). Open gates — anyone can create ballots and vote.

```bash
npm install
npm run build
NODE_ENV=development USE_MOCKS=true npm run web
```

Open `http://localhost:3000` in your browser.

> **Why `NODE_ENV=development`?** Prestige refuses to start with `USE_MOCKS=true` in production mode (see [Troubleshooting](#troubleshooting)). The `.env.example` defaults to `NODE_ENV=production`, so you must override it. In development mode, `createTestPrestige()` is used, which configures open gates, mock adapters, 60-minute ballot durations, and an in-memory store automatically.

### Docker Compose (Full Stack)

Runs Prestige alongside real Freebird, Witness (3-node BFT cluster), and HyperToken Relay. Requires sibling repository checkouts:

```text
dev/
  prestige/
  freebird/
  witness/
  hypertoken/
```

```bash
# Create local configuration
cp .env.example .env

# Generate required keys (run once per value):
node -e "const { randomBytes } = require('crypto'); console.log(randomBytes(32).toString('hex'))"

# Fill these in .env:
#   PRESTIGE_PRIVATE_KEY     — 32-byte hex Ed25519 private key
#   FREEBIRD_ADMIN_KEY        — strong random admin key
#   FREEBIRD_SYBIL_MODE       — invitation, proof_of_work, webauthn, or none (local testing only)
#   BALLOT_GATE               — owner, delegation, freebird, petition, or open
#   VOTER_GATE                — freebird, allowlist, or open

# For a local smoke test with open gates, also set:
#   ALLOW_OPEN_GATES_IN_PRODUCTION=true

# Start all services
docker compose up --build

# Create a ballot
curl -X POST http://localhost:3000/api/ballot \
  -H "Content-Type: application/json" \
  -d '{"question": "Best framework?", "choices": ["React", "Vue", "Svelte"]}'

# Open the web UI
open http://localhost:3000
```

Docker Compose runs in production mode (`NODE_ENV=production` is set in `docker-compose.yml`), so all production guards apply. Mock mode is not available in this path.

### Local Development with Real Services

Run Prestige locally against real Freebird, Witness, and HyperToken services (started separately or via `docker compose up freebird-issuer freebird-verifier witness-gateway`):

```bash
npm install
npm run build

# Ensure .env has real service URLs and gate config
npm run web
```

If `WITNESS_URL` is set and `NODE_ENV` is not `production`, Prestige uses real adapters for configured services and mocks for any that are missing.

---

## Demo Guide

A 2-minute walkthrough of the full commit-reveal lifecycle.

### 1. Start in mock mode

```bash
NODE_ENV=development USE_MOCKS=true npm run web
```

### 2. Create a ballot

**Via web UI:** Open `http://localhost:3000`, create a ballot with question "Best framework?" and choices React, Vue, Svelte.

**Via API:**

```bash
curl -X POST http://localhost:3000/api/ballot \
  -H "Content-Type: application/json" \
  -d '{"question": "Best framework?", "choices": ["React", "Vue", "Svelte"], "durationMinutes": 1, "revealWindowMinutes": 1}'
```

Use short durations (`durationMinutes: 1`, `revealWindowMinutes: 1`) so you don't have to wait 24 hours for the demo.

### 3. Cast a vote

Open the ballot in the web UI and vote. The browser generates an Ed25519 keypair (stored in IndexedDB), requests an eligibility token, and submits a commitment `H(choice || salt)` with a nullifier `H(secret || ballotId)`. The actual choice is not visible yet — only the hash.

### 4. Wait for the deadline to pass

With 1-minute durations, wait ~60 seconds. Check status:

```bash
curl http://localhost:3000/api/ballot/<ballot-id>/status
```

### 5. Reveal the vote

After the voting deadline passes, the reveal phase opens. Submit the choice + salt to prove the commitment was honest. The server verifies that `H(choice || salt)` matches the original commitment.

### 6. View results

```bash
curl http://localhost:3000/api/results/<ballot-id>
```

Results show the final tally with witness attestations. Use `/verify` for a full verification report, or `/export/json` and `/export/csv` for audit data.

### CLI alternative

You can also drive the demo from the terminal:

```bash
npm run cli -- create              # interactive ballot creation
npm run cli -- list                # list ballots
npm run cli -- vote <ballot-id>    # cast a vote
npm run cli -- status <ballot-id>  # check status
npm run cli -- reveal <ballot-id>  # reveal after deadline
npm run cli -- results <ballot-id> # view tally
```

---

## How It Works

### Commit-Reveal Scheme

```
Voting Phase          Deadline         Reveal Phase          Finalization
     │                   │                  │                      │
     ▼                   ▼                  ▼                      ▼
 Voters submit      No more votes     Voters reveal           Tally computed
 commitments +      accepted          choice + salt to        from valid reveals,
 nullifiers.                           prove commitment        attested by witnesses
 (choice hidden)                       was honest
```

1. **Voting Phase**: Voters submit commitments `H(choice || salt)` with nullifiers `H(secret || ballotId)` and eligibility proofs.
2. **Deadline Passes**: No more votes accepted.
3. **Reveal Phase**: Voters reveal choice + salt, proving their commitment was honest.
4. **Finalization**: Tally computed from valid reveals, attested by witness nodes.

### Privacy Guarantees

| Property | Mechanism |
|----------|-----------|
| **Ballot Secrecy** | Freebird VOPRF unlinkability — issuer can't connect token to verifier |
| **No Double Voting** | Nullifiers `H(secret || ballotId)` + one-time token spend tracking |
| **Eligibility** | Freebird token verification — only authorized voters get tokens |
| **Verifiability** | Public commit-reveal scheme — anyone can audit |
| **Timestamp Integrity** | Witness BFT attestations — cryptographic proof of when votes were cast |
| **Timing Attack Resistance** | Random response delays in privacy mode |
| **IP Privacy** | Header stripping in privacy mode |

---

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

---

## Voting Methods

| Method | Description | Best For |
|--------|-------------|----------|
| **Single Choice** | Traditional one-person-one-vote | Simple yes/no or binary decisions |
| **Approval Voting** | Vote for all acceptable choices | Selecting from many similar options |
| **Ranked Choice (IRV)** | Rank choices in preference order | Eliminating vote-splitting, finding consensus |
| **Score Voting** | Rate each choice on a scale | Nuanced preference expression |

### Ranked Choice Voting (IRV)

Uses Instant-Runoff Voting:
1. Count first-choice votes
2. If no majority, eliminate lowest candidate
3. Redistribute eliminated candidate's votes to next preferences
4. Repeat until majority winner emerges

Results display round-by-round elimination for full transparency.

### Score Voting

Voters assign scores (e.g., 0-5) to each choice. Total scores determine winner; average scores shown for comparison.

---

## Gate System

> "No one owns the mechanism, but someone owns each instance."

Prestige uses a two-layer gate system to control access.

### Ballot Gates (Who Creates Ballots)

| Gate | Description | Config |
|------|-------------|--------|
| `open` | Anyone can create ballots | (none) |
| `owner` | Single admin key | `BALLOT_GATE_ADMIN_KEY` |
| `delegation` | List of authorized keys | `BALLOT_GATE_DELEGATES` |
| `freebird` | Token-gated creation | `BALLOT_GATE_FREEBIRD_ISSUER` |
| `petition` | Anyone proposes, activates at threshold | `BALLOT_GATE_PETITION_THRESHOLD` |

### Voter Gates (Who Can Vote — Instance Level)

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

---

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

HyperToken Relay is only needed for multi-node federation. Single-node deployments work without it.

---

## API Reference

### System

```
GET  /health              # Service health check
GET  /api/info            # Instance info (public key, gate config)
```

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

### Crypto Utilities

```
GET  /api/crypto/salt     # Generate a random salt
GET  /api/crypto/secret   # Generate a random voter secret
```

### Page Routes

```
GET  /b/:id    # Ballot page (shareable link)
GET  /r/:id    # Results page (shareable link)
```

---

## CLI Usage

The CLI uses the Prestige library directly (not the HTTP API). Run with `npm run cli --`:

```bash
# Create a ballot interactively
npm run cli -- create

# Vote on a ballot
npm run cli -- vote <ballot-id>

# Reveal your vote after deadline
npm run cli -- reveal <ballot-id>

# Check ballot status
npm run cli -- status <ballot-id>

# View results
npm run cli -- results <ballot-id>

# List recent ballots
npm run cli -- list

# Show gate configuration and your eligibility
npm run cli -- gates

# Sign a petition to activate a ballot (for petition gate)
npm run cli -- petition <ballot-id>

# Check your voting eligibility
npm run cli -- eligibility [ballot-id]

# Check service health
npm run cli -- health
```

If `prestige` is globally installed (via `npm link`), you can use `prestige <command>` directly.

---

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and edit.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `production` | Set to `development` for mock mode or local dev |
| `DATA_DIR` | `/data` | SQLite database directory |
| `TOKEN_CHALLENGE_TTL_MS` | `300000` | Token challenge nonce TTL in ms (5 min) |

### Instance Identity

| Variable | Default | Description |
|----------|---------|-------------|
| `PRESTIGE_PRIVATE_KEY` | (none) | 32-byte hex Ed25519 private key. Required in production. Generate with `node -e "const { randomBytes } = require('crypto'); console.log(randomBytes(32).toString('hex'))"` |
| `PRESTIGE_PUBLIC_KEY` | (none) | Matching public key. Optional startup guard — verified against private key on boot |

### Freebird (VOPRF Token System)

| Variable | Default | Description |
|----------|---------|-------------|
| `FREEBIRD_ISSUER_URL` | `http://localhost:8081` | Freebird issuer endpoint |
| `FREEBIRD_VERIFIER_URL` | `http://localhost:8082` | Freebird verifier endpoint |
| `FREEBIRD_ISSUER_ID` | `issuer:prestige:v4` | Issuer identifier |
| `FREEBIRD_VERIFIER_ID` | `verifier:prestige:v4` | Verifier identifier |
| `FREEBIRD_VERIFIER_AUDIENCE` | `prestige` | Verifier audience claim |
| `FREEBIRD_SYBIL_MODE` | `invitation` | Sybil resistance mode: `invitation`, `proof_of_work`, `webauthn`, or `none` (local testing only) |
| `FREEBIRD_ADMIN_KEY` | (none) | Strong admin key for Freebird service. Required by docker-compose |
| `FREEBIRD_REQUIRE_TLS` | `false` | Require TLS for Freebird connections |

### Witness (BFT Timestamping)

| Variable | Default | Description |
|----------|---------|-------------|
| `WITNESS_URL` | `http://localhost:8080` | Witness gateway endpoint |

### HyperToken Relay (Optional — Multi-Node Federation)

| Variable | Default | Description |
|----------|---------|-------------|
| `HYPERTOKEN_RELAY_URL` | (none) | WebSocket relay URL. If unset, HyperToken is disabled (single-node) |

### Ballot Defaults

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_BALLOT_DURATION_MINUTES` | `1440` | Default voting duration (24 hours) |
| `REVEAL_WINDOW_MINUTES` | `1440` | Default reveal window (24 hours) |
| `MIN_DURATION_MINUTES` | `1` | Minimum allowed ballot duration |
| `MAX_CHOICES` | `20` | Maximum choices per ballot |
| `MAX_QUESTION_LENGTH` | `500` | Maximum question length (characters) |

### Ballot Gate (Who Creates Ballots)

| Variable | Default | Description |
|----------|---------|-------------|
| `BALLOT_GATE` | `owner` | Gate type: `open`, `owner`, `delegation`, `freebird`, `petition` |
| `BALLOT_GATE_ADMIN_KEY` | instance key | For `owner` gate (defaults to instance public key) |
| `BALLOT_GATE_DELEGATES` | (none) | Comma-separated keys for `delegation` gate |
| `BALLOT_GATE_FREEBIRD_ISSUER` | (none) | Issuer ID for `freebird` gate |
| `BALLOT_GATE_FREEBIRD_ISSUER_URL` | (none) | Separate issuer URL for ballot gate |
| `BALLOT_GATE_PETITION_THRESHOLD` | `10` | Signatures needed to activate for `petition` gate |
| `ALLOW_OPEN_GATES_IN_PRODUCTION` | `false` | Set `true` to allow `open` gates in production |

### Voter Gate (Who Can Vote — Instance Level)

| Variable | Default | Description |
|----------|---------|-------------|
| `VOTER_GATE` | `freebird` | Gate type: `open`, `freebird`, `allowlist` |
| `VOTER_GATE_ALLOWLIST` | (none) | Comma-separated keys for `allowlist` gate |
| `VOTER_GATE_FREEBIRD_ISSUER_URL` | (none) | Separate issuer URL for voter gate |

### Proposal Gate (When `BALLOT_GATE=petition`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PETITION_PROPOSAL_GATE` | `voters` | Gate type: `voters` or `delegation` |
| `PETITION_PROPOSAL_DELEGATES` | (none) | Comma-separated keys for `delegation` proposal gate |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (1 minute) |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per window (general) |
| `RATE_LIMIT_REQUESTS` | `30` | Max requests per window for sensitive endpoints (vote, reveal, token) |

### Enhanced Privacy Mode

| Variable | Default | Description |
|----------|---------|-------------|
| `PRIVACY_MODE` | `false` | Master switch for privacy features |
| `PRIVACY_MIN_DELAY_MS` | `100` | Minimum random delay on sensitive endpoints |
| `PRIVACY_MAX_DELAY_MS` | `2000` | Maximum random delay on sensitive endpoints |
| `PRIVACY_NORMALIZED_RESPONSE_MS` | `0` | All responses take at least this long (0 = use random delays instead) |
| `PRIVACY_BATCHING` | `false` | Process votes/reveals in batches for unlinkability (increases latency) |
| `PRIVACY_BATCH_INTERVAL_MS` | `5000` | Batch processing interval |
| `DISABLE_LOGGING` | `false` | Disable request logging for maximum privacy |
| `ONION_LOCATION` | (none) | Advertise Tor hidden service via Onion-Location header |

Token challenges are stored in-memory and expire automatically. They are cleared when the server restarts.

---

## Privacy & Security

### Enhanced Privacy Mode

Enable for high-stakes anonymous voting:

```bash
PRIVACY_MODE=true
PRIVACY_MIN_DELAY_MS=100
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

For high-security deployments, consider running on Tails or Whonix, enabling batching for additional unlinkability, and using separate Tor circuits for each voter gate check.

### Privacy Tips for Voters

The web UI includes privacy guidance:
- Tor Browser usage recommendations
- VPN recommendations (Mullvad, ProtonVPN, IVPN)
- Device privacy best practices
- Timing attack mitigation tips

---

## Progressive Web App

Prestige works as a Progressive Web App:

- **Install on any device**: Add to home screen on mobile or desktop
- **Offline support**: Queue votes/reveals when offline, sync when connected
- **Local notifications**: Get reminded when ballots are ending or reveals are due (requires permission)
- **Fast loading**: Service worker caching for instant access

> Vote sync requires a pre-issued eligibility proof. If a vote was queued without `proof`, replay is rejected.

### Installing

- **iOS**: Safari → Share → Add to Home Screen (iOS 16.4+ required for notifications)
- **Android**: Chrome → Menu → Add to Home Screen
- **Desktop**: Chrome/Edge → Install button in address bar

### Notifications

Local notifications require user permission. On iOS, the PWA must be installed to the home screen before notifications can be enabled. The app schedules reminders for:
- Voting deadlines (1 hour before)
- Reveal deadlines (30 minutes before)

---

## Audit & Verification

### Witness Attestations

All votes and results are timestamped by witness nodes:
- Cryptographic signatures prove timestamp integrity
- Multiple witnesses for Byzantine fault tolerance

### Audit Exports

Download complete ballot data for independent verification:

- **JSON Export** (`/api/results/:ballotId/export/json`): Full audit data including all votes, reveals, attestations, and cryptographic proofs
- **CSV Export** (`/api/results/:ballotId/export/csv`): Spreadsheet-friendly format with vote-level data and summary statistics

Exports include:
- All vote commitments and nullifiers
- All reveals with verification status
- Witness attestations and signatures
- Final tally computation data

---

## Testing

```bash
# Run all tests
npm test

# Run integration tests only
npm run test:integration

# Run with coverage
npm test -- --coverage

# Run live-service contract tests (needs real Freebird/Witness/HyperToken)
npm run test:live
```

The default test set covers crypto primitives, gate enforcement, and the full voting lifecycle (create → vote → reveal → tally) including double-vote and token-replay scenarios. Tests use `InMemoryStore` + mock adapters — no HTTP or external services required.

> **Note:** `npm run dev` runs `tsc --watch` only — it compiles but does not launch a server. To run the server in mock mode, use `NODE_ENV=development USE_MOCKS=true npm run web`.

---

## Troubleshooting

### `Refusing to start production Prestige with USE_MOCKS=true`

**Cause:** `NODE_ENV=production` (or unset, which defaults to production behavior in some environments) and `USE_MOCKS=true` are both set. The server refuses to run with mock adapters in production mode — mock VOPRF tokens aren't unlinkable and mock witnesses don't provide real BFT timestamps.

**Fix:** Set `NODE_ENV=development`:

```bash
NODE_ENV=development USE_MOCKS=true npm run web
```

### `Refusing to start production Prestige with missing required config: ...`

**Cause:** Running in production mode without required environment variables. Production requires: `PRESTIGE_PRIVATE_KEY`, `FREEBIRD_ISSUER_URL`, `FREEBIRD_VERIFIER_URL`, `WITNESS_URL`, `BALLOT_GATE`, `VOTER_GATE`.

**Fix:** Set the missing variables in `.env`, or switch to development mode for local testing.

### `Refusing to start production Prestige with open gates`

**Cause:** `BALLOT_GATE=open` or `VOTER_GATE=open` in production mode without explicit opt-in. Open gates let anyone create ballots or vote — dangerous in production unless intentional.

**Fix:** If this is intentional (public poll mode), set `ALLOW_OPEN_GATES_IN_PRODUCTION=true`. Otherwise, use a restrictive gate (`owner`, `delegation`, `freebird`, `allowlist`).

### `PRESTIGE_PUBLIC_KEY does not match PRESTIGE_PRIVATE_KEY`

**Cause:** The configured public key doesn't match the private key.

**Fix:** Either remove `PRESTIGE_PUBLIC_KEY` (it's optional — the server derives it from the private key), or regenerate it from your private key.

### `npm run dev` doesn't start a server

**Cause:** `npm run dev` is `tsc --watch` only — it compiles TypeScript but doesn't launch the server.

**Fix:** Use `npm run build && NODE_ENV=development USE_MOCKS=true npm run web` for mock mode, or run `tsc --watch` in one terminal and `node --env-file=.env dist/web/server.js` in another.

### `npm run lint` fails

**Cause:** No ESLint configuration exists in the repo.

**Fix:** Create an `eslint.config.*` file first, or skip linting.

---

## License

Apache-2.0

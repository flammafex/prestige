# AGENTS.md

Guidance for Codex / AI agents working in this repository. Read this before making changes.

## What this is

Prestige is an anonymous, verifiable voting system (TypeScript/Node.js). Ballot secrecy via unlinkable VOPRF tokens, eligibility via gates, no double-voting via nullifiers + spent-token tracking, public verifiability via commit-reveal, BFT timestamped attestations. Ships as a web app (Express + PWA) and a CLI, backed by SQLite.

## Repo layout

```
src/
  index.ts                 # Library barrel — re-exports public API from prestige/
  prestige/                # Core domain (framework-agnostic)
    index.ts               # Prestige orchestrator + createPrestige/createTestPrestige + env loading
    ballot.ts              # BallotManager — create/activate/list/status, validation
    vote.ts                # VoteManager — eligibility, token verify, nullifier, double-vote
    reveal.ts              # RevealManager — commitment verification, reveal windows
    tally.ts               # TallyManager — single/approval/IRV/score finalization
    storage.ts             # SQLiteStore + InMemoryStore, schema, unique constraints
    crypto.ts              # Ed25519, hashing, commitments, nullifiers, constant-time compare
    types.ts               # All domain types
    privacy.ts             # Timing obfuscation / batching helpers
    gossip.ts              # P2P propagation over HyperToken
    adapters/              # freebird.ts, witness.ts, hypertoken.ts — HTTP/WS clients + Mock* impls
    gates/                 # ballot/{open,owner,delegation,freebird,petition}.ts
                           # voter/{open,allowlist,freebird}.ts
                           # proposal/{index,voters,delegation}.ts
  vendor/freebird/         # Vendored P-256 VOPRF crypto (voprf.ts, p256.ts) — DO NOT modify casually
  web/
    server.ts              # Express bootstrap + ALL API routes + page routes (~1000 lines)
    middleware/security.ts # Headers, IP anonymization, timing obfuscation, rate limiting
    public/                # PWA: HTML pages, sw.js, manifest.json, js/ (vanilla, no framework)
  cli/
    index.ts               # Single-file CLI, 10 subcommands, uses Prestige library directly
test/                      # crypto.test.ts, gates.test.ts, integration.test.ts, live-services.contract.ts
scripts/generate-icons.js  # Build-time icon generation (sharp)
.forgejo/workflows/docker.yml  # CI: build & push Docker images on main/tags
```

## Setup / run / test / lint / build

```bash
npm install                  # install deps (Node >= 20 required)
npm run build                # tsc + cp src/web/public -> dist/web/
npm run web                  # run server: node --env-file=.env dist/web/server.js
npm run cli                  # run CLI: node dist/cli/index.js
USE_MOCKS=true npm run web   # mock mode (no external services needed)
npm test                     # jest (ESM via --experimental-vm-modules)
npm run test:integration     # integration tests only
npm run test:live            # live-service contract test (needs real Freebird/Witness/HyperToken)
npm run lint                 # eslint src/  — NOTE: no eslint config exists yet; may fail
npm run generate-icons      # regenerate PWA icons (requires sharp)
docker compose up -d         # full stack with all external services
```

**Known issues:**
- `npm run dev` is `tsc --watch` only — it compiles but does NOT launch a server. To run in mock mode, use `npm run build && USE_MOCKS=true npm run web`.
- `npm run lint` has no `.eslintrc*` / `eslint.config.*` in the repo. If you need linting, create a config first.
- `web` script uses `node --env-file=` which requires Node >= 20.10 (engines says >= 20.0.0).

## Coding conventions

- **ESM only.** `"type": "module"`, NodeNext resolution. Use `.js` extensions in relative imports even for `.ts` source files.
- **Strict TypeScript.** `strict: true`, declarations + source maps emitted to `dist/`.
- **Adapter pattern.** External services implement an interface (`FreebirdAdapter`, `WitnessAdapter`, `HyperTokenAdapter`) with `Http*`/`WebSocket*` and `Mock*` implementations. Add new external dependencies behind an adapter.
- **Gate pattern.** Each gate is a small class implementing `canCreate`/`canVote`/`canPropose` + `getRequirements`, one file per gate, composed via factories in `gates/index.ts`.
- **Manager pattern.** `BallotManager`/`VoteManager`/`RevealManager`/`TallyManager` each own a lifecycle phase; `Prestige` orchestrates them.
- **Frontend is vanilla.** No framework, no bundler — plain HTML + ES modules + IndexedDB + service worker. Do not introduce a framework without asking.
- **Tests use the public API.** Drive `Prestige` directly with `InMemoryStore` + mock adapters; no HTTP in unit/integration tests.
- **Security-conscious.** Use constant-time comparison for secrets, never log IPs/UA in privacy mode, respect `PRIVACY_MODE` and `DISABLE_LOGGING`.

## Testing expectations

- **Run `npm test` before declaring done.** All existing tests must pass.
- **Default test set** (`testMatch: **/test/**/*.test.ts`): `crypto.test.ts`, `gates.test.ts`, `integration.test.ts`. `live-services.contract.ts` is intentionally excluded (run via `npm run test:live` only with real services).
- **Add tests for new logic.** New crypto, gates, tally methods, or vote/reveal flows need tests. Use `InMemoryStore` + `Mock*` adapters.
- **Integration tests cover the lifecycle** (create → vote → reveal → tally) and double-vote / token-replay (including concurrent). Extend these when changing vote/storage logic.
- **No HTTP/web-layer tests exist.** If you change API routes or middleware, add the first tests for them.
- **No CLI tests exist.** If you change CLI logic, consider adding tests.
- **Coverage:** `npm test -- --coverage` collects from `src/**/*.ts`.

## PR / review expectations

- **Small, focused PRs.** One concern per PR. Don't mix refactors with feature changes.
- **Cite files in descriptions.** Reference paths and line numbers (e.g. `src/prestige/vote.ts:141`).
- **Security changes need explicit review.** Anything touching crypto, gates, vote/reveal/storage, or middleware must describe the threat model impact.
- **Don't break the commit-reveal invariant.** Ballot secrecy, no-double-vote, and verifiability are the core guarantees. If a change could affect them, call it out.
- **Keep adapters swappable.** Any change must work with both real and mock adapters.
- **CI:** Forgejo builds Docker images on `main` and `v*` tags. Don't push tags casually.

## Constraints — ask before touching

- **`src/vendor/freebird/`** — vendored P-256 VOPRF / curve math. Likely a faithful port of a reference; no dedicated tests. Do NOT modify without explicit approval.
- **`src/prestige/crypto.ts`** — all signing/hashing/commitment/nullifier primitives. Changes here affect every security property.
- **`src/prestige/storage.ts` unique constraints** — `(ballot_id, nullifier)` and `(ballot_id, token_hash)` are the last line of defense against double-voting and token replay. Do not weaken.
- **`src/prestige/vote.ts` token-spend / nullifier logic** — TOCTOU-sensitive. Concurrency assumptions matter.
- **`src/prestige/tally.ts` IRV elimination** (`:186-290`) — complex redistribution logic; no dedicated unit tests for IRV/score/approval edge cases. Changes need new tests.
- **Gate defaults in production** — `ALLOW_OPEN_GATES_IN_PRODUCTION=false` and `src/web/server.ts:93-95` rejects `USE_MOCKS=true` in production. Do not bypass these guards.
- **`PRESTIGE_PRIVATE_KEY`** — stable instance identity. Never generate a new one casually; it breaks attestation continuity.
- **External service images** in `docker-compose.yml` (`ghcr.io/flammafex/*`) — pinned to `:latest`. Don't change versions without coordination.

## Definition of done

A change is done when ALL of these hold:

1. **Builds clean:** `npm run build` succeeds with no TS errors.
2. **Tests pass:** `npm test` is green; new logic has new tests.
3. **Adapters intact:** change works with both real and mock adapters (if applicable).
4. **No security regressions:** commit-reveal invariants, gate enforcement, privacy mode, and production guards are preserved.
5. **No untested security-critical changes:** crypto, gates, vote/reveal/storage, and middleware changes include tests and a review note.
6. **Docs updated** if behavior changed: README API reference, gate tables, env vars, or data model.
7. **No secrets committed:** `.env` is gitignored; never hardcode keys or tokens.
8. **Lints** (if a config exists): `npm run lint` passes.

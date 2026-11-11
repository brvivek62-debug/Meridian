# Meridian

**The line your agents can't cross.**

Meridian gives AI agents delegated financial authority on NEAR. Funds sit in an on-chain Vault contract. Each agent gets a mandate (budget, per-transaction cap, daily cap, vendor allowlist, approval threshold) and holds only a function-call access key restricted to the Vault, so it cannot move money except through the Vault's policy checks.

Built at NEAR HACKATHON. Tracks: `agents`, `security`, `swarms`.

> Status: work in progress. See [Progress](#progress).

## Problem

_TODO_

## Solution

_TODO_ — mandates, spending limits, policy engine, sandboxed wallets via function-call keys, escrow, sub-mandates, Chain Signatures, NEAR Intents (1Click).

## Architecture

_TODO: Mermaid diagram._

```
contracts/vault/   Rust Vault contract (near-sdk, cargo-near) → NEAR testnet
agent/             TypeScript LLM agent loop + NEAR client
vendors/           Paid API (HTTP 402) + worker agents
dashboard/         Next.js + Tailwind dashboard
scripts/           Deploy, seed, demo-run scripts
```

## Trust model

_TODO: what is enforced on-chain vs. off-chain._

## Run locally

_TODO: "do X → see Y" steps._

1. `cp .env.example .env` and fill in values.

## Deployments and proofs

| Item | Value |
|---|---|
| Vault contract (testnet) | _TODO_ |
| Hosted demo | _TODO_ |
| Demo video | _TODO_ |
| Chain Signatures payment (Sepolia) tx | _TODO_ |
| NEAR Intents swap (mainnet) tx | _TODO_ |

## Libraries, templates and tools used

- AI coding tools: this project is built with Claude Code.
- _TODO: full list of libraries and templates._

## Roadmap

_TODO_

## Team

spider sensi

## License

[MIT](LICENSE)

## Progress

### MUST
- [x] M1 Repo scaffold, `.gitignore`, `.env.example`, README skeleton
- [ ] M2 Vault contract: mandates, `pay`, policy checks, receipts, tests
- [ ] M3 Pending approvals, sub-mandates, escrow, revoke, tests
- [ ] M4 Testnet deploy, `scripts/deploy.ts`, `scripts/seed.ts`
- [ ] M5 Agent with restricted function-call key + paid-API 402 flow
- [ ] M6 Worker agents, bidding, counter-offer, escrow release
- [ ] M7 Dashboard: create mandate, live receipts, approvals, attack button
- [ ] M8 `scripts/demo.ts` runs the full demo in one command

### SHOULD
- [ ] S1 Chain Signatures Sepolia payment via `authorize_foreign_payment`
- [ ] S2 1Click quote in live flow + one real mainnet swap recorded
- [ ] S3 Delegation tree visualization

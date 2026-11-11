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

### Enforced on-chain by the Vault contract
- An agent spends only through the Vault. Every `pay`, `accept_bid` and `create_sub_mandate` is checked against the mandate: active, remaining budget, per-transaction cap, daily cap (24h window), and vendor allowlist.
- Violations are recorded as `Blocked` receipts. The agent cannot hide a failed attempt.
- Payments above the approval threshold wait for the owner. `approve` re-runs every check at approval time. Escrow above the threshold is blocked, so escrow cannot be used to skip approval.
- A sub-mandate can never have more authority than its parent: every limit must be ≤ the parent's, its allowlist must be a subset, and its budget comes out of the parent's remaining budget.
- The owner can `revoke` a mandate at any time. It deactivates the whole subtree and refunds the unspent budget.

### Not enforced on-chain (yet)
- **Agent key restriction.** The claim that an agent holds only a function-call key for the Vault is set up off-chain by `scripts/setup-agent-key.ts` (M5). It is verifiable on-chain by listing the agent account's access keys.
- **Delivery.** The Vault does not know whether a vendor delivered what was paid for. Paid-API access is verified by the vendor, off-chain. Escrow release is the poster agent's decision (or the owner's).
- **Combined daily spend across a delegation tree.** Daily caps are per mandate. A parent and its sub-mandates can together spend more in one day than the parent's daily cap, though never more than the parent's total budget.
- **Pending payments do not reserve funds.** That is why `approve` re-checks the policy.

### Storage cost
The Vault pays NEAR storage staking for everything it stores: mandates, receipts (including `Blocked` ones), pending payments, tasks and bids. Anyone can create a mandate (minimum 0.1 NEAR budget) and anyone can bid on an open task, so storage use is bounded by hard caps rather than paid by the caller:
- allowlist ≤ 20 entries, memo ≤ 256 bytes, task description ≤ 512 bytes
- ≤ 5 sub-mandates per mandate, delegation depth ≤ 2
- ≤ 50 pending payments per owner, ≤ 20 bidders per task (re-bidding replaces the bid)
- callers other than the mandate's agent or owner are rejected before anything is stored

Receipt history still grows with agent activity, and the Vault account must keep enough NEAR for storage. A production version would charge callers a storage deposit (NEP-145 style) instead.

## Run locally

_TODO: "do X → see Y" steps._

1. `cp .env.example .env` and fill in values.

### Vault contract: build and test

```bash
cd contracts/vault
cargo near build non-reproducible-wasm   # → target/near/vault.wasm
cargo test                               # unit tests + sandbox tests
```

Sandbox tests use `near-sandbox` + `near-api` (what `cargo near new` generates now, in place of `near-workspaces`) and run on Apple Silicon. The 24h daily-cap rollover is unit-tested with `testing_env!` rather than sandbox-tested: sandbox `fast_forward` moves the clock only ~0.4 s per block here, so 24h would take ~35 min per run. Details: [contracts/vault/README.md](contracts/vault/README.md).

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
- `cargo near new` project template (Vault scaffold)
- Rust: `near-sdk` 5.30; tests: `near-sandbox`, `near-api`, `cargo-near-build`, `tokio`, `testresult`
- _TODO: remaining libraries as they are added._

## Roadmap

_TODO_

## Team

spider sensi

## License

[MIT](LICENSE)

## Progress

### MUST
- [x] M1 Repo scaffold, `.gitignore`, `.env.example`, README skeleton
- [x] M2 Vault contract: mandates, `pay`, policy checks, receipts, tests
- [x] M3 Pending approvals, sub-mandates, escrow, revoke, tests
- [ ] M4 Testnet deploy, `scripts/deploy.ts`, `scripts/seed.ts`
- [ ] M5 Agent with restricted function-call key + paid-API 402 flow
- [ ] M6 Worker agents, bidding, counter-offer, escrow release
- [ ] M7 Dashboard: create mandate, live receipts, approvals, attack button
- [ ] M8 `scripts/demo.ts` runs the full demo in one command

### SHOULD
- [ ] S1 Chain Signatures Sepolia payment via `authorize_foreign_payment`
- [ ] S2 1Click quote in live flow + one real mainnet swap recorded
- [ ] S3 Delegation tree visualization

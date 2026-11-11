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
- **Agent key restriction.** `agent.vivek-meridian.testnet` holds only a function-call access key (`scripts/setup-agent-key.ts`, M5) scoped to `vault.vivek-meridian.testnet` and the Vault's agent-side methods only (`pay`, `post_task`, `accept_bid`, `release`, `refund`, `create_sub_mandate`). Its full-access key was removed in the same transaction. This is enforced by NEAR's own access-key validation, not by Vault contract code — a plain transfer or a call to any other method is rejected before it ever reaches a contract, as proven by `npm run prove-no-bypass` (`scripts/prove-key-restriction.ts`).

### Not enforced on-chain (yet)
- **Contract upgrades.** `vault.vivek-meridian.testnet` keeps a full-access key held by the deployer, so the deployer can replace the code. The on-chain code hash is listed under [Deployments and proofs](#deployments-and-proofs) for anyone to check. A production Vault would remove that key or hand upgrades to a DAO.
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

### Deploy to testnet and seed

Requires Node ≥ 20, [near-cli-rs](https://github.com/near/near-cli-rs), and a funded testnet owner account whose key is in the near-cli-rs keychain.

```bash
npm install
cp .env.example .env        # set OWNER_ACCOUNT_ID=<you>.testnet
(cd contracts/vault && cargo near build non-reproducible-wasm)
npm run deploy              # → creates vault/agent/worker-scraper/worker-summarizer/paid-api.<owner>, deploys the Vault
npm run seed                # → owner creates a 5 NEAR mandate, agent pays 0.1 NEAR to paid-api: prints "Paid"
```

Both scripts are idempotent: a re-run skips accounts, code and the seed mandate that already exist. They write public account ids and tx hashes to [`deployments/testnet.json`](deployments/testnet.json). The scripts refuse to run unless `NEAR_NETWORK=testnet`.

**Keys.** The owner's key never leaves the near-cli-rs keychain: owner transactions (account creation, `create_mandate`) are signed by `near ... sign-with-keychain`. Each demo account gets a new key, written only to `~/.near-credentials/testnet/<account>.json` (mode 600). No key is in this repository or in `.env`.

The deploy funds the Vault with 3 NEAR: ~2.46 NEAR covers code storage (245 KB) and the rest pays for mandate and receipt storage. The seed needs 5 NEAR for the mandate and keeps a 3 NEAR reserve in the owner (`SEED_OWNER_RESERVE`). If the owner is short, get testnet NEAR from a faucet (see [Q-008](HACKATHON.md)).

### Agent key restriction, paid API, and the agent loop (M5)

```bash
npm run setup-agent-key     # agent.<owner>: full-access key → function-call key scoped to the Vault, one-shot
npm run prove-no-bypass     # proves a direct transfer and a non-allowed Vault method both get rejected by NEAR itself
npm run demo:m5             # starts vendors/paid-api, runs the agent, shows 402 → pay via Vault → data end to end
```

`setup-agent-key` is idempotent — re-running it after the agent is already restricted is a no-op. The agent (`agent/`) runs an LLM tool-calling loop on **NEAR AI Cloud** (OpenAI-compatible, `openai` npm package, model `LLM_MODEL` from `.env`) with two tools: `check_budget` (reads the mandate from the Vault) and `call_paid_api` (GETs a URL, and on a 402 pays the quoted price through `Vault.pay` and retries automatically — this is the agent's *only* way to move NEAR, since its key cannot do a plain transfer). `vendors/paid-api` (`npm run paid-api`) is the other side: it answers `GET /data?q=...` with `402 { price, payTo, memoNonce }` when there's no `X-Payment-Tx` header, and with one, verifies through NEAR testnet RPC — not by trusting the client — that the transaction called `Vault.pay`, paid at least the price to itself, carried the issued nonce in the memo, and actually succeeded on-chain, before returning data. It rejects a replayed tx hash.

To run the two halves by hand instead of `demo:m5`: `npm run paid-api` in one terminal, then `npm run agent -- "your research question"` in another.

## Deployments and proofs

| Item | Value |
|---|---|
| Vault contract (testnet) | [`vault.vivek-meridian.testnet`](https://testnet.nearblocks.io/address/vault.vivek-meridian.testnet), code hash `42ZeciXtgZtd2UKKi88WMzUcg7RPgnG6pxYjGqE1Rn3M` |
| Vault deploy tx | [`FVrP5cmZ…GFR5`](https://testnet.nearblocks.io/txns/FVrP5cmZLQms5NfGW1wDSdAPHYPZ22q39tTPg2jrGFR5) |
| Seed mandate (5 NEAR, id 0) | [`9DZkqxPY…bpY7`](https://testnet.nearblocks.io/txns/9DZkqxPYUj8VjX6jdBu5Sr3Njftn744nTRopyK4PbpY7) |
| Test payment, 0.1 NEAR agent → paid-api (`Paid`) | [`CKLuXywE…pfzqW`](https://testnet.nearblocks.io/txns/CKLuXywEZAq6qL3zRBnZrYkDxguWADzPHTuPotMpfzqW) |
| Agent key restricted (full-access → function-call, scoped to Vault) | [`F9nxYdBv…8CKK`](https://testnet.nearblocks.io/txns/F9nxYdBv4SbDMyULCZfcEwVdRHEsyWutee4usAGA8CKK) |
| Agent → paid-api payment via 402 flow, 0.3 NEAR (`Paid`) | [`9JZEDEpV…rWsSY`](https://testnet.nearblocks.io/txns/9JZEDEpVW1x557crJdtD4P52co55Gq1Av36YSiZrWsSY) |
| Demo accounts (testnet) | `agent`, `worker-scraper`, `worker-summarizer`, `paid-api` `.vivek-meridian.testnet`; all ids and creation txs in [`deployments/testnet.json`](deployments/testnet.json) |
| Hosted demo | _TODO_ |
| Demo video | _TODO_ |
| Chain Signatures payment (Sepolia) tx | _TODO_ |
| NEAR Intents swap (mainnet) tx | _TODO_ |

## Libraries, templates and tools used

- AI coding tools: this project is built with Claude Code.
- `cargo near new` project template (Vault scaffold)
- Rust: `near-sdk` 5.30; tests: `near-sandbox`, `near-api`, `cargo-near-build`, `tokio`, `testresult`
- Node scripts: `near-api-js` 7.4, `tsx`, `dotenv`, `typescript`; `near-cli-rs` for owner-signed transactions
- Agent and paid API (M5): `openai` 7.55 (OpenAI-compatible client, pointed at NEAR AI Cloud), `express` 5.3
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
- [x] M4 Testnet deploy, `scripts/deploy.ts`, `scripts/seed.ts`
- [x] M5 Agent with restricted function-call key + paid-API 402 flow
- [ ] M6 Worker agents, bidding, counter-offer, escrow release
- [ ] M7 Dashboard: create mandate, live receipts, approvals, attack button
- [ ] M8 `scripts/demo.ts` runs the full demo in one command

### SHOULD
- [ ] S1 Chain Signatures Sepolia payment via `authorize_foreign_payment`
- [ ] S2 1Click quote in live flow + one real mainnet swap recorded
- [ ] S3 Delegation tree visualization

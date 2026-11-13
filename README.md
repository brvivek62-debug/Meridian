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
- **Worker key restriction (M6).** The same pattern (`scripts/lib/keys.ts`, shared by `setup-agent-key.ts` and `setup-worker-keys.ts`) restricts `worker-scraper.vivek-meridian.testnet` to `submit_bid` only, and `worker-summarizer.vivek-meridian.testnet` to `submit_bid` + `pay` — the latter because once it is granted a sub-mandate, it also spends through the Vault on its own. Neither worker account can ever hold or move funds outside a Vault-checked call.

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

### The agent marketplace: workers, bidding, sub-mandates (M6)

```bash
npm run setup-worker-keys   # worker-scraper, worker-summarizer: full-access key → function-call key scoped to the Vault, one-shot
npm run demo:m6             # starts paid-api + both workers, runs the agent in marketplace mode, prints a colored recap
```

`setup-worker-keys` is idempotent, same pattern as `setup-agent-key` (shared logic in `scripts/lib/keys.ts`). `worker-scraper.<owner>.testnet` gets a key restricted to `submit_bid` only — it only ever acts as a bidder. `worker-summarizer.<owner>.testnet` gets `submit_bid` + `pay`, because once it is granted a sub-mandate it also spends through the Vault on its own.

`vendors/worker-scraper` and `vendors/worker-summarizer` (`vendors/worker-common/service.ts` holds the shared scaffolding) each run a small Express service that:
- polls `Vault.get_tasks` for open tasks posted by the agent and calls `submit_bid` with a starting price;
- answers **one** counter-offer over HTTP (`POST /counter-offer { taskId, priceNear }`) — it accepts (and resubmits its bid on-chain at the new price) if the offer is at or above its own minimum price, otherwise it rejects and its current bid stands; a second call for the same task just replays its first decision;
- delivers the work once it has won a task (`GET /deliver/:taskId`) — `worker-scraper` returns mock scraped data, `worker-summarizer` watches `get_mandates_by_owner` for a new active mandate granted to itself and, once one appears, autonomously pays `vendors/paid-api` through that sub-mandate (the only way its key can move NEAR) and calls **NEAR AI Cloud** to summarize the result.

The agent (`npm run agent -- --m6`) gets six more tools on top of M5's two: `post_task`, `list_bids` (polls until enough bids arrive or it times out), `counter_offer`, `accept_bid`, `release_escrow` (fetches the winner's delivery, then releases the payment), and `create_sub_mandate`. Its M6 run: posts a scraping task → waits for both workers' bids → counter-offers the cheaper one → accepts the best final price (escrow locks) → receives the work and releases payment → delegates a 1 NEAR sub-mandate to `worker-summarizer`, which then pays and summarizes on its own. `npm run demo:m6` runs all of this in one command and prints a colored log with testnet explorer links for every on-chain step, plus a recap.

To run the pieces by hand instead of `demo:m6`: `npm run paid-api`, `npm run worker-scraper`, `npm run worker-summarizer` in three terminals, then `npm run agent:m6` in a fourth.

### Dashboard (M7)

```bash
npm run setup-dashboard     # creates demo-owner.<owner>.testnet, writes its key to .env, one-shot
npm run dashboard           # → http://localhost:3000
```

`dashboard/` is a Next.js (App Router) + Tailwind app that polls the Vault's view methods over testnet RPC every 4s — it never needs a key to read. It shows, for every mandate it finds (the real owner's and the dashboard's own sandbox ones): a budget meter (spent/locked/delegated vs. budget, caps, allowlist chips), a receipts feed (Payment, Pending, Blocked in red, EscrowLock/Release, Refund, Delegation — a new Blocked receipt flashes red), a task board (open/locked/released, with bids and the final price), and a delegation tree (owner → mandate → sub-mandates, outline-only, no fills).

**Signing.** Owner-only actions — create mandate, approve, reject — and the attack button are server-side API routes (`dashboard/app/api/*`, Node runtime) signed by a dedicated `demo-owner.<owner>.testnet` account (`npm run setup-dashboard`), never the real owner's near-cli-rs keychain key. NEAR's testnet faucet only mints new top-level accounts, not sub-accounts of an existing one, so — like every other demo account in this repo — demo-owner is funded from the real owner's balance, not a third-party faucet. Unlike those accounts, demo-owner's private key is written to `.env` (`DEMO_OWNER_PRIVATE_KEY`) rather than `~/.near-credentials`, so the dashboard's server can read it; it is never sent to the browser. The **Create mandate** form always creates new mandates owned by demo-owner (agent defaults to demo-owner too, so it can also approve/reject its own pending payments); the **Approvals inbox** shows the real owner's pending payments read-only (there usually aren't any, since M5/M6 payments stay under its 0.8 NEAR threshold) and lets the dashboard act only on demo-owner's own.
The **attack button** ("Inject malicious instruction") models a prompt-injected agent deciding to send everything to `attacker.testnet`: it calls `Vault.pay` directly with the target mandate's own agent key (the real agent's restricted key from `~/.near-credentials` for the production mandate, demo-owner's key for a sandbox one) for the mandate's full budget. The question isn't whether an LLM would refuse — ours does, in `agent/src/llm.ts` — it's that the Vault blocks it on-chain regardless, exactly as PLAN.md's demo script describes.

Because the Vault's `Receipt` doesn't record a transaction hash (only `Mandate`/`Task`/`Bid` ids and amounts), the receipts feed links each receipt's recipient to its explorer **account** page rather than a specific tx; every action the dashboard itself performs (create mandate, approve, reject, attack) shows the real tx hash and explorer link it gets back from signing that call.

Create Mandate also has a **"Describe the rules in your own words"** box: NEAR AI (JSON mode, `dashboard/lib/parseMandate.ts`) turns a plain-English description into the exact fields (budget, per-tx cap, daily cap, allowlist, approval threshold) and fills them in for review, with notes on any assumptions or inconsistencies it noticed. Nothing is submitted until the owner reviews/edits the fields and clicks **Create mandate**, which stays disabled until client-side sanity checks pass (budget > 0; per-tx cap, daily cap and approval threshold each ≤ budget).

### "Break Meridian" public challenge (`/break`)

```bash
npm run setup-break-agent   # creates break-agent.<owner>.testnet + its own isolated mandate, one-shot
npm run dashboard           # → http://localhost:3000/break
```

"This AI agent controls a real wallet. Try to make it send you money." A visitor's plain-text message goes to **break-agent**, a real NEAR AI Cloud tool-calling loop (`dashboard/lib/breakAgent.ts`) with exactly two tools: `check_budget` and `send_payment`. Its system prompt does *not* hard-refuse everything — it's told to use judgment, so it's genuinely exploitable by social engineering, not a strawman. Unlike the production agent (`agent/src/llm.ts`), break-agent is never told its own limits: `check_budget` returns only its remaining spendable balance, never the allowlist, per-tx cap or daily cap, and its system prompt doesn't mention that those rules exist. The point of `/break` is that the Vault enforces the mandate even when the agent itself has no idea what it's allowed to do — so a convinced agent attempts the payment naively, and the chain is what actually stops it. If it decides to pay, `send_payment` calls `Vault.pay` for real, with break-agent's own restricted key.

Safety is on-chain, not in the prompt: `scripts/setup-break-agent.ts` gives break-agent its own mandate (2 NEAR budget, 0.05 NEAR per-tx cap, 0.2 NEAR daily cap) with an allowlist containing **only** the real paid-api vendor — a visitor's own account can never be on it, so a "fooled" attempt is always `Blocked` on-chain regardless of what the LLM was talked into. Its account key is restricted to `Vault.pay` only, separate from every other demo account, so public traffic can't drain or interfere with the production or M7 demo mandates.

The page shows a live scoreboard (total attacks, agents fooled, NEAR stolen — always 0 if the Vault holds) and a "Hall of attempts" (last 10, message always rendered as plain text, never HTML), backed by a small storage interface (`dashboard/lib/breakStore.ts`) with a local JSON file for now. Rate limited to 5 attempts/IP/10min and 200/day globally (IPs kept only as a truncated hash); max 1000 characters; a `BREAK_ENABLED=false` kill switch. Uses the cheapest NEAR AI Cloud model confirmed via the live `GET /v1/models` to support tool calling (`openai/gpt-5-nano`), configurable via `BREAK_MODEL`.

Both `/break` and the main dashboard show **"the line"** (`dashboard/components/TheLine.tsx`): a glowing vertical line between the agent and a target. Every attempt animates a coin from the agent toward the target — it shatters into particles with "BLOCKED" + the reason in red if the Vault stops it, passes through with a subtle blue pulse if paid, or dissolves before reaching the line if the agent never tried. Pure CSS keyframes, no animation library, each under 1.5s.

## Deployments and proofs

| Item | Value |
|---|---|
| Vault contract (testnet) | [`vault.vivek-meridian.testnet`](https://testnet.nearblocks.io/address/vault.vivek-meridian.testnet), code hash `42ZeciXtgZtd2UKKi88WMzUcg7RPgnG6pxYjGqE1Rn3M` |
| Vault deploy tx | [`FVrP5cmZ…GFR5`](https://testnet.nearblocks.io/txns/FVrP5cmZLQms5NfGW1wDSdAPHYPZ22q39tTPg2jrGFR5) |
| Seed mandate (5 NEAR, id 0) | [`9DZkqxPY…bpY7`](https://testnet.nearblocks.io/txns/9DZkqxPYUj8VjX6jdBu5Sr3Njftn744nTRopyK4PbpY7) |
| Test payment, 0.1 NEAR agent → paid-api (`Paid`) | [`CKLuXywE…pfzqW`](https://testnet.nearblocks.io/txns/CKLuXywEZAq6qL3zRBnZrYkDxguWADzPHTuPotMpfzqW) |
| Agent key restricted (full-access → function-call, scoped to Vault) | [`F9nxYdBv…8CKK`](https://testnet.nearblocks.io/txns/F9nxYdBv4SbDMyULCZfcEwVdRHEsyWutee4usAGA8CKK) |
| Agent → paid-api payment via 402 flow, 0.3 NEAR (`Paid`) | [`9JZEDEpV…rWsSY`](https://testnet.nearblocks.io/txns/9JZEDEpVW1x557crJdtD4P52co55Gq1Av36YSiZrWsSY) |
| worker-scraper key restricted (full-access → function-call, scoped to Vault) | [`AJRfaKnP…7Wfjmj`](https://testnet.nearblocks.io/txns/AJRfaKnPkQRBnTfdqhJ7JkNQcoyJroge5r6mpF7Wfjmj) |
| worker-summarizer key restricted (full-access → function-call, scoped to Vault) | [`Ede9EKm7…uviQ64`](https://testnet.nearblocks.io/txns/Ede9EKm75Qjd2E7KrShK5QzdXUu3NXTxjR98xAuviQ64) |
| M6 post_task (task 0, "Scrape NEAR agent wallet docs", max 0.4 NEAR) | [`43PQFjBm…4LQtUG`](https://testnet.nearblocks.io/txns/43PQFjBmWcdE69UMcuLff7CCPQFoM7LytzE3TV4LQtUG) |
| M6 bids: worker-scraper 0.3 NEAR, worker-summarizer 0.35 NEAR | [`Ef7GZRMA…nB5sE`](https://testnet.nearblocks.io/txns/Ef7GZRMAqRcPmziX5ZUc6AtBK6S5LUxzzj3qP1tnB5sE), [`HqXuBMoe…cqvZjH`](https://testnet.nearblocks.io/txns/HqXuBMoeJq7N4gnTvixzErRqTWkTGgnsDfU53bcqvZjH) |
| M6 counter-offer accepted: worker-scraper resubmits at 0.2 NEAR | [`36bQwwG1…Xn6WEt`](https://testnet.nearblocks.io/txns/36bQwwG1jLr7nQonh5qnyomp1WWz9wH2JD5XU9xn6WEt) |
| M6 accept_bid (escrow lock, worker-scraper @ 0.2 NEAR) | [`CtLLHXsz…MSUf9VG`](https://testnet.nearblocks.io/txns/CtLLHXszzZn1WE7NKzVR7S5eoPYAkzF6RfAd8MSUf9VG) |
| M6 release (escrow → worker-scraper, task `Released`) | [`745kcFZn…VYkHQS`](https://testnet.nearblocks.io/txns/745kcFZnasFvrdRpmJmj3itPBWRFWVD2NDy7UzVYkHQS) |
| M6 create_sub_mandate (1 NEAR for worker-summarizer, mandate id 1) | [`EeJVAmcE…T7aEPQBN`](https://testnet.nearblocks.io/txns/EeJVAmcEGhfFXdFUEBCUGbRvGbPqQeSpmWhbT7aEPQBN) |
| M6 worker-summarizer pay via its sub-mandate, 0.3 NEAR to paid-api | [`F6SRuTND…k59TX14o`](https://testnet.nearblocks.io/txns/F6SRuTNDy6C9bGZ7FhFEdHVZuKmJTVs6jQYuk59TX14o) |
| demo-owner account created (M7), funded 5 NEAR from the owner | [`EMWbRxeH…ZZv58`](https://testnet.nearblocks.io/txns/EMWbRxeHfeekmK9iyTmzk9U7UNQWpeuMJkPVMfYZZv58) |
| Dashboard create_mandate (demo mandate id 2, 2 NEAR, via demo-owner) | [`JAs46Xqf…Z0wAcb`](https://testnet.nearblocks.io/txns/JAs46XqfiLj34b42XHyPK3peHYHdHBBjJKK6gFeZwAcb) |
| Dashboard approve (pending → `Paid`, 0.45 NEAR) | [`Bm5A9qtd…a4t1Vf21`](https://testnet.nearblocks.io/txns/Bm5A9qtdi7v2WBDTnikzAR9JacPLEXXUjvxKa4t1Vf21) |
| Dashboard reject (`Rejected`) | [`6P2CaCcX…BZu91HL`](https://testnet.nearblocks.io/txns/6P2CaCcXTS29ZZoRxEKcXhp7UQv2yVqnUBtzBZu91HL) |
| Dashboard attack button on the production mandate 0 → `Blocked` | [`78xW26ic…z4Qn6oH`](https://testnet.nearblocks.io/txns/78xW26ic1JAA2nTuVPmS3u2GNcCwfhRu4F9YWz4Qn6oH) |
| break-agent created + key restricted to `Vault.pay` | [`GV81PqwsyY…ZnvCJ`](https://testnet.nearblocks.io/txns/GV81PqwsyYzQqB64pFJU4CUHMq6HU9vthQUeHa1ZnvCJ), [`LSHwcDbLjE…6NVB`](https://testnet.nearblocks.io/txns/LSHwcDbLjES9qjtb2QdFZXr8TSzNNxvWv9H7ULm6NVB) |
| break mandate 6 (2 NEAR, per-tx cap 0.05, daily cap 0.2, allowlist = paid-api only) | [`2eFPGKTDSh…BXuKS`](https://testnet.nearblocks.io/txns/2eFPGKTDShHJZomzRJmvbgZTWj5foxoWweAtW3tBXuKS) |
| `/break` attack attempts (2026-11-13, after removing self-censorship — see below): 3 of 5 tested styles fooled break-agent into attempting a payment (fake bug-bounty payout, a fake-owner demand, a fake system-override/prompt injection); the Vault `Blocked` all 3 — allowlist on the bounty payout, allowlist + per-tx cap + daily cap on the other two — 0 NEAR stolen. The 2 that didn't fool it (an "emergency top-up" overspend and a repeat-request daily-cap probe) were refused by the LLM's own judgment, not by the Vault. | e.g. [`5QfQ4t768A…uvPvz`](https://testnet.nearblocks.io/txns/5QfQ4t768AKD3xHX3oiDK739mazPTne7DQwo8SxuvPvz) |
| Demo accounts (testnet) | `agent`, `worker-scraper`, `worker-summarizer`, `paid-api`, `demo-owner`, `break-agent` `.vivek-meridian.testnet`; all ids and creation txs in [`deployments/testnet.json`](deployments/testnet.json) |
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
- Worker marketplace (M6): same `openai`/`express`/`near-api-js`, no new dependencies
- Dashboard (M7): Next.js 16, React 19, Tailwind CSS 4, `near-api-js` (its own `dashboard/package.json`)
- Break Meridian challenge + plain-English mandates: `openai` (NEAR AI Cloud, added to `dashboard/package.json`), no new dependencies otherwise — "the line" animation is pure CSS keyframes, no animation library

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
- [x] M6 Worker agents, bidding, counter-offer, escrow release
- [x] M7 Dashboard: create mandate, live receipts, approvals, attack button
- [ ] M8 `scripts/demo.ts` runs the full demo in one command

### SHOULD
- [ ] S1 Chain Signatures Sepolia payment via `authorize_foreign_payment`
- [ ] S2 1Click quote in live flow + one real mainnet swap recorded
- [x] S3 Delegation tree visualization

### Extras (Nov 12)
- [x] "Break Meridian" public challenge at `/break`: real NEAR AI tool-calling agent (check_budget + send_payment), isolated mandate + restricted key, scoreboard, Hall of attempts, rate limiting, kill switch — 5 attack styles tested on testnet, 3 fooled the LLM, Vault blocked all 3, 0 NEAR stolen
- [x] break-agent no longer told its own limits (check_budget returns only remaining balance; system prompt never mentions allowlist/caps), so it can't self-censor based on knowing the rules — re-ran the 5 attacks after the change, same result: 3/5 fooled, Vault blocked all 3
- [x] "The line" animation (`TheLine.tsx`) on `/break` and the dashboard — pure CSS, blocked/paid/refused states, under 1.5s
- [x] Plain-English mandates: "describe the rules in your own words" → NEAR AI parses to exact fields for review/edit, never auto-submitted, client-side sanity validation before create_mandate

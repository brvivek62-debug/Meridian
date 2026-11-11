# Meridian Vault contract

Rust contract (near-sdk 5.30, cargo-near). Holds owner-funded **mandates** and lets each mandate's agent spend only through policy-checked methods.

## Methods

| Method | Caller | Behavior |
|---|---|---|
| `create_mandate(agent, per_tx_cap, daily_cap, allowlist, approval_threshold)` `#[payable]` | owner | Attached deposit (≥ 0.1 NEAR) becomes the budget. Returns the mandate id. |
| `pay(mandate_id, to, amount, memo)` | mandate's agent | Policy checks: active, amount > 0, allowlist (empty = any), per-tx cap, remaining budget, daily cap (24h window). Any violation → `Blocked` receipt listing **every** failed rule, returns `{status: "Blocked"}` and **does not panic**. Passes and `amount > approval_threshold` → `PendingPayment` + `Pending` receipt, `{status: "Pending", pending_id}`. Otherwise → transfer + `Payment` receipt, `{status: "Paid"}`. |
| `approve(pending_id)` | mandate owner | **Re-runs every policy check at approval time.** Passes → transfer (`Paid`). Fails → `Blocked`. The pending entry is consumed either way. |
| `reject(pending_id)` | mandate owner | Drops it, `Rejected` receipt. Nothing moves. |
| `create_sub_mandate(parent_id, agent, budget, per_tx_cap, daily_cap, allowlist, approval_threshold)` | parent's agent | Moves `budget` out of the parent's remaining budget. **Panics if any limit is higher than the parent's**, if `budget` > parent's remaining, or if the allowlist is not a subset of the parent's (an empty allowlist under a restricted parent is rejected too, because empty means "any"). The owner of the sub-mandate stays the human root owner. Bounded to 5 children per mandate and depth 2. |
| `post_task(mandate_id, description, max_price)` | mandate's agent | Opens a task. |
| `submit_bid(task_id, price)` | any worker | `price ≤ max_price`. Bidding again replaces the worker's previous bid; this is how a counter-offer is answered. Max 20 bidders per task. |
| `accept_bid(task_id, worker)` | poster | Same policy checks as `pay`, with the worker as vendor. **Escrow above the approval threshold is blocked**, so escrow cannot be used to skip approval. Passes → price is locked (counts toward the daily cap) and an `EscrowLock` receipt is recorded. |
| `release(task_id)` | poster while active, or owner | Pays the worker, `EscrowRelease` receipt. |
| `refund(task_id)` | poster while active, or owner | Cancels an open task, or returns locked escrow to the mandate (to the owner if the mandate was revoked). `Refund` receipt. |
| `revoke(mandate_id)` | owner | Deactivates the mandate and every active descendant, transfers their combined remaining budget to the owner (one `Refund` receipt per mandate), and drops their pending payments. Locked escrow stays locked until the owner releases or refunds it. |
| views: `get_mandate`, `get_mandates_by_owner`, `get_receipts(mandate_id, from?, limit?)`, `get_pending(owner)`, `get_task`, `get_tasks(from?, limit?)`, `get_bids(task_id)` | anyone | Pages are max 100. `get_mandates_by_owner` includes sub-mandates; use `parent`/`children` to draw the delegation tree. |

Mandate accounting: `remaining = budget − spent − delegated − locked − returned`.

### Receipts and events

Every receipt is stored and emitted as a NEP-297 event:
`EVENT_JSON:{"standard":"meridian","version":"1.0.0","event":"<kind>","data":[...]}`

Receipt kinds: `payment`, `pending`, `rejected`, `blocked`, `delegation`, `escrow_lock`, `escrow_release`, `refund`. `ref_id` links a receipt to its pending payment, task, or child mandate.

Events without a stored receipt: `mandate_created`, `mandate_revoked`, `task_posted`, `bid_submitted`. They are deliberately not stored as receipts: any account can bid, and storing bids as receipts would let outsiders write into a mandate's payment history. Tasks and bids are still stored and readable through `get_task` / `get_bids`.

### What panics and what doesn't

- **Agent policy violations never panic.** They become `Blocked` receipts so the attempt is visible on-chain.
- **Wrong caller, unknown ids, and invalid setup do panic** (non-agent `pay`, non-owner `approve`/`revoke`, a sub-mandate looser than its parent, a bid above `max_price`). This stops outsiders from filling Vault storage with junk receipts.

## Build and test

```bash
cargo near build non-reproducible-wasm   # → target/near/vault.wasm
cargo test                               # unit tests + local sandbox tests
```

- **Unit tests** (`src/tests.rs`, `testing_env!`): policy logic, blocked-receipt format, pending/approve/reject, approval re-check, every sub-mandate rejection rule, escrow lock/release/refund, revoke of a subtree, settling escrow after revoke, failed-transfer refunds, pagination, and the **24h daily-cap rollover**.
- **Sandbox tests** (`tests/sandbox.rs`, `near-sandbox` + `near-api`, the current replacement for `near-workspaces` used by the `cargo near new` template): build the wasm, deploy to a local node, and send real transactions, checking real balances and a NEP-297 event on every state-changing call. Covered: normal payment; per-tx cap, allowlist, budget and daily cap → Blocked; over threshold → Pending → approve pays; reject drops; sub-mandates that exceed the parent are rejected; escrow post → bid → counter → accept → release pays the worker; refund returns funds; revoke refunds the owner and disables children. These run natively on Apple Silicon (M4).
- **Rollover is unit-tested, not sandbox-tested.** On this machine, sandbox `fast_forward` advances the block clock only about 0.4 s per block, so simulating 24h would need ~216k blocks (~35 min per run).

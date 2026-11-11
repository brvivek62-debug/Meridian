# Meridian Vault contract

Rust contract (near-sdk 5.30, cargo-near). Holds owner-funded **mandates** and lets each mandate's agent spend only through policy-checked `pay`.

## Methods (M2)

| Method | Caller | Behavior |
|---|---|---|
| `create_mandate(agent, per_tx_cap, daily_cap, allowlist, approval_threshold)` `#[payable]` | owner | Attached deposit (≥ 0.1 NEAR) becomes the budget. Returns the mandate id (string-encoded u64). |
| `pay(mandate_id, to, amount, memo)` | mandate's agent | Checks: active, amount > 0, allowlist (empty = any), per-tx cap, remaining budget, daily cap (24h window, resets once 24h have passed since the window started). On any violation it records a `Blocked` receipt listing **every** failed rule and returns `{status: "Blocked"}`. **It does not panic**, so the attempt stays on-chain. Otherwise it transfers and records a `Payment` receipt. If the transfer fails, a callback returns the funds to the mandate and records a `Refund` receipt (`status: "Failed"`). |
| `get_mandate(mandate_id)` | view | |
| `get_mandates_by_owner(owner)` | view | |
| `get_receipts(mandate_id, from?, limit?)` | view | Oldest first, max 100 per page. |

Every receipt is stored and emitted as a NEP-297 event:
`EVENT_JSON:{"standard":"meridian","version":"1.0.0","event":"payment|blocked|refund|mandate_created","data":[...]}`

Callers other than the mandate's agent, and unknown mandate ids, **do** panic. This stops outsiders from filling Vault storage with junk receipts.

`approval_threshold` is stored but enforced from M3 (pending approvals).

## Build and test

```bash
cargo near build non-reproducible-wasm   # → target/near/vault.wasm
cargo test                               # unit tests + local sandbox tests
```

- **Unit tests** (`src/lib.rs`, `testing_env!`): 11 tests covering policy logic, the blocked-receipt format, refund on a failed transfer, pagination, and the **24h daily-cap rollover**.
- **Sandbox tests** (`tests/sandbox.rs`, `near-sandbox` + `near-api`, the current replacement for `near-workspaces` used by the `cargo near new` template): build the wasm, deploy to a local node, and send real transactions. Covered: normal payment (vendor balance increases), over per-tx cap → Blocked, non-allowlisted vendor → Blocked (attacker balance unchanged), over budget → Blocked, daily cap → Blocked, plus a NEP-297 event check on every `pay`. These run natively on Apple Silicon (M4).
- **Rollover is unit-tested, not sandbox-tested.** On this machine, sandbox `fast_forward` advances the block clock only about 0.4 s per block, so simulating 24h would need ~216k blocks (~35 min per run).

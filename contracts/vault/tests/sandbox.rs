//! Integration tests: build the Vault wasm, deploy it to a local NEAR sandbox,
//! and drive it with real transactions (real transfers, real logs).

use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_api::types::transaction::result::TransactionResult;
use near_sdk::serde::Deserialize;
use near_sdk::serde::de::DeserializeOwned;
use near_sdk::serde_json::{Value, json};
use std::sync::Arc;

type R<T> = testresult::TestResult<T>;

fn n(x: u128) -> NearToken {
    NearToken::from_near(x)
}
fn m(x: u128) -> NearToken {
    NearToken::from_millinear(x)
}

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct ActionResult {
    status: String,
    reason: Option<String>,
    pending_id: Option<u64>,
}

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct Mandate {
    active: bool,
    spent: NearToken,
    spent_today: NearToken,
    delegated: NearToken,
    locked: NearToken,
    children: Vec<u64>,
    receipt_count: u32,
}

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct RevokeResult {
    revoked: Vec<u64>,
    refunded: NearToken,
}

struct Env {
    _sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    vault: AccountId,
    owner: AccountId,
    agent: AccountId,
    child: AccountId,
    api: AccountId,
    worker: AccountId,
    worker2: AccountId,
    attacker: AccountId,
}

async fn create_account(sb: &near_sandbox::Sandbox, name: &str) -> R<AccountId> {
    let id: AccountId = name.parse()?;
    sb.create_account(id.as_str().parse()?)
        .initial_balance(n(20))
        .send()
        .await?;
    Ok(id)
}

async fn setup() -> R<Env> {
    let wasm_path = cargo_near_build::build_with_cli(Default::default())?;
    let wasm = std::fs::read(wasm_path)?;

    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
    )?;

    let vault = create_account(&sandbox, "vault.sandbox").await?;
    let env = Env {
        owner: create_account(&sandbox, "owner.sandbox").await?,
        agent: create_account(&sandbox, "agent.sandbox").await?,
        child: create_account(&sandbox, "summarizer.sandbox").await?,
        api: create_account(&sandbox, "api.sandbox").await?,
        worker: create_account(&sandbox, "worker.sandbox").await?,
        worker2: create_account(&sandbox, "worker2.sandbox").await?,
        attacker: create_account(&sandbox, "attacker.sandbox").await?,
        vault: vault.clone(),
        net,
        signer,
        _sandbox: sandbox,
    };

    near_api::Contract::deploy(vault)
        .use_code(wasm)
        .without_init_call()
        .with_signer(env.signer.clone())
        .send_to(&env.net)
        .await?
        .assert_success();
    Ok(env)
}

impl Env {
    /// Send a transaction to the Vault as `who`. Returns the raw result so tests
    /// can assert success or failure.
    async fn call(&self, who: &AccountId, method: &str, args: Value, deposit: NearToken) -> R<TransactionResult> {
        Ok(near_api::Contract(self.vault.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(NearGas::from_tgas(100))
            .with_signer(who.clone(), self.signer.clone())
            .send_to(&self.net)
            .await?)
    }

    /// Call and decode the JSON return value; the transaction must succeed and
    /// emit at least one NEP-297 `meridian` event.
    async fn ok<T: DeserializeOwned>(&self, who: &AccountId, method: &str, args: Value) -> R<T> {
        self.ok_with_deposit(who, method, args, NearToken::from_yoctonear(0)).await
    }

    async fn ok_with_deposit<T: DeserializeOwned>(&self, who: &AccountId, method: &str, args: Value, deposit: NearToken) -> R<T> {
        let res = self.call(who, method, args, deposit).await?.assert_success();
        assert!(
            res.logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"standard\":\"meridian\"")),
            "{method}: no NEP-297 event in logs: {:?}",
            res.logs()
        );
        Ok(res.json()?)
    }

    async fn view<T: DeserializeOwned + Send + Sync + 'static>(&self, method: &str, args: Value) -> R<T> {
        Ok(near_api::Contract(self.vault.clone())
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    /// The demo mandate: per-tx 1 NEAR, daily 2 NEAR, allowlist = api + two
    /// workers + summarizer, approval threshold 0.8 NEAR.
    async fn create_mandate(&self, budget: NearToken) -> R<u64> {
        self.ok_with_deposit(
            &self.owner,
            "create_mandate",
            json!({
                "agent": self.agent,
                "per_tx_cap": n(1),
                "daily_cap": n(2),
                "allowlist": [self.api, self.worker, self.worker2, self.child],
                "approval_threshold": m(800),
            }),
            budget,
        )
        .await
    }

    async fn pay(&self, mandate_id: u64, to: &AccountId, amount: NearToken) -> R<ActionResult> {
        self.pay_as(&self.agent, mandate_id, to, amount).await
    }

    async fn pay_as(&self, who: &AccountId, mandate_id: u64, to: &AccountId, amount: NearToken) -> R<ActionResult> {
        self.ok(who, "pay", json!({ "mandate_id": mandate_id, "to": to, "amount": amount, "memo": "test" }))
            .await
    }

    async fn mandate(&self, id: u64) -> R<Mandate> {
        self.view("get_mandate", json!({ "mandate_id": id })).await
    }

    async fn receipt_kinds(&self, id: u64) -> R<Vec<String>> {
        let rs: Vec<Value> = self.view("get_receipts", json!({ "mandate_id": id })).await?;
        Ok(rs.iter().map(|r| r["kind"].as_str().unwrap().to_string()).collect())
    }

    async fn pending(&self) -> R<Vec<Value>> {
        self.view("get_pending", json!({ "owner": self.owner })).await
    }

    async fn balance(&self, id: &AccountId) -> R<NearToken> {
        Ok(near_api::Tokens::account(id.clone()).near_balance().fetch_from(&self.net).await?.total)
    }

    /// Arguments for a sub-mandate for the summarizer (daily 1 NEAR, threshold 0.4 NEAR).
    fn sub_mandate_args(&self, parent: u64, budget: NearToken, per_tx: NearToken, allow: Vec<&AccountId>) -> Value {
        json!({
            "parent_id": parent,
            "agent": self.child,
            "budget": budget,
            "per_tx_cap": per_tx,
            "daily_cap": n(1),
            "allowlist": allow,
            "approval_threshold": m(400),
        })
    }
}

// ------------------------------------------------------------------ M2

#[tokio::test]
async fn pay_policy_end_to_end() -> R<()> {
    let env = setup().await?;
    let id = env.create_mandate(n(5)).await?;

    // Normal payment: vendor receives the funds, mandate books the spend.
    let api_before = env.balance(&env.api).await?;
    let r = env.pay(id, &env.api, m(300)).await?;
    assert_eq!(r.status, "Paid", "{r:?}");
    assert_eq!(env.balance(&env.api).await?, api_before.saturating_add(m(300)));
    assert_eq!(env.mandate(id).await?.spent, m(300));

    // Over per-tx cap -> Blocked. The tx itself succeeds (no panic) and nothing moves.
    let api_before = env.balance(&env.api).await?;
    let r = env.pay(id, &env.api, m(1500)).await?;
    assert_eq!(r.status, "Blocked");
    assert!(r.reason.as_deref().unwrap().contains("per-tx cap"), "{r:?}");
    assert_eq!(env.balance(&env.api).await?, api_before);

    // Non-allowlisted vendor -> Blocked, attacker gets nothing.
    let attacker_before = env.balance(&env.attacker).await?;
    let r = env.pay(id, &env.attacker, m(100)).await?;
    assert_eq!(r.status, "Blocked");
    assert!(r.reason.as_deref().unwrap().contains("not on the allowlist"), "{r:?}");
    assert_eq!(env.balance(&env.attacker).await?, attacker_before);

    // Blocked attempts are stored as receipts.
    assert_eq!(env.receipt_kinds(id).await?, vec!["Payment", "Blocked", "Blocked"]);
    assert_eq!(env.mandate(id).await?.receipt_count, 3);
    Ok(())
}

#[tokio::test]
async fn over_budget_and_daily_cap_are_blocked() -> R<()> {
    let env = setup().await?;
    // Budget: 1 NEAR.
    let id = env.create_mandate(n(1)).await?;
    assert_eq!(env.pay(id, &env.api, m(700)).await?.status, "Paid");
    let r = env.pay(id, &env.api, m(400)).await?;
    assert_eq!(r.status, "Blocked");
    assert!(r.reason.as_deref().unwrap().contains("remaining budget"), "{r:?}");

    // Daily cap: 2 NEAR. The 24h rollover is unit-tested (see README).
    let id = env.create_mandate(n(5)).await?;
    for _ in 0..4 {
        assert_eq!(env.pay(id, &env.api, m(500)).await?.status, "Paid");
    }
    let r = env.pay(id, &env.api, m(100)).await?;
    assert_eq!(r.status, "Blocked");
    assert!(r.reason.as_deref().unwrap().contains("daily cap"), "{r:?}");
    assert_eq!(env.mandate(id).await?.spent_today, n(2));
    Ok(())
}

// ------------------------------------------------------------------ M3: approvals

#[tokio::test]
async fn pending_approve_and_reject() -> R<()> {
    let env = setup().await?;
    let id = env.create_mandate(n(5)).await?;

    // 0.9 NEAR > 0.8 threshold -> Pending, nothing moves.
    let api_before = env.balance(&env.api).await?;
    let r = env.pay(id, &env.api, m(900)).await?;
    assert_eq!(r.status, "Pending", "{r:?}");
    let pid = r.pending_id.unwrap();
    assert_eq!(env.pending().await?.len(), 1);
    assert_eq!(env.balance(&env.api).await?, api_before);

    // The agent cannot approve its own payment.
    env.call(&env.agent, "approve", json!({ "pending_id": pid }), NearToken::from_yoctonear(0))
        .await?
        .assert_failure();

    // Owner approves -> the payment executes.
    let r: ActionResult = env.ok(&env.owner, "approve", json!({ "pending_id": pid })).await?;
    assert_eq!(r.status, "Paid", "{r:?}");
    assert_eq!(env.balance(&env.api).await?, api_before.saturating_add(m(900)));
    assert!(env.pending().await?.is_empty());
    assert_eq!(env.mandate(id).await?.spent, m(900));

    // Second pending payment -> owner rejects -> dropped, nothing moves.
    let pid = env.pay(id, &env.api, m(950)).await?.pending_id.unwrap();
    let api_before = env.balance(&env.api).await?;
    let r: ActionResult = env.ok(&env.owner, "reject", json!({ "pending_id": pid })).await?;
    assert_eq!(r.status, "Rejected");
    assert!(env.pending().await?.is_empty());
    assert_eq!(env.balance(&env.api).await?, api_before);
    assert_eq!(env.mandate(id).await?.spent, m(900));
    assert_eq!(env.receipt_kinds(id).await?, vec!["Pending", "Payment", "Pending", "Rejected"]);
    Ok(())
}

// ------------------------------------------------------------------ M3: sub-mandates

#[tokio::test]
async fn sub_mandates_cannot_exceed_parent() -> R<()> {
    let env = setup().await?;
    let id = env.create_mandate(n(5)).await?;
    let zero = NearToken::from_yoctonear(0);

    // per-tx cap above the parent's -> rejected.
    let args = env.sub_mandate_args(id, n(1), m(1500), vec![&env.api]);
    env.call(&env.agent, "create_sub_mandate", args, zero).await?.assert_failure();
    // Budget above the parent's remaining -> rejected.
    let args = env.sub_mandate_args(id, n(6), m(500), vec![&env.api]);
    env.call(&env.agent, "create_sub_mandate", args, zero).await?.assert_failure();
    // Allowlist not a subset of the parent's -> rejected.
    let args = env.sub_mandate_args(id, n(1), m(500), vec![&env.api, &env.attacker]);
    env.call(&env.agent, "create_sub_mandate", args, zero).await?.assert_failure();
    // Empty allowlist (= any vendor) under a restricted parent -> rejected.
    let args = env.sub_mandate_args(id, n(1), m(500), vec![]);
    env.call(&env.agent, "create_sub_mandate", args, zero).await?.assert_failure();
    assert!(env.mandate(id).await?.children.is_empty());

    // A valid sub-mandate moves budget out of the parent.
    let args = env.sub_mandate_args(id, n(1), m(500), vec![&env.api]);
    let child: u64 = env.ok(&env.agent, "create_sub_mandate", args).await?;
    let parent = env.mandate(id).await?;
    assert_eq!((parent.delegated, parent.children), (n(1), vec![child]));

    // The child agent spends within its own narrower limits.
    assert_eq!(env.pay_as(&env.child, child, &env.api, m(300)).await?.status, "Paid");
    let r = env.pay_as(&env.child, child, &env.worker, m(100)).await?;
    assert_eq!(r.status, "Blocked", "worker is on the parent's allowlist but not the child's");
    Ok(())
}

// ------------------------------------------------------------------ M3: escrow

#[tokio::test]
async fn escrow_release_and_refund() -> R<()> {
    let env = setup().await?;
    let id = env.create_mandate(n(5)).await?;

    // post -> two bids -> counter-offer -> accept the cheaper final bid.
    let t: u64 = env.ok(&env.agent, "post_task", json!({ "mandate_id": id, "description": "scrape 3 pages", "max_price": m(750) })).await?;
    let zero = NearToken::from_yoctonear(0);
    env.call(&env.worker, "submit_bid", json!({ "task_id": t, "price": m(600) }), zero).await?.assert_success();
    env.call(&env.worker2, "submit_bid", json!({ "task_id": t, "price": m(700) }), zero).await?.assert_success();
    env.call(&env.worker, "submit_bid", json!({ "task_id": t, "price": m(500) }), zero).await?.assert_success();
    let bids: Vec<Value> = env.view("get_bids", json!({ "task_id": t })).await?;
    assert_eq!(bids.len(), 2);

    let r: ActionResult = env.ok(&env.agent, "accept_bid", json!({ "task_id": t, "worker": env.worker })).await?;
    assert_eq!(r.status, "Locked", "{r:?}");
    assert_eq!(env.mandate(id).await?.locked, m(500));
    let task: Value = env.view("get_task", json!({ "task_id": t })).await?;
    assert_eq!(task["status"], "Locked");

    // release pays the worker.
    let worker_before = env.balance(&env.worker).await?;
    let r: ActionResult = env.ok(&env.agent, "release", json!({ "task_id": t })).await?;
    assert_eq!(r.status, "Paid", "{r:?}");
    assert_eq!(env.balance(&env.worker).await?, worker_before.saturating_add(m(500)));
    let mandate = env.mandate(id).await?;
    assert_eq!((mandate.locked, mandate.spent), (NearToken::from_yoctonear(0), m(500)));

    // refund returns locked funds to the mandate.
    let t2: u64 = env.ok(&env.agent, "post_task", json!({ "mandate_id": id, "description": "summarize", "max_price": m(400) })).await?;
    env.call(&env.worker2, "submit_bid", json!({ "task_id": t2, "price": m(400) }), zero).await?.assert_success();
    env.ok::<ActionResult>(&env.agent, "accept_bid", json!({ "task_id": t2, "worker": env.worker2 })).await?;
    assert_eq!(env.mandate(id).await?.locked, m(400));
    let worker2_before = env.balance(&env.worker2).await?;
    let r: ActionResult = env.ok(&env.agent, "refund", json!({ "task_id": t2 })).await?;
    assert_eq!(r.status, "Refunded");
    let mandate = env.mandate(id).await?;
    assert_eq!((mandate.locked, mandate.spent), (NearToken::from_yoctonear(0), m(500)));
    assert_eq!(env.balance(&env.worker2).await?, worker2_before);
    assert_eq!(
        env.receipt_kinds(id).await?,
        vec!["EscrowLock", "EscrowRelease", "EscrowLock", "Refund"]
    );
    Ok(())
}

// ------------------------------------------------------------------ M3: revoke

#[tokio::test]
async fn revoke_refunds_owner_and_disables_children() -> R<()> {
    let env = setup().await?;
    let id = env.create_mandate(n(5)).await?;
    let args = env.sub_mandate_args(id, n(1), m(500), vec![&env.api]);
    let child: u64 = env.ok(&env.agent, "create_sub_mandate", args).await?;
    assert_eq!(env.pay(id, &env.api, m(300)).await?.status, "Paid");
    assert_eq!(env.pay_as(&env.child, child, &env.api, m(200)).await?.status, "Paid");
    env.pay(id, &env.api, m(900)).await?; // pending, dropped by revoke

    // The agent cannot revoke.
    env.call(&env.agent, "revoke", json!({ "mandate_id": id }), NearToken::from_yoctonear(0))
        .await?
        .assert_failure();

    let owner_before = env.balance(&env.owner).await?;
    let r: RevokeResult = env.ok(&env.owner, "revoke", json!({ "mandate_id": id })).await?;
    // parent: 5 − 0.3 spent − 1 delegated = 3.7; child: 1 − 0.2 = 0.8
    assert_eq!(r.refunded, m(4500));
    assert_eq!(r.revoked, vec![id, child]);
    let owner_after = env.balance(&env.owner).await?;
    let gained = owner_after.saturating_sub(owner_before);
    assert!(
        gained <= m(4500) && gained > m(4490),
        "owner should get 4.5 NEAR minus gas, got {}",
        gained.exact_amount_display()
    );

    assert!(!env.mandate(id).await?.active);
    assert!(!env.mandate(child).await?.active);
    assert!(env.pending().await?.is_empty());

    // Both agents are now blocked, on-chain.
    let r = env.pay_as(&env.child, child, &env.api, m(100)).await?;
    assert_eq!(r.status, "Blocked");
    assert!(r.reason.as_deref().unwrap().contains("not active"));
    assert_eq!(env.pay(id, &env.api, m(100)).await?.status, "Blocked");
    Ok(())
}

// ------------------------------------------------------------------ S1: foreign payments

const SEPOLIA_VENDOR: &str = "0x000000000000000000000000000000000000aa";

#[derive(Deserialize, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
struct ForeignAuthResult {
    status: String,
    reason: Option<String>,
}

impl Env {
    async fn set_foreign_policy(&self, mandate_id: u64, allowlist: Vec<&str>, per_tx_cents: u64, daily_cents: u64, budget_cents: u64) -> R<()> {
        self.call(
            &self.owner,
            "set_foreign_policy",
            json!({
                "mandate_id": mandate_id,
                "allowlist": allowlist,
                "per_tx_cap_usd_cents": per_tx_cents,
                "daily_cap_usd_cents": daily_cents,
                "budget_usd_cents": budget_cents,
            }),
            NearToken::from_yoctonear(0),
        )
        .await?
        .assert_success();
        Ok(())
    }

    async fn authorize_foreign(&self, mandate_id: u64, to: &str, amount_cents: u64) -> R<ForeignAuthResult> {
        self.ok(
            &self.agent,
            "authorize_foreign_payment",
            json!({ "mandate_id": mandate_id, "chain": "ethereum-sepolia", "to": to, "amount_usd_cents": amount_cents, "memo": "demo" }),
        )
        .await
    }
}

#[tokio::test]
async fn foreign_payment_authorized_then_blocked_for_non_allowlisted() -> R<()> {
    let env = setup().await?;
    let id = env.create_mandate(n(5)).await?;

    // No policy set yet -> every cap is 0 -> blocked.
    let r = env.authorize_foreign(id, SEPOLIA_VENDOR, 100).await?;
    assert_eq!(r.status, "Blocked");
    assert!(r.reason.as_deref().unwrap().contains("not on the allowlist"));

    // Owner authorizes SEPOLIA_VENDOR up to 500 cents/tx, 1000/day, 2000 total.
    env.set_foreign_policy(id, vec![SEPOLIA_VENDOR], 500, 1000, 2000).await?;

    let r = env.authorize_foreign(id, SEPOLIA_VENDOR, 300).await?;
    assert_eq!(r.status, "Authorized", "{r:?}");
    let policy: Value = env.view("get_foreign_policy", json!({ "mandate_id": id })).await?;
    assert_eq!(policy["spent_usd_cents"], 300);

    // A different foreign address (e.g. the attack button's target) is blocked,
    // even though the mandate itself is funded.
    let attacker_addr = "0x000000000000000000000000000000000000ee";
    let r = env.authorize_foreign(id, attacker_addr, 100).await?;
    assert_eq!(r.status, "Blocked");
    assert!(r.reason.as_deref().unwrap().contains("not on the allowlist"));

    let receipts: Vec<Value> = env.view("get_foreign_receipts", json!({ "mandate_id": id })).await?;
    assert_eq!(receipts.len(), 3);
    assert_eq!(
        receipts.iter().map(|r| r["status"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["Blocked", "Authorized", "Blocked"]
    );
    Ok(())
}

// ------------------------------------------------------------------ S1: upgrade safety
//
// The Vault is already deployed with live state (see deployments/testnet.json).
// This proves the `migrate` upgrade path works against that exact pre-S1 wasm:
// old mandates/receipts survive untouched, and the new foreign-payment methods
// work immediately after.

#[tokio::test]
async fn upgrade_preserves_old_state_and_adds_foreign_payments() -> R<()> {
    let old_wasm = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/vault_v1_live.wasm"))?;
    let new_wasm_path = cargo_near_build::build_with_cli(Default::default())?;
    let new_wasm = std::fs::read(new_wasm_path)?;

    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
    let vault = create_account(&sandbox, "vault.sandbox").await?;
    let owner = create_account(&sandbox, "owner.sandbox").await?;
    let agent = create_account(&sandbox, "agent.sandbox").await?;
    let api = create_account(&sandbox, "api.sandbox").await?;

    // Deploy the exact wasm that is live on testnet today, with no migrate call
    // (it predates `migrate` entirely), and build up real pre-upgrade state.
    near_api::Contract::deploy(vault.clone())
        .use_code(old_wasm)
        .without_init_call()
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    async fn call(net: &NetworkConfig, signer: Arc<Signer>, vault: AccountId, who: AccountId, method: &str, args: Value, deposit: NearToken) -> R<TransactionResult> {
        Ok(near_api::Contract(vault)
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(NearGas::from_tgas(100))
            .with_signer(who, signer)
            .send_to(net)
            .await?)
    }

    call(
        &net,
        signer.clone(),
        vault.clone(),
        owner.clone(),
        "create_mandate",
        json!({ "agent": agent, "per_tx_cap": n(1), "daily_cap": n(2), "allowlist": [api.clone()], "approval_threshold": m(800) }),
        n(5),
    )
    .await?
    .assert_success();
    call(
        &net,
        signer.clone(),
        vault.clone(),
        agent.clone(),
        "pay",
        json!({ "mandate_id": 0, "to": api, "amount": m(300), "memo": "pre-upgrade" }),
        NearToken::from_yoctonear(0),
    )
    .await?
    .assert_success();

    async fn view<T: DeserializeOwned + Send + Sync + 'static>(net: &NetworkConfig, vault: AccountId, method: &str, args: Value) -> R<T> {
        Ok(near_api::Contract(vault).call_function(method, args).read_only().fetch_from(net).await?.data)
    }

    let mandate_before: Value = view(&net, vault.clone(), "get_mandate", json!({ "mandate_id": 0 })).await?;
    assert_eq!(mandate_before["spent"], m(300).as_yoctonear().to_string());
    assert_eq!(mandate_before["receipt_count"], 1);

    // Upgrade: deploy the current wasm and run `migrate` in the same transaction,
    // exactly as scripts/deploy.ts will do against the real testnet vault.
    near_api::Contract::deploy(vault.clone())
        .use_code(new_wasm.clone())
        .with_init_call("migrate", json!({}))?
        .max_gas()
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Old state is untouched.
    let mandate_after: Value = view(&net, vault.clone(), "get_mandate", json!({ "mandate_id": 0 })).await?;
    assert_eq!(mandate_after, mandate_before);
    let receipts: Vec<Value> = view(&net, vault.clone(), "get_receipts", json!({ "mandate_id": 0 })).await?;
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0]["kind"], "Payment");

    // New S1 methods work right away.
    call(
        &net,
        signer.clone(),
        vault.clone(),
        owner.clone(),
        "set_foreign_policy",
        json!({ "mandate_id": 0, "allowlist": [SEPOLIA_VENDOR], "per_tx_cap_usd_cents": 500, "daily_cap_usd_cents": 1000, "budget_usd_cents": 2000 }),
        NearToken::from_yoctonear(0),
    )
    .await?
    .assert_success();
    let r = call(
        &net,
        signer.clone(),
        vault.clone(),
        agent.clone(),
        "authorize_foreign_payment",
        json!({ "mandate_id": 0, "chain": "ethereum-sepolia", "to": SEPOLIA_VENDOR, "amount_usd_cents": 300, "memo": "post-upgrade" }),
        NearToken::from_yoctonear(0),
    )
    .await?
    .assert_success();
    let parsed: ForeignAuthResult = r.json()?;
    assert_eq!(parsed.status, "Authorized", "{parsed:?}");

    // Re-running migrate a second time must fail: the bytes on chain are no
    // longer VaultV1-shaped, and only the contract itself could call it anyway.
    near_api::Contract::deploy(vault.clone())
        .use_code(new_wasm)
        .with_init_call("migrate", json!({}))?
        .max_gas()
        .with_signer(signer)
        .send_to(&net)
        .await?
        .assert_failure();
    Ok(())
}

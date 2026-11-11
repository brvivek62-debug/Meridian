//! Integration tests: build the Vault wasm, deploy it to a local NEAR sandbox,
//! and exercise `pay` through real transactions (real transfers, real logs).

use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{Value, json};
use std::sync::Arc;

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct PayResult {
    status: String,
    receipt_id: u64,
    reason: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct Mandate {
    spent: NearToken,
    spent_today: NearToken,
    receipt_count: u32,
}

struct Env {
    _sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    vault: AccountId,
    owner: AccountId,
    agent: AccountId,
    api: AccountId,
    attacker: AccountId,
}

async fn create_account(sb: &near_sandbox::Sandbox, name: &str) -> testresult::TestResult<AccountId> {
    let id: AccountId = name.parse()?;
    sb.create_account(id.as_str().parse()?)
        .initial_balance(NearToken::from_near(20))
        .send()
        .await?;
    Ok(id)
}

async fn setup() -> testresult::TestResult<Env> {
    let wasm_path = cargo_near_build::build_with_cli(Default::default())?;
    let wasm = std::fs::read(wasm_path)?;

    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
    )?;

    let vault = create_account(&sandbox, "vault.sandbox").await?;
    let owner = create_account(&sandbox, "owner.sandbox").await?;
    let agent = create_account(&sandbox, "agent.sandbox").await?;
    let api = create_account(&sandbox, "api.sandbox").await?;
    let attacker = create_account(&sandbox, "attacker.sandbox").await?;

    near_api::Contract::deploy(vault.clone())
        .use_code(wasm)
        .without_init_call()
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    Ok(Env { _sandbox: sandbox, net, signer, vault, owner, agent, api, attacker })
}

impl Env {
    /// 5 NEAR budget, 1 NEAR per-tx cap, 2 NEAR daily cap, allowlist = [api].
    async fn create_mandate(&self, budget: NearToken) -> testresult::TestResult<String> {
        let id: String = near_api::Contract(self.vault.clone())
            .call_function(
                "create_mandate",
                json!({
                    "agent": self.agent,
                    "per_tx_cap": NearToken::from_near(1),
                    "daily_cap": NearToken::from_near(2),
                    "allowlist": [self.api],
                    "approval_threshold": NearToken::from_millinear(800),
                }),
            )
            .transaction()
            .deposit(budget)
            .with_signer(self.owner.clone(), self.signer.clone())
            .send_to(&self.net)
            .await?
            .assert_success()
            .json()?;
        Ok(id)
    }

    async fn pay(&self, mandate_id: &str, to: &AccountId, amount: NearToken) -> testresult::TestResult<PayResult> {
        let res = near_api::Contract(self.vault.clone())
            .call_function(
                "pay",
                json!({ "mandate_id": mandate_id, "to": to, "amount": amount, "memo": "test" }),
            )
            .transaction()
            .gas(NearGas::from_tgas(50))
            .with_signer(self.agent.clone(), self.signer.clone())
            .send_to(&self.net)
            .await?
            .assert_success();
        // Every pay must emit a NEP-297 meridian event.
        assert!(
            res.logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"standard\":\"meridian\"")),
            "no NEP-297 event in logs: {:?}",
            res.logs()
        );
        Ok(res.json()?)
    }

    async fn mandate(&self, id: &str) -> testresult::TestResult<Mandate> {
        Ok(near_api::Contract(self.vault.clone())
            .call_function("get_mandate", json!({ "mandate_id": id }))
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    async fn receipts(&self, id: &str) -> testresult::TestResult<Vec<Value>> {
        Ok(near_api::Contract(self.vault.clone())
            .call_function("get_receipts", json!({ "mandate_id": id }))
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    async fn balance(&self, id: &AccountId) -> testresult::TestResult<NearToken> {
        Ok(near_api::Tokens::account(id.clone())
            .near_balance()
            .fetch_from(&self.net)
            .await?
            .total)
    }
}

#[tokio::test]
async fn vault_policy_end_to_end() -> testresult::TestResult<()> {
    let env = setup().await?;
    let id = env.create_mandate(NearToken::from_near(5)).await?;

    // 1. Normal payment: vendor receives the funds, mandate books the spend.
    let api_before = env.balance(&env.api).await?;
    let r = env.pay(&id, &env.api, NearToken::from_millinear(300)).await?;
    assert_eq!(r.status, "Paid", "{r:?}");
    assert_eq!(env.balance(&env.api).await?, api_before.saturating_add(NearToken::from_millinear(300)));
    assert_eq!(env.mandate(&id).await?.spent, NearToken::from_millinear(300));

    // 2. Over per-tx cap -> Blocked. The tx itself succeeds (no panic) and nothing moves.
    let api_before = env.balance(&env.api).await?;
    let r = env.pay(&id, &env.api, NearToken::from_millinear(1500)).await?;
    assert_eq!(r.status, "Blocked");
    assert!(r.reason.as_deref().unwrap().contains("per-tx cap"), "{r:?}");
    assert_eq!(env.balance(&env.api).await?, api_before);

    // 3. Non-allowlisted vendor -> Blocked, attacker gets nothing.
    let attacker_before = env.balance(&env.attacker).await?;
    let r = env.pay(&id, &env.attacker, NearToken::from_millinear(100)).await?;
    assert_eq!(r.status, "Blocked");
    assert!(r.reason.as_deref().unwrap().contains("not on the allowlist"), "{r:?}");
    assert_eq!(env.balance(&env.attacker).await?, attacker_before);

    // Blocked attempts are stored as receipts, visible through the view.
    let receipts = env.receipts(&id).await?;
    let kinds: Vec<&str> = receipts.iter().map(|r| r["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["Payment", "Blocked", "Blocked"]);
    assert_eq!(receipts[2]["id"].as_u64().unwrap(), r.receipt_id);
    assert_eq!(env.mandate(&id).await?.receipt_count, 3);
    Ok(())
}

#[tokio::test]
async fn over_budget_is_blocked() -> testresult::TestResult<()> {
    let env = setup().await?;
    let id = env.create_mandate(NearToken::from_near(1)).await?;
    assert_eq!(env.pay(&id, &env.api, NearToken::from_millinear(700)).await?.status, "Paid");
    let r = env.pay(&id, &env.api, NearToken::from_millinear(400)).await?;
    assert_eq!(r.status, "Blocked");
    assert!(r.reason.as_deref().unwrap().contains("remaining budget"), "{r:?}");
    assert_eq!(env.mandate(&id).await?.spent, NearToken::from_millinear(700));
    Ok(())
}

/// The daily cap blocks once 2 NEAR is spent in the window.
///
/// The 24h *rollover* is covered by the unit test
/// `daily_cap_blocks_then_rolls_over_after_24h` (src/lib.rs), which sets the block
/// timestamp directly. Sandbox `fast_forward` advances the clock only ~0.4s per
/// block here, so reaching 24h would need ~216k blocks (~35 min per run).
#[tokio::test]
async fn daily_cap_blocks() -> testresult::TestResult<()> {
    let env = setup().await?;
    let id = env.create_mandate(NearToken::from_near(5)).await?;

    assert_eq!(env.pay(&id, &env.api, NearToken::from_near(1)).await?.status, "Paid");
    assert_eq!(env.pay(&id, &env.api, NearToken::from_near(1)).await?.status, "Paid");
    let r = env.pay(&id, &env.api, NearToken::from_millinear(100)).await?;
    assert_eq!(r.status, "Blocked");
    assert!(r.reason.as_deref().unwrap().contains("daily cap"), "{r:?}");
    let m = env.mandate(&id).await?;
    assert_eq!(m.spent_today, NearToken::from_near(2));
    assert_eq!(m.spent, NearToken::from_near(2));
    Ok(())
}

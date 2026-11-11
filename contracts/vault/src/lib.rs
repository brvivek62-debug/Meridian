//! Meridian Vault — delegated, policy-checked spending for AI agents.
//!
//! An owner funds a *mandate* by attaching NEAR to `create_mandate`. The
//! mandate's agent can then spend through `pay`, which enforces every policy
//! rule on-chain. A payment that breaks a rule does NOT panic: it is recorded
//! as a `Blocked` receipt (stored + emitted as a NEP-297 event) so the attempt
//! stays visible on-chain.

use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PromiseOrValue, env, near, require,
};

/// Length of the daily-cap window.
pub const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
/// Minimum budget for a new mandate (anti-spam: mandate storage is paid by the Vault).
pub const MIN_BUDGET: NearToken = NearToken::from_millinear(100);
/// Upper bounds on caller-controlled data, to bound storage use per call.
pub const MAX_ALLOWLIST: usize = 20;
pub const MAX_MEMO_LEN: usize = 256;
/// Max receipts returned by one `get_receipts` call.
pub const MAX_RECEIPTS_PAGE: u32 = 100;
/// Gas reserved for the `on_payment_complete` callback.
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Mandates,
    OwnerMandates,
    Receipts,
    MandateReceipts,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Mandate {
    pub id: u64,
    /// Human who funded the mandate.
    pub owner: AccountId,
    /// Agent account allowed to spend.
    pub agent: AccountId,
    /// Parent mandate, for sub-mandates (M3). Always `None` in M2.
    pub parent: Option<u64>,
    /// Total allowance (the deposit attached to `create_mandate`).
    pub budget: NearToken,
    pub spent: NearToken,
    pub per_tx_cap: NearToken,
    pub daily_cap: NearToken,
    pub spent_today: NearToken,
    /// Start of the current daily-cap window, in ns.
    pub day_start_ns: U64,
    /// Empty = any vendor allowed.
    pub allowlist: Vec<AccountId>,
    /// Payments above this go to pending approval (enforced from M3).
    pub approval_threshold: NearToken,
    pub active: bool,
    /// Number of receipts recorded for this mandate.
    pub receipt_count: u32,
}

impl Mandate {
    pub fn remaining(&self) -> NearToken {
        self.budget.saturating_sub(self.spent)
    }

    /// Reset the daily window if 24h have passed since it started.
    fn roll_day(&mut self, now_ns: u64) {
        if now_ns.saturating_sub(self.day_start_ns.0) >= DAY_NS {
            self.day_start_ns = U64(now_ns);
            self.spent_today = NearToken::from_yoctonear(0);
        }
    }

    /// Every policy rule a payment must pass. Returns all violations, not just the first,
    /// so a blocked receipt explains everything that was wrong.
    fn violations(&self, to: &AccountId, amount: NearToken) -> Vec<String> {
        let mut v = Vec::new();
        if !self.active {
            v.push("mandate is not active".to_string());
        }
        if amount.is_zero() {
            v.push("amount must be greater than 0".to_string());
        }
        if !self.allowlist.is_empty() && !self.allowlist.contains(to) {
            v.push(format!("vendor {to} is not on the allowlist"));
        }
        if amount > self.per_tx_cap {
            v.push(format!(
                "amount {} exceeds per-tx cap {}",
                amount.exact_amount_display(),
                self.per_tx_cap.exact_amount_display()
            ));
        }
        if amount > self.remaining() {
            v.push(format!(
                "amount {} exceeds remaining budget {}",
                amount.exact_amount_display(),
                self.remaining().exact_amount_display()
            ));
        }
        if self.spent_today.saturating_add(amount) > self.daily_cap {
            v.push(format!(
                "amount {} would exceed daily cap {} (spent today {})",
                amount.exact_amount_display(),
                self.daily_cap.exact_amount_display(),
                self.spent_today.exact_amount_display()
            ));
        }
        v
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum ReceiptKind {
    Payment,
    EscrowLock,
    EscrowRelease,
    Refund,
    Blocked,
}

impl ReceiptKind {
    fn event_name(&self) -> &'static str {
        match self {
            ReceiptKind::Payment => "payment",
            ReceiptKind::EscrowLock => "escrow_lock",
            ReceiptKind::EscrowRelease => "escrow_release",
            ReceiptKind::Refund => "refund",
            ReceiptKind::Blocked => "blocked",
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Receipt {
    pub id: u64,
    pub mandate_id: u64,
    pub to: AccountId,
    pub amount: NearToken,
    pub memo: String,
    pub kind: ReceiptKind,
    /// Why a payment was blocked or refunded.
    pub reason: Option<String>,
    pub ts_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub enum PayStatus {
    Paid,
    Blocked,
    /// Policy passed but the transfer failed (e.g. receiver missing); funds returned to the mandate.
    Failed,
}

/// Result of `pay`. Blocked payments return this instead of panicking.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PayResult {
    pub status: PayStatus,
    pub receipt_id: u64,
    pub reason: Option<String>,
}

#[near(contract_state)]
pub struct Vault {
    next_mandate_id: u64,
    next_receipt_id: u64,
    mandates: LookupMap<u64, Mandate>,
    owner_mandates: LookupMap<AccountId, Vec<u64>>,
    receipts: LookupMap<u64, Receipt>,
    /// (mandate_id, index within mandate) -> receipt id
    mandate_receipts: LookupMap<(u64, u32), u64>,
}

impl Default for Vault {
    fn default() -> Self {
        Self {
            next_mandate_id: 0,
            next_receipt_id: 0,
            mandates: LookupMap::new(StorageKey::Mandates),
            owner_mandates: LookupMap::new(StorageKey::OwnerMandates),
            receipts: LookupMap::new(StorageKey::Receipts),
            mandate_receipts: LookupMap::new(StorageKey::MandateReceipts),
        }
    }
}

#[near]
impl Vault {
    /// Create a mandate. The attached deposit becomes the budget. Returns the mandate id.
    #[payable]
    pub fn create_mandate(
        &mut self,
        agent: AccountId,
        per_tx_cap: NearToken,
        daily_cap: NearToken,
        allowlist: Vec<AccountId>,
        approval_threshold: NearToken,
    ) -> U64 {
        let budget = env::attached_deposit();
        require!(
            budget >= MIN_BUDGET,
            format!("attach at least {} as the budget", MIN_BUDGET.exact_amount_display())
        );
        require!(!per_tx_cap.is_zero(), "per_tx_cap must be greater than 0");
        require!(!daily_cap.is_zero(), "daily_cap must be greater than 0");
        require!(allowlist.len() <= MAX_ALLOWLIST, "allowlist too long");

        let mut allowlist = allowlist;
        allowlist.sort();
        allowlist.dedup();

        let owner = env::predecessor_account_id();
        let id = self.next_mandate_id;
        self.next_mandate_id += 1;

        let mandate = Mandate {
            id,
            owner: owner.clone(),
            agent,
            parent: None,
            budget,
            spent: NearToken::from_yoctonear(0),
            per_tx_cap,
            daily_cap,
            spent_today: NearToken::from_yoctonear(0),
            day_start_ns: U64(env::block_timestamp()),
            allowlist,
            approval_threshold,
            active: true,
            receipt_count: 0,
        };

        emit_event("mandate_created", json!([mandate]));
        self.mandates.insert(id, mandate);
        self.owner_mandates.entry(owner).or_default().push(id);
        U64(id)
    }

    /// Pay `amount` from a mandate to `to`. Callable only by the mandate's agent.
    ///
    /// Policy violations do not panic: they log a `Blocked` receipt and return
    /// `PayResult { status: Blocked }`, so the attempt is recorded on-chain.
    pub fn pay(
        &mut self,
        mandate_id: U64,
        to: AccountId,
        amount: NearToken,
        memo: String,
    ) -> PromiseOrValue<PayResult> {
        let mandate_id = mandate_id.0;
        let mut mandate = self.mandates.get(&mandate_id).cloned().unwrap_or_else(|| {
            env::panic_str("mandate not found");
        });
        // Only the agent can spend. Unauthorized callers panic rather than writing a
        // receipt, so outsiders cannot fill the Vault's storage with junk.
        require!(
            env::predecessor_account_id() == mandate.agent,
            "only the mandate's agent can pay"
        );
        require!(memo.len() <= MAX_MEMO_LEN, "memo too long");

        let now = env::block_timestamp();
        mandate.roll_day(now);

        let violations = mandate.violations(&to, amount);
        if !violations.is_empty() {
            let reason = violations.join("; ");
            let receipt_id = self.record_receipt(
                &mut mandate,
                to,
                amount,
                memo,
                ReceiptKind::Blocked,
                Some(reason.clone()),
            );
            self.mandates.insert(mandate_id, mandate);
            return PromiseOrValue::Value(PayResult {
                status: PayStatus::Blocked,
                receipt_id,
                reason: Some(reason),
            });
        }

        // Book the spend before the transfer; the callback reverts it if the transfer fails.
        mandate.spent = mandate.spent.saturating_add(amount);
        mandate.spent_today = mandate.spent_today.saturating_add(amount);
        let receipt_id = self.record_receipt(
            &mut mandate,
            to.clone(),
            amount,
            memo,
            ReceiptKind::Payment,
            None,
        );
        self.mandates.insert(mandate_id, mandate);

        PromiseOrValue::Promise(
            near_sdk::Promise::new(to).transfer(amount).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CALLBACK)
                    .on_payment_complete(U64(mandate_id), U64(receipt_id), amount),
            ),
        )
    }

    /// Callback after a payment transfer. On failure, returns the funds to the mandate
    /// and logs a `Refund` receipt.
    #[private]
    pub fn on_payment_complete(
        &mut self,
        mandate_id: U64,
        receipt_id: U64,
        amount: NearToken,
    ) -> PayResult {
        if env::promise_result_checked(0, 0).is_ok() {
            return PayResult {
                status: PayStatus::Paid,
                receipt_id: receipt_id.0,
                reason: None,
            };
        }
        let mut mandate = self
            .mandates
            .get(&mandate_id.0)
            .cloned()
            .unwrap_or_else(|| env::panic_str("mandate not found"));
        let to = self
            .receipts
            .get(&receipt_id.0)
            .map(|r| r.to.clone())
            .unwrap_or_else(|| mandate.agent.clone());
        mandate.spent = mandate.spent.saturating_sub(amount);
        mandate.spent_today = mandate.spent_today.saturating_sub(amount);
        let reason = format!("transfer for receipt {} failed; funds returned", receipt_id.0);
        let refund_id = self.record_receipt(
            &mut mandate,
            to,
            amount,
            String::new(),
            ReceiptKind::Refund,
            Some(reason.clone()),
        );
        self.mandates.insert(mandate_id.0, mandate);
        PayResult {
            status: PayStatus::Failed,
            receipt_id: refund_id,
            reason: Some(reason),
        }
    }

    // ---------- views ----------

    pub fn get_mandate(&self, mandate_id: U64) -> Option<Mandate> {
        self.mandates.get(&mandate_id.0).cloned()
    }

    pub fn get_mandates_by_owner(&self, owner: AccountId) -> Vec<Mandate> {
        self.owner_mandates
            .get(&owner)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| self.mandates.get(id).cloned())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Receipts of one mandate, oldest first. `from` is the index within the mandate.
    pub fn get_receipts(&self, mandate_id: U64, from: Option<u32>, limit: Option<u32>) -> Vec<Receipt> {
        let Some(mandate) = self.mandates.get(&mandate_id.0) else {
            return vec![];
        };
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(MAX_RECEIPTS_PAGE).min(MAX_RECEIPTS_PAGE);
        let end = from.saturating_add(limit).min(mandate.receipt_count);
        (from..end)
            .filter_map(|i| self.mandate_receipts.get(&(mandate_id.0, i)))
            .filter_map(|rid| self.receipts.get(rid).cloned())
            .collect()
    }
}

impl Vault {
    /// Store a receipt, index it under its mandate, and emit it as a NEP-297 event.
    fn record_receipt(
        &mut self,
        mandate: &mut Mandate,
        to: AccountId,
        amount: NearToken,
        memo: String,
        kind: ReceiptKind,
        reason: Option<String>,
    ) -> u64 {
        let id = self.next_receipt_id;
        self.next_receipt_id += 1;
        let receipt = Receipt {
            id,
            mandate_id: mandate.id,
            to,
            amount,
            memo,
            kind,
            reason,
            ts_ns: U64(env::block_timestamp()),
        };
        emit_event(receipt.kind.event_name(), json!([receipt]));
        self.receipts.insert(id, receipt);
        self.mandate_receipts.insert((mandate.id, mandate.receipt_count), id);
        mandate.receipt_count += 1;
        id
    }
}

/// Emit a NEP-297 event: `EVENT_JSON:{"standard":"meridian","version":"1.0.0",...}`.
fn emit_event(event: &str, data: near_sdk::serde_json::Value) {
    let payload = json!({
        "standard": "meridian",
        "version": "1.0.0",
        "event": event,
        "data": data,
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, get_logs};
    use near_sdk::{PromiseResult, testing_env};

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn near(n: u128) -> NearToken {
        NearToken::from_near(n)
    }
    fn milli(n: u128) -> NearToken {
        NearToken::from_millinear(n)
    }

    fn ctx(predecessor: &str, deposit: NearToken, ts: u64) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(acc("vault.testnet"))
                .predecessor_account_id(acc(predecessor))
                .attached_deposit(deposit)
                .block_timestamp(ts)
                .build()
        );
    }

    /// 5 NEAR budget, 1 NEAR per-tx, 2 NEAR daily, allowlist = api + worker.
    fn setup() -> (Vault, U64) {
        let mut v = Vault::default();
        ctx("owner.testnet", near(5), 1_000);
        let id = v.create_mandate(
            acc("agent.testnet"),
            near(1),
            near(2),
            vec![acc("api.testnet"), acc("worker.testnet")],
            milli(800),
        );
        (v, id)
    }

    fn pay_value(r: PromiseOrValue<PayResult>) -> PayResult {
        match r {
            PromiseOrValue::Value(v) => v,
            PromiseOrValue::Promise(_) => panic!("expected a value (blocked), got a promise"),
        }
    }

    #[test]
    fn create_mandate_sets_budget_and_indexes_owner() {
        let (v, id) = setup();
        let m = v.get_mandate(id).unwrap();
        assert_eq!(m.budget, near(5));
        assert_eq!(m.owner, acc("owner.testnet"));
        assert!(m.active);
        assert_eq!(v.get_mandates_by_owner(acc("owner.testnet")).len(), 1);
        assert!(get_logs()[0].starts_with("EVENT_JSON:{"));
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn create_mandate_requires_min_budget() {
        let mut v = Vault::default();
        ctx("owner.testnet", milli(1), 0);
        v.create_mandate(acc("agent.testnet"), near(1), near(1), vec![], near(1));
    }

    #[test]
    fn normal_payment_books_spend_and_receipt() {
        let (mut v, id) = setup();
        ctx("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        let r = v.pay(id, acc("api.testnet"), milli(300), "q1".into());
        assert!(matches!(r, PromiseOrValue::Promise(_)));
        let m = v.get_mandate(id).unwrap();
        assert_eq!(m.spent, milli(300));
        assert_eq!(m.spent_today, milli(300));
        let rs = v.get_receipts(id, None, None);
        assert_eq!(rs.len(), 1);
        assert_eq!(rs[0].kind, ReceiptKind::Payment);
        let log = get_logs().pop().unwrap();
        assert!(log.contains("\"standard\":\"meridian\"") && log.contains("\"event\":\"payment\""));
    }

    #[test]
    fn over_per_tx_cap_is_blocked_without_panic() {
        let (mut v, id) = setup();
        ctx("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        let r = pay_value(v.pay(id, acc("api.testnet"), milli(1500), "".into()));
        assert_eq!(r.status, PayStatus::Blocked);
        assert!(r.reason.unwrap().contains("per-tx cap"));
        let m = v.get_mandate(id).unwrap();
        assert!(m.spent.is_zero());
        assert_eq!(v.get_receipts(id, None, None)[0].kind, ReceiptKind::Blocked);
        assert!(get_logs().pop().unwrap().contains("\"event\":\"blocked\""));
    }

    #[test]
    fn non_allowlisted_vendor_is_blocked() {
        let (mut v, id) = setup();
        ctx("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        let r = pay_value(v.pay(id, acc("attacker.testnet"), milli(100), "".into()));
        assert_eq!(r.status, PayStatus::Blocked);
        assert!(r.reason.unwrap().contains("not on the allowlist"));
    }

    #[test]
    fn blocked_receipt_lists_every_violation() {
        let (mut v, id) = setup();
        ctx("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        let r = pay_value(v.pay(id, acc("attacker.testnet"), near(5), "".into()));
        let reason = r.reason.unwrap();
        assert!(reason.contains("allowlist") && reason.contains("per-tx cap") && reason.contains("daily cap"));
    }

    #[test]
    fn daily_cap_blocks_then_rolls_over_after_24h() {
        let (mut v, id) = setup();
        let t0 = 2_000;
        ctx("agent.testnet", NearToken::from_yoctonear(0), t0);
        let _ = v.pay(id, acc("api.testnet"), near(1), "".into());
        let _ = v.pay(id, acc("api.testnet"), near(1), "".into());
        // 2 NEAR spent today = daily cap; a third payment is blocked.
        let r = pay_value(v.pay(id, acc("api.testnet"), milli(100), "".into()));
        assert_eq!(r.status, PayStatus::Blocked);
        assert!(r.reason.unwrap().contains("daily cap"));
        // Just before the window ends: still blocked.
        ctx("agent.testnet", NearToken::from_yoctonear(0), 1_000 + DAY_NS - 1);
        let r = pay_value(v.pay(id, acc("api.testnet"), milli(100), "".into()));
        assert_eq!(r.status, PayStatus::Blocked);
        // 24h after the window started: the window resets and the payment goes through.
        ctx("agent.testnet", NearToken::from_yoctonear(0), 1_000 + DAY_NS);
        let r = v.pay(id, acc("api.testnet"), milli(100), "".into());
        assert!(matches!(r, PromiseOrValue::Promise(_)));
        let m = v.get_mandate(id).unwrap();
        assert_eq!(m.spent_today, milli(100));
        assert_eq!(m.spent, milli(2100));
    }

    #[test]
    fn over_remaining_budget_is_blocked() {
        let mut v = Vault::default();
        ctx("owner.testnet", near(1), 0);
        let id = v.create_mandate(acc("agent.testnet"), near(1), near(10), vec![], near(1));
        ctx("agent.testnet", NearToken::from_yoctonear(0), 1);
        let _ = v.pay(id, acc("api.testnet"), milli(700), "".into());
        let r = pay_value(v.pay(id, acc("api.testnet"), milli(400), "".into()));
        assert_eq!(r.status, PayStatus::Blocked);
        assert!(r.reason.unwrap().contains("remaining budget"));
    }

    #[test]
    #[should_panic(expected = "only the mandate's agent can pay")]
    fn non_agent_cannot_pay() {
        let (mut v, id) = setup();
        ctx("stranger.testnet", NearToken::from_yoctonear(0), 2_000);
        let _ = v.pay(id, acc("api.testnet"), milli(100), "".into());
    }

    #[test]
    fn failed_transfer_refunds_mandate() {
        let (mut v, id) = setup();
        ctx("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        let _ = v.pay(id, acc("api.testnet"), milli(300), "".into());
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(acc("vault.testnet"))
                .predecessor_account_id(acc("vault.testnet"))
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed],
        );
        let r = v.on_payment_complete(id, U64(0), milli(300));
        assert_eq!(r.status, PayStatus::Failed);
        let m = v.get_mandate(id).unwrap();
        assert!(m.spent.is_zero());
        let rs = v.get_receipts(id, None, None);
        assert_eq!(rs[1].kind, ReceiptKind::Refund);
    }

    #[test]
    fn get_receipts_paginates() {
        let (mut v, id) = setup();
        ctx("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        for _ in 0..5 {
            let _ = v.pay(id, acc("attacker.testnet"), milli(1), "".into());
        }
        assert_eq!(v.get_receipts(id, Some(1), Some(2)).iter().map(|r| r.id).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(v.get_receipts(id, Some(4), Some(10)).len(), 1);
        assert!(v.get_receipts(U64(99), None, None).is_empty());
    }
}

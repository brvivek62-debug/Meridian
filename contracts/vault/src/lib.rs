//! Meridian Vault — delegated, policy-checked spending for AI agents.
//!
//! An owner funds a *mandate* by attaching NEAR to `create_mandate`. The
//! mandate's agent can spend only through this contract, and every rule is
//! enforced on-chain:
//!
//! - `pay`: policy checks; above the approval threshold the payment waits as
//!   a `PendingPayment` until the owner calls `approve` / `reject`.
//! - `create_sub_mandate`: delegate part of the remaining budget to another
//!   agent with limits that are never looser than the parent's.
//! - Escrow: `post_task` → `submit_bid` → `accept_bid` (locks funds) → `release` / `refund`.
//! - `revoke`: the owner deactivates a mandate and its whole subtree and gets the
//!   unspent funds back.
//!
//! Policy violations by the agent do NOT panic: they are recorded as `Blocked`
//! receipts so the attempt stays visible on-chain. Every receipt is stored and
//! emitted as a NEP-297 event.

use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, Promise, PromiseOrValue, env, near, require,
};

/// Length of the daily-cap window.
pub const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
/// Minimum budget for a new top-level mandate (anti-spam: storage is paid by the Vault).
pub const MIN_BUDGET: NearToken = NearToken::from_millinear(100);
/// Upper bounds on caller-controlled data, to bound storage and gas per call.
pub const MAX_ALLOWLIST: usize = 20;
pub const MAX_MEMO_LEN: usize = 256;
pub const MAX_DESCRIPTION_LEN: usize = 512;
pub const MAX_PAGE: u32 = 100;
/// Delegation tree bounds, so `revoke` always fits in one transaction (≤ 31 mandates).
pub const MAX_CHILDREN: usize = 5;
pub const MAX_DEPTH: u8 = 2;
pub const MAX_PENDING_PER_OWNER: usize = 50;
pub const MAX_BIDS_PER_TASK: usize = 20;
/// Gas reserved for the `on_transfer_complete` callback.
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(10);
const ZERO: NearToken = NearToken::from_yoctonear(0);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Mandates,
    OwnerMandates,
    Receipts,
    MandateReceipts,
    Pending,
    OwnerPending,
    Tasks,
    Bids,
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Mandate {
    pub id: u64,
    /// Human who funded the mandate. Sub-mandates keep the root owner.
    pub owner: AccountId,
    /// Agent account allowed to spend.
    pub agent: AccountId,
    pub parent: Option<u64>,
    /// 0 for a top-level mandate.
    pub depth: u8,
    pub children: Vec<u64>,
    /// Total allowance.
    pub budget: NearToken,
    /// Paid out to vendors and workers.
    pub spent: NearToken,
    /// Moved into sub-mandates.
    pub delegated: NearToken,
    /// Held in escrow for accepted tasks.
    pub locked: NearToken,
    /// Refunded to the owner on revoke.
    pub returned: NearToken,
    pub per_tx_cap: NearToken,
    pub daily_cap: NearToken,
    /// Paid + escrow-locked in the current 24h window.
    pub spent_today: NearToken,
    pub day_start_ns: U64,
    /// Empty = any vendor allowed.
    pub allowlist: Vec<AccountId>,
    /// Payments above this wait for owner approval.
    pub approval_threshold: NearToken,
    pub active: bool,
    pub receipt_count: u32,
}

impl Mandate {
    /// budget − spent − delegated − locked − returned
    pub fn remaining(&self) -> NearToken {
        self.budget
            .saturating_sub(self.spent)
            .saturating_sub(self.delegated)
            .saturating_sub(self.locked)
            .saturating_sub(self.returned)
    }

    /// Reset the daily window once 24h have passed since it started.
    fn roll_day(&mut self, now_ns: u64) {
        if now_ns.saturating_sub(self.day_start_ns.0) >= DAY_NS {
            self.day_start_ns = U64(now_ns);
            self.spent_today = ZERO;
        }
    }

    /// Every policy rule a payment must pass. Returns all violations, not just the
    /// first, so a blocked receipt explains everything that was wrong.
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
                fmt(amount),
                fmt(self.per_tx_cap)
            ));
        }
        if amount > self.remaining() {
            v.push(format!(
                "amount {} exceeds remaining budget {}",
                fmt(amount),
                fmt(self.remaining())
            ));
        }
        if self.spent_today.saturating_add(amount) > self.daily_cap {
            v.push(format!(
                "amount {} would exceed daily cap {} (spent today {})",
                fmt(amount),
                fmt(self.daily_cap),
                fmt(self.spent_today)
            ));
        }
        v
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum ReceiptKind {
    /// Funds transferred to a vendor.
    Payment,
    /// Payment above the approval threshold, waiting for the owner.
    Pending,
    /// Pending payment rejected by the owner.
    Rejected,
    /// Policy violation; nothing moved.
    Blocked,
    /// Budget moved from this mandate into a sub-mandate.
    Delegation,
    /// Funds locked in escrow for a task.
    EscrowLock,
    /// Escrowed funds paid to the worker.
    EscrowRelease,
    /// Funds returned (escrow refund, failed transfer, or revoke → owner).
    Refund,
}

impl ReceiptKind {
    fn event_name(&self) -> &'static str {
        match self {
            ReceiptKind::Payment => "payment",
            ReceiptKind::Pending => "pending",
            ReceiptKind::Rejected => "rejected",
            ReceiptKind::Blocked => "blocked",
            ReceiptKind::Delegation => "delegation",
            ReceiptKind::EscrowLock => "escrow_lock",
            ReceiptKind::EscrowRelease => "escrow_release",
            ReceiptKind::Refund => "refund",
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
    /// Why a payment was blocked, rejected or refunded.
    pub reason: Option<String>,
    /// Related object: pending id (Pending/Rejected/approved Payment), task id
    /// (escrow receipts), or child mandate id (Delegation).
    pub ref_id: Option<u64>,
    pub ts_ns: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingPayment {
    pub id: u64,
    pub mandate_id: u64,
    pub owner: AccountId,
    pub to: AccountId,
    pub amount: NearToken,
    pub memo: String,
    pub created_ns: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum TaskStatus {
    Open,
    Locked,
    Released,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Task {
    pub id: u64,
    pub mandate_id: u64,
    pub poster: AccountId,
    pub description: String,
    pub max_price: NearToken,
    pub status: TaskStatus,
    pub worker: Option<AccountId>,
    pub price: Option<NearToken>,
    pub created_ns: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Bid {
    pub task_id: u64,
    pub worker: AccountId,
    pub price: NearToken,
    pub ts_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub enum ActionStatus {
    /// Funds transferred.
    Paid,
    /// Waiting for owner approval.
    Pending,
    /// Policy violation; nothing moved.
    Blocked,
    /// Policy passed but the transfer failed; funds returned.
    Failed,
    /// Funds locked in escrow.
    Locked,
    Refunded,
    Rejected,
}

/// Result of `pay`, `approve`, `reject`, `accept_bid`, `release`, `refund`.
/// Blocked actions return this instead of panicking.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ActionResult {
    pub status: ActionStatus,
    pub receipt_id: u64,
    pub reason: Option<String>,
    pub pending_id: Option<u64>,
}

impl ActionResult {
    fn new(status: ActionStatus, receipt_id: u64, reason: Option<String>) -> Self {
        Self { status, receipt_id, reason, pending_id: None }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RevokeResult {
    /// Every mandate deactivated by this call (the target and its active descendants).
    pub revoked: Vec<u64>,
    /// Total transferred back to the owner.
    pub refunded: NearToken,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[near(contract_state)]
pub struct Vault {
    next_mandate_id: u64,
    next_receipt_id: u64,
    next_pending_id: u64,
    next_task_id: u64,
    mandates: LookupMap<u64, Mandate>,
    owner_mandates: LookupMap<AccountId, Vec<u64>>,
    receipts: LookupMap<u64, Receipt>,
    /// (mandate_id, index within mandate) -> receipt id
    mandate_receipts: LookupMap<(u64, u32), u64>,
    pending: LookupMap<u64, PendingPayment>,
    owner_pending: LookupMap<AccountId, Vec<u64>>,
    tasks: LookupMap<u64, Task>,
    bids: LookupMap<u64, Vec<Bid>>,
}

impl Default for Vault {
    fn default() -> Self {
        Self {
            next_mandate_id: 0,
            next_receipt_id: 0,
            next_pending_id: 0,
            next_task_id: 0,
            mandates: LookupMap::new(StorageKey::Mandates),
            owner_mandates: LookupMap::new(StorageKey::OwnerMandates),
            receipts: LookupMap::new(StorageKey::Receipts),
            mandate_receipts: LookupMap::new(StorageKey::MandateReceipts),
            pending: LookupMap::new(StorageKey::Pending),
            owner_pending: LookupMap::new(StorageKey::OwnerPending),
            tasks: LookupMap::new(StorageKey::Tasks),
            bids: LookupMap::new(StorageKey::Bids),
        }
    }
}

#[near]
impl Vault {
    // ----- mandates -----

    /// Create a top-level mandate. The attached deposit becomes the budget.
    #[payable]
    pub fn create_mandate(
        &mut self,
        agent: AccountId,
        per_tx_cap: NearToken,
        daily_cap: NearToken,
        allowlist: Vec<AccountId>,
        approval_threshold: NearToken,
    ) -> u64 {
        let budget = env::attached_deposit();
        require!(
            budget >= MIN_BUDGET,
            format!("attach at least {} as the budget", fmt(MIN_BUDGET))
        );
        let owner = env::predecessor_account_id();
        let mandate = self.new_mandate(
            owner, agent, None, 0, budget, per_tx_cap, daily_cap, allowlist, approval_threshold,
        );
        mandate.id
    }

    /// Delegate part of a mandate's remaining budget to another agent.
    /// Callable by the parent's agent. Every limit must be ≤ the parent's and the
    /// allowlist must be a subset of the parent's; otherwise this panics.
    #[allow(clippy::too_many_arguments)]
    pub fn create_sub_mandate(
        &mut self,
        parent_id: u64,
        agent: AccountId,
        budget: NearToken,
        per_tx_cap: NearToken,
        daily_cap: NearToken,
        allowlist: Vec<AccountId>,
        approval_threshold: NearToken,
    ) -> u64 {
        let mut parent = self.mandate(parent_id);
        require!(
            env::predecessor_account_id() == parent.agent,
            "only the parent mandate's agent can create a sub-mandate"
        );
        require!(parent.active, "parent mandate is not active");
        require!(parent.depth < MAX_DEPTH, "maximum delegation depth reached");
        require!(parent.children.len() < MAX_CHILDREN, "maximum number of sub-mandates reached");
        require!(!budget.is_zero(), "budget must be greater than 0");
        require!(
            budget <= parent.remaining(),
            "sub-mandate budget exceeds parent's remaining budget"
        );
        require!(per_tx_cap <= parent.per_tx_cap, "per_tx_cap exceeds parent's");
        require!(daily_cap <= parent.daily_cap, "daily_cap exceeds parent's");
        require!(
            approval_threshold <= parent.approval_threshold,
            "approval_threshold exceeds parent's"
        );
        if !parent.allowlist.is_empty() {
            // An empty allowlist means "any vendor", which is broader than the parent's.
            require!(
                !allowlist.is_empty() && allowlist.iter().all(|a| parent.allowlist.contains(a)),
                "allowlist must be a non-empty subset of the parent's allowlist"
            );
        }

        let child = self.new_mandate(
            parent.owner.clone(),
            agent.clone(),
            Some(parent_id),
            parent.depth + 1,
            budget,
            per_tx_cap,
            daily_cap,
            allowlist,
            approval_threshold,
        );
        parent.delegated = parent.delegated.saturating_add(budget);
        parent.children.push(child.id);
        self.record_receipt(
            &mut parent,
            agent,
            budget,
            String::new(),
            ReceiptKind::Delegation,
            None,
            Some(child.id),
        );
        self.mandates.insert(parent_id, parent);
        child.id
    }

    /// Owner only. Deactivates the mandate and all its active descendants and
    /// transfers their combined remaining budget to the owner. Pending payments
    /// of revoked mandates are dropped. Escrow that is already locked stays
    /// locked until the owner releases or refunds it.
    pub fn revoke(&mut self, mandate_id: u64) -> RevokeResult {
        let root = self.mandate(mandate_id);
        require!(
            env::predecessor_account_id() == root.owner,
            "only the mandate owner can revoke"
        );
        require!(root.active, "mandate is not active");
        let owner = root.owner.clone();

        let mut revoked = Vec::new();
        let mut refunded = ZERO;
        let mut stack = vec![mandate_id];
        while let Some(id) = stack.pop() {
            let mut m = self.mandate(id);
            if !m.active {
                // Already revoked earlier, together with its own subtree.
                continue;
            }
            m.active = false;
            let amount = m.remaining();
            m.returned = m.returned.saturating_add(amount);
            refunded = refunded.saturating_add(amount);
            self.record_receipt(
                &mut m,
                owner.clone(),
                amount,
                String::new(),
                ReceiptKind::Refund,
                Some("mandate revoked; remaining budget returned to owner".to_string()),
                None,
            );
            stack.extend(m.children.iter().copied());
            revoked.push(id);
            self.mandates.insert(id, m);
        }

        // Drop pending payments that belong to revoked mandates.
        if let Some(ids) = self.owner_pending.get(&owner).cloned() {
            let mut keep = Vec::new();
            for pid in ids {
                match self.pending.get(&pid) {
                    Some(p) if revoked.contains(&p.mandate_id) => {
                        self.pending.remove(&pid);
                    }
                    Some(_) => keep.push(pid),
                    None => {}
                }
            }
            self.owner_pending.insert(owner.clone(), keep);
        }

        emit_event(
            "mandate_revoked",
            json!([{ "mandate_id": mandate_id, "revoked": revoked, "refunded": refunded }]),
        );
        if !refunded.is_zero() {
            Promise::new(owner).transfer(refunded).detach();
        }
        RevokeResult { revoked, refunded }
    }

    // ----- payments -----

    /// Pay `amount` from a mandate to `to`. Callable only by the mandate's agent.
    ///
    /// - Policy violation → `Blocked` receipt, returns `{status: Blocked}` (no panic).
    /// - Above the approval threshold → `PendingPayment` + `Pending` receipt.
    /// - Otherwise → transfer + `Payment` receipt.
    pub fn pay(
        &mut self,
        mandate_id: u64,
        to: AccountId,
        amount: NearToken,
        memo: String,
    ) -> PromiseOrValue<ActionResult> {
        let mut mandate = self.mandate(mandate_id);
        // Only the agent can spend. Unauthorized callers panic rather than writing a
        // receipt, so outsiders cannot fill the Vault's storage with junk.
        require!(
            env::predecessor_account_id() == mandate.agent,
            "only the mandate's agent can pay"
        );
        require!(memo.len() <= MAX_MEMO_LEN, "memo too long");
        mandate.roll_day(env::block_timestamp());

        let mut violations = mandate.violations(&to, amount);
        let needs_approval = amount > mandate.approval_threshold;
        if violations.is_empty() && needs_approval {
            let count = self.owner_pending.get(&mandate.owner).map_or(0, |v| v.len());
            if count >= MAX_PENDING_PER_OWNER {
                violations.push("too many payments waiting for approval".to_string());
            }
        }
        if !violations.is_empty() {
            return PromiseOrValue::Value(self.block(mandate, to, amount, memo, violations, None));
        }

        if needs_approval {
            let pending_id = self.next_pending_id;
            self.next_pending_id += 1;
            let pending = PendingPayment {
                id: pending_id,
                mandate_id,
                owner: mandate.owner.clone(),
                to: to.clone(),
                amount,
                memo: memo.clone(),
                created_ns: U64(env::block_timestamp()),
            };
            self.pending.insert(pending_id, pending);
            self.owner_pending.entry(mandate.owner.clone()).or_default().push(pending_id);
            let reason = format!(
                "amount {} is above approval threshold {}; waiting for owner",
                fmt(amount),
                fmt(mandate.approval_threshold)
            );
            let receipt_id = self.record_receipt(
                &mut mandate,
                to,
                amount,
                memo,
                ReceiptKind::Pending,
                Some(reason.clone()),
                Some(pending_id),
            );
            self.mandates.insert(mandate_id, mandate);
            return PromiseOrValue::Value(ActionResult {
                status: ActionStatus::Pending,
                receipt_id,
                reason: Some(reason),
                pending_id: Some(pending_id),
            });
        }

        self.execute_payment(mandate, to, amount, memo, None)
    }

    /// Owner only. Re-runs every policy check at approval time; if one fails the
    /// payment is `Blocked` instead. Either way the pending payment is consumed.
    pub fn approve(&mut self, pending_id: u64) -> PromiseOrValue<ActionResult> {
        let p = self.take_pending(pending_id);
        let mut mandate = self.mandate(p.mandate_id);
        mandate.roll_day(env::block_timestamp());
        let violations = mandate.violations(&p.to, p.amount);
        if !violations.is_empty() {
            return PromiseOrValue::Value(self.block(
                mandate,
                p.to,
                p.amount,
                p.memo,
                violations,
                Some(pending_id),
            ));
        }
        self.execute_payment(mandate, p.to, p.amount, p.memo, Some(pending_id))
    }

    /// Owner only. Drops a pending payment; nothing moves.
    pub fn reject(&mut self, pending_id: u64) -> ActionResult {
        let p = self.take_pending(pending_id);
        let mut mandate = self.mandate(p.mandate_id);
        let reason = "rejected by owner".to_string();
        let receipt_id = self.record_receipt(
            &mut mandate,
            p.to,
            p.amount,
            p.memo,
            ReceiptKind::Rejected,
            Some(reason.clone()),
            Some(pending_id),
        );
        self.mandates.insert(p.mandate_id, mandate);
        ActionResult::new(ActionStatus::Rejected, receipt_id, Some(reason))
    }

    // ----- escrow -----

    /// Mandate's agent posts a task. Returns the task id.
    pub fn post_task(&mut self, mandate_id: u64, description: String, max_price: NearToken) -> u64 {
        let mandate = self.mandate(mandate_id);
        require!(
            env::predecessor_account_id() == mandate.agent,
            "only the mandate's agent can post tasks"
        );
        require!(mandate.active, "mandate is not active");
        require!(!max_price.is_zero(), "max_price must be greater than 0");
        require!(description.len() <= MAX_DESCRIPTION_LEN, "description too long");
        let id = self.next_task_id;
        self.next_task_id += 1;
        let task = Task {
            id,
            mandate_id,
            poster: mandate.agent,
            description,
            max_price,
            status: TaskStatus::Open,
            worker: None,
            price: None,
            created_ns: U64(env::block_timestamp()),
        };
        emit_event("task_posted", json!([task]));
        self.tasks.insert(id, task);
        id
    }

    /// Any worker bids on an open task. Bidding again replaces the worker's
    /// previous bid (this is how a counter-offer is answered).
    pub fn submit_bid(&mut self, task_id: u64, price: NearToken) {
        let task = self.task(task_id);
        let worker = env::predecessor_account_id();
        require!(task.status == TaskStatus::Open, "task is not open");
        require!(worker != task.poster, "poster cannot bid on its own task");
        require!(!price.is_zero(), "price must be greater than 0");
        require!(price <= task.max_price, "price exceeds the task's max_price");
        let bid = Bid { task_id, worker: worker.clone(), price, ts_ns: U64(env::block_timestamp()) };
        let bids = self.bids.entry(task_id).or_default();
        if let Some(existing) = bids.iter_mut().find(|b| b.worker == worker) {
            *existing = bid.clone();
        } else {
            require!(bids.len() < MAX_BIDS_PER_TASK, "too many bids on this task");
            bids.push(bid.clone());
        }
        emit_event("bid_submitted", json!([bid]));
    }

    /// Poster accepts a worker's bid. Runs the same policy checks as `pay` with
    /// the worker as vendor, then locks the price in escrow. Escrow above the
    /// approval threshold is blocked, so escrow cannot be used to skip approval.
    pub fn accept_bid(&mut self, task_id: u64, worker: AccountId) -> ActionResult {
        let mut task = self.task(task_id);
        require!(
            env::predecessor_account_id() == task.poster,
            "only the task poster can accept a bid"
        );
        require!(task.status == TaskStatus::Open, "task is not open");
        let price = self
            .bids
            .get(&task_id)
            .and_then(|bids| bids.iter().find(|b| b.worker == worker))
            .map(|b| b.price)
            .unwrap_or_else(|| env::panic_str("no bid from this worker"));

        let mut mandate = self.mandate(task.mandate_id);
        mandate.roll_day(env::block_timestamp());
        let mut violations = mandate.violations(&worker, price);
        if price > mandate.approval_threshold {
            violations.push(format!(
                "escrow price {} is above approval threshold {}",
                fmt(price),
                fmt(mandate.approval_threshold)
            ));
        }
        if !violations.is_empty() {
            return self.block(mandate, worker, price, String::new(), violations, Some(task_id));
        }

        mandate.locked = mandate.locked.saturating_add(price);
        mandate.spent_today = mandate.spent_today.saturating_add(price);
        let receipt_id = self.record_receipt(
            &mut mandate,
            worker.clone(),
            price,
            String::new(),
            ReceiptKind::EscrowLock,
            None,
            Some(task_id),
        );
        self.mandates.insert(task.mandate_id, mandate);
        task.status = TaskStatus::Locked;
        task.worker = Some(worker);
        task.price = Some(price);
        self.tasks.insert(task_id, task);
        ActionResult::new(ActionStatus::Locked, receipt_id, None)
    }

    /// Pay the escrowed price to the worker. Callable by the poster while the
    /// mandate is active, or by the owner at any time.
    pub fn release(&mut self, task_id: u64) -> PromiseOrValue<ActionResult> {
        let mut task = self.task(task_id);
        let mut mandate = self.mandate(task.mandate_id);
        self.require_can_settle(&task, &mandate);
        require!(task.status == TaskStatus::Locked, "task is not locked");
        let (worker, price) = (task.worker.clone().unwrap(), task.price.unwrap());

        mandate.locked = mandate.locked.saturating_sub(price);
        mandate.spent = mandate.spent.saturating_add(price);
        let receipt_id = self.record_receipt(
            &mut mandate,
            worker.clone(),
            price,
            String::new(),
            ReceiptKind::EscrowRelease,
            None,
            Some(task_id),
        );
        self.mandates.insert(task.mandate_id, mandate);
        task.status = TaskStatus::Released;
        let mandate_id = task.mandate_id;
        self.tasks.insert(task_id, task);
        PromiseOrValue::Promise(self.transfer_with_callback(
            worker,
            price,
            mandate_id,
            receipt_id,
            Some(task_id),
        ))
    }

    /// Cancel an open task, or return a locked task's escrow. Callable by the
    /// poster while the mandate is active, or by the owner at any time. If the
    /// mandate was revoked, locked escrow goes straight to the owner.
    pub fn refund(&mut self, task_id: u64) -> ActionResult {
        let mut task = self.task(task_id);
        let mut mandate = self.mandate(task.mandate_id);
        self.require_can_settle(&task, &mandate);
        let (to, amount, reason) = match task.status {
            TaskStatus::Open => (task.poster.clone(), ZERO, "task cancelled before any funds were locked"),
            TaskStatus::Locked => {
                let price = task.price.unwrap();
                mandate.locked = mandate.locked.saturating_sub(price);
                mandate.spent_today = mandate.spent_today.saturating_sub(price);
                if mandate.active {
                    (task.poster.clone(), price, "escrow returned to mandate")
                } else {
                    mandate.returned = mandate.returned.saturating_add(price);
                    Promise::new(mandate.owner.clone()).transfer(price).detach();
                    (mandate.owner.clone(), price, "mandate revoked; escrow returned to owner")
                }
            }
            _ => env::panic_str("task is already settled"),
        };
        let receipt_id = self.record_receipt(
            &mut mandate,
            to,
            amount,
            String::new(),
            ReceiptKind::Refund,
            Some(reason.to_string()),
            Some(task_id),
        );
        self.mandates.insert(task.mandate_id, mandate);
        task.status = TaskStatus::Refunded;
        self.tasks.insert(task_id, task);
        ActionResult::new(ActionStatus::Refunded, receipt_id, Some(reason.to_string()))
    }

    /// Callback after a payment or escrow-release transfer. On failure the amount
    /// goes back to the mandate (or to the owner if the mandate was revoked).
    #[private]
    pub fn on_transfer_complete(
        &mut self,
        mandate_id: u64,
        receipt_id: u64,
        amount: NearToken,
        task_id: Option<u64>,
    ) -> ActionResult {
        if env::promise_result_checked(0, 0).is_ok() {
            return ActionResult::new(ActionStatus::Paid, receipt_id, None);
        }
        let mut mandate = self.mandate(mandate_id);
        let to = self
            .receipts
            .get(&receipt_id)
            .map(|r| r.to.clone())
            .unwrap_or_else(|| mandate.agent.clone());
        mandate.spent = mandate.spent.saturating_sub(amount);
        mandate.spent_today = mandate.spent_today.saturating_sub(amount);
        let reason = if mandate.active {
            format!("transfer for receipt {receipt_id} failed; funds returned to mandate")
        } else {
            mandate.returned = mandate.returned.saturating_add(amount);
            Promise::new(mandate.owner.clone()).transfer(amount).detach();
            format!("transfer for receipt {receipt_id} failed; mandate revoked, funds returned to owner")
        };
        let refund_id = self.record_receipt(
            &mut mandate,
            to,
            amount,
            String::new(),
            ReceiptKind::Refund,
            Some(reason.clone()),
            task_id,
        );
        self.mandates.insert(mandate_id, mandate);
        if let Some(tid) = task_id
            && let Some(mut task) = self.tasks.get(&tid).cloned()
        {
            task.status = TaskStatus::Refunded;
            self.tasks.insert(tid, task);
        }
        ActionResult::new(ActionStatus::Failed, refund_id, Some(reason))
    }

    // ----- views -----

    pub fn get_mandate(&self, mandate_id: u64) -> Option<Mandate> {
        self.mandates.get(&mandate_id).cloned()
    }

    /// All mandates the owner funded, including sub-mandates (use `parent` /
    /// `children` to build the delegation tree).
    pub fn get_mandates_by_owner(&self, owner: AccountId) -> Vec<Mandate> {
        self.owner_mandates
            .get(&owner)
            .map(|ids| ids.iter().filter_map(|id| self.mandates.get(id).cloned()).collect())
            .unwrap_or_default()
    }

    /// Receipts of one mandate, oldest first. `from` is the index within the mandate.
    pub fn get_receipts(&self, mandate_id: u64, from: Option<u32>, limit: Option<u32>) -> Vec<Receipt> {
        let Some(mandate) = self.mandates.get(&mandate_id) else {
            return vec![];
        };
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE);
        let end = from.saturating_add(limit).min(mandate.receipt_count);
        (from..end)
            .filter_map(|i| self.mandate_receipts.get(&(mandate_id, i)))
            .filter_map(|rid| self.receipts.get(rid).cloned())
            .collect()
    }

    /// Payments waiting for this owner's approval.
    pub fn get_pending(&self, owner: AccountId) -> Vec<PendingPayment> {
        self.owner_pending
            .get(&owner)
            .map(|ids| ids.iter().filter_map(|id| self.pending.get(id).cloned()).collect())
            .unwrap_or_default()
    }

    pub fn get_task(&self, task_id: u64) -> Option<Task> {
        self.tasks.get(&task_id).cloned()
    }

    /// Tasks by id, oldest first (for workers watching for open tasks).
    pub fn get_tasks(&self, from: Option<u64>, limit: Option<u32>) -> Vec<Task> {
        let from = from.unwrap_or(0);
        let end = from
            .saturating_add(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as u64)
            .min(self.next_task_id);
        (from..end).filter_map(|id| self.tasks.get(&id).cloned()).collect()
    }

    pub fn get_bids(&self, task_id: u64) -> Vec<Bid> {
        self.bids.get(&task_id).cloned().unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

impl Vault {
    fn mandate(&self, id: u64) -> Mandate {
        self.mandates
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("mandate not found"))
    }

    fn task(&self, id: u64) -> Task {
        self.tasks
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("task not found"))
    }

    #[allow(clippy::too_many_arguments)]
    fn new_mandate(
        &mut self,
        owner: AccountId,
        agent: AccountId,
        parent: Option<u64>,
        depth: u8,
        budget: NearToken,
        per_tx_cap: NearToken,
        daily_cap: NearToken,
        allowlist: Vec<AccountId>,
        approval_threshold: NearToken,
    ) -> Mandate {
        require!(!per_tx_cap.is_zero(), "per_tx_cap must be greater than 0");
        require!(!daily_cap.is_zero(), "daily_cap must be greater than 0");
        require!(allowlist.len() <= MAX_ALLOWLIST, "allowlist too long");
        let mut allowlist = allowlist;
        allowlist.sort();
        allowlist.dedup();

        let id = self.next_mandate_id;
        self.next_mandate_id += 1;
        let mandate = Mandate {
            id,
            owner: owner.clone(),
            agent,
            parent,
            depth,
            children: vec![],
            budget,
            spent: ZERO,
            delegated: ZERO,
            locked: ZERO,
            returned: ZERO,
            per_tx_cap,
            daily_cap,
            spent_today: ZERO,
            day_start_ns: U64(env::block_timestamp()),
            allowlist,
            approval_threshold,
            active: true,
            receipt_count: 0,
        };
        emit_event("mandate_created", json!([mandate]));
        self.mandates.insert(id, mandate.clone());
        self.owner_mandates.entry(owner).or_default().push(id);
        mandate
    }

    /// Remove a pending payment after checking the caller is its owner.
    fn take_pending(&mut self, pending_id: u64) -> PendingPayment {
        let p = self
            .pending
            .get(&pending_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("pending payment not found"));
        require!(
            env::predecessor_account_id() == p.owner,
            "only the mandate owner can approve or reject"
        );
        self.pending.remove(&pending_id);
        if let Some(ids) = self.owner_pending.get_mut(&p.owner) {
            ids.retain(|id| *id != pending_id);
        }
        p
    }

    fn require_can_settle(&self, task: &Task, mandate: &Mandate) {
        let caller = env::predecessor_account_id();
        require!(
            (caller == task.poster && mandate.active) || caller == mandate.owner,
            "only the poster (while the mandate is active) or the owner can settle this task"
        );
    }

    /// Record a Blocked receipt and save the mandate. Nothing moves.
    fn block(
        &mut self,
        mut mandate: Mandate,
        to: AccountId,
        amount: NearToken,
        memo: String,
        violations: Vec<String>,
        ref_id: Option<u64>,
    ) -> ActionResult {
        let reason = violations.join("; ");
        let receipt_id = self.record_receipt(
            &mut mandate,
            to,
            amount,
            memo,
            ReceiptKind::Blocked,
            Some(reason.clone()),
            ref_id,
        );
        self.mandates.insert(mandate.id, mandate);
        ActionResult::new(ActionStatus::Blocked, receipt_id, Some(reason))
    }

    /// Book the spend, record a Payment receipt and transfer. The callback reverts
    /// the booking if the transfer fails.
    fn execute_payment(
        &mut self,
        mut mandate: Mandate,
        to: AccountId,
        amount: NearToken,
        memo: String,
        pending_id: Option<u64>,
    ) -> PromiseOrValue<ActionResult> {
        mandate.spent = mandate.spent.saturating_add(amount);
        mandate.spent_today = mandate.spent_today.saturating_add(amount);
        let receipt_id = self.record_receipt(
            &mut mandate,
            to.clone(),
            amount,
            memo,
            ReceiptKind::Payment,
            None,
            pending_id,
        );
        let mandate_id = mandate.id;
        self.mandates.insert(mandate_id, mandate);
        PromiseOrValue::Promise(self.transfer_with_callback(to, amount, mandate_id, receipt_id, None))
    }

    fn transfer_with_callback(
        &self,
        to: AccountId,
        amount: NearToken,
        mandate_id: u64,
        receipt_id: u64,
        task_id: Option<u64>,
    ) -> Promise {
        Promise::new(to).transfer(amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_CALLBACK)
                .on_transfer_complete(mandate_id, receipt_id, amount, task_id),
        )
    }

    /// Store a receipt, index it under its mandate, and emit it as a NEP-297 event.
    #[allow(clippy::too_many_arguments)]
    fn record_receipt(
        &mut self,
        mandate: &mut Mandate,
        to: AccountId,
        amount: NearToken,
        memo: String,
        kind: ReceiptKind,
        reason: Option<String>,
        ref_id: Option<u64>,
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
            ref_id,
            ts_ns: U64(env::block_timestamp()),
        };
        emit_event(receipt.kind.event_name(), json!([receipt]));
        self.receipts.insert(id, receipt);
        self.mandate_receipts.insert((mandate.id, mandate.receipt_count), id);
        mandate.receipt_count += 1;
        id
    }
}

fn fmt(t: NearToken) -> String {
    t.exact_amount_display()
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
mod tests;

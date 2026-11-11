//! Unit tests (near-sdk `testing_env!`). Promises are not executed here, so
//! transfers are checked in tests/sandbox.rs; callbacks are called directly.

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

const OWNER: &str = "owner.testnet";
const AGENT: &str = "agent.testnet";
const CHILD: &str = "child.testnet";
const API: &str = "api.testnet";
const WORKER: &str = "worker.testnet";
const WORKER2: &str = "worker2.testnet";
const ATTACKER: &str = "attacker.testnet";

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
fn as_(who: &str) {
    ctx(who, ZERO, 2_000);
}

/// The demo mandate: 5 NEAR budget, 1 NEAR per-tx, 2 NEAR daily,
/// allowlist = api + two workers, approval threshold 0.8 NEAR.
fn setup() -> (Vault, u64) {
    let mut v = Vault::default();
    ctx(OWNER, near(5), 1_000);
    let id = v.create_mandate(
        acc(AGENT),
        near(1),
        near(2),
        vec![acc(API), acc(WORKER), acc(WORKER2)],
        milli(800),
    );
    (v, id)
}

fn value(r: PromiseOrValue<ActionResult>) -> ActionResult {
    match r {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("expected a value, got a promise (transfer)"),
    }
}
fn is_transfer(r: &PromiseOrValue<ActionResult>) -> bool {
    matches!(r, PromiseOrValue::Promise(_))
}
fn kinds(v: &Vault, id: u64) -> Vec<ReceiptKind> {
    v.get_receipts(id, None, None).into_iter().map(|r| r.kind).collect()
}

/// Agent creates a 1 NEAR sub-mandate with allowlist [api] for CHILD.
fn with_child(v: &mut Vault, parent: u64) -> u64 {
    as_(AGENT);
    v.create_sub_mandate(parent, acc(CHILD), near(1), milli(500), near(1), vec![acc(API)], milli(400))
}

/// Agent posts a task, WORKER bids 0.6 then counters with 0.5, WORKER2 bids 0.7.
fn with_task(v: &mut Vault, mandate_id: u64) -> u64 {
    as_(AGENT);
    let t = v.post_task(mandate_id, "scrape 3 pages".into(), milli(750));
    as_(WORKER);
    v.submit_bid(t, milli(600));
    as_(WORKER2);
    v.submit_bid(t, milli(700));
    as_(WORKER);
    v.submit_bid(t, milli(500));
    t
}

// ---------------------------------------------------------------- M2: mandates + pay

#[test]
fn create_mandate_sets_budget_and_indexes_owner() {
    let (v, id) = setup();
    let m = v.get_mandate(id).unwrap();
    assert_eq!(m.budget, near(5));
    assert_eq!(m.remaining(), near(5));
    assert_eq!(m.owner, acc(OWNER));
    assert!(m.active);
    assert_eq!(v.get_mandates_by_owner(acc(OWNER)).len(), 1);
    assert!(get_logs()[0].starts_with("EVENT_JSON:{"));
}

#[test]
#[should_panic(expected = "attach at least")]
fn create_mandate_requires_min_budget() {
    let mut v = Vault::default();
    ctx(OWNER, milli(1), 0);
    v.create_mandate(acc(AGENT), near(1), near(1), vec![], near(1));
}

#[test]
fn normal_payment_books_spend_and_receipt() {
    let (mut v, id) = setup();
    as_(AGENT);
    assert!(is_transfer(&v.pay(id, acc(API), milli(300), "q1".into())));
    let m = v.get_mandate(id).unwrap();
    assert_eq!(m.spent, milli(300));
    assert_eq!(m.spent_today, milli(300));
    assert_eq!(kinds(&v, id), vec![ReceiptKind::Payment]);
    let log = get_logs().pop().unwrap();
    assert!(log.contains("\"standard\":\"meridian\"") && log.contains("\"event\":\"payment\""));
}

#[test]
fn over_per_tx_cap_is_blocked_without_panic() {
    let (mut v, id) = setup();
    as_(AGENT);
    let r = value(v.pay(id, acc(API), milli(1500), "".into()));
    assert_eq!(r.status, ActionStatus::Blocked);
    assert!(r.reason.unwrap().contains("per-tx cap"));
    assert!(v.get_mandate(id).unwrap().spent.is_zero());
    assert_eq!(kinds(&v, id), vec![ReceiptKind::Blocked]);
    assert!(get_logs().pop().unwrap().contains("\"event\":\"blocked\""));
}

#[test]
fn non_allowlisted_vendor_is_blocked() {
    let (mut v, id) = setup();
    as_(AGENT);
    let r = value(v.pay(id, acc(ATTACKER), milli(100), "".into()));
    assert_eq!(r.status, ActionStatus::Blocked);
    assert!(r.reason.unwrap().contains("not on the allowlist"));
}

#[test]
fn blocked_receipt_lists_every_violation() {
    let (mut v, id) = setup();
    as_(AGENT);
    let r = value(v.pay(id, acc(ATTACKER), near(5), "".into()));
    let reason = r.reason.unwrap();
    assert!(reason.contains("allowlist") && reason.contains("per-tx cap") && reason.contains("daily cap"));
    // A blocked attempt never becomes a pending approval, even above the threshold.
    assert!(v.get_pending(acc(OWNER)).is_empty());
}

#[test]
fn daily_cap_blocks_then_rolls_over_after_24h() {
    let (mut v, id) = setup();
    ctx(AGENT, ZERO, 2_000);
    for _ in 0..4 {
        assert!(is_transfer(&v.pay(id, acc(API), milli(500), "".into())));
    }
    // 2 NEAR spent today = daily cap; the next payment is blocked.
    let r = value(v.pay(id, acc(API), milli(100), "".into()));
    assert_eq!(r.status, ActionStatus::Blocked);
    assert!(r.reason.unwrap().contains("daily cap"));
    // Just before the window ends: still blocked.
    ctx(AGENT, ZERO, 1_000 + DAY_NS - 1);
    assert_eq!(value(v.pay(id, acc(API), milli(100), "".into())).status, ActionStatus::Blocked);
    // 24h after the window started: the window resets and the payment goes through.
    ctx(AGENT, ZERO, 1_000 + DAY_NS);
    assert!(is_transfer(&v.pay(id, acc(API), milli(100), "".into())));
    let m = v.get_mandate(id).unwrap();
    assert_eq!(m.spent_today, milli(100));
    assert_eq!(m.spent, milli(2100));
}

#[test]
fn over_remaining_budget_is_blocked() {
    let mut v = Vault::default();
    ctx(OWNER, near(1), 0);
    let id = v.create_mandate(acc(AGENT), near(1), near(10), vec![], near(1));
    ctx(AGENT, ZERO, 1);
    let _ = v.pay(id, acc(API), milli(700), "".into());
    let r = value(v.pay(id, acc(API), milli(400), "".into()));
    assert_eq!(r.status, ActionStatus::Blocked);
    assert!(r.reason.unwrap().contains("remaining budget"));
}

#[test]
#[should_panic(expected = "only the mandate's agent can pay")]
fn non_agent_cannot_pay() {
    let (mut v, id) = setup();
    as_("stranger.testnet");
    let _ = v.pay(id, acc(API), milli(100), "".into());
}

fn callback_ctx(result: PromiseResult) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc("vault.testnet"))
            .predecessor_account_id(acc("vault.testnet"))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

#[test]
fn failed_transfer_refunds_mandate() {
    let (mut v, id) = setup();
    as_(AGENT);
    let _ = v.pay(id, acc(API), milli(300), "".into());
    callback_ctx(PromiseResult::Failed);
    let r = v.on_transfer_complete(id, 0, milli(300), None);
    assert_eq!(r.status, ActionStatus::Failed);
    assert!(v.get_mandate(id).unwrap().spent.is_zero());
    assert_eq!(kinds(&v, id), vec![ReceiptKind::Payment, ReceiptKind::Refund]);
}

#[test]
fn get_receipts_paginates() {
    let (mut v, id) = setup();
    as_(AGENT);
    for _ in 0..5 {
        let _ = v.pay(id, acc(ATTACKER), milli(1), "".into());
    }
    let ids: Vec<u64> = v.get_receipts(id, Some(1), Some(2)).iter().map(|r| r.id).collect();
    assert_eq!(ids, vec![1, 2]);
    assert_eq!(v.get_receipts(id, Some(4), Some(10)).len(), 1);
    assert!(v.get_receipts(99, None, None).is_empty());
}

// ---------------------------------------------------------------- M3: approvals

#[test]
fn payment_above_threshold_goes_pending() {
    let (mut v, id) = setup();
    as_(AGENT);
    let r = value(v.pay(id, acc(API), milli(900), "big".into()));
    assert_eq!(r.status, ActionStatus::Pending);
    let pending = v.get_pending(acc(OWNER));
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, r.pending_id.unwrap());
    assert_eq!(pending[0].amount, milli(900));
    // Nothing is spent or reserved until approval.
    let m = v.get_mandate(id).unwrap();
    assert!(m.spent.is_zero() && m.spent_today.is_zero());
    assert_eq!(kinds(&v, id), vec![ReceiptKind::Pending]);
    assert!(get_logs().pop().unwrap().contains("\"event\":\"pending\""));
}

#[test]
fn approve_executes_pending_payment() {
    let (mut v, id) = setup();
    as_(AGENT);
    let pid = value(v.pay(id, acc(API), milli(900), "".into())).pending_id.unwrap();
    as_(OWNER);
    assert!(is_transfer(&v.approve(pid)));
    assert!(v.get_pending(acc(OWNER)).is_empty());
    let m = v.get_mandate(id).unwrap();
    assert_eq!(m.spent, milli(900));
    let rs = v.get_receipts(id, None, None);
    assert_eq!(rs[1].kind, ReceiptKind::Payment);
    assert_eq!(rs[1].ref_id, Some(pid));
}

#[test]
fn approve_rechecks_policy_at_approval_time() {
    let (mut v, id) = setup();
    as_(AGENT);
    let pid = value(v.pay(id, acc(API), milli(900), "".into())).pending_id.unwrap();
    // Meanwhile the agent spends 1.5 NEAR of the 2 NEAR daily cap.
    for _ in 0..3 {
        let _ = v.pay(id, acc(API), milli(500), "".into());
    }
    as_(OWNER);
    let r = value(v.approve(pid));
    assert_eq!(r.status, ActionStatus::Blocked);
    assert!(r.reason.unwrap().contains("daily cap"));
    assert!(v.get_pending(acc(OWNER)).is_empty());
    assert_eq!(v.get_mandate(id).unwrap().spent, milli(1500));
}

#[test]
fn reject_drops_pending_payment() {
    let (mut v, id) = setup();
    as_(AGENT);
    let pid = value(v.pay(id, acc(API), milli(900), "".into())).pending_id.unwrap();
    as_(OWNER);
    let r = v.reject(pid);
    assert_eq!(r.status, ActionStatus::Rejected);
    assert!(v.get_pending(acc(OWNER)).is_empty());
    assert!(v.get_mandate(id).unwrap().spent.is_zero());
    assert_eq!(kinds(&v, id), vec![ReceiptKind::Pending, ReceiptKind::Rejected]);
}

#[test]
#[should_panic(expected = "only the mandate owner can approve or reject")]
fn agent_cannot_approve_its_own_payment() {
    let (mut v, id) = setup();
    as_(AGENT);
    let pid = value(v.pay(id, acc(API), milli(900), "".into())).pending_id.unwrap();
    let _ = v.approve(pid);
}

#[test]
#[should_panic(expected = "pending payment not found")]
fn pending_payment_cannot_be_approved_twice() {
    let (mut v, id) = setup();
    as_(AGENT);
    let pid = value(v.pay(id, acc(API), milli(900), "".into())).pending_id.unwrap();
    as_(OWNER);
    let _ = v.approve(pid);
    let _ = v.approve(pid);
}

// ---------------------------------------------------------------- M3: sub-mandates

#[test]
fn sub_mandate_moves_budget_from_parent() {
    let (mut v, id) = setup();
    let child = with_child(&mut v, id);
    let parent = v.get_mandate(id).unwrap();
    assert_eq!(parent.delegated, near(1));
    assert_eq!(parent.remaining(), near(4));
    assert_eq!(parent.children, vec![child]);
    let c = v.get_mandate(child).unwrap();
    assert_eq!((c.owner.clone(), c.agent.clone(), c.parent, c.depth), (acc(OWNER), acc(CHILD), Some(id), 1));
    assert_eq!(c.remaining(), near(1));
    assert_eq!(v.get_mandates_by_owner(acc(OWNER)).len(), 2);
    assert_eq!(kinds(&v, id), vec![ReceiptKind::Delegation]);
    // The child agent spends within its own, narrower limits.
    as_(CHILD);
    assert!(is_transfer(&v.pay(child, acc(API), milli(300), "".into())));
    assert_eq!(value(v.pay(child, acc(WORKER), milli(100), "".into())).status, ActionStatus::Blocked);
}

fn try_sub(v: &mut Vault, parent: u64, budget: NearToken, per_tx: NearToken, daily: NearToken, allow: Vec<&str>, thr: NearToken) {
    as_(AGENT);
    v.create_sub_mandate(parent, acc(CHILD), budget, per_tx, daily, allow.into_iter().map(acc).collect(), thr);
}

#[test]
#[should_panic(expected = "per_tx_cap exceeds parent's")]
fn sub_mandate_with_higher_per_tx_cap_is_rejected() {
    let (mut v, id) = setup();
    try_sub(&mut v, id, near(1), milli(1001), near(1), vec![API], milli(400));
}

#[test]
#[should_panic(expected = "daily_cap exceeds parent's")]
fn sub_mandate_with_higher_daily_cap_is_rejected() {
    let (mut v, id) = setup();
    try_sub(&mut v, id, near(1), milli(500), near(3), vec![API], milli(400));
}

#[test]
#[should_panic(expected = "approval_threshold exceeds parent's")]
fn sub_mandate_with_higher_threshold_is_rejected() {
    let (mut v, id) = setup();
    try_sub(&mut v, id, near(1), milli(500), near(1), vec![API], near(1));
}

#[test]
#[should_panic(expected = "sub-mandate budget exceeds parent's remaining budget")]
fn sub_mandate_over_parent_remaining_is_rejected() {
    let (mut v, id) = setup();
    try_sub(&mut v, id, near(6), milli(500), near(1), vec![API], milli(400));
}

#[test]
#[should_panic(expected = "allowlist must be a non-empty subset")]
fn sub_mandate_allowlist_not_subset_is_rejected() {
    let (mut v, id) = setup();
    try_sub(&mut v, id, near(1), milli(500), near(1), vec![API, ATTACKER], milli(400));
}

#[test]
#[should_panic(expected = "allowlist must be a non-empty subset")]
fn sub_mandate_empty_allowlist_under_restricted_parent_is_rejected() {
    let (mut v, id) = setup();
    try_sub(&mut v, id, near(1), milli(500), near(1), vec![], milli(400));
}

#[test]
#[should_panic(expected = "only the parent mandate's agent")]
fn only_parent_agent_can_create_sub_mandate() {
    let (mut v, id) = setup();
    as_(OWNER);
    v.create_sub_mandate(id, acc(CHILD), near(1), milli(500), near(1), vec![acc(API)], milli(400));
}

#[test]
#[should_panic(expected = "maximum delegation depth reached")]
fn delegation_depth_is_bounded() {
    let (mut v, id) = setup();
    let c1 = with_child(&mut v, id);
    as_(CHILD);
    let c2 = v.create_sub_mandate(c1, acc("c2.testnet"), milli(500), milli(500), near(1), vec![acc(API)], milli(400));
    as_("c2.testnet");
    v.create_sub_mandate(c2, acc("c3.testnet"), milli(100), milli(100), near(1), vec![acc(API)], milli(100));
}

// ---------------------------------------------------------------- M3: escrow

#[test]
fn escrow_full_flow_locks_then_releases() {
    let (mut v, id) = setup();
    let t = with_task(&mut v, id);
    let bids = v.get_bids(t);
    assert_eq!(bids.len(), 2, "a counter-offer replaces the worker's bid");
    assert_eq!(bids.iter().find(|b| b.worker == acc(WORKER)).unwrap().price, milli(500));

    as_(AGENT);
    let r = v.accept_bid(t, acc(WORKER));
    assert_eq!(r.status, ActionStatus::Locked);
    let m = v.get_mandate(id).unwrap();
    assert_eq!(m.locked, milli(500));
    assert_eq!(m.spent_today, milli(500));
    assert_eq!(m.remaining(), milli(4500));
    let task = v.get_task(t).unwrap();
    assert_eq!((task.status, task.worker, task.price), (TaskStatus::Locked, Some(acc(WORKER)), Some(milli(500))));

    assert!(is_transfer(&v.release(t)));
    let m = v.get_mandate(id).unwrap();
    assert_eq!((m.locked, m.spent), (ZERO, milli(500)));
    assert_eq!(v.get_task(t).unwrap().status, TaskStatus::Released);
    assert_eq!(kinds(&v, id), vec![ReceiptKind::EscrowLock, ReceiptKind::EscrowRelease]);
}

#[test]
fn accept_bid_runs_policy_checks() {
    let (mut v, id) = setup();
    as_(AGENT);
    let t = v.post_task(id, "job".into(), near(1));
    as_(ATTACKER);
    v.submit_bid(t, milli(100));
    as_(WORKER);
    v.submit_bid(t, milli(900));
    as_(AGENT);
    let r = v.accept_bid(t, acc(ATTACKER));
    assert_eq!(r.status, ActionStatus::Blocked);
    assert!(r.reason.unwrap().contains("not on the allowlist"));
    // Escrow above the approval threshold is blocked, so escrow cannot skip approval.
    let r = v.accept_bid(t, acc(WORKER));
    assert_eq!(r.status, ActionStatus::Blocked);
    assert!(r.reason.unwrap().contains("approval threshold"));
    assert_eq!(v.get_task(t).unwrap().status, TaskStatus::Open);
    assert!(v.get_mandate(id).unwrap().locked.is_zero());
}

#[test]
#[should_panic(expected = "price exceeds the task's max_price")]
fn bid_above_max_price_is_rejected() {
    let (mut v, id) = setup();
    as_(AGENT);
    let t = v.post_task(id, "job".into(), milli(500));
    as_(WORKER);
    v.submit_bid(t, milli(600));
}

#[test]
fn refund_returns_locked_escrow_to_mandate() {
    let (mut v, id) = setup();
    let t = with_task(&mut v, id);
    as_(AGENT);
    v.accept_bid(t, acc(WORKER));
    let r = v.refund(t);
    assert_eq!(r.status, ActionStatus::Refunded);
    let m = v.get_mandate(id).unwrap();
    assert_eq!((m.locked, m.spent, m.spent_today, m.remaining()), (ZERO, ZERO, ZERO, near(5)));
    assert_eq!(v.get_task(t).unwrap().status, TaskStatus::Refunded);
}

#[test]
#[should_panic(expected = "task is not locked")]
fn refunded_task_cannot_be_released() {
    let (mut v, id) = setup();
    let t = with_task(&mut v, id);
    as_(AGENT);
    v.accept_bid(t, acc(WORKER));
    v.refund(t);
    let _ = v.release(t);
}

#[test]
fn failed_release_marks_task_refunded() {
    let (mut v, id) = setup();
    let t = with_task(&mut v, id);
    as_(AGENT);
    v.accept_bid(t, acc(WORKER));
    let _ = v.release(t);
    callback_ctx(PromiseResult::Failed);
    let r = v.on_transfer_complete(id, 1, milli(500), Some(t));
    assert_eq!(r.status, ActionStatus::Failed);
    assert_eq!(v.get_task(t).unwrap().status, TaskStatus::Refunded);
    assert_eq!(v.get_mandate(id).unwrap().remaining(), near(5));
}

// ---------------------------------------------------------------- M3: revoke

#[test]
fn revoke_refunds_subtree_and_disables_children() {
    let (mut v, id) = setup();
    let child = with_child(&mut v, id);
    as_(AGENT);
    let _ = v.pay(id, acc(API), milli(300), "".into());
    as_(CHILD);
    let _ = v.pay(child, acc(API), milli(200), "".into());

    as_(OWNER);
    let r = v.revoke(id);
    // parent: 5 − 0.3 spent − 1 delegated = 3.7; child: 1 − 0.2 = 0.8
    assert_eq!(r.refunded, milli(4500));
    assert_eq!(r.revoked, vec![id, child]);
    for m in [id, child] {
        let m = v.get_mandate(m).unwrap();
        assert!(!m.active);
        assert!(m.remaining().is_zero());
    }
    assert_eq!(kinds(&v, child).last(), Some(&ReceiptKind::Refund));

    // Both agents are now blocked.
    as_(CHILD);
    let r = value(v.pay(child, acc(API), milli(100), "".into()));
    assert!(r.reason.unwrap().contains("not active"));
    as_(AGENT);
    assert_eq!(value(v.pay(id, acc(API), milli(100), "".into())).status, ActionStatus::Blocked);
}

#[test]
fn revoke_drops_pending_payments() {
    let (mut v, id) = setup();
    as_(AGENT);
    let _ = v.pay(id, acc(API), milli(900), "".into());
    assert_eq!(v.get_pending(acc(OWNER)).len(), 1);
    as_(OWNER);
    v.revoke(id);
    assert!(v.get_pending(acc(OWNER)).is_empty());
}

#[test]
fn revoking_a_child_leaves_the_parent_active() {
    let (mut v, id) = setup();
    let child = with_child(&mut v, id);
    as_(OWNER);
    let r = v.revoke(child);
    assert_eq!((r.revoked, r.refunded), (vec![child], near(1)));
    assert!(v.get_mandate(id).unwrap().active);
    assert_eq!(v.get_mandate(id).unwrap().remaining(), near(4));
}

#[test]
#[should_panic(expected = "only the mandate owner can revoke")]
fn only_owner_can_revoke() {
    let (mut v, id) = setup();
    as_(AGENT);
    v.revoke(id);
}

#[test]
fn owner_settles_escrow_after_revoke() {
    let (mut v, id) = setup();
    let t = with_task(&mut v, id);
    as_(AGENT);
    v.accept_bid(t, acc(WORKER));
    as_(OWNER);
    let r = v.revoke(id);
    // Locked escrow is not part of the revoke refund.
    assert_eq!(r.refunded, milli(4500));
    // The agent can no longer settle; the owner refunds the escrow to themself.
    as_(OWNER);
    let r = v.refund(t);
    assert!(r.reason.unwrap().contains("returned to owner"));
    let m = v.get_mandate(id).unwrap();
    assert_eq!((m.locked, m.returned), (ZERO, near(5)));
}

#[test]
#[should_panic(expected = "only the poster (while the mandate is active) or the owner")]
fn agent_cannot_settle_escrow_after_revoke() {
    let (mut v, id) = setup();
    let t = with_task(&mut v, id);
    as_(AGENT);
    v.accept_bid(t, acc(WORKER));
    as_(OWNER);
    v.revoke(id);
    as_(AGENT);
    let _ = v.release(t);
}

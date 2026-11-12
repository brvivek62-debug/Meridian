/** JSON shapes returned by the Vault's view methods (contracts/vault/src/lib.rs). */

export interface Mandate {
  id: number;
  owner: string;
  agent: string;
  parent: number | null;
  depth: number;
  children: number[];
  budget: string;
  spent: string;
  delegated: string;
  locked: string;
  returned: string;
  per_tx_cap: string;
  daily_cap: string;
  spent_today: string;
  day_start_ns: string;
  allowlist: string[];
  approval_threshold: string;
  active: boolean;
  receipt_count: number;
}

export type ReceiptKind = 'Payment' | 'Pending' | 'Rejected' | 'Blocked' | 'Delegation' | 'EscrowLock' | 'EscrowRelease' | 'Refund';

export interface Receipt {
  id: number;
  mandate_id: number;
  to: string;
  amount: string;
  memo: string;
  kind: ReceiptKind;
  reason: string | null;
  ref_id: number | null;
  ts_ns: string;
}

export interface PendingPayment {
  id: number;
  mandate_id: number;
  owner: string;
  to: string;
  amount: string;
  memo: string;
  created_ns: string;
}

export type TaskStatus = 'Open' | 'Locked' | 'Released' | 'Refunded';

export interface Task {
  id: number;
  mandate_id: number;
  poster: string;
  description: string;
  max_price: string;
  status: TaskStatus;
  worker: string | null;
  price: string | null;
  created_ns: string;
}

export interface Bid {
  task_id: number;
  worker: string;
  price: string;
  ts_ns: string;
}

export type ActionStatus = 'Paid' | 'Pending' | 'Blocked' | 'Failed' | 'Locked' | 'Refunded' | 'Rejected';

export interface ActionResult {
  status: ActionStatus;
  receipt_id: number;
  reason: string | null;
  pending_id: number | null;
}

export interface MandateWithChildren extends Mandate {
  receipts: Receipt[];
  tasks: (Task & { bids: Bid[] })[];
}

export interface OwnerGroup {
  ownerId: string;
  role: 'production' | 'demo';
  canAct: boolean;
  mandates: MandateWithChildren[];
  pending: PendingPayment[];
}

export interface DashboardStats {
  nearUnderMandateYocto: string;
  paymentsMade: number;
  attacksBlocked: number;
  nearStolenYocto: string;
}

export interface DashboardState {
  network: string;
  vaultId: string;
  explorerBase: string;
  agentAccountId: string;
  owners: OwnerGroup[];
  stats: DashboardStats;
  generatedAt: string;
}

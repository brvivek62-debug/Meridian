/** The agent's view of the Vault: the only way this account can make anything move. */
import { nearToYocto, teraToGas } from 'near-api-js';
import { account, explorerTx, readDeployments, requireEnv, txHash, txValue, view } from '../../scripts/lib/near.ts';

export const VAULT_ID = requireEnv('VAULT_CONTRACT_ID');
export const AGENT_ID = requireEnv('AGENT_ACCOUNT_ID');

export function mandateId(): number {
  const override = process.env.AGENT_MANDATE_ID;
  if (override) return Number(override);
  const d = readDeployments();
  if (d.seed?.mandateId === undefined) {
    throw new Error('No mandate id available. Set AGENT_MANDATE_ID in .env or run `npm run seed`.');
  }
  return d.seed.mandateId;
}

export interface Mandate {
  id: number;
  agent: string;
  active: boolean;
  budget: string;
  spent: string;
  per_tx_cap: string;
  daily_cap: string;
  spent_today: string;
}

export interface ActionResult {
  status: 'Paid' | 'Pending' | 'Blocked' | 'Failed' | 'Locked' | 'Refunded' | 'Rejected';
  receipt_id: number;
  reason: string | null;
  pending_id: number | null;
}

export async function getMandate(id: number): Promise<Mandate> {
  const m = await view<Mandate | null>(VAULT_ID, 'get_mandate', { mandate_id: id });
  if (!m) throw new Error(`mandate ${id} not found on ${VAULT_ID}`);
  return m;
}

/** Pay through the Vault. This is the only path the agent's restricted key can use to move NEAR. */
export async function pay(
  id: number,
  to: string,
  amountYocto: bigint,
  memo: string,
): Promise<{ result: ActionResult; hash: string }> {
  const res = await account(AGENT_ID).callFunctionRaw({
    contractId: VAULT_ID,
    methodName: 'pay',
    args: { mandate_id: id, to, amount: amountYocto.toString(), memo },
    gas: teraToGas('50'),
  });
  return { result: txValue<ActionResult>(res), hash: txHash(res) };
}

export interface Task {
  id: number;
  mandate_id: number;
  poster: string;
  description: string;
  max_price: string;
  status: 'Open' | 'Locked' | 'Released' | 'Refunded';
  worker: string | null;
  price: string | null;
}

export interface Bid {
  task_id: number;
  worker: string;
  price: string;
}

function asNumber(v: unknown): number {
  return typeof v === 'string' ? Number(v) : (v as number);
}

/** Post an open task to the marketplace. Returns its id. */
export async function postTask(id: number, description: string, maxPriceYocto: bigint): Promise<{ taskId: number; hash: string }> {
  const res = await account(AGENT_ID).callFunctionRaw({
    contractId: VAULT_ID,
    methodName: 'post_task',
    args: { mandate_id: id, description, max_price: maxPriceYocto.toString() },
    gas: teraToGas('30'),
  });
  return { taskId: asNumber(txValue<unknown>(res)), hash: txHash(res) };
}

export async function getTask(taskId: number): Promise<Task | null> {
  return view<Task | null>(VAULT_ID, 'get_task', { task_id: taskId });
}

export async function getBids(taskId: number): Promise<Bid[]> {
  return view<Bid[]>(VAULT_ID, 'get_bids', { task_id: taskId });
}

/** Accept a worker's bid. Runs the Vault's policy checks and locks the price in escrow. */
export async function acceptBid(taskId: number, worker: string): Promise<{ result: ActionResult; hash: string }> {
  const res = await account(AGENT_ID).callFunctionRaw({
    contractId: VAULT_ID,
    methodName: 'accept_bid',
    args: { task_id: taskId, worker },
    gas: teraToGas('30'),
  });
  return { result: txValue<ActionResult>(res), hash: txHash(res) };
}

/** Pay the escrowed price to the worker. */
export async function releaseEscrow(taskId: number): Promise<{ result: ActionResult; hash: string }> {
  const res = await account(AGENT_ID).callFunctionRaw({
    contractId: VAULT_ID,
    methodName: 'release',
    args: { task_id: taskId },
    gas: teraToGas('60'),
  });
  return { result: txValue<ActionResult>(res), hash: txHash(res) };
}

/** Delegate part of this agent's own mandate to another agent account. Returns the child mandate id. */
export async function createSubMandate(
  parentId: number,
  agent: string,
  budgetYocto: bigint,
  perTxCapYocto: bigint,
  dailyCapYocto: bigint,
  allowlist: string[],
  approvalThresholdYocto: bigint,
): Promise<{ childId: number; hash: string }> {
  const res = await account(AGENT_ID).callFunctionRaw({
    contractId: VAULT_ID,
    methodName: 'create_sub_mandate',
    args: {
      parent_id: parentId,
      agent,
      budget: budgetYocto.toString(),
      per_tx_cap: perTxCapYocto.toString(),
      daily_cap: dailyCapYocto.toString(),
      allowlist,
      approval_threshold: approvalThresholdYocto.toString(),
    },
    gas: teraToGas('30'),
  });
  return { childId: asNumber(txValue<unknown>(res)), hash: txHash(res) };
}

export { explorerTx, nearToYocto };

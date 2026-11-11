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

export { explorerTx, nearToYocto };

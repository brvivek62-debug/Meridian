/** The two tools exposed to the LLM for M5: check_budget and call_paid_api. */
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { buildMemo, PAYMENT_FROM_HEADER, PAYMENT_TX_HEADER, type PaymentRequired } from '../../vendors/paid-api/protocol.ts';
import { AGENT_ID, explorerTx, getMandate, mandateId, pay } from './vault.ts';

export const toolSchemas: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'check_budget',
      description:
        "Check the agent's current Vault mandate: remaining budget, per-transaction cap, daily cap, and how much has been spent today. Call this before spending if unsure.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'call_paid_api',
      description:
        'GET a URL that may answer with HTTP 402 Payment Required. If it does, this pays the quoted price through the Vault (the only way this agent can move funds) and retries automatically, returning the final data.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to GET, e.g. http://localhost:4021/data?q=near+agent+wallets' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
];

export async function checkBudget(): Promise<string> {
  const id = mandateId();
  const m = await getMandate(id);
  const remaining = BigInt(m.budget) - BigInt(m.spent);
  return JSON.stringify({
    mandateId: id,
    active: m.active,
    remainingYocto: remaining.toString(),
    perTxCapYocto: m.per_tx_cap,
    dailyCapYocto: m.daily_cap,
    spentTodayYocto: m.spent_today,
  });
}

export interface PaidApiLog {
  step: 'quoted' | 'paid' | 'data';
  detail: string;
}

export async function callPaidApi(url: string, onLog?: (log: PaidApiLog) => void): Promise<string> {
  const first = await fetch(url);
  if (first.status !== 402) {
    if (!first.ok) throw new Error(`${url} → HTTP ${first.status}`);
    return JSON.stringify(await first.json());
  }
  const quoteBody = (await first.json()) as PaymentRequired;
  onLog?.({ step: 'quoted', detail: `402 Payment Required — ${quoteBody.priceNear} to ${quoteBody.payTo}, nonce ${quoteBody.memoNonce}` });

  const id = mandateId();
  const { result, hash } = await pay(id, quoteBody.payTo, BigInt(quoteBody.price), buildMemo(quoteBody.memoNonce));
  if (result.status !== 'Paid') {
    throw new Error(`Vault.pay did not succeed: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  }
  onLog?.({ step: 'paid', detail: `Vault.pay → Paid, receipt ${result.receipt_id} — ${explorerTx(hash)}` });

  const second = await fetch(url, { headers: { [PAYMENT_TX_HEADER]: hash, [PAYMENT_FROM_HEADER]: AGENT_ID } });
  if (!second.ok) throw new Error(`retry after payment failed: HTTP ${second.status} ${await second.text()}`);
  const data = await second.json();
  onLog?.({ step: 'data', detail: '200 OK — data returned' });
  return JSON.stringify(data);
}

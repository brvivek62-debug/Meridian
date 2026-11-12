/**
 * Tools exposed to the LLM: check_budget and call_paid_api (M5), plus the M6
 * marketplace tools (post_task, list_bids, counter_offer, accept_bid,
 * release_escrow, create_sub_mandate).
 */
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { buildMemo, PAYMENT_FROM_HEADER, PAYMENT_TX_HEADER, type PaymentRequired } from '../../vendors/paid-api/protocol.ts';
import {
  acceptBid, type AgentIdentity, createSubMandate, explorerTx, getBids, getMandate, getTask,
  nearToYocto, pay, postTask, releaseEscrow,
} from './vault.ts';

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
  {
    type: 'function',
    function: {
      name: 'post_task',
      description: "Post an open task to the Vault marketplace that any worker can bid on, funded from the agent's own mandate.",
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'What the task is, e.g. "Scrape NEAR agent-wallet docs"' },
          max_price_near: { type: 'string', description: 'Maximum price in NEAR, e.g. "0.4"' },
        },
        required: ['description', 'max_price_near'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_bids',
      description: 'List bids on a task. Waits, polling, until at least min_bids bids have arrived or the timeout elapses.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'number' },
          min_bids: { type: 'number', description: 'Wait until at least this many bids exist. Default 1.' },
          timeout_ms: { type: 'number', description: 'Max time to wait, in milliseconds. Default 30000.' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'counter_offer',
      description:
        "Ask a worker to lower its bid on a task to a specific price. The worker's HTTP endpoint answers once: it either accepts (and resubmits its bid on-chain at that price) or rejects (its current bid stands).",
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'number' },
          worker: { type: 'string', description: 'The worker account id to counter-offer.' },
          price_near: { type: 'string', description: 'Proposed price in NEAR, e.g. "0.2"' },
        },
        required: ['task_id', 'worker', 'price_near'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'accept_bid',
      description: "Accept a worker's current bid on a task. Runs the Vault's policy checks and locks the price in escrow.",
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'number' },
          worker: { type: 'string' },
        },
        required: ['task_id', 'worker'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'release_escrow',
      description: 'Fetch the delivered work from the winning worker and release the escrowed payment to them.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'number' } },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_sub_mandate',
      description:
        "Delegate part of the agent's own mandate to another agent account as a sub-mandate. Every limit must be at or below this mandate's own limits, and the allowlist must be a subset of this mandate's allowlist.",
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Account id to receive the sub-mandate, e.g. worker-summarizer.<owner>.testnet' },
          budget_near: { type: 'string' },
          per_tx_cap_near: { type: 'string' },
          daily_cap_near: { type: 'string' },
          allowlist: { type: 'array', items: { type: 'string' } },
          approval_threshold_near: { type: 'string' },
        },
        required: ['agent', 'budget_near', 'per_tx_cap_near', 'daily_cap_near', 'allowlist', 'approval_threshold_near'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_payment',
      description: 'Send NEAR directly to an account through the Vault, e.g. for a refund, reward, bounty or tip. The Vault enforces the mandate (budget, caps, allowlist) on-chain regardless of what you decide here.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient account id, e.g. someone.testnet' },
          amount_near: { type: 'string', description: 'Amount in NEAR, e.g. "0.5"' },
          memo: { type: 'string', description: 'Short memo explaining the payment.' },
        },
        required: ['to', 'amount_near', 'memo'],
        additionalProperties: false,
      },
    },
  },
];

export const TOOL_NAMES_M5 = ['check_budget', 'call_paid_api'] as const;
export const TOOL_NAMES_M6 = [
  'check_budget', 'call_paid_api', 'post_task', 'list_bids', 'counter_offer', 'accept_bid', 'release_escrow', 'create_sub_mandate',
] as const;
export const TOOL_NAMES_BREAK = ['check_budget', 'send_payment'] as const;

/** Where to reach a worker's HTTP endpoint, by account id. */
function workerUrl(workerId: string): string {
  if (workerId === process.env.WORKER_SCRAPER_ACCOUNT_ID) return process.env.WORKER_SCRAPER_URL ?? 'http://localhost:4031';
  if (workerId === process.env.WORKER_SUMMARIZER_ACCOUNT_ID) return process.env.WORKER_SUMMARIZER_URL ?? 'http://localhost:4032';
  throw new Error(`no known HTTP endpoint for worker ${workerId}`);
}

export async function postTaskTool(identity: AgentIdentity, args: { description: string; max_price_near: string }): Promise<string> {
  const maxPrice = nearToYocto(args.max_price_near as `${number}`);
  const { taskId, hash } = await postTask(identity.accountId, identity.mandateId, args.description, maxPrice);
  return JSON.stringify({ taskId, tx: hash, explorer: explorerTx(hash) });
}

export async function listBidsTool(args: { task_id: number; min_bids?: number; timeout_ms?: number }): Promise<string> {
  const minBids = args.min_bids ?? 1;
  const deadline = Date.now() + (args.timeout_ms ?? 30_000);
  let bids = await getBids(args.task_id);
  while (bids.length < minBids && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    bids = await getBids(args.task_id);
  }
  return JSON.stringify({ bids });
}

export async function counterOfferTool(args: { task_id: number; worker: string; price_near: string }): Promise<string> {
  const res = await fetch(`${workerUrl(args.worker)}/counter-offer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: args.task_id, priceNear: args.price_near }),
  });
  if (!res.ok) throw new Error(`counter-offer to ${args.worker} failed: HTTP ${res.status}`);
  return JSON.stringify(await res.json());
}

export async function acceptBidTool(identity: AgentIdentity, args: { task_id: number; worker: string }): Promise<string> {
  const { result, hash } = await acceptBid(identity.accountId, args.task_id, args.worker);
  return JSON.stringify({ ...result, tx: hash, explorer: explorerTx(hash) });
}

export async function releaseEscrowTool(identity: AgentIdentity, args: { task_id: number }): Promise<string> {
  const task = await getTask(args.task_id);
  if (!task || !task.worker) throw new Error(`task ${args.task_id} has no assigned worker`);
  const deliverRes = await fetch(`${workerUrl(task.worker)}/deliver/${args.task_id}`);
  if (!deliverRes.ok) throw new Error(`delivery fetch from ${task.worker} failed: HTTP ${deliverRes.status}`);
  const delivery = await deliverRes.json();
  const { result, hash } = await releaseEscrow(identity.accountId, args.task_id);
  return JSON.stringify({ delivery, ...result, tx: hash, explorer: explorerTx(hash) });
}

export async function createSubMandateTool(identity: AgentIdentity, args: {
  agent: string;
  budget_near: string;
  per_tx_cap_near: string;
  daily_cap_near: string;
  allowlist: string[];
  approval_threshold_near: string;
}): Promise<string> {
  const { childId, hash } = await createSubMandate(
    identity.accountId,
    identity.mandateId,
    args.agent,
    nearToYocto(args.budget_near as `${number}`),
    nearToYocto(args.per_tx_cap_near as `${number}`),
    nearToYocto(args.daily_cap_near as `${number}`),
    args.allowlist,
    nearToYocto(args.approval_threshold_near as `${number}`),
  );
  return JSON.stringify({ childId, tx: hash, explorer: explorerTx(hash) });
}

export async function sendPaymentTool(identity: AgentIdentity, args: { to: string; amount_near: string; memo: string }): Promise<string> {
  const { result, hash } = await pay(identity.accountId, identity.mandateId, args.to, nearToYocto(args.amount_near as `${number}`), args.memo);
  return JSON.stringify({ ...result, tx: hash, explorer: explorerTx(hash) });
}

export async function checkBudget(identity: AgentIdentity): Promise<string> {
  const m = await getMandate(identity.mandateId);
  const remaining = BigInt(m.budget) - BigInt(m.spent);
  return JSON.stringify({
    mandateId: identity.mandateId,
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

export async function callPaidApi(identity: AgentIdentity, url: string, onLog?: (log: PaidApiLog) => void): Promise<string> {
  const first = await fetch(url);
  if (first.status !== 402) {
    if (!first.ok) throw new Error(`${url} → HTTP ${first.status}`);
    return JSON.stringify(await first.json());
  }
  const quoteBody = (await first.json()) as PaymentRequired;
  onLog?.({ step: 'quoted', detail: `402 Payment Required — ${quoteBody.priceNear} to ${quoteBody.payTo}, nonce ${quoteBody.memoNonce}` });

  const { result, hash } = await pay(identity.accountId, identity.mandateId, quoteBody.payTo, BigInt(quoteBody.price), buildMemo(quoteBody.memoNonce));
  if (result.status !== 'Paid') {
    throw new Error(`Vault.pay did not succeed: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  }
  onLog?.({ step: 'paid', detail: `Vault.pay → Paid, receipt ${result.receipt_id} — ${explorerTx(hash)}` });

  const second = await fetch(url, { headers: { [PAYMENT_TX_HEADER]: hash, [PAYMENT_FROM_HEADER]: identity.accountId } });
  if (!second.ok) throw new Error(`retry after payment failed: HTTP ${second.status} ${await second.text()}`);
  const data = await second.json();
  onLog?.({ step: 'data', detail: '200 OK — data returned' });
  return JSON.stringify(data);
}

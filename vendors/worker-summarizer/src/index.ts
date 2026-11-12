/**
 * vendors/worker-summarizer — bids on open Vault tasks and answers one
 * counter-offer like worker-scraper (see vendors/worker-common/service.ts).
 *
 * Its distinct role is autonomous: once the agent grants it a sub-mandate
 * (`create_sub_mandate`), it detects the new mandate, pays vendors/paid-api
 * through the Vault with its OWN restricted key — the only way its account
 * can move NEAR — and uses NEAR AI Cloud to summarize the result.
 *
 * Usage: npm run worker-summarizer
 */
import 'dotenv/config';
import { teraToGas } from 'near-api-js';
import OpenAI from 'openai';
import { magenta } from '../../../scripts/lib/colors.ts';
import { account, explorerTx, requireEnv, txHash, txValue } from '../../../scripts/lib/near.ts';
import { buildMemo, PAYMENT_FROM_HEADER, PAYMENT_TX_HEADER, type PaymentRequired } from '../../paid-api/protocol.ts';
import { startWorkerService, type MandateView } from '../../worker-common/service.ts';

const ACCOUNT_ID = requireEnv('WORKER_SUMMARIZER_ACCOUNT_ID');
const VAULT_ID = requireEnv('VAULT_CONTRACT_ID');
const POSTER_ID = requireEnv('AGENT_ACCOUNT_ID');
const OWNER_ID = requireEnv('OWNER_ACCOUNT_ID');
const PORT = Number(process.env.WORKER_SUMMARIZER_PORT ?? 4032);
const PAID_API_URL = process.env.PAID_API_URL ?? 'http://localhost:4021';

const openai = new OpenAI({ apiKey: requireEnv('NEARAI_API_KEY'), baseURL: requireEnv('NEARAI_BASE_URL') });
const MODEL = requireEnv('LLM_MODEL');

interface ActionResult {
  status: string;
  receipt_id: number;
  reason: string | null;
}

const log = (s: string): void => console.log(`${magenta('[worker-summarizer]')} ${s}`);

/** Pay through the Vault with this account's own key — its only way to move NEAR. */
async function payThroughVault(
  mandateId: number,
  to: string,
  amountYocto: bigint,
  memo: string,
): Promise<{ result: ActionResult; hash: string }> {
  const res = await account(ACCOUNT_ID).callFunctionRaw({
    contractId: VAULT_ID,
    methodName: 'pay',
    args: { mandate_id: mandateId, to, amount: amountYocto.toString(), memo },
    gas: teraToGas('50'),
  });
  return { result: txValue<ActionResult>(res), hash: txHash(res) };
}

/** Pay vendors/paid-api's 402 quote through the sub-mandate and return the data. */
async function fetchResearchData(mandateId: number): Promise<unknown> {
  const url = `${PAID_API_URL}/data?q=near+agent+sub+mandates`;
  const first = await fetch(url);
  if (first.status !== 402) {
    if (!first.ok) throw new Error(`${url} → HTTP ${first.status}`);
    return first.json();
  }
  const quote = (await first.json()) as PaymentRequired;
  log(`402 from paid-api — ${quote.priceNear} to ${quote.payTo}, nonce ${quote.memoNonce}`);

  const { result, hash } = await payThroughVault(mandateId, quote.payTo, BigInt(quote.price), buildMemo(quote.memoNonce));
  if (result.status !== 'Paid') {
    throw new Error(`sub-mandate pay() did not succeed: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  }
  log(`paid ${quote.priceNear} via sub-mandate ${mandateId} — ${explorerTx(hash)}`);

  const second = await fetch(url, { headers: { [PAYMENT_TX_HEADER]: hash, [PAYMENT_FROM_HEADER]: ACCOUNT_ID } });
  if (!second.ok) throw new Error(`retry after payment failed: HTTP ${second.status} ${await second.text()}`);
  return second.json();
}

async function doSummary(mandate: MandateView): Promise<void> {
  try {
    const data = await fetchResearchData(mandate.id);
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You summarize research data in 2-3 sentences for a busy reader.' },
        { role: 'user', content: `Summarize this data:\n${JSON.stringify(data)}` },
      ],
    });
    const summary = completion.choices[0]?.message?.content ?? '(no summary)';
    log(`summary (sub-mandate ${mandate.id}, NEAR AI, model ${MODEL}):`);
    log(`  ${summary}`);
  } catch (e) {
    log(`failed to produce summary: ${e instanceof Error ? e.message : e}`);
  }
}

startWorkerService({
  accountId: ACCOUNT_ID,
  vaultId: VAULT_ID,
  posterId: POSTER_ID,
  ownerId: OWNER_ID,
  port: PORT,
  label: 'worker-summarizer',
  color: magenta,
  startPriceNear: '0.35',
  minPriceNear: '0.28',
  onDeliver: (task) => ({
    taskId: task.id,
    kind: 'mock-summary-fallback',
    note: 'worker-summarizer specializes in summarization; this generic delivery is only used if it wins a non-summarization task.',
  }),
  onMandateGranted: (mandate) => {
    void doSummary(mandate);
  },
});

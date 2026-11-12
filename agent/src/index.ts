/**
 * The agent entrypoint. Runs an LLM tool-calling loop on NEAR AI Cloud that can
 * check its Vault-enforced budget and call paid APIs, paying through the Vault
 * automatically on a 402.
 *
 * Usage:
 *   npm run agent -- "research question"   (M5: paid-API 402 flow)
 *   npm run agent -- --m6                  (M6: marketplace flow, see below)
 */
import 'dotenv/config';
import { runAgent } from './llm.ts';

const DEFAULT_QUESTION =
  'Using the paid research API at ' +
  (process.env.PAID_API_URL ?? 'http://localhost:4021') +
  '/data?q=near+agent+wallets, summarize the key security properties of delegated AI agent wallets.';

/**
 * The M6 goal: hire a worker through the Vault marketplace to scrape some
 * docs, then delegate a sub-mandate to worker-summarizer so it can spend on
 * its own. Concrete account ids and amounts are spelled out so the model
 * doesn't have to guess them.
 */
function m6Goal(): string {
  const scraper = process.env.WORKER_SCRAPER_ACCOUNT_ID ?? 'worker-scraper.testnet';
  const summarizer = process.env.WORKER_SUMMARIZER_ACCOUNT_ID ?? 'worker-summarizer.testnet';
  const paidApi = process.env.PAID_API_ACCOUNT_ID ?? 'paid-api.testnet';
  return [
    'Hire a worker to scrape some NEAR agent-economy docs, through the Vault marketplace:',
    '1. post_task: description "Scrape NEAR agent wallet docs", max_price_near "0.4".',
    '2. list_bids with min_bids 2 and timeout_ms 25000 to wait for both workers to bid.',
    '3. Find the cheaper of the two bidders and counter_offer it a lower price — about',
    '   30-40% below its current bid, but never propose less than 0.1 NEAR.',
    '4. list_bids again (min_bids 2, a short timeout is fine) to see the final prices,',
    '   then accept_bid the worker with the lowest final price.',
    '5. release_escrow on that task to receive the delivered work and pay the worker.',
    `6. create_sub_mandate: agent "${summarizer}", budget_near "1", per_tx_cap_near "0.35",`,
    `   daily_cap_near "1", allowlist ["${paidApi}"], approval_threshold_near "0.5".`,
    `   This lets ${summarizer} spend on its own through the Vault to produce a summary.`,
    `(Workers: ${scraper} and ${summarizer}.)`,
    'Report what happened at each step, including the transaction/explorer links you get back.',
  ].join('\n');
}

const isM6 = process.argv.includes('--m6');
const argv = process.argv.slice(2).filter((a) => a !== '--m6');
const question = isM6 ? m6Goal() : argv.join(' ').trim() || DEFAULT_QUESTION;

async function main() {
  console.log(`[agent] question: ${question}\n`);
  const answer = await runAgent(question, (line) => console.log(line));
  console.log(`\n[agent] answer:\n${answer}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

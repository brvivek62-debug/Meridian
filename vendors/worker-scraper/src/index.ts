/**
 * vendors/worker-scraper — bids on open Vault tasks, answers one counter-offer,
 * and on winning returns mock scraped data. See vendors/worker-common/service.ts
 * for the shared bid/counter-offer/deliver scaffolding.
 *
 * Usage: npm run worker-scraper
 */
import 'dotenv/config';
import { cyan } from '../../../scripts/lib/colors.ts';
import { requireEnv } from '../../../scripts/lib/near.ts';
import { startWorkerService } from '../../worker-common/service.ts';

const ACCOUNT_ID = requireEnv('WORKER_SCRAPER_ACCOUNT_ID');
const VAULT_ID = requireEnv('VAULT_CONTRACT_ID');
const POSTER_ID = requireEnv('AGENT_ACCOUNT_ID');
const PORT = Number(process.env.WORKER_SCRAPER_PORT ?? 4031);

startWorkerService({
  accountId: ACCOUNT_ID,
  vaultId: VAULT_ID,
  posterId: POSTER_ID,
  port: PORT,
  label: 'worker-scraper',
  color: cyan,
  startPriceNear: '0.3',
  minPriceNear: '0.15',
  onDeliver: (task) => ({
    taskId: task.id,
    kind: 'mock-scrape',
    pages: [
      { url: 'https://example.com/near-agent-wallets', title: 'Delegated AI agent wallets on NEAR', words: 842 },
      { url: 'https://example.com/function-call-keys', title: 'Function-call access keys explained', words: 611 },
    ],
    note: 'Mock scraped data from vendors/worker-scraper (no real network fetch — this is a demo vendor).',
  }),
});

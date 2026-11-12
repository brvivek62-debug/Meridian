/**
 * M6 security setup: restrict both worker accounts to a function-call key
 * scoped to the Vault, same pattern as scripts/setup-agent-key.ts.
 *
 *  - worker-scraper only ever bids as a worker: `submit_bid`.
 *  - worker-summarizer also spends through its own sub-mandate once one is
 *    granted (M6 step: `create_sub_mandate` for it), so it additionally needs
 *    `pay`.
 *
 * Idempotent: a no-op for any account already restricted this way.
 *
 * Usage: npm run setup-worker-keys
 */
import { accountId, readDeployments } from './lib/near.ts';
import { restrictToVault } from './lib/keys.ts';

export const WORKER_SCRAPER_METHODS = ['submit_bid'];
export const WORKER_SUMMARIZER_METHODS = ['submit_bid', 'pay'];

async function main() {
  const d = readDeployments();
  const vaultId: string | undefined = d.vault?.contractId;
  if (!vaultId) throw new Error('No Vault in deployments/testnet.json. Run `npm run deploy` first.');

  console.log('=== worker-scraper ===');
  await restrictToVault(accountId('workerScraper'), vaultId, WORKER_SCRAPER_METHODS);

  console.log('\n=== worker-summarizer ===');
  await restrictToVault(accountId('workerSummarizer'), vaultId, WORKER_SUMMARIZER_METHODS);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

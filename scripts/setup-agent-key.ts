/**
 * M5 security setup: cut the agent's full-access key down to a function-call
 * access key that can ONLY call the Vault's agent-side methods, then remove
 * the full-access key. After this, agent.<owner>.testnet physically cannot
 * move NEAR except by calling those Vault methods — see scripts/prove-key-restriction.ts.
 *
 * Idempotent: if the agent already has only a function-call key restricted to
 * the Vault with these methods, this is a no-op. Shared restriction logic
 * lives in scripts/lib/keys.ts (also used by scripts/setup-worker-keys.ts).
 *
 * Usage: npm run setup-agent-key
 */
import { accountId, readDeployments } from './lib/near.ts';
import { restrictToVault } from './lib/keys.ts';

/** The only Vault methods the agent's own account key may ever call. */
export const AGENT_METHODS = ['pay', 'post_task', 'accept_bid', 'release', 'refund', 'create_sub_mandate'];

async function main() {
  const d = readDeployments();
  const vaultId: string | undefined = d.vault?.contractId;
  if (!vaultId) throw new Error('No Vault in deployments/testnet.json. Run `npm run deploy` first.');

  await restrictToVault(accountId('agent'), vaultId, AGENT_METHODS);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

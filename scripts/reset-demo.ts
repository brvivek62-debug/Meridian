/**
 * Reset the demo to one clean state. Testnet accumulates duplicate mandates
 * across repeated `npm run demo:m6` / dashboard testing runs (e.g. three
 * worker-summarizer sub-mandates under the same production mandate, two
 * leftover demo-owner sandbox mandates). This script:
 *
 *  1. Revokes every active root mandate currently owned by OWNER_ID and by
 *     demo-owner (revoke cascades through each mandate's sub-mandates and
 *     refunds the remaining budget back to the owner automatically).
 *  2. Creates exactly one fresh production mandate for the agent (5 NEAR,
 *     per-tx cap 1, daily cap 2, threshold 0.8, allowlist = paid-api + both
 *     workers), with exactly one worker-summarizer sub-mandate (1 NEAR).
 *  3. Creates exactly one fresh break-agent mandate, owned by demo-owner (2
 *     NEAR, per-tx cap 0.05, daily cap 0.2, allowlist = paid-api only).
 *  4. Writes the new ids to deployments/testnet.json (`seed.mandateId`, used
 *     by agent/src/vault.ts's mandateId() and the demo scripts) and to .env
 *     (`BREAK_MANDATE_ID`, read by the dashboard).
 *
 * Testnet only (scripts/lib/near.ts enforces this). Safe to re-run — it just
 * revokes and recreates again.
 *
 * Usage: npm run reset-demo
 */
import { Account, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OWNER_ID, ROOT, account, accountId, explorerAccount, explorerTx, ownerTx, provider,
  readDeployments, requireEnv, txHash, txValue, view, writeDeployments,
} from './lib/near.ts';

const ENV_PATH = join(ROOT, '.env');

interface MandateRow {
  id: number;
  owner: string;
  agent: string;
  parent: number | null;
  active: boolean;
}

function demoOwnerSigner(): { id: string; account: Account } {
  const id = requireEnv('DEMO_OWNER_ACCOUNT_ID');
  const key = requireEnv('DEMO_OWNER_PRIVATE_KEY');
  return { id, account: new Account(id, provider, key as KeyPairString) };
}

function upsertEnvVar(name: string, value: string): void {
  const text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, 'm');
  const next = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  writeFileSync(ENV_PATH, next);
}

async function revokeAsOwner(vaultId: string, id: number): Promise<void> {
  const { txHash: hash } = ownerTx([
    'contract', 'call-function', 'as-transaction', vaultId, 'revoke',
    'json-args', JSON.stringify({ mandate_id: id }),
    'prepaid-gas', '100 Tgas',
    'attached-deposit', '0 NEAR',
  ]);
  console.log(`  revoked mandate ${id} (owner)  ${explorerTx(hash)}`);
}

async function revokeAsDemoOwner(vaultId: string, signer: Account, id: number): Promise<void> {
  const res = await signer.callFunctionRaw({ contractId: vaultId, methodName: 'revoke', args: { mandate_id: id }, gas: 100_000_000_000_000n });
  console.log(`  revoked mandate ${id} (demo-owner)  ${explorerTx(txHash(res))}`);
}

async function main() {
  const d = readDeployments();
  const vaultId: string | undefined = d.vault?.contractId;
  if (!vaultId) throw new Error('No Vault in deployments/testnet.json. Run `npm run deploy` first.');

  const { id: demoOwnerId, account: demoOwner } = demoOwnerSigner();

  console.log('=== 1. revoking existing mandates ===');
  const ownerMandates = await view<MandateRow[]>(vaultId, 'get_mandates_by_owner', { owner: OWNER_ID });
  for (const m of ownerMandates.filter((m) => m.active && m.parent === null)) {
    await revokeAsOwner(vaultId, m.id);
  }
  const demoMandates = await view<MandateRow[]>(vaultId, 'get_mandates_by_owner', { owner: demoOwnerId });
  for (const m of demoMandates.filter((m) => m.active && m.parent === null)) {
    await revokeAsDemoOwner(vaultId, demoOwner, m.id);
  }

  console.log('\n=== 2. creating the production mandate ===');
  const agentId = accountId('agent');
  const paidApi = accountId('paidApi');
  const allowlist = [paidApi, accountId('workerScraper'), accountId('workerSummarizer')];
  const { txHash: createTx } = ownerTx([
    'contract', 'call-function', 'as-transaction', vaultId, 'create_mandate',
    'json-args', JSON.stringify({
      agent: agentId,
      per_tx_cap: nearToYocto('1').toString(),
      daily_cap: nearToYocto('2').toString(),
      allowlist,
      approval_threshold: nearToYocto('0.8').toString(),
    }),
    'prepaid-gas', '30 Tgas',
    'attached-deposit', '5 NEAR',
  ]);
  const freshOwnerMandates = await view<MandateRow[]>(vaultId, 'get_mandates_by_owner', { owner: OWNER_ID });
  const mandateId = Math.max(...freshOwnerMandates.filter((m) => m.agent === agentId && m.active).map((m) => m.id));
  console.log(`  mandate ${mandateId}: 5 NEAR for ${agentId}  ${explorerTx(createTx)}`);

  console.log('\n=== 3. creating the worker-summarizer sub-mandate ===');
  const summarizer = accountId('workerSummarizer');
  const subRes = await account(agentId).callFunctionRaw({
    contractId: vaultId,
    methodName: 'create_sub_mandate',
    args: {
      parent_id: mandateId,
      agent: summarizer,
      budget: nearToYocto('1').toString(),
      per_tx_cap: nearToYocto('0.35').toString(),
      daily_cap: nearToYocto('1').toString(),
      allowlist: [paidApi],
      approval_threshold: nearToYocto('0.5').toString(),
    },
    gas: teraToGas('30'),
  });
  const subId = Number(txValue<number | string>(subRes));
  console.log(`  sub-mandate ${subId}: 1 NEAR for ${summarizer}  ${explorerTx(txHash(subRes))}`);

  console.log('\n=== 4. creating the break-agent mandate ===');
  const breakAgentId = `break-agent.${OWNER_ID}`;
  const breakRes = await demoOwner.callFunctionRaw({
    contractId: vaultId,
    methodName: 'create_mandate',
    args: {
      agent: breakAgentId,
      per_tx_cap: nearToYocto('0.05').toString(),
      daily_cap: nearToYocto('0.2').toString(),
      allowlist: [paidApi],
      approval_threshold: nearToYocto('1').toString(),
    },
    deposit: nearToYocto('2'),
    gas: 30_000_000_000_000n,
  });
  const breakId = Number(txValue<number | string>(breakRes));
  console.log(`  break mandate ${breakId}: 2 NEAR for ${breakAgentId}  ${explorerTx(txHash(breakRes))}`);

  console.log('\n=== 5. writing deployments/testnet.json and .env ===');
  d.seed = {
    mandateId,
    agent: agentId,
    budget: '5 NEAR',
    createMandateTx: createTx,
    subMandate: { id: subId, agent: summarizer, budget: '1 NEAR' },
    resetAt: new Date().toISOString(),
  };
  d.break = {
    accountId: breakAgentId,
    ownerId: demoOwnerId,
    mandateId: breakId,
    budget: '2 NEAR',
    createMandateTx: txHash(breakRes),
    createdAt: new Date().toISOString(),
  };
  writeDeployments(d);
  upsertEnvVar('BREAK_MANDATE_ID', String(breakId));
  console.log(`  deployments/testnet.json updated; .env BREAK_MANDATE_ID=${breakId}`);

  console.log('\n✓ reset complete.');
  console.log(`  production mandate ${mandateId} (${agentId})  ${explorerAccount(agentId)}`);
  console.log(`  worker-summarizer sub-mandate ${subId}`);
  console.log(`  break mandate ${breakId} (${breakAgentId})  ${explorerAccount(breakAgentId)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

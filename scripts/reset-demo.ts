/**
 * Reset the demo to one clean state. Testnet accumulates duplicate mandates
 * across repeated `npm run demo:m6` / dashboard testing runs (e.g. three
 * worker-summarizer sub-mandates under the same production mandate, stray
 * demo-owner sandbox mandates created while testing the dashboard's Create
 * Mandate form). This script:
 *
 *  1. Revokes every active root mandate currently owned by OWNER_ID, and
 *     every active root mandate owned by demo-owner EXCEPT the break-agent
 *     mandate (revoke cascades through each mandate's sub-mandates and
 *     refunds the remaining budget back to the owner automatically).
 *  2. Creates exactly one fresh production mandate for the agent (5 NEAR,
 *     per-tx cap 1, daily cap 2, threshold 0.8, allowlist = paid-api + both
 *     workers), with exactly one worker-summarizer sub-mandate (1 NEAR).
 *  3. Writes the new ids to deployments/testnet.json (`seed.mandateId`, used
 *     by agent/src/vault.ts's mandateId() and the demo scripts).
 *
 * The break-agent mandate is deliberately left untouched: the live Vercel
 * deploy's BREAK_MANDATE_ID env var is fixed at deploy time (not read from
 * deployments/testnet.json), so revoking and recreating it here would break
 * the live /break challenge until someone manually updated that env var —
 * and the "Break Meridian" attempts/scoreboard are kept as proof regardless,
 * so there is no reason to touch its mandate's identity. Run
 * `npm run setup-break-agent` directly (separately, deliberately) if the
 * break-agent mandate itself ever needs to be recreated.
 *
 * Testnet only (scripts/lib/near.ts enforces this). Safe to re-run — it just
 * revokes and recreates the production mandate again.
 *
 * Usage: npm run reset-demo
 */
import { Account, formatNearAmount, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';
import {
  OWNER_ID, account, accountId, explorerAccount, explorerTx, ownerTx, provider,
  readDeployments, readonlyAccount, requireEnv, txHash, txValue, view, writeDeployments,
} from './lib/near.ts';

const TARGET_BUDGET_NEAR = 5;
const GAS_BUFFER_YOCTO = nearToYocto('0.05'); // covers gas/fees on top of the deposit itself

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
  const breakAgentId = `break-agent.${OWNER_ID}`;
  const demoMandates = await view<MandateRow[]>(vaultId, 'get_mandates_by_owner', { owner: demoOwnerId });
  for (const m of demoMandates.filter((m) => m.active && m.parent === null && m.agent !== breakAgentId)) {
    await revokeAsDemoOwner(vaultId, demoOwner, m.id);
  }
  console.log(`  (left break-agent's mandate untouched — see this file's header comment for why)`);

  console.log('\n=== 2. creating the production mandate ===');
  const agentId = accountId('agent');
  const paidApi = accountId('paidApi');
  const allowlist = [paidApi, accountId('workerScraper'), accountId('workerSummarizer')];

  // The target is TARGET_BUDGET_NEAR (5), matching PLAN.md's demo script, but
  // revoking mandate 7 above only just refunded the owner (its balance moves
  // in and out as mandates are created/revoked across repeated resets) — use
  // whatever target fits rather than failing outright if it's short.
  const ownerBalance = (await readonlyAccount(OWNER_ID).getState()).balance.available;
  const targetYocto = nearToYocto(TARGET_BUDGET_NEAR);
  const affordableYocto = ownerBalance - GAS_BUFFER_YOCTO;
  if (affordableYocto < nearToYocto('1')) {
    throw new Error(
      `Owner ${OWNER_ID} only has ${formatNearAmount(ownerBalance.toString(), 4)} NEAR available — too low for even a` +
        ` 1 NEAR mandate. Fund it (faucet or near-cli) and re-run.`,
    );
  }
  const budgetYocto = affordableYocto < targetYocto ? affordableYocto : targetYocto;
  const budgetNear = formatNearAmount(budgetYocto.toString(), 4);
  if (budgetYocto < targetYocto) {
    console.log(`  owner only has ${formatNearAmount(ownerBalance.toString(), 4)} NEAR — using ${budgetNear} NEAR instead of the usual ${TARGET_BUDGET_NEAR}`);
  }
  // Caps/threshold stay proportioned to the (possibly reduced) budget so create_mandate never rejects them as exceeding it.
  const perTxCap = budgetYocto < targetYocto ? budgetYocto / 5n : nearToYocto('1');
  const dailyCap = budgetYocto < targetYocto ? (budgetYocto * 2n) / 5n : nearToYocto('2');
  const approvalThreshold = budgetYocto < targetYocto ? (budgetYocto * 4n) / 25n : nearToYocto('0.8');

  const { txHash: createTx } = ownerTx([
    'contract', 'call-function', 'as-transaction', vaultId, 'create_mandate',
    'json-args', JSON.stringify({
      agent: agentId,
      per_tx_cap: perTxCap.toString(),
      daily_cap: dailyCap.toString(),
      allowlist,
      approval_threshold: approvalThreshold.toString(),
    }),
    'prepaid-gas', '30 Tgas',
    'attached-deposit', `${budgetNear} NEAR`,
  ]);
  const freshOwnerMandates = await view<MandateRow[]>(vaultId, 'get_mandates_by_owner', { owner: OWNER_ID });
  const mandateId = Math.max(...freshOwnerMandates.filter((m) => m.agent === agentId && m.active).map((m) => m.id));
  console.log(`  mandate ${mandateId}: ${budgetNear} NEAR for ${agentId}  ${explorerTx(createTx)}`);

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

  console.log('\n=== 4. writing deployments/testnet.json ===');
  d.seed = {
    mandateId,
    agent: agentId,
    budget: '5 NEAR',
    createMandateTx: createTx,
    subMandate: { id: subId, agent: summarizer, budget: '1 NEAR' },
    resetAt: new Date().toISOString(),
  };
  writeDeployments(d);
  console.log('  deployments/testnet.json updated');

  console.log('\n✓ reset complete.');
  console.log(`  production mandate ${mandateId} (${agentId})  ${explorerAccount(agentId)}`);
  console.log(`  worker-summarizer sub-mandate ${subId}`);
  console.log(`  break-agent's mandate was left untouched (not reset) — ${explorerAccount(breakAgentId)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

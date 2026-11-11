/**
 * Seed the testnet Vault: the owner creates the demo mandate for the agent,
 * then the agent makes one small payment to prove the policy path works.
 *
 *   mandate: 5 NEAR budget, 1 NEAR per-tx cap, 2 NEAR daily cap,
 *            allowlist = paid-api + both workers, approval threshold 0.8 NEAR
 *   payment: 0.1 NEAR agent → paid-api
 *
 * The owner signs create_mandate through near-cli-rs (key stays in its keychain);
 * the agent signs pay() with its key from ~/.near-credentials.
 *
 * Skips if deployments/testnet.json already records an active seed mandate.
 * Pass --force to seed another one.
 *
 * Usage: npm run seed [-- --force]
 */
import { nearToYocto, teraToGas } from 'near-api-js';
import {
  OWNER_ID, account, accountId, explorerTx, formatNear, ownerTx, provider, readDeployments,
  readonlyAccount, txHash, txValue, view, writeDeployments,
} from './lib/near.ts';

const BUDGET = '5';
const PAYMENT = '0.1';
/** The owner keeps at least this much after funding the mandate. */
const OWNER_RESERVE = process.env.SEED_OWNER_RESERVE ?? '3';

interface Mandate { id: number; agent: string; active: boolean; spent: string; budget: string }
interface ActionResult { status: string; receipt_id: number; reason: string | null }

async function balance(id: string): Promise<bigint> {
  return BigInt((await provider.viewAccount({ accountId: id, blockQuery: { finality: 'final' } })).amount);
}

async function main() {
  const d = readDeployments();
  const vaultId: string | undefined = d.vault?.contractId;
  if (!vaultId) throw new Error('No Vault in deployments/testnet.json. Run `npm run deploy` first.');

  if (d.seed?.mandateId !== undefined && !process.argv.includes('--force')) {
    const m = await view<Mandate | null>(vaultId, 'get_mandate', { mandate_id: d.seed.mandateId });
    if (m?.active) {
      console.log(`✓ Seed mandate ${m.id} already exists and is active (spent ${formatNear(BigInt(m.spent))}). Use --force to create another.`);
      return;
    }
  }

  const agentId = accountId('agent');
  const paidApi = accountId('paidApi');
  const allowlist = [paidApi, accountId('workerScraper'), accountId('workerSummarizer')];

  const available = (await readonlyAccount(OWNER_ID).getState()).balance.available;
  const needed = nearToYocto(BUDGET) + nearToYocto(OWNER_RESERVE as `${number}`);
  if (available < needed) {
    throw new Error(
      `Owner has ${formatNear(available)}; needs ${formatNear(needed)} (${BUDGET} NEAR budget + ${OWNER_RESERVE} NEAR reserve). Top up from the testnet faucet.`,
    );
  }

  // 1. Owner creates the mandate; the attached deposit is the budget.
  const args = {
    agent: agentId,
    per_tx_cap: nearToYocto('1').toString(),
    daily_cap: nearToYocto('2').toString(),
    allowlist,
    approval_threshold: nearToYocto('0.8').toString(),
  };
  const { txHash: createTx } = ownerTx([
    'contract', 'call-function', 'as-transaction', vaultId, 'create_mandate',
    'json-args', JSON.stringify(args),
    'prepaid-gas', '30 Tgas',
    'attached-deposit', `${BUDGET} NEAR`,
  ]);
  // The new mandate is the owner's highest id for this agent.
  const mine = await view<Mandate[]>(vaultId, 'get_mandates_by_owner', { owner: OWNER_ID });
  const mandateId = Math.max(...mine.filter((m) => m.agent === agentId).map((m) => m.id));
  console.log(`+ mandate ${mandateId}: ${BUDGET} NEAR for ${agentId}  ${explorerTx(createTx)}`);

  // 2. Agent pays the paid API through the Vault.
  const before = await balance(paidApi);
  const payRes = await account(agentId).callFunctionRaw({
    contractId: vaultId,
    methodName: 'pay',
    args: { mandate_id: mandateId, to: paidApi, amount: nearToYocto(PAYMENT).toString(), memo: 'seed: testnet smoke test' },
    gas: teraToGas('50'),
  });
  const result = txValue<ActionResult>(payRes);
  const payTx = txHash(payRes);
  if (result.status !== 'Paid') throw new Error(`pay() returned ${JSON.stringify(result)}  ${explorerTx(payTx)}`);
  console.log(`+ pay ${PAYMENT} NEAR → ${paidApi}: ${result.status} (receipt ${result.receipt_id})  ${explorerTx(payTx)}`);

  // 3. Verify on-chain state.
  const m = await view<Mandate>(vaultId, 'get_mandate', { mandate_id: mandateId });
  const receipts = await view<{ kind: string }[]>(vaultId, 'get_receipts', { mandate_id: mandateId });
  const gained = (await balance(paidApi)) - before;
  console.log(`✓ mandate ${mandateId} spent ${formatNear(BigInt(m.spent))}; receipts: ${receipts.map((r) => r.kind).join(', ')}`);
  console.log(`✓ ${paidApi} balance +${formatNear(gained)}`);

  d.seed = {
    mandateId,
    agent: agentId,
    budget: `${BUDGET} NEAR`,
    createMandateTx: createTx,
    payment: { to: paidApi, amount: `${PAYMENT} NEAR`, receiptId: result.receipt_id, tx: payTx },
    seededAt: new Date().toISOString(),
  };
  writeDeployments(d);
  console.log('Wrote deployments/testnet.json');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

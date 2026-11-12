/**
 * "Break Meridian" setup: create a dedicated agent + mandate for the public
 * /break challenge in the dashboard, isolated from the production and M7 demo
 * mandates so visitors hammering the page can't drain or interfere with them.
 *
 *  - break-agent.<owner>.testnet: a fresh account, gas-funded, restricted
 *    (same pattern as setup-agent-key.ts) to a function-call key that can
 *    only call Vault.pay — the one tool the break-agent's LLM loop exposes.
 *  - A mandate owned by demo-owner (so it signs with the key already in
 *    .env, not the real owner's keychain), with a NON-EMPTY allowlist
 *    containing only paid-api. Since a visitor's target account is never
 *    paid-api, the Vault blocks every attack by the allowlist check alone —
 *    on top of a small budget, per-tx cap and daily cap.
 *
 * Idempotent: a no-op if deployments/testnet.json already has an active
 * break mandate for an existing break-agent key.
 *
 * Usage: npm run setup-break-agent
 */
import { Account, KeyPair, nearToYocto, type KeyPairString } from 'near-api-js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OWNER_ID, ROOT, accountId, explorerAccount, explorerTx, formatNear, hasKey, loadKey,
  ownerTxNoSignAs, provider, readDeployments, readonlyAccount, requireEnv, saveKey, txHash, txValue,
  view, writeDeployments,
} from './lib/near.ts';
import { restrictToVault } from './lib/keys.ts';

const ENV_PATH = join(ROOT, '.env');
const BREAK_AGENT_ID = `break-agent.${OWNER_ID}`;
const BREAK_AGENT_FUND = '0.3'; // gas money only — it never holds spendable funds of its own
const BREAK_AGENT_METHODS = ['pay'];

const BREAK_BUDGET = '2';
const BREAK_PER_TX_CAP = '0.05';
const BREAK_DAILY_CAP = '0.2';
const BREAK_APPROVAL_THRESHOLD = '1'; // above the per-tx cap, so an allowed payment pays immediately
const DEMO_OWNER_RESERVE = nearToYocto('0.3');

interface Mandate {
  id: number;
  agent: string;
  owner: string;
  active: boolean;
  budget: string;
}

function demoOwnerSigner(): { id: string; account: Account } {
  const id = requireEnv('DEMO_OWNER_ACCOUNT_ID');
  const key = requireEnv('DEMO_OWNER_PRIVATE_KEY');
  return { id, account: new Account(id, provider, key as KeyPairString) };
}

/** Add or replace a `NAME=value` line in .env, preserving everything else. */
function upsertEnvVar(name: string, value: string): void {
  const text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, 'm');
  const next = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  writeFileSync(ENV_PATH, next);
}

async function main() {
  const d = readDeployments();
  const vaultId: string | undefined = d.vault?.contractId;
  if (!vaultId) throw new Error('No Vault in deployments/testnet.json. Run `npm run deploy` first.');
  const paidApi = accountId('paidApi');

  // ---- 1. break-agent account ----
  if (await readonlyAccount(BREAK_AGENT_ID).getState().then(() => true, () => false)) {
    console.log(`✓ ${BREAK_AGENT_ID} exists`);
  } else {
    const kp = hasKey(BREAK_AGENT_ID) ? KeyPair.fromString(loadKey(BREAK_AGENT_ID)) : KeyPair.fromRandom('ed25519');
    if (!hasKey(BREAK_AGENT_ID)) saveKey(BREAK_AGENT_ID, kp);
    const { txHash: hash } = ownerTxNoSignAs([
      'account', 'create-account', 'fund-myself', BREAK_AGENT_ID, `${BREAK_AGENT_FUND} NEAR`,
      'use-manually-provided-public-key', kp.getPublicKey().toString(),
      'sign-as', OWNER_ID,
    ]);
    console.log(`+ created ${BREAK_AGENT_ID} with ${BREAK_AGENT_FUND} NEAR  ${explorerTx(hash)}`);
  }

  // ---- 2. restrict its key to Vault.pay only ----
  await restrictToVault(BREAK_AGENT_ID, vaultId, BREAK_AGENT_METHODS);

  // ---- 3. the break mandate, owned by demo-owner ----
  const existingId: number | undefined = d.break?.mandateId;
  if (existingId !== undefined) {
    const m = await view<Mandate | null>(vaultId, 'get_mandate', { mandate_id: existingId });
    if (m?.active && m.agent === BREAK_AGENT_ID) {
      console.log(`✓ break mandate ${existingId} already exists and is active (budget ${formatNear(BigInt(m.budget))}). Nothing to do.`);
      console.log(`  ${explorerAccount(BREAK_AGENT_ID)}`);
      upsertEnvVar('BREAK_AGENT_ACCOUNT_ID', BREAK_AGENT_ID);
      upsertEnvVar('BREAK_MANDATE_ID', String(existingId));
      return;
    }
  }

  const { id: demoOwnerId, account: demoOwner } = demoOwnerSigner();
  const demoOwnerBalance = (await readonlyAccount(demoOwnerId).getState()).balance.available;
  const needed = nearToYocto(BREAK_BUDGET) + DEMO_OWNER_RESERVE;
  if (demoOwnerBalance < needed) {
    const topUp = needed - demoOwnerBalance;
    const topUpNear = (Number(topUp) / 1e24).toFixed(2);
    console.log(`demo-owner has ${formatNear(demoOwnerBalance)}; topping up ${topUpNear} NEAR from the owner...`);
    const { txHash: hash } = ownerTxNoSignAs(['tokens', OWNER_ID, 'send-near', demoOwnerId, `${topUpNear} NEAR`]);
    console.log(`+ transferred ${topUpNear} NEAR to ${demoOwnerId}  ${explorerTx(hash)}`);
  }

  const args = {
    agent: BREAK_AGENT_ID,
    per_tx_cap: nearToYocto(BREAK_PER_TX_CAP).toString(),
    daily_cap: nearToYocto(BREAK_DAILY_CAP).toString(),
    allowlist: [paidApi],
    approval_threshold: nearToYocto(BREAK_APPROVAL_THRESHOLD).toString(),
  };
  const res = await demoOwner.callFunctionRaw({
    contractId: vaultId,
    methodName: 'create_mandate',
    args,
    deposit: nearToYocto(BREAK_BUDGET),
    gas: 30_000_000_000_000n,
  });
  const mandateId = txValue<number | string>(res);
  const hash = txHash(res);
  const id = typeof mandateId === 'string' ? Number(mandateId) : mandateId;
  console.log(`+ break mandate ${id}: ${BREAK_BUDGET} NEAR budget, per-tx cap ${BREAK_PER_TX_CAP}, daily cap ${BREAK_DAILY_CAP}, allowlist [${paidApi}]  ${explorerTx(hash)}`);

  d.break = {
    accountId: BREAK_AGENT_ID,
    ownerId: demoOwnerId,
    mandateId: id,
    budget: `${BREAK_BUDGET} NEAR`,
    createMandateTx: hash,
    createdAt: new Date().toISOString(),
  };
  writeDeployments(d);

  upsertEnvVar('BREAK_AGENT_ACCOUNT_ID', BREAK_AGENT_ID);
  upsertEnvVar('BREAK_MANDATE_ID', String(id));
  console.log(`+ wrote BREAK_AGENT_ACCOUNT_ID and BREAK_MANDATE_ID to ${ENV_PATH}`);

  console.log(`\n✓ ${BREAK_AGENT_ID} ready for the /break challenge (mandate ${id}, owner ${demoOwnerId}).`);
  console.log(`  ${explorerAccount(BREAK_AGENT_ID)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

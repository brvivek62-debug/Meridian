/**
 * Deploy Meridian to NEAR testnet. Idempotent: safe to re-run.
 *
 *  1. Creates the demo sub-accounts of OWNER_ACCOUNT_ID that don't exist yet
 *     (vault, agent, worker-scraper, worker-summarizer, paid-api). The owner
 *     funds them via near-cli-rs, signing with the key in its keychain. Each new
 *     account gets a fresh key, saved only to ~/.near-credentials/testnet/.
 *  2. Deploys contracts/vault/target/near/vault.wasm to vault.<owner>.
 *     - A brand-new vault account (no code yet) deploys plain: its state
 *       starts from `Default` on first use, so there is nothing to initialise.
 *     - An existing vault being *upgraded* (code differs and it already has
 *       on-chain state) deploys together with a `migrate` init call in the
 *       SAME transaction, so the old-shaped bytes are never left readable by
 *       the new code in between. See contracts/vault/src/lib.rs's migration
 *       section and tests/sandbox.rs's upgrade test for why this is safe.
 *  3. Records account ids and tx hashes in deployments/testnet.json (public data only).
 *
 * Usage: (cd contracts/vault && cargo near build non-reproducible-wasm) && npm run deploy
 */
import { actions, KeyPair, nearToYocto, teraToGas } from 'near-api-js';

/** NEAR's codeHash for an account with no contract deployed (sha256 of zero bytes, base58). */
const NO_CODE_HASH = '11111111111111111111111111111111';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OWNER_ID, ROOT, SUB_ACCOUNTS, type Deployments, type Role,
  account, accountExists, accountId, codeHash, credPath, explorerAccount, explorerTx,
  formatNear, hasKey, loadKey, ownerTxNoSignAs, readDeployments, readonlyAccount, saveKey, txHash,
  view, writeDeployments,
} from './lib/near.ts';

const WASM_PATH = join(ROOT, 'contracts/vault/target/near/vault.wasm');
/** Never let the owner drop below this while funding accounts. */
const OWNER_MIN_AFTER_DEPLOY = nearToYocto('0.5');

async function ensureAccount(role: Role, d: Deployments): Promise<void> {
  const id = accountId(role);
  if (await accountExists(id)) {
    if (!hasKey(id)) console.warn(`! ${id} exists but ${credPath(id)} is missing; scripts cannot sign for it.`);
    console.log(`✓ ${id} exists`);
    return;
  }
  // Re-use a key saved by an earlier run whose account creation failed.
  const kp = hasKey(id) ? KeyPair.fromString(loadKey(id)) : KeyPair.fromRandom('ed25519');
  if (!hasKey(id)) saveKey(id, kp);

  const fund = SUB_ACCOUNTS[role].fund;
  const { txHash: hash } = ownerTxNoSignAs([
    'account', 'create-account', 'fund-myself', id, `${fund} NEAR`,
    'use-manually-provided-public-key', kp.getPublicKey().toString(),
    'sign-as', OWNER_ID,
  ]);
  d.createTxs[role] = hash;
  writeDeployments(d);
  console.log(`+ created ${id} with ${fund} NEAR  ${explorerTx(hash)}`);
}

async function main() {
  if (!existsSync(WASM_PATH)) {
    throw new Error(`${WASM_PATH} not found. Run: cd contracts/vault && cargo near build non-reproducible-wasm`);
  }
  const wasm = readFileSync(WASM_PATH);
  const localHash = codeHash(wasm);

  const ownerState = await readonlyAccount(OWNER_ID).getState();
  console.log(`Owner ${OWNER_ID}: ${formatNear(ownerState.balance.available)} available`);

  // Check the owner can afford the accounts that still need creating.
  const roles = Object.keys(SUB_ACCOUNTS) as Role[];
  let needed = 0n;
  for (const role of roles) {
    if (!(await accountExists(accountId(role)))) needed += nearToYocto(SUB_ACCOUNTS[role].fund as `${number}`);
  }
  if (needed > 0n && ownerState.balance.available - needed < OWNER_MIN_AFTER_DEPLOY) {
    throw new Error(
      `Owner needs ${formatNear(needed)} for new accounts and must keep ${formatNear(OWNER_MIN_AFTER_DEPLOY)}. Top up from the testnet faucet first.`,
    );
  }

  const d = readDeployments();
  d.network = 'testnet';
  d.owner = OWNER_ID;
  // Merge, don't replace: other setup scripts (e.g. setup-dashboard.ts) add
  // their own accounts here (demoOwner, etc.) that aren't part of SUB_ACCOUNTS.
  d.accounts = { ...d.accounts, ...Object.fromEntries(roles.map((r) => [r, accountId(r)])) };
  d.createTxs ??= {};
  for (const role of roles) await ensureAccount(role, d);

  // Deploy the contract if the on-chain code differs. The vault signs its own deploy.
  const vaultId = accountId('vault');
  const onChain = (await readonlyAccount(vaultId).getState()).codeHash;
  if (onChain === localHash) {
    console.log(`✓ ${vaultId} already runs this wasm (${localHash})`);
  } else if (onChain === NO_CODE_HASH) {
    // Fresh account: state starts from Default on first use, nothing to migrate.
    const res = await account(vaultId).deployContract(new Uint8Array(wasm));
    const hash = txHash(res);
    d.vault = { contractId: vaultId, codeHash: localHash, deployTx: hash, deployedAt: new Date().toISOString() };
    writeDeployments(d);
    console.log(`+ deployed vault.wasm (${wasm.length} bytes, code hash ${localHash}) to ${vaultId}  ${explorerTx(hash)}`);
  } else {
    // Upgrading existing live state: deploy + `migrate` as one atomic transaction.
    console.log(`! ${vaultId} runs ${onChain}, upgrading to ${localHash} with a migrate() init call...`);
    const res = await account(vaultId).signAndSendTransaction({
      receiverId: vaultId,
      actions: [actions.deployContract(new Uint8Array(wasm)), actions.functionCall('migrate', {}, teraToGas('100'), 0n)],
    });
    const hash = txHash(res);
    d.vault = { contractId: vaultId, codeHash: localHash, deployTx: hash, migratedFrom: onChain, deployedAt: new Date().toISOString() };
    writeDeployments(d);
    console.log(`+ upgraded ${vaultId} to vault.wasm (${wasm.length} bytes, code hash ${localHash}) and ran migrate()  ${explorerTx(hash)}`);
  }

  // Smoke check: views work and the account has room for more storage.
  const mandates = await view<unknown[]>(vaultId, 'get_mandates_by_owner', { owner: OWNER_ID });
  const vs = await readonlyAccount(vaultId).getState();
  console.log(`✓ get_mandates_by_owner(${OWNER_ID}) → ${mandates.length} mandate(s)`);
  console.log(`  vault: ${formatNear(vs.balance.total)} total, ${vs.storageUsage} bytes stored, ≈${formatNear(vs.balance.available)} free for more storage`);
  console.log(`\nVault: ${vaultId}  ${explorerAccount(vaultId)}`);
  console.log('Wrote deployments/testnet.json');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

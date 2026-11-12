/**
 * M7 setup: create a demo-owner testnet account for the dashboard to act as
 * "owner" with (create mandate, approve, reject) without ever touching the
 * real owner's near-cli-rs keychain key.
 *
 * NEAR's testnet faucet only mints new top-level `.testnet` accounts, not
 * sub-accounts of an existing one — so, like every other demo account in
 * this repo (vault, agent, the workers, paid-api), demo-owner is created as
 * a sub-account of OWNER_ACCOUNT_ID and funded from the owner's own balance,
 * not from a third-party faucet.
 *
 * Unlike those accounts, demo-owner's key is written straight into `.env`
 * (DEMO_OWNER_ACCOUNT_ID / DEMO_OWNER_PRIVATE_KEY) rather than
 * ~/.near-credentials, so the dashboard's Next.js server can read it without
 * touching the filesystem layout the CLI scripts use — and it is still never
 * sent to the browser. It holds a full-access key: it only ever signs for
 * its own small, isolated demo mandates (never the production ones), the
 * same risk class as the other full-access demo keys already in this repo.
 *
 * Idempotent: a no-op if .env already has both vars and the account exists.
 *
 * Usage: npm run setup-dashboard
 */
import { KeyPair, nearToYocto } from 'near-api-js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OWNER_ID, ROOT, accountExists, explorerAccount, explorerTx, formatNear, ownerTxNoSignAs,
  readDeployments, readonlyAccount, writeDeployments,
} from './lib/near.ts';

const DEMO_OWNER_ID = `demo-owner.${OWNER_ID}`;
const FUND_NEAR = '5';
const ENV_PATH = join(ROOT, '.env');

function readEnvVar(name: string): string | undefined {
  if (!existsSync(ENV_PATH)) return undefined;
  const m = readFileSync(ENV_PATH, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
  return m?.[1]?.trim() || undefined;
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
  const existingId = readEnvVar('DEMO_OWNER_ACCOUNT_ID');
  const existingKey = readEnvVar('DEMO_OWNER_PRIVATE_KEY');
  const onChain = await accountExists(DEMO_OWNER_ID);

  if (existingId === DEMO_OWNER_ID && existingKey && onChain) {
    console.log(`✓ ${DEMO_OWNER_ID} already exists and .env already has its key. Nothing to do.`);
    console.log(`  ${explorerAccount(DEMO_OWNER_ID)}`);
    return;
  }
  if (onChain) {
    throw new Error(
      `${DEMO_OWNER_ID} already exists on-chain but .env is missing its key — cannot recover the private key. Inspect manually.`,
    );
  }

  const available = (await readonlyAccount(OWNER_ID).getState()).balance.available;
  const needed = nearToYocto(FUND_NEAR as `${number}`);
  if (available < needed) {
    throw new Error(`Owner has ${formatNear(available)}; needs ${formatNear(needed)} to fund ${DEMO_OWNER_ID}. Top up from the testnet faucet.`);
  }

  const kp = KeyPair.fromRandom('ed25519');
  const { txHash: hash } = ownerTxNoSignAs([
    'account', 'create-account', 'fund-myself', DEMO_OWNER_ID, `${FUND_NEAR} NEAR`,
    'use-manually-provided-public-key', kp.getPublicKey().toString(),
    'sign-as', OWNER_ID,
  ]);
  console.log(`+ created ${DEMO_OWNER_ID} with ${FUND_NEAR} NEAR — ${explorerTx(hash)}`);

  upsertEnvVar('DEMO_OWNER_ACCOUNT_ID', DEMO_OWNER_ID);
  upsertEnvVar('DEMO_OWNER_PRIVATE_KEY', kp.toString());
  console.log(`+ wrote DEMO_OWNER_ACCOUNT_ID and DEMO_OWNER_PRIVATE_KEY to ${ENV_PATH}`);

  const d = readDeployments();
  d.accounts ??= {};
  d.accounts.demoOwner = DEMO_OWNER_ID; // public id only — the key lives in .env, never here
  d.createTxs ??= {};
  d.createTxs.demoOwner = hash;
  writeDeployments(d);

  console.log(`\n✓ ${DEMO_OWNER_ID} ready for the dashboard.`);
  console.log(`  ${explorerAccount(DEMO_OWNER_ID)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

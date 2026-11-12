/**
 * Server-only NEAR access for the dashboard. Never import this from a client
 * component — it reads private keys (the repo-root `.env` and, for the real
 * agent, ~/.near-credentials) and must only run inside API routes.
 *
 * Reads the monorepo's root `.env` directly (not dashboard/.env*) so there is
 * one source of truth for account ids and the demo-owner key shared with the
 * CLI scripts in scripts/.
 */
import { config as loadEnv } from 'dotenv';
import { Account, JsonRpcProvider, type KeyPairString } from 'near-api-js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
loadEnv({ path: join(ROOT, '.env') });

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} in .env at the repo root (see .env.example).`);
  return v;
}

export const NETWORK = process.env.NEAR_NETWORK ?? 'testnet';
if (NETWORK !== 'testnet') {
  throw new Error(`NEAR_NETWORK is "${NETWORK}". The dashboard only runs against testnet.`);
}

export const RPC_URL = process.env.NEAR_RPC_URL ?? 'https://rpc.testnet.fastnear.com';
export const EXPLORER_BASE = 'https://testnet.nearblocks.io';
export const provider = new JsonRpcProvider({ url: RPC_URL });

export const VAULT_ID = requireEnv('VAULT_CONTRACT_ID');
export const OWNER_ID = requireEnv('OWNER_ACCOUNT_ID');
export const AGENT_ID = requireEnv('AGENT_ACCOUNT_ID');
export const DEMO_OWNER_ID = process.env.DEMO_OWNER_ACCOUNT_ID;
const DEMO_OWNER_KEY = process.env.DEMO_OWNER_PRIVATE_KEY;

/** View call — read-only, needs no key. */
export async function view<T>(contractId: string, methodName: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method: methodName, args })) as T;
}

/**
 * An Account that can sign. For demo-owner, the key comes from `.env`
 * (DEMO_OWNER_PRIVATE_KEY) — never from the filesystem the browser could
 * somehow reach. For any other account (e.g. the real agent, for the attack
 * route) the key comes from ~/.near-credentials, the same file the CLI
 * scripts in scripts/ already use — still server-side only.
 */
export function signerFor(accountId: string): Account {
  if (DEMO_OWNER_ID && accountId === DEMO_OWNER_ID) {
    if (!DEMO_OWNER_KEY) throw new Error('DEMO_OWNER_PRIVATE_KEY is not set in .env. Run `npm run setup-dashboard`.');
    return new Account(accountId, provider, DEMO_OWNER_KEY as KeyPairString);
  }
  const path = join(homedir(), '.near-credentials', NETWORK, `${accountId}.json`);
  if (!existsSync(path)) throw new Error(`No key for ${accountId} at ${path}.`);
  const { private_key, secret_key } = JSON.parse(readFileSync(path, 'utf8'));
  return new Account(accountId, provider, (private_key ?? secret_key) as KeyPairString);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxResponse = any;

export function txHash(res: TxResponse): string {
  return res?.transaction?.hash ?? res?.transaction_outcome?.id;
}

/** Decode the JSON return value of a function-call transaction. */
export function txValue<T>(res: TxResponse): T {
  const status = res?.status;
  if (status?.Failure) throw new Error(`Transaction failed: ${JSON.stringify(status.Failure)}`);
  const b64 = status?.SuccessValue;
  if (b64 === undefined) throw new Error(`No SuccessValue in ${JSON.stringify(status)}`);
  const text = Buffer.from(b64, 'base64').toString('utf8');
  return (text ? JSON.parse(text) : null) as T;
}

export function nearToYocto(near: string): bigint {
  const [whole, frac = ''] = near.split('.');
  const fracPadded = (frac + '0'.repeat(24)).slice(0, 24);
  return BigInt(whole || '0') * 10n ** 24n + BigInt(fracPadded || '0');
}

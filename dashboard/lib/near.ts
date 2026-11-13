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
import { Account, FailoverRpcProvider, JsonRpcProvider, type KeyPairString } from 'near-api-js';
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

// Two independent testnet RPC endpoints. fastnear's public tier rate-limits
// aggressively under concurrent serverless traffic; near.org is the fallback.
// FailoverRpcProvider retries each with backoff before moving to the next.
export const RPC_URL = process.env.NEAR_RPC_URL ?? 'https://rpc.testnet.fastnear.com';
export const RPC_URL_FALLBACK = process.env.NEAR_RPC_URL_FALLBACK ?? 'https://rpc.testnet.near.org';
export const EXPLORER_BASE = 'https://testnet.nearblocks.io';
export const provider = new FailoverRpcProvider([new JsonRpcProvider({ url: RPC_URL }), new JsonRpcProvider({ url: RPC_URL_FALLBACK })]);

// Not requireEnv() here: a serverless build's page-data collection step
// imports this module without secrets present, and must not throw just from
// doing so. assertCoreEnv() below does the real check at request time.
export const VAULT_ID = process.env.VAULT_CONTRACT_ID ?? '';
export const OWNER_ID = process.env.OWNER_ACCOUNT_ID ?? '';
export const AGENT_ID = process.env.AGENT_ACCOUNT_ID ?? '';
export const DEMO_OWNER_ID = process.env.DEMO_OWNER_ACCOUNT_ID;
const DEMO_OWNER_KEY = process.env.DEMO_OWNER_PRIVATE_KEY;

// Public demo lock: true on the Vercel deploy. Owner actions (create mandate,
// approve, reject) stop short of signing/submitting a transaction — anyone
// with the URL can otherwise act as demo-owner. Local dev leaves this unset.
export const READ_ONLY_OWNER_ACTIONS = process.env.READ_ONLY_OWNER_ACTIONS === 'true';

// --- /break challenge (see scripts/setup-break-agent.ts) ---
export const BREAK_AGENT_ID = process.env.BREAK_AGENT_ACCOUNT_ID;
export const BREAK_MANDATE_ID = process.env.BREAK_MANDATE_ID !== undefined ? Number(process.env.BREAK_MANDATE_ID) : undefined;
// Only needed where ~/.near-credentials doesn't exist, i.e. the Vercel deploy
// (serverless has no persistent filesystem to hold it). Local dev falls back
// to the credentials file, same as every other demo account.
const BREAK_AGENT_KEY = process.env.BREAK_AGENT_PRIVATE_KEY;

/** Called at the top of each route handler — throws with a clear message if the core Vault env vars are missing. */
export function assertCoreEnv(): void {
  requireEnv('VAULT_CONTRACT_ID');
  requireEnv('OWNER_ACCOUNT_ID');
  requireEnv('AGENT_ACCOUNT_ID');
}

const VIEW_CACHE_TTL_MS = 5000;
const viewCache = new Map<string, { value: unknown; expires: number }>();

/**
 * View call — read-only, needs no key. Cached for a few seconds so a page full
 * of concurrent visitors polling the dashboard shares one RPC call instead of
 * each hitting fastnear's public rate limit directly.
 */
export async function view<T>(contractId: string, methodName: string, args: Record<string, unknown> = {}): Promise<T> {
  const key = `${contractId}:${methodName}:${JSON.stringify(args)}`;
  const now = Date.now();
  const cached = viewCache.get(key);
  if (cached && cached.expires > now) return cached.value as T;
  const value = (await provider.callFunction({ contractId, method: methodName, args })) as T;
  viewCache.set(key, { value, expires: now + VIEW_CACHE_TTL_MS });
  return value;
}

/**
 * An Account that can sign. For demo-owner, the key comes from `.env`
 * (DEMO_OWNER_PRIVATE_KEY) — never from the filesystem the browser could
 * somehow reach. For break-agent, it comes from `.env` (BREAK_AGENT_PRIVATE_KEY)
 * when set (the Vercel deploy), else ~/.near-credentials (local dev). For any
 * other account the key comes from ~/.near-credentials, the same file the CLI
 * scripts in scripts/ already use — still server-side only.
 */
export function signerFor(accountId: string): Account {
  if (DEMO_OWNER_ID && accountId === DEMO_OWNER_ID) {
    if (!DEMO_OWNER_KEY) throw new Error('DEMO_OWNER_PRIVATE_KEY is not set in .env. Run `npm run setup-dashboard`.');
    return new Account(accountId, provider, DEMO_OWNER_KEY as KeyPairString);
  }
  if (BREAK_AGENT_ID && accountId === BREAK_AGENT_ID && BREAK_AGENT_KEY) {
    return new Account(accountId, provider, BREAK_AGENT_KEY as KeyPairString);
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

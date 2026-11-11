/**
 * Shared NEAR helpers for the deploy / seed / demo scripts.
 *
 * Keys:
 * - The OWNER's key never leaves the near-cli-rs keychain. Owner-signed
 *   transactions are sent through `near ... sign-with-keychain` (see ownerTx).
 * - Demo accounts created by these scripts get new keys, saved ONLY to
 *   ~/.near-credentials/testnet/<account>.json (legacy near-cli format, mode 600).
 * Nothing secret is written to the repository. Public deployment data goes to
 * deployments/testnet.json.
 */
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from 'near-api-js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------- network

export const NETWORK = process.env.NEAR_NETWORK ?? 'testnet';
if (NETWORK !== 'testnet') {
  // Hard guard: these scripts create accounts and move funds. Never on mainnet.
  throw new Error(`NEAR_NETWORK is "${NETWORK}". These scripts only run on testnet.`);
}
export const RPC_URL = process.env.NEAR_RPC_URL ?? 'https://rpc.testnet.fastnear.com';
export const provider = new JsonRpcProvider({ url: RPC_URL });

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} in .env (see .env.example).`);
  return v;
}

export const OWNER_ID = requireEnv('OWNER_ACCOUNT_ID');
if (!OWNER_ID.endsWith('.testnet')) {
  throw new Error(`OWNER_ACCOUNT_ID must be a .testnet account, got "${OWNER_ID}".`);
}

/** Demo accounts, all sub-accounts of the owner, and the NEAR each one gets. */
export const SUB_ACCOUNTS = {
  // Contract code storage (~245 KB ≈ 2.46 NEAR) + room for mandates/receipts.
  vault: { prefix: 'vault', fund: '3' },
  // Gas money only; agents spend mandate funds through the Vault.
  agent: { prefix: 'agent', fund: '0.3' },
  workerScraper: { prefix: 'worker-scraper', fund: '0.2' },
  workerSummarizer: { prefix: 'worker-summarizer', fund: '0.2' },
  paidApi: { prefix: 'paid-api', fund: '0.05' },
} as const;
export type Role = keyof typeof SUB_ACCOUNTS;
export const accountId = (role: Role) => `${SUB_ACCOUNTS[role].prefix}.${OWNER_ID}`;

// ---------------------------------------------------------------- credentials

const CREDS_DIR = join(homedir(), '.near-credentials', NETWORK);
export const credPath = (id: string) => join(CREDS_DIR, `${id}.json`);

export function hasKey(id: string): boolean {
  return existsSync(credPath(id));
}

export function loadKey(id: string): KeyPairString {
  if (id === OWNER_ID) throw new Error('The owner key stays in the near-cli-rs keychain; use ownerTx().');
  const p = credPath(id);
  if (!existsSync(p)) throw new Error(`No key for ${id} at ${p}. Run \`npm run deploy\` to create the demo accounts.`);
  const { private_key, secret_key } = JSON.parse(readFileSync(p, 'utf8'));
  return (private_key ?? secret_key) as KeyPairString;
}

/** Save a new key in the legacy near-cli format. Refuses to overwrite. */
export function saveKey(id: string, kp: KeyPair): void {
  const p = credPath(id);
  if (existsSync(p)) throw new Error(`Refusing to overwrite existing key file ${p}`);
  mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 });
  const body = { account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() };
  writeFileSync(p, JSON.stringify(body), { mode: 0o600, flag: 'wx' });
}

/** An account that can sign (demo accounts only; key from ~/.near-credentials). */
export function account(id: string): Account {
  return new Account(id, provider, loadKey(id));
}

/** Read-only account handle (balances, state, code hash). */
export function readonlyAccount(id: string): Account {
  return new Account(id, provider);
}

/**
 * Send a transaction signed by the OWNER through near-cli-rs, using the key in
 * its keychain. `args` is the near-cli-rs command up to (not including) the
 * signer, e.g. ['contract', 'call-function', 'as-transaction', ...].
 * macOS may ask once to allow keychain access.
 */
export function ownerTx(args: string[]): { txHash: string; stdout: string } {
  const full = [...args, 'sign-as', OWNER_ID, 'network-config', NETWORK, 'sign-with-keychain', 'send'];
  return runNearCli(full);
}

/** Like ownerTx for commands whose signer is already part of `args` (e.g. create-account). */
export function ownerTxNoSignAs(args: string[]): { txHash: string; stdout: string } {
  return runNearCli([...args, 'network-config', NETWORK, 'sign-with-keychain', 'send']);
}

function runNearCli(args: string[]): { txHash: string; stdout: string } {
  const r = spawnSync('near', args, { encoding: 'utf8' });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (r.error) throw new Error(`Could not run near-cli-rs (is it installed?): ${r.error.message}`);
  if (r.status !== 0) throw new Error(`near ${args.slice(0, 3).join(' ')} failed:\n${output}`);
  const m = output.match(/Transaction ID:\s*([1-9A-HJ-NP-Za-km-z]{43,44})/);
  if (!m) throw new Error(`No transaction ID in near-cli-rs output:\n${output}`);
  return { txHash: m[1], stdout: r.stdout };
}

export async function accountExists(id: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId: id, blockQuery: { finality: 'final' } });
    return true;
  } catch (e) {
    if (String(e).match(/does not exist|UNKNOWN_ACCOUNT/i)) return false;
    throw e;
  }
}

// ---------------------------------------------------------------- tx helpers

export const explorerTx = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
export const explorerAccount = (id: string) => `https://testnet.nearblocks.io/address/${id}`;

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

/** View call on the Vault (no signature). */
export async function view<T>(contractId: string, methodName: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method: methodName, args })) as T;
}

/** The base58 code hash NEAR reports for a wasm blob (sha256, base58). */
export function codeHash(wasm: Uint8Array): string {
  const digest = createHash('sha256').update(wasm).digest();
  return base58(digest);
}

function base58(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function formatNear(yocto: bigint): string {
  const s = yocto.toString().padStart(25, '0');
  const whole = s.slice(0, -24);
  const frac = s.slice(-24, -19).replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''} NEAR`;
}

// ---------------------------------------------------------------- deployments file

export const DEPLOYMENTS_FILE = join(ROOT, 'deployments', `${NETWORK}.json`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Deployments = Record<string, any>;

export function readDeployments(): Deployments {
  return existsSync(DEPLOYMENTS_FILE) ? JSON.parse(readFileSync(DEPLOYMENTS_FILE, 'utf8')) : {};
}

export function writeDeployments(d: Deployments): void {
  mkdirSync(dirname(DEPLOYMENTS_FILE), { recursive: true });
  writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(d, null, 2) + '\n');
}

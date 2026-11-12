/**
 * Storage for the /break challenge's attempt history. A small interface so
 * the backing store can move from a local JSON file to a hosted store (e.g.
 * on Vercel) later without touching the API route or UI.
 *
 * `ipHash` is a truncated hash, not the raw IP — it is enough to rate-limit
 * by, without keeping visitors' real IPs in a file that ends up in a repo
 * checkout or a demo deploy.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Attempt {
  id: string;
  ts: number;
  ipHash: string;
  message: string;
  target: string;
  fooled: boolean;
  /** Account the agent actually tried to pay (may differ from `target`, e.g. a "hard mode" overspend at the allowlisted vendor). */
  paidTo: string | null;
  decision: string;
  vaultStatus: string;
  reason: string | null;
  /** Which on-chain rule(s) blocked this attempt, e.g. ["ALLOWLIST"] or ["PER-TX CAP", "DAILY CAP"]. */
  blockedRules: string[];
  amountNear: string | null;
  tx: string | null;
  explorer: string | null;
}

export type PublicAttempt = Omit<Attempt, 'ipHash'>;

export function toPublic(a: Attempt): PublicAttempt {
  const { ipHash, ...rest } = a;
  void ipHash;
  return rest;
}

export interface Scoreboard {
  totalAttempts: number;
  agentsFooled: number;
  blockedAttempts: number;
  nearStolenYocto: string;
  blocksByRule: Record<string, number>;
}

export interface BreakStore {
  add(attempt: Attempt): Promise<void>;
  recent(limit: number): Promise<Attempt[]>;
  scoreboard(): Promise<Scoreboard>;
  countSince(ipHash: string, sinceMs: number): Promise<number>;
  countGlobalSince(sinceMs: number): Promise<number>;
}

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
const DATA_FILE = join(DATA_DIR, 'break-attempts.json');
const MAX_STORED = 1000;

class JsonFileStore implements BreakStore {
  private readAll(): Attempt[] {
    if (!existsSync(DATA_FILE)) return [];
    try {
      return JSON.parse(readFileSync(DATA_FILE, 'utf8')) as Attempt[];
    } catch {
      return [];
    }
  }

  private writeAll(all: Attempt[]): void {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify(all));
  }

  async add(attempt: Attempt): Promise<void> {
    const all = this.readAll();
    all.push(attempt);
    this.writeAll(all.slice(-MAX_STORED));
  }

  async recent(limit: number): Promise<Attempt[]> {
    const all = this.readAll();
    return all.slice(-limit).reverse();
  }

  async scoreboard(): Promise<Scoreboard> {
    const all = this.readAll();
    const agentsFooled = all.filter((a) => a.fooled).length;
    // The only legitimate recipient break-agent's mandate allows. A "hard mode" overspend
    // attempt can still end up `Paid` here (capped to the per-tx limit) — that is money
    // reaching the real vendor, not an attacker, so it must never count as "stolen". Read
    // lazily (not at module scope) so it doesn't race dashboard/lib/near.ts's env loading.
    const legitVendorId = process.env.PAID_API_ACCOUNT_ID;
    const nearStolenYocto = all
      .filter((a) => a.vaultStatus === 'Paid' && a.amountNear && a.paidTo !== legitVendorId)
      .reduce((sum, a) => sum + nearToYoctoSafe(a.amountNear as string), 0n)
      .toString();
    const blocksByRule: Record<string, number> = {};
    for (const a of all) {
      for (const rule of a.blockedRules ?? []) {
        blocksByRule[rule] = (blocksByRule[rule] ?? 0) + 1;
      }
    }
    const blockedAttempts = all.filter((a) => a.vaultStatus === 'Blocked').length;
    return { totalAttempts: all.length, agentsFooled, blockedAttempts, nearStolenYocto, blocksByRule };
  }

  async countSince(ipHash: string, sinceMs: number): Promise<number> {
    return this.readAll().filter((a) => a.ipHash === ipHash && a.ts >= sinceMs).length;
  }

  async countGlobalSince(sinceMs: number): Promise<number> {
    return this.readAll().filter((a) => a.ts >= sinceMs).length;
  }
}

function nearToYoctoSafe(near: string): bigint {
  try {
    const [whole, frac = ''] = near.split('.');
    const fracPadded = (frac + '0'.repeat(24)).slice(0, 24);
    return BigInt(whole || '0') * 10n ** 24n + BigInt(fracPadded || '0');
  } catch {
    return 0n;
  }
}

export const breakStore: BreakStore = new JsonFileStore();

/**
 * Storage for the /break challenge's attempt history. A small interface so
 * the backing store can move from a local JSON file to a hosted store without
 * touching the API route or UI: Vercel's serverless functions have no
 * persistent filesystem and multiple concurrent instances, so the deployed
 * site uses Upstash Redis (via the Vercel Marketplace integration) instead —
 * set automatically when UPSTASH_REDIS_REST_URL/TOKEN (or the legacy
 * KV_REST_API_URL/TOKEN names the integration also writes) are present. Local
 * dev keeps using a JSON file when they're absent.
 *
 * `ipHash` is a truncated hash, not the raw IP — it is enough to rate-limit
 * by, without keeping visitors' real IPs in a file that ends up in a repo
 * checkout or a demo deploy.
 */
import { Redis } from '@upstash/redis';
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

function computeScoreboard(all: Attempt[]): Scoreboard {
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

function nearToYoctoSafe(near: string): bigint {
  try {
    const [whole, frac = ''] = near.split('.');
    const fracPadded = (frac + '0'.repeat(24)).slice(0, 24);
    return BigInt(whole || '0') * 10n ** 24n + BigInt(fracPadded || '0');
  } catch {
    return 0n;
  }
}

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
    return computeScoreboard(this.readAll());
  }

  async countSince(ipHash: string, sinceMs: number): Promise<number> {
    return this.readAll().filter((a) => a.ipHash === ipHash && a.ts >= sinceMs).length;
  }

  async countGlobalSince(sinceMs: number): Promise<number> {
    return this.readAll().filter((a) => a.ts >= sinceMs).length;
  }
}

/**
 * Upstash Redis-backed store (the Vercel deploy). Attempts live in one Redis
 * list, newest pushed to the tail and trimmed to MAX_STORED — small enough
 * (≤1000 JSON rows) that scoreboard/rate-limit queries just read the whole
 * list and filter in memory, same as the JSON file does locally.
 */
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const REDIS_KEY = 'break:attempts';

class RedisStore implements BreakStore {
  private redis = new Redis({ url: REDIS_URL!, token: REDIS_TOKEN! });

  private async readAll(): Promise<Attempt[]> {
    const raw = await this.redis.lrange<Attempt>(REDIS_KEY, 0, -1);
    return raw.map((r) => (typeof r === 'string' ? (JSON.parse(r) as Attempt) : r));
  }

  async add(attempt: Attempt): Promise<void> {
    await this.redis.rpush(REDIS_KEY, JSON.stringify(attempt));
    await this.redis.ltrim(REDIS_KEY, -MAX_STORED, -1);
  }

  async recent(limit: number): Promise<Attempt[]> {
    const raw = await this.redis.lrange<Attempt>(REDIS_KEY, -limit, -1);
    return raw.map((r) => (typeof r === 'string' ? (JSON.parse(r) as Attempt) : r)).reverse();
  }

  async scoreboard(): Promise<Scoreboard> {
    return computeScoreboard(await this.readAll());
  }

  async countSince(ipHash: string, sinceMs: number): Promise<number> {
    return (await this.readAll()).filter((a) => a.ipHash === ipHash && a.ts >= sinceMs).length;
  }

  async countGlobalSince(sinceMs: number): Promise<number> {
    return (await this.readAll()).filter((a) => a.ts >= sinceMs).length;
  }
}

export const breakStore: BreakStore = REDIS_URL && REDIS_TOKEN ? new RedisStore() : new JsonFileStore();

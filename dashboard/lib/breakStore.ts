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
  decision: string;
  vaultStatus: string;
  reason: string | null;
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
  nearStolenYocto: string;
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
    const nearStolenYocto = all
      .filter((a) => a.vaultStatus === 'Paid' && a.amountNear)
      .reduce((sum, a) => sum + nearToYoctoSafe(a.amountNear as string), 0n)
      .toString();
    return { totalAttempts: all.length, agentsFooled, nearStolenYocto };
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

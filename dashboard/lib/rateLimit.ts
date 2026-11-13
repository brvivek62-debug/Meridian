/**
 * A small fixed-window rate limiter shared by any route that needs one (the
 * /break challenge has its own richer, attempt-history-based limiter in
 * breakStore.ts; this is for routes that just need a plain per-key counter,
 * e.g. /api/parse-mandate). Same storage story as breakStore.ts: Upstash
 * Redis on Vercel (serverless has no durable filesystem and multiple
 * concurrent instances), a local JSON file otherwise.
 */
import { Redis } from '@upstash/redis';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';

/** Truncated hash, not the raw IP — enough to rate-limit by, never stored as-is. */
export function clientIpHash(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  const ip = (fwd ? fwd.split(',')[0] : req.headers.get('x-real-ip')) ?? '127.0.0.1';
  return createHash('sha256').update(ip.trim()).digest('hex').slice(0, 16);
}

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
const DATA_FILE = join(DATA_DIR, 'rate-limits.json');

function readAll(): Record<string, { count: number; resetAt: number }> {
  if (!existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, { count: number; resetAt: number }>): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(all));
}

/** Increments the counter for `key` and returns the new count within the current fixed window. */
export async function hit(key: string, windowMs: number): Promise<number> {
  if (redis) {
    const redisKey = `ratelimit:${key}`;
    const count = await redis.incr(redisKey);
    if (count === 1) await redis.pexpire(redisKey, windowMs);
    return count;
  }
  const now = Date.now();
  const all = readAll();
  const entry = all[key];
  if (!entry || entry.resetAt <= now) {
    all[key] = { count: 1, resetAt: now + windowMs };
    writeAll(all);
    return 1;
  }
  entry.count += 1;
  writeAll(all);
  return entry.count;
}

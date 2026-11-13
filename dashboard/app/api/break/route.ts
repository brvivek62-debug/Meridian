export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A NEAR AI tool-calling loop (up to MAX_TURNS round trips) plus a NEAR tx can
// run past Vercel's default serverless timeout — a single NEAR AI call has
// been observed taking >60s. Hobby's own default/max with Fluid Compute is
// already 300s, so this is us being generous, not fighting a platform ceiling.
export const maxDuration = 120;

import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { classifyBlockReasons } from '@/lib/blockRules';
import { runBreakAgent } from '@/lib/breakAgent';
import { breakStore, toPublic, type Attempt } from '@/lib/breakStore';
import { EXPLORER_BASE, VAULT_ID } from '@/lib/near';
import { clientIpHash } from '@/lib/rateLimit';

const MAX_MESSAGE_LEN = 1000;
const RATE_LIMIT_PER_IP = 5;
const RATE_LIMIT_IP_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_GLOBAL_PER_DAY = 200;
const RATE_LIMIT_GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 10;

function isEnabled(): boolean {
  return process.env.BREAK_ENABLED !== 'false';
}

const TESTNET_ACCOUNT_RE = /^[a-z0-9_-]{2,64}(\.[a-z0-9_-]{2,64})*\.testnet$/;

export async function GET() {
  const [recent, scoreboard] = await Promise.all([breakStore.recent(RECENT_LIMIT), breakStore.scoreboard()]);
  return NextResponse.json({ enabled: isEnabled(), recent: recent.map(toPublic), scoreboard, explorerBase: EXPLORER_BASE, vaultId: VAULT_ID });
}

export async function POST(req: NextRequest) {
  try {
    if (!isEnabled()) {
      return NextResponse.json({ error: 'The Break Meridian challenge is currently disabled.' }, { status: 503 });
    }

    const body = (await req.json()) as { message?: string; target?: string };
    const message = (body.message ?? '').trim();
    const target = (body.target ?? '').trim();

    if (!message) return NextResponse.json({ error: 'message is required' }, { status: 400 });
    if (message.length > MAX_MESSAGE_LEN) {
      return NextResponse.json({ error: `message must be ${MAX_MESSAGE_LEN} characters or fewer` }, { status: 400 });
    }
    if (!target || !TESTNET_ACCOUNT_RE.test(target) || target.length > 64) {
      return NextResponse.json({ error: 'target must be a valid .testnet account id' }, { status: 400 });
    }

    const ipHash = clientIpHash(req);
    const now = Date.now();
    const [ipCount, globalCount] = await Promise.all([
      breakStore.countSince(ipHash, now - RATE_LIMIT_IP_WINDOW_MS),
      breakStore.countGlobalSince(now - RATE_LIMIT_GLOBAL_WINDOW_MS),
    ]);
    if (ipCount >= RATE_LIMIT_PER_IP) {
      return NextResponse.json({ error: 'Rate limit: 5 attempts per 10 minutes per visitor. Try again shortly.' }, { status: 429 });
    }
    if (globalCount >= RATE_LIMIT_GLOBAL_PER_DAY) {
      return NextResponse.json({ error: 'Daily attempt limit reached for everyone. Try again tomorrow.' }, { status: 429 });
    }

    const result = await runBreakAgent(message, target);

    const vaultStatus = result.vault?.status ?? (result.fooled ? 'error' : 'refused');
    const attempt: Attempt = {
      id: randomUUID(),
      ts: now,
      ipHash,
      message: message.slice(0, MAX_MESSAGE_LEN),
      target,
      fooled: result.fooled,
      paidTo: result.paymentAttempt?.to ?? null,
      decision: result.agentReply,
      vaultStatus,
      reason: result.vault?.reason ?? result.error ?? null,
      blockedRules: vaultStatus === 'Blocked' ? classifyBlockReasons(result.vault?.reason) : [],
      amountNear: result.paymentAttempt?.amountNear ?? null,
      tx: result.vault?.hash ?? null,
      explorer: result.vault?.explorer ?? null,
    };
    await breakStore.add(attempt);

    const [recent, scoreboard] = await Promise.all([breakStore.recent(RECENT_LIMIT), breakStore.scoreboard()]);
    return NextResponse.json({ ok: true, attempt: toPublic(attempt), recent: recent.map(toPublic), scoreboard, explorerBase: EXPLORER_BASE, vaultId: VAULT_ID });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

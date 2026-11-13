export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A NEAR AI JSON-mode call can take longer than Vercel's default timeout.
export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { parseMandateDescription } from '@/lib/parseMandate';
import { clientIpHash, hit } from '@/lib/rateLimit';

const MAX_LEN = 2000;
const RATE_LIMIT_PER_IP = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const count = await hit(`parse-mandate:${clientIpHash(req)}`, RATE_LIMIT_WINDOW_MS);
    if (count > RATE_LIMIT_PER_IP) {
      return NextResponse.json({ error: 'Rate limit: 10 requests per hour per visitor. Try again later.' }, { status: 429 });
    }

    const body = (await req.json()) as { description?: string };
    const description = (body.description ?? '').trim();
    if (!description) return NextResponse.json({ error: 'description is required' }, { status: 400 });
    if (description.length > MAX_LEN) {
      return NextResponse.json({ error: `description must be ${MAX_LEN} characters or fewer` }, { status: 400 });
    }
    const parsed = await parseMandateDescription(description);
    return NextResponse.json({ ok: true, parsed });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { parseMandateDescription } from '@/lib/parseMandate';

const MAX_LEN = 2000;

export async function POST(req: NextRequest) {
  try {
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

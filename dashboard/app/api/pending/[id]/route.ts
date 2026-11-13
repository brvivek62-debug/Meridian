export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A NEAR transaction (approve/reject) can take longer than Vercel's default timeout.
export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { assertCoreEnv, DEMO_OWNER_ID, EXPLORER_BASE, READ_ONLY_OWNER_ACTIONS, VAULT_ID, signerFor, txHash, txValue, view } from '@/lib/near';
import { READ_ONLY_OWNER_ACTIONS_MESSAGE, type ActionResult, type PendingPayment } from '@/lib/types';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertCoreEnv();
    if (READ_ONLY_OWNER_ACTIONS) {
      return NextResponse.json({ error: READ_ONLY_OWNER_ACTIONS_MESSAGE }, { status: 403 });
    }
    if (!DEMO_OWNER_ID) {
      return NextResponse.json({ error: 'DEMO_OWNER_ACCOUNT_ID is not set. Run `npm run setup-dashboard`.' }, { status: 400 });
    }
    const { id } = await params;
    const pendingId = Number(id);
    const { action } = (await req.json()) as { action: 'approve' | 'reject' };
    if (action !== 'approve' && action !== 'reject') {
      return NextResponse.json({ error: 'action must be "approve" or "reject"' }, { status: 400 });
    }

    // Only let the dashboard act on pending payments that belong to its own
    // demo-owner mandates — never try to sign for the real owner's.
    const ownPending = await view<PendingPayment[]>(VAULT_ID, 'get_pending', { owner: DEMO_OWNER_ID });
    if (!ownPending.some((p) => p.id === pendingId)) {
      return NextResponse.json(
        { error: `pending payment ${pendingId} does not belong to ${DEMO_OWNER_ID}; the dashboard can only act on its own demo mandates` },
        { status: 403 },
      );
    }

    const demoOwner = signerFor(DEMO_OWNER_ID);
    const res = await demoOwner.callFunctionRaw({
      contractId: VAULT_ID,
      methodName: action,
      args: { pending_id: pendingId },
      gas: 50_000_000_000_000n,
    });
    const result = txValue<ActionResult>(res);
    const hash = txHash(res);
    return NextResponse.json({ ok: true, ...result, tx: hash, explorer: `${EXPLORER_BASE}/txns/${hash}` });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

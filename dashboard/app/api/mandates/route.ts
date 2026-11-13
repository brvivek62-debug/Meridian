export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A NEAR transaction (create_mandate) can take longer than Vercel's default timeout.
export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { AGENT_ID, assertCoreEnv, DEMO_OWNER_ID, EXPLORER_BASE, READ_ONLY_OWNER_ACTIONS, VAULT_ID, nearToYocto, signerFor, txHash, txValue } from '@/lib/near';
import { READ_ONLY_OWNER_ACTIONS_MESSAGE } from '@/lib/types';

interface CreateMandateBody {
  agent?: string;
  budgetNear: string;
  perTxCapNear: string;
  dailyCapNear: string;
  allowlist: string[];
  approvalThresholdNear: string;
}

export async function POST(req: NextRequest) {
  try {
    assertCoreEnv();
    if (READ_ONLY_OWNER_ACTIONS) {
      return NextResponse.json({ error: READ_ONLY_OWNER_ACTIONS_MESSAGE }, { status: 403 });
    }
    if (!DEMO_OWNER_ID) {
      return NextResponse.json({ error: 'DEMO_OWNER_ACCOUNT_ID is not set. Run `npm run setup-dashboard`.' }, { status: 400 });
    }
    const body = (await req.json()) as CreateMandateBody;
    if (!body.budgetNear || !body.perTxCapNear || !body.dailyCapNear || !body.approvalThresholdNear) {
      return NextResponse.json({ error: 'budgetNear, perTxCapNear, dailyCapNear and approvalThresholdNear are required' }, { status: 400 });
    }

    const demoOwner = signerFor(DEMO_OWNER_ID);
    const res = await demoOwner.callFunctionRaw({
      contractId: VAULT_ID,
      methodName: 'create_mandate',
      args: {
        agent: body.agent || AGENT_ID,
        per_tx_cap: nearToYocto(body.perTxCapNear).toString(),
        daily_cap: nearToYocto(body.dailyCapNear).toString(),
        allowlist: body.allowlist ?? [],
        approval_threshold: nearToYocto(body.approvalThresholdNear).toString(),
      },
      deposit: nearToYocto(body.budgetNear),
      gas: 30_000_000_000_000n,
    });

    const mandateId = txValue<number | string>(res);
    const hash = txHash(res);
    return NextResponse.json({
      ok: true,
      mandateId: typeof mandateId === 'string' ? Number(mandateId) : mandateId,
      tx: hash,
      explorer: `${EXPLORER_BASE}/txns/${hash}`,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

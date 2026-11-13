export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { breakStore } from '@/lib/breakStore';
import { AGENT_ID, assertCoreEnv, DEMO_OWNER_ID, EXPLORER_BASE, OWNER_ID, VAULT_ID, view } from '@/lib/near';
import type { Bid, DashboardState, DashboardStats, Mandate, MandateWithChildren, OwnerGroup, PendingPayment, Task } from '@/lib/types';

const RECEIPT_PAGE = 50;
const TASK_PAGE = 200;

async function loadMandatesFor(owner: string): Promise<Mandate[]> {
  return view<Mandate[]>(VAULT_ID, 'get_mandates_by_owner', { owner });
}

async function loadReceipts(mandate: Mandate) {
  const from = Math.max(0, mandate.receipt_count - RECEIPT_PAGE);
  const receipts = await view<MandateWithChildren['receipts']>(VAULT_ID, 'get_receipts', {
    mandate_id: mandate.id,
    from,
    limit: RECEIPT_PAGE,
  });
  return receipts.slice().reverse(); // newest first
}

async function loadAllTasks(): Promise<Task[]> {
  return view<Task[]>(VAULT_ID, 'get_tasks', { from: 0, limit: TASK_PAGE });
}

async function loadGroup(ownerId: string, role: OwnerGroup['role'], canAct: boolean, allTasks: Task[]): Promise<OwnerGroup> {
  const mandates = await loadMandatesFor(ownerId);
  const withChildren: MandateWithChildren[] = await Promise.all(
    mandates.map(async (m) => {
      const receipts = await loadReceipts(m);
      const tasksForMandate = allTasks.filter((t) => t.mandate_id === m.id);
      const tasksWithBids = await Promise.all(
        tasksForMandate.map(async (t) => ({ ...t, bids: await view<Bid[]>(VAULT_ID, 'get_bids', { task_id: t.id }) })),
      );
      return { ...m, receipts, tasks: tasksWithBids.sort((a, b) => b.id - a.id) };
    }),
  );
  const pending = await view<PendingPayment[]>(VAULT_ID, 'get_pending', { owner: ownerId });
  return { ownerId, role, canAct, mandates: withChildren.sort((a, b) => a.id - b.id), pending };
}

function computeStats(owners: OwnerGroup[], breakBlocked: number, breakStolenYocto: string): DashboardStats {
  let nearUnderMandateYocto = 0n;
  let paymentsMade = 0;
  let vaultBlocked = 0;
  for (const owner of owners) {
    for (const m of owner.mandates) {
      if (m.active && m.parent === null) nearUnderMandateYocto += BigInt(m.budget);
      for (const r of m.receipts) {
        if (r.kind === 'Payment' || r.kind === 'EscrowRelease') paymentsMade += 1;
        if (r.kind === 'Blocked') vaultBlocked += 1;
      }
    }
  }
  return {
    nearUnderMandateYocto: nearUnderMandateYocto.toString(),
    paymentsMade,
    attacksBlocked: vaultBlocked + breakBlocked,
    nearStolenYocto: breakStolenYocto,
  };
}

export async function GET() {
  try {
    assertCoreEnv();
    const allTasks = await loadAllTasks();
    const owners: OwnerGroup[] = [await loadGroup(OWNER_ID, 'production', false, allTasks)];
    if (DEMO_OWNER_ID) owners.push(await loadGroup(DEMO_OWNER_ID, 'demo', true, allTasks));
    const breakScoreboard = await breakStore.scoreboard();

    const body: DashboardState = {
      network: 'testnet',
      vaultId: VAULT_ID,
      explorerBase: EXPLORER_BASE,
      agentAccountId: AGENT_ID,
      owners,
      stats: computeStats(owners, breakScoreboard.blockedAttempts, breakScoreboard.nearStolenYocto),
      generatedAt: new Date().toISOString(),
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

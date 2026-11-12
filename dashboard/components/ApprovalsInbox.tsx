'use client';

import { useState } from 'react';
import { formatNear, shortAccount } from '@/lib/format';
import type { OwnerGroup } from '@/lib/types';

type ActResult = { ok: boolean; error?: string; explorer?: string; status?: string };

export function ApprovalsInbox({
  owners,
  onAct,
}: {
  owners: OwnerGroup[];
  onAct: (pendingId: number, action: 'approve' | 'reject') => Promise<ActResult>;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [results, setResults] = useState<Record<number, ActResult>>({});

  const rows = owners.flatMap((o) => o.pending.map((p) => ({ ...p, canAct: o.canAct })));

  if (rows.length === 0) {
    return <p className="font-mono text-sm text-offwhite/40">Nothing waiting on approval.</p>;
  }

  async function act(pendingId: number, action: 'approve' | 'reject') {
    setBusy(pendingId);
    const result = await onAct(pendingId, action);
    setResults((r) => ({ ...r, [pendingId]: result }));
    setBusy(null);
  }

  return (
    <ul className="space-y-2">
      {rows.map((p) => {
        const result = results[p.id];
        return (
          <li key={p.id} className="enter-fade rounded-md border border-offwhite/10 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-mono text-sm">
                {formatNear(p.amount)} &rarr; {shortAccount(p.to)}
              </div>
              {p.canAct ? (
                <div className="flex gap-2">
                  <button
                    disabled={busy === p.id}
                    onClick={() => act(p.id, 'approve')}
                    className="rounded border border-accent/40 px-2.5 py-1 font-mono text-xs text-accent transition-colors duration-150 hover:bg-accent/10 disabled:opacity-40"
                  >
                    Approve
                  </button>
                  <button
                    disabled={busy === p.id}
                    onClick={() => act(p.id, 'reject')}
                    className="rounded border border-offwhite/20 px-2.5 py-1 font-mono text-xs text-offwhite/70 transition-colors duration-150 hover:bg-offwhite/10 disabled:opacity-40"
                  >
                    Reject
                  </button>
                </div>
              ) : (
                <span className="font-mono text-[11px] text-offwhite/40">read-only &mdash; needs the real owner&rsquo;s keychain key</span>
              )}
            </div>
            <div className="mt-1 font-mono text-xs text-offwhite/40">
              pending #{p.id} &middot; mandate {p.mandate_id} {p.memo && `— ${p.memo}`}
            </div>
            {result && (
              <div className={['mt-1.5 font-mono text-xs', result.ok ? 'text-accent' : 'text-danger'].join(' ')}>
                {result.ok ? (
                  <>
                    {result.status} &middot;{' '}
                    <a href={result.explorer} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                      view tx
                    </a>
                  </>
                ) : (
                  result.error
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

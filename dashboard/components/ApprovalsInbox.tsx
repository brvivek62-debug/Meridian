'use client';

import { useState } from 'react';
import { formatNear, shortAccount } from '@/lib/format';
import type { OwnerGroup } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { TxLink } from '@/components/TxLink';

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
    return <p className="text-[14px] text-muted">Nothing waiting on approval.</p>;
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
          <li key={p.id} className="enter-fade rounded-lg border border-border px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-[14px] text-ink">
                <span className="tabular-nums">{formatNear(p.amount)}</span> &rarr; {shortAccount(p.to)}
              </div>
              {p.canAct ? (
                <div className="flex gap-2">
                  <Button variant="primary" className="h-8 px-3 text-[13px]" disabled={busy === p.id} onClick={() => act(p.id, 'approve')}>
                    Approve
                  </Button>
                  <Button variant="secondary" className="h-8 px-3 text-[13px]" disabled={busy === p.id} onClick={() => act(p.id, 'reject')}>
                    Reject
                  </Button>
                </div>
              ) : (
                <span className="text-[13px] text-muted">Read-only — needs the real owner&rsquo;s keychain key</span>
              )}
            </div>
            <div className="mt-1.5 text-[13px] text-muted">
              Pending #{p.id} · Mandate {p.mandate_id} {p.memo && `— ${p.memo}`}
            </div>
            {result && (
              <div className="mt-2 text-[13px]">
                {result.ok ? (
                  <span className="flex items-center gap-2 text-success">
                    {result.status} · {result.explorer && <TxLink explorer={result.explorer} />}
                  </span>
                ) : (
                  <span className="text-danger">{result.error}</span>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

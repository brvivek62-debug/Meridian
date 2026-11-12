import { formatNear, shortAccount, timeAgo } from '@/lib/format';
import type { Receipt } from '@/lib/types';

const KIND_LABEL: Record<Receipt['kind'], string> = {
  Payment: 'payment',
  Pending: 'pending',
  Rejected: 'rejected',
  Blocked: 'blocked',
  Delegation: 'sub-mandate funded',
  EscrowLock: 'escrow locked',
  EscrowRelease: 'escrow released',
  Refund: 'refund',
};

export function ReceiptsFeed({ receipts, explorerBase }: { receipts: Receipt[]; explorerBase: string }) {
  if (receipts.length === 0) {
    return <p className="font-mono text-sm text-offwhite/40">No receipts yet.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {receipts.map((r) => (
        <li
          key={r.id}
          className={[
            'enter-fade flex flex-col gap-1 rounded-md border border-offwhite/10 px-3 py-2',
            r.kind === 'Blocked' ? 'flash-blocked border-danger/40' : '',
          ].join(' ')}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className={['font-mono text-xs uppercase tracking-wide', r.kind === 'Blocked' ? 'text-danger' : 'text-accent'].join(' ')}>
                {KIND_LABEL[r.kind]}
              </span>
              <span className="font-mono text-sm">{formatNear(r.amount)}</span>
              <a
                href={`${explorerBase}/address/${r.to}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs text-offwhite/50 underline-offset-2 hover:text-accent hover:underline"
              >
                &rarr; {shortAccount(r.to)}
              </a>
            </div>
            <span className="font-mono text-xs text-offwhite/40">{timeAgo(r.ts_ns)}</span>
          </div>
          {r.reason && <p className={['font-mono text-xs', r.kind === 'Blocked' ? 'text-danger/80' : 'text-offwhite/50'].join(' ')}>{r.reason}</p>}
        </li>
      ))}
    </ul>
  );
}

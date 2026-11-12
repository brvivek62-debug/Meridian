import { formatNear, shortAccount, timeAgo } from '@/lib/format';
import type { Receipt } from '@/lib/types';
import { Pill, type PillTone } from '@/components/ui/Pill';
import { TxLink } from '@/components/TxLink';

const KIND_LABEL: Record<Receipt['kind'], string> = {
  Payment: 'Payment',
  Pending: 'Pending',
  Rejected: 'Rejected',
  Blocked: 'Blocked',
  Delegation: 'Sub-mandate funded',
  EscrowLock: 'Escrow locked',
  EscrowRelease: 'Escrow released',
  Refund: 'Refund',
};

const KIND_TONE: Record<Receipt['kind'], PillTone> = {
  Payment: 'success',
  Pending: 'pending',
  Rejected: 'danger',
  Blocked: 'danger',
  Delegation: 'neutral',
  EscrowLock: 'pending',
  EscrowRelease: 'success',
  Refund: 'neutral',
};

export function ReceiptsFeed({ receipts, explorerBase }: { receipts: Receipt[]; explorerBase: string }) {
  if (receipts.length === 0) {
    return <p className="text-[14px] text-muted">No receipts yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
        <thead>
          <tr className="border-b border-border bg-surface text-[13px] text-muted">
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Amount</th>
            <th className="px-3 py-2 font-medium">To</th>
            <th className="px-3 py-2 font-medium">Rule / reason</th>
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {receipts.map((r) => (
            <tr key={r.id} className={['enter-fade border-b border-border last:border-b-0', r.kind === 'Blocked' ? 'flash-blocked' : ''].join(' ')}>
              <td className="px-3 py-2.5">
                <Pill tone={KIND_TONE[r.kind]}>{KIND_LABEL[r.kind]}</Pill>
              </td>
              <td className="px-3 py-2.5 tabular-nums text-ink">{formatNear(r.amount)}</td>
              <td className="px-3 py-2.5">
                <a
                  href={`${explorerBase}/address/${r.to}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[13px] text-muted hover:text-accent hover:underline"
                >
                  {shortAccount(r.to)}
                </a>
              </td>
              <td className="px-3 py-2.5 text-[13px] text-slate">{r.reason ?? '—'}</td>
              <td className="px-3 py-2.5 text-[13px] text-muted">{timeAgo(r.ts_ns)}</td>
              <td className="px-3 py-2.5">
                <TxLink explorer={`${explorerBase}/address/${r.to}`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

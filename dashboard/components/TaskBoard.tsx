import { formatNear, shortAccount } from '@/lib/format';
import type { Bid, Task } from '@/lib/types';
import { StatusChip } from './Badge';

export function TaskBoard({ tasks, explorerBase }: { tasks: (Task & { bids: Bid[] })[]; explorerBase: string }) {
  if (tasks.length === 0) {
    return <p className="font-mono text-sm text-offwhite/40">No tasks posted yet.</p>;
  }
  return (
    <ul className="space-y-2">
      {tasks.map((t) => (
        <li key={t.id} className="enter-fade rounded-md border border-offwhite/10 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">{t.description}</span>
            <StatusChip status={t.status} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-offwhite/50">
            <span>task #{t.id}</span>
            <span>max {formatNear(t.max_price)}</span>
            {t.worker && t.price && (
              <a href={`${explorerBase}/address/${t.worker}`} target="_blank" rel="noreferrer" className="hover:text-accent hover:underline">
                won by {shortAccount(t.worker)} @ {formatNear(t.price)}
              </a>
            )}
          </div>
          {t.bids.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {t.bids
                .slice()
                .sort((a, b) => Number(BigInt(a.price) - BigInt(b.price)))
                .map((b) => (
                  <span
                    key={b.worker}
                    className={[
                      'rounded border px-2 py-0.5 font-mono text-[11px]',
                      t.worker === b.worker ? 'border-accent/40 text-accent' : 'border-offwhite/15 text-offwhite/60',
                    ].join(' ')}
                  >
                    {shortAccount(b.worker)} &middot; {formatNear(b.price)}
                  </span>
                ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

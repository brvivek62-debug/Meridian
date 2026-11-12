import { formatNear, shortAccount } from '@/lib/format';
import type { Bid, Task } from '@/lib/types';
import { StatusChip } from './Badge';
import { Pill } from '@/components/ui/Pill';

export function TaskBoard({ tasks, explorerBase }: { tasks: (Task & { bids: Bid[] })[]; explorerBase: string }) {
  if (tasks.length === 0) {
    return <p className="text-[14px] text-muted">No tasks posted yet.</p>;
  }
  return (
    <ul className="space-y-2">
      {tasks.map((t) => (
        <li key={t.id} className="enter-fade rounded-lg border border-border px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[14px] text-ink">{t.description}</span>
            <StatusChip status={t.status} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
            <span>Task #{t.id}</span>
            <span className="tabular-nums">Max {formatNear(t.max_price)}</span>
            {t.worker && t.price && (
              <a href={`${explorerBase}/address/${t.worker}`} target="_blank" rel="noreferrer" className="hover:text-accent hover:underline">
                Won by {shortAccount(t.worker)} @ {formatNear(t.price)}
              </a>
            )}
          </div>
          {t.bids.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {t.bids
                .slice()
                .sort((a, b) => Number(BigInt(a.price) - BigInt(b.price)))
                .map((b) => (
                  <Pill key={b.worker} tone={t.worker === b.worker ? 'accent' : 'neutral'}>
                    {shortAccount(b.worker)} · {formatNear(b.price)}
                  </Pill>
                ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

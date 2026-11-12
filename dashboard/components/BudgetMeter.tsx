import { formatNear, pct, shortAccount } from '@/lib/format';
import type { Mandate } from '@/lib/types';
import { Pill } from '@/components/ui/Pill';

export function BudgetMeter({ mandate }: { mandate: Mandate }) {
  const budget = BigInt(mandate.budget);
  const spent = BigInt(mandate.spent);
  const delegated = BigInt(mandate.delegated);
  const locked = BigInt(mandate.locked);
  const returned = BigInt(mandate.returned);
  const used = spent + delegated + locked + returned;
  const remaining = budget - used > 0n ? budget - used : 0n;

  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between text-[13px] text-slate">
        <span>Spent + locked + delegated</span>
        <span className="tabular-nums">
          {formatNear(used)} / {formatNear(budget)}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${pct(used, budget)}%` }} />
      </div>
      <div className="flex items-baseline justify-between text-[13px] text-muted">
        <span className="tabular-nums">Remaining {formatNear(remaining)}</span>
        <span className="tabular-nums">
          Per-tx cap {formatNear(mandate.per_tx_cap)} · Daily cap {formatNear(mandate.daily_cap)}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 pt-1">
        {mandate.allowlist.length === 0 ? (
          <Pill tone="pending">No allowlist — unsafe</Pill>
        ) : (
          mandate.allowlist.map((a) => <Pill key={a} tone="neutral">{shortAccount(a)}</Pill>)
        )}
      </div>
    </div>
  );
}

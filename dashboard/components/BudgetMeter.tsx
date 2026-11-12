import { formatNear, pct, shortAccount } from '@/lib/format';
import type { Mandate } from '@/lib/types';

export function BudgetMeter({ mandate }: { mandate: Mandate }) {
  const budget = BigInt(mandate.budget);
  const spent = BigInt(mandate.spent);
  const delegated = BigInt(mandate.delegated);
  const locked = BigInt(mandate.locked);
  const returned = BigInt(mandate.returned);
  const used = spent + delegated + locked + returned;
  const remaining = budget - used > 0n ? budget - used : 0n;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-sm text-offwhite/70">spent + locked + delegated</span>
        <span className="font-mono text-sm text-offwhite/70">
          {formatNear(used)} / {formatNear(budget)}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full border border-offwhite/10 bg-offwhite/5">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
          style={{ width: `${pct(used, budget)}%` }}
        />
      </div>
      <div className="flex items-baseline justify-between text-xs font-mono text-offwhite/50">
        <span>remaining {formatNear(remaining)}</span>
        <span>
          per-tx cap {formatNear(mandate.per_tx_cap)} &middot; daily cap {formatNear(mandate.daily_cap)}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 pt-1">
        {mandate.allowlist.length === 0 ? (
          <span className="rounded-full border border-amber-500/50 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-mono uppercase tracking-wide text-amber-400">
            no allowlist (unsafe)
          </span>
        ) : (
          mandate.allowlist.map((a) => (
            <span key={a} className="rounded-full border border-offwhite/15 px-2.5 py-0.5 text-[11px] font-mono text-offwhite/70">
              {shortAccount(a)}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

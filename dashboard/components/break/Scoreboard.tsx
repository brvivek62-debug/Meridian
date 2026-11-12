import { Stat } from '@/components/Stat';
import { formatNear } from '@/lib/format';
import type { Scoreboard as ScoreboardData } from '@/lib/breakStore';

export function Scoreboard({ data }: { data: ScoreboardData | null }) {
  const stolen = data ? formatNear(data.nearStolenYocto, 5) : '—';
  const stolenIsZero = data ? BigInt(data.nearStolenYocto) === 0n : true;
  const rules = data ? Object.entries(data.blocksByRule).sort((a, b) => b[1] - a[1]) : [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <Stat label="Total attacks" value={data ? String(data.totalAttempts) : '—'} />
        <Stat label="Agents fooled" value={data ? String(data.agentsFooled) : '—'} />
        <Stat label="NEAR stolen" value={stolen} danger={!stolenIsZero} />
      </div>
      {rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-offwhite/40">
          <span className="uppercase tracking-wide text-offwhite/30">blocks by rule:</span>
          {rules.map(([rule, count]) => (
            <span key={rule} className="rounded border border-offwhite/15 px-1.5 py-0.5 text-offwhite/60">
              {rule} &middot; {count}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

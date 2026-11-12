import { Stat } from '@/components/Stat';
import { Pill } from '@/components/ui/Pill';
import { formatNear } from '@/lib/format';
import type { Scoreboard as ScoreboardData } from '@/lib/breakStore';

export function Scoreboard({ data }: { data: ScoreboardData | null }) {
  const stolen = data ? formatNear(data.nearStolenYocto, 5) : '—';
  const stolenIsZero = data ? BigInt(data.nearStolenYocto) === 0n : true;
  const rules = data ? Object.entries(data.blocksByRule).sort((a, b) => b[1] - a[1]) : [];
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Total attacks" value={data ? String(data.totalAttempts) : '—'} />
        <Stat label="Agents fooled" value={data ? String(data.agentsFooled) : '—'} />
        <Stat label="NEAR stolen" value={stolen} danger={!stolenIsZero} />
      </div>
      {rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
          <span>Blocks by rule:</span>
          {rules.map(([rule, count]) => (
            <Pill key={rule} tone="neutral">
              {rule} · {count}
            </Pill>
          ))}
        </div>
      )}
    </div>
  );
}

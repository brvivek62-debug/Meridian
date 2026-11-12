import { formatNear } from '@/lib/format';
import type { Scoreboard as ScoreboardData } from '@/lib/breakStore';

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex flex-1 flex-col gap-1 rounded-lg border border-offwhite/12 bg-navy-raised/40 px-4 py-3">
      <span className="font-mono text-[11px] uppercase tracking-wide text-offwhite/40">{label}</span>
      <span className={['font-mono text-2xl font-semibold', danger ? 'text-danger' : 'text-offwhite'].join(' ')}>{value}</span>
    </div>
  );
}

export function Scoreboard({ data }: { data: ScoreboardData | null }) {
  const stolen = data ? formatNear(data.nearStolenYocto, 5) : '—';
  const stolenIsZero = data ? BigInt(data.nearStolenYocto) === 0n : true;
  return (
    <div className="flex flex-wrap gap-3">
      <Stat label="Total attacks" value={data ? String(data.totalAttempts) : '—'} />
      <Stat label="Agents fooled" value={data ? String(data.agentsFooled) : '—'} />
      <Stat label="NEAR stolen" value={stolen} danger={!stolenIsZero} />
    </div>
  );
}

import { RuleTag, TxLink } from '@/components/TxLink';
import { Pill } from '@/components/ui/Pill';
import type { PublicAttempt } from '@/lib/breakStore';

/** Truncate at a whitespace boundary — never mid-word. */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function timeAgo(ts: number): string {
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return `${Math.floor(diffSec / 3600)}h ago`;
}

export function HallOfAttempts({ attempts }: { attempts: PublicAttempt[] }) {
  if (attempts.length === 0) {
    return <p className="text-[14px] text-muted">No attempts yet — be the first.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[600px] border-collapse text-left text-[14px]">
        <thead>
          <tr className="border-b border-border bg-surface text-[13px] text-muted">
            <th className="px-3 py-2 font-medium">Attempt</th>
            <th className="px-3 py-2 font-medium">Result</th>
            <th className="px-3 py-2 font-medium">Rule</th>
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((a) => (
            <tr key={a.id} className="enter-fade border-b border-border last:border-b-0">
              <td className="max-w-[220px] px-3 py-2.5 text-[13px] text-slate">&ldquo;{truncate(a.message, 90)}&rdquo;</td>
              <td className="px-3 py-2.5">
                {a.fooled ? (
                  <Pill tone={a.vaultStatus === 'Blocked' ? 'danger' : 'success'}>{a.vaultStatus}</Pill>
                ) : (
                  <Pill tone="neutral">Refused</Pill>
                )}
              </td>
              <td className="px-3 py-2.5">
                <div className="flex flex-wrap gap-1.5">
                  {a.blockedRules?.map((r) => <RuleTag key={r} rule={r} />)}
                </div>
              </td>
              <td className="px-3 py-2.5 text-[13px] text-muted">{timeAgo(a.ts)}</td>
              <td className="px-3 py-2.5">{a.explorer && <TxLink explorer={a.explorer} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

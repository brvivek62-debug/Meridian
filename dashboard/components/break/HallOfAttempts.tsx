import { shortAccount } from '@/lib/format';
import type { PublicAttempt } from '@/lib/breakStore';

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
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
    return <p className="font-mono text-sm text-offwhite/40">No attempts yet &mdash; be the first.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {attempts.map((a) => (
        <li
          key={a.id}
          className={[
            'enter-fade flex flex-col gap-1 rounded-md border px-3 py-2',
            a.fooled ? 'border-danger/30' : 'border-offwhite/10',
          ].join(' ')}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-xs text-offwhite/70">&ldquo;{truncate(a.message, 110)}&rdquo;</span>
            <span className="font-mono text-[11px] text-offwhite/40">{timeAgo(a.ts)}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
            <span className={a.fooled ? 'text-danger' : 'text-offwhite/50'}>{a.fooled ? 'fooled' : 'refused'}</span>
            {a.fooled && (
              <>
                <span className="text-offwhite/30">&rarr;</span>
                <span className={a.vaultStatus === 'Blocked' ? 'text-danger' : 'text-accent'}>{a.vaultStatus}</span>
                {a.reason && <span className="text-offwhite/40">({truncate(a.reason, 60)})</span>}
                {a.explorer && (
                  <a href={a.explorer} target="_blank" rel="noreferrer" className="text-offwhite/40 underline-offset-2 hover:text-accent hover:underline">
                    tx
                  </a>
                )}
              </>
            )}
            <span className="text-offwhite/30">target: {shortAccount(a.target)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * "The line your agents can't cross" — a vertical glowing line between the
 * agent (left) and a target (right). Each job animates a coin from the agent
 * toward the target:
 *  - blocked: the coin reaches the line, shatters into particles, and
 *    "BLOCKED" + the Vault's reason appears on the line in red.
 *  - paid: the coin passes through with a subtle blue pulse and continues.
 *  - refused: the agent never tried — the coin fades out before reaching the
 *    line at all.
 * Pure CSS keyframes (dashboard/app/globals.css), no animation libraries.
 * Re-keying by job.id restarts the animation for a new attempt.
 */
export type LineOutcome = 'blocked' | 'paid' | 'refused';

export interface LineJob {
  id: string;
  outcome: LineOutcome;
  reason?: string | null;
}

const PARTICLE_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

const COIN_ANIMATION: Record<LineOutcome, string> = {
  blocked: 'animate-[coin-block_1.1s_ease-in_forwards]',
  paid: 'animate-[coin-pass_1.2s_ease-out_forwards]',
  refused: 'animate-[coin-refused_1s_ease-out_forwards]',
};

const COIN_COLOR: Record<LineOutcome, string> = {
  blocked: 'bg-danger shadow-[0_0_8px_2px_rgba(255,92,92,0.65)]',
  paid: 'bg-accent shadow-[0_0_8px_2px_rgba(47,140,255,0.65)]',
  refused: 'bg-offwhite/50',
};

export function TheLine({ job }: { job: LineJob | null }) {
  return (
    <div className="relative h-28 w-full overflow-hidden rounded-lg border border-offwhite/10 bg-navy-raised/20">
      {/* the line itself */}
      <div className="absolute inset-y-3 left-1/2 w-px -translate-x-1/2 bg-accent/70 shadow-[0_0_10px_2px_rgba(47,140,255,0.55)]" />

      {/* endpoints */}
      <div className="absolute left-[8%] top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1">
        <div className="flex h-7 w-7 items-center justify-center rounded-full border border-offwhite/25 bg-navy-raised font-mono text-[10px] text-offwhite/60">
          A
        </div>
        <span className="font-mono text-[10px] text-offwhite/30">agent</span>
      </div>
      <div className="absolute left-[88%] top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1">
        <div className="flex h-7 w-7 items-center justify-center rounded-full border border-offwhite/25 bg-navy-raised font-mono text-[10px] text-offwhite/60">
          T
        </div>
        <span className="font-mono text-[10px] text-offwhite/30">target</span>
      </div>

      {job && (
        <div key={job.id} className="absolute inset-0">
          {/* the coin */}
          <div className={['absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0', COIN_COLOR[job.outcome], COIN_ANIMATION[job.outcome]].join(' ')} />

          {job.outcome === 'blocked' &&
            PARTICLE_ANGLES.map((angle) => (
              <span
                key={angle}
                className="absolute left-1/2 top-1/2 h-1 w-1 rounded-full bg-danger opacity-0 [animation:particle-burst_0.5s_ease-out_0.82s_forwards]"
                style={{ '--angle': `${angle}deg` } as React.CSSProperties}
              />
            ))}

          {job.outcome === 'blocked' && (
            <div className="absolute left-1/2 top-1/2 w-max max-w-[70%] -translate-x-1/2 text-center opacity-0 [animation:line-text-in_0.3s_ease-out_0.82s_forwards]">
              <div className="font-mono text-xs font-bold uppercase tracking-wide text-danger">Blocked</div>
              {job.reason && <div className="truncate font-mono text-[10px] text-danger/80">{job.reason}</div>}
            </div>
          )}

          {job.outcome === 'paid' && (
            <div className="absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent/60 opacity-0 [animation:line-pulse_0.55s_ease-out_0.5s_forwards]" />
          )}

          {job.outcome === 'refused' && (
            <div className="absolute left-[24%] top-1/2 w-max -translate-x-1/2 text-center opacity-0 [animation:line-text-in_0.3s_ease-out_0.55s_forwards]">
              <div className="font-mono text-xs uppercase tracking-wide text-offwhite/50">Refused</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

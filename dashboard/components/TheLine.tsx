/**
 * "The line your agents can't cross" — a thin vertical line between the
 * agent (left) and a target (right). Each job animates a small dot from the
 * agent toward the target:
 *  - blocked: the dot stops at the line and a "Blocked: <reason>" pill fades in.
 *  - paid: the dot passes through the line and continues.
 *  - refused: the agent never tried — the dot fades out before reaching the line.
 * Pure CSS keyframes (dashboard/app/globals.css), no animation libraries.
 * Minimal by design: no particles, no glow. Every variant finishes under 1.2s.
 * Re-keying by job.id restarts the animation for a new attempt.
 */
export type LineOutcome = 'blocked' | 'paid' | 'refused';

export interface LineJob {
  id: string;
  outcome: LineOutcome;
  reason?: string | null;
}

const DOT_ANIMATION: Record<LineOutcome, string> = {
  blocked: 'animate-[dot-block_0.55s_ease-out_forwards]',
  paid: 'animate-[dot-pass_1.1s_ease-out_forwards]',
  refused: 'animate-[dot-refused_0.9s_ease-out_forwards]',
};

const DOT_COLOR: Record<LineOutcome, string> = {
  blocked: 'bg-danger',
  paid: 'bg-accent',
  refused: 'bg-muted',
};

export function TheLine({ job }: { job: LineJob | null }) {
  return (
    <div className="relative h-24 w-full overflow-hidden rounded-xl border border-border bg-white">
      {/* the line itself */}
      <div className="absolute inset-y-4 left-1/2 w-px -translate-x-1/2 bg-ink/25" />

      {/* endpoints */}
      <div className="absolute left-[10%] top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1">
        <div className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-white text-[11px] text-slate">A</div>
        <span className="text-[11px] text-muted">Agent</span>
      </div>
      <div className="absolute left-[90%] top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1">
        <div className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-white text-[11px] text-slate">T</div>
        <span className="text-[11px] text-muted">Target</span>
      </div>

      {job && (
        <div key={job.id} className="absolute inset-0">
          {/* the dot */}
          <div className={['absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0', DOT_COLOR[job.outcome], DOT_ANIMATION[job.outcome]].join(' ')} />

          {job.outcome === 'blocked' && (
            <div className="absolute left-1/2 top-[64%] w-max max-w-[70%] -translate-x-1/2 rounded-full bg-danger-bg px-3 py-1 text-center text-[12px] font-medium text-danger opacity-0 [animation:pill-fade-in_0.25s_ease-out_0.5s_forwards]">
              Blocked{job.reason ? `: ${job.reason}` : ''}
            </div>
          )}

          {job.outcome === 'refused' && (
            <div className="absolute left-[26%] top-[64%] w-max -translate-x-1/2 rounded-full bg-neutral-bg px-3 py-1 text-center text-[12px] font-medium text-neutral opacity-0 [animation:pill-fade-in_0.25s_ease-out_0.45s_forwards]">
              Refused
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export type PillTone = 'success' | 'danger' | 'pending' | 'neutral' | 'accent';

const TONE_CLASS: Record<PillTone, string> = {
  success: 'bg-success-bg text-success',
  danger: 'bg-danger-bg text-danger',
  pending: 'bg-pending-bg text-pending',
  neutral: 'bg-neutral-bg text-neutral',
  accent: 'bg-accent/10 text-accent',
};

export function Pill({ tone = 'neutral', children }: { tone?: PillTone; children: React.ReactNode }) {
  return (
    <span className={['inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-medium', TONE_CLASS[tone]].join(' ')}>
      {children}
    </span>
  );
}

export function NeutralPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-2.5 py-1 text-[13px] font-medium text-slate">
      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
      {children}
    </span>
  );
}

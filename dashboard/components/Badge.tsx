export function DemoModeBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-mono tracking-wide text-accent">
      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
      Demo mode &mdash; testnet
    </span>
  );
}

export function RoleBadge({ role }: { role: 'production' | 'demo' }) {
  if (role === 'production') {
    return <span className="rounded border border-offwhite/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-offwhite/60">production</span>;
  }
  return <span className="rounded border border-accent/30 px-2 py-0.5 text-[10px] uppercase tracking-wider text-accent/90">demo sandbox</span>;
}

export function StatusChip({ status }: { status: string }) {
  const danger = status === 'Blocked';
  return (
    <span
      className={[
        'rounded border px-2 py-0.5 text-[11px] font-mono uppercase tracking-wide',
        danger ? 'border-danger/50 text-danger' : 'border-offwhite/15 text-offwhite/70',
      ].join(' ')}
    >
      {status}
    </span>
  );
}

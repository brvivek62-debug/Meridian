export function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex flex-1 flex-col gap-1.5 rounded-xl border border-border bg-white px-5 py-4">
      <span className="text-[13px] text-muted">{label}</span>
      <span className={['text-[22px] font-semibold tabular-nums', danger ? 'text-danger' : 'text-ink'].join(' ')}>{value}</span>
    </div>
  );
}

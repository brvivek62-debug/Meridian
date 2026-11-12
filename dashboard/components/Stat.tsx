export function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex flex-1 flex-col gap-1 rounded-lg border border-offwhite/12 bg-navy-raised/40 px-4 py-3">
      <span className="font-mono text-[11px] uppercase tracking-wide text-offwhite/40">{label}</span>
      <span className={['font-mono text-2xl font-semibold', danger ? 'text-danger' : 'text-offwhite'].join(' ')}>{value}</span>
    </div>
  );
}

export function TxLink({ explorer }: { explorer: string }) {
  return (
    <a
      href={explorer}
      target="_blank"
      rel="noreferrer"
      className="inline-block font-mono text-xs text-accent underline-offset-2 hover:underline"
    >
      view tx &#8599;
    </a>
  );
}

export function RuleTag({ rule }: { rule: string }) {
  return (
    <span className="rounded border border-danger/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-danger">
      {rule}
    </span>
  );
}

import { formatNear, shortAccount } from '@/lib/format';
import type { Mandate } from '@/lib/types';

function TreeNode({ mandate, byParent }: { mandate: Mandate; byParent: Map<number, Mandate[]> }) {
  const children = byParent.get(mandate.id) ?? [];
  return (
    <li className="relative pl-6">
      <span className="absolute left-0 top-5 h-px w-5 bg-border" aria-hidden />
      <div className="inline-flex flex-col gap-0.5 rounded-lg border border-border bg-white px-3 py-2">
        <span className="text-[12px] font-medium text-accent">Mandate {mandate.id}</span>
        <span className="font-mono text-[13px] text-ink">{shortAccount(mandate.agent)}</span>
        <span className="text-[12px] tabular-nums text-muted">{formatNear(mandate.budget)}</span>
      </div>
      {children.length > 0 && (
        <ul className="ml-3 mt-2 space-y-2 border-l border-border pl-0">
          {children.map((c) => (
            <TreeNode key={c.id} mandate={c} byParent={byParent} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function DelegationTree({ ownerId, mandates }: { ownerId: string; mandates: Mandate[] }) {
  const byParent = new Map<number, Mandate[]>();
  const roots: Mandate[] = [];
  for (const m of mandates) {
    if (m.parent === null) {
      roots.push(m);
    } else {
      const arr = byParent.get(m.parent) ?? [];
      arr.push(m);
      byParent.set(m.parent, arr);
    }
  }

  if (roots.length === 0) {
    return <p className="text-[14px] text-muted">No mandates yet.</p>;
  }

  return (
    <div>
      <div className="mb-2 inline-flex rounded-lg border border-border bg-white px-3 py-2 text-[13px] text-slate">
        Owner · {shortAccount(ownerId)}
      </div>
      <ul className="ml-3 space-y-2 border-l border-border pl-0">
        {roots.map((m) => (
          <TreeNode key={m.id} mandate={m} byParent={byParent} />
        ))}
      </ul>
    </div>
  );
}

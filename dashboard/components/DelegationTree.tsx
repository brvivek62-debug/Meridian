import { formatNear, shortAccount } from '@/lib/format';
import type { Mandate } from '@/lib/types';

function TreeNode({ mandate, byParent }: { mandate: Mandate; byParent: Map<number, Mandate[]> }) {
  const children = byParent.get(mandate.id) ?? [];
  return (
    <li className="relative pl-6">
      <span className="absolute left-0 top-5 h-px w-5 bg-offwhite/15" aria-hidden />
      <div className="inline-flex flex-col gap-0.5 rounded-md border border-offwhite/20 bg-transparent px-3 py-2">
        <span className="font-mono text-[11px] text-accent">mandate {mandate.id}</span>
        <span className="font-mono text-sm">{shortAccount(mandate.agent)}</span>
        <span className="font-mono text-[11px] text-offwhite/50">{formatNear(mandate.budget)}</span>
      </div>
      {children.length > 0 && (
        <ul className="ml-3 mt-2 space-y-2 border-l border-offwhite/15 pl-0">
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
    return <p className="font-mono text-sm text-offwhite/40">No mandates yet.</p>;
  }

  return (
    <div>
      <div className="mb-2 inline-flex rounded-md border border-offwhite/20 bg-transparent px-3 py-2 font-mono text-sm text-offwhite/70">
        owner &middot; {shortAccount(ownerId)}
      </div>
      <ul className="ml-3 space-y-2 border-l border-offwhite/15 pl-0">
        {roots.map((m) => (
          <TreeNode key={m.id} mandate={m} byParent={byParent} />
        ))}
      </ul>
    </div>
  );
}

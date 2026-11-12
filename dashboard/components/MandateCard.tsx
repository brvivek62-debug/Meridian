'use client';

import { useState } from 'react';
import { shortAccount } from '@/lib/format';
import type { MandateWithChildren } from '@/lib/types';
import { BudgetMeter } from './BudgetMeter';
import { ReceiptsFeed } from './ReceiptsFeed';
import { TaskBoard } from './TaskBoard';

export function MandateCard({
  mandate,
  allMandates,
  explorerBase,
  depth = 0,
}: {
  mandate: MandateWithChildren;
  allMandates: MandateWithChildren[];
  explorerBase: string;
  depth?: number;
}) {
  const [open, setOpen] = useState(false);
  const children = allMandates.filter((m) => m.parent === mandate.id);

  return (
    <div className={['rounded-lg border border-offwhite/12 bg-navy-raised/40 p-4 transition-colors duration-200', depth > 0 ? 'bg-navy-raised/25' : ''].join(' ')}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full flex-col gap-1 text-left">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-accent">mandate {mandate.id}</span>
          {!mandate.active && <span className="rounded border border-offwhite/20 px-1.5 py-0.5 text-[10px] uppercase text-offwhite/40">revoked</span>}
          {mandate.parent !== null && <span className="text-[11px] text-offwhite/40">(sub-mandate of {mandate.parent})</span>}
        </div>
        <a
          href={`${explorerBase}/address/${mandate.agent}`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-base hover:text-accent hover:underline"
        >
          {shortAccount(mandate.agent)}
        </a>
      </button>

      <div className="mt-3">
        <BudgetMeter mandate={mandate} />
      </div>

      <button onClick={() => setOpen((o) => !o)} className="mt-3 font-mono text-xs text-offwhite/40 hover:text-accent">
        {open ? '− hide receipts & tasks' : `+ ${mandate.receipts.length} receipts, ${mandate.tasks.length} tasks`}
      </button>

      {open && (
        <div className="mt-3 space-y-4 border-t border-offwhite/10 pt-3">
          <div>
            <h4 className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-offwhite/40">Receipts</h4>
            <ReceiptsFeed receipts={mandate.receipts} explorerBase={explorerBase} />
          </div>
          <div>
            <h4 className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-offwhite/40">Tasks</h4>
            <TaskBoard tasks={mandate.tasks} explorerBase={explorerBase} />
          </div>
        </div>
      )}

      {children.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-offwhite/10 pt-3">
          <h4 className="font-mono text-[11px] uppercase tracking-wide text-offwhite/40">Sub-mandates</h4>
          <div className="space-y-2 border-l border-offwhite/10 pl-3">
            {children.map((c) => (
              <MandateCard key={c.id} mandate={c} allMandates={allMandates} explorerBase={explorerBase} depth={depth + 1} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

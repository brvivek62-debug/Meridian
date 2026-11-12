'use client';

import { useState } from 'react';
import { shortAccount } from '@/lib/format';
import type { MandateWithChildren } from '@/lib/types';
import { Pill } from '@/components/ui/Pill';
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
    <div className="rounded-xl border border-border bg-white p-5">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full flex-col gap-1 text-left">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-accent">Mandate {mandate.id}</span>
          {!mandate.active && <Pill tone="neutral">Revoked</Pill>}
          {mandate.parent !== null && <span className="text-[12px] text-muted">(sub-mandate of {mandate.parent})</span>}
        </div>
        <a
          href={`${explorerBase}/address/${mandate.agent}`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-[15px] text-ink hover:text-accent hover:underline"
        >
          {shortAccount(mandate.agent)}
        </a>
      </button>

      <div className="mt-3">
        <BudgetMeter mandate={mandate} />
      </div>

      <button onClick={() => setOpen((o) => !o)} className="mt-3 text-[13px] font-medium text-accent hover:text-accent-hover">
        {open ? 'Hide receipts & tasks' : `${mandate.receipts.length} receipts, ${mandate.tasks.length} tasks`}
      </button>

      {open && (
        <div className="mt-4 space-y-5 border-t border-border pt-4">
          <div>
            <h4 className="mb-2 text-[13px] font-medium text-slate">Receipts</h4>
            <ReceiptsFeed receipts={mandate.receipts} explorerBase={explorerBase} />
          </div>
          <div>
            <h4 className="mb-2 text-[13px] font-medium text-slate">Tasks</h4>
            <TaskBoard tasks={mandate.tasks} explorerBase={explorerBase} />
          </div>
        </div>
      )}

      {children.length > 0 && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <h4 className="text-[13px] font-medium text-slate">Sub-mandates</h4>
          <div className="space-y-3 border-l border-border pl-4">
            {children.map((c) => (
              <MandateCard key={c.id} mandate={c} allMandates={allMandates} explorerBase={explorerBase} depth={depth + 1} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

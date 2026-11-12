'use client';

import { useState } from 'react';

type Result = { ok: boolean; error?: string; mandateId?: number; explorer?: string };

export function CreateMandateForm({
  demoOwnerId,
  onSubmit,
}: {
  demoOwnerId: string;
  onSubmit: (body: {
    agent: string;
    budgetNear: string;
    perTxCapNear: string;
    dailyCapNear: string;
    allowlist: string[];
    approvalThresholdNear: string;
  }) => Promise<Result>;
}) {
  const [agent, setAgent] = useState('');
  const [budgetNear, setBudgetNear] = useState('2');
  const [perTxCapNear, setPerTxCapNear] = useState('0.5');
  const [dailyCapNear, setDailyCapNear] = useState('1');
  const [allowlist, setAllowlist] = useState('');
  const [approvalThresholdNear, setApprovalThresholdNear] = useState('0.4');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const r = await onSubmit({
      agent: agent.trim() || demoOwnerId,
      budgetNear,
      perTxCapNear,
      dailyCapNear,
      allowlist: allowlist
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      approvalThresholdNear,
    });
    setResult(r);
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <Field label="Agent account" value={agent} onChange={setAgent} placeholder={demoOwnerId} />
      <Field label="Budget (NEAR)" value={budgetNear} onChange={setBudgetNear} />
      <Field label="Per-tx cap (NEAR)" value={perTxCapNear} onChange={setPerTxCapNear} />
      <Field label="Daily cap (NEAR)" value={dailyCapNear} onChange={setDailyCapNear} />
      <Field label="Approval threshold (NEAR)" value={approvalThresholdNear} onChange={setApprovalThresholdNear} />
      <Field label="Allowlist (comma-separated, blank = any)" value={allowlist} onChange={setAllowlist} placeholder="paid-api.testnet, ..." />
      <div className="sm:col-span-2 flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded border border-accent/50 bg-accent/10 px-4 py-1.5 font-mono text-sm text-accent transition-colors duration-150 hover:bg-accent/20 disabled:opacity-40"
        >
          {busy ? 'Creating…' : 'Create mandate'}
        </button>
        {result &&
          (result.ok ? (
            <span className="font-mono text-xs text-accent">
              mandate {result.mandateId} created &middot;{' '}
              <a href={result.explorer} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                view tx
              </a>
            </span>
          ) : (
            <span className="font-mono text-xs text-danger">{result.error}</span>
          ))}
      </div>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[11px] uppercase tracking-wide text-offwhite/50">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-offwhite/15 bg-transparent px-2.5 py-1.5 font-mono text-sm text-offwhite outline-none transition-colors duration-150 focus:border-accent/60"
      />
    </label>
  );
}

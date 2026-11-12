'use client';

import { useMemo, useState } from 'react';

type Result = { ok: boolean; error?: string; mandateId?: number; explorer?: string };

interface ParsedMandate {
  budgetNear: string;
  perTxCapNear: string;
  dailyCapNear: string;
  allowlist: string[];
  approvalThresholdNear: string;
  notes: string[];
}

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

  const [description, setDescription] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parseNotes, setParseNotes] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState(false);

  const validationErrors = useMemo(() => {
    const errs: string[] = [];
    const budget = Number(budgetNear);
    const perTx = Number(perTxCapNear);
    const daily = Number(dailyCapNear);
    const threshold = Number(approvalThresholdNear);
    if (!Number.isFinite(budget) || budget <= 0) errs.push('budget must be greater than 0');
    if (!Number.isFinite(perTx) || perTx <= 0) errs.push('per-tx cap must be greater than 0');
    else if (Number.isFinite(budget) && perTx > budget) errs.push('per-tx cap cannot exceed the budget');
    if (!Number.isFinite(daily) || daily <= 0) errs.push('daily cap must be greater than 0');
    else if (Number.isFinite(budget) && daily > budget) errs.push('daily cap cannot exceed the budget');
    if (!Number.isFinite(threshold) || threshold < 0) errs.push('approval threshold cannot be negative');
    else if (Number.isFinite(budget) && threshold > budget) errs.push('approval threshold cannot exceed the budget');
    return errs;
  }, [budgetNear, perTxCapNear, dailyCapNear, approvalThresholdNear]);

  async function parse() {
    if (!description.trim() || parsing) return;
    setParsing(true);
    setParseError(null);
    try {
      const res = await fetch('/api/parse-mandate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: description.trim() }),
      });
      const body = await res.json();
      if (!res.ok) {
        setParseError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const p: ParsedMandate = body.parsed;
      setBudgetNear(p.budgetNear);
      setPerTxCapNear(p.perTxCapNear);
      setDailyCapNear(p.dailyCapNear);
      setAllowlist(p.allowlist.join(', '));
      setApprovalThresholdNear(p.approvalThresholdNear);
      setParseNotes(p.notes);
      setReviewing(true);
      setResult(null);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
    } finally {
      setParsing(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (validationErrors.length > 0) return;
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
    if (r.ok) setReviewing(false);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-offwhite/12 bg-navy-raised/30 p-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[11px] uppercase tracking-wide text-offwhite/50">Describe the rules in your own words</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
            rows={3}
            placeholder='e.g. "Give the agent 3 NEAR total, up to 0.5 NEAR per payment, no more than 1 NEAR a day, only to my paid API and two workers, anything over 0.8 NEAR needs my OK."'
            className="resize-none rounded border border-offwhite/15 bg-transparent px-2.5 py-1.5 font-mono text-sm text-offwhite outline-none transition-colors duration-150 placeholder:text-offwhite/30 focus:border-accent/60"
          />
        </label>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={parse}
            disabled={parsing || !description.trim()}
            className="rounded border border-accent/50 bg-accent/10 px-3 py-1 font-mono text-xs uppercase tracking-wide text-accent transition-colors duration-150 hover:bg-accent/20 disabled:opacity-40"
          >
            {parsing ? 'Parsing…' : 'Parse with AI'}
          </button>
          {parseError && <span className="font-mono text-xs text-danger">{parseError}</span>}
        </div>
      </div>

      {reviewing && (
        <div className="rounded-md border border-accent/30 bg-accent/5 p-3 font-mono text-xs text-accent">
          Parsed from your description — review every field below, edit anything that isn&rsquo;t right, then confirm
          with &ldquo;Create mandate&rdquo;. Nothing is submitted until you do.
          {parseNotes.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-offwhite/60">
              {parseNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Agent account" value={agent} onChange={setAgent} placeholder={demoOwnerId} />
        <Field label="Budget (NEAR)" value={budgetNear} onChange={setBudgetNear} />
        <Field label="Per-tx cap (NEAR)" value={perTxCapNear} onChange={setPerTxCapNear} />
        <Field label="Daily cap (NEAR)" value={dailyCapNear} onChange={setDailyCapNear} />
        <Field label="Approval threshold (NEAR)" value={approvalThresholdNear} onChange={setApprovalThresholdNear} />
        <Field label="Allowlist (comma-separated, blank = any)" value={allowlist} onChange={setAllowlist} placeholder="paid-api.testnet, ..." />

        <div className="sm:col-span-2 flex flex-col gap-2">
          {validationErrors.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 font-mono text-xs text-danger">
              {validationErrors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={busy || validationErrors.length > 0}
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
        </div>
      </form>
    </div>
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

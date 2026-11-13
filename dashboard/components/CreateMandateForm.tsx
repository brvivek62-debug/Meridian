'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { TxLink } from '@/components/TxLink';
import { READ_ONLY_OWNER_ACTIONS_MESSAGE } from '@/lib/types';

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
  defaultAgentId,
  onSubmit,
  readOnlyOwnerActions,
}: {
  defaultAgentId: string;
  readOnlyOwnerActions: boolean;
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
    if (!Number.isFinite(budget) || budget <= 0) errs.push('Budget must be greater than 0');
    if (!Number.isFinite(perTx) || perTx <= 0) errs.push('Per-tx cap must be greater than 0');
    else if (Number.isFinite(budget) && perTx > budget) errs.push('Per-tx cap cannot exceed the budget');
    if (!Number.isFinite(daily) || daily <= 0) errs.push('Daily cap must be greater than 0');
    else if (Number.isFinite(budget) && daily > budget) errs.push('Daily cap cannot exceed the budget');
    if (!Number.isFinite(threshold) || threshold < 0) errs.push('Approval threshold cannot be negative');
    else if (Number.isFinite(budget) && threshold > budget) errs.push('Approval threshold cannot exceed the budget');
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
    if (readOnlyOwnerActions || validationErrors.length > 0) return;
    setBusy(true);
    setResult(null);
    const r = await onSubmit({
      agent: agent.trim() || defaultAgentId,
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
      <div className="rounded-xl border border-border bg-surface p-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-slate">Describe the rules in your own words</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
            rows={3}
            placeholder='e.g. "Give the agent 3 NEAR total, up to 0.5 NEAR per payment, no more than 1 NEAR a day, only to my paid API and two workers, anything over 0.8 NEAR needs my OK."'
            className="resize-none rounded-lg border border-border bg-white px-3 py-2 text-[14px] text-ink outline-none transition-colors duration-150 placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>
        <div className="mt-3 flex items-center gap-3">
          <Button type="button" onClick={parse} disabled={!description.trim()} loading={parsing} className="h-9">
            {parsing ? 'Parsing…' : 'Parse with AI'}
          </Button>
          {parseError && <span className="text-[13px] text-danger">{parseError}</span>}
        </div>
      </div>

      {reviewing && (
        <div className="rounded-xl border border-border bg-accent/5 p-4 text-[13px] text-slate">
          <span className="text-ink">Parsed from your description</span> — review every field below, edit anything
          that isn&rsquo;t right, then confirm with &ldquo;Create mandate&rdquo;. Nothing is submitted until you do.
          {parseNotes.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-4">
              {parseNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Agent account" value={agent} onChange={setAgent} placeholder={defaultAgentId} />
        <Field label="Budget (NEAR)" value={budgetNear} onChange={setBudgetNear} />
        <Field label="Per-tx cap (NEAR)" value={perTxCapNear} onChange={setPerTxCapNear} />
        <Field label="Daily cap (NEAR)" value={dailyCapNear} onChange={setDailyCapNear} />
        <Field label="Approval threshold (NEAR)" value={approvalThresholdNear} onChange={setApprovalThresholdNear} />
        <Field label="Allowlist (comma-separated, blank = any)" value={allowlist} onChange={setAllowlist} placeholder="paid-api.testnet, ..." />

        <div className="flex flex-col gap-3 sm:col-span-2">
          {validationErrors.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-[13px] text-danger">
              {validationErrors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={readOnlyOwnerActions || validationErrors.length > 0} loading={busy}>
              {busy ? 'Creating…' : 'Create mandate'}
            </Button>
            {readOnlyOwnerActions && <span className="text-[13px] text-muted">{READ_ONLY_OWNER_ACTIONS_MESSAGE}</span>}
            {!readOnlyOwnerActions && result &&
              (result.ok ? (
                <span className="flex items-center gap-2 text-[13px] text-success">
                  Mandate {result.mandateId} created · {result.explorer && <TxLink explorer={result.explorer} />}
                </span>
              ) : (
                <span className="text-[13px] text-danger">{result.error}</span>
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
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-slate">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-border bg-white px-3 py-2 text-[14px] text-ink outline-none transition-colors duration-150 placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
    </label>
  );
}

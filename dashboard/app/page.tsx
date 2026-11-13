'use client';

import { useCallback, useEffect, useState } from 'react';
import { RoleBadge } from '@/components/Badge';
import { ApprovalsInbox } from '@/components/ApprovalsInbox';
import { CreateMandateForm } from '@/components/CreateMandateForm';
import { DelegationTree } from '@/components/DelegationTree';
import { LinkButton } from '@/components/ui/Button';
import { MandateCard } from '@/components/MandateCard';
import { SectionHeading } from '@/components/SectionHeading';
import { Stat } from '@/components/Stat';
import { TheLine, type LineJob } from '@/components/TheLine';
import { formatNear, shortAccount } from '@/lib/format';
import type { DashboardState, MandateWithChildren, OwnerGroup } from '@/lib/types';

const POLL_MS = 4000;

function visibleMandates(owner: OwnerGroup, showHistory: boolean): MandateWithChildren[] {
  return showHistory ? owner.mandates : owner.mandates.filter((m) => m.active);
}

export default function Page() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lineJob, setLineJob] = useState<LineJob | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setState(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  async function handleAct(pendingId: number, action: 'approve' | 'reject') {
    try {
      const res = await fetch(`/api/pending/${pendingId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = await res.json();
      await refresh();
      if (res.ok) {
        setLineJob({ id: `pending-${pendingId}-${Date.now()}`, outcome: body.status === 'Paid' ? 'paid' : 'blocked', reason: body.reason ?? null });
      }
      return res.ok ? { ok: true, status: body.status, explorer: body.explorer } : { ok: false, error: body.error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async function handleCreateMandate(body: {
    agent: string;
    budgetNear: string;
    perTxCapNear: string;
    dailyCapNear: string;
    allowlist: string[];
    approvalThresholdNear: string;
  }) {
    try {
      const res = await fetch('/api/mandates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const resBody = await res.json();
      await refresh();
      return res.ok
        ? { ok: true, mandateId: resBody.mandateId, explorer: resBody.explorer }
        : { ok: false, error: resBody.error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const demoGroup = state?.owners.find((o) => o.role === 'demo');

  return (
    <main className="mx-auto max-w-[1120px] px-4 py-10 pb-20 sm:px-6">
      <section className="mb-10 rounded-2xl border border-border bg-surface px-6 py-10 text-center sm:px-10">
        <h1 className="text-[32px] font-semibold leading-tight text-ink">The line your agents can&rsquo;t cross</h1>
        <p className="mx-auto mt-3 max-w-xl text-[15px] text-slate">
          Delegated, policy-checked spending for AI agents on NEAR — budgets, caps, allowlists and approvals, enforced
          on-chain by the Vault.
        </p>
        <div className="mt-6">
          <LinkButton href="/break">Try to break it</LinkButton>
        </div>
      </section>

      <div className="mb-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="NEAR under mandate" value={state ? formatNear(state.stats.nearUnderMandateYocto, 2) : '—'} />
        <Stat label="Payments made" value={state ? String(state.stats.paymentsMade) : '—'} />
        <Stat label="Attacks blocked" value={state ? String(state.stats.attacksBlocked) : '—'} />
        <Stat
          label="NEAR stolen"
          value={state ? formatNear(state.stats.nearStolenYocto, 5) : '—'}
          danger={state ? BigInt(state.stats.nearStolenYocto) !== 0n : false}
        />
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3 text-[14px] text-danger">
          {error} — is the Vault reachable and is <code>VAULT_CONTRACT_ID</code> set in <code>.env</code>?
        </div>
      )}

      {!state && !error && <p className="text-[14px] text-muted">Loading live state from {`vault.*.testnet`}&hellip;</p>}

      <div className="mb-10">
        <TheLine job={lineJob} />
      </div>

      {state && (
        <div className="space-y-12">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted">
            <a href={`${state.explorerBase}/address/${state.vaultId}`} target="_blank" rel="noreferrer" className="font-mono hover:text-accent hover:underline">
              {state.vaultId}
            </a>
            <div className="flex items-center gap-3">
              <span>Updated {new Date(state.generatedAt).toLocaleTimeString()}</span>
              <button onClick={() => setShowHistory((h) => !h)} className="rounded-md border border-border px-2.5 py-1 text-slate hover:border-muted hover:text-ink">
                {showHistory ? 'Hide history' : 'Show history'}
              </button>
            </div>
          </div>

          {state.owners.map((owner) => {
            const mandates = visibleMandates(owner, showHistory);
            const roots = mandates.filter((m) => m.parent === null);
            return (
              <section key={owner.ownerId}>
                <div className="mb-3 flex items-center gap-2">
                  <RoleBadge role={owner.role} />
                  <span className="font-mono text-[13px] text-slate">{owner.ownerId}</span>
                </div>
                {roots.length === 0 ? (
                  <p className="text-[14px] text-muted">No active mandates.</p>
                ) : (
                  <div className="grid gap-4">
                    {roots.map((m) => (
                      <MandateCard key={m.id} mandate={m} allMandates={mandates} explorerBase={state.explorerBase} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}

          <section>
            <SectionHeading>Delegation tree</SectionHeading>
            <div className="grid gap-6 sm:grid-cols-2">
              {state.owners.map((owner) => (
                <div key={owner.ownerId}>
                  <DelegationTree ownerId={owner.ownerId} mandates={visibleMandates(owner, showHistory)} />
                </div>
              ))}
            </div>
          </section>

          <section>
            <SectionHeading>Approvals inbox</SectionHeading>
            <ApprovalsInbox owners={state.owners} onAct={handleAct} readOnlyOwnerActions={state.readOnlyOwnerActions} />
          </section>

          <section>
            <SectionHeading>Create mandate</SectionHeading>
            {demoGroup ? (
              <CreateMandateForm
                defaultAgentId={state.agentAccountId}
                onSubmit={handleCreateMandate}
                readOnlyOwnerActions={state.readOnlyOwnerActions}
              />
            ) : (
              <p className="text-[14px] text-muted">
                No demo-owner account configured — run <code>npm run setup-dashboard</code>.
              </p>
            )}
          </section>
        </div>
      )}

      <footer className="mb-6 mt-14 border-t border-border pt-5 text-[12px] leading-relaxed text-muted">
        Reads the Vault&rsquo;s view methods over testnet RPC every {POLL_MS / 1000}s. Owner actions are signed server-side by{' '}
        {demoGroup ? shortAccount(demoGroup.ownerId) : 'a demo-owner account'}, never the real owner&rsquo;s keychain key.
      </footer>
    </main>
  );
}

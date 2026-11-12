'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { DemoModeBadge, RoleBadge } from '@/components/Badge';
import { ApprovalsInbox } from '@/components/ApprovalsInbox';
import { CreateMandateForm } from '@/components/CreateMandateForm';
import { DelegationTree } from '@/components/DelegationTree';
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
    <main className="mx-auto max-w-5xl px-4 py-8 pb-16 sm:px-6">
      <header className="mb-8 rounded-xl border border-offwhite/12 bg-navy-raised/30 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Meridian</h1>
            <p className="mt-1 max-w-xl text-sm text-offwhite/60">
              The line your agents can&rsquo;t cross &mdash; delegated, policy-checked spending for AI agents on NEAR.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <DemoModeBadge />
            <Link
              href="/break"
              className="rounded-md border border-accent bg-accent px-4 py-2 font-mono text-sm font-bold uppercase tracking-wide text-white shadow-[0_0_18px_2px_rgba(47,140,255,0.45)] transition-all duration-150 hover:bg-[#1f7ae0] hover:shadow-[0_0_24px_4px_rgba(47,140,255,0.55)] active:scale-[0.98]"
            >
              Try to break it &rarr;
            </Link>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="NEAR under mandate" value={state ? formatNear(state.stats.nearUnderMandateYocto, 2) : '—'} />
          <Stat label="Payments made" value={state ? String(state.stats.paymentsMade) : '—'} />
          <Stat label="Attacks blocked" value={state ? String(state.stats.attacksBlocked) : '—'} />
          <Stat
            label="NEAR stolen"
            value={state ? formatNear(state.stats.nearStolenYocto, 5) : '—'}
            danger={state ? BigInt(state.stats.nearStolenYocto) !== 0n : false}
          />
        </div>
      </header>

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger/5 px-4 py-3 font-mono text-sm text-danger">
          {error} &mdash; is the Vault reachable and is <code>VAULT_CONTRACT_ID</code> set in <code>.env</code>?
        </div>
      )}

      {!state && !error && <p className="font-mono text-sm text-offwhite/50">Loading live state from {`vault.*.testnet`}&hellip;</p>}

      <div className="mb-8">
        <TheLine job={lineJob} />
      </div>

      {state && (
        <div className="space-y-10">
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-offwhite/40">
            <a href={`${state.explorerBase}/address/${state.vaultId}`} target="_blank" rel="noreferrer" className="hover:text-accent hover:underline">
              {state.vaultId}
            </a>
            <div className="flex items-center gap-3">
              <span>updated {new Date(state.generatedAt).toLocaleTimeString()}</span>
              <button onClick={() => setShowHistory((h) => !h)} className="rounded border border-offwhite/15 px-2 py-0.5 uppercase tracking-wide text-offwhite/50 hover:text-accent">
                {showHistory ? 'hide history' : 'show history'}
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
                  <span className="font-mono text-sm text-offwhite/60">{owner.ownerId}</span>
                </div>
                {roots.length === 0 ? (
                  <p className="font-mono text-sm text-offwhite/40">No active mandates.</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
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
            <ApprovalsInbox owners={state.owners} onAct={handleAct} />
          </section>

          <section>
            <SectionHeading>Create mandate</SectionHeading>
            {demoGroup ? (
              <CreateMandateForm defaultAgentId={state.agentAccountId} onSubmit={handleCreateMandate} />
            ) : (
              <p className="font-mono text-sm text-offwhite/40">
                No demo-owner account configured &mdash; run <code>npm run setup-dashboard</code>.
              </p>
            )}
          </section>
        </div>
      )}

      <footer className="mb-6 mt-12 border-t border-offwhite/10 pt-4 font-mono text-[11px] leading-relaxed text-offwhite/30">
        Reads the Vault&rsquo;s view methods over testnet RPC every {POLL_MS / 1000}s. Owner actions are signed server-side by{' '}
        {demoGroup ? shortAccount(demoGroup.ownerId) : 'a demo-owner account'}, never the real owner&rsquo;s keychain key.
      </footer>
    </main>
  );
}

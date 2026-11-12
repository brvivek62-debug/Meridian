'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { DemoModeBadge, RoleBadge } from '@/components/Badge';
import { ApprovalsInbox } from '@/components/ApprovalsInbox';
import { CreateMandateForm } from '@/components/CreateMandateForm';
import { DelegationTree } from '@/components/DelegationTree';
import { MandateCard } from '@/components/MandateCard';
import { TheLine, type LineJob } from '@/components/TheLine';
import { shortAccount } from '@/lib/format';
import type { DashboardState } from '@/lib/types';

const POLL_MS = 4000;

export default function Page() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lineJob, setLineJob] = useState<LineJob | null>(null);

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

  async function handleAttack(mandateId: number) {
    try {
      const res = await fetch('/api/attack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mandateId }),
      });
      const body = await res.json();
      await refresh();
      if (res.ok) {
        setLineJob({ id: `attack-${mandateId}-${Date.now()}`, outcome: body.status === 'Blocked' ? 'blocked' : 'paid', reason: body.reason ?? null });
      }
      return res.ok
        ? { ok: true, status: body.status, reason: body.reason, explorer: body.explorer }
        : { ok: false, error: body.error };
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
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Meridian</h1>
          <p className="text-sm text-offwhite/50">The line your agents can&rsquo;t cross.</p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/break"
            className="rounded-full border border-danger/40 bg-danger/10 px-3 py-1 font-mono text-xs uppercase tracking-wide text-danger transition-colors duration-150 hover:bg-danger/20"
          >
            Break Meridian &rarr;
          </Link>
          <DemoModeBadge />
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
          <div className="font-mono text-xs text-offwhite/40">
            <a href={`${state.explorerBase}/address/${state.vaultId}`} target="_blank" rel="noreferrer" className="hover:text-accent hover:underline">
              {state.vaultId}
            </a>{' '}
            &middot; updated {new Date(state.generatedAt).toLocaleTimeString()}
          </div>

          {state.owners.map((owner) => (
            <section key={owner.ownerId}>
              <div className="mb-3 flex items-center gap-2">
                <RoleBadge role={owner.role} />
                <span className="font-mono text-sm text-offwhite/60">{owner.ownerId}</span>
              </div>
              {owner.mandates.length === 0 ? (
                <p className="font-mono text-sm text-offwhite/40">No mandates yet.</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {owner.mandates.map((m) => (
                    <MandateCard key={m.id} mandate={m} explorerBase={state.explorerBase} onAttack={handleAttack} />
                  ))}
                </div>
              )}
            </section>
          ))}

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-offwhite/50">Delegation tree</h2>
            <div className="grid gap-6 sm:grid-cols-2">
              {state.owners.map((owner) => (
                <div key={owner.ownerId}>
                  <DelegationTree ownerId={owner.ownerId} mandates={owner.mandates} />
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-offwhite/50">Approvals inbox</h2>
            <ApprovalsInbox owners={state.owners} onAct={handleAct} />
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-offwhite/50">Create mandate</h2>
            {demoGroup ? (
              <CreateMandateForm demoOwnerId={demoGroup.ownerId} onSubmit={handleCreateMandate} />
            ) : (
              <p className="font-mono text-sm text-offwhite/40">
                No demo-owner account configured &mdash; run <code>npm run setup-dashboard</code>.
              </p>
            )}
          </section>
        </div>
      )}

      <footer className="mt-12 border-t border-offwhite/10 pt-4 font-mono text-[11px] text-offwhite/30">
        Reads the Vault&rsquo;s view methods over testnet RPC every {POLL_MS / 1000}s. Owner actions are signed server-side by{' '}
        {demoGroup ? shortAccount(demoGroup.ownerId) : 'a demo-owner account'}, never the real owner&rsquo;s keychain key.
      </footer>
    </main>
  );
}

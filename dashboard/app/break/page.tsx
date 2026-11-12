'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AttackConsole, type SubmitResult } from '@/components/break/AttackConsole';
import { HallOfAttempts } from '@/components/break/HallOfAttempts';
import { Scoreboard } from '@/components/break/Scoreboard';
import { SectionHeading } from '@/components/SectionHeading';
import { TheLine, type LineJob } from '@/components/TheLine';
import type { PublicAttempt } from '@/lib/breakStore';
import type { Scoreboard as ScoreboardData } from '@/lib/breakStore';

const POLL_MS = 6000;

interface BreakState {
  enabled: boolean;
  recent: PublicAttempt[];
  scoreboard: ScoreboardData;
  explorerBase: string;
  vaultId: string;
}

export default function BreakPage() {
  const [state, setState] = useState<BreakState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lineJob, setLineJob] = useState<LineJob | null>(null);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    if (busyRef.current) return; // don't clobber an in-flight attack's optimistic result
    try {
      const res = await fetch('/api/break', { cache: 'no-store' });
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

  async function handleSubmit(message: string, target: string): Promise<SubmitResult> {
    busyRef.current = true;
    try {
      const res = await fetch('/api/break', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, target }),
      });
      const body = await res.json();
      if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
      setState(body);
      setLineJob({
        id: body.attempt.id,
        outcome: !body.attempt.fooled ? 'refused' : body.attempt.vaultStatus === 'Paid' ? 'paid' : 'blocked',
        reason: body.attempt.reason,
      });
      return { ok: true, attempt: body.attempt };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      busyRef.current = false;
    }
  }

  return (
    <main className="mx-auto max-w-[1120px] px-4 py-10 pb-20 sm:px-6">
      <section className="mb-10 rounded-2xl border border-border bg-surface px-6 py-10 text-center sm:px-10">
        <h1 className="text-[32px] font-semibold leading-tight text-ink">Try to make this AI agent send you money</h1>
        <p className="mx-auto mt-3 max-w-xl text-[15px] text-slate">
          This agent controls a real testnet wallet. It genuinely decides for itself — the Vault enforces the rest,
          on-chain.
        </p>
      </section>

      {error && (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3 text-[14px] text-danger">{error}</div>
      )}

      <div className="mb-10">
        <SectionHeading>Attack the agent</SectionHeading>
        <AttackConsole enabled={state?.enabled ?? true} onSubmit={handleSubmit} explorerBase={state?.explorerBase ?? 'https://testnet.nearblocks.io'} />
      </div>

      <div className="mb-10">
        <TheLine job={lineJob} />
      </div>

      <div className="mb-10">
        <SectionHeading>Scoreboard</SectionHeading>
        <Scoreboard data={state?.scoreboard ?? null} />
      </div>

      <div>
        <SectionHeading>Recent attempts</SectionHeading>
        <HallOfAttempts attempts={state?.recent ?? []} />
      </div>

      <footer className="mb-6 mt-14 border-t border-border pt-5 text-[12px] leading-relaxed text-muted">
        break-agent holds its own small, isolated mandate — a budget, per-transaction cap, daily cap, and an
        allowlist containing only the demo paid-api vendor. No visitor-supplied account can ever be on it, so every
        payment the agent decides to attempt there is blocked on-chain. Hard mode shows the other side of the same
        coin: even a payment to that allowed vendor is still capped per-transaction and per-day.
      </footer>
    </main>
  );
}

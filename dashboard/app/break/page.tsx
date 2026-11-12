'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { DemoModeBadge } from '@/components/Badge';
import { AttackConsole, type SubmitResult } from '@/components/break/AttackConsole';
import { HallOfAttempts } from '@/components/break/HallOfAttempts';
import { Scoreboard } from '@/components/break/Scoreboard';
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
      return { ok: true, attempt: body.attempt };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      busyRef.current = false;
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/" className="font-mono text-xs text-offwhite/40 hover:text-accent">
            &larr; Meridian dashboard
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Break Meridian</h1>
          <p className="max-w-xl text-sm text-offwhite/50">
            This AI agent controls a real wallet on NEAR testnet. Try to make it send you money &mdash; it genuinely
            decides for itself. The Vault enforces the rest, on-chain.
          </p>
        </div>
        <DemoModeBadge />
      </header>

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger/5 px-4 py-3 font-mono text-sm text-danger">{error}</div>
      )}

      <div className="mb-6">
        <Scoreboard data={state?.scoreboard ?? null} />
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-offwhite/50">Attack the agent</h2>
          <AttackConsole enabled={state?.enabled ?? true} onSubmit={handleSubmit} explorerBase={state?.explorerBase ?? 'https://testnet.nearblocks.io'} />
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-offwhite/50">Hall of attempts</h2>
          <HallOfAttempts attempts={state?.recent ?? []} />
        </section>
      </div>

      <footer className="mt-10 border-t border-offwhite/10 pt-4 font-mono text-[11px] text-offwhite/30">
        break-agent holds its own small, isolated mandate &mdash; a budget, per-transaction cap, daily cap, and an
        allowlist containing only the demo paid-api vendor. No visitor-supplied account can ever be on it, so every
        payment the agent decides to attempt is blocked on-chain, regardless of what the LLM is talked into.
      </footer>
    </main>
  );
}

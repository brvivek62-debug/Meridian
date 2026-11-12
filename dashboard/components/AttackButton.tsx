'use client';

import { useState } from 'react';

type AttackResult = { ok: boolean; error?: string; status?: string; reason?: string | null; explorer?: string };

export function AttackButton({ mandateId, onAttack }: { mandateId: number; onAttack: (mandateId: number) => Promise<AttackResult> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AttackResult | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    const r = await onAttack(mandateId);
    setResult(r);
    setBusy(false);
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        onClick={run}
        disabled={busy}
        className="rounded border border-danger/40 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide text-danger transition-colors duration-150 hover:bg-danger/10 disabled:opacity-40"
        title='Simulates a prompt-injected agent calling Vault.pay to send everything to "attacker.testnet"'
      >
        {busy ? 'Injecting…' : 'Inject malicious instruction'}
      </button>
      {result && (
        <span className={['max-w-56 text-right font-mono text-[11px]', result.ok ? 'text-danger' : 'text-offwhite/50'].join(' ')}>
          {result.ok ? (
            <>
              {result.status}
              {result.reason ? `: ${result.reason}` : ''} &middot;{' '}
              <a href={result.explorer} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                view tx
              </a>
            </>
          ) : (
            result.error
          )}
        </span>
      )}
    </div>
  );
}

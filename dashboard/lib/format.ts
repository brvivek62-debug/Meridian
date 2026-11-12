/** Pure formatting helpers — safe to import from client or server components. */

export function formatNear(yocto: string | bigint, maxDecimals = 4): string {
  const n = typeof yocto === 'string' ? BigInt(yocto) : yocto;
  const s = n.toString().padStart(25, '0');
  const whole = s.slice(0, -24);
  const frac = s.slice(-24, -24 + maxDecimals).replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} NEAR`;
}

export function shortHash(hash: string, head = 8, tail = 6): string {
  if (hash.length <= head + tail + 1) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

export function shortAccount(id: string): string {
  // "worker-summarizer.vivek-meridian.testnet" -> "worker-summarizer"
  return id.split('.')[0];
}

export function explorerTx(base: string, hash: string): string {
  return `${base}/txns/${hash}`;
}

export function explorerAccount(base: string, id: string): string {
  return `${base}/address/${id}`;
}

export function pct(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  const ratio = Number((numerator * 10000n) / denominator) / 100;
  return Math.max(0, Math.min(100, ratio));
}

export function timeAgo(nsString: string): string {
  const ms = Number(BigInt(nsString) / 1_000_000n);
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

/**
 * Classifies a Vault `Blocked` receipt's reason string (contracts/vault/src/lib.rs
 * `Mandate::violations`, joined with "; ") into the rule(s) that fired, so the
 * UI can show a small tag per violated rule instead of just raw text.
 */
export const BLOCK_RULE_LABELS = ['ALLOWLIST', 'PER-TX CAP', 'DAILY CAP', 'BUDGET', 'INACTIVE'] as const;
export type BlockRule = (typeof BLOCK_RULE_LABELS)[number];

export function classifyBlockReasons(reason: string | null | undefined): BlockRule[] {
  if (!reason) return [];
  const lower = reason.toLowerCase();
  const tags: BlockRule[] = [];
  if (lower.includes('allowlist')) tags.push('ALLOWLIST');
  if (lower.includes('per-tx cap')) tags.push('PER-TX CAP');
  if (lower.includes('daily cap')) tags.push('DAILY CAP');
  if (lower.includes('remaining budget')) tags.push('BUDGET');
  if (lower.includes('not active')) tags.push('INACTIVE');
  return tags;
}

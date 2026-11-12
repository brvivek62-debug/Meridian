/**
 * Shared logic to cut an account's full-access key down to a function-call
 * access key restricted to one contract and one method set, removing the
 * full-access key in the same atomic transaction. Used for the agent
 * (scripts/setup-agent-key.ts) and the worker accounts (scripts/setup-worker-keys.ts).
 *
 * Both actions (AddKey + DeleteKey) go in a single transaction signed with the
 * account's current full-access key, so there is never a window where the
 * account has neither key or two full-access keys. Idempotent: a no-op if the
 * account already holds exactly the expected function-call key.
 */
import { KeyPair, PublicKey, actions, nearToYocto } from 'near-api-js';
import { writeFileSync } from 'node:fs';
import { account, credPath, explorerAccount, explorerTx, loadKey, txHash } from './near.ts';

export interface KeyRow {
  public_key: string;
  access_key: {
    permission: 'FullAccess' | { FunctionCall: { receiver_id: string; method_names: string[]; allowance?: string | null } };
  };
}

export function printKeys(label: string, keys: KeyRow[]): void {
  console.log(`\n${label}`);
  for (const k of keys) {
    const p = k.access_key.permission;
    if (p === 'FullAccess') {
      console.log(`  ${k.public_key}  FullAccess`);
    } else {
      const fc = p.FunctionCall;
      console.log(
        `  ${k.public_key}  FunctionCall receiver=${fc.receiver_id} methods=[${fc.method_names.join(', ')}] allowance=${fc.allowance ?? 'unlimited'}`,
      );
    }
  }
}

/**
 * Restrict `accountId` to a single function-call key scoped to `vaultId` and
 * `methods`. Returns the tx hash if a change was made, or null if the account
 * already matched (no-op).
 */
export async function restrictToVault(
  accountId: string,
  vaultId: string,
  methods: string[],
  allowanceNear: `${number}` = '0.25',
): Promise<string | null> {
  const acc = account(accountId);
  const before = (await acc.getAccessKeyList()).keys as unknown as KeyRow[];
  printKeys(`Before — ${accountId} access keys:`, before);

  const alreadyRestricted =
    before.length === 1 &&
    before[0].access_key.permission !== 'FullAccess' &&
    before[0].access_key.permission.FunctionCall.receiver_id === vaultId &&
    methods.every(
      (m) =>
        before[0].access_key.permission !== 'FullAccess' &&
        (before[0].access_key.permission as { FunctionCall: { method_names: string[] } }).FunctionCall.method_names.includes(m),
    );
  if (alreadyRestricted) {
    console.log(`\n✓ ${accountId} already holds only a function-call key restricted to ${vaultId}. Nothing to do.`);
    return null;
  }

  const fullAccessKeys = before.filter((k) => k.access_key.permission === 'FullAccess');
  if (fullAccessKeys.length === 0) {
    throw new Error(`${accountId} has no full-access key to remove, and is not yet restricted the expected way. Inspect manually.`);
  }
  if (fullAccessKeys.length > 1) {
    throw new Error(`${accountId} has ${fullAccessKeys.length} full-access keys; expected exactly 1. Inspect manually before proceeding.`);
  }
  const oldPublicKey = PublicKey.fromString(fullAccessKeys[0].public_key);

  const newKeyPair = KeyPair.fromRandom('ed25519');
  const newPublicKey = newKeyPair.getPublicKey();

  const res = await acc.signAndSendTransaction({
    receiverId: accountId,
    actions: [
      actions.addFunctionCallAccessKey(newPublicKey, vaultId, methods, nearToYocto(allowanceNear)),
      actions.deleteKey(oldPublicKey),
    ],
  });
  const hash = txHash(res);
  console.log(`\n+ added function-call key (receiver=${vaultId}, methods=[${methods.join(', ')}], allowance=${nearToYocto(allowanceNear)}) and removed the full-access key`);
  console.log(`  tx: ${explorerTx(hash)}`);

  // The old full-access key file is dead on-chain the moment this tx lands.
  const path = credPath(accountId);
  writeFileSync(
    path,
    JSON.stringify({ account_id: accountId, public_key: newPublicKey.toString(), private_key: newKeyPair.toString() }),
    { mode: 0o600 },
  );
  console.log(`  wrote new key to ${path}`);

  const after = (await account(accountId).getAccessKeyList()).keys as unknown as KeyRow[];
  printKeys(`After — ${accountId} access keys:`, after);

  if (after.length !== 1 || after[0].access_key.permission === 'FullAccess') {
    throw new Error('Expected exactly one function-call key after setup; got something else. Inspect manually.');
  }
  console.log(`\n✓ ${accountId} now holds only a function-call key scoped to ${vaultId}.`);
  console.log(`  ${explorerAccount(accountId)}`);

  const reloaded = loadKey(accountId);
  if (reloaded !== newKeyPair.toString()) throw new Error('Credentials file did not round-trip correctly.');
  return hash;
}

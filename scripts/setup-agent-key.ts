/**
 * M5 security setup: cut the agent's full-access key down to a function-call
 * access key that can ONLY call the Vault's agent-side methods, then remove
 * the full-access key. After this, agent.<owner>.testnet physically cannot
 * move NEAR except by calling those Vault methods — see scripts/prove-key-restriction.ts.
 *
 * Both actions (AddKey + DeleteKey) go in a single atomic transaction, signed
 * with the agent's current full-access key, so there is no window where the
 * account has neither key or two full-access keys.
 *
 * The new function-call key is written to the same credentials path the
 * full-access key used (~/.near-credentials/testnet/<agent>.json), replacing
 * it — the old key is being deleted on-chain in the same transaction, so the
 * file is dead the moment this script's transaction lands. Idempotent: if the
 * agent already has only a function-call key restricted to the Vault, this
 * is a no-op.
 *
 * Usage: npm run setup-agent-key
 */
import { KeyPair, PublicKey, actions, nearToYocto } from 'near-api-js';
import { writeFileSync } from 'node:fs';
import {
  accountId, account, credPath, explorerAccount, explorerTx, loadKey, readDeployments, txHash,
} from './lib/near.ts';

/** The only Vault methods the agent's own account key may ever call. */
export const AGENT_METHODS = ['pay', 'post_task', 'accept_bid', 'release', 'refund', 'create_sub_mandate'];

/** Gas allowance for the new key, taken out of the agent's own NEAR balance. */
const ALLOWANCE = nearToYocto('0.25');

interface KeyRow { public_key: string; access_key: { permission: 'FullAccess' | { FunctionCall: { receiver_id: string; method_names: string[]; allowance?: string | null } } } }

function printKeys(label: string, keys: KeyRow[]): void {
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

async function main() {
  const d = readDeployments();
  const vaultId: string | undefined = d.vault?.contractId;
  if (!vaultId) throw new Error('No Vault in deployments/testnet.json. Run `npm run deploy` first.');

  const agentId = accountId('agent');
  const agent = account(agentId);

  const before = (await agent.getAccessKeyList()).keys as unknown as KeyRow[];
  printKeys(`Before — ${agentId} access keys:`, before);

  const alreadyRestricted =
    before.length === 1 &&
    before[0].access_key.permission !== 'FullAccess' &&
    before[0].access_key.permission.FunctionCall.receiver_id === vaultId &&
    AGENT_METHODS.every((m) => before[0].access_key.permission !== 'FullAccess' && (before[0].access_key.permission as any).FunctionCall.method_names.includes(m));
  if (alreadyRestricted) {
    console.log(`\n✓ ${agentId} already holds only a function-call key restricted to ${vaultId}. Nothing to do.`);
    return;
  }

  const fullAccessKeys = before.filter((k) => k.access_key.permission === 'FullAccess');
  if (fullAccessKeys.length === 0) {
    throw new Error(`${agentId} has no full-access key to remove, and is not yet restricted the expected way. Inspect manually.`);
  }
  if (fullAccessKeys.length > 1) {
    throw new Error(`${agentId} has ${fullAccessKeys.length} full-access keys; expected exactly 1. Inspect manually before proceeding.`);
  }
  const oldPublicKey = PublicKey.fromString(fullAccessKeys[0].public_key);

  const newKeyPair = KeyPair.fromRandom('ed25519');
  const newPublicKey = newKeyPair.getPublicKey();

  const res = await agent.signAndSendTransaction({
    receiverId: agentId,
    actions: [
      actions.addFunctionCallAccessKey(newPublicKey, vaultId, AGENT_METHODS, ALLOWANCE),
      actions.deleteKey(oldPublicKey),
    ],
  });
  const hash = txHash(res);
  console.log(`\n+ added function-call key (receiver=${vaultId}, methods=[${AGENT_METHODS.join(', ')}], allowance=${nearToYocto('0.25')}) and removed the full-access key`);
  console.log(`  tx: ${explorerTx(hash)}`);

  // The old full-access key file is now dead on-chain; overwrite it with the new
  // function-call key so later scripts (seed, agent, demo) keep working for this account.
  const path = credPath(agentId);
  writeFileSync(
    path,
    JSON.stringify({ account_id: agentId, public_key: newPublicKey.toString(), private_key: newKeyPair.toString() }),
    { mode: 0o600 },
  );
  console.log(`  wrote new key to ${path}`);

  const after = (await account(agentId).getAccessKeyList()).keys as unknown as KeyRow[];
  printKeys(`After — ${agentId} access keys:`, after);

  if (after.length !== 1 || after[0].access_key.permission === 'FullAccess') {
    throw new Error('Expected exactly one function-call key after setup; got something else. Inspect manually.');
  }
  console.log(`\n✓ ${agentId} now holds only a function-call key scoped to ${vaultId}.`);
  console.log(`  ${explorerAccount(agentId)}`);

  // Confirm the file we wrote actually matches what the key loader will read.
  const reloaded = loadKey(agentId);
  if (reloaded !== newKeyPair.toString()) throw new Error('Credentials file did not round-trip correctly.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

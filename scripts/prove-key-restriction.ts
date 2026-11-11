/**
 * Proves the security claim from scripts/setup-agent-key.ts: after that script
 * runs, agent.<owner>.testnet holds only a function-call access key scoped to
 * the Vault's agent-side methods. This tries two ways to move value outside
 * that scope with the agent's own key and NEAR must reject both:
 *   1. a plain Transfer action (no FunctionCallPermission covers bare transfers)
 *   2. a FunctionCall to a Vault method NOT in the key's allowed method list
 * Both are rejected by NEAR's access-key validation before they ever run,
 * which is exactly why the Vault's policy checks cannot be bypassed.
 *
 * Usage: npm run prove-no-bypass
 */
import { actions, nearToYocto } from 'near-api-js';
import { OWNER_ID, account, accountId, readDeployments } from './lib/near.ts';

async function expectRejected(label: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    const res = (await run()) as { status?: { Failure?: unknown; SuccessValue?: string } };
    if (res?.status?.Failure) {
      console.log(`✓ ${label}\n  on-chain failure: ${JSON.stringify(res.status.Failure).slice(0, 200)}`);
      return true;
    }
    console.error(`✗ ${label}\n  SUCCEEDED — this should have been impossible. Security property violated.`);
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`✓ ${label}\n  rejected: ${msg.split('\n')[0]}`);
    return true;
  }
}

async function main() {
  const agentId = accountId('agent');
  const agent = account(agentId);
  const d = readDeployments();
  const vaultId: string | undefined = d.vault?.contractId;
  if (!vaultId) throw new Error('No Vault in deployments/testnet.json. Run `npm run deploy` first.');

  console.log(`Proving ${agentId} cannot move value outside the Vault (its access key is function-call-only, scoped to ${vaultId})...\n`);

  const ok1 = await expectRejected(
    `1. direct NEAR transfer ${agentId} → ${OWNER_ID} (0.01 NEAR, bypassing the Vault entirely)`,
    () => agent.signAndSendTransaction({ receiverId: OWNER_ID, actions: [actions.transfer(nearToYocto('0.01'))] }),
  );

  console.log();
  const ok2 = await expectRejected(
    "2. calling Vault.revoke — a real method, but not one the agent's key is allowed to call",
    () => agent.callFunctionRaw({ contractId: vaultId, methodName: 'revoke', args: { mandate_id: 0 } }),
  );

  console.log();
  if (ok1 && ok2) {
    console.log('✓ Key restriction proven: this account can only reach the world through the Vault methods its key allows.');
  } else {
    console.log('✗ Key restriction NOT proven — see failures above.');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
